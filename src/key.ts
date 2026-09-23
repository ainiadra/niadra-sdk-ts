/** The parts of a source key the SDK needs to find the right endpoint. */
export interface ParsedApiKey {
  /** `live` keys reach production spaces, `test` keys reach sandbox spaces. */
  mode: "live" | "test";
  /** Data region, such as `sa-east-1`. */
  region: string;
  /** The space (project and environment) the key belongs to. */
  space: string;
  keyId: string;
}

const PREFIX = "nia_sk_";
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KEY_ID = /^[A-Za-z0-9]+$/;

/**
 * Parses `nia_sk_<live|test>_<region>_<space>_<key_id>_<secret>`.
 *
 * Region and space become DNS labels in the base URL, so they are held to lowercase letters,
 * digits and inner hyphens. The secret is everything after the fifth underscore and is never
 * returned. Returns `null` for anything that does not match, rather than guessing.
 */
export function parseApiKey(apiKey: string): ParsedApiKey | null {
  if (!apiKey.startsWith(PREFIX)) return null;
  const parts = apiKey.slice(PREFIX.length).split("_");
  if (parts.length < 5) return null;
  const [mode, region, space, keyId] = parts as [string, string, string, string];
  const secret = parts.slice(4).join("_");
  if (mode !== "live" && mode !== "test") return null;
  if (!DNS_LABEL.test(region) || !DNS_LABEL.test(space)) return null;
  if (!KEY_ID.test(keyId) || secret.length === 0) return null;
  return { mode, region, space, keyId };
}

/**
 * The stable address of a space: `https://<space>.<region>.api.niadra.com`. It never names a
 * cell; when a space moves between cells, the old cell answers 421 and the SDK retries.
 */
export function baseURLFromKey(key: ParsedApiKey): string {
  return `https://${key.space}.${key.region}.api.niadra.com`;
}
