import { NiadraValidationError } from "./errors.js";
import { includeText } from "./constraints/text.js";
import type { NiadraError } from "./errors.js";
import { toObjectRef } from "./handles.js";
import type { Handle, ObjectRef } from "./types/common.js";
import type {
  ContextFormat,
  ContextPack,
  ContextRequest,
  ContextResponse,
  CoordinationBlock,
  Include,
  LiveTurn,
  PrefetchRequest,
  TargetModel,
} from "./types/context.js";
import type { ConstraintsBlock } from "./types/signals.js";
import type { StateView } from "./types/state.js";
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
  /**
   * Other words than the turn to pick this read's slots by. Up to 2,000 characters. Wins over
   * `turn`, and like it never changes the pack.
   */
  query?: string;
  /**
   * The customer's last turn; a conversation passes it for you. It goes as `query` and the answer
   * adds `slots`, what the turn selected from memory, in `suffix`, while the pack stays the
   * conversation's pinned one (and is cached as without it).
   */
  turn?: string | null;
  /** Ask only for what changed since this source last read the subject. */
  delta?: boolean;
  /** The model that will read the pack, so the server can size it for that model's prompt cache. */
  target?: TargetModel;
  /** `json` also returns the pack as typed sections in `pack` (`context-pack.v1`). Defaults to `text`. */
  format?: ContextFormat;
  /**
   * Adds `why` to each of `pack.slots`, naming the retrieval channels that
   * ranked it, the fused score, the weights version and, for a derived line, the rule behind it.
   * Requires `format: "json"`. It changes nothing else: the pinned text, the slots chosen and the
   * receipt are the same bytes with or without it.
   */
  explain?: boolean;
  /**
   * Blocks read in the same round trip: `["constraints"]` returns the subject's constraints block, `["state"]`
   * the state of their objects. Each only where the space turned its feature on; a block the space does not
   * serve is left out and not asked again for a while, and the read goes on. The blocks are cached with the
   * pack, so a read that fails serves the last good ones too.
   */
  include?: Include[];
}

/** Arguments of `prefetch()`: who the turn is about, as in `context()`, and the turn so far. */
export interface PrefetchParams {
  subject?: Handle;
  object?: ObjectRef | string;
  about?: Handle;
  /** Defaults to `voice`, where partial transcripts come from. */
  view?: View;
  verification?: Verification;
  conversation_id?: string;
  task_id?: string;
  /** The partial transcript of the customer's turn. */
  text: string;
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
  /** For `conversation.context()` and `task.context()`: blocks read in the same round trip. */
  include?: Include[] | undefined;
  /** For `conversation.context()` and `task.context()`: `json` also returns `pack`. */
  format?: ContextFormat | undefined;
  /**
   * For `conversation.context()` and `task.context()`: adds `why` to each of `pack.slots`.
   * Requires `format: "json"`.
   */
  explain?: boolean | undefined;
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
   * conversation: the live turns from other channels, this turn's slots (what the customer's last
   * turn selected from memory), the blocks asked for by `include` (the state view, the constraints) and the
   * delta, in that order, as the API places them. Empty when there are none.
   */
  suffix: string;
  /** Named values from the pack, for templates that place them individually. */
  variables: Record<string, string>;
  /** The pack as typed sections, when read with `format: "json"`; otherwise `null`. */
  pack: ContextPack | null;
  source: ContextSource;
  /**
   * How long ago Niadra sent or confirmed the pack served, in milliseconds: 0 for an answer just received,
   * growing while a cached pack is served (`cache`, `stale`, or `fallback` with Niadra down), and `null` when
   * there is no pack.
   */
  ageMs: number | null;
  /** The response this result was built from; `null` when `source` is `none`. */
  response: ContextResponse | null;
  /** What went wrong, when `source` is `fallback` or `none`. */
  error: NiadraError | null;
  /** With `include: ["constraints"]`: the subject's constraints block. */
  constraints?: ConstraintsBlock | null;
  /** With `include: ["state"]`: the state of the subject's objects. */
  state?: StateView | null;
  /** With `include: ["coordination"]`: what coordination knows of the subject. */
  coordination?: CoordinationBlock | null;
  /**
   * Blocks the read asked by `include` that the answer does not carry: the server could not read them this time
   * and said `degraded`. A missing `constraints` block is said in `suffix`, never left silent: a model that is
   * not told a restriction may hold would answer as if none did. Always set by the SDK.
   */
  unreadBlocks?: Include[];
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
  const format: string = params.format ?? "text";
  if (format !== "text" && format !== "json") throw new NiadraValidationError("format is `text` or `json`");
  if (format === "json") request.format = "json";
  if (params.explain) {
    if (format !== "json") throw new NiadraValidationError('explain requires format: "json"');
    request.explain = true;
  }
  if (params.include?.length) request.include = [...new Set(params.include)];
  return request;
}

/** Validates the arguments of `prefetch()` and builds the wire request. */
export function buildPrefetchRequest(params: PrefetchParams): PrefetchRequest {
  if ((params.subject === undefined) === (params.object === undefined)) {
    throw new NiadraValidationError("pass exactly one of `subject` or `object`");
  }
  if (params.conversation_id && params.task_id) {
    throw new NiadraValidationError("pass `conversation_id` or `task_id`, not both");
  }
  if (params.view !== undefined && !VIEW.test(params.view)) {
    throw new NiadraValidationError("unknown view; task views look like `task:billing`");
  }
  const text = params.text.trim();
  if (!text || text.length > MAX_QUERY) throw new NiadraValidationError(`text must be 1 to ${MAX_QUERY} characters`);
  const request: PrefetchRequest = { view: params.view ?? "voice", query: text };
  if (params.subject) request.subject = params.subject;
  if (params.object !== undefined) request.object = toObjectRef(params.object);
  if (params.about) request.about = params.about;
  if (params.verification) request.verification = params.verification;
  if (params.conversation_id) request.conversation_id = params.conversation_id;
  if (params.task_id) request.task_id = params.task_id;
  return request;
}

/** Packs are only cached inside a conversation or task, the unit the server pins them to. */
export function cacheScope(request: Pick<ContextRequest, "conversation_id" | "task_id">): string | null {
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
    request.format ?? "text",
    request.explain ?? false,
    request.include ?? null,
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
    pack: cached.pack ?? null,
    // The blocks sit outside the pinned pack: a fresh block wins, and a missing one keeps the cached.
    constraints: fresh.constraints ?? cached.constraints ?? null,
    state: fresh.state ?? cached.state ?? null,
    coordination: fresh.coordination ?? cached.coordination ?? null,
  };
}

export function resultFrom(
  response: ContextResponse,
  source: ContextSource,
  error: NiadraError | null = null,
  ageMs: number | null = 0,
): ContextResult {
  // A conversation in the control group gets an empty pack on purpose; it is not an error.
  const holdout = response.path === "holdout";
  const text = holdout ? "" : (response.text ?? "");
  const pack = holdout ? null : (response.pack ?? null);
  const blocks = {
    constraints: response.constraints ?? null,
    state: response.state ?? null,
    coordination: response.coordination ?? null,
  };
  const unreadBlocks = unreadOf(response);
  return { text, suffix: renderSuffix(response), variables: response.variables, pack, source, ageMs, response, error, ...blocks, unreadBlocks };
}

export function emptyResult(error: NiadraError | null): ContextResult {
  return { text: "", suffix: "", variables: {}, pack: null, source: "none", ageMs: null, response: null, error, constraints: null, state: null, coordination: null, unreadBlocks: [] };
}

/**
 * An answer as the SDK keeps it: `asked_blocks`, set by the SDK and never sent by the API, are the blocks the read
 * asked by `include`, after any the space does not serve. A block asked and absent is one the server could not
 * read (`ContextResult.unreadBlocks`).
 */
export type ServedContext = ContextResponse & { asked_blocks?: Include[] };

/** The blocks the read asked by `include` that the answer does not carry. */
export function unreadOf(response: ServedContext): Include[] {
  return (response.asked_blocks ?? []).filter((name) => response[name] == null);
}

/**
 * Renders the live turns, the slots and the delta for the end of the prompt, in that order. Kept
 * outside the pinned pack so that the prompt prefix stays byte-identical across turns and the
 * model provider's prompt cache keeps hitting. Returns an empty string when there is nothing to add.
 */
export function renderSuffix(response: ContextResponse): string {
  if (response.path === "holdout") return "";
  const included = includeText(response.text, response.state, response.constraints, unreadOf(response));
  return [renderLive(response), response.slots ?? "", included, response.delta ?? ""].filter(Boolean).join("\n\n");
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
