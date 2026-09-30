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
 * The evidence is what the turn's tools returned, in their results and in the objects they showed, and what
 * the include blocks of its reads served (`blockValues`), each fresh for a claim or not, never the pack's text:
 *
 * - a field named like a role of a category is a value of that role and of that category's classes, so a
 *   number said with the role and a different value is a `mismatch`, and one with the same value `matched`;
 * - any other number, amount or date in them backs a number said with the same value, of the class the
 *   output gives it.
 */

import { internalRecord } from "../claims/internal.js";
import type { InternalText } from "../claims/internal.js";
import { check, sameValue } from "../claims/check.js";
import type { Finding, Turn, TurnValue } from "../claims/check.js";
import { decimal, decimalText } from "../claims/decimal.js";
import { mentions } from "../claims/numbers.js";
import type { Language, Mention, MentionClass, Value } from "../claims/numbers.js";
import type { ConstraintsBlock } from "../types/signals.js";
import type { ClaimContractSummary, StateView } from "../types/state.js";
import type { ClaimRecord } from "../types/turns.js";
import type { Said, StateValue, TurnFrame } from "./frame.js";

/** A string of a result longer than this is prose, not a value: it is not read for numbers. */
const MAX_TEXT = 200;
const STANDING = new Set(["matched", "quoted_found", "anchored"]);

/** The claims of everything the turn said, as the record carries them, in count mode. */
export function checkTurn(frame: TurnFrame, contract: ClaimContractSummary, internal?: InternalText): ClaimRecord[] {
  return frame.said.flatMap((said) => checkSaid(frame, contract, said, internal));
}

/**
 * The claims of one output in count mode: a claim that stands records `none`, any other `count`, and so does a
 * passage of the company's own prompt it repeats.
 */
export function checkSaid(frame: TurnFrame | undefined, contract: ClaimContractSummary, said: Said, internal?: InternalText): ClaimRecord[] {
  const records = findingsOf(frame, contract, said).map((f) => recordOf(f, STANDING.has(f.verdict) ? "none" : "count"));
  return [...records, ...passages(contract, internal, said.text).map(([span, ref]) => internalRecord(span, ref, "count"))];
}

/** Where `text` repeats the company's prompt the contract names, with the prompt's version. */
export function passages(contract: ClaimContractSummary, internal: InternalText | undefined, text: string): [[number, number], string][] {
  const config = contract.internal_text;
  if (!config || internal === undefined) return [];
  return internal.passages(text, config.shingle_hashes_ref, config.n ?? 8).map((span) => [span, config.shingle_hashes_ref]);
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

/**
 * Every value a read's include blocks served, as the claim check's evidence (the claim contract spec, 4.3): the
 * fields and computed values of the state view's objects and of the shared objects the subject showed interest
 * in, the new value of each field that changed since they saw it, the values of the constraints block's lines
 * (what the subject requires, prefers and is), and the numbers each object shown was last shown with (an
 * offer's price, total, discount or installment).
 *
 * A value backs a claim only while it is claim-safe. A field or an offer's number that is not stays as a copy
 * too old to back one, so a claim that repeats it is `stale`; a computed value that is not backs nothing. A changed field's new
 * value is as claim-safe as the object's field, and not at all without the object; the value it was seen at
 * is not evidence. The subject's own constraints always back a claim, except one that lost a conflict and was
 * left out of the block. A masked or unknown value backs nothing.
 */
export function blockValues(state: StateView | null | undefined, constraints: ConstraintsBlock | null | undefined): StateValue[] {
  const out: StateValue[] = [];
  if (state) {
    const objects = [...(state.objects ?? []), ...(state.interests ?? []).flatMap((i) => (i.object ? [i.object] : []))];
    for (const item of objects) {
      const ref = `${item.ref.type}:${item.ref.namespace}:${item.ref.id}`;
      const gaps = item.declared_gaps ?? [];
      const claimable = (item.blocked?.claim ?? []).length === 0;
      for (const [name, field] of Object.entries(item.fields ?? {})) {
        if (field.masked || field.logic !== "yes" || field.v == null) continue;
        out.push({ ref, field: name, value: field.v, claimSafe: field.claim_safe && claimable, role: field.role ?? null, declaredGaps: gaps });
      }
      for (const [name, value] of Object.entries(item.values ?? {})) {
        if (value.logic !== "yes" || value.v == null || !(value.claim_safe && claimable)) continue;
        out.push({ ref, field: name, value: value.v, claimSafe: true, role: null, declaredGaps: [...new Set([...gaps, ...(value.declared_gaps ?? [])])] });
      }
    }
    const served = new Set(out.map((v) => `${v.ref ?? ""}\n${v.field}`));
    for (const change of state.changes_since_seen ?? []) {
      const ref = `${change.ref.type}:${change.ref.namespace}:${change.ref.id}`;
      if (change.now != null && !served.has(`${ref}\n${change.field}`)) out.push({ ref, field: change.field, value: change.now, claimSafe: false });
    }
  }
  if (constraints) {
    const lost = new Set((constraints.conflicts ?? []).flatMap((c) => c.ids.filter((i) => i !== c.kept)));
    const said: [string, unknown][] = (constraints.hard ?? []).filter((h) => !lost.has(h.id)).flatMap((h) => h.values.map((v): [string, unknown] => [h.attr, v]));
    for (const s of constraints.soft ?? []) said.push([s.attr, s.value]);
    for (const a of constraints.attributes ?? []) said.push([a.name, a.value]);
    // A constraint names a field of a type (`health_plan.monthly_price`), and backs a claim by the field.
    for (const [attr, value] of said) out.push({ ref: null, field: attr.split(".").pop() ?? attr, value, claimSafe: true });
    for (const shown of constraints.already_presented ?? []) {
      for (const [field, n] of Object.entries(shown.values ?? {})) {
        out.push({ ref: shown.ref, field, value: n.v, claimSafe: n.claim_safe, role: n.role ?? null });
      }
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
    // A value from a block backs a claim only while it is fresh enough for one.
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

