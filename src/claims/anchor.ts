/**
 * The text anchor (the claim contract spec, section 9): how closely a quoted passage matches the document
 * it cites.
 *
 * Both texts are normalized the same way: lower case, no accents, every run of anything but letters and
 * digits one space, trimmed. The score is `1 - d / len(quote)`, where `d` is the fewest insertions, deletions
 * and substitutions that turn the quote into some passage of the document (any start, any end), and an anchor
 * holds at 0.90 or above. The distance runs as Myers' bit-parallel algorithm, linear in the document's length.
 */

import { plain } from "./text.js";

/** An anchor holds at this score or above; a contract may ask for more, never less. */
export const MIN_ANCHOR_MATCH = 0.9;

const NOT_ALNUM = /[^a-z0-9]+/g;

export function normalize(text: string): string {
  return plain(text).toLowerCase().replace(NOT_ALNUM, " ").trim();
}

/** The edit distance between `pattern` and the passage of `text` nearest to it. */
export function distance(pattern: string, text: string): number {
  const chars = Array.from(pattern);
  const m = chars.length;
  if (m === 0) return 0;
  const full = (1n << BigInt(m)) - 1n;
  const top = 1n << BigInt(m - 1);
  const peq = new Map<string, bigint>();
  chars.forEach((ch, i) => peq.set(ch, (peq.get(ch) ?? 0n) | (1n << BigInt(i))));
  let pv = full;
  let mv = 0n;
  let score = m;
  let best = m;
  for (const ch of text) {
    const eq = peq.get(ch) ?? 0n;
    const xv = eq | mv;
    const xh = (((eq & pv) + pv) ^ pv) | eq;
    let ph = mv | (~(xh | pv) & full);
    let mh = pv & xh;
    if ((ph & top) !== 0n) score += 1;
    else if ((mh & top) !== 0n) score -= 1;
    // A passage may start anywhere in the text: no carry into the first row.
    ph = (ph << 1n) & full;
    mh = (mh << 1n) & full;
    pv = mh | (~(xv | ph) & full);
    mv = ph & xv;
    best = Math.min(best, score);
  }
  return best;
}

/** 1 when the normalized quote is a passage of the normalized document; 0 for an empty quote. */
export function score(quote: string, document: string): number {
  const q = normalize(quote);
  const d = normalize(document);
  if (!q) return 0;
  if (d.includes(q)) return 1;
  return 1 - distance(q, d) / q.length;
}
