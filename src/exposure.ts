/**
 * The exposure token (`spec/exposure-token.md`): `nx1.<id>.<position>.<verifier>`, the short string a card
 * carries so that the order line the store's app copies it into names the list the agent showed and the
 * card's place in it.
 *
 * The token carries no personal data. Its verifier catches a token copied wrong or cut short; it is not a
 * signature. Building one is synchronous, so a card can carry it as it renders: the SHA-256 of the verifier
 * is computed here, since Web Crypto only hashes asynchronously.
 *
 * The same rules as the Python SDK's `niadra.exposure`.
 */

import { NiadraError } from "./errors.js";

const UUID = /^[0-9a-f]{32}$/i;
const ID = /^[A-Za-z0-9_-]{22}$/;
const VERIFIER = /^[A-Za-z0-9_-]{4}$/;
const POSITION = /^[1-9][0-9]{0,3}$/;

/** Why a reader refuses a token: the first check of `spec/exposure-token.md`, section 4, that fails. */
export type ExposureTokenRefusal = "malformed" | "unsupported_version" | "bad_position" | "bad_verifier";

/** A token a reader refuses, with the code of the first check it fails. */
export class NiadraExposureTokenError extends NiadraError {
  override readonly name = "NiadraExposureTokenError";

  constructor(readonly code: ExposureTokenRefusal) {
    super(code);
  }
}

/**
 * The token of the card at `position` (1-based, up to 9999) of the exposure `exposureId`, a UUID: 33
 * characters for the first card, at most 36.
 */
export function exposureToken(exposureId: string, position: number): string {
  if (!Number.isInteger(position) || position < 1 || position > 9999) {
    throw new RangeError("a card's position is from 1 to 9999");
  }
  const hex = exposureId.replace(/-/g, "");
  if (!UUID.test(hex)) throw new TypeError("the exposure id is not a UUID");
  const bytes = Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  const head = `nx1.${toBase64url(bytes)}.${position}`;
  return `${head}.${verifier(head)}`;
}

/** The exposure id, written as a UUID, and the position a token names. Throws `NiadraExposureTokenError`. */
export function parseExposureToken(token: string): { exposureId: string; position: number } {
  const segments = token.split(".");
  if (segments.length !== 4) throw new NiadraExposureTokenError("malformed");
  const [version = "", id = "", position = "", check = ""] = segments;
  if (version !== "nx1") throw new NiadraExposureTokenError("unsupported_version");
  if (!ID.test(id)) throw new NiadraExposureTokenError("malformed");
  const bytes = Uint8Array.from(atob(id.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
  if (toBase64url(bytes) !== id) throw new NiadraExposureTokenError("malformed");
  if (!VERIFIER.test(check)) throw new NiadraExposureTokenError("malformed");
  if (!POSITION.test(position)) throw new NiadraExposureTokenError("bad_position");
  if (verifier(`${version}.${id}.${position}`) !== check) throw new NiadraExposureTokenError("bad_verifier");
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const exposureId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { exposureId, position: Number(position) };
}

function verifier(head: string): string {
  return toBase64url(sha256(new TextEncoder().encode(head))).slice(0, 4);
}

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Words = [number, number, number, number, number, number, number, number];

const INITIAL: Words = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const ROUNDS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 (FIPS 180-4). */
function sha256(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const message = new DataView(padded.buffer);
  message.setUint32(padded.length - 8, Math.floor(data.length / 0x20000000));
  message.setUint32(padded.length - 4, data.length * 8);
  const w = new DataView(new ArrayBuffer(256));
  let state = INITIAL;
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 64; i++) {
      if (i < 16) {
        w.setUint32(i * 4, message.getUint32(block + i * 4));
        continue;
      }
      const x = w.getUint32((i - 15) * 4);
      const y = w.getUint32((i - 2) * 4);
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w.setUint32(i * 4, w.getUint32((i - 16) * 4) + s0 + w.getUint32((i - 7) * 4) + s1);
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (const [i, round] of ROUNDS.entries()) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + round + w.getUint32(i * 4)) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
    }
    const [h0, h1, h2, h3, h4, h5, h6, h7] = state;
    state = [(h0 + a) | 0, (h1 + b) | 0, (h2 + c) | 0, (h3 + d) | 0, (h4 + e) | 0, (h5 + f) | 0, (h6 + g) | 0, (h7 + h) | 0];
  }
  const digest = new DataView(new ArrayBuffer(32));
  for (const [i, word] of state.entries()) digest.setUint32(i * 4, word);
  return new Uint8Array(digest.buffer);
}
