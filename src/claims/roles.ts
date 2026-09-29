/**
 * A number's role, from the words around it (the claim contract spec, section 6): the same R$ 511,06 is a
 * full price, a discounted one or a price per person by what the sentence says next to it.
 *
 * A role's term counts within `WINDOW` words of the number, in the same sentence, and belongs to the nearest
 * number of the same class (to both when two are as near). The nearest term gives the role, and at the same
 * distance a term of the number's own beats one it shares; two terms of different roles still tied leave the
 * number without one, `ambiguous`, which is never approved.
 */

import type { Mention } from "./numbers.js";
import { type Span, phraseAt, phrases, sentenceOf, words } from "./text.js";

/** Words between a number and a term of its role, at most. */
export const WINDOW = 6;

export interface Role {
  readonly name: string | null;
  readonly status: "matched" | "ambiguous" | "none";
}

interface Term {
  role: string;
  /** Word indexes: the term's first word, and the one after its last. */
  first: number;
  past: number;
}

export const NO_ROLE: Role = { name: null, status: "none" };

function terms(text: string, roles: Readonly<Record<string, readonly string[]>>, inside: readonly Span[]): Term[] {
  const found = words(text);
  const hits: Term[] = [];
  for (const [role, list] of Object.entries(roles)) {
    for (const phrase of phrases(list)) {
      for (let i = 0; i < found.length; i++) {
        if (phraseAt(found, i, phrase)) hits.push({ role, first: i, past: i + phrase.length });
      }
    }
  }
  // The longest term at the leftmost place wins; a term inside a number's span is part of the number.
  const length = (t: Term): number => t.past - t.first;
  hits.sort((a, b) => a.first - b.first || length(b) - length(a) || (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
  const kept: Term[] = [];
  for (const hit of hits) {
    const start = found[hit.first]?.start ?? 0;
    const end = found[hit.past - 1]?.end ?? 0;
    if (inside.some(([s, e]) => s < end && start < e)) continue;
    const apart = kept.every((k) => hit.past <= k.first || hit.first >= k.past);
    if (apart || kept.some((k) => k.first === hit.first && k.past === hit.past)) kept.push(hit);
  }
  return kept;
}

/** The role of each of `numbers` (a category's mentions, in order), by the terms of `roles`. */
export function rolesOf(text: string, numbers: readonly Mention[], roles: Readonly<Record<string, readonly string[]>>): Role[] {
  if (Object.keys(roles).length === 0) return numbers.map(() => NO_ROLE);
  const found = words(text);
  const spans: Span[] = numbers.map((m) => {
    const indexes = found.flatMap((w, i) => (m.start <= w.start && w.start < m.end ? [i] : []));
    const first = indexes[0];
    const last = indexes[indexes.length - 1];
    return first !== undefined && last !== undefined ? [first, last + 1] : [0, 0];
  });
  const sentences = numbers.map((m) => sentenceOf(text, m.start));

  const distance = (term: Term, k: number): number | null => {
    const [first, past] = spans[k] ?? [0, 0];
    const [low, high] = sentences[k] ?? [0, 0];
    const start = found[term.first]?.start ?? 0;
    if (!(low <= start && start < high) || past === 0) return null;
    const gap = term.first >= past ? term.first - past : first - term.past;
    return gap >= 0 && gap <= WINDOW ? gap : null;
  };

  // Per number: [distance, shared with another number, role]. A term of its own beats a shared one at the
  // same distance: in "de R$ 299,90 por R$ 199,90", "por" is as near to both, and "de" is the first's alone.
  const near: [number, boolean, string][][] = numbers.map(() => []);
  for (const term of terms(text, roles, numbers.map((m) => [m.start, m.end]))) {
    const distances = numbers.flatMap((_, k) => {
      const d = distance(term, k);
      return d === null ? [] : [[d, k] as const];
    });
    if (distances.length === 0) continue;
    const closest = Math.min(...distances.map(([d]) => d));
    const owners = distances.filter(([d]) => d === closest).map(([, k]) => k);
    for (const k of owners) near[k]?.push([closest, owners.length > 1, term.role]);
  }
  // Nearest first, and at the same distance a term of the number's own before a shared one.
  const rank = ([d, shared]: [number, boolean, string]): number => 2 * d + (shared ? 1 : 0);
  return near.map((candidates): Role => {
    if (candidates.length === 0) return NO_ROLE;
    const best = Math.min(...candidates.map(rank));
    const named = new Set(candidates.filter((c) => rank(c) === best).map(([, , role]) => role));
    const [name] = named;
    return named.size === 1 && name !== undefined ? { name, status: "matched" } : { name: null, status: "ambiguous" };
  });
}
