/**
 * Turns what callers pass to `track()`, `identify()` and friends into batch items, applying the
 * same shape rules the server enforces. Catching a malformed event here means it is dropped
 * with a log line instead of occupying the queue and coming back as a 207 error.
 */

import { NiadraValidationError } from "./errors.js";
import { toObjectRef } from "./handles.js";
import { uuidv7 } from "./ids.js";
import type { Handle, ObjectRef, Subject } from "./types/common.js";
import {
  MAX_EVENT_TEXT,
  type ActionInfo,
  type Closes,
  type Content,
  type ContextStamp,
  type ConversationEndedItem,
  type EventItem,
  type FeedbackAction,
  type FeedbackRequest,
  type HandoffItem,
  type IdentifyItem,
  type ModelUsage,
  type SpeakerRef,
  type TaskEndedItem,
  type VerifyItem,
  type VoiceInfo,
} from "./types/events.js";
import type {
  AssertionMethod,
  EventKind,
  Speaker,
  SubjectKind,
  Verification,
  VerifyMethod,
  Visibility,
} from "./types/vocabulary.js";

/** An ISO 8601 string or a `Date`. */
export type Timestamp = string | Date;

/** Fields shared by everything `track()` records. */
interface EventBase {
  /** Where it happened, such as `whatsapp`, `voice`, `app` or `erp`. */
  channel: string;
  /** Provider message id, when there is one; otherwise the SDK mints a UUIDv7. */
  idempotency_key?: string;
  conversation_id?: string | null;
  /** Other ids the same conversation has in other systems. Up to 8. */
  conversation_aliases?: string[];
  task_id?: string | null;
  /** Up to 16. An event needs at least one handle, subject or object. */
  handles?: Handle[];
  /** Up to 8. */
  subjects?: Subject[];
  /** Up to 16. Accepts `type:namespace:id` strings. */
  object_refs?: (ObjectRef | string)[];
  /** Defaults to now. */
  occurred_at?: Timestamp;
  visibility?: Visibility;
  verification_hint?: Verification | null;
  corrects_event_id?: string | null;
  voice?: VoiceInfo | null;
  /**
   * Which context the agent acted on, for the agent's own turns and actions. Conversations and
   * tasks set it from `markInjected()`.
   */
  context_stamp?: ContextStamp | null;
}

/** An event for `track()`. `kind` defaults to `message`. */
export interface TrackEvent extends EventBase {
  kind?: EventKind;
  /** Who produced it. A bare role is shorthand for `{ role }`. */
  speaker: SpeakerRef | Speaker;
  /** Defaults to `inbound` for customer messages and `outbound` for agent messages. */
  direction?: "inbound" | "outbound" | null;
  content?: Content | null;
  /** Shorthand for `content: { type: "text", text }`. Cannot be combined with `content`. */
  text?: string;
  /** Required for `system_event`, such as `invoice.credited`. */
  canonical_type?: string | null;
  fields?: Record<string, unknown>;
  /** Required for `action`, and only valid there. */
  action?: ActionInfo | null;
  /** What the provider reported for the model call behind an `ai_agent` message; only valid there. */
  usage?: ModelUsage | null;
}

/** An agent action for `action()`: what an agent did in a system of record. */
export interface ActionEvent extends EventBase {
  /** Canonical operation, such as `credit` or `reschedule`. */
  operation: string;
  /** What happened, up to 2,000 characters. */
  result?: string | null;
  purpose?: string | null;
  /** The open item this action fulfils, which the server then marks resolved. */
  closes?: Closes | null;
  corrects_action_id?: string | null;
  /** Defaults to `ai_agent`. */
  speaker?: SpeakerRef | Speaker;
}

export interface IdentifyParams {
  /** Between 2 and 16 handles that belong to the same subject. */
  handles: Handle[];
  /** Defaults to `explicit_identify`. */
  method?: AssertionMethod;
  /** Defaults to `person`. */
  subject_kind?: SubjectKind;
  conversation_id?: string | null;
  occurred_at?: Timestamp;
  idempotency_key?: string;
}

export interface VerifyParams {
  /** The handle whose possession was proven. */
  handle: Handle;
  method: VerifyMethod;
  /** The level reached. It applies to this conversation or task only. */
  level: Verification;
  conversation_id?: string | null;
  task_id?: string | null;
  /** When the proof stops counting. */
  valid_until?: Timestamp | null;
  occurred_at?: Timestamp;
  idempotency_key?: string;
}

export interface HandoffParams {
  conversation_id: string;
  target: "human" | "agent";
  /** The source that takes over, when it is integrated with Niadra. */
  target_source?: string | null;
  reason?: string | null;
  /** `warm` when the receiver gets a briefing. Defaults to `warm`. */
  mode?: "warm" | "cold";
  occurred_at?: Timestamp;
  idempotency_key?: string;
}

/** Arguments of `feedback()`: a correction of what Niadra derived about a subject. */
export interface FeedbackParams {
  subject: Handle;
  /**
   * `retract_fact` or `correct_fact` (with `fact_id`, and `value` for the right one),
   * `resolve_open_item` (with `open_item_id`) or `conversation_outcome` (with `conversation_id`
   * and `value`).
   */
  action: FeedbackAction;
  fact_id?: string | null;
  open_item_id?: string | null;
  conversation_id?: string | null;
  /** Up to 2,000 characters. */
  value?: string | null;
  /** Why, up to 500 characters. */
  reason?: string | null;
  idempotency_key?: string;
}

const FEEDBACK_ACTIONS: readonly FeedbackAction[] = [
  "retract_fact",
  "correct_fact",
  "resolve_open_item",
  "conversation_outcome",
];

const SHORT = 256;

function fail(message: string): never {
  throw new NiadraValidationError(message);
}

function iso(value: Timestamp | undefined): string {
  if (value === undefined) return new Date().toISOString();
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail("invalid Date");
    return value.toISOString();
  }
  if (Number.isNaN(Date.parse(value))) fail("timestamps must be ISO 8601");
  return value;
}

function short(value: string | null | undefined, field: string): void {
  if (value === undefined || value === null) return;
  if (value.length === 0 || value.length > SHORT) fail(`${field} must be 1 to ${SHORT} characters`);
}

function limit(list: readonly unknown[] | undefined, max: number, field: string): void {
  if (list && list.length > max) fail(`${field} takes at most ${max} entries`);
}

function speakerRef(speaker: SpeakerRef | Speaker): SpeakerRef {
  return typeof speaker === "string" ? { role: speaker } : speaker;
}

function checkCloses(closes: Closes | null | undefined): void {
  if (!closes) return;
  const byId = Boolean(closes.item_id);
  const byObject = Boolean(closes.object && closes.operation);
  if (byId === byObject) fail("closes takes either item_id, or object and operation");
}

function checkUsage(usage: ModelUsage): void {
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(usage.provider)) fail("usage.provider must be lowercase, like `openai`");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}$/.test(usage.model)) fail("usage.model is not a model name");
  const counts = [usage.prompt_tokens, usage.cached_tokens ?? 0, usage.cache_write_tokens ?? 0];
  if (!counts.every((n) => Number.isInteger(n) && n >= 0)) fail("usage counts are whole numbers from 0");
  if ((usage.cached_tokens ?? 0) + (usage.cache_write_tokens ?? 0) > usage.prompt_tokens) {
    fail("cached and written tokens are part of prompt_tokens");
  }
}

function checkContent(content: Content | null | undefined): void {
  if (!content) return;
  if ((content.text?.length ?? 0) > MAX_EVENT_TEXT) fail(`content.text is longer than ${MAX_EVENT_TEXT}`);
  if ((content.transcript?.length ?? 0) > MAX_EVENT_TEXT) {
    fail(`content.transcript is longer than ${MAX_EVENT_TEXT}`);
  }
}

/** Builds the wire event and checks it against the server's shape rules. */
export function buildEvent(input: TrackEvent): EventItem {
  if (input.text !== undefined && input.content) fail("pass `text` or `content`, not both");
  const kind: EventKind = input.kind ?? "message";
  const speaker = speakerRef(input.speaker);
  const content: Content | null =
    input.text !== undefined ? { type: "text", text: input.text } : (input.content ?? null);

  short(input.channel, "channel");
  checkContent(content);
  limit(input.handles, 16, "handles");
  limit(input.subjects, 8, "subjects");
  limit(input.object_refs, 16, "object_refs");
  limit(input.conversation_aliases, 8, "conversation_aliases");
  if (kind === "action" && !input.action) fail("an action event needs the `action` block");
  if (kind !== "action" && input.action) fail("`action` is only valid when kind is `action`");
  if (kind === "system_event" && !input.canonical_type) fail("a system event needs `canonical_type`");
  if (kind === "message" && !(content?.text || content?.media_ref || content?.transcript)) {
    fail("a message needs text, a transcript or a media reference");
  }
  if (!hasTarget(input)) fail("an event needs at least one handle, subject or object");
  if (input.action) {
    short(input.action.operation, "action.operation");
    if ((input.action.result?.length ?? 0) > 2000) fail("action.result is longer than 2000");
    checkCloses(input.action.closes);
  }
  if (input.usage) {
    if (kind !== "message" || speaker.role !== "ai_agent") fail("`usage` is only valid on a message of the `ai_agent`");
    checkUsage(input.usage);
  }

  const event: EventItem = {
    type: "event",
    kind,
    idempotency_key: input.idempotency_key ?? uuidv7(),
    channel: input.channel,
    speaker,
    occurred_at: iso(input.occurred_at),
  };
  if (content) event.content = content;
  const direction = input.direction ?? (kind === "message" ? defaultDirection(speaker.role) : undefined);
  if (direction) event.direction = direction;
  if (input.object_refs) event.object_refs = input.object_refs.map(toObjectRef);
  if (input.canonical_type) event.canonical_type = input.canonical_type;
  if (input.fields) event.fields = input.fields;
  if (input.action) event.action = input.action;
  if (input.usage) event.usage = input.usage;
  copyOptional(event, input);
  assertSerializable(event);
  return event;
}

/** Builds an `action` event: `track()` with `kind: "action"` and the action block filled in. */
export function buildAction(input: ActionEvent): EventItem {
  const { operation, result, purpose, closes, corrects_action_id, speaker, ...base } = input;
  const action: ActionInfo = { operation };
  if (result !== undefined) action.result = result;
  if (purpose !== undefined) action.purpose = purpose;
  if (closes !== undefined) action.closes = closes;
  if (corrects_action_id !== undefined) action.corrects_action_id = corrects_action_id;
  return buildEvent({ ...base, kind: "action", speaker: speaker ?? "ai_agent", action });
}

export function buildIdentify(input: IdentifyParams): IdentifyItem {
  if (input.handles.length < 2 || input.handles.length > 16) fail("identify takes 2 to 16 handles");
  const item: IdentifyItem = {
    type: "identify",
    idempotency_key: input.idempotency_key ?? uuidv7(),
    handles: input.handles,
    method: input.method ?? "explicit_identify",
    subject_kind: input.subject_kind ?? "person",
    occurred_at: iso(input.occurred_at),
  };
  if (input.conversation_id) item.conversation_id = input.conversation_id;
  return item;
}

export function buildVerify(input: Omit<VerifyParams, "handle"> & { handle: Handle | undefined }): VerifyItem {
  if (!input.handle) fail("verify needs the handle whose possession was proven");
  if (input.conversation_id && input.task_id) fail("pass `conversation_id` or `task_id`, not both");
  const item: VerifyItem = {
    type: "verify",
    idempotency_key: input.idempotency_key ?? uuidv7(),
    method: input.method,
    level: input.level,
    handle: input.handle,
    occurred_at: iso(input.occurred_at),
  };
  if (input.conversation_id) item.conversation_id = input.conversation_id;
  if (input.task_id) item.task_id = input.task_id;
  if (input.valid_until) item.valid_until = iso(input.valid_until);
  return item;
}

export function buildHandoff(input: HandoffParams): HandoffItem {
  short(input.conversation_id, "conversation_id");
  const item: HandoffItem = {
    type: "handoff",
    idempotency_key: input.idempotency_key ?? uuidv7(),
    conversation_id: input.conversation_id,
    target: input.target,
    mode: input.mode ?? "warm",
    occurred_at: iso(input.occurred_at),
  };
  if (input.target_source) item.target_source = input.target_source;
  if (input.reason) item.reason = input.reason;
  return item;
}

export function buildFeedback(input: FeedbackParams): FeedbackRequest {
  if (!FEEDBACK_ACTIONS.includes(input.action)) fail(`action must be one of ${FEEDBACK_ACTIONS.join(", ")}`);
  if ((input.value?.length ?? 0) > 2000) fail("value is longer than 2000");
  if ((input.reason?.length ?? 0) > 500) fail("reason is longer than 500");
  const request: FeedbackRequest = {
    idempotency_key: input.idempotency_key ?? uuidv7(),
    subject: input.subject,
    action: input.action,
  };
  if (input.fact_id) request.fact_id = input.fact_id;
  if (input.open_item_id) request.open_item_id = input.open_item_id;
  if (input.conversation_id) request.conversation_id = input.conversation_id;
  if (input.value) request.value = input.value;
  if (input.reason) request.reason = input.reason;
  return request;
}

export function buildConversationEnded(conversationId: string): ConversationEndedItem {
  return {
    type: "conversation.ended",
    idempotency_key: uuidv7(),
    conversation_id: conversationId,
    occurred_at: iso(undefined),
  };
}

export function buildTaskEnded(taskId: string): TaskEndedItem {
  return { type: "task.ended", idempotency_key: uuidv7(), task_id: taskId, occurred_at: iso(undefined) };
}

/** Whether an event names who or what it is about. */
export function hasTarget(event: {
  handles?: readonly unknown[] | undefined;
  subjects?: readonly unknown[] | undefined;
  object_refs?: readonly unknown[] | undefined;
}): boolean {
  return [event.handles, event.subjects, event.object_refs].some((list) => (list?.length ?? 0) > 0);
}

function defaultDirection(role: Speaker): "inbound" | "outbound" | undefined {
  if (role === "customer") return "inbound";
  if (role === "ai_agent" || role === "human_agent") return "outbound";
  return undefined;
}

function copyOptional(event: EventItem, input: EventBase): void {
  if (input.conversation_id) event.conversation_id = input.conversation_id;
  if (input.conversation_aliases?.length) event.conversation_aliases = input.conversation_aliases;
  if (input.task_id) event.task_id = input.task_id;
  if (input.handles?.length) event.handles = input.handles;
  if (input.subjects?.length) event.subjects = input.subjects;
  if (input.visibility) event.visibility = input.visibility;
  if (input.verification_hint) event.verification_hint = input.verification_hint;
  if (input.corrects_event_id) event.corrects_event_id = input.corrects_event_id;
  if (input.voice) event.voice = input.voice;
  if (input.context_stamp) {
    const { etag, injected_at } = input.context_stamp;
    event.context_stamp = etag ? { etag, injected_at: iso(injected_at) } : { injected_at: iso(injected_at) };
  }
}

/** `fields` can hold anything; a value JSON cannot encode would poison the whole batch. */
function assertSerializable(event: EventItem): void {
  try {
    JSON.stringify(event);
  } catch {
    fail("event is not JSON-serializable (check `fields` for BigInt or circular values)");
  }
}
