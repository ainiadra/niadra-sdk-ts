/**
 * The digest of a value a turn record carries: SHA-256 over its canonical JSON (RFC 8785).
 *
 * The canonical form leaves no whitespace, sorts object keys by their UTF-16 code units and writes numbers
 * as ECMAScript does, so a producer in any language hashes the same value to the same digest. The Turn
 * Record spec fixes it (section 6.2.1) with the vectors in `spec/vectors/turn-record-digest.v0.json`.
 */

/**
 * `value` (JSON data: plain objects, arrays, strings, finite numbers, booleans and `null`) as its
 * canonical JSON. A property whose value is `undefined` is left out, as `JSON.stringify` does; anything
 * JSON cannot hold (`NaN`, a `bigint`, a `Date`) throws.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON has no NaN or Infinity");
    // ECMAScript's Number::toString, which RFC 8785 adopts: -0 is written 0, 1e21 is 1e+21.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON takes only plain objects");
    }
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    // The default sort compares UTF-16 code units, the order RFC 8785 fixes.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new TypeError(`canonical JSON has no form for a ${typeof value}`);
}

/**
 * `value`'s digest, written `sha256:<hex>`, and the size in bytes of its canonical JSON (UTF-8). Web
 * Crypto hashes asynchronously, so the turn capture hashes when it sends, never on the agent's path.
 */
export async function jsonDigest(value: unknown): Promise<{ sha256: string; size: number }> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { sha256: `sha256:${hex}`, size: bytes.length };
}
