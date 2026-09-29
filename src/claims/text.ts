/**
 * Offsets, words and sentences of an output, as every part of the claim checker reads them.
 *
 * Offsets are Unicode code points (the claim contract spec, section 2). The checker reads a text as one
 * UTF-16 unit per code point (`units`), so every index a regular expression returns is a code point offset.
 * Its patterns read `\w`, `\d`, `\s` and `\b` as Python's `re` does on text (`pattern`): the SDKs and the
 * server's reference checker find the same numbers in the same places.
 */

/** A start and an end, in code points, end excluded. */
export type Span = readonly [number, number];

const WORD_CHARS = String.raw`\p{L}\p{N}_`;
/** What Python's `str.isspace` counts as a space. */
const SPACE_CHARS = String.raw`\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const CLASSES: Partial<Record<string, string>> = { w: WORD_CHARS, d: String.raw`\p{Nd}`, s: SPACE_CHARS };
const BOUNDARY = `(?:(?<=[${WORD_CHARS}])(?![${WORD_CHARS}])|(?<![${WORD_CHARS}])(?=[${WORD_CHARS}]))`;

/**
 * A pattern written for Python's `re` on text, as a regular expression that matches the same: `\w` is a
 * letter, a number or `_` of any script, `\d` a decimal digit of any script, `\s` any space, `\b` the edge
 * of a run of `\w`, `$` the end or a line break that ends the text, and `\Z` the end only.
 */
export function pattern(source: string, flags = ""): RegExp {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i);
    if (ch === "\\") {
      const next = source.charAt(++i);
      const chars = CLASSES[next];
      if (chars !== undefined) out += inClass ? chars : `[${chars}]`;
      else if (next === "b" && !inClass) out += BOUNDARY;
      else out += next === "Z" && !inClass ? "$" : `\\${next}`;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    out += ch === "$" && !inClass ? String.raw`(?=\n?$)` : ch;
  }
  return new RegExp(out, `${flags}u`);
}

/** `re.search(text, pos, endpos)`: the first match at `pos` or after, reading nothing past `endpos`. */
export function search(re: RegExp, text: string, pos: number, endpos = text.length): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text.slice(0, endpos));
}

/** `re.match(text, pos)`, for a sticky pattern: a match starting at `pos` exactly. */
export function matchAt(re: RegExp, text: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text);
}

/** `compute`, remembered for the last texts it read: a check reads one output many times. */
export function memo<T>(compute: (text: string) => T, size = 256): (text: string) => T {
  const cache = new Map<string, T>();
  return (text) => {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const value = compute(text);
    const oldest = cache.keys().next();
    if (cache.size >= size && !oldest.done) cache.delete(oldest.value);
    cache.set(text, value);
    return value;
  };
}

const ASCII = /^\p{ASCII}*$/u;
const SURROGATE = /[\ud800-\udfff]/;
const DIGIT = /^\p{Nd}$/u;
const WORD_CHAR = /^[\p{L}\p{N}]$/u;
const MARK = /^[\p{Mn}\p{Mc}]$/u;

/** The value of a decimal digit of any script: Unicode encodes each script's digits in one run, 0 to 9. */
export function digitValue(ch: string): number {
  let cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
  let value = 0;
  while (DIGIT.test(String.fromCodePoint(cp - 1))) {
    cp -= 1;
    value += 1;
  }
  return value % 10;
}

/** The integer that decimal digits of any script write, as Python's `int` reads it. */
export function integer(digits: string): number {
  let value = 0;
  for (const ch of digits) value = value * 10 + digitValue(ch);
  return value;
}

/**
 * `text` as one UTF-16 unit per code point, so an index is a code point offset. A character past the Basic
 * Multilingual Plane stands in as one unit that every pattern reads alike: a decimal digit of the same value,
 * a letter, or a symbol.
 */
export const units = memo((text: string): string => {
  if (!SURROGATE.test(text)) return text;
  let out = "";
  for (const ch of text) {
    if (ch.length === 1) out += ch;
    else if (DIGIT.test(ch)) out += String.fromCharCode(0x0660 + digitValue(ch));
    else out += WORD_CHAR.test(ch) ? "\u3400" : "\ufffc";
  }
  return out;
});

/** The code points of `text` from `start` to `end`. */
export function slice(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join("");
}

/**
 * Whether `c`, a code point of a decomposed text, is a combining mark (a canonical combining class other
 * than 0, what Python's `unicodedata.combining` reads): canonical ordering moves a mark between two marks
 * out of order, and never moves a starter.
 */
export function combining(c: string): boolean {
  if (!MARK.test(c)) return false;
  const run = `\u0301${c}\u0316`;
  return run.normalize("NFD") !== run;
}

/** `text` in compatibility form (NFKD), without its combining marks. */
export function plain(text: string): string {
  let out = "";
  for (const c of text.normalize("NFKD")) if (!combining(c)) out += c;
  return out;
}

/**
 * Lower case without accents, one code point for each code point, so an offset in the folded text is an
 * offset in the text: a character that folds to more than one (`ﬁ`, `½`) becomes `?`.
 */
export const fold = memo((text: string): string => {
  if (ASCII.test(text)) return text.toLowerCase();
  let out = "";
  for (const ch of text) {
    const folded = plain(ch).toLowerCase();
    out += Array.from(folded).length === 1 ? folded : "?";
  }
  return out;
});

/** The folded text as the checker's patterns read it, one unit per code point (`units`). */
export function folded(text: string): string {
  return units(fold(text));
}

/** A folded word or number of a text, and where it is. */
export interface Word {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const WORD = /[a-z0-9]+(?:['’][a-z]+)?/g;

/** The folded words and numbers of a text, with their offsets; punctuation separates them. */
export const words = memo((text: string): readonly Word[] =>
  Array.from(folded(text).matchAll(WORD), (m) => ({ text: m[0], start: m.index, end: m.index + m[0].length })),
);

export function phraseAt(found: readonly Word[], i: number, phrase: readonly string[]): boolean {
  return phrase.every((word, k) => found[i + k]?.text === word);
}

/** The distinct word sequences of `terms`, leaving out a term without words. */
export function phrases(terms: readonly string[]): string[][] {
  const out = new Map<string, string[]>();
  for (const term of terms) {
    const phrase = words(term).map((w) => w.text);
    if (phrase.length > 0) out.set(phrase.join(" "), phrase);
  }
  return [...out.values()];
}

// A sentence ends at `!`, `?` or `;` before a space, at a period before a space and a capital letter (so
// "art. 5" and "R$ 1.234,56" never end one), and at a line break.
const SENTENCE_END = pattern(String.raw`[!?;](?=\s|$)|\.(?=\s+[A-ZÀ-Ý]|\s*$)|\n`, "g");

export const sentences = memo((text: string): readonly Span[] => {
  const all = units(text);
  const spans: Span[] = [];
  let start = 0;
  for (const m of all.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length;
    if (end > start) spans.push([start, end]);
    start = end;
  }
  if (start < all.length) spans.push([start, all.length]);
  return spans;
});

export function sentenceOf(text: string, offset: number): Span {
  return sentences(text).find(([start, end]) => start <= offset && offset < end) ?? [0, units(text).length];
}

const QUOTES: Partial<Record<string, string>> = { '"': '"', "“": "”", "«": "»", "„": "“" };

/**
 * The spans between quotation marks, marks excluded: straight double quotes pair in order, and the curly
 * and angle quotes pair with their closing mark. A mark left open quotes nothing.
 */
export const quotations = memo((text: string): readonly Span[] => {
  const all = units(text);
  const spans: Span[] = [];
  let i = 0;
  while (i < all.length) {
    const close = QUOTES[all.charAt(i)];
    const end = close === undefined ? -1 : all.indexOf(close, i + 1);
    if (end > i + 1) {
      spans.push([i + 1, end]);
      i = end + 1;
    } else i += 1;
  }
  return spans;
});
