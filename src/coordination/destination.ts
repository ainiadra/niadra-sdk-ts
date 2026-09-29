/**
 * The canonical destination of a handle and its key per reader (`spec/suppression-list.md`, sections 3
 * and 4).
 *
 * A phone number, a WhatsApp id and an e-mail address each have one canonical form, `phone:+<E.164>` or
 * `email:<address>`. The suppression list keys it with each reader's salt, and the contact token carries it
 * keyed with the gateway's key as `rcpt` (`spec/contact-token.md`, section 4.1), so a reader matches the
 * destination it is about to contact without the list ever carrying a handle.
 *
 * The same rules as the Python SDK's `niadra.coordination.destination`.
 */

import { fromBase64url, toBase64url } from "../base64url.js";
import { NiadraError } from "../errors.js";

const SEPARATORS = /[\s().\-/]/g;
const DIGITS = /^[0-9]+$/;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]{1,63})+$/;

/**
 * A handle with no canonical destination: `invalid_handle` when the value is not a handle of its type,
 * `unsupported_type` when the list does not cover the type.
 */
export class NiadraDestinationError extends NiadraError {
  override readonly name = "NiadraDestinationError";

  constructor(readonly code: "invalid_handle" | "unsupported_type") {
    super(code);
  }
}

/**
 * The canonical form of a handle of `type` (`phone_e164`, `wa_id`, `wa_jid` or `email`), such as
 * `phone:+5511987654321` for `"(11) 98765-4321"`. Throws `NiadraDestinationError`.
 */
export function canonicalDestination(type: string, value: string): string {
  switch (type) {
    case "phone_e164":
      return phone(value);
    case "wa_id": {
      const text = value.trim();
      return phone(text.startsWith("+") ? text : `+${text}`);
    }
    case "wa_jid": {
      const user = value.trim().toLowerCase().split("@", 1)[0] ?? "";
      return phone(`+${user.split(":", 1)[0] ?? ""}`);
    }
    case "email": {
      const address = value.trim().toLowerCase();
      if (!EMAIL.test(address)) throw new NiadraDestinationError("invalid_handle");
      return `email:${address}`;
    }
    default:
      throw new NiadraDestinationError("unsupported_type");
  }
}

/**
 * A canonical destination keyed with a reader's salt, in base64url as `GET /v1/suppressions/salt` gives it:
 * the base64url of HMAC-SHA256 over its UTF-8 bytes, 43 characters. Web Crypto signs asynchronously.
 */
export async function suppressionKey(salt: string, canonical: string): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey("raw", saltBytes(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64url(new Uint8Array(await subtle.sign("HMAC", key, new TextEncoder().encode(canonical))));
}

/**
 * `phone:+<digits>` in E.164: a Brazilian national number gains `55`, and a Brazilian mobile number from
 * before the ninth digit gains its `9`.
 */
function phone(value: string): string {
  const raw = value.trim().replace(SEPARATORS, "");
  const international = raw.startsWith("+") || raw.startsWith("00");
  let digits = raw.startsWith("+") ? raw.slice(1) : international ? raw.slice(2) : raw;
  if (!DIGITS.test(digits)) throw new NiadraDestinationError("invalid_handle");
  const national = digits.replace(/^0+/, "");
  if (!international && (national.length === 10 || national.length === 11) && isArea(national.slice(0, 2))) {
    digits = `55${national}`;
  }
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) {
    throw new NiadraDestinationError("invalid_handle");
  }
  const rest = digits.slice(2);
  if (digits.startsWith("55") && rest.length === 10 && isArea(rest.slice(0, 2)) && "6789".includes(rest.charAt(2))) {
    digits = `55${rest.slice(0, 2)}9${rest.slice(2)}`;
  }
  return `phone:+${digits}`;
}

/** A Brazilian area code: two digits, neither of them zero. */
function isArea(code: string): boolean {
  return /^[1-9]{2}$/.test(code);
}

function saltBytes(salt: string): Uint8Array<ArrayBuffer> {
  const bytes = fromBase64url(salt);
  if (bytes === null) throw new TypeError("the salt is not base64url");
  return bytes;
}
