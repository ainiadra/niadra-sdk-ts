/**
 * The claim check (the claim contract spec, sections 4 to 8): the claims each category detects in an
 * output, their nature, the verdict against what the turn holds, and the action the contract takes for the
 * output's context.
 *
 * Detection: numbers of the category's classes (in a sentence with one of its terms, when it lists terms),
 * each occurrence of a term (when it lists terms and no classes), statute and precedent citations, and the
 * sentences of named document sections. Nature, for a number: `quoted` inside quotation marks; `computed`
 * when the turn holds a value of the same role, or the same value; `model` otherwise. Verdicts that stand
 * (`matched`, `quoted_found`, `anchored`) take no action; `not_checked` is counted; every other one takes the
 * category's action for the context, and `unsupported` the action its natures give to what the model said.
 * A rewrite happens only when it is unequivocal (a stale copy of one field whose fresh value differs), and
 * is a warning otherwise. Nothing is ever rewritten in an immutable output, and a block there sends the
 * whole output to a person, untouched.
 */

import type { Actions, ClaimCategory, Detect } from "../types/state.js";
import type { ClaimRecord } from "../types/turns.js";
import { MIN_ANCHOR_MATCH, score } from "./anchor.js";
import { compare, decimal } from "./decimal.js";
import { type Language, type Mention, type MentionClass, type Value, mentions } from "./numbers.js";
import { NO_ROLE, type Role, rolesOf } from "./roles.js";
import { type Span, folded, pattern, phraseAt, phrases, quotations, sentenceOf, sentences, slice, units, words } from "./text.js";

export type Verdict = ClaimRecord["verdict"];
/** What happened to a claim, as the turn record writes it. */
export type Action = ClaimRecord["action"];
export type Nature = NonNullable<ClaimRecord["nature"]>;
type Configured = Actions["default"];

/** Classes a rewrite may touch: a dose, a technical quantity, a count and a label never change. */
const REWRITABLE: ReadonlySet<MentionClass> = new Set<MentionClass>(["money", "percent", "date", "duration"]);
/** Verdicts under which a claim stands, and takes no action. */
const STANDING: ReadonlySet<Verdict> = new Set<Verdict>(["matched", "quoted_found", "anchored"]);

const PATTERNS: Readonly<Record<NonNullable<Detect["patterns"]>[number], RegExp>> = {
  article_citation: pattern(
    String.raw`\b(?:art|arts|artigo|artigos|article|articles|articulo|articulos)\b\.?\s*(?:n[o.]?\s*)?\d+(?:o|-[a-z])?` +
      String.raw`(?![\w])`,
    "g",
  ),
  precedent_citation: pattern(
    String.raw`\b(?:resp|aresp|re|are|agrg|agint|hc|ms|adi|adpf|rr|airr)\b\s*(?:n[o.]?\s*)?\d[\d.]*(?:/[a-z]{2})?` +
      String.raw`|\bsumula\s+(?:vinculante\s+)?(?:n[o.]?\s*)?\d+|\btema\s+(?:n[o.]?\s*)?\d[\d.]*\d`,
    "g",
  ),
};

/** A value with provenance the turn holds: a field of a tool's result or of a state read. */
export interface TurnValue {
  readonly cls: MentionClass;
  /** As `Mention.value()` writes it. */
  readonly value: Value;
  readonly role?: string | null;
  /** True unless said otherwise. */
  readonly fresh?: boolean;
  readonly objectType?: string | null;
  /** The field or computed value it is. */
  readonly name?: string | null;
  readonly callId?: string | null;
  readonly ref?: string | null;
  readonly declaredGaps?: readonly string[];
}

/** A passage an output cites, as the tool or the agent emitted it: where, what it quotes, from what. */
export interface Anchor {
  readonly start: number;
  readonly end: number;
  readonly quote: string;
  readonly document: string;
}

/** What the turn holds to check an output against. */
export interface Turn {
  readonly values?: readonly TurnValue[];
  /** The tools called in the turn. */
  readonly tools?: readonly string[];
  /** The documents in hand, by id: what quotes and anchors are checked against. */
  readonly documents?: Readonly<Record<string, string>>;
  readonly anchors?: readonly Anchor[];
  /** The output's named sections, as spans, when it is a document. */
  readonly sections?: Readonly<Record<string, readonly Span[]>>;
}

/** One claim a category found, its verdict and what happened to it. */
export interface Finding {
  readonly category: string;
  readonly start: number;
  readonly end: number;
  readonly verdict: Verdict;
  readonly action: Action;
  /** For a number. */
  readonly cls: MentionClass | null;
  readonly nature: Nature | null;
  readonly role: string | null;
  readonly value: Value | null;
  readonly evidence: TurnValue | Anchor | null;
}

/** The text the check reads, in its language and context (`chat`, `proposal`, `contestacao`). */
export interface Output {
  readonly text: string;
  readonly lang: Language;
  readonly context: string;
  readonly immutable: boolean;
  readonly agent?: string | null;
}

function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

function dateParts(iso: string): [number | null, number | null, number | null] {
  const part = (raw: string | undefined): number => {
    if (raw === undefined || !/^\d+$/.test(raw)) throw new TypeError(`not a date: ${JSON.stringify(iso)}`);
    return Number(raw);
  };
  if (iso.startsWith("---")) return [null, null, part(iso.slice(3))];
  if (iso.startsWith("--")) {
    const [month, day, ...rest] = iso.slice(2).split("-");
    if (rest.length > 0) part(undefined);
    return [null, part(month), part(day)];
  }
  const parts = iso.split("-");
  if (parts.length > 3) part(undefined);
  return [part(parts[0]), part(parts[1]), parts.length === 3 ? part(parts[2]) : null];
}

/**
 * Equal on every part both state, and both state a day or neither does: "5 de outubro" is the 5th of
 * October of any year, never "outubro de 2026".
 */
function sameDate(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const pa = dateParts(a);
  const pb = dateParts(b);
  if ((pa[2] === null) !== (pb[2] === null)) return false;
  return pa.every((x, i) => x === null || pb[i] === null || x === pb[i]);
}

const valueKeys = (value: Value): string =>
  Object.keys(value)
    .filter((k) => k !== "unit")
    .sort()
    .join(" ");

/**
 * The same number: equal amounts (or ends of a range), or the same date; a unit only counts when both have
 * one, so "511,06" is the R$ 511,06 of a tool's result.
 */
export function sameValue(a: Value, b: Value): boolean {
  if (a.unit && b.unit && a.unit !== b.unit) return false;
  if (valueKeys(a) !== valueKeys(b)) return false;
  if ("date" in a) return sameDate(a.date, b.date);
  if ("date_from" in a) return sameDate(a.date_from, b.date_from) && sameDate(a.date_to, b.date_to);
  return (["amount", "min", "max"] as const).every((k) => {
    const x = a[k];
    return x === undefined || compare(decimal(x), decimal(b[k] ?? "")) === 0;
  });
}

function inQuotes(text: string, start: number, end: number): Span | null {
  return quotations(text).find(([s, e]) => s <= start && end <= e) ?? null;
}

function termHits(text: string, terms: readonly string[]): Span[] {
  const found = words(text);
  const hits = new Map<string, Span>();
  for (const phrase of phrases(terms)) {
    for (let i = 0; i < found.length; i++) {
      const first = found[i];
      const last = found[i + phrase.length - 1];
      if (first && last && phraseAt(found, i, phrase)) hits.set(`${first.start} ${last.end}`, [first.start, last.end]);
    }
  }
  return [...hits.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function numbersOf(detect: Detect, output: Output): Mention[] {
  const classes: readonly string[] = detect.classes ?? [];
  const found = mentions(output.text, output.lang).filter((m) => classes.includes(m.cls));
  const terms = detect.terms ?? [];
  if (terms.length === 0) return found;
  const hits = termHits(output.text, terms).map(([start]) => start);
  return found.filter((m) => {
    const [low, high] = sentenceOf(output.text, m.start);
    return hits.some((h) => low <= h && h < high);
  });
}

/** A declared gap is stated by one of its words, or by its name when the contract gives none. */
function stated(gap: string, output: Output, gapTerms: Readonly<Record<string, string[]>>): boolean {
  const terms = own(gapTerms, gap);
  return termHits(output.text, terms && terms.length > 0 ? terms : [gap.replaceAll("_", " ")]).length > 0;
}

function settle(category: ClaimCategory, output: Output, verdict: Verdict, chosen: Configured | null = null): Action {
  if (STANDING.has(verdict)) return "none";
  if (verdict === "not_checked") return "count";
  const configured = chosen ?? own(category.actions.contexts, output.context) ?? category.actions.default;
  if (configured === "rewrite_if_unequivocal") return "rewrite";
  if (configured === "discard_anchor_and_count") return "discard_anchor";
  return configured;
}

/**
 * The value a stale number is rewritten to, when that is unequivocal: a mutable output, a point value of a
 * class that may change, a literal copy of one field of one object whose fresh value differs, and no other
 * number of the class in the sentence (a derived one would go wrong). Null otherwise.
 */
function rewrite(output: Output, mention: Mention, turn: Turn, stale: TurnValue): TurnValue | null {
  const [low, high] = sentenceOf(output.text, mention.start);
  const others = mentions(output.text, output.lang).filter((m) => m.cls === mention.cls && low <= m.start && m.start < high);
  const sameField = (turn.values ?? []).filter(
    (v) => v.cls === stale.cls && (v.ref ?? null) === (stale.ref ?? null) && (v.name ?? null) === (stale.name ?? null),
  );
  const fresh = sameField.filter((v) => (v.fresh ?? true) && !sameValue(v.value, stale.value));
  const single = (stale.ref ?? null) !== null && (stale.name ?? null) !== null && fresh.length === 1;
  if (output.immutable || !REWRITABLE.has(mention.cls) || mention.isRange || others.length > 1 || !single) return null;
  return fresh[0] ?? null;
}

interface Judged {
  nature: Nature;
  verdict: Verdict;
  evidence?: TurnValue;
  /** An action that overrides the category's: what its natures give to a number the model said. */
  chosen?: Configured | null;
}

/**
 * `quoted` inside quotation marks; `computed` when the turn holds a value of the number's class with its
 * role or its value; `model` otherwise.
 */
export function natureOf(text: string, mention: Mention, role: Role, values: readonly TurnValue[]): Nature {
  if (inQuotes(text, mention.start, mention.end) !== null) return "quoted";
  const value = mention.value();
  const computed = values.some(
    (v) =>
      v.cls === mention.cls &&
      ((role.name !== null && (v.role ?? null) === role.name) || (value !== null && sameValue(v.value, value))),
  );
  return computed ? "computed" : "model";
}

const SPACES = pattern(String.raw`\s+`, "g");
const NOT_SPACE = pattern(String.raw`[^\s]`);

/** Words separated by one space, as Python's `" ".join(text.split())` writes them. */
function squeezed(text: string): string {
  return text.replace(SPACES, " ").replace(/^ | $/g, "");
}

function judge(category: ClaimCategory, output: Output, turn: Turn, mention: Mention, role: Role, value: Value): Judged {
  const values = turn.values ?? [];
  const ofClass = values.filter((v) => v.cls === mention.cls);
  const nature = natureOf(output.text, mention, role, values);
  if (nature === "quoted") {
    if (category.natures?.quoted === "count") return { nature, verdict: "not_checked" };
    const [start, end] = inQuotes(output.text, mention.start, mention.end) ?? [mention.start, mention.end];
    const passage = squeezed(slice(output.text, start, end)).toLowerCase();
    const found = Object.values(turn.documents ?? {}).some((doc) => squeezed(doc).toLowerCase().includes(passage));
    return { nature, verdict: found ? "quoted_found" : "quoted_missing" };
  }
  const byRole = ofClass.filter((v) => role.name !== null && (v.role ?? null) === role.name);
  const spec = category.evidence.value ?? null;
  if (spec === null) return { nature, verdict: toolsVerdict(category, turn) };
  if (nature === "model") return { nature, verdict: "unsupported", chosen: category.natures?.model ?? null };
  if (category.natures?.computed === "count") return { nature, verdict: "not_checked" };
  if (role.status === "ambiguous") return { nature, verdict: "role_ambiguous" };
  // A number with no word of a role is checked against every value of its class: only a named role narrows.
  let candidates = spec.same_role && role.name !== null ? byRole : ofClass;
  const type = spec.type ?? null;
  if (type !== null) {
    candidates = candidates.filter(
      (v) => (v.objectType ?? null) === type && [spec.value ?? null, null].includes(v.name ?? null),
    );
  }
  const matched = candidates.find((v) => sameValue(v.value, value));
  if (matched === undefined) return { nature, verdict: candidates.length > 0 ? "mismatch" : "no_evidence" };
  if (spec.fresh_for === "claim" && !(matched.fresh ?? true)) return { nature, verdict: "stale", evidence: matched };
  const unsaid = (matched.declaredGaps ?? []).filter((gap) => !stated(gap, output, spec.gap_terms ?? {}));
  if (spec.must_state_gaps && unsaid.length > 0) return { nature, verdict: "gap_not_stated", evidence: matched };
  return { nature, verdict: "matched", evidence: matched };
}

function numberFinding(category: ClaimCategory, output: Output, turn: Turn, mention: Mention, role: Role): Finding {
  const value = mention.value();
  const judged = judge(category, output, turn, mention, role, value ?? {});
  let action = settle(category, output, judged.verdict, judged.chosen);
  let evidence = judged.evidence ?? null;
  if (action === "rewrite") {
    const fresh = judged.verdict === "stale" && evidence !== null ? rewrite(output, mention, turn, evidence) : null;
    // The evidence of a rewrite is the fresh value the number becomes.
    if (fresh !== null) evidence = fresh;
    else action = "warn";
  }
  return {
    category: category.id,
    start: mention.start,
    end: mention.end,
    verdict: judged.verdict,
    action,
    cls: mention.cls,
    nature: judged.nature,
    role: role.name,
    value,
    evidence,
  };
}

function toolsVerdict(category: ClaimCategory, turn: Turn): Verdict {
  const { tool, tool_any } = category.evidence;
  const needed = tool ? [tool] : (tool_any ?? []);
  return needed.some((name) => (turn.tools ?? []).includes(name)) ? "matched" : "no_evidence";
}

/** A claim that is no number: a term, a citation, a sentence of a document section. */
function plainFinding(category: ClaimCategory, output: Output, turn: Turn, start: number, end: number): Finding {
  const claim = { category: category.id, start, end, cls: null, nature: null, role: null, value: null };
  const anchorSpec = category.evidence.anchor ?? null;
  if (anchorSpec === null) {
    const verdict = toolsVerdict(category, turn);
    return { ...claim, verdict, action: settle(category, output, verdict), evidence: null };
  }
  const anchor = (turn.anchors ?? []).find((a) => a.start < end && start < a.end);
  if (anchor === undefined) return { ...claim, verdict: "not_checked", action: "count", evidence: null };
  const document = own(turn.documents, anchor.document);
  let verdict: Verdict = "source_missing";
  if (document !== undefined) {
    verdict = score(anchor.quote, document) >= (anchorSpec.min_match ?? MIN_ANCHOR_MATCH) ? "anchored" : "below_threshold";
  }
  return { ...claim, verdict, action: settle(category, output, verdict), evidence: anchor };
}

/** Every claim of `output` that a category detects, in the contract's order and then the text's. */
export function check(categories: readonly ClaimCategory[], output: Output, turn: Turn = {}): Finding[] {
  const findings: Finding[] = [];
  const text = folded(output.text);
  for (const category of categories) {
    const agents = category.agents ?? [];
    if (agents.length > 0 && (output.agent == null || !agents.includes(output.agent))) continue;
    const detect = category.detect;
    if ((detect.classes ?? []).length > 0) {
      const numbers = numbersOf(detect, output);
      // Numbers of one class compete for the words around them; a date and a duration never do.
      const roles = new Map<Mention, Role>();
      for (const cls of new Set(numbers.map((m) => m.cls))) {
        const same = numbers.filter((m) => m.cls === cls);
        const found = rolesOf(output.text, same, detect.roles ?? {});
        same.forEach((m, i) => roles.set(m, found[i] ?? NO_ROLE));
      }
      findings.push(...numbers.map((m) => numberFinding(category, output, turn, m, roles.get(m) ?? NO_ROLE)));
    } else if ((detect.terms ?? []).length > 0) {
      for (const [start, end] of termHits(output.text, detect.terms ?? [])) {
        findings.push(plainFinding(category, output, turn, start, end));
      }
    }
    for (const name of detect.patterns ?? []) {
      for (const m of text.matchAll(PATTERNS[name])) {
        findings.push(plainFinding(category, output, turn, m.index, m.index + m[0].length));
      }
    }
    for (const section of detect.document_sections ?? []) {
      for (const [low, high] of own(turn.sections, section) ?? []) {
        for (const [start, end] of sentences(output.text)) {
          if (low <= start && end <= high && NOT_SPACE.test(units(output.text).slice(start, end))) {
            findings.push(plainFinding(category, output, turn, start, end));
          }
        }
      }
    }
  }
  return findings;
}

/** The categories that detect anything in `output`: what a phrase of the negative corpus must never trigger. */
export function detected(categories: readonly ClaimCategory[], output: Output): string[] {
  return [...new Set(check(categories, output).map((f) => f.category))].sort();
}
