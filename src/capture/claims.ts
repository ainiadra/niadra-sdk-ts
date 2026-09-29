/**
 * The claim contract in the turn: what the agent said inside a turn, checked against what the turn holds, and
 * recorded in the record's `claims` (`spec/claim-contract.md`, section 12).
 *
 * Count mode never changes an output. Every claim gets its verdict, and the act recorded is what was done: a
 * claim that stands (`matched`, `quoted_found`, `anchored`) records `none`, and any other one `count`,
 * whatever the contract's configured action would do. It runs on the sender, off the agent's path, on
 * everything the turn said that the guard did not see, and on demand (`conversation.claims.check()`). The
 * guard (`conversation.claims.guard()`, `capture/guard.ts`) acts, and records the act it took.
 *
 * The evidence is what the turn's tools returned, in their results and in the objects they showed, and the
 * fields its state reads served, each fresh for a claim or not:
 *
 * - a field named like a role of a category is a value of that role and of that category's classes, so a
 *   number said with the role and a different value is a `mismatch`, and one with the same value `matched`;
 * - any other number, amount or date in them backs a number said with the same value, of the class the
 *   output gives it.
 */

import { check, sameValue } from "../claims/check.js";
import type { Finding, Turn, TurnValue } from "../claims/check.js";
import { decimal, decimalText } from "../claims/decimal.js";
import { mentions } from "../claims/numbers.js";
import type { Language, Mention, MentionClass, Value } from "../claims/numbers.js";
import type { ClaimContractSummary, ObjectRead } from "../types/state.js";
import type { ClaimRecord } from "../types/turns.js";
import type { Said, StateValue, TurnFrame } from "./frame.js";

/** A string of a result longer than this is prose, not a value: it is not read for numbers. */
const MAX_TEXT = 200;
const STANDING = new Set(["matched", "quoted_found", "anchored"]);

/** The claims of everything the turn said, as the record carries them, in count mode. */
export function checkTurn(frame: TurnFrame, contract: ClaimContractSummary): ClaimRecord[] {
  return frame.said.flatMap((said) => checkSaid(frame, contract, said));
}

/** The claims of one output in count mode: a claim that stands records `none`, any other `count`. */
export function checkSaid(frame: TurnFrame | undefined, contract: ClaimContractSummary, said: Said): ClaimRecord[] {
  return findingsOf(frame, contract, said).map((f) => recordOf(f, STANDING.has(f.verdict) ? "none" : "count"));
}

/** The claims of one output, with the verdict and the act its category's action gives. */
export function findingsOf(frame: TurnFrame | undefined, contract: ClaimContractSummary, said: Said): Finding[] {
  const lang = (contract.languages[0] ?? "pt");
  const spoken = mentions(said.text, lang).filter((m) => m.cls !== "label");
  const turn: Turn = frame !== undefined ? evidence(frame, contract, spoken, lang) : {};
  return check(contract.categories ?? [], { text: said.text, lang, context: said.context, immutable: said.immutable, agent: said.agent }, turn);
}

/** A finding as the turn record's `claims` carries it, with what was done (`act`). */
export function recordOf(finding: Finding, act: ClaimRecord["action"]): ClaimRecord {
  const record: ClaimRecord = { category: finding.category, span: [finding.start, finding.end], verdict: finding.verdict, action: act };
  if (finding.cls !== null && finding.cls !== "label") {
    record.class = finding.cls;
    if (finding.nature !== null) record.nature = finding.nature;
    if (finding.role !== null) record.role = finding.role;
    if (finding.value !== null) record.value = { ...finding.value };
  }
  const found = finding.evidence;
  if (found !== null && "cls" in found) {
    const ref: NonNullable<ClaimRecord["evidence"]> = {};
    if (found.callId) ref.call_id = found.callId;
    if (found.name) ref.field = found.name;
    if (found.ref) ref.ref = found.ref;
    if (Object.keys(ref).length > 0) record.evidence = ref;
  }
  return record;
}

/** The fields of objects a state read served, as the claim check's evidence. */
export function stateValues(objects: readonly ObjectRead[]): StateValue[] {
  const out: StateValue[] = [];
  for (const item of objects) {
    const ref = `${item.ref.type}:${item.ref.namespace}:${item.ref.id}`;
    for (const [name, field] of Object.entries(item.fields ?? {})) {
      if (field.masked || field.logic !== "yes" || field.v == null) continue;
      out.push({ ref, field: name, value: field.v, claimSafe: field.claim_safe, role: field.role ?? null, declaredGaps: item.declared_gaps ?? [] });
    }
  }
  return out;
}

/** What the turn holds that a claim can stand on: the values its tools returned and its reads served. */
export function evidence(frame: TurnFrame, contract: ClaimContractSummary, spoken: readonly Mention[], lang: Language): Turn {
  const roles = new Map<string, Set<string>>();
  for (const category of contract.categories ?? []) {
    for (const role of Object.keys(category.detect.roles ?? {})) {
      const known = roles.get(role) ?? new Set<string>();
      for (const cls of category.detect.classes ?? []) known.add(cls);
      roles.set(role, known);
    }
  }
  const values: TurnValue[] = [];
  const tools: string[] = [];
  for (const call of frame.calls) {
    if (call.kind !== "tool") continue;
    tools.push(typeof call.name === "string" ? call.name : "");
    const sources: [string | null, unknown][] = [];
    for (const o of (call.observations as { ref?: string; fields?: unknown }[] | undefined) ?? []) sources.push([o.ref ?? null, o.fields ?? {}]);
    const result = frame.valueOf(call.result_model);
    if (result !== undefined) sources.push([null, result]);
    for (const [ref, data] of sources) {
      for (const [key, leaf] of leaves(data, null)) values.push(...valuesOf(key, leaf, ref, call.call_id, roles, spoken, lang));
    }
  }
  for (const item of frame.state) {
    // A field read from state backs a claim only while it is fresh enough for one.
    const name = item.role && roles.has(item.role) ? item.role : item.field;
    for (const [key, leaf] of leaves(item.value, name)) {
      for (const found of valuesOf(key, leaf, item.ref, null, roles, spoken, lang)) {
        values.push({ ...found, fresh: item.claimSafe, name: item.field, declaredGaps: item.declaredGaps ?? [] });
      }
    }
  }
  return { values, tools };
}

function* leaves(value: unknown, key: string | null): Generator<[string | null, unknown]> {
  if (Array.isArray(value)) {
    for (const item of value) yield* leaves(item, key);
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) yield* leaves(v, k);
  } else {
    yield [key, value];
  }
}

function valuesOf(
  key: string | null,
  leaf: unknown,
  ref: string | null,
  callId: string | null,
  roles: ReadonlyMap<string, ReadonlySet<string>>,
  spoken: readonly Mention[],
  lang: Language,
): TurnValue[] {
  let found: [string, Value][] = [];
  if (typeof leaf === "number" && Number.isFinite(leaf)) {
    try {
      found = [["", { amount: decimalText(decimal(String(leaf))) }]];
    } catch {
      return [];
    }
  } else if (typeof leaf === "string" && leaf.length <= MAX_TEXT) {
    found = mentions(leaf, lang).flatMap((m) => {
      const value = m.value();
      return value === null ? [] : [[m.cls, value] as [string, Value]];
    });
  }
  const objectType = ref !== null ? (ref.split(":", 1)[0] ?? null) : null;
  const out: TurnValue[] = [];
  for (const [cls, value] of found) {
    const known = key !== null ? roles.get(key) : undefined;
    const role = known !== undefined && (cls === "" || known.has(cls)) ? key : null;
    let classes: string[];
    if (role !== null && known !== undefined) classes = cls !== "" ? [cls] : [...known].sort();
    else {
      const said = new Set(spoken.filter((m) => m.value() !== null && sameValue(m.value() ?? {}, value)).map((m) => m.cls as string));
      classes = [...said].filter((c) => cls === "" || c === cls).sort();
    }
    for (const c of classes) out.push({ cls: c as MentionClass, value, role, fresh: true, objectType, name: key, callId, ref });
  }
  return out;
}

