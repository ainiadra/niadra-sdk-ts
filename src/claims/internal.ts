/**
 * Internal text (the claim contract spec, section 11): fingerprints of the company's own prompt, so an output
 * that repeats a passage of it gives way to the contract's `redact` line.
 *
 * ```ts
 * niadra.internalText.register("prompts@v16", CORE_PROMPT); // the contract's `shingle_hashes_ref`
 * ```
 *
 * A fingerprint is the SHA-256 of `n` consecutive words of the prompt (folded as the claim checker folds text,
 * joined by one space), and the prompt never leaves the process: Niadra knows only the name of the version
 * the fingerprints come from. `shingles()` computes them apart, for a company that ships only the
 * fingerprints to the agent's process (`registerHashes()`); the Python SDK computes the same ones.
 *
 * Each passage found becomes one claim of the turn record: category `internal_text`, verdict
 * `internal_text_found`, the span it had before the redaction, and the prompt version as its evidence.
 */

import { sha256Hex } from "../sha256.js";
import type { ClaimRecord } from "../types/turns.js";
import { words } from "./text.js";

const INTERNAL_CATEGORY = "internal_text";
const INTERNAL_VERDICT = "internal_text_found";

const encoder = new TextEncoder();
const hash = (folded: readonly string[]): string => sha256Hex(encoder.encode(folded.join(" ")));

/** The fingerprints of every `n` consecutive words of `text`. */
export function shingles(text: string, n: number): Set<string> {
  const folded = words(text).map((w) => w.text);
  const out = new Set<string>();
  for (let i = 0; i + n <= folded.length; i++) out.add(hash(folded.slice(i, i + n)));
  return out;
}

/** `niadra.internalText`: the company's prompt fingerprints by version, held in the process only. */
export class InternalText {
  private readonly texts = new Map<string, string[][]>();
  private readonly hashes = new Map<string, Set<string>>();

  /** The prompt texts of version `ref` (the contract's `shingle_hashes_ref`). */
  register(ref: string, ...texts: string[]): void {
    const held = this.texts.get(ref) ?? [];
    held.push(...texts.map((t) => words(t).map((w) => w.text)));
    this.texts.set(ref, held);
    for (const key of [...this.hashes.keys()]) if (key.startsWith(`${ref}\u0000`)) this.hashes.delete(key);
  }

  /** Fingerprints computed apart with `shingles(text, n)`. */
  registerHashes(ref: string, hashes: Iterable<string>, n = 8): void {
    const key = `${ref}\u0000${String(n)}`;
    const held = this.hashes.get(key) ?? new Set<string>();
    for (const h of hashes) held.add(h);
    this.hashes.set(key, held);
  }

  has(ref: string): boolean {
    return this.texts.has(ref) || [...this.hashes.keys()].some((key) => key.startsWith(`${ref}\u0000`));
  }

  /** Where `text` repeats `n` words of the prompt `ref`, as merged spans of code points. */
  passages(text: string, ref: string, n: number): [number, number][] {
    const known = this.fingerprints(ref, n);
    if (known.size === 0) return [];
    const found = words(text);
    const spans: [number, number][] = [];
    for (let i = 0; i + n <= found.length; i++) {
      if (!known.has(hash(found.slice(i, i + n).map((w) => w.text)))) continue;
      const start = found[i]?.start ?? 0;
      const end = found[i + n - 1]?.end ?? start;
      const last = spans.at(-1);
      if (last !== undefined && start <= last[1]) last[1] = Math.max(end, last[1]);
      else spans.push([start, end]);
    }
    return spans;
  }

  private fingerprints(ref: string, n: number): Set<string> {
    const key = `${ref}\u0000${String(n)}`;
    let known = this.hashes.get(key);
    const texts = this.texts.get(ref);
    if (known === undefined && texts !== undefined) {
      known = new Set();
      for (const folded of texts) for (let i = 0; i + n <= folded.length; i++) known.add(hash(folded.slice(i, i + n)));
      this.hashes.set(key, known);
    }
    return known ?? new Set();
  }
}

/** A passage as the turn record's `claims` carries it: never its text. */
export function internalRecord(span: readonly [number, number], ref: string, act: ClaimRecord["action"]): ClaimRecord {
  return { category: INTERNAL_CATEGORY, span: [span[0], span[1]], verdict: INTERNAL_VERDICT, action: act, evidence: { document: ref } };
}
