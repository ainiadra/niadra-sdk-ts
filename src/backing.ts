/**
 * Backed answers: no number, date, code or amount the agent says without a source.
 *
 * Before an agent's answer is recorded, a rule reads the values it states and looks each one up in
 * what the agent had: the context pack (text, live turns, slots, delta), the customer's own words
 * in this conversation, what a human attendant said in it, the results of the actions it recorded
 * and of the tools it called. No model runs; a check costs a few milliseconds.
 *
 * What counts as a value:
 *
 * - `amount`: a number with a currency or a money word (`R$ 249,90`, `$1,200.00`, `30 euros`),
 *   any size;
 * - `date`: `18/09`, `18/09/2026`, `2026-09-18`, `18 de setembro`, `September 18`,
 *   `18 de septiembre`;
 * - `code`: letters with three or more digits (`PX-4471`, `AB12C34`);
 * - `number`: three or more digits (`81220`, `45778-204`).
 *
 * Words are never values ("dois dias"), and neither are numbers of one or two digits ("2 dias"),
 * times of day, or a year on its own. An amount is also backed when it is the sum or the difference
 * of two backed amounts, the sum of three, or a backed amount times a count said in the answer or
 * the sources ("3 x R$ 83,30"). A number is backed by its last digits ("final 4471") when the
 * source holds the whole of it.
 *
 * Guards (the lines a memory v2 server writes for a kind of value agents got wrong) are checked
 * too: an answer that states another value of the guarded kind, and never the guarded one, went
 * against the guard.
 *
 * A value that looks like a card or a document number (the card check, a CPF or CNPJ check digit)
 * is never written back in a report: it shows as `[withheld:card]` or `[withheld:document]`.
 *
 * The same rule as the Python SDK's `niadra.backing`.
 */

import type { Backing, ValueKind } from "./types/events.js";

export type { ValueKind };

/** Values read per answer at most; past them, the rest of a pasted table is not checked. */
export const MAX_VALUES = 100;
/** Amounts combined into sums at most: the newest of the sources, enough for a bill and its lines. */
const MAX_SUM_TERMS = 64;
/** A count an amount is multiplied by at most (installments). */
const MAX_FACTOR = 60;

/** A value the answer states that no source backs, or one that went against a guard. */
export interface UnbackedValue {
  kind: ValueKind;
  /** As the answer writes it; `[withheld:card]` or `[withheld:document]` for what looks like one. */
  value: string;
  /** Where it starts in the answer. */
  start: number;
}

/** What the check found in one answer. */
export interface BackingReport {
  /** Values the check read in the answer. */
  checked: number;
  /** The values no source backs, in the order said. */
  unbacked: UnbackedValue[];
  /** Short ids of the guards the answer went against. */
  guardViolations: string[];
  /** The values that went against a guard: another value of the guarded kind. */
  conflicting: UnbackedValue[];
}


/** A guard line as the context result types it (`PackGuard`), or anything with its three fields. */
export interface GuardLike {
  id: string;
  value_type: string;
  value: string;
}

interface Found {
  kind: ValueKind;
  raw: string;
  start: number;
  end: number;
  /** Digits for a number, letters and digits upper case for a code, cents for an amount, `d/m/y` for a date. */
  key: string;
}

const MONTH_NAMES: [string[], number][] = [
  [["janeiro", "january", "enero", "jan", "ene"], 1],
  [["fevereiro", "february", "febrero", "fev", "feb"], 2],
  [["marco", "march", "marzo", "mar"], 3],
  [["abril", "april", "abr", "apr"], 4],
  [["maio", "may", "mayo", "mai"], 5],
  [["junho", "june", "junio", "jun"], 6],
  [["julho", "july", "julio", "jul"], 7],
  [["agosto", "august", "ago", "aug"], 8],
  [["setembro", "september", "septiembre", "setiembre", "set", "sep", "sept"], 9],
  [["outubro", "october", "octubre", "out", "oct"], 10],
  [["novembro", "november", "noviembre", "nov"], 11],
  [["dezembro", "december", "diciembre", "dez", "dec", "dic"], 12],
];
const MONTHS = new Map<string, number>(MONTH_NAMES.flatMap(([names, n]) => names.map((name) => [name, n] as [string, number])));
const MONTH = [...MONTHS.keys()].sort((a, b) => b.length - a.length).join("|");

const CURRENCY = String.raw`(?:r\$|us\$|u\$s|\$|€|£|usd|brl|eur|mxn|ars|clp|cop)`;
const MONEY_WORD = String.raw`(?:reais|real|dolares|dollars?|euros?|pesos?|brl|usd|eur)`;
const NUM = String.raw`\d[\d.,]*\d|\d`;

const AMOUNT = new RegExp(String.raw`(?<![\w$€£])(?:${CURRENCY})\s?(?<a>${NUM})|(?<b>${NUM})\s?(?:${MONEY_WORD})\b`, "g");
const DATE_WORDS = new RegExp(
  String.raw`\b(?<d1>\d{1,2})(?:o|st|nd|rd|th)?\s+(?:de\s+|of\s+)?(?<m1>${MONTH})\b\.?(?:,?\s+(?:de\s+)?(?<y1>\d{4}))?` +
    String.raw`|\b(?<m2>${MONTH})\.?\s+(?<d2>\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(?<y2>\d{4}))?`,
  "g",
);
const DATE_NUMERIC = new RegExp(
  String.raw`(?<![\w/.-])(?:(?<y>\d{4})-(?<ym>\d{1,2})-(?<yd>\d{1,2})` +
    String.raw`|(?<d>\d{1,2})(?<sep>[/-])(?<m>\d{1,2})(?:\k<sep>(?<year>\d{4}|\d{2}))?` +
    String.raw`|(?<dd>\d{1,2})\.(?<dm>\d{1,2})\.(?<dy>\d{4}))(?![\w/-]|\.\d)`,
  "g",
);
const TIME = /(?<!\d)\d{1,2}[:h]\d{2}(?!\d)/g;
/** Digits written in groups of four, as cards are: read as one number, so the card check sees it. */
const GROUPED = /(?<![\d.,])\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,3})?(?!\d)/g;
const TOKEN = /[A-Za-z0-9][A-Za-z0-9.,/-]*[A-Za-z0-9]|[0-9]/g;
const WORD = /[a-z]+/g;
const TRAILING = /[.,/-]+$/;
const MARKS = /\p{M}/gu;

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) return false;
  return true;
}

/** Lower case without accents, one code unit per code unit, so offsets still point into `text`. */
function fold(text: string): string {
  if (isAscii(text)) return text.toLowerCase();
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const plain = text.charAt(i).normalize("NFKD").replace(MARKS, "").toLowerCase();
    out += plain.length === 1 ? plain : "?";
  }
  return out;
}

/** The decimal digits of a string of digits, as numbers. */
function digitList(number: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < number.length; i++) out.push(number.charCodeAt(i) - 48);
  return out;
}

function digitsOf(text: string): string {
  return text.replace(/\D+/g, "");
}

function alnumUpper(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/** An amount in cents, in either convention: `1.234,56`, `1,234.56`, `249,90`, `249.90`, `30`. */
export function cents(raw: string): number | null {
  const text = raw.trim().replace(/^[.,/-]+|[.,/-]+$/g, "");
  if (!text || !/^\d/.test(text)) return null;
  const last = Math.max(text.lastIndexOf(","), text.lastIndexOf("."));
  let whole = text;
  let frac = "";
  if (last >= 0 && [1, 2].includes(text.length - last - 1)) {
    whole = text.slice(0, last);
    frac = text.slice(last + 1);
  }
  whole = digitsOf(whole);
  if (!whole || whole.length > 13) return null;
  return Number(whole) * 100 + Number(`${frac}00`.slice(0, 2));
}

function dateKey(day: number, month: number, year: number | null): string | null {
  if (!(day >= 1 && day <= 31 && month >= 1 && month <= 12)) return null;
  return `${day}/${month}/${year ?? ""}`;
}

function yearOf(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return value < 100 ? value + 2000 : value;
}

/**
 * Every value a text states, in order: amounts, dates, codes and numbers of three or more digits.
 * A span taken by one is never read again as another.
 */
export function valuesIn(text: string, limit = MAX_VALUES): Found[] {
  const folded = fold(text);
  const taken: [number, number][] = [];
  const found: Found[] = [];
  const free = (start: number, end: number): boolean => taken.every(([s, e]) => end <= s || start >= e);
  const take = (item: Found): void => {
    taken.push([item.start, item.end]);
    found.push(item);
  };

  for (const m of folded.matchAll(AMOUNT)) {
    const start = m.index;
    const end = start + m[0].length;
    const g = m.groups ?? {};
    const value = cents(g.a ?? g.b ?? "");
    if (value !== null && free(start, end)) take({ kind: "amount", raw: text.slice(start, end).trim(), start, end, key: String(value) });
  }
  for (const m of folded.matchAll(DATE_WORDS)) {
    const start = m.index;
    const end = start + m[0].length;
    const g = m.groups ?? {};
    const month = MONTHS.get(g.m1 ?? g.m2 ?? "") ?? 0;
    const key = dateKey(Number(g.d1 ?? g.d2), month, yearOf(g.y1 ?? g.y2));
    if (key !== null && free(start, end)) take({ kind: "date", raw: text.slice(start, end), start, end, key });
  }
  for (const m of folded.matchAll(DATE_NUMERIC)) {
    const start = m.index;
    const end = start + m[0].length;
    const g = m.groups ?? {};
    let key: string | null;
    if (g.y) key = dateKey(Number(g.yd), Number(g.ym), Number(g.y));
    else if (g.dd) key = dateKey(Number(g.dd), Number(g.dm), Number(g.dy));
    else {
      const day = Number(g.d);
      const month = Number(g.m);
      const year = yearOf(g.year);
      // Day first, as PT and ES write it; an impossible month reads the date the US way.
      key = dateKey(day, month, year) ?? dateKey(month, day, year);
    }
    if (key !== null && free(start, end)) take({ kind: "date", raw: text.slice(start, end), start, end, key });
  }
  for (const m of folded.matchAll(TIME)) {
    if (free(m.index, m.index + m[0].length)) taken.push([m.index, m.index + m[0].length]); // not checked
  }
  for (const m of text.matchAll(GROUPED)) {
    if (free(m.index, m.index + m[0].length)) {
      take({ kind: "number", raw: m[0], start: m.index, end: m.index + m[0].length, key: digitsOf(m[0]) });
    }
  }
  for (const m of text.matchAll(TOKEN)) {
    const raw = m[0].replace(TRAILING, "");
    const start = m.index;
    const end = start + raw.length;
    if (!free(start, end)) continue;
    const digits = digitsOf(raw);
    if (digits.length < 3) continue;
    if (/[A-Za-z]/.test(raw)) {
      if (/^\d+(st|nd|rd|th)$/i.test(raw)) continue;
      take({ kind: "code", raw, start, end, key: alnumUpper(raw) });
      continue;
    }
    if (digits.length === 4 && raw === digits && Number(digits) >= 1900 && Number(digits) <= 2099) continue; // a year
    take({ kind: "number", raw, start, end, key: digits });
  }
  found.sort((a, b) => a.start - b.start);
  return found.slice(0, limit);
}

/**
 * What the agent had, indexed for the check: add each text once, check many answers. Texts are
 * kept by value, so the same pack added every turn is indexed once.
 */
export class Sources {
  readonly numbers = new Set<string>();
  readonly amounts = new Set<number>();
  readonly dates = new Set<string>();
  readonly codes = new Set<string>();
  readonly counts = new Set<number>();
  private readonly amountOrder: number[] = [];
  private readonly seen = new Set<string>();

  add(text: string | null | undefined): void {
    if (!text || this.seen.has(text)) return;
    this.seen.add(text);
    for (const item of valuesIn(text, 10_000)) this.index(item);
    // Every token with digits backs a number or an amount written another way ("249,90" backs
    // "R$ 249.90"), and small integers are counts an amount may be multiplied by.
    for (const m of text.matchAll(TOKEN)) {
      const raw = m[0].replace(TRAILING, "");
      const digits = digitsOf(raw);
      if (!digits) continue;
      this.numbers.add(digits);
      if (/^\d+$/.test(raw) && Number(raw) > 1 && Number(raw) <= MAX_FACTOR) this.counts.add(Number(raw));
      const value = cents(raw);
      if (value !== null) this.amount(value);
      if (/[A-Za-z]/.test(raw)) this.codes.add(alnumUpper(raw));
    }
  }

  private amount(value: number): void {
    if (!this.amounts.has(value)) {
      this.amounts.add(value);
      this.amountOrder.push(value);
    }
  }

  private index(item: Found): void {
    if (item.kind === "amount") this.amount(Number(item.key));
    else if (item.kind === "date") {
      const [day, month, year] = item.key.split("/") as [string, string, string];
      this.dates.add(item.key);
      this.dates.add(`${day}/${month}/`);
      if (Number(day) <= 12) {
        this.dates.add(`${month}/${day}/${year}`); // ambiguous: read both ways
        this.dates.add(`${month}/${day}/`);
      }
    } else if (item.kind === "code") this.codes.add(item.key);
    else this.numbers.add(item.key);
  }

  backs(item: Found, said: readonly Found[] = []): boolean {
    if (item.kind === "amount") return this.backsAmount(Number(item.key), said);
    if (item.kind === "date") {
      const [day, month] = item.key.split("/");
      return this.dates.has(item.key) || this.dates.has(`${day}/${month}/`);
    }
    if (item.kind === "code") return this.codes.has(item.key) || this.numbers.has(digitsOf(item.key));
    if (this.numbers.has(item.key)) return true;
    const value = cents(item.raw);
    if (value !== null && this.amounts.has(value)) return true;
    // "final 4471": the last digits of a number the sources hold whole.
    if (item.key.length < 4) return false;
    for (const n of this.numbers) if (n.length > item.key.length && n.endsWith(item.key)) return true;
    return false;
  }

  private backsAmount(value: number, said: readonly Found[]): boolean {
    if (this.amounts.has(value)) return true;
    const terms = this.amountOrder.slice(-MAX_SUM_TERMS);
    const pool = new Set(terms);
    for (const a of terms) if (pool.has(value - a) || pool.has(a - value)) return true; // a + b, a - b
    for (const [i, a] of terms.entries()) {
      for (const b of terms.slice(i + 1)) if (pool.has(value - a - b)) return true;
    }
    const counts = new Set(this.counts);
    for (const f of said) if (f.kind === "number" && /^\d+$/.test(f.key)) counts.add(Number(f.key));
    for (const m of said.map((f) => f.raw).join(" ").matchAll(/(?<![\d.,])(\d{1,2})\s?x\b/g)) counts.add(Number(m[1]));
    for (const n of counts) if (n > 1 && n <= MAX_FACTOR && value % n === 0 && pool.has(value / n)) return true;
    return false;
  }
}

const TYPE_STEMS: Record<string, string[]> = {
  protocol: ["protocol"],
  ticket: ["chamado", "ticket", "ocorrenc", "incident", "incidenc", "caso", "case"],
  order: ["pedido", "order", "orden", "compra", "purchase"],
  record: ["registr", "record", "sinistro", "claim", "siniestro"],
  receipt: ["comprovante", "receipt", "recibo", "comprobante", "transac"],
  postal_code: ["cep", "zip", "postal"],
  code: ["codigo", "code", "cupom", "coupon", "cupon", "voucher", "rastrei", "tracking", "reserva"],
};
const NEAR = 6;

/** The numbers and codes of the answer at most six words from a word naming `valueType`. */
function typedNear(answer: string, found: readonly Found[], valueType: string): Found[] {
  const stems = TYPE_STEMS[valueType];
  if (!stems) return [];
  const words = [...fold(answer).matchAll(WORD)];
  const starts = words.map((w) => w.index);
  const named = words.filter((w) => stems.some((stem) => w[0].startsWith(stem))).map((w) => w.index);
  return found.filter(
    (item) =>
      (item.kind === "number" || item.kind === "code") &&
      named.some((at) => {
        const low = Math.min(at, item.start);
        const high = Math.max(at, item.start);
        return starts.filter((w) => low <= w && w < high).length <= NEAR;
      }),
  );
}

function guardValue(guard: GuardLike): Found | null {
  const found = valuesIn(guard.value);
  if (found[0]) return found[0];
  const digits = digitsOf(guard.value);
  return digits.length >= 3 ? { kind: "number", raw: guard.value, start: 0, end: guard.value.length, key: digits } : null;
}

function amountOf(item: Found): number | null {
  return item.kind === "amount" ? Number(item.key) : cents(item.raw);
}

/** Two writings of one value: the same day and month, the same amount, or the same digits. */
function same(a: Found, b: Found): boolean {
  if (a.kind === "date" && b.kind === "date") {
    const [da, ma, ya] = a.key.split("/");
    const [db, mb, yb] = b.key.split("/");
    return da === db && ma === mb && (!ya || !yb || ya === yb);
  }
  if (a.kind === "amount" || b.kind === "amount") {
    const left = amountOf(a);
    return left !== null && left === amountOf(b);
  }
  if (a.kind === "code" || b.kind === "code") return a.key === b.key || digitsOf(a.key) === digitsOf(b.key);
  return a.key === b.key;
}

/** The values of the guarded kind the answer states, when none of them is the guarded one. */
function conflicts(guard: GuardLike, answer: string, said: readonly Found[]): Found[] {
  const guarded = guardValue(guard);
  if (!guarded) return [];
  let ofType: Found[];
  if (guard.value_type === "date") ofType = said.filter((f) => f.kind === "date");
  else if (guard.value_type === "amount") ofType = said.filter((f) => f.kind === "amount");
  else ofType = typedNear(answer, said, guard.value_type);
  return said.some((f) => same(f, guarded)) ? [] : ofType;
}

/** The answer states another value of the guarded kind and never the guarded one. */
export function violated(guard: GuardLike, answer: string): boolean {
  return conflicts(guard, answer, valuesIn(answer)).length > 0;
}

function masked(item: Found): string {
  const digits = digitsOf(item.raw);
  const onlyDigits = /^[\d .\-/]+$/.test(item.raw);
  if (onlyDigits && isCard(digits)) return "[withheld:card]";
  if (onlyDigits && ((digits.length === 11 && isCpf(digits)) || (digits.length === 14 && isCnpj(digits)))) {
    return "[withheld:document]";
  }
  return item.raw;
}

function isCard(number: string): boolean {
  if (number.length < 13 || number.length > 19 || !"23456".includes(number.charAt(0))) return false;
  let total = 0;
  digitList(number)
    .reverse()
    .forEach((digit, i) => {
      total += i % 2 ? (digit > 4 ? digit * 2 - 9 : digit * 2) : digit;
    });
  return total % 10 === 0;
}

function mod11(values: number[], weights: number[]): number {
  const rest = values.reduce((sum, v, i) => sum + v * (weights[i] ?? 0), 0) % 11;
  return rest < 2 ? 0 : 11 - rest;
}

function isCpf(number: string): boolean {
  const d = digitList(number);
  if (new Set(d).size === 1) return false;
  const first = mod11(d.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = mod11([...d.slice(0, 9), first], [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d[9] === first && d[10] === second;
}

function isCnpj(number: string): boolean {
  const d = digitList(number);
  if (new Set(d).size === 1) return false;
  const first = mod11(d.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = mod11([...d.slice(0, 12), first], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d[12] === first && d[13] === second;
}

/**
 * Reads the values `answer` states and looks each up in `sources`; checks it against `guards`.
 *
 * @example
 * const report = check("A fatura é de R$ 259,90.", [ctx.text, ctx.suffix]);
 * report.unbacked; // [{ kind: "amount", value: "R$ 259,90", start: 14 }]
 */
export function check(answer: string, sources: Sources | Iterable<string | null | undefined>, guards: Iterable<GuardLike> = []): BackingReport {
  const index = sources instanceof Sources ? sources : indexOf(sources);
  const said = valuesIn(answer);
  const unbacked = said.filter((item) => !index.backs(item, said)).map(toUnbacked);
  const guardViolations: string[] = [];
  const conflicting = new Map<number, UnbackedValue>();
  for (const guard of guards) {
    const found = conflicts(guard, answer, said);
    if (!found.length) continue;
    if (!guardViolations.includes(guard.id)) guardViolations.push(guard.id);
    for (const item of found) if (!conflicting.has(item.start)) conflicting.set(item.start, toUnbacked(item));
  }
  return { checked: said.length, unbacked, guardViolations, conflicting: [...conflicting.values()] };
}

/** What `strict` returns: the values with no source, then those that went against a guard. */
export function problems(report: BackingReport): UnbackedValue[] {
  const seen = new Set(report.unbacked.map((v) => v.start));
  return [...report.unbacked, ...report.conflicting.filter((v) => !seen.has(v.start))];
}

/** The report as the agent's turn carries it: kinds, counts and ids, never a value. */
export function backingOf(report: BackingReport): Backing {
  return {
    checked: Math.min(report.checked, 500),
    unbacked_values: report.unbacked.slice(0, MAX_VALUES).map((v) => ({ kind: v.kind })),
    guard_violations: report.guardViolations.slice(0, 8),
  };
}

function toUnbacked(item: Found): UnbackedValue {
  return { kind: item.kind, value: masked(item), start: item.start };
}

function indexOf(texts: Iterable<string | null | undefined>): Sources {
  const index = new Sources();
  for (const text of texts) index.add(text);
  return index;
}
