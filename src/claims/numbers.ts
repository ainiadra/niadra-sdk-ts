/**
 * The numbers of an output, read by rules (the claim contract spec, section 5): each one with its class,
 * its normalized value and its span, in Portuguese, English or Spanish.
 *
 * Every number of the text lands in at most one mention, found in this order, and a later step never takes
 * what an earlier one took:
 *
 * 1. labels by shape: a case number, a postal code, a tax id, a phone, a time of day;
 * 2. labels by the word before them: an order, a protocol, a statute's article, a size, a list position;
 * 3. dates: ISO, numeric (day first in `pt` and `es`, month first in `en`), with month names, a month of a
 *    year, "dia 20";
 * 4. amounts with what follows or precedes them: money (a currency before or after, a scale like "mil"),
 *    percent, duration, dose, quantity, installments ("10x"); written in digits, or in words right before
 *    the unit; two of them joined by "a", "to", "-" (or "e", "and", "y" after "entre", "between") make a
 *    range;
 * 5. codes that mix letters and digits, and ordinals: labels;
 * 6. the rest: a number with two decimals is money; an integer before a word is a count; five digits or
 *    more, a leading zero or a year are labels; anything else is not read.
 *
 * A label is never a claim and is never rewritten.
 */

import { type Decimal, compare, decimal, decimalText, isIntegral, times } from "./decimal.js";
import { folded, integer, matchAt, memo, pattern, search, words } from "./text.js";
import { type Language, readWords } from "./words.js";

export type { Language } from "./words.js";

export const LANGUAGES: readonly Language[] = ["pt", "en", "es"];

/** What a number measures; a `label` names something instead. */
export type MentionClass = "money" | "percent" | "date" | "duration" | "quantity" | "count" | "dosage" | "label";

/** A number's normalized value (the claim contract spec, section 5.3), as vectors and turn records write it. */
export type Value = Readonly<Partial<Record<"amount" | "min" | "max" | "unit" | "date" | "date_from" | "date_to", string>>>;

interface MentionFields {
  amount?: Decimal;
  low?: Decimal;
  high?: Decimal;
  unit?: string | null;
  date?: string;
  dateFrom?: string;
  dateTo?: string;
  written?: "digits" | "words";
}

/** A number of an output: its class, its span in code points and its value. */
export class Mention {
  /** Decimals as `decimalText` writes them. */
  readonly amount: string | null;
  readonly low: string | null;
  readonly high: string | null;
  readonly unit: string | null;
  readonly date: string | null;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly written: "digits" | "words";

  constructor(
    readonly cls: MentionClass,
    readonly start: number,
    readonly end: number,
    fields: MentionFields = {},
  ) {
    this.amount = fields.amount ? decimalText(fields.amount) : null;
    this.low = fields.low ? decimalText(fields.low) : null;
    this.high = fields.high ? decimalText(fields.high) : null;
    this.unit = fields.unit ?? null;
    this.date = fields.date ?? null;
    this.dateFrom = fields.dateFrom ?? null;
    this.dateTo = fields.dateTo ?? null;
    this.written = fields.written ?? "digits";
  }

  /** The normalized value; a label has none. */
  value(): Value | null {
    if (this.cls === "label") return null;
    if (this.date !== null) return { date: this.date };
    if (this.dateFrom !== null && this.dateTo !== null) return { date_from: this.dateFrom, date_to: this.dateTo };
    const out: Record<string, string> =
      this.amount !== null ? { amount: this.amount } : { min: this.low ?? "", max: this.high ?? "" };
    if (this.unit !== null) out.unit = this.unit;
    return out;
  }

  get isRange(): boolean {
    return this.low !== null || this.dateFrom !== null;
  }
}

const NUM = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?(?![\d])|\d+(?:[.,]\d+)?`;
const NUMBER = pattern(String.raw`(?<![\w.,/])(?<![a-z]-)(?:${NUM})(?![.,]?\d)`, "g");
const SEPARATORS = /[.,]/;

/**
 * A number in either convention (the claim contract spec, section 5.1): the last separator of two kinds is
 * the decimal one; a separator that repeats groups thousands; a single one before exactly three digits
 * groups them when it is the language's grouping mark (`.` in `pt` and `es`, `,` in `en`) and is the decimal
 * mark otherwise.
 */
export function toDecimal(raw: string, lang: Language): Decimal | null {
  const seps = Array.from(raw).filter((ch) => ch === "." || ch === ",");
  if (seps.length === 0) return decimal(raw);
  let decimalAt: number | null = null;
  if (new Set(seps).size === 2) decimalAt = Math.max(raw.lastIndexOf("."), raw.lastIndexOf(","));
  else if (seps.length === 1) {
    const sep = seps[0] ?? "";
    const at = raw.indexOf(sep);
    if (raw.length - at - 1 !== 3 || sep !== (lang === "en" ? "," : ".")) decimalAt = at;
  }
  const whole = decimalAt === null ? raw : raw.slice(0, decimalAt);
  const frac = decimalAt === null ? "" : raw.slice(decimalAt + 1);
  const groups = whole.split(SEPARATORS);
  const [first = "", ...rest] = groups;
  if (groups.length > 1 && (!(first.length >= 1 && first.length <= 3) || rest.some((g) => g.length !== 3))) return null;
  return decimal(groups.join("") + (frac ? `.${frac}` : ""));
}

/** Month names by month, from January. */
const byMonth = (names: readonly (readonly string[])[]): Map<string, number> =>
  new Map(names.flatMap((same, i) => same.map((name) => [name, i + 1] as const)));
const MONTHS = byMonth([
  ["janeiro", "january", "enero"],
  ["fevereiro", "february", "febrero"],
  ["marco", "march", "marzo"],
  ["abril", "april"],
  ["maio", "may", "mayo"],
  ["junho", "june", "junio"],
  ["julho", "july", "julio"],
  ["agosto", "august"],
  ["setembro", "september", "septiembre", "setiembre"],
  ["outubro", "october", "octubre"],
  ["novembro", "november", "noviembre"],
  ["dezembro", "december", "diciembre"],
]);
const SHORT_MONTHS = byMonth([
  ["jan", "ene"],
  ["fev", "feb"],
  ["mar"],
  ["abr", "apr"],
  ["mai"],
  ["jun"],
  ["jul"],
  ["ago", "aug"],
  ["set", "sep", "sept"],
  ["out", "oct"],
  ["nov"],
  ["dez", "dec", "dic"],
]);
const longestFirst = (names: Iterable<string>): string[] => [...names].sort((a, b) => b.length - a.length);
// A short month name counts only with its period ("5 set. 2026"): "mar", "set" and "out" are also words.
const MONTH = [...longestFirst(MONTHS.keys()), ...longestFirst(SHORT_MONTHS.keys()).map((m) => String.raw`${m}\.`)].join("|");
const ORD = "(?:o|a|st|nd|rd|th)?";
const SEP = String.raw`\s*(?:-|\u2013|\u2014|\ba\b|\bao\b|\bal\b|\bate\b|\bto\b|\bhasta\b)\s*`;
const JOINED = pattern(String.raw`^(?:${SEP})\Z`);
const BETWEEN = pattern(String.raw`(?:entre|between)\s+$`, "g");
const AND = pattern(String.raw`^\s+(?:e|and|y)\s+\Z`);

function monthOf(name: string): number {
  return MONTHS.get(name) ?? SHORT_MONTHS.get(name.replace(/\.+$/, "")) ?? 0;
}

function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function iso(year: number | null, month: number | null, day: number | null): string | null {
  if (month !== null && !(month >= 1 && month <= 12)) return null;
  // A leap year when the text gives none (or gives the year 0): "29 de fevereiro".
  if (day !== null && !(day >= 1 && day <= daysIn(year === null || year === 0 ? 2024 : year, month ?? 1))) return null;
  if (year !== null && month !== null && day !== null) return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
  if (year !== null && month !== null) return `${pad(year, 4)}-${pad(month, 2)}`;
  if (month !== null && day !== null) return `--${pad(month, 2)}-${pad(day, 2)}`;
  return day !== null ? `---${pad(day, 2)}` : null;
}

function yearOf(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  return raw.length === 2 ? 2000 + integer(raw) : integer(raw);
}

// Labels by shape.
const SHAPES = pattern(
  String.raw`(?<![\w.])(?:` +
    String.raw`\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}` + // a case number (CNJ)
    String.raw`|\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2}` + // tax ids
    String.raw`|\d{5}-\d{3}` + // a postal code
    String.raw`|\(?\d{2}\)?\s?9?\d{4}-\d{4}|\+\d{1,3}(?:[\s-]?\d{2,5}){2,4}` + // a phone
    String.raw`|\d{1,2}:\d{2}(?::\d{2})?(?:\s?(?:am|pm))?|\d{1,2}h\d{2}|\d{1,2}\s?(?:am|pm)\b` + // a time of day
    String.raw`)(?![\w-])` +
    String.raw`|(?<=\bas\s)\d{1,2}h\b|(?<=\bat\s)\d{1,2}(?:h\b|\b)|(?<=\blas\s)\d{1,2}(?:h\b|\b)`, // "às 14h", "at 3"
  "g",
);
/**
 * Words after which a number names something instead of measuring it. Only number markers ("nº", "#", ":")
 * may stand between: "pedido de 3 itens" is a count.
 */
const CUES =
  "pedido|order|orden|protocolo|protocol|numero|nr|processo|proceso|case|cep|zip|art|arts|artigo|artigos|" +
  "article|articulo|inciso|paragrafo|lei|law|ley|decreto|sumula|tema|tamanho|tam|size|talla|numeracao|item|" +
  "itens|opcao|option|opcion|posicao|position|pagina|page|pag|versao|version|capitulo|chapter|clausula|" +
  "clause|apto|apartamento|sala|vara|nf|cupom|coupon|codigo|code|cpf|cnpj|rg|rastreio|tracking|chamado|" +
  "ticket|sinistro|apolice|poliza|matricula|ref|referencia|resp|aresp|agrg|agint|adi|adpf|hc|rr|airr";
const FILLER = String.raw`(?:\s*(?:n[o.]?|numero|nr\.?|#|:)\s*)*`;
const CUED = pattern(String.raw`\b(?:${CUES})\b\.?${FILLER}\s*(?<n>\d[\d./-]*\d[a-z]?|\d[a-z]?)(?![\w])`, "gd");
const LAW_SIGN = pattern(String.raw`§\s*(?<n>\d+)`, "gd");

function named(m: RegExpMatchArray, group: string): Mention {
  const [start, end] = m.indices?.groups?.[group] ?? [0, 0];
  return new Mention("label", start, end);
}

function labelsByShape(text: string): Mention[] {
  return Array.from(text.matchAll(SHAPES), (m) => new Mention("label", m.index, m.index + m[0].length));
}

function labelsByCue(text: string): Mention[] {
  return [...text.matchAll(CUED), ...text.matchAll(LAW_SIGN)].map((m) => named(m, "n"));
}

const ISO_DATE = pattern(String.raw`(?<![\w.-])(\d{4})-(\d{2})-(\d{2})(?![\w-])`, "g");
const SLASH_DATE = pattern(String.raw`(?<![\w/.-])(\d{1,2})/(\d{1,2})(?:/(\d{4}|\d{2}))?(?![\w/]|[.-]\d)`, "g");
const DOTTED_DATE = pattern(String.raw`(?<![\w/.-])(\d{1,2})([.-])(\d{1,2})\2(\d{4})(?![\w/.-])`, "g");
const MONTH_YEAR_NUM = pattern(String.raw`(?<![\w/.-])(\d{1,2})/(\d{4})(?![\w/])`, "g");
const DAY_MONTH = pattern(
  String.raw`(?<![\w.,])(\d{1,2})${ORD}(?:${SEP}(\d{1,2})${ORD})?\s+(?:de\s+|of\s+|del\s+)?(${MONTH})(?![\w])` +
    String.raw`(?:,?\s+(?:de\s+|del\s+)?(\d{4}))?(?![\w])`,
  "g",
);
const MONTH_DAY = pattern(String.raw`\b(${MONTH})\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?(?![\w])`, "g");
const MONTH_OF_YEAR = pattern(String.raw`\b(${MONTH})\s+(?:de\s+|of\s+|del\s+)?(\d{4})(?![\w])`, "g");
const DAY_ONLY = pattern(String.raw`\b(?:dia|day)\s+(\d{1,2})(?:o|a|st|nd|rd|th)?(?![\w%]|[.,]\d)`, "gd");

function dates(text: string, lang: Language): Mention[] {
  const found: Mention[] = [];
  const add = (start: number, end: number, date: string | null): void => {
    if (date !== null) found.push(new Mention("date", start, end, { date }));
  };
  const endOf = (m: RegExpExecArray): number => m.index + m[0].length;
  const dayFirst = (first: number, second: number): [number, number] => (lang === "en" ? [second, first] : [first, second]);

  for (const m of text.matchAll(ISO_DATE)) {
    add(m.index, endOf(m), iso(integer(m[1] ?? ""), integer(m[2] ?? ""), integer(m[3] ?? "")));
  }
  for (const m of text.matchAll(SLASH_DATE)) {
    const [day, month] = dayFirst(integer(m[1] ?? ""), integer(m[2] ?? ""));
    add(m.index, endOf(m), iso(yearOf(m[3]), month, day));
  }
  for (const m of text.matchAll(DOTTED_DATE)) {
    const [day, month] = dayFirst(integer(m[1] ?? ""), integer(m[3] ?? ""));
    add(m.index, endOf(m), iso(integer(m[4] ?? ""), month, day));
  }
  for (const m of text.matchAll(MONTH_YEAR_NUM)) add(m.index, endOf(m), iso(integer(m[2] ?? ""), integer(m[1] ?? ""), null));
  for (const m of text.matchAll(DAY_MONTH)) {
    const month = monthOf(m[3] ?? "");
    const year = yearOf(m[4]);
    if (m[2] === undefined) {
      add(m.index, endOf(m), iso(year, month, integer(m[1] ?? "")));
      continue;
    }
    const low = iso(year, month, integer(m[1] ?? ""));
    const high = iso(year, month, integer(m[2]));
    if (low !== null && high !== null && low < high) found.push(new Mention("date", m.index, endOf(m), { dateFrom: low, dateTo: high }));
  }
  for (const m of text.matchAll(MONTH_DAY)) add(m.index, endOf(m), iso(yearOf(m[3]), monthOf(m[1] ?? ""), integer(m[2] ?? "")));
  for (const m of text.matchAll(MONTH_OF_YEAR)) {
    if (MONTHS.has(m[1] ?? "")) add(m.index, endOf(m), iso(integer(m[2] ?? ""), monthOf(m[1] ?? ""), null));
  }
  for (const m of text.matchAll(DAY_ONLY)) add(m.indices?.[1]?.[0] ?? m.index, endOf(m), iso(null, null, integer(m[1] ?? "")));
  return found;
}

const CURRENCY_BEFORE = pattern(String.raw`(?:(?<![a-z])(r\$|us\$|u\$s|usd|brl|eur|gbp|mxn|ars|clp|cop)|(€|£|\$))\s?$`, "g");
const CURRENCIES = new Map<string, string | null>([
  ["r$", "BRL"], ["us$", "USD"], ["u$s", "USD"], ["usd", "USD"], ["brl", "BRL"], ["eur", "EUR"], ["€", "EUR"],
  ["gbp", "GBP"], ["£", "GBP"], ["mxn", "MXN"], ["ars", "ARS"], ["clp", "CLP"], ["cop", "COP"], ["$", null],
]);
const SCALE = pattern(String.raw`\s?(mil|milhao|milhoes|millon|millones|million|millions|thousand|k)\b`, "y");
const SCALES = new Map<string, bigint>([["mil", 1000n], ["thousand", 1000n], ["k", 1000n]]);

/** A class and its unit. */
type Suffix = readonly [MentionClass, string | null];

const SUFFIXES: readonly (readonly [RegExp, Suffix])[] = (
  [
    [String.raw`\s?(?:%|por\s?cento\b|percent\b|per\s?cent\b|por\s?ciento\b)`, ["percent", "%"]],
    [String.raw`\s?(?:reais|real)\b`, ["money", "BRL"]],
    [String.raw`\s?(?:dolares|dolar|dollars|dollar)\b`, ["money", "USD"]],
    [String.raw`\s?(?:euros|euro)\b`, ["money", "EUR"]],
    [String.raw`\s?(?:pesos|peso)\b`, ["money", null]],
    [String.raw`\s?(?:brl)\b`, ["money", "BRL"]],
    [String.raw`\s?(?:usd)\b`, ["money", "USD"]],
    [String.raw`\s?(?:eur)\b`, ["money", "EUR"]],
    [
      String.raw`\s?(?:dias?\s+uteis|dia\s+util|business\s+days?|working\s+days?|dias?\s+habiles|dia\s+habil)\b`,
      ["duration", "business_day"],
    ],
    [String.raw`\s?(?:dias?\s+corridos|calendar\s+days?|dias?\s+naturales|dias?\s+calendario)\b`, ["duration", "day"]],
    [String.raw`\s?(?:dias?|days?)\b`, ["duration", "day"]],
    [String.raw`\s?(?:horas?|hours?|hrs?|h)\b`, ["duration", "hour"]],
    [String.raw`\s?(?:minutos?|minutes?|mins?)\b`, ["duration", "minute"]],
    [String.raw`\s?(?:semanas?|weeks?)\b`, ["duration", "week"]],
    [String.raw`\s?(?:meses|mes|months?)\b`, ["duration", "month"]],
    [String.raw`\s?(?:anos?|years?)\b`, ["duration", "year"]],
    [String.raw`\s?(?:mcg|ug|μg)\b`, ["dosage", "mcg"]],
    [String.raw`\s?mg\b`, ["dosage", "mg"]],
    [String.raw`\s?(?:ui|iu)\b`, ["dosage", "IU"]],
    [String.raw`\s?(?:gotas?|drops?)\b`, ["dosage", "drop"]],
    [String.raw`\s?(?:comprimidos?|tablets?|pastillas?)\b`, ["dosage", "tablet"]],
    [String.raw`\s?(?:capsulas?|capsules?)\b`, ["dosage", "capsule"]],
    [String.raw`\s?kg\b`, ["quantity", "kg"]],
    [String.raw`\s?(?:ml)\b`, ["quantity", "ml"]],
    [String.raw`\s?(?:litros?|liters?|litres?|l)\b`, ["quantity", "l"]],
    [String.raw`\s?(?:gb)\b`, ["quantity", "GB"]],
    [String.raw`\s?(?:mb)\b`, ["quantity", "MB"]],
    [String.raw`\s?(?:tb)\b`, ["quantity", "TB"]],
    [String.raw`\s?(?:mah)\b`, ["quantity", "mAh"]],
    [String.raw`\s?(?:cm)\b`, ["quantity", "cm"]],
    [String.raw`\s?(?:mm)\b`, ["quantity", "mm"]],
    [String.raw`\s?(?:km)\b`, ["quantity", "km"]],
    [String.raw`\s?(?:m2|m²)`, ["quantity", "m2"]],
    [String.raw`\s?(?:metros?|meters?|metres?|m)\b`, ["quantity", "m"]],
    [String.raw`\s?g\b`, ["quantity", "g"]],
    [String.raw`\s?(?:w)\b`, ["quantity", "W"]],
    [String.raw`\s?(?:v)\b`, ["quantity", "V"]],
    [String.raw`\s?(?:polegadas?|pulgadas?|inches|inch)\b`, ["quantity", "in"]],
    [String.raw`\s?(?:unidades?|units?|unidad|pecas?|pieces?|piezas?|itens|items?)\b`, ["quantity", "unit"]],
    [String.raw`\s?(?:pares|pairs?)\b`, ["quantity", "pair"]],
    [String.raw`x\b`, ["count", "x"]],
  ] as const
).map(([source, suffix]) => [pattern(source, "y"), suffix] as const);

interface Atom {
  raw: string;
  start: number;
  /** Past the number, its scale and its suffix. */
  end: number;
  amount: Decimal;
  written: "digits" | "words";
  scaled: boolean;
  suffix: Suffix | null;
  /** Where a currency before it starts. */
  prefixStart: number | null;
  currency: string | null;
}

function suffixAt(text: string, at: number): [Suffix, number] | null {
  for (const [re, suffix] of SUFFIXES) {
    const m = matchAt(re, text, at);
    if (m) return [suffix, m.index + m[0].length];
  }
  return null;
}

function atomAt(text: string, raw: string, start: number, end: number, amount: Decimal, written: Atom["written"]): Atom {
  let prefixStart: number | null = null;
  let currency: string | null = null;
  const before = search(CURRENCY_BEFORE, text, Math.max(0, start - 5), start);
  if (before) [prefixStart, currency] = [before.index, CURRENCIES.get(before[1] ?? before[2] ?? "") ?? null];
  let scaled = false;
  const scale = matchAt(SCALE, text, end);
  if (scale) {
    const after = suffixAt(text, scale.index + scale[0].length);
    // "5k" is money only: with a currency before or after it.
    if (scale[1] !== "k" || prefixStart !== null || after?.[0][0] === "money") {
      amount = times(amount, SCALES.get(scale[1] ?? "") ?? 1_000_000n);
      end = scale.index + scale[0].length;
      scaled = true;
    }
  }
  const found = suffixAt(text, end);
  const suffix = found?.[0] ?? null;
  // "R$ 5 dias" is five days: the unit decides.
  if (suffix !== null && suffix[0] !== "money") [prefixStart, currency] = [null, null];
  return { raw, start, end: found?.[1] ?? end, amount, written, scaled, suffix, prefixStart, currency };
}

function atoms(text: string, lang: Language, free: (start: number, end: number) => boolean): Atom[] {
  const out: Atom[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const amount = toDecimal(m[0], lang);
    const end = m.index + m[0].length;
    if (amount !== null && free(m.index, end)) out.push(atomAt(text, m[0], m.index, end, amount, "digits"));
  }
  const found = words(text);
  let i = 0;
  while (i < found.length) {
    const read = readWords(lang, found, i);
    if (read === null) {
      i += 1;
      continue;
    }
    const [amount, past] = read;
    const start = found[i]?.start ?? 0;
    const end = found[past - 1]?.end ?? 0;
    if (free(start, end)) {
      const candidate = atomAt(text, text.slice(start, end), start, end, amount, "words");
      if (candidate.suffix !== null && candidate.suffix[0] !== "count") out.push(candidate);
    }
    i = past;
  }
  return out.sort((a, b) => a.start - b.start);
}

function classOf(atom: Atom): Suffix | null {
  if (atom.suffix !== null) return atom.suffix;
  return atom.prefixStart !== null ? ["money", atom.currency] : null;
}

const sameSuffix = (a: Suffix | null, b: Suffix): boolean => a === null || (a[0] === b[0] && a[1] === b[1]);

const TWO_DECIMALS = pattern(String.raw`[.,]\d{2}$`);
const DIGITS = pattern(String.raw`^\d+\Z`);
const NEXT_WORD = pattern(String.raw`\s+[a-z]`, "y");

/** A number with nothing around it that says what it measures. */
function bare(text: string, atom: Atom): Mention | null {
  const raw = atom.raw;
  if (atom.written === "words") return null;
  const digits = DIGITS.test(raw);
  const year = raw.length === 4 && digits && integer(raw) >= 1900 && integer(raw) <= 2099;
  if (!atom.scaled && digits && (raw.length >= 5 || (raw.length > 1 && raw.startsWith("0")) || year)) {
    return new Mention("label", atom.start, atom.end);
  }
  if (!atom.scaled && TWO_DECIMALS.test(raw)) return new Mention("money", atom.start, atom.end, { amount: atom.amount });
  if (isIntegral(atom.amount) && matchAt(NEXT_WORD, text, atom.end)) {
    return new Mention("count", atom.start, atom.end, { amount: atom.amount });
  }
  return null;
}

/** The amounts a unit or a currency qualifies, and apart the bare numbers, which come after the codes. */
function amounts(text: string, lang: Language, free: (start: number, end: number) => boolean): [Mention[], Mention[]] {
  const all = atoms(text, lang, free);
  const found: Mention[] = [];
  const rest: Mention[] = [];
  for (let i = 0; i < all.length; i++) {
    const atom = all[i];
    if (atom === undefined) continue;
    const next = all[i + 1];
    const kind = classOf(atom);
    const start = atom.prefixStart ?? atom.start;
    // A range: this amount, a joiner, the next amount; the unit may come only once, after the second.
    let other = next !== undefined ? classOf(next) : null;
    if (other === null && kind !== null && next?.written === atom.written) {
      other = kind; // "R$ 300 a 400": the second amount, alone, takes the first one's unit
    }
    if (next !== undefined && other !== null && sameSuffix(kind, other) && compare(atom.amount, next.amount) < 0) {
      const gap = text.slice(atom.end, next.prefixStart ?? next.start);
      const between = search(BETWEEN, text, Math.max(0, start - 10), start) !== null;
      if (JOINED.test(gap) || (between && AND.test(gap))) {
        const [cls, unit] = other;
        found.push(new Mention(cls, start, next.end, { low: atom.amount, high: next.amount, unit }));
        i += 1;
        continue;
      }
    }
    if (kind !== null) {
      const [cls, unit] = kind;
      found.push(new Mention(cls, start, atom.end, { amount: atom.amount, unit, written: atom.written }));
    } else {
      const mention = bare(text, atom);
      if (mention !== null) rest.push(mention);
    }
  }
  return [found, rest];
}

const CODE = pattern(String.raw`(?<![\w$])(?=[\w-]*\d)(?=[\w-]*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*(?![\w])`, "g");

function codes(text: string): Mention[] {
  return Array.from(text.matchAll(CODE), (m) => new Mention("label", m.index, m.index + m[0].length));
}

function parse(text: string, lang: Language): readonly Mention[] {
  const all = folded(text);
  const taken: Mention[] = [];
  const free = (start: number, end: number): boolean => taken.every((t) => end <= t.start || start >= t.end);
  const keep = (candidates: Mention[]): void => {
    const ordered = [...candidates].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
    for (const mention of ordered) if (free(mention.start, mention.end)) taken.push(mention);
  };
  keep(labelsByShape(all));
  keep(labelsByCue(all));
  keep(dates(all, lang));
  const [found, rest] = amounts(all, lang, free);
  keep(found);
  keep(codes(all));
  keep(rest);
  return taken.sort((a, b) => a.start - b.start);
}

const PARSED: Record<Language, (text: string) => readonly Mention[]> = {
  pt: memo((text) => parse(text, "pt")),
  en: memo((text) => parse(text, "en")),
  es: memo((text) => parse(text, "es")),
};

/** The numbers of `text` in the language `lang`, in the order they appear; offsets are code points. */
export function mentions(text: string, lang: Language): readonly Mention[] {
  if (!LANGUAGES.includes(lang)) throw new RangeError(`unknown language ${JSON.stringify(lang)}`);
  return PARSED[lang](text);
}
