// The conformance vectors of the open specifications, which the server and both SDKs run alike.
//
// `pnpm sync-spec --spec` copies them into spec/vectors (and the claim contract examples, with their
// negative corpus, into spec/examples/claim-contract). `EXPECTED` lists every file the SDK runs, with the
// fields its spec gives a case. Nothing here passes without running:
// - a file not published yet is skipped, titled "pending vectors";
// - a published file whose runner the SDK does not have yet is an expected failure ("pending
//   implementation"), which turns red the day a runner makes it pass and nobody moved it;
// - a file nothing expects, a case field its spec does not define and a malformed envelope fail.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, expr, jsonDigest } from "../src/index.js";

const SPEC = new URL("../spec/", import.meta.url);
const VECTORS = new URL("vectors/", SPEC);
const CASE_ID = /^[a-z0-9_]+(\.[a-z0-9_-]+)+$/;

type Case = Record<string, unknown> & { id: string; expect?: Record<string, unknown> };
interface VectorFile {
  vectors: string;
  version: string;
  spec: string;
  cases: Case[];
}

interface Expected {
  caseFields: string[];
  expectFields: string[];
  run: ((c: Case) => Promise<void>) | null;
  pending?: string;
}

/** A published file whose runner the SDK does not have yet. */
const pending = (caseFields: string, expectFields: string, what: string): Expected => ({
  caseFields: caseFields.split(" "),
  expectFields: expectFields.split(" "),
  run: null,
  pending: what,
});

async function digestCase(c: Case): Promise<void> {
  const expected = c.expect as { canonical: string; sha256: string; size: number };
  expect(canonicalJson(c.value)).toBe(expected.canonical);
  expect(await jsonDigest(c.value)).toEqual({ sha256: expected.sha256, size: expected.size });
}

// niadra-expr, read as the server's runner reads it (`spec/object-type.md`, section 6): a member the spec
// does not define fails the case, so a vector written for a later version never passes by being half read.
const EXPR_INPUT = new Set([
  "now",
  "utc_offset",
  "fields",
  "inputs",
  "absent_names",
  "config",
  "quotes",
  "calendars",
  "state",
  "derived_status",
  "watch_count",
  "purpose",
  "presented_rank",
]);
const EXPR_SLOT = new Set(["type", "v", "logic", "absent", "at", "observer", "was", "completeness"]);
const EXPR_PREVIOUS = new Set(["type", "v", "logic", "absent"]);
const EXPR_CALENDAR = new Set(["holidays", "weekend"]);
const EXPR_LOGIC = new Set(["yes", "no", "unobserved", "known_defect"]);
const KIND_OF_TYPE: Record<string, expr.Kind> = {
  string: "string",
  text: "string",
  enum: "string",
  ref: "string",
  number: "number",
  money: "number",
  percent: "number",
  date: "date",
  datetime: "datetime",
  duration: "duration",
  bool: "bool",
  list: "list",
};

type Json = Record<string, any>;

function only(raw: Json, members: Set<string>, what: string): Json {
  expect(Object.keys(raw).filter((key) => !members.has(key)), `unknown ${what} members`).toEqual([]);
  return raw;
}

const entries = (raw: unknown): [string, any][] => Object.entries((raw ?? {}) as Json);

function scalar(raw: unknown): expr.Value {
  if (typeof raw === "boolean") return expr.boolean(raw);
  if (typeof raw === "number") return { logic: "yes", kind: "number", datum: raw };
  if (typeof raw === "string") return { logic: "yes", kind: "string", datum: raw };
  throw new Error(`not a scalar: ${JSON.stringify(raw)}`);
}

function present(kind: expr.Kind, raw: unknown): expr.Value {
  if (kind === "number" && typeof raw === "number") return { logic: "yes", kind, datum: raw };
  if (kind === "string" && typeof raw === "string") return { logic: "yes", kind, datum: raw };
  if (kind === "date" && typeof raw === "string") return { logic: "yes", kind, datum: expr.parseDate(raw) };
  if (kind === "datetime" && typeof raw === "string") return { logic: "yes", kind, datum: expr.parseDatetime(raw) };
  if (kind === "duration" && Number.isInteger(raw)) return { logic: "yes", kind, datum: raw as number };
  if (kind === "list" && Array.isArray(raw)) return { logic: "yes", kind, datum: raw.map(scalar) };
  throw new Error(`not a ${kind}: ${JSON.stringify(raw)}`);
}

/** A slot's value: `yes` with a value (`no` for `false`) and `unobserved` without one, unless `logic` says. */
function valueOf(raw: Json, members: Set<string>): expr.Value {
  only(raw, members, "slot");
  const v: unknown = raw.v ?? null;
  const kind = raw.type === undefined ? (v === null ? undefined : scalar(v).kind) : KIND_OF_TYPE[raw.type as string];
  if (raw.type !== undefined && kind === undefined) throw new Error(`unknown type ${JSON.stringify(raw.type)}`);
  const logic = (raw.logic ?? (v === null ? "unobserved" : v === false ? "no" : "yes")) as expr.Value["logic"];
  if (!EXPR_LOGIC.has(logic)) throw new Error(`unknown logic ${JSON.stringify(logic)}`);
  if (kind === "bool" && (logic === "yes" || logic === "no")) return expr.boolean(logic === "yes");
  if (logic === "no") return expr.absent(raw.absent as string | undefined);
  if (logic !== "yes") return expr.unknown(logic);
  if (kind === undefined) throw new Error("a present value needs a type or a value");
  return present(kind, v);
}

function slotOf(raw: Json): expr.Slot {
  only(raw, EXPR_SLOT, "slot");
  const value = valueOf(Object.fromEntries(Object.entries(raw).filter(([key]) => EXPR_PREVIOUS.has(key))), EXPR_SLOT);
  return {
    value,
    ...(raw.at === undefined ? {} : { at: expr.parseDatetime(raw.at as string) }),
    ...(raw.observer === undefined ? {} : { observer: raw.observer as string }),
    ...(raw.was === undefined ? {} : { was: valueOf(raw.was as Json, EXPR_PREVIOUS) }),
    ...(raw.completeness === undefined ? {} : { completeness: raw.completeness as string }),
  };
}

function offsetMinutes(text: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(text);
  if (match === null) throw new Error(`not a UTC offset: ${text}`);
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

function environment(raw: Json): expr.Environment {
  only(raw, EXPR_INPUT, "input");
  const slots = (group: unknown) => Object.fromEntries(entries(group).map(([name, slot]) => [name, slotOf(slot as Json)]));
  return {
    now: expr.parseDatetime(raw.now as string),
    utcOffsetMin: offsetMinutes((raw.utc_offset ?? "+00:00") as string),
    fields: slots(raw.fields),
    inputs: slots(raw.inputs),
    absentNames: new Set((raw.absent_names ?? []) as string[]),
    config: Object.fromEntries(entries(raw.config).map(([key, v]) => [key, v === null ? expr.absent() : scalar(v)])),
    quotes: Object.fromEntries(entries(raw.quotes).map(([source, quote]) => [source, slots(quote)])),
    calendars: Object.fromEntries(
      entries(raw.calendars).map(([name, calendar]) => {
        only(calendar as Json, EXPR_CALENDAR, "calendar");
        const { holidays = [], weekend = [6, 7] } = calendar as { holidays?: string[]; weekend?: number[] };
        return [name, { holidays: new Set(holidays.map(expr.parseDate)), weekend: new Set(weekend) }];
      }),
    ),
    ...(raw.state === undefined ? {} : { state: raw.state as string }),
    ...(raw.derived_status === undefined ? {} : { derivedStatus: raw.derived_status as string }),
    watchCount: (raw.watch_count ?? 0) as number,
    purpose: (raw.purpose ?? "display") as string,
    ...(raw.presented_rank === undefined ? {} : { presentedRank: raw.presented_rank as number }),
  };
}

/** A result as the vectors write it: the logical value, and the kind and value of a known one. */
function encode(value: expr.Value): Json {
  if (value.kind === undefined) {
    if (value.logic !== "no") return { logic: value.logic };
    return value.absent === undefined ? { logic: "no" } : { logic: "no", absent: value.absent };
  }
  switch (value.kind) {
    case "date":
      return { type: value.kind, logic: value.logic, v: expr.formatDate(value.datum) };
    case "datetime":
      return { type: value.kind, logic: value.logic, v: expr.formatDatetime(value.datum) };
    case "list":
      return { type: value.kind, logic: value.logic, v: value.datum.map(encode) };
    case "business_days":
    case "quote":
      throw new Error(`a ${value.kind} is never a result`);
    default:
      return { type: value.kind, logic: value.logic, v: value.datum };
  }
}

async function exprCase(c: Case): Promise<void> {
  expect(Object.keys(c).sort()).toEqual(["expect", "expr", "id", "input"]);
  expect(Object.keys(c.expect ?? {})).toHaveLength(1);
  const env = environment(c.input as Json);
  let result: Json;
  try {
    result = { value: encode(expr.evaluate(expr.parse(c.expr as string), env)) };
  } catch (error) {
    if (!(error instanceof expr.ExprError)) throw error;
    result = { error: error.code };
  }
  expect(result).toStrictEqual(c.expect);
}

const EXPECTED: Record<string, Expected> = {
  "turn-record-digest.v0": {
    caseFields: ["id", "note", "value", "expect"],
    expectFields: ["canonical", "sha256", "size"],
    run: digestCase,
  },
  "niadra-expr.v0": {
    caseFields: ["id", "expr", "input", "expect"],
    expectFields: ["value"],
    run: exprCase,
  },
  "claim-parser.v0": pending("id lang text roles evidence expect", "mentions", "the claim contract's number and role parser"),
  "claim-detect.v0": pending("id contract output turn expect", "findings", "the claim contract's detection"),
  "claim-anchor.v0": pending("id quote document expect", "normalized_quote_length distance holds", "the claim contract's text anchor"),
  "constraint-render.v0": pending(
    "id block binding families call mode results expect",
    "applies args suggested injected hard_sent residual post_filter conflicts honored",
    "the constraints block's rendering per tool binding",
  ),
  "exposure-token.v0": pending("id op description exposure_id position token expect", "token exposure_id position", "the exposure token"),
  "contact-token.v0": pending(
    "id op description seed claims keys gateway token destination channel now seen_jti expect",
    "token claims",
    "the contact token's issue and offline check",
  ),
  "suppression-key.v0": pending("id description salt type value expect", "canonical key", "the suppression list's per-source key"),
};
const NEGATIVE_CORPUS = ["retail", "legal", "health-plan-sales"];

const published = (name: string): boolean => existsSync(new URL(`${name}.json`, VECTORS));
const load = (name: string): VectorFile => JSON.parse(readFileSync(new URL(`${name}.json`, VECTORS), "utf8")) as VectorFile;

it("runs every published vector file", () => {
  const files = readdirSync(VECTORS).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5));
  expect(files.filter((name) => !(name in EXPECTED)), "vector files the SDK does not run: add them to EXPECTED").toEqual([]);
});

for (const [name, expected] of Object.entries(EXPECTED)) {
  if (!published(name)) {
    it.skip(`pending vectors: ${name}.json is not published in niadra-spec yet`, () => undefined);
    continue;
  }
  describe(name, () => {
    const data = load(name);

    it("has the envelope and only the fields its spec defines", () => {
      const dot = name.lastIndexOf(".");
      expect(Object.keys(data).sort()).toEqual(["cases", "spec", "vectors", "version"]);
      expect([data.vectors, data.version]).toEqual([name.slice(0, dot), name.slice(dot + 1)]);
      expect(data.spec.startsWith("spec/")).toBe(true);
      const ids = data.cases.map((c) => c.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((id) => !CASE_ID.test(id))).toEqual([]);
      const caseFields = new Set(expected.caseFields);
      const expectFields = new Set([...expected.expectFields, "error"]);
      for (const c of data.cases) {
        expect(Object.keys(c).filter((field) => !caseFields.has(field)), c.id).toEqual([]);
        expect(Object.keys(c.expect ?? {}).filter((field) => !expectFields.has(field)), c.id).toEqual([]);
      }
    });

    for (const c of data.cases) {
      const run = async (): Promise<void> => {
        if (!expected.run) throw new Error(`not implemented: ${expected.pending ?? name}`);
        await expected.run(c);
      };
      if (expected.pending) it.fails(`pending implementation: ${expected.pending}: ${c.id}`, run);
      else it(c.id, run);
    }
  });
}

for (const sector of NEGATIVE_CORPUS) {
  const path = new URL(`examples/claim-contract/${sector}.json`, SPEC);
  if (!existsSync(path)) {
    it.skip(`pending vectors: examples/claim-contract/${sector}.json is not published yet`, () => undefined);
    continue;
  }
  it.fails(`pending implementation: the claim contract's detection, on the ${sector} negative corpus`, () => {
    const example = JSON.parse(readFileSync(path, "utf8")) as { negative_corpus: { phrases: string[] } };
    expect(example.negative_corpus.phrases.length).toBeGreaterThan(0);
    throw new Error("not implemented: the claim contract's detection");
  });
}
