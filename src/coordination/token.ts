/**
 * The contact token's offline check, at the company's gateway (`spec/contact-token.md`).
 *
 * A coordination check that allows an outbound contact of a purpose that needs a token (by default
 * `marketing`, `retention` and `collection`) carries `contact_token`: `nct1.<payload>.<signature>`, signed
 * with the space's Ed25519 key. The gateway that dispatches the message checks it without calling anyone, and
 * lets the message out once:
 *
 * ```ts
 * const gateway = niadra.contactGateway("wa_gateway", { space: SPACE_ID, key: GATEWAY_KEY });
 * const claims = await gateway.verify(token, { handle: handles.phone("+5511987654321"), channel: "whatsapp" });
 * ```
 *
 * `verifyContactToken()` is the check itself, the thirteen steps of the spec in their order, each refusal
 * with its code. `ContactGateway` adds what a gateway keeps: the space's public keys (read from
 * `GET /.well-known/niadra-contact-keys.json?space=`, again every hour, and at most once a minute for a key
 * it does not know; the last set read stays in use while Niadra is out of reach) and the `jti` of every token
 * it let through, until the token's expiry plus the leeway. A gateway of several processes passes a shared
 * `seen` store. The signature is checked with Web Crypto's Ed25519.
 */

import { fromBase64url, toBase64url } from "../base64url.js";
import { NiadraError } from "../errors.js";
import type { Handle } from "../types/common.js";
import type { ContactKey, ContactKeys } from "../types/coordination.js";
import { canonicalDestination } from "./destination.js";

/** Seconds of clock skew a gateway allows, before `iat` and after `exp`. */
const LEEWAY = 5;
const MAX_LIFETIME = 120;
const MAX_LENGTH = 1024;
const KEYS_REFRESH_MS = 3_600_000;
const UNKNOWN_KID_REFRESH_MS = 60_000;

export type Refusal =
  | "malformed"
  | "unsupported_version"
  | "unknown_key"
  | "bad_signature"
  | "wrong_space"
  | "wrong_gateway"
  | "lifetime_too_long"
  | "not_yet_valid"
  | "expired"
  | "wrong_channel"
  | "wrong_recipient"
  | "replayed";

/** A token the gateway refuses, with the spec's code. A refused token is never retried: ask for a new decision. */
export class NiadraContactTokenError extends NiadraError {
  override readonly name = "NiadraContactTokenError";

  constructor(readonly code: Refusal) {
    super(code);
  }
}

/** The payload of a token that passed. */
export interface ContactClaims {
  kid: string;
  space: string;
  jti: string;
  purpose: string;
  channel: string;
  rcpt: string;
  gateway: string;
  iat: number;
  exp: number;
}

/**
 * Where a gateway remembers the tokens it let through. `add` records `jti` until `until` (seconds since the
 * epoch) and resolves `false` when it was already there: shared between processes, it must do both in one
 * atomic step (a Redis `SET NX EXAT`, a unique row).
 */
export interface SeenTokens {
  add(jti: string, until: number): boolean | Promise<boolean>;
}

/** The tokens one process let through, forgotten after their expiry and the leeway. */
export class MemorySeen implements SeenTokens {
  private readonly until = new Map<string, number>();

  constructor(private readonly clock: () => number = () => Date.now() / 1000) {}

  add(jti: string, until: number): boolean {
    const now = this.clock();
    if (this.until.size > 1024) for (const [k, v] of this.until) if (v <= now) this.until.delete(k);
    if ((this.until.get(jti) ?? 0) > now) return false;
    this.until.set(jti, until);
    return true;
  }
}

const MEMBERS: readonly [keyof ContactClaims, "string" | "number"][] = [
  ["kid", "string"],
  ["space", "string"],
  ["jti", "string"],
  ["purpose", "string"],
  ["channel", "string"],
  ["rcpt", "string"],
  ["gateway", "string"],
  ["iat", "number"],
  ["exp", "number"],
];
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const KID = /^[A-Za-z0-9_-]{8,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Strict base64url without padding, or `null`; never empty. */
function unb64(text: string): Uint8Array<ArrayBuffer> | null {
  return SEGMENT.test(text) ? fromBase64url(text) : null;
}

/**
 * `rcpt` for a canonical destination (`phone:+5511987654321`): the base64url of HMAC-SHA256 keyed with the
 * 32-byte key the gateway shares with Niadra (base64url, or the bytes).
 */
export async function recipientHash(gatewayKey: string | Uint8Array, destination: string): Promise<string> {
  const raw = typeof gatewayKey === "string" ? unb64(gatewayKey) : new Uint8Array(gatewayKey);
  if (raw === null) throw new TypeError("the gateway key is not base64url");
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(destination))));
}

function claimsOf(raw: Uint8Array): ContactClaims {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new NiadraContactTokenError("malformed");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new NiadraContactTokenError("malformed");
  const found = payload as Record<string, unknown>;
  if (Object.keys(found).length !== MEMBERS.length) throw new NiadraContactTokenError("malformed");
  for (const [name, kind] of MEMBERS) {
    const value = found[name];
    if (typeof value !== kind || (kind === "number" && !Number.isInteger(value))) throw new NiadraContactTokenError("malformed");
  }
  const claims = found as unknown as ContactClaims;
  const valid =
    KID.test(claims.kid) &&
    UUID.test(claims.space) &&
    UUID.test(claims.jti) &&
    [claims.purpose, claims.channel, claims.gateway].every((n) => NAME.test(n)) &&
    unb64(claims.rcpt) !== null &&
    claims.rcpt.length === 43;
  if (!valid) throw new NiadraContactTokenError("malformed");
  return { ...claims };
}

/** The key with the token's `kid` in the token's space; a retiring key past its `not_after` is gone. */
function keyOf(keys: readonly ContactKey[], claims: ContactClaims, now: number): ContactKey | null {
  for (const key of keys) {
    if (key.kid !== claims.kid || key.space !== claims.space) continue;
    if (key.not_after != null && Date.parse(key.not_after) / 1000 <= now) continue;
    return key;
  }
  return null;
}

async function signed(key: ContactKey, message: Uint8Array<ArrayBuffer>, signature: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const publicKey = unb64(key.x);
  if (publicKey?.length !== 32) return false;
  try {
    const imported = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, imported, signature, message);
  } catch {
    return false;
  }
}

export interface VerifyParams {
  keys: readonly ContactKey[];
  gatewayId: string;
  space: string;
  gatewayKey: string | Uint8Array;
  /** The canonical form of the message's destination. */
  destination: string;
  channel: string;
  /** The gateway's clock, in seconds; now by default. */
  now?: number;
  /** The `jti` the gateway already let through; remembering this one is the caller's (`ContactGateway` does it). */
  seen?: ReadonlySet<string>;
}

/**
 * Checks `token` for a message of `channel` to `destination` about to leave through `gatewayId`, in the spec's
 * order, and resolves with its payload. Rejects with `NiadraContactTokenError` and the first refusal that
 * applies.
 */
export async function verifyContactToken(token: string, params: VerifyParams): Promise<ContactClaims> {
  const now = Math.floor(params.now ?? Date.now() / 1000);
  const parts = typeof token === "string" && token.length <= MAX_LENGTH ? token.split(".") : [];
  if (parts.length !== 3 || parts.some((p) => p === "")) throw new NiadraContactTokenError("malformed");
  const [version = "", body = "", sig = ""] = parts;
  if (version !== "nct1") throw new NiadraContactTokenError("unsupported_version");
  const raw = unb64(body);
  const signature = unb64(sig);
  if (raw === null || signature?.length !== 64) throw new NiadraContactTokenError("malformed");
  const claims = claimsOf(raw);
  const key = keyOf(params.keys, claims, now);
  if (key === null) throw new NiadraContactTokenError("unknown_key");
  if (!(await signed(key, new TextEncoder().encode(`${version}.${body}`), signature))) throw new NiadraContactTokenError("bad_signature");
  if (claims.space !== params.space.toLowerCase()) throw new NiadraContactTokenError("wrong_space");
  if (claims.gateway !== params.gatewayId) throw new NiadraContactTokenError("wrong_gateway");
  if (!(claims.exp - claims.iat > 0 && claims.exp - claims.iat <= MAX_LIFETIME)) throw new NiadraContactTokenError("lifetime_too_long");
  if (claims.iat - LEEWAY > now) throw new NiadraContactTokenError("not_yet_valid");
  if (now >= claims.exp + LEEWAY) throw new NiadraContactTokenError("expired");
  if (claims.channel !== params.channel) throw new NiadraContactTokenError("wrong_channel");
  if (!equal(claims.rcpt, await recipientHash(params.gatewayKey, params.destination))) throw new NiadraContactTokenError("wrong_recipient");
  if (params.seen?.has(claims.jti)) throw new NiadraContactTokenError("replayed");
  return claims;
}

/** Compares two strings in time that does not depend on where they differ. */
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface GatewayOptions {
  space: string;
  /** The key the gateway shares with Niadra, base64url or bytes. */
  key: string | Uint8Array;
  /** Reads the space's key set; `keys` is a fixed set instead. */
  read?: () => Promise<ContactKeys>;
  keys?: readonly ContactKey[];
  seen?: SeenTokens;
  /** Seconds since the epoch; now by default. */
  clock?: () => number;
}

/**
 * A gateway's side of the contact token: its id, its space, the key it shares with Niadra, the space's public
 * keys and the tokens it already let through. A read of the keys that fails keeps the last set, however old: a
 * gateway never stops checking because Niadra is out of reach, and a token it cannot check is refused.
 */
export class ContactGateway {
  readonly space: string;
  private keySet: ContactKey[];
  private readAt: number | null = null;
  private missedAt = Number.NEGATIVE_INFINITY;
  private readonly seen: SeenTokens;
  private readonly clock: () => number;

  constructor(
    readonly gatewayId: string,
    private readonly options: GatewayOptions,
  ) {
    if (!NAME.test(gatewayId)) throw new TypeError("a gateway id matches ^[a-z][a-z0-9_]{0,39}$");
    if (typeof options.key === "string" && unb64(options.key) === null) throw new TypeError("the gateway key is not base64url");
    this.space = options.space.toLowerCase();
    this.keySet = [...(options.keys ?? [])];
    this.clock = options.clock ?? (() => Date.now() / 1000);
    this.seen = options.seen ?? new MemorySeen(this.clock);
  }

  get keys(): readonly ContactKey[] {
    return this.keySet;
  }

  /**
   * Checks a token for a message of `channel` to `destination` (canonical) or `handle`, and remembers it.
   * Rejects with `NiadraContactTokenError`.
   */
  async verify(token: string, params: { channel: string; destination?: string; handle?: Handle }): Promise<ContactClaims> {
    const destination = params.destination ?? (params.handle ? canonicalDestination(params.handle.type, params.handle.value) : null);
    if (destination === null) throw new TypeError("pass destination or handle");
    const now = this.clock();
    if (this.options.read && (this.readAt === null || (now - this.readAt) * 1000 >= KEYS_REFRESH_MS)) await this.refresh();
    try {
      return await this.check(token, destination, params.channel, now);
    } catch (error) {
      const stale = error instanceof NiadraContactTokenError && error.code === "unknown_key";
      if (!stale || !this.options.read || (now - this.missedAt) * 1000 < UNKNOWN_KID_REFRESH_MS) throw error;
    }
    this.missedAt = now;
    await this.refresh();
    return this.check(token, destination, params.channel, now);
  }

  /** Reads the key set again; `false` when that failed and the last set stays in use. */
  async refresh(): Promise<boolean> {
    if (!this.options.read) return false;
    this.readAt = this.clock();
    try {
      this.keySet = [...(await this.options.read()).keys];
      return true;
    } catch {
      return false;
    }
  }

  private async check(token: string, destination: string, channel: string, now: number): Promise<ContactClaims> {
    const claims = await verifyContactToken(token, {
      keys: this.keySet,
      gatewayId: this.gatewayId,
      space: this.space,
      gatewayKey: this.options.key,
      destination,
      channel,
      now,
    });
    if (!(await this.seen.add(claims.jti, claims.exp + LEEWAY))) throw new NiadraContactTokenError("replayed");
    return claims;
  }
}
