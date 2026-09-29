/** base64url without padding (RFC 4648, section 5), as tokens, salts and keys carry bytes. */

const ALPHABET = /^[A-Za-z0-9_-]*$/;

export function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url without padding, or `null`. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!ALPHABET.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}
