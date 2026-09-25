/**
 * Helpers for the webhook adapters (ElevenLabs, Vapi, WhatsApp, Twilio): signatures with Web
 * Crypto and header lookup. Only web APIs, so the handlers run on Node 20+, Deno, Bun, Cloudflare
 * Workers and the Vercel Edge Runtime alike.
 */

import type { Handle } from "../types/common.js";
import type { ContextStamp } from "../types/events.js";
import type { Verification } from "../types/vocabulary.js";

/**
 * What a call's first webhook learned, for the webhooks that come later in the same call (tool
 * calls, the end-of-call report): who the caller is, the level they proved and the context stamp.
 */
export interface CallRecord {
  subject: Handle;
  verification: Verification;
  stamp?: ContextStamp | null;
}

/**
 * Where the webhook adapters keep a `CallRecord` between requests, by the platform's call id.
 * The default lives in this process's memory; on serverless or several instances, pass one backed
 * by your key-value store.
 */
export interface CallStore {
  get(id: string): CallRecord | undefined | PromiseLike<CallRecord | undefined>;
  set(id: string, record: CallRecord): void | PromiseLike<void>;
}

/** An in-memory `CallStore` that keeps the most recent `max` calls. */
export function memoryCallStore(max = 10_000): CallStore {
  const calls = new Map<string, CallRecord>();
  return {
    get: (id) => calls.get(id),
    set: (id, record) => {
      calls.delete(id);
      calls.set(id, record);
      if (calls.size > max) {
        const oldest = calls.keys().next().value;
        if (oldest !== undefined) calls.delete(oldest);
      }
    },
  };
}

/** Request headers as a `Headers` object or a plain record (any case). */
export type HeadersLike = Headers | Record<string, string | string[] | undefined>;

/** What a handler answers: the HTTP status and a JSON-serializable body (`null` for no body). */
export interface WebhookResponse<B = unknown> {
  status: number;
  body: B;
}

export function header(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function subtle(): SubtleCrypto {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!crypto?.subtle) throw new Error("Web Crypto is not available on this runtime");
  return crypto.subtle;
}

const encoder = new TextEncoder();

export async function hmac(hash: "SHA-1" | "SHA-256", secret: string, message: string): Promise<Uint8Array> {
  const key = await subtle().importKey("raw", encoder.encode(secret), { name: "HMAC", hash }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", key, encoder.encode(message)));
}

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Compares two strings in time that depends only on their length. */
export function safeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/** The raw body as text, whatever form the framework hands it in. */
export function bodyText(body: string | Uint8Array | ArrayBuffer): string {
  if (typeof body === "string") return body;
  return new TextDecoder().decode(body instanceof Uint8Array ? body : new Uint8Array(body));
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
