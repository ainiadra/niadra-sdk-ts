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

/** Brazil's area codes (DDD) in use (section 3.4). */
const AREA_CODES = new Set(
  (
    "11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 " +
    "51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 " +
    "91 92 93 94 95 96 97 98 99"
  ).split(" "),
);
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/**
 * `phone:+<digits>` in E.164 (section 3.1): invisible marks and a `tel:` prefix dropped, a Brazilian
 * national number gains `55` (also after a carrier code), a Brazilian mobile number from before the ninth
 * digit gains its `9`, and the mobile `1` of Mexico and `9` of Argentina that WhatsApp ids keep are dropped.
 */
function phone(value: string): string {
  let text = value.normalize("NFKC").replace(FORMAT_CHARACTERS, "").trim();
  if (text.slice(0, 4).toLowerCase() === "tel:") text = text.slice(4);
  const international = text.startsWith("+") || text.startsWith("00");
  if (international) text = text.replaceAll("(0)", "");
  const raw = text.replace(SEPARATORS, "");
  let digits = raw.startsWith("+") ? raw.slice(1) : international ? raw.slice(2) : raw;
  if (!DIGITS.test(digits)) throw new NiadraDestinationError("invalid_handle");
  if (!international) {
    const national = digits.replace(/^0+/, "");
    if (isBrazilianNational(national)) {
      digits = `55${national}`;
    } else if (digits.startsWith("0") && (national.length === 12 || national.length === 13)) {
      if (isBrazilianNational(national.slice(2))) digits = `55${national.slice(2)}`;
    }
  }
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) {
    throw new NiadraDestinationError("invalid_handle");
  }
  const rest = digits.slice(2);
  if (digits.startsWith("55") && rest.length === 10 && AREA_CODES.has(rest.slice(0, 2)) && "6789".includes(rest.charAt(2))) {
    digits = `55${rest.slice(0, 2)}9${rest.slice(2)}`;
  }
  if (digits.length === 13 && (digits.startsWith("521") || digits.startsWith("549"))) {
    digits = digits.slice(0, 2) + digits.slice(3);
  }
  return `phone:+${digits}`;
}

/** An area code, then 8 digits from 2 to 9 or 9 digits from 9 (section 3.1, step 5). */
function isBrazilianNational(national: string): boolean {
  if (!AREA_CODES.has(national.slice(0, 2))) return false;
  if (national.length === 10) return "23456789".includes(national.charAt(2));
  return national.length === 11 && national.charAt(2) === "9";
}

function saltBytes(salt: string): Uint8Array<ArrayBuffer> {
  const bytes = fromBase64url(salt);
  if (bytes === null) throw new TypeError("the salt is not base64url");
  return bytes;
}
