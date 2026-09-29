// The conformance vectors of the open specifications, which the server and both SDKs run alike.
//
// `pnpm sync-spec --spec` copies them into spec/vectors (and the claim contract examples, with their
// negative corpus, into spec/examples/claim-contract). `EXPECTED` lists every file the SDK runs, with the
// fields its spec gives a case, and its runner. Nothing here passes without running: a missing file, a file
// nothing expects, a case field its spec does not define and a malformed envelope fail.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NiadraContactTokenError,
  NiadraDestinationError,
  NiadraExposureTokenError,
  canonicalDestination,
  canonicalJson,
  claims,
  expr,
  exposureToken,
  honoredConstraints,
  jsonDigest,
  overlapAtK,
  parseExposureToken,
  renderConstraints,
  suppressionKey,
  verifyContactToken,
} from "../src/index.js";
import type { ClaimCategory, ConstraintBinding, ConstraintCall, ConstraintsBlock, ContactKey } from "../src/index.js";
import { DeriveError, changes, derive } from "../src/introspect/derive.js";
import type { Catalog } from "../src/introspect/derive.js";
import { scenarioVerdict } from "./support/stats.js";
import type { Execution } from "./support/stats.js";

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
  run: (c: Case) => Promise<void>;
}

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

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function contactTokenCase(c: Case): Promise<void> {
  if (c.op === "issue") {
    // Niadra issues; the SDK only checks. The runner signs as the spec says, to prove the byte form the check
    // reads is the one every issuer writes.
    expect(Object.keys(c).sort()).toEqual(["claims", "description", "expect", "id", "op", "seed"]);
    const seed = Uint8Array.from(atob((c.seed as string).replace(/-/g, "+").replace(/_/g, "/") + "="), (ch) => ch.charCodeAt(0));
    const pkcs8 = new Uint8Array([...[0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20], ...seed]);
    const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
    const payload = b64url(new TextEncoder().encode(JSON.stringify(c.claims)));
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(`nct1.${payload}`)));
    expect({ token: `nct1.${payload}.${b64url(signature)}` }).toEqual(c.expect);
    return;
  }
  expect(c.op).toBe("verify");
  const gateway = c.gateway as { gateway_id: string; space: string; key: string };
  let got: Record<string, unknown>;
  try {
    const claims = await verifyContactToken(c.token as string, {
      keys: c.keys as ContactKey[],
      gatewayId: gateway.gateway_id,
      space: gateway.space,
      gatewayKey: gateway.key,
      destination: c.destination as string,
      channel: c.channel as string,
      now: c.now as number,
      seen: new Set(c.seen_jti as string[]),
    });
    got = { claims };
  } catch (error) {
    if (!(error instanceof NiadraContactTokenError)) throw error;
    got = { error: error.code };
  }
  expect(got).toEqual(c.expect);
}

async function counterfactualOverlapCase(c: Case): Promise<void> {
  expect(overlapAtK(c.a as string[], c.b as string[], c.k as number)).toBeCloseTo((c.expect as { overlap: number }).overlap, 6);
  await Promise.resolve();
}

async function regressionStatsCase(c: Case): Promise<void> {
  // The statistic is the recorder's; the tests' stand-in for it computes the verdict the same way.
  for (const execution of c.executions as Record<string, unknown>[]) {
    expect(Object.keys(execution).sort()).toEqual(["outcomes", "paraphrase", "status"]);
  }
  expect(scenarioVerdict(c.executions as Execution[], c.baseline as Record<string, [number, number]> | null)).toEqual(c.expect);
  await Promise.resolve();
}

async function suppressionKeyCase(c: Case): Promise<void> {
  let got: Record<string, unknown>;
  try {
    const canonical = canonicalDestination(c.type as string, c.value as string);
    got = { canonical, key: await suppressionKey(c.salt as string, canonical) };
  } catch (error) {
    if (!(error instanceof NiadraDestinationError)) throw error;
    got = { error: error.code };
  }
  expect(got).toStrictEqual(c.expect);
}

async function exposureTokenCase(c: Case): Promise<void> {
  if (c.op === "build") {
    expect(Object.keys(c).sort()).toEqual(["description", "expect", "exposure_id", "id", "op", "position"]);
    const token = exposureToken(c.exposure_id as string, c.position as number);
    expect({ token }).toStrictEqual(c.expect);
    expect(token.length).toBe(32 + String(c.position).length);
    return;
  }
  expect(c.op).toBe("parse");
  expect(Object.keys(c).sort()).toEqual(["description", "expect", "id", "op", "token"]);
  let got: Record<string, unknown>;
  try {
    const { exposureId, position } = parseExposureToken(c.token as string);
    got = { exposure_id: exposureId, position };
  } catch (error) {
    if (!(error instanceof NiadraExposureTokenError)) throw error;
    got = { error: error.code };
  }
  expect(got).toStrictEqual(c.expect);
}

const unknownFields = (value: object, known: string[]): string[] => Object.keys(value).filter((k) => !known.includes(k));

function bindingOf(raw: Record<string, any>, families: Record<string, string>): ConstraintBinding {
  expect(unknownFields(raw, ["tool", "args", "overfetch"])).toEqual([]);
  const args = (raw.args as Record<string, any>[]).map((arg) => {
    expect(unknownFields(arg, ["attr", "param", "transform", "negation", "ops"])).toEqual([]);
    return {
      attr: arg.attr as string,
      param: arg.param as string,
      transform: arg.transform ?? null,
      negation: (arg.negation?.param as string | undefined) ?? null,
      ops: (arg.ops as string[] | undefined) ?? [],
      family: families[arg.attr as string] ?? null,
    };
  });
  return { tool: raw.tool as string, args, overfetch: raw.overfetch === true };
}

async function constraintRenderCase(c: Case): Promise<void> {
  const block = c.block as ConstraintsBlock;
  const raw = c.call as Record<string, any>;
  expect(unknownFields(raw, ["args", "for", "category", "asked"])).toEqual([]);
  const call: ConstraintCall = { args: raw.args, for: raw.for, category: raw.category ?? null, asked: raw.asked ?? [] };
  const binding = bindingOf(c.binding as Record<string, any>, c.families as Record<string, string>);
  const got = renderConstraints(block, binding, call, c.mode as "advisory" | "apply");
  const rendered: Record<string, unknown> = {
    applies: got.applies,
    args: got.args,
    suggested: got.suggested,
    injected: got.injected,
    hard_sent: got.hardSent,
    residual: got.residual,
    post_filter: got.postFilter,
    conflicts: got.conflicts,
  };
  if ("results" in c) {
    const seen = honoredConstraints(block, got.hardSent, c.results as Record<string, unknown>[]);
    rendered.honored = { results_checked: seen.resultsChecked, violations: seen.violations, unverifiable: seen.unverifiable };
  }
  expect(rendered).toStrictEqual(c.expect);
  const inferred = (block.attributes ?? []).filter((a) => a.source !== "stated" && a.source !== "correction").map((a) => a.id);
  expect(got.injected.filter((id) => inferred.includes(id)), "an inferred attribute is never injected, whatever the mode").toEqual([]);
}

/** Code points, as the claim contract counts offsets. */
const between = (text: string, start: number, end: number): string => Array.from(text).slice(start, end).join("");

interface VectorValue {
  class: claims.MentionClass;
  value: claims.Value;
  role?: string;
  fresh?: boolean;
  object_type?: string;
  name?: string;
  call_id?: string;
  ref?: string;
  declared_gaps?: string[];
}

const TURN_VALUE = new Set(["class", "value", "role", "fresh", "object_type", "name", "call_id", "ref", "declared_gaps"]);

function turnValue(item: VectorValue): claims.TurnValue {
  only(item, TURN_VALUE, "turn value");
  return {
    cls: item.class,
    value: item.value,
    role: item.role ?? null,
    fresh: item.fresh ?? true,
    objectType: item.object_type ?? null,
    name: item.name ?? null,
    callId: item.call_id ?? null,
    ref: item.ref ?? null,
    declaredGaps: item.declared_gaps ?? [],
  };
}

interface ClaimContract {
  languages: claims.Language[];
  categories: ClaimCategory[];
  negative_corpus: { version: string; phrases: string[] };
}

const contract = (path: string): ClaimContract => JSON.parse(readFileSync(new URL(path, SPEC), "utf8")) as ClaimContract;

async function parserCase(c: Case): Promise<void> {
  const { text, lang, roles: terms, evidence } = c as Case & {
    text: string;
    lang: claims.Language;
    roles?: Record<string, string[]>;
    evidence?: VectorValue[];
  };
  const found = claims.mentions(text, lang);
  const roles = new Map<claims.Mention, claims.Role>();
  if (terms) {
    for (const cls of new Set(found.filter((m) => m.cls !== "label").map((m) => m.cls))) {
      const same = found.filter((m) => m.cls === cls);
      claims.rolesOf(text, same, terms).forEach((role, i) => roles.set(same[i]!, role));
    }
  }
  const values = (evidence ?? []).map(turnValue);
  const got = found.map((m) => {
    const item: Record<string, unknown> = { span: [m.start, m.end], text: between(text, m.start, m.end), class: m.cls };
    if (m.cls !== "label") {
      Object.assign(item, { value: m.value(), written: m.written });
      if (terms) Object.assign(item, { role: roles.get(m)!.name, role_status: roles.get(m)!.status });
      if (evidence) item.nature = claims.natureOf(text, m, roles.get(m) ?? { name: null, status: "none" }, values);
    }
    return item;
  });
  expect(got).toEqual(c.expect?.mentions);
}

interface VectorTurn {
  values?: VectorValue[];
  tools?: string[];
  documents?: Record<string, string>;
  anchors?: { span: [number, number]; quote: string; document: string }[];
  sections?: Record<string, [number, number][]>;
}

async function detectCase(c: Case): Promise<void> {
  const example = contract(c.contract as string);
  const out = c.output as { text: string; lang: claims.Language; context: string; immutable: boolean; agent?: string };
  const turn = c.turn as VectorTurn;
  only(out, new Set(["text", "lang", "context", "immutable", "agent"]), "output");
  only(turn, new Set(["values", "tools", "documents", "anchors", "sections"]), "turn");
  const values = (turn.values ?? []).map(turnValue);
  const anchors = (turn.anchors ?? []).map((a): claims.Anchor => {
    only(a, new Set(["span", "quote", "document"]), "anchor");
    return { start: a.span[0], end: a.span[1], quote: a.quote, document: a.document };
  });
  const output: claims.Output = { text: out.text, lang: out.lang, context: out.context, immutable: out.immutable, agent: out.agent ?? null };
  const found = claims.check(example.categories, output, {
    values,
    tools: turn.tools ?? [],
    documents: turn.documents ?? {},
    anchors,
    sections: turn.sections ?? {},
  });
  const got = found.map((f) => {
    const item: Record<string, unknown> = { category: f.category, span: [f.start, f.end], text: between(out.text, f.start, f.end) };
    if (f.cls !== null) Object.assign(item, { class: f.cls, nature: f.nature, role: f.role, value: f.value });
    Object.assign(item, { verdict: f.verdict, action: f.action });
    if (f.evidence !== null) {
      item.evidence = "quote" in f.evidence ? { anchor: anchors.indexOf(f.evidence) } : { value: values.indexOf(f.evidence) };
    }
    return item;
  });
  expect(got).toEqual(c.expect?.findings);
}

async function anchorCase(c: Case): Promise<void> {
  const { quote, document } = c as Case & { quote: string; document: string };
  const expected = c.expect as { normalized_quote_length: number; distance: number; holds: boolean };
  const normalized = claims.normalize(quote);
  expect(normalized.length).toBe(expected.normalized_quote_length);
  const got = claims.score(quote, document);
  if (normalized) expect(got).toBe(1 - expected.distance / normalized.length);
  expect(got >= 0.9).toBe(expected.holds);
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
  "claim-parser.v0": {
    caseFields: ["id", "lang", "text", "roles", "evidence", "expect"],
    expectFields: ["mentions"],
    run: parserCase,
  },
  "claim-detect.v0": {
    caseFields: ["id", "contract", "output", "turn", "expect"],
    expectFields: ["findings"],
    run: detectCase,
  },
  "claim-anchor.v0": {
    caseFields: ["id", "quote", "document", "expect"],
    expectFields: ["normalized_quote_length", "distance", "holds"],
    run: anchorCase,
  },
  "constraint-render.v0": {
    caseFields: ["id", "block", "binding", "families", "call", "mode", "results", "expect"],
    expectFields: ["applies", "args", "suggested", "injected", "hard_sent", "residual", "post_filter", "conflicts", "honored"],
    run: constraintRenderCase,
  },
  "exposure-token.v0": {
    caseFields: ["id", "op", "description", "exposure_id", "position", "token", "expect"],
    expectFields: ["token", "exposure_id", "position"],
    run: exposureTokenCase,
  },
  "contact-token.v0": {
    caseFields: ["id", "op", "description", "seed", "claims", "keys", "gateway", "token", "destination", "channel", "now", "seen_jti", "expect"],
    expectFields: ["token", "claims"],
    run: contactTokenCase,
  },
  "counterfactual-overlap.v0": {
    caseFields: ["id", "description", "a", "b", "k", "expect"],
    expectFields: ["overlap"],
    run: counterfactualOverlapCase,
  },
  "type-derive.v0": {
    caseFields: ["id", "op", "description", "catalog", "options", "declared", "live", "expect"],
    expectFields: ["fingerprint", "type", "review", "changes"],
    run: typeDeriveCase,
  },
  "regression-stats.v0": {
    caseFields: ["id", "description", "executions", "baseline", "expect"],
    expectFields: ["verdict", "completed", "infrastructure_errors", "pin_mismatches", "needs_paraphrase", "assertions"],
    run: regressionStatsCase,
  },
  "suppression-key.v0": {
    caseFields: ["id", "description", "salt", "type", "value", "expect"],
    expectFields: ["canonical", "key"],
    run: suppressionKeyCase,
  },
};
const NEGATIVE_CORPUS = ["retail", "legal", "health-plan-sales"];

// Derivation by introspection (`spec/object-type.md`, section 8): a proposal, its fingerprint and review, or
// the changes a drift check counts.
async function typeDeriveCase(c: Case): Promise<void> {
  if (c.op === "changes") {
    expect(changes(c.declared as Record<string, unknown>, c.live as Record<string, unknown>)).toEqual((c.expect!).changes);
    return;
  }
  const options = c.options as Record<string, string>;
  expect(Object.keys(options).filter((k) => !["type", "system", "ownership"].includes(k))).toEqual([]);
  const expected = c.expect!;
  if ("error" in expected) {
    const refused = await derive(c.catalog as Catalog, options).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(DeriveError);
    expect((refused as DeriveError).code).toBe(expected.error);
    return;
  }
  expect(await derive(c.catalog as Catalog, options)).toEqual(expected);
}

const load = (name: string): VectorFile => JSON.parse(readFileSync(new URL(`${name}.json`, VECTORS), "utf8")) as VectorFile;

it("runs every published vector file", () => {
  const files = readdirSync(VECTORS).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5));
  expect(files.filter((name) => !(name in EXPECTED)), "vector files the SDK does not run: add them to EXPECTED").toEqual([]);
});

for (const [name, expected] of Object.entries(EXPECTED)) {
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

    for (const c of data.cases) it(c.id, () => expected.run(c));
  });
}

for (const sector of NEGATIVE_CORPUS) {
  // A phrase triggers when a category finds a claim in it, in any of the contract's languages and for any
  // of its agents (the claim contract spec, section 10.2).
  it(`no phrase of the ${sector} negative corpus triggers its contract`, () => {
    const example = contract(`examples/claim-contract/${sector}.json`);
    expect(example.negative_corpus.phrases.length).toBeGreaterThan(0);
    const agents = [null, ...new Set(example.categories.flatMap((c) => c.agents ?? []))];
    const triggered = example.negative_corpus.phrases.flatMap((text) =>
      example.languages.flatMap((lang) =>
        agents.flatMap((agent) => {
          const categories = claims.detected(example.categories, { text, lang, context: "chat", immutable: false, agent });
          return categories.length > 0 ? [{ text, lang, agent, categories }] : [];
        }),
      ),
    );
    expect(triggered).toEqual([]);
  });
}

it("the negative corpus check would catch a phrase that triggers", () => {
  const retail = contract("examples/claim-contract/retail.json");
  const output: claims.Output = { text: "Infelizmente está esgotado.", lang: "pt", context: "chat", immutable: false };
  expect(claims.detected(retail.categories, output)).toEqual(["availability_denial"]);
});
