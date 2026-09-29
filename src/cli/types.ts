/**
 * `niadra types derive`: a type proposed from the company's PostgreSQL schema, and `--check` for drift.
 *
 * Both run inside the company's boundary and read the catalog, never a row (`introspect`). `derive` writes
 * the proposal (JSON that validates against `object-type.v0`) and lists on stderr what a person must review
 * before submitting it as a configuration change. `--check` reads the catalog again and compares its
 * fingerprint with the declaration's; it sends Niadra only the fingerprint and the counts of what changed
 * (`POST /v1/types/fingerprint`), and says locally, on stderr, what the counts are about. Without
 * `--declaration` it compares with the type the space serves in its SDK profile, and Niadra decides the drift.
 *
 * `--check` exits with 0 without drift, 1 on drift and 2 when it could not check.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Niadra } from "../client.js";
import { DeriveError, changes, derive, fingerprint, toName } from "../introspect/derive.js";
import type { Catalog } from "../introspect/derive.js";
import { readCatalog } from "../introspect/postgres.js";
import type { Io } from "./index.js";

type Json = Record<string, unknown>;

export const DSN_VARIABLE = "NIADRA_DERIVE_DSN";

export async function typesDerive(argv: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      dsn: { type: "string" },
      table: { type: "string" },
      type: { type: "string" },
      system: { type: "string" },
      ownership: { type: "string", default: "subject" },
      out: { type: "string" },
      check: { type: "boolean", default: false },
      declaration: { type: "string" },
      "no-send": { type: "boolean", default: false },
    },
  });
  const dsn = values.dsn ?? process.env[DSN_VARIABLE];
  if (!dsn) return fail(io, `a connection string is needed: --dsn or ${DSN_VARIABLE}`);
  if (values.table === undefined) return fail(io, "--table is needed");
  let catalog: Catalog;
  try {
    catalog = await readCatalog(dsn, values.table);
    if (values.check) return await check(values, catalog, io);
    const derived = await derive(catalog, {
      ...(values.type !== undefined ? { type: values.type } : {}),
      ...(values.system !== undefined ? { system: values.system } : {}),
      ownership: values.ownership,
    });
    const text = `${JSON.stringify(derived.type, null, 2)}\n`;
    if (values.out !== undefined) writeFileSync(values.out, text, "utf8");
    else io.out(text.trimEnd());
    for (const item of derived.review) io.err(`review: ${review(item)}`);
    return 0;
  } catch (error) {
    if (error instanceof DeriveError) return fail(io, `${error.code}: ${error.message}`);
    // The driver's own: its message may carry the connection string.
    const name = error instanceof Error ? error.name : typeof error;
    return fail(io, error instanceof Error && error.message.includes("pg package") ? error.message : `could not read the catalog (${name})`);
  }
}

interface CheckArgs {
  type?: string;
  system?: string;
  declaration?: string;
  "no-send": boolean;
}

async function check(args: CheckArgs, catalog: Catalog, io: Io): Promise<number> {
  const live = await fingerprint(catalog);
  const served = args.declaration === undefined;
  let niadra: Niadra | undefined;
  let declared: Json | undefined;
  if (args.declaration !== undefined) declared = JSON.parse(readFileSync(args.declaration, "utf8")) as Json;
  else if (args["no-send"]) return fail(io, "--no-send needs --declaration: there is nothing else to compare with");
  else {
    niadra = io.client();
    declared = await servedType(niadra, args.type ?? toName(tableName(catalog), 40));
    if (declared === undefined) return fail(io, "the space serves no such type: pass --type, or --declaration");
  }
  const mirror = (declared.mirror_of ?? {}) as Json;
  const system = typeof mirror.system === "string" ? mirror.system : args.system;
  const derived = (
    await derive(catalog, {
      type: String(declared.type),
      ...(system !== undefined ? { system } : {}),
      ownership: typeof declared.ownership === "string" ? declared.ownership : "subject",
    })
  ).type;
  if (served) delete derived.relations; // the profile's summary carries no relations: nothing to compare
  const report = changes(declared, derived);
  let drift: boolean | null = typeof mirror.fingerprint === "string" ? live !== mirror.fingerprint : null;
  let issueId: string | null = null;
  if (!args["no-send"]) {
    try {
      niadra ??= io.client();
      const answer = await niadra.callRoute<Json>({
        method: "POST",
        path: "/v1/types/fingerprint",
        body: { type: declared.type, fingerprint: live, changes: report },
      });
      drift ??= Boolean(answer.drift);
      issueId = typeof answer.issue_id === "string" ? answer.issue_id : null;
    } catch (error) {
      io.err(`niadra: the fingerprint was not sent (${error instanceof Error ? error.name : typeof error})`);
    }
  }
  if (drift === null) return fail(io, "the declaration has no fingerprint and Niadra did not answer");
  for (const line of details(declared, derived)) io.err(line);
  io.out(JSON.stringify({ type: declared.type, drift, fingerprint: live, changes: report, ...(issueId !== null ? { issue_id: issueId } : {}) }, null, 2));
  return drift ? 1 : 0;
}

async function servedType(niadra: Niadra, name: string): Promise<Json | undefined> {
  const profile = await niadra.callRoute<{ types?: Json[] } | null>({ method: "GET", path: "/v1/sdk/profile" });
  const found = (profile?.types ?? []).find((t) => t.type === name);
  return found === undefined ? undefined : { ...found };
}

function tableName(catalog: Catalog): string {
  const table = catalog.table.slice(catalog.table.lastIndexOf(".") + 1);
  return table.startsWith('"') ? table.slice(1, -1).replaceAll('""', '"') : table;
}

/** What the counts are about, named: for the company's own log, never sent. */
function details(declared: Json, live: Json): string[] {
  const before = (declared.fields ?? {}) as Record<string, Json>;
  const after = (live.fields ?? {}) as Record<string, Json>;
  const lines = Object.keys(after).filter((n) => !(n in before)).map((n) => `field added: ${n} (${String(after[n]?.type)})`);
  lines.push(...Object.keys(before).filter((n) => !(n in after)).map((n) => `field removed: ${n}`));
  lines.push(
    ...Object.keys(before)
      .filter((n) => n in after && before[n]?.type !== after[n]?.type)
      .map((n) => `field retyped: ${n} (${String(before[n]?.type)} to ${String(after[n]?.type)})`),
  );
  const statesBefore = (declared.states ?? []) as string[];
  const statesAfter = (live.states ?? []) as string[];
  lines.push(...statesAfter.filter((s) => !statesBefore.includes(s)).map((s) => `state added: ${s}`));
  lines.push(...statesBefore.filter((s) => !statesAfter.includes(s)).map((s) => `state removed: ${s}`));
  const relationsBefore = Object.keys((declared.relations ?? {}));
  const relationsAfter = Object.keys((live.relations ?? {}));
  lines.push(...relationsAfter.filter((r) => !relationsBefore.includes(r)).map((r) => `relation added: ${r}`));
  lines.push(...relationsBefore.filter((r) => !relationsAfter.includes(r)).map((r) => `relation removed: ${r}`));
  const keyBefore = (((declared.key ?? {}) as Json).natural ?? []) as string[];
  const keyAfter = (((live.key ?? {}) as Json).natural ?? []) as string[];
  if (keyBefore.join(",") !== keyAfter.join(",")) lines.push(`key: [${keyBefore.join(", ")}] to [${keyAfter.join(", ")}]`);
  return lines;
}

function review(item: Json): string {
  switch (item.kind) {
    case "column":
      return `column ${String(item.column)} (${String(item.type)}) has no field type: declare it by hand, or leave it`;
    case "check":
      return `CHECK not read as a list of values: ${String(item.definition)}`;
    case "states":
      return `the values of ${String(item.column)} are not state names; declare the states by hand`;
    case "foreign_key":
      return `foreign key ${(item.columns as string[]).join(", ")} to ${String(item.references)} is not a relation`;
    default:
      return `trigger ${String(item.name)} (${item.enabled ? "enabled" : "disabled"}) is code: declare the transitions it enforces in lifecycle`;
  }
}

function fail(io: Io, message: string): number {
  io.err(`niadra: ${message}`);
  return 2;
}
