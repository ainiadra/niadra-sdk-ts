/**
 * The constraints block rendered for one tool call (`spec/constraints.md`, sections 6 and 7): what the
 * call's arguments can carry through the tool's binding, what they cannot (the residual), and, after the
 * call, how much of what was sent the results honored. The server runs the same rules for
 * `POST /v1/constraints` with a tool.
 *
 * - A hard constraint renders through the binding argument of its field: `in` and `eq` to the argument,
 *   `not_in` and `ne` to its negation parameter, a comparison or `between` only to an argument that
 *   declares it in `ops`. One value renders as itself, several as a list; `transform` changes the case of
 *   text.
 * - A hard constraint that lost a conflict of the block is not rendered at all.
 * - A constraint of a category holds only for a call of that category.
 * - An attribute renders through the argument of its family (`size` for `size.pants`) when it applies:
 *   `always`, or `when_asked` and the person asked for it this turn.
 * - What no argument can express is residual: the SDK filters it from the results when the tool
 *   overfetches, and it is otherwise unenforced. `exclude` is always residual.
 * - Advisory mode (the default) changes nothing and suggests. Apply mode adds only what the call left out,
 *   and only a hard constraint said in this turn or this session, or an attribute the person said; it never
 *   overrides an argument the call set (the current utterance wins, and the clash is reported as a
 *   conflict), and never adds an inferred size.
 * - A block for another beneficiary than the call's does not apply at all.
 *
 * The same rules as the Python SDK's `niadra.constraints.render`.
 */

import { fold } from "../claims/text.js";
import type { ConstraintsBlock, HardConstraint } from "../types/signals.js";

type Op = HardConstraint["op"];

const SAID = new Set<string>(["stated", "tool_args", "correction"]);
const NEGATED = new Set<Op>(["not_in", "ne"]);
const POSITIVE = new Set<Op>(["in", "eq"]);

/** One argument of a tool's binding (`tool-bindings`): the field it carries and how. */
export interface BindingArg {
  /** The field, `type.field`. */
  attr: string;
  param: string;
  transform?: "lower" | "upper" | null;
  /** The parameter that carries the field's negation (`not_in`, `ne`). */
  negation?: string | null;
  /** The comparisons the parameter accepts besides `in` and `eq`. */
  ops?: readonly string[];
  /** The attribute family of the field (`size`), from the type registry. */
  family?: string | null;
}

export interface Binding {
  tool: string;
  args: readonly BindingArg[];
  /** The tool returns more than asked, so the SDK can filter the residual from its results. */
  overfetch?: boolean;
}

/** The call the model made. */
export interface Call {
  args: Readonly<Record<string, unknown>>;
  /** Whose call it is: `self` (the default), `beneficiary:<id>` or `gift`. */
  for?: string;
  category?: string | null;
  /** The attributes the person asked to use this turn ("in my size": `size`). */
  asked?: readonly string[];
}

export interface Rendering {
  applies: boolean;
  /** What the call sends: its own arguments, plus what apply mode added. */
  args: Record<string, unknown>;
  suggested: Record<string, unknown>;
  injected: string[];
  hardSent: string[];
  residual: string[];
  postFilter: string[];
  /** A hard constraint and the argument the call set against it. */
  conflicts: { id: string; param: string }[];
}

/** What the results show of the hard constraints sent: "sent, verifiable, violated", never only sent. */
export interface Honored {
  resultsChecked: number;
  violations: number;
  /** Results without the constrained field: without this count, conformance lies upward. */
  unverifiable: number;
}

/** The block for one call of the tool `binding` describes. */
export function render(
  block: ConstraintsBlock,
  binding: Binding,
  call: Call,
  mode: "advisory" | "apply" = "advisory",
): Rendering {
  if ((block.subject?.for ?? "self") !== (call.for ?? "self")) {
    const args = { ...call.args };
    return { applies: false, args, suggested: {}, injected: [], hardSent: [], residual: [], postFilter: [], conflicts: [] };
  }
  const hard = block.hard ?? [];
  const attributes = block.attributes ?? [];
  const lost = new Set((block.conflicts ?? []).flatMap((c) => c.ids.filter((id) => id !== c.kept)));
  const category = call.category ?? null;
  const suggested = new Map<string, unknown>();
  const sources = new Map<string, string[]>();
  const residual: string[] = [];
  const conflicts: { id: string; param: string }[] = [];
  const routed: [HardConstraint, string][] = [];
  for (const h of hard) {
    if (lost.has(h.id) || (h.category != null && h.category !== category)) continue;
    const route = routeOf(h, binding);
    if (!route) {
      residual.push(h.id);
      continue;
    }
    const [arg, param] = route;
    let value = shape(h.values, arg.transform);
    if (suggested.has(param)) {
      if (!POSITIVE.has(h.op) && !NEGATED.has(h.op)) {
        residual.push(h.id);
        continue;
      }
      const before = asList(suggested.get(param));
      const merged = [...before, ...asList(value).filter((v) => !before.includes(v))];
      value = merged.length === 1 ? merged[0] : merged;
    }
    suggested.set(param, value);
    sources.set(param, [...(sources.get(param) ?? []), h.id]);
    routed.push([h, param]);
    if (against(h, arg, call.args)) conflicts.push({ id: h.id, param: arg.param });
  }
  const asked = new Set(call.asked ?? []);
  for (const a of attributes) {
    const family = a.name.split(".")[0] ?? a.name;
    if (a.category != null && a.category !== category) continue;
    if (a.apply !== "always" && !asked.has(family) && !asked.has(a.name)) continue;
    const carrier = binding.args.find((b) => b.family === family);
    if (carrier && !suggested.has(carrier.param)) {
      suggested.set(carrier.param, shape([a.value], carrier.transform));
      sources.set(carrier.param, [a.id]);
    }
  }
  if ((block.exclude ?? []).length > 0) residual.push("exclude");
  const args = new Map(Object.entries(call.args));
  const injected: string[] = [];
  if (mode === "apply") {
    const disputed = new Set(conflicts.map((c) => c.id));
    const allowed = new Set([
      ...hard
        .filter((h) => SAID.has(h.source) && (h.scope === "turn" || h.scope === "session") && !disputed.has(h.id))
        .map((h) => h.id),
      ...attributes.filter((a) => a.source === "stated" || a.source === "correction").map((a) => a.id),
    ]);
    for (const [param, value] of suggested) {
      const ids = sources.get(param) ?? [];
      if (!args.has(param) && ids.every((id) => allowed.has(id))) {
        args.set(param, value);
        injected.push(...ids);
      }
    }
  }
  const hardSent = routed.filter(([h, param]) => sent(h, param, args)).map(([h]) => h.id);
  return {
    applies: true,
    args: Object.fromEntries(args),
    suggested: Object.fromEntries(suggested),
    injected,
    hardSent,
    residual,
    postFilter: binding.overfetch ? [...residual] : [],
    conflicts,
  };
}

/**
 * Each result item, keyed by `type.field`, is a violation when it breaks a hard constraint that was sent,
 * and unverifiable when it breaks none but lacks the field of one.
 */
export function honored(
  block: ConstraintsBlock,
  sentIds: readonly string[],
  results: readonly Readonly<Record<string, unknown>>[],
): Honored {
  const checks = (block.hard ?? []).filter((h) => sentIds.includes(h.id));
  let violations = 0;
  let unverifiable = 0;
  for (const item of results) {
    if (checks.some((h) => item[h.attr] != null && !satisfies(h.op, h.values, item[h.attr]))) violations++;
    else if (checks.some((h) => item[h.attr] == null)) unverifiable++;
  }
  return { resultsChecked: results.length, violations, unverifiable };
}

/** Whether `value` honors `op` over `values`; text is compared folded, numbers as exact decimals. */
export function satisfies(op: Op, values: readonly unknown[], value: unknown): boolean {
  const got = keyOf(value);
  const want = values.map(keyOf);
  const first = want[0];
  switch (op) {
    case "in":
    case "eq":
      return want.some((w) => same(got, w));
    case "not_in":
    case "ne":
      return !want.some((w) => same(got, w));
    case "lt":
      return holds(compare(got, first), (c) => c < 0);
    case "lte":
      return holds(compare(got, first), (c) => c <= 0);
    case "gt":
      return holds(compare(got, first), (c) => c > 0);
    case "gte":
      return holds(compare(got, first), (c) => c >= 0);
    case "between":
      return holds(compare(first, got), (c) => c <= 0) && holds(compare(got, want[1]), (c) => c <= 0);
  }
}

function shape(values: readonly unknown[], transform: BindingArg["transform"]): unknown {
  const out = values.map((v) => {
    if (typeof v !== "string") return v;
    return transform === "lower" ? v.toLowerCase() : transform === "upper" ? v.toUpperCase() : v;
  });
  return out.length === 1 ? out[0] : out;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? [...(value as unknown[])] : [value];
}

/** The argument and parameter a hard constraint renders through, if any can express it. */
function routeOf(h: HardConstraint, binding: Binding): [BindingArg, string] | null {
  for (const arg of binding.args) {
    if (arg.attr !== h.attr) continue;
    const ops = arg.ops ?? [];
    if (POSITIVE.has(h.op) && (ops.length === 0 || ops.includes(h.op) || ops.includes("in"))) return [arg, arg.param];
    if (NEGATED.has(h.op) && arg.negation != null) return [arg, arg.negation];
    if (!POSITIVE.has(h.op) && !NEGATED.has(h.op) && ops.includes(h.op)) return [arg, arg.param];
  }
  return null;
}

function sent(h: HardConstraint, param: string, args: ReadonlyMap<string, unknown>): boolean {
  if (!args.has(param)) return false;
  const given = asList(args.get(param));
  if (NEGATED.has(h.op)) return h.values.every((v) => satisfies("in", given, v));
  if (POSITIVE.has(h.op)) return given.every((v) => satisfies("in", h.values, v));
  return given.every((v) => satisfies(h.op, h.values, v));
}

/** The call set the field's own argument to something the constraint refuses. */
function against(h: HardConstraint, arg: BindingArg, args: Readonly<Record<string, unknown>>): boolean {
  if (!Object.hasOwn(args, arg.param)) return false;
  return asList(args[arg.param]).some((v) => !satisfies(h.op, h.values, v));
}

/**
 * A value as the comparisons read it: a number (or text that reads as one, or a boolean as 1 or 0) as an
 * exact decimal, `sign * digits * 10^exponent` without leading or trailing zeros; other text folded and
 * trimmed; anything else compares with nothing.
 */
type Key =
  | { kind: "number"; sign: -1 | 0 | 1; digits: string; exponent: number }
  | { kind: "text"; text: string }
  | { kind: "other" };

const DECIMAL = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i;

const OTHER: Key = { kind: "other" };

function keyOf(value: unknown): Key {
  if (typeof value === "string") {
    return decimal(value.trim().replace(/_/g, "")) ?? { kind: "text", text: fold(value).trim() };
  }
  const number = typeof value === "boolean" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? (decimal(String(number)) ?? OTHER) : OTHER;
}

function decimal(text: string): Key | null {
  const m = DECIMAL.exec(text);
  if (!m) return null;
  const fraction = m[3] ?? m[4] ?? "";
  const all = `${m[2] ?? ""}${fraction}`.replace(/^0+/, "");
  const digits = all.replace(/0+$/, "");
  if (!digits) return { kind: "number", sign: 0, digits: "", exponent: 0 };
  const exponent = Number(m[5] ?? 0) - fraction.length + (all.length - digits.length);
  return { kind: "number", sign: m[1] === "-" ? -1 : 1, digits, exponent };
}

function same(a: Key, b: Key | undefined): boolean {
  if (a.kind === "number" && b?.kind === "number") {
    return a.sign === b.sign && a.digits === b.digits && a.exponent === b.exponent;
  }
  return a.kind === "text" && b?.kind === "text" && a.text === b.text;
}

/** The order of two keys, or null when they do not compare (text with a number, a missing bound). */
function compare(a: Key | undefined, b: Key | undefined): number | null {
  if (a?.kind === "text" && b?.kind === "text") return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  if (a?.kind !== "number" || b?.kind !== "number") return null;
  if (a.sign !== b.sign) return a.sign < b.sign ? -1 : 1;
  if (a.sign === 0) return 0;
  // The magnitude: first the place of the leading digit, then the digits from it.
  const lead = a.digits.length + a.exponent - (b.digits.length + b.exponent);
  if (lead !== 0) return lead * a.sign < 0 ? -1 : 1;
  const width = Math.max(a.digits.length, b.digits.length);
  const left = a.digits.padEnd(width, "0");
  const right = b.digits.padEnd(width, "0");
  return left === right ? 0 : (left < right ? -1 : 1) * a.sign;
}

function holds(order: number | null, test: (order: number) => boolean): boolean {
  return order !== null && test(order);
}
