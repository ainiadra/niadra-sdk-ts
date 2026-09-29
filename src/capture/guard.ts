/**
 * The claim contract that acts: at the stream bridge, before the customer, or on a whole output before it
 * goes (`spec/claim-contract.md`, sections 8 and 12).
 *
 * ```ts
 * for await (const chunk of conversation.claims.guard(stream)) sse.send(chunk);
 * const guarded = conversation.claims.guardText(reply); // a whole message, or a document before it is saved
 * ```
 *
 * Each claim of the output gets its verdict against what the turn holds, and the category's action for the
 * output's context decides what happens, as the turn record's `claims` then says:
 *
 * - `block`: in a mutable output, the sentence gives way to the category's `replace_with` (once per message;
 *   a later blocked sentence is dropped), or is dropped without one; in an immutable output nothing changes
 *   and the whole output goes to a person (`Guarded.review`);
 * - `rewrite_if_unequivocal`: the number becomes the fresh value of the one field it copies, written the way
 *   the output wrote it, only when that is unequivocal (the spec's 8.3) and the output is mutable; otherwise
 *   the claim is marked `warn`;
 * - `warn`: the text goes as it is and the claim is marked; `count`: only measured; `discard_anchor`: the
 *   anchor is dropped and counted.
 *
 * **In a stream,** text flows through untouched until something could start a claim: a digit, a currency, a
 * quotation mark, or the first word of one of the contract's terms or citation patterns. From there the guard
 * holds the text until the sentence ends, checks it and lets it go as the actions leave it. Where a context
 * blocks, text goes sentence by sentence, so what gives way to the caveat is the whole sentence. A hold lasts
 * at most `holdMs` (150 ms) and a message's holds `messageMs` in total (300 ms): past them the text goes as it
 * is, the turn is flagged `guard_budget_exceeded`, and its claims are recorded as marked. The guard never
 * replaces an answer with an error: a check that fails lets the text through. Offsets are code points.
 */

import { internalRecord } from "../claims/internal.js";
import type { InternalText } from "../claims/internal.js";
import type { Finding } from "../claims/check.js";
import { decimalText } from "../claims/decimal.js";
import { mentions, toDecimal } from "../claims/numbers.js";
import type { Language } from "../claims/numbers.js";
import { folded, pattern, phrases, units } from "../claims/text.js";
import type { ClaimCategory, ClaimContractSummary } from "../types/state.js";
import type { ClaimRecord } from "../types/turns.js";
import { findingsOf, passages, recordOf } from "./claims.js";
import type { TurnFrame } from "./frame.js";

export const HOLD_MS = 150;
export const MESSAGE_MS = 300;
const ACTED = new Set<string>(["block", "rewrite", "warn"]);
const BOUNDARY = pattern(String.raw`[!?;](?=\s)|\.(?=\s+[A-ZÀ-Ý])|\n`, "g");
const TRAILING_WORD = pattern(String.raw`[\w$€£]+$`);
const NUMBER = /\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?/u;
const NUMERIC_DATE = /^(\d{1,2})([/.-])(\d{1,2})(?:\2(\d{2}|\d{4}))?$/u;
const CITATION_WORDS: Record<string, readonly string[]> = {
  article_citation: ["art", "arts", "artigo", "artigos", "article", "articles", "articulo", "articulos"],
  precedent_citation: ["resp", "aresp", "re", "are", "agrg", "agint", "hc", "ms", "adi", "adpf", "rr", "airr", "sumula", "tema"],
};

/** An output after the guard: the text as it may go, the claims recorded for it, and whether a person must see it first. */
export interface Guarded {
  text: string;
  claims: ClaimRecord[];
  review: boolean;
}

export interface GuardOptions {
  context?: string;
  immutable?: boolean;
  agent?: string | null;
  holdMs?: number;
  messageMs?: number;
  now?: () => number;
  /** The company's prompt fingerprints: a passage the output repeats gives way to the contract's line. */
  internal?: InternalText;
}

const cps = (text: string): number => units(text).length;
const cut = (text: string, start: number, end?: number): string => Array.from(text).slice(start, end).join("");

/**
 * The acting check of one output. `feed()` takes text as it arrives and returns what may go now, `expire()`
 * lets a hold that ran out go, and `finish()` returns the rest and records the claims in the turn; `result`
 * is then the whole output as it went.
 */
export class Guard {
  readonly context: string;
  readonly immutable: boolean;
  readonly agent: string | null;
  result: Guarded | null = null;
  private readonly holdMs: number;
  private readonly messageMs: number;
  private readonly now: () => number;
  private readonly categories: ClaimCategory[];
  private readonly candidate: RegExp;
  private readonly whole: boolean;
  private text = "";
  private readonly out: string[] = [];
  private released = 0;
  private heldAt: number | null = null;
  private heldTotal = 0;
  private exceeded = false;
  private readonly unchecked: [number, number][] = [];
  private caveatSent = false;
  private readonly records: ClaimRecord[] = [];
  private review = false;
  private readonly internal: InternalText | undefined;

  constructor(
    private readonly contract: ClaimContractSummary,
    private readonly frame: TurnFrame | undefined,
    options: GuardOptions = {},
  ) {
    this.context = options.context ?? "chat";
    this.immutable = options.immutable ?? (contract.outputs?.immutable ?? []).includes(this.context);
    this.agent = options.agent ?? frame?.agent ?? null;
    this.holdMs = options.holdMs ?? HOLD_MS;
    this.messageMs = options.messageMs ?? MESSAGE_MS;
    this.now = options.now ?? (() => performance.now());
    this.categories = (contract.categories ?? []).filter((c) => (c.agents ?? []).length === 0 || (this.agent !== null && (c.agents ?? []).includes(this.agent)));
    this.internal = options.internal;
    // A repeated passage of the company's prompt can be anywhere: every sentence is held and checked.
    const ref = contract.internal_text?.shingle_hashes_ref;
    const watching = ref !== undefined && this.internal?.has(ref) === true;
    this.candidate = watching ? /[a-z0-9]/g : candidates(this.categories);
    // Where a context blocks, text goes sentence by sentence: a blocked claim takes its whole sentence.
    this.whole = !this.immutable && (watching || this.categories.some((c) => blocks(c, this.context)));
  }

  /** Milliseconds the current hold may still last; infinite while nothing is held. */
  remaining(): number {
    if (this.heldAt === null) return Number.POSITIVE_INFINITY;
    const spent = this.now() - this.heldAt;
    return Math.max(0, Math.min(this.holdMs - spent, this.messageMs - this.heldTotal - spent));
  }

  feed(chunk: string): string {
    this.text += chunk;
    return this.advance(false);
  }

  /** The hold ran out: what it held goes as it is. */
  expire(): string {
    if (this.heldAt === null) return "";
    return this.letGo(this.safe(false));
  }

  /** The output ended, with `rest` as its last text: the rest is checked and goes, and the claims go to the turn. */
  finish(rest = ""): string {
    this.text += rest;
    const tail = this.advance(true);
    if (this.unchecked.length > 0) this.recordUnchecked();
    const text = this.out.join("");
    if (this.frame !== undefined) {
      this.frame.addClaims(this.records);
      if (this.records.some((r) => ACTED.has(r.action))) this.frame.flag("guard_acted");
      if (this.exceeded) this.frame.flag("guard_budget_exceeded");
      this.frame.guarded(text);
    }
    this.result = { text, claims: [...this.records], review: this.review };
    return tail;
  }

  private safe(final: boolean): number {
    const all = units(this.text);
    if (final) return all.length;
    const trailing = TRAILING_WORD.exec(all);
    return all.length - (trailing?.[0].length ?? 0);
  }

  private advance(final: boolean): string {
    const out: string[] = [];
    for (;;) {
      const safe = this.safe(final);
      if (this.heldTotal >= this.messageMs) {
        out.push(this.letGo(safe)); // the message's holds are spent: the rest goes as it is
        return out.join("");
      }
      if (this.heldAt !== null && !final && this.remaining() <= 0) {
        out.push(this.letGo(safe));
        continue;
      }
      const start = this.candidateAt(this.released, safe);
      if (this.whole) {
        const boundary = final ? safe : lastClosed(this.text, this.released, safe);
        if (boundary === null) {
          if (start !== null && this.heldAt === null) this.heldAt = this.now();
          return out.join("");
        }
        out.push(start !== null && start < boundary ? this.decide(boundary) : this.pass(boundary));
        if (final || boundary >= safe) return out.join("");
        continue;
      }
      if (start === null) {
        out.push(this.pass(safe));
        return out.join("");
      }
      out.push(this.pass(start));
      this.heldAt ??= this.now();
      const closed = final ? safe : closedAfter(this.text, start);
      if (closed === null) return out.join("");
      out.push(this.decide(closed));
      if (final) return out.join("");
    }
  }

  /** Text with nothing to check goes as it is. */
  private pass(upto: number): string {
    if (upto <= this.released) return "";
    const piece = cut(this.text, this.released, upto);
    this.released = upto;
    this.out.push(piece);
    return piece;
  }

  /** A hold ran out: the held text goes unchecked, and its claims are recorded as marked. */
  private letGo(upto: number): string {
    this.stopHolding();
    this.exceeded = true;
    if (upto > this.released) this.unchecked.push([this.released, upto]);
    return this.pass(upto);
  }

  private stopHolding(): void {
    if (this.heldAt === null) return;
    this.heldTotal += this.now() - this.heldAt;
    this.heldAt = null;
  }

  private candidateAt(low: number, high: number): number | null {
    if (high <= low) return null;
    this.candidate.lastIndex = low;
    const found = this.candidate.exec(folded(this.text).slice(0, high));
    return found === null ? null : found.index;
  }

  /** Checks the held text, up to the end of its sentence, and lets it go as the actions leave it. */
  private decide(upto: number): string {
    this.stopHolding();
    const low = this.released;
    const text = cut(this.text, 0, upto);
    let piece = cut(text, low);
    try {
      const repeated = passages(this.contract, this.internal, text)
        .filter(([[, e]]) => e > low)
        .map(([[s, e], ref]): [[number, number], string] => [[Math.max(s, low), e], ref]);
      const findings = this.findings(text).filter(
        (f) => low <= f.start && f.start < upto && !repeated.some(([[s, e]]) => s <= f.start && f.start < e),
      );
      piece = this.act(text, low, findings, repeated);
    } catch {
      this.frame?.incomplete();
    }
    this.released = upto;
    this.out.push(piece);
    return piece;
  }

  private findings(text: string): Finding[] {
    return findingsOf(this.frame, this.contract, { text, context: this.context, immutable: this.immutable, agent: this.agent });
  }

  private act(text: string, low: number, findings: readonly Finding[], repeated: readonly [[number, number], string][]): string {
    const rewrites = new Map<string, [number, number, string]>();
    const blocked = new Map<string, [number, number, string | null]>();
    for (const finding of findings) {
      let act: ClaimRecord["action"] = finding.action;
      if (act === "rewrite") {
        const written = this.immutable ? null : rewritten(text, finding, this.contract);
        if (written === null) act = "warn";
        else rewrites.set(`${finding.start}`, [finding.start, finding.end, written]);
      } else if (act === "block") {
        if (this.immutable) this.review = true;
        else {
          const [start, end] = sentence(text, finding.start, low);
          const key = `${start}:${end}`;
          const held = blocked.get(key);
          blocked.set(key, [start, end, held?.[2] ?? this.caveat(finding.category)]);
        }
      }
      this.records.push(recordOf(finding, act));
    }
    // A passage of the company's own prompt gives way to the contract's line; a document goes to a person.
    const redact = this.contract.internal_text?.redact ?? "";
    for (const [[start, end], ref] of repeated) {
      this.records.push(internalRecord([start, end], ref, "block"));
      if (this.immutable) this.review = true;
      else rewrites.set(String(start), [start, end, redact]);
    }
    const spans = [...blocked.values()];
    const edits: [number, number, string][] = [...rewrites.values()].filter(([s]) => !spans.some(([b, c]) => b <= s && s < c));
    for (const [start, end, caveat] of spans.sort((a, b) => a[0] - b[0])) {
      // The sentence goes with the space before it; the space after it stays for the next one.
      const body = cut(text, start, end);
      const lead = body.slice(0, body.length - body.trimStart().length);
      const stop = start + cps(body.trimEnd());
      if (caveat !== null && !this.caveatSent) {
        this.caveatSent = true;
        edits.push([start, stop, lead + caveat]);
      } else edits.push([start, stop, ""]);
    }
    let piece = Array.from(cut(text, low));
    for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) {
      piece = [...piece.slice(0, start - low), ...Array.from(replacement), ...piece.slice(end - low)];
    }
    return piece.join("");
  }

  private caveat(category: string): string | null {
    return this.categories.find((c) => c.id === category)?.actions.replace_with ?? null;
  }

  /** The claims of text a hold let go: checked now, and recorded as what happened to them. */
  private recordUnchecked(): void {
    let findings: Finding[];
    try {
      findings = this.findings(this.text);
    } catch {
      return;
    }
    for (const finding of findings) {
      if (!this.unchecked.some(([s, e]) => s <= finding.start && finding.start < e)) continue;
      const act = ["none", "count", "discard_anchor"].includes(finding.action) ? finding.action : "warn";
      this.records.push(recordOf(finding, act));
    }
    for (const [span, ref] of passages(this.contract, this.internal, this.text)) {
      if (this.unchecked.some(([s, e]) => s <= span[0] && span[0] < e)) this.records.push(internalRecord(span, ref, "warn"));
    }
  }
}

/** The guard on a whole output: nothing is held, so nothing goes unchecked. */
export function guardText(contract: ClaimContractSummary, frame: TurnFrame | undefined, text: string, options: GuardOptions = {}): Guarded {
  const guard = new Guard(contract, frame, options);
  guard.finish(text);
  return guard.result ?? { text, claims: [], review: false };
}

/**
 * A stream through the guard: an iterable or async iterable of text chunks. A hold that runs out lets its
 * text go without waiting for the next chunk.
 */
export async function* guardStream(guard: Guard, stream: AsyncIterable<string> | Iterable<string>): AsyncGenerator<string> {
  const chunks = Symbol.asyncIterator in stream ? stream[Symbol.asyncIterator]() : toAsync(stream[Symbol.iterator]());
  let pending: Promise<IteratorResult<string>> | null = null;
  for (;;) {
    pending ??= chunks.next();
    const wait = guard.remaining();
    const next = Number.isFinite(wait) ? await Promise.race([pending, sleep(wait)]) : await pending;
    if (next === TIMEOUT) {
      const piece = guard.expire();
      if (piece) yield piece;
      continue;
    }
    pending = null;
    if (next.done) break;
    const piece = guard.feed(next.value);
    if (piece) yield piece;
  }
  const tail = guard.finish();
  if (tail) yield tail;
}

const TIMEOUT = Symbol("timeout");

function sleep(ms: number): Promise<typeof TIMEOUT> {
  return new Promise((resolve) => setTimeout(() => { resolve(TIMEOUT); }, ms));
}

function toAsync(iterator: Iterator<string>): AsyncIterator<string> {
  return { next: () => Promise.resolve(iterator.next()) };
}

/** Where the sentence holding `offset` ends, once the text that follows confirms it; `null` until then. */
function closedAfter(text: string, offset: number): number | null {
  BOUNDARY.lastIndex = offset;
  const found = BOUNDARY.exec(units(text));
  return found === null ? null : found.index + found[0].length;
}

/** The end of the last sentence between `low` and `high` that the text after it confirms. */
function lastClosed(text: string, low: number, high: number): number | null {
  let last: number | null = null;
  BOUNDARY.lastIndex = low;
  const all = units(text);
  for (let found = BOUNDARY.exec(all); found !== null; found = BOUNDARY.exec(all)) {
    const end = found.index + found[0].length;
    if (end > high) break;
    last = end;
  }
  return last;
}

/** The sentence around `offset`, split as the stream is: at the ends the text after them confirms. */
function sentence(text: string, offset: number, low: number): [number, number] {
  let start = low;
  let end = cps(text);
  BOUNDARY.lastIndex = low;
  const all = units(text);
  for (let found = BOUNDARY.exec(all); found !== null; found = BOUNDARY.exec(all)) {
    const stop = found.index + found[0].length;
    if (stop > offset) {
      end = stop;
      break;
    }
    start = stop;
  }
  return [start, end];
}

function blocks(category: ClaimCategory, context: string): boolean {
  const configured = category.actions.contexts?.[context] ?? category.actions.default;
  return configured === "block" || category.natures?.model === "block";
}

/** What could start a claim of these categories, in folded text. */
function candidates(categories: readonly ClaimCategory[]): RegExp {
  const alternatives: string[] = [];
  if (categories.some((c) => (c.detect.classes ?? []).length > 0)) alternatives.push(String.raw`\d`, String.raw`r\$`, String.raw`us\$`, "[$€£]", '["“«„]');
  const firsts = new Set<string>();
  for (const c of categories) {
    if ((c.detect.classes ?? []).length === 0) for (const phrase of phrases(c.detect.terms ?? [])) if (phrase[0]) firsts.add(phrase[0]);
    for (const name of c.detect.patterns ?? []) for (const word of CITATION_WORDS[name] ?? []) firsts.add(word);
  }
  if (firsts.size > 0) alternatives.push(String.raw`\b(?:${[...firsts].sort().map(escape).join("|")})\b`);
  return pattern(alternatives.join("|") || "(?!)", "g");
}

function escape(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The number of a rewrite, written with the fresh value the way the output wrote the old one; `null` when
 * that cannot be done without doubt (a number in words, a scale, another unit, a date in words).
 */
function rewritten(text: string, finding: Finding, contract: ClaimContractSummary): string | null {
  const fresh = finding.evidence;
  if (fresh === null || !("cls" in fresh)) return null;
  const lang = (contract.languages[0] ?? "pt");
  const span = cut(text, finding.start, finding.end);
  const mention = mentions(text, lang).find((m) => m.start === finding.start && m.end === finding.end);
  if (mention?.written !== "digits" || mention.isRange) return null;
  const value = (fresh).value;
  if (mention.date !== null && value.date !== undefined) return dateWritten(span, value.date, lang);
  if (mention.amount === null || value.amount === undefined) return null;
  if (mention.unit && value.unit && mention.unit !== value.unit) return null;
  const number = NUMBER.exec(span);
  if (number === null) return null;
  const parsed = toDecimal(number[0], lang);
  if (parsed === null || decimalText(parsed) !== mention.amount) return null;
  const written = amountWritten(value.amount, number[0], lang);
  return written === null ? null : span.slice(0, number.index) + written + span.slice(number.index + number[0].length);
}

/** `amount` with the marks and the decimals of `raw`. */
function amountWritten(amount: string, raw: string, lang: Language): string | null {
  const marks = Array.from(raw).filter((ch) => ch === "." || ch === ",");
  let grouping = lang === "en" ? "," : ".";
  let decimalMark = lang === "en" ? "." : ",";
  let decimals = 0;
  let grouped = false;
  if (marks.length > 0) {
    const last = Math.max(raw.lastIndexOf("."), raw.lastIndexOf(","));
    const tail = raw.length - last - 1;
    if (new Set(marks).size === 2 || tail !== 3 || marks[marks.length - 1] !== grouping) {
      decimalMark = raw.charAt(last);
      decimals = tail;
      grouping = decimalMark === "." ? "," : ".";
      grouped = marks.length > 1;
    } else grouped = true;
  }
  const [whole = "0", frac = ""] = amount.replace(/^-/, "").split(".");
  if (frac.length > decimals) {
    if (decimals > 0 || frac.length > 2) return null;
    decimals = 2;
  }
  const digits = grouped ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, grouping) : whole;
  return (amount.startsWith("-") ? "-" : "") + digits + (decimals > 0 ? decimalMark + frac.padEnd(decimals, "0") : "");
}

/** A numeric date with the fresh day, in the same shape; a date in words is never rewritten. */
function dateWritten(span: string, iso: string, lang: Language): string | null {
  const shape = NUMERIC_DATE.exec(span.trim());
  const parts = iso.split("-");
  if (shape === null || parts.length !== 3 || iso.startsWith("-")) return null;
  const [year = "", month = "", day = ""] = parts;
  const [, first = "", sep = "", second = "", oldYear] = shape;
  const [a, b] = lang === "en" ? [month, day] : [day, month];
  let out = `${a.padStart(first.length, "0")}${sep}${b.padStart(second.length, "0")}`;
  if (oldYear !== undefined) out += sep + (oldYear.length === 2 ? year.slice(-2) : year);
  return span.replace(span.trim(), out);
}
