/**
 * Niadra for the WhatsApp Cloud API (Meta). Translates only: it checks and reads Meta's webhook,
 * gives you each inbound message with the customer's handle and the turn ready to record, and
 * records the agent's turn from the send API's answer. It never sends a message.
 *
 * @example
 * const { status, messages } = await readWhatsApp(await request.text(), request.headers, { appSecret });
 * for (const inbound of messages) {
 *   const convo = niadra.conversation({ subject: inbound.subject, channel: "whatsapp", conversation_id: yourThreadId });
 *   recordInbound(convo, inbound);
 *   const ctx = await convo.context();
 *   ...
 *   recordOutbound(convo, reply, await sendResponse.json());
 * }
 */

import type { Conversation } from "../conversation.js";
import { handles } from "../handles.js";
import type { Handle } from "../types/common.js";
import type { Content } from "../types/events.js";
import { errorName, isRecord } from "./shared.js";
import { bodyText, header, hex, hmac, parseJson, safeEqual } from "./webhook.js";
import type { HeadersLike, WebhookResponse } from "./webhook.js";

export type { HeadersLike, WebhookResponse } from "./webhook.js";

/** A media attachment as Meta reports it. Download it with the Graph API, then `niadra.uploadMedia()`. */
export interface WhatsAppMedia {
  /** Meta's media id. */
  id: string;
  mimeType?: string | undefined;
  filename?: string | undefined;
}

/** One inbound message, read from the webhook. */
export interface WhatsAppInbound {
  /** The customer, as `wa_id`. */
  subject: Handle;
  waId: string;
  /** The name on the customer's WhatsApp profile, when Meta sends it. */
  profileName?: string | undefined;
  /** Your business number that received the message. */
  phoneNumberId: string;
  /** Meta's message id (`wamid...`): the idempotency key of the turn. */
  messageId: string;
  /** Meta's message type: `text`, `image`, `audio`, `document`, `interactive`, ... */
  type: string;
  /** The text of the message, the caption of media, or the title of a button or list reply. */
  text: string;
  media?: WhatsAppMedia | undefined;
  occurredAt?: Date | undefined;
  /** The message this one replies to, when it is a reply. */
  replyTo?: string | undefined;
}

export interface ReadResult extends WebhookResponse<null> {
  /** The inbound messages, empty for status updates and for requests that fail the signature. */
  messages: WhatsAppInbound[];
}

const MEDIA = new Set(["image", "audio", "video", "document", "sticker", "voice"]);
const CONTENT: Record<string, Content["type"]> = { image: "image", sticker: "image", audio: "audio", voice: "audio", video: "file", document: "file" };

/** Checks `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body with the app secret>`. */
export async function validWhatsAppSignature(rawBody: string | Uint8Array | ArrayBuffer, signature: string | undefined, appSecret: string): Promise<boolean> {
  if (!signature || !appSecret || !signature.startsWith("sha256=")) return false;
  const expected = `sha256=${hex(await hmac("SHA-256", appSecret, bodyText(rawBody)))}`;
  return safeEqual(signature.toLowerCase(), expected);
}

/**
 * Answers Meta's subscription check (`GET` with `hub.mode`, `hub.verify_token`, `hub.challenge`):
 * the challenge when the token matches, 403 otherwise.
 */
export function whatsAppChallenge(query: URLSearchParams | Record<string, string | undefined>, verifyToken: string): WebhookResponse<string> {
  const get = (name: string): string | undefined =>
    query instanceof URLSearchParams ? (query.get(name) ?? undefined) : query[name];
  const token = get("hub.verify_token");
  const challenge = get("hub.challenge");
  if (get("hub.mode") === "subscribe" && token !== undefined && verifyToken && safeEqual(token, verifyToken) && challenge) {
    return { status: 200, body: challenge };
  }
  return { status: 403, body: "" };
}

/**
 * Checks the signature and reads every inbound message of a webhook delivery. Answer Meta with
 * `status` at once (200, or 401 for a bad signature); a delivery that fails is not read.
 */
export async function readWhatsApp(
  rawBody: string | Uint8Array | ArrayBuffer,
  headers: HeadersLike,
  options: { appSecret: string },
): Promise<ReadResult> {
  const text = bodyText(rawBody);
  if (!(await validWhatsAppSignature(text, header(headers, "x-hub-signature-256"), options.appSecret))) {
    return { status: 401, body: null, messages: [] };
  }
  return { status: 200, body: null, messages: parseWhatsApp(parseJson(text)) };
}

/** Reads the inbound messages of an already verified webhook payload. */
export function parseWhatsApp(payload: unknown): WhatsAppInbound[] {
  const messages: WhatsAppInbound[] = [];
  const entries = isRecord(payload) && Array.isArray(payload.entry) ? (payload.entry as unknown[]) : [];
  for (const entry of entries) {
    const changes = isRecord(entry) && Array.isArray(entry.changes) ? (entry.changes as unknown[]) : [];
    for (const change of changes) {
      const value = isRecord(change) && isRecord(change.value) ? change.value : null;
      if (!value || !Array.isArray(value.messages)) continue;
      const phoneNumberId = isRecord(value.metadata) ? str(value.metadata.phone_number_id) : undefined;
      const names = new Map<string, string>();
      for (const contact of Array.isArray(value.contacts) ? (value.contacts as unknown[]) : []) {
        const waId = isRecord(contact) ? str(contact.wa_id) : undefined;
        const name = isRecord(contact) && isRecord(contact.profile) ? str(contact.profile.name) : undefined;
        if (waId && name) names.set(waId, name);
      }
      for (const message of value.messages as unknown[]) {
        const inbound = isRecord(message) && phoneNumberId ? readMessage(message, phoneNumberId, names) : null;
        if (inbound) messages.push(inbound);
      }
    }
  }
  return messages;
}

/**
 * Records an inbound message as the customer's turn, with Meta's message id as the idempotency key,
 * so a redelivered webhook is harmless. For media, pass what `niadra.uploadMedia()` returned.
 */
export function recordInbound(
  conversation: Conversation,
  inbound: WhatsAppInbound,
  media?: { media_ref: string; media_sha256?: string | undefined },
): string | null {
  try {
    const kind = CONTENT[inbound.type];
    if (media && kind) {
      return conversation.track({
        speaker: "customer",
        idempotency_key: inbound.messageId,
        ...(inbound.occurredAt ? { occurred_at: inbound.occurredAt } : {}),
        content: {
          type: kind,
          media_ref: media.media_ref,
          ...(media.media_sha256 ? { media_sha256: media.media_sha256 } : {}),
          ...(inbound.text ? { text: inbound.text } : {}),
        },
      });
    }
    if (!inbound.text) return null;
    return conversation.customer(inbound.text, {
      idempotency_key: inbound.messageId,
      ...(inbound.occurredAt ? { occurred_at: inbound.occurredAt } : {}),
    });
  } catch (error) {
    conversation.logger.warn(`could not record the WhatsApp message (${errorName(error)})`);
    return null;
  }
}

/**
 * Records the agent's turn after the send API accepted it, with the `wamid` Meta returned as the
 * idempotency key. `response` is the JSON of `POST /{phone_number_id}/messages`.
 */
export function recordOutbound(conversation: Conversation, text: string, response?: unknown): string | null {
  try {
    const messages = isRecord(response) && Array.isArray(response.messages) ? (response.messages as unknown[]) : [];
    const id = isRecord(messages[0]) ? str(messages[0].id) : undefined;
    return conversation.agent(text, id ? { idempotency_key: id } : {});
  } catch (error) {
    conversation.logger.warn(`could not record the agent's WhatsApp message (${errorName(error)})`);
    return null;
  }
}

function readMessage(message: Record<PropertyKey, unknown>, phoneNumberId: string, names: Map<string, string>): WhatsAppInbound | null {
  const waId = str(message.from);
  const id = str(message.id);
  const type = str(message.type) ?? "unknown";
  if (!waId || !id) return null;
  let text = "";
  let media: WhatsAppMedia | undefined;
  const body = message[type];
  if (type === "text" && isRecord(body)) text = str(body.body) ?? "";
  else if (type === "button" && isRecord(body)) text = str(body.text) ?? "";
  else if (type === "interactive" && isRecord(body)) {
    const reply = isRecord(body.button_reply) ? body.button_reply : isRecord(body.list_reply) ? body.list_reply : null;
    text = reply ? (str(reply.title) ?? "") : "";
  } else if (MEDIA.has(type) && isRecord(body)) {
    const mediaId = str(body.id);
    text = str(body.caption) ?? "";
    if (mediaId) media = { id: mediaId, mimeType: str(body.mime_type), filename: str(body.filename) };
  }
  const seconds = Number(message.timestamp);
  const context = isRecord(message.context) ? str(message.context.id) : undefined;
  return {
    subject: handles.waId(waId),
    waId,
    profileName: names.get(waId),
    phoneNumberId,
    messageId: id,
    type,
    text,
    media,
    occurredAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : undefined,
    replyTo: context,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
