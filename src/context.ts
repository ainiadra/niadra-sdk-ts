import { NiadraValidationError } from "./errors.js";
import type { NiadraError } from "./errors.js";
import { toObjectRef } from "./handles.js";
import type { Handle, ObjectRef } from "./types/common.js";
import type { ContextRequest, ContextResponse, LiveTurn, TargetModel } from "./types/context.js";
import type { Verification, View } from "./types/vocabulary.js";

/** Arguments of `context()`. Pass exactly one of `subject` or `object`. */
export interface ContextParams {
  /** The customer, by any handle the server knows. */
  subject?: Handle;
  /** A business object, such as an invoice, when the task is about the object rather than a person. */
  object?: ObjectRef | string;
  /** The account or partner the person acts for. Requires an active link between the two. */
  about?: Handle;
  /** Defaults to `chat`. */
  view?: View;
  /**
   * The level proven in this conversation. The server may answer with a lower effective level
   * when the source's ceiling is lower; see `response.verification`.
   */
  verification?: Verification;
  /** Enables the per-conversation cache and the server's pinning of the pack. */
  conversation_id?: string;
  /** For internal agents: the task plays the role of the conversation. */
  task_id?: string;
  /** What the turn is about, so selection can favour relevant history. Up to 2,000 characters. */
  query?: string;
  /** Ask only for what changed since this source last read the subject. */
  delta?: boolean;
  /** The model that will read the pack, so the server can size it for that model's prompt cache. */
  target?: TargetModel;
}

/** Per-call options shared by every read method. */
export interface RequestOptions {
  /** Overrides the method's default time budget, in milliseconds. */
  timeout?: number | undefined;
  /** Cancels the wait. A request shared with other callers keeps running for them. */
  signal?: AbortSignal | undefined;
  /** Extra headers, such as a W3C `traceparent`. */
  headers?: Record<string, string> | undefined;
}

export interface ContextOptions extends RequestOptions {
  /** Pass `false` to skip the per-conversation cache for this call. */
  cache?: boolean | undefined;
}

/**
 * Where a `context()` result came from.
 *
 * - `network`: a response the server just sent (or confirmed unchanged).
 * - `cache`: a pack younger than the cache TTL; no request was made.
 * - `stale`: an older pack returned at once while a background request refreshes it.
 * - `fallback`: the request failed and this is the last good pack for the conversation.
 * - `none`: nothing was available; `text` is empty and `error` says why.
 */
export type ContextSource = "network" | "cache" | "stale" | "fallback" | "none";

/** What `context()` resolves to. Always usable: on failure `text` is an empty string. */
export interface ContextResult {
  /** The pack, ready for the system prompt. Empty when there is nothing to inject. */
  text: string;
  /**
   * The parts that change turn by turn and belong at the end of the prompt, after the
   * conversation: the delta and the live turns from other channels. Empty when there are none.
   */
  suffix: string;
  /** Named values from the pack, for templates that place them individually. */
  variables: Record<string, string>;
  source: ContextSource;
  /** The response this result was built from; `null` when `source` is `none`. */
  response: ContextResponse | null;
  /** What went wrong, when `source` is `fallback` or `none`. */
  error: NiadraError | null;
}

const VIEW = /^(voice|chat|brief|full|custom|account|partner|task:[a-z0-9_]{1,40})$/;
const MAX_QUERY = 2000;

/** Validates the arguments and builds the wire request, without `known_etag`. */
export function buildContextRequest(params: ContextParams): ContextRequest {
  if ((params.subject === undefined) === (params.object === undefined)) {
    throw new NiadraValidationError("pass exactly one of `subject` or `object`");
  }
  if (params.conversation_id && params.task_id) {
    throw new NiadraValidationError("pass `conversation_id` or `task_id`, not both");
  }
  if (params.view !== undefined && !VIEW.test(params.view)) {
    throw new NiadraValidationError("unknown view; task views look like `task:billing`");
  }
  if (params.query !== undefined && params.query.length > MAX_QUERY) {
    throw new NiadraValidationError(`query is longer than ${MAX_QUERY} characters`);
  }

  const request: ContextRequest = { view: params.view ?? "chat" };
  if (params.subject) request.subject = params.subject;
  if (params.object !== undefined) request.object = toObjectRef(params.object);
  if (params.about) request.about = params.about;
  if (params.verification) request.verification = params.verification;
  if (params.conversation_id) request.conversation_id = params.conversation_id;
  if (params.task_id) request.task_id = params.task_id;
  if (params.query) request.query = params.query;
  if (params.delta) request.delta = true;
  if (params.target) request.target = params.target;
  return request;
}

/** Packs are only cached inside a conversation or task, the unit the server pins them to. */
export function cacheScope(request: ContextRequest): string | null {
  if (request.conversation_id) return `conversation:${request.conversation_id}`;
  if (request.task_id) return `task:${request.task_id}`;
  return null;
}

/**
 * Every field that changes what the server would compile goes into the key, in a fixed order.
 * `delta` does not: a plain read and a delta read of one conversation get the same pinned
 * bytes, so they share one entry.
 */
export function cacheKey(request: ContextRequest): string {
  return JSON.stringify([
    request.subject ?? null,
    request.object ?? null,
    request.about ?? null,
    request.view ?? "chat",
    request.verification ?? "V0",
    request.conversation_id ?? null,
    request.task_id ?? null,
    request.query ?? null,
    request.target ?? null,
  ]);
}

/**
 * Applies a `not_modified` answer to the cached pack: the pinned text and its metadata stay,
 * while the parts outside the pin (live turns, delta, coverage, timing) come from the new answer.
 */
export function mergeNotModified(cached: ContextResponse, fresh: ContextResponse): ContextResponse {
  return {
    ...fresh,
    not_modified: false,
    text: cached.text ?? null,
    variables: cached.variables,
    version: cached.version,
    etag: cached.etag,
    manifest_hash: cached.manifest_hash ?? null,
    withheld: cached.withheld,
    cache: cached.cache ?? null,
  };
}

export function resultFrom(
  response: ContextResponse,
  source: ContextSource,
  error: NiadraError | null = null,
): ContextResult {
  // A conversation in the control group gets an empty pack on purpose; it is not an error.
  const text = response.path === "holdout" ? "" : (response.text ?? "");
  return { text, suffix: renderSuffix(response), variables: response.variables, source, response, error };
}

export function emptyResult(error: NiadraError | null): ContextResult {
  return { text: "", suffix: "", variables: {}, source: "none", response: null, error };
}

/**
 * Renders the delta and the live turns for the end of the prompt. Kept outside the pinned
 * pack so that the prompt prefix stays byte-identical across turns and the model provider's
 * prompt cache keeps hitting. Returns an empty string when there is nothing to add.
 */
export function renderSuffix(response: ContextResponse): string {
  if (response.path === "holdout") return "";
  return [response.delta ?? "", renderLive(response)].filter(Boolean).join("\n\n");
}

/**
 * Renders the live turns (recent turns from other channels that the pack has not absorbed
 * yet) as one tagged block, or an empty string when there are none. `complete="false"` tells
 * the model the list may be missing turns because the server could not read all of them.
 */
export function renderLive(response: ContextResponse): string {
  if (response.path === "holdout" || response.live.length === 0) return "";
  const complete = response.live_complete ? "" : ' complete="false"';
  const lines = response.live.map(renderLiveTurn).join("\n");
  return `<live_turns source="niadra"${complete}>\n${lines}\n</live_turns>`;
}

function renderLiveTurn(turn: LiveTurn): string {
  return `[${utcSeconds(turn.at)}] ${turn.channel} · ${turn.speaker}: ${turn.text}`;
}

/** The same timestamp form in every SDK, whatever precision or offset the server sent. */
function utcSeconds(at: string): string {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? at : `${new Date(ms).toISOString().slice(0, 19)}Z`;
}
