/**
 * The measure the tool counterfactual reports (`spec/counterfactual.md`, 4): how much two ranked lists of
 * object references agree in their first positions, weighted by the exposure a position gets.
 *
 * The runner of the counterfactual (each recorded tool call run live with and without an element of the
 * constraints block) reports only positions and these overlaps, never items.
 */

export const MAX_K = 100;

/**
 * Depth-weighted average overlap of `a` and `b` down to `min(k, the longer list's length)`, with
 * `w(d) = 1 / log2(d + 1)`. An item repeated within a list counts once, at its first position. Two equal
 * lists overlap 1, and so do two empty lists; a list against an empty one overlaps 0.
 */
export function overlapAtK(a: readonly string[], b: readonly string[], k: number): number {
  if (!Number.isInteger(k) || k < 1 || k > MAX_K) throw new RangeError(`k must be 1 to ${String(MAX_K)}`);
  const first = [...new Set(a)];
  const second = [...new Set(b)];
  const depth = Math.min(k, Math.max(first.length, second.length));
  if (depth === 0) return 1;
  let weighted = 0;
  let total = 0;
  for (let d = 1; d <= depth; d++) {
    const top = new Set(first.slice(0, d));
    const shared = second.slice(0, d).filter((item) => top.has(item)).length;
    const weight = 1 / Math.log2(d + 1);
    weighted += (weight * shared) / d;
    total += weight;
  }
  return weighted / total;
}
