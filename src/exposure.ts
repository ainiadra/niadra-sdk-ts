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

import { toBase64url } from "./base64url.js";
import { NiadraError } from "./errors.js";
import { sha256 } from "./sha256.js";

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
