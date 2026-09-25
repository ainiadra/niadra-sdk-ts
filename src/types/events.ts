/**
 * The write side: items of `POST /v1/batch`. A batch mixes item types, and one bad item never
 * fails the batch; the server answers 207 with one error per rejected item.
 */

import type { Handle, ObjectRef, Subject } from "./common.js";
import type {
  AssertionMethod,
  EventKind,
  Speaker,
  SubjectKind,
  Verification,
  VerifyMethod,
  Visibility,
} from "./vocabulary.js";

/** Longest text the server accepts in `content.text` or `content.transcript`. */
export const MAX_EVENT_TEXT = 200_000;

/** Largest batch the server accepts. */
export const MAX_BATCH_ITEMS = 500;

/** Largest file `POST /v1/media/uploads` reserves room for: 500 MiB. */
export const MAX_MEDIA_BYTES = 500 * 1024 * 1024;

export interface SpeakerRef {
  role: Speaker;
  /** Agent or attendant id inside the source. */
  id?: string | null;
}

export interface Content {
  type?: "text" | "audio" | "image" | "file";
  text?: string | null;
  /** Reference returned by `/v1/media/uploads`; the media itself never travels in the event. */
  media_ref?: string | null;
  /** Lowercase hex SHA-256 of the media. */
  media_sha256?: string | null;
  transcript?: string | null;
  /** Speech-to-text confidence between 0 and 1. Low-confidence agent turns are not measured. */
  stt_confidence?: number | null;
}

export interface VoiceInfo {
  ani?: string | null;
  dnis?: string | null;
  trunk?: string | null;
  network_attestation?: "A" | "B" | "C" | null;
  answered_at?: string | null;
  ended_at?: string | null;
  end_reason?: string | null;
  recording_ref?: string | null;
  turn_offset_ms?: number | null;
}

/**
 * The open item an action fulfils. Pass either `item_id`, or `object` together with the
 * canonical `operation`; the server rejects any other combination.
 */
export interface Closes {
  item_id?: string | null;
  object?: ObjectRef | null;
  operation?: string | null;
}

export interface ActionInfo {
  /** Canonical operation, such as `credit` or `reschedule`. */
  operation: string;
  /** What happened, up to 2,000 characters. */
  result?: string | null;
  purpose?: string | null;
  closes?: Closes | null;
  corrects_action_id?: string | null;
}

/**
 * Which context the agent's prompt carried and when it went in. Set on the agent's own turns
 * and actions, so measurement can tell a context that arrived after the agent spoke from one
 * it had and did not use.
 */
export interface ContextStamp {
  /** The etag of the pack in the prompt; absent when the prompt carried no pack. */
  etag?: string | null;
  injected_at: string;
}

/**
 * What the model provider reported for the call behind an agent's turn. `wrap()` reads it from every
 * call it sees; without `wrap()`, pass it with the turn: `agent(text, { usage: response })` takes an
 * OpenAI or Anthropic response or a `ModelUsage`.
 */
export interface ModelUsage {
  /** Who served the call, lowercase: `openai`, `anthropic`, a router or a cloud. */
  provider: string;
  /** The model the provider says answered, such as `gpt-4.1-2025-04-14`. */
  model: string;
  /** Every input token, cached ones included. */
  prompt_tokens: number;
  /** Input tokens read from the provider's prompt cache. */
  cached_tokens?: number;
  /** Input tokens written to the cache (Anthropic's cache creation). */
  cache_write_tokens?: number;
}

/** A message, a system event or an agent action, exactly as sent on the wire. */
export interface EventItem {
  type: "event";
  kind: EventKind;
  idempotency_key: string;
  channel: string;
  conversation_id?: string | null;
  conversation_aliases?: string[];
  task_id?: string | null;
  handles?: Handle[];
  subjects?: Subject[];
  object_refs?: ObjectRef[];
  speaker: SpeakerRef;
  direction?: "inbound" | "outbound" | null;
  content?: Content | null;
  occurred_at: string;
  visibility?: Visibility;
  verification_hint?: Verification | null;
  /** System events only, such as `invoice.credited`. */
  canonical_type?: string | null;
  /** Structured fields of a system event. */
  fields?: Record<string, unknown>;
  action?: ActionInfo | null;
  corrects_event_id?: string | null;
  voice?: VoiceInfo | null;
  context_stamp?: ContextStamp | null;
  /** The model call behind an `ai_agent` message: tokens and prompt cache. */
  usage?: ModelUsage | null;
  /**
   * Until when what this event states holds, such as an offer valid until a date. After it, the
   * facts the event gave leave the pack and the history unless a read asks for expired items.
   */
  valid_until?: string | null;
}

/** States that several handles belong to the same subject. */
export interface IdentifyItem {
  type: "identify";
  idempotency_key: string;
  /** Between 2 and 16 handles. */
  handles: Handle[];
  method: AssertionMethod;
  subject_kind: SubjectKind;
  conversation_id?: string | null;
  occurred_at: string;
}

/** Raises the verification level of one conversation or task. The server never infers it. */
export interface VerifyItem {
  type: "verify";
  idempotency_key: string;
  method: VerifyMethod;
  level: Verification;
  conversation_id?: string | null;
  task_id?: string | null;
  handle: Handle;
  valid_until?: string | null;
  occurred_at: string;
}

export interface ConversationEndedItem {
  type: "conversation.ended";
  idempotency_key: string;
  conversation_id: string;
  occurred_at: string;
}

export interface TaskEndedItem {
  type: "task.ended";
  idempotency_key: string;
  task_id: string;
  occurred_at: string;
}

/** A transfer to a human or another agent. */
export interface HandoffItem {
  type: "handoff";
  idempotency_key: string;
  conversation_id: string;
  target: "human" | "agent";
  target_source?: string | null;
  reason?: string | null;
  mode: "warm" | "cold";
  occurred_at: string;
}

/** Periodic counter the SDK sends so the server can tell a quiet source from a broken one. */
export interface HeartbeatItem {
  type: "heartbeat";
  window_start: string;
  sent: number;
}

export type BatchItem =
  | EventItem
  | IdentifyItem
  | VerifyItem
  | ConversationEndedItem
  | TaskEndedItem
  | HandoffItem
  | HeartbeatItem;

export interface BatchRequest {
  items: BatchItem[];
}

export interface ItemError {
  /** Position of the rejected item in the batch that was sent. */
  index: number;
  code: string;
  detail?: string | null;
}

export interface BatchResponse {
  accepted: number;
  duplicates: number;
  errors: ItemError[];
}

/** Body of `POST /v1/media/uploads`. */
export interface MediaUploadRequest {
  content_type: string;
  /** Between 1 byte and 500 MiB. */
  size_bytes: number;
  /** Lowercase hex SHA-256 of the bytes. */
  sha256: string;
  /** Whose media it is. Stored under that person, so erasing them erases it too. */
  subject?: Handle | null;
}

/** Where to send the bytes: a short-lived signed URL, and the reference events carry afterwards. */
export interface MediaUploadResponse {
  media_ref: string;
  upload_url: string;
  /** Send exactly these headers with the bytes; the store refuses anything else. */
  upload_headers?: Record<string, string>;
  expires_at: string;
}

export type FeedbackAction = "retract_fact" | "correct_fact" | "resolve_open_item" | "conversation_outcome";

/** Body of `POST /v1/feedback`. The server records it as a `feedback.<action>` system event. */
export interface FeedbackRequest {
  idempotency_key: string;
  subject: Handle;
  action: FeedbackAction;
  fact_id?: string | null;
  open_item_id?: string | null;
  conversation_id?: string | null;
  /** Up to 2,000 characters. */
  value?: string | null;
  /** Up to 500 characters. */
  reason?: string | null;
}
