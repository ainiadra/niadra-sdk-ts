/**
 * Niadra for Twilio webhooks: Programmable Voice, Messaging (SMS and WhatsApp) and Conversations.
 * Translates only: it checks `X-Twilio-Signature`, finds the customer's handle, the call or thread
 * id and what the carrier attested, and records the inbound turn. It never answers with TwiML.
 *
 * @example
 * const { status, request } = await readTwilio(publicUrl, await req.text(), req.headers, { authToken });
 * const convo = niadra.conversation({ subject: request.subject, channel: request.channel, conversation_id: request.conversationId });
 * await verifyTwilio(convo, request);   // StirVerstat on voice
 * recordTwilioInbound(convo, request);
 */

import type { Conversation } from "../conversation.js";
import { handles } from "../handles.js";
import type { Handle } from "../types/common.js";
import { attestationProof, errorName, phoneHandle } from "./shared.js";
import type { Proof } from "./shared.js";
import { base64, bodyText, header, hmac, safeEqual } from "./webhook.js";
import type { HeadersLike } from "./webhook.js";

export { attestationProof } from "./shared.js";
export type { Proof } from "./shared.js";
export type { HeadersLike } from "./webhook.js";

/** One Twilio webhook request, read. */
export interface TwilioRequest {
  /** `voice`, `whatsapp`, `sms` or `conversations`, usable as the Niadra channel. */
  channel: "voice" | "whatsapp" | "sms" | "conversations";
  /** The customer: `WaId` on WhatsApp, else the phone number on the customer's side of the call or message. */
  subject: Handle;
  /** `CallSid` on voice, `ConversationSid` on Conversations; messages leave the thread id to you. */
  conversationId?: string | undefined;
  /** `MessageSid`: the idempotency key of the turn. */
  messageId?: string | undefined;
  /** The message body, or the speech recognized by `<Gather input="speech">`. */
  text?: string | undefined;
  /** Speech confidence from `<Gather>`, between 0 and 1. */
  confidence?: number | undefined;
  /** What the carrier attested (`StirVerstat`), as a proof for `verify()`; `null` when nothing was proven. */
  proof: Proof | null;
  /** Every parameter Twilio sent. */
  params: Record<string, string>;
}

/**
 * Checks `X-Twilio-Signature`: base64 HMAC-SHA1, with the auth token, of the full URL Twilio called
 * followed by every POST parameter, sorted by name, as name and value.
 */
export async function validTwilioSignature(
  url: string,
  params: URLSearchParams | Record<string, string>,
  signature: string | undefined,
  authToken: string,
): Promise<boolean> {
  if (!signature || !authToken) return false;
  const pairs = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
  pairs.sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  const data = url + pairs.map(([key, value]) => key + value).join("");
  return safeEqual(signature, base64(await hmac("SHA-1", authToken, data)));
}

/**
 * Checks the signature of a form-encoded Twilio webhook and reads it. `url` is the exact public URL
 * Twilio called, query string included (behind a proxy, not the one your server sees).
 */
export async function readTwilio(
  url: string,
  rawBody: string | Uint8Array | ArrayBuffer,
  headers: HeadersLike,
  options: { authToken: string },
): Promise<{ status: number; request: TwilioRequest | null }> {
  const params = new URLSearchParams(bodyText(rawBody));
  if (!(await validTwilioSignature(url, params, header(headers, "x-twilio-signature"), options.authToken))) {
    return { status: 403, request: null };
  }
  return { status: 200, request: parseTwilio(params) };
}

/** Reads the parameters of an already verified request; `null` when no customer can be found. */
export function parseTwilio(params: URLSearchParams | Record<string, string>): TwilioRequest | null {
  const all: Record<string, string> = params instanceof URLSearchParams ? Object.fromEntries(params.entries()) : { ...params };
  const get = (name: string): string | undefined => {
    const value = all[name];
    return value === "" ? undefined : value;
  };
  const outbound = get("Direction")?.startsWith("outbound") ?? false;
  const other = outbound ? get("To") : get("From");
  const text = get("Body") ?? get("SpeechResult");
  const confidence = Number(get("Confidence"));
  const base = {
    messageId: get("MessageSid"),
    text,
    confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 && get("SpeechResult") ? confidence : undefined,
    proof: attestationProof(get("StirVerstat")),
    params: all,
  };

  if (get("ConversationSid")) {
    const author = get("Author");
    const subject = author ? (phoneHandle(author.replace(/^whatsapp:/, "")) ?? handles.appUserId(author)) : null;
    return subject ? { ...base, channel: "conversations", subject, conversationId: get("ConversationSid") } : null;
  }
  if (other?.startsWith("whatsapp:")) {
    const waId = get("WaId");
    const subject = waId ? handles.waId(waId) : phoneHandle(other.slice("whatsapp:".length));
    return subject ? { ...base, channel: "whatsapp", subject } : null;
  }
  const subject = phoneHandle(other);
  if (!subject) return null;
  if (get("CallSid") && !get("MessageSid")) return { ...base, channel: "voice", subject, conversationId: get("CallSid") };
  return { ...base, channel: "sms", subject };
}

/** Records what the carrier attested for the call, before the first context read. Never rejects. */
export async function verifyTwilio(conversation: Conversation, request: TwilioRequest): Promise<void> {
  if (!request.proof) return;
  try {
    await conversation.verify(request.proof);
  } catch (error) {
    conversation.logger.warn(`could not record the verification (${errorName(error)})`);
  }
}

/** Records the inbound text or speech as the customer's turn, keyed by `MessageSid` when there is one. */
export function recordTwilioInbound(conversation: Conversation, request: TwilioRequest): string | null {
  if (!request.text) return null;
  try {
    return conversation.customer(request.text, {
      ...(request.messageId ? { idempotency_key: request.messageId } : {}),
      ...(request.confidence !== undefined ? { stt_confidence: request.confidence } : {}),
    });
  } catch (error) {
    conversation.logger.warn(`could not record the Twilio message (${errorName(error)})`);
    return null;
  }
}
