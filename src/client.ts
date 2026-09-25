import { Admin } from "./admin.js";
import { AgentMemoryCache, blockResult, checkNote, checkTags, emptyBlock } from "./agent-memory.js";
import type { AgentMemoryParams, AgentMemoryResult, RememberParams } from "./agent-memory.js";
import { ContextCache } from "./cache.js";
import type { Revalidated } from "./cache.js";
import {
  buildContextRequest,
  cacheKey,
  cacheScope,
  emptyResult,
  mergeNotModified,
  resultFrom,
} from "./context.js";
import type { ContextOptions, ContextParams, ContextResult, RequestOptions } from "./context.js";
import { Conversation } from "./conversation.js";
import type { ConversationParams } from "./conversation.js";
import {
  NiadraAPIError,
  NiadraAbortError,
  NiadraAuthenticationError,
  NiadraConfigError,
  NiadraError,
  NiadraPermissionError,
  NiadraTimeoutError,
  NiadraValidationError,
  toNiadraError,
} from "./errors.js";
import { registerExitFlush } from "./exit.js";
import {
  buildAction,
  buildConversationEnded,
  buildEvent,
  buildFeedback,
  buildHandoff,
  buildIdentify,
  buildTaskEnded,
  buildVerify,
} from "./items.js";
import { checkUploadURL, prepareUpload } from "./media.js";
import type { MediaUpload, UploadParams } from "./media.js";
import { objectPath } from "./objects.js";
import type { ObjectTimelineParams } from "./objects.js";
import type {
  ActionEvent,
  FeedbackParams,
  HandoffParams,
  IdentifyParams,
  TrackEvent,
  VerifyParams,
} from "./items.js";
import { baseURLFromKey, parseApiKey } from "./key.js";
import { consoleLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { DEFAULT_CACHE, DEFAULT_QUEUE, DEFAULT_TIMEOUTS } from "./options.js";
import type { ClientOptions, Timeouts } from "./options.js";
import { EventQueue } from "./queue.js";
import { Task } from "./task.js";
import type { TaskParams } from "./task.js";
import { bindTools } from "./tools.js";
import type { BoundTools, Navigator, Result, ToolBinding, ToolOptions } from "./tools.js";
import { READ_POLICY, Transport } from "./transport.js";
import type { RequestSpec, RetryPolicy } from "./transport.js";
import type { Handle, ObjectRef } from "./types/common.js";
import type {
  ContextRequest,
  ContextResponse,
  ObjectState,
  ObjectTimeline,
  OpenedItem,
  OpenItemRequest,
  SearchRequest,
  SearchResponse,
  TimelineRequest,
  TimelineResponse,
} from "./types/context.js";
import type { KeyIdentity } from "./types/admin.js";
import type { BatchItem, BatchResponse, FeedbackRequest, MediaUploadResponse } from "./types/events.js";
import type {
  AgentMemoryBlock,
  AgentMemorySearchRequest,
  AgentMemorySearchResponse,
  AgentNote,
  CreateAgentNoteRequest,
  RememberResult,
} from "./types/agent-memory.js";
import type { SubjectToken, SubjectTokenRequest } from "./types/tokens.js";
import type { Verification } from "./types/vocabulary.js";

/** What `identify()`, `verify()`, `handoff()` and the `end()` helpers resolve to. */
export type WriteResult =
  | { ok: true; idempotency_key: string; error: null }
  | { ok: false; idempotency_key: string | null; error: NiadraError };

/** Scope of `open()`: the same verification and conversation the rest of the session uses. */
export interface OpenParams {
  verification?: Verification;
  conversation_id?: string;
  /** Kept for callers of 0.1.0; the server never read it on this route, so it is not sent. */
  task_id?: string;
  /**
   * The customer the item must belong to: the server opens it only when it is theirs, and answers
   * 404 otherwise. `tools()` passes the bound customer.
   */
  subject?: Handle;
}

interface Core {
  transport: Transport;
  queue: EventQueue;
  cache: ContextCache | null;
  /** The agent memory block per request shape, with its ETag. */
  agentMemory: AgentMemoryCache | null;
  baseURL: string;
  /** How requests sent at once, outside the queue, are retried: like a batch. */
  writes: WritePolicy;
}

type WritePolicy = Extract<RetryPolicy, { kind: "write" }>;

/**
 * An environment variable, where the runtime has them. Deno without `--allow-env` throws on any
 * read of `process.env`, and a missing permission must not stop the client from being built.
 */
function readEnv(name: string): string | undefined {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const value = env?.[name];
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

function describe(error: NiadraError): string {
  if (error instanceof NiadraAPIError) {
    return error.requestId ? `${error.message} (request ${error.requestId})` : error.message;
  }
  return `${error.name}: ${error.message}`;
}

/**
 * The Niadra client.
 *
 * Reads (`context`, `search`, `timeline`, `open`) run on the agent's hot path with short time
 * budgets of their own. Writes (`track` and friends) go through an in-memory queue and never
 * block the caller. By default every method is fail-open: an outage, a timeout or a bad
 * argument is logged and the method resolves with an empty result, so the agent keeps
 * working without memory rather than not working at all. Pass `strict: true` to throw instead.
 *
 * Create one client per process and share it; it holds the queue, the cache and the
 * connection pool.
 *
 * @example
 * const niadra = new Niadra({ apiKey: process.env.NIADRA_API_KEY });
 * const ctx = await niadra.context({ subject: handles.phone("+5511987654321"), conversation_id: "wa-8812" });
 */
export class Niadra {
  /** `false` when the client was built without a usable key and sends nothing. */
  readonly enabled: boolean;
  private readonly core: Core | null;
  private readonly timeouts: Timeouts;
  private readonly strict: boolean;
  /** Where the client reports what it swallows in fail-open mode. */
  readonly logger: Logger;
  private readonly disabledReason: NiadraConfigError | null;
  private unregisterExit: () => void = () => undefined;
  /**
   * Governance calls for a key with the `admin` scope: find a customer, read their memory and a
   * fact's history, correct, erase and export. See `Admin`.
   */
  readonly admin: Admin;

  constructor(options: ClientOptions = {}) {
    this.strict = options.strict ?? false;
    this.logger = options.logger ?? consoleLogger;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.admin = new Admin({
      send: (build) => this.navigate(build),
      read: (method, path, body, opts) => this.readSpec(method, path, body, this.timeouts.write, opts),
      write: (path, body, key, opts) => this.writeSpec(path, body, key, opts),
    });

    const setup = this.setup(options);
    if (setup instanceof NiadraConfigError) {
      if (this.strict) throw setup;
      this.logger.warn(`${setup.message}; the client is disabled and will send nothing`);
      this.core = null;
      this.enabled = false;
      this.disabledReason = setup;
      return;
    }

    this.core = setup;
    this.enabled = true;
    this.disabledReason = null;
    if (options.flushOnExit ?? true) this.unregisterExit = registerExitFlush(this);
  }

  private setup(options: ClientOptions): Core | NiadraConfigError {
    const apiKey = options.apiKey ?? readEnv("NIADRA_API_KEY");
    if (!apiKey) return new NiadraConfigError("no API key: pass `apiKey` or set NIADRA_API_KEY");

    let baseURL = options.baseURL ?? readEnv("NIADRA_BASE_URL");
    if (!baseURL) {
      const parsed = parseApiKey(apiKey);
      if (!parsed) {
        return new NiadraConfigError(
          "the API key does not look like nia_sk_<live|test>_<region>_<space>_<key_id>_<secret>; pass `baseURL` to use it anyway",
        );
      }
      baseURL = baseURLFromKey(parsed);
    }

    const fetchImpl = options.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
    if (!fetchImpl) return new NiadraConfigError("no fetch implementation: pass `fetch` on this runtime");

    const transport = new Transport({
      baseURL,
      apiKey,
      fetch: fetchImpl,
      defaultHeaders: options.defaultHeaders ?? {},
    });
    const queueOptions = { ...DEFAULT_QUEUE, ...options.queue };
    // One slot of the server's 500-item limit stays free for the heartbeat.
    queueOptions.maxBatchSize = Math.min(queueOptions.maxBatchSize, 499);
    const queue = new EventQueue(
      (items) => this.sendBatch(transport, items, queueOptions.maxAttempts, queueOptions),
      queueOptions,
      this.logger,
    );
    const cacheOptions = { ...DEFAULT_CACHE, ...(options.cache === false ? {} : options.cache) };
    const cache = options.cache === false ? null : new ContextCache(cacheOptions);
    const agentMemory = options.cache === false ? null : new AgentMemoryCache(cacheOptions.ttlMs, cacheOptions.maxStaleMs);
    const writes: WritePolicy = {
      kind: "write",
      maxAttempts: queueOptions.maxAttempts,
      baseDelayMs: queueOptions.retryDelayMs,
      maxDelayMs: queueOptions.maxRetryDelayMs,
    };
    return { transport, queue, cache, agentMemory, baseURL, writes };
  }

  /**
   * The customer's context pack, to place in the system prompt before calling the model.
   *
   * Inside a conversation (`conversation_id` or `task_id`), packs are cached: a recent one is
   * returned without a request, an older one is returned at once while a single background
   * request refreshes it, and when a request fails the last good pack is returned instead.
   * A 401 or 403 is not an outage: it drops the cached packs, so revoking a key also stops
   * what the process had already cached from reaching the model.
   *
   * A plain read and a `delta` read of one conversation share the cached pack. The server
   * sends each delta once, and so does the cache, even one a background refresh brought in;
   * `conversation()` and `task()` keep them across turns.
   *
   * Never rejects unless `strict` is set. On failure `text` is empty and `error` is set.
   */
  async context(params: ContextParams, options: ContextOptions = {}): Promise<ContextResult> {
    if (!this.core) return emptyResult(this.disabledReason);
    let request: ContextRequest;
    try {
      request = buildContextRequest(params);
    } catch (error) {
      return this.contextFailure(toNiadraError(error), null);
    }

    const timeout = options.timeout ?? (request.view === "voice" ? this.timeouts.contextVoice : this.timeouts.context);
    const cache = options.cache === false ? null : this.core.cache;
    const scope = cacheScope(request);

    if (!cache || !scope) {
      try {
        const response = await this.fetchContext(this.core, request, timeout, options.signal, options.headers);
        return resultFrom(response, "network");
      } catch (error) {
        const failure = toNiadraError(error);
        this.observeAuth(failure, null);
        return this.contextFailure(failure, null);
      }
    }

    const key = cacheKey(request);
    const hit = cache.lookup(key);
    if (hit?.freshness === "fresh") return resultFrom(delivered(hit.response, cache.take(key)), "cache");
    if (hit?.freshness === "stale") {
      this.revalidate(this.core, cache, key, scope, request, timeout, options.headers).catch((error: unknown) => {
        this.logger.debug(`background context refresh failed: ${describe(toNiadraError(error))}`);
      });
      return resultFrom(delivered(hit.response, cache.take(key)), "stale");
    }

    try {
      const pending = this.revalidate(this.core, cache, key, scope, request, timeout, options.headers);
      const { response, source } = await abortable(pending, options.signal);
      return resultFrom(delivered(response, cache.take(key)), source);
    } catch (error) {
      const failure = toNiadraError(error);
      const fallback = cache.lookup(key);
      return this.contextFailure(failure, fallback ? delivered(fallback.response, cache.take(key)) : null);
    }
  }

  /**
   * Searches the customer's history by keywords and meaning, with filters by period, channel,
   * topic and kind. The answer includes how often the same kind of issue came back.
   */
  async search(params: SearchRequest, options: RequestOptions = {}): Promise<Result<SearchResponse>> {
    return this.navigate(() => {
      if (!params.query || params.query.length > 2000) {
        throw new NiadraValidationError("query must be 1 to 2000 characters");
      }
      return this.readSpec("POST", "/v1/history/search", params, this.timeouts.navigation, options);
    });
  }

  /** The customer's history, newest first, one line per item, paginated by cursor. */
  async timeline(params: TimelineRequest, options: RequestOptions = {}): Promise<Result<TimelineResponse>> {
    return this.navigate(() =>
      this.readSpec("POST", "/v1/history/timeline", params, this.timeouts.navigation, options),
    );
  }

  /**
   * Opens one history item from `search()` or `timeline()`: summary, request, commitments,
   * outcome and resolution. Sent as `POST /v1/history/open`: the conversation id and `subject` go
   * in the body, never in a URL.
   */
  async open(id: string, params: OpenParams = {}, options: RequestOptions = {}): Promise<Result<OpenedItem>> {
    return this.navigate(() => {
      if (!id) throw new NiadraValidationError("open() needs an item id");
      const body: OpenItemRequest = { item_id: id };
      if (params.subject) body.subject = params.subject;
      if (params.verification) body.verification = params.verification;
      if (params.conversation_id) body.conversation_id = params.conversation_id;
      return this.readSpec("POST", "/v1/history/open", body, this.timeouts.navigation, options);
    });
  }

  /**
   * The derived state of a business object: what its systems of record reported last, `as_of`
   * when, and its open items, under this source's purpose.
   *
   * @example
   * const { data: invoice } = await niadra.objectState("invoice:erp:0823");
   */
  async objectState(object: ObjectRef | string, options: RequestOptions = {}): Promise<Result<ObjectState>> {
    return this.navigate(() => this.readSpec("GET", objectPath(object), undefined, this.timeouts.navigation, options));
  }

  /**
   * System events and agent actions about one object, newest first, one line each and never
   * conversation content. Pass `next_cursor` back as `cursor` to go on.
   */
  async objectTimeline(
    object: ObjectRef | string,
    params: ObjectTimelineParams = {},
    options: RequestOptions = {},
  ): Promise<Result<ObjectTimeline>> {
    return this.navigate(() => {
      const limit = params.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new NiadraValidationError("limit must be between 1 and 100");
      }
      const path = `${objectPath(object)}/timeline`;
      const spec = this.readSpec("GET", path, undefined, this.timeouts.navigation, options);
      spec.query = { cursor: params.cursor, limit: String(limit) };
      return spec;
    });
  }

  /**
   * The navigation kit as function-calling tools with the customer bound outside the model's
   * reach. Hand `definitions` to any model API and pass its tool calls to `call()`.
   *
   * @example
   * const kit = niadra.tools(handles.phone("+5511987654321"), { conversation_id: "wa-8812" });
   * const output = await kit.call(toolCall.function.name, toolCall.function.arguments);
   */
  tools(subject: Handle, binding: ToolBinding = {}, options: ToolOptions = {}): BoundTools {
    const navigator: Navigator = {
      search: (params, voice) => this.search(params, this.voiceBudget(voice)),
      timeline: (params, voice) => this.timeline(params, this.voiceBudget(voice)),
      open: (id, customer, bound, voice) => {
        // The bound customer goes along, so the server opens only an item of theirs.
        const scope: OpenParams = { subject: customer };
        if (bound.verification) scope.verification = bound.verification;
        if (bound.conversation_id) scope.conversation_id = bound.conversation_id;
        return this.open(id, scope, this.voiceBudget(voice));
      },
      searchAgentMemory: (query, scope, voice) => this.searchAgentMemory(query, scope, this.voiceBudget(voice)),
      remember: (note) => this.remember(note),
    };
    return bindTools(subject, binding, navigator, this.strict, options);
  }

  /**
   * The agent's own working notes as text for the prompt: put it after your instructions and
   * before the customer's context. It is the same for every customer, so it stays in the
   * cacheable prefix. Served from an ETag cache like `context()`.
   *
   * Never rejects unless `strict` is set: on failure, or when agent memory is off for the space,
   * `text` is empty.
   */
  async agentMemory(params: AgentMemoryParams = {}, options: RequestOptions & { cache?: boolean } = {}): Promise<AgentMemoryResult> {
    if (!this.core) return emptyBlock(this.disabledReason);
    const core = this.core;
    try {
      checkTags(params.tags);
      const tokens = params.max_tokens ?? 300;
      if (!Number.isInteger(tokens) || tokens < 1 || tokens > 4000) throw new NiadraValidationError("max_tokens must be between 1 and 4000");
    } catch (error) {
      const failure = toNiadraError(error);
      if (this.strict) throw failure;
      this.logger.warn(`agentMemory() failed: ${describe(failure)}`);
      return emptyBlock(failure);
    }
    const cache = options.cache === false ? null : core.agentMemory;
    const key = AgentMemoryCache.key(params);
    const fresh = cache?.fresh(key);
    if (fresh) return blockResult(fresh, "cache");

    const timeout = options.timeout ?? (params.view === "voice" ? this.timeouts.contextVoice : this.timeouts.context);
    const spec = this.readSpec("GET", "/v1/agent-memory/block", undefined, timeout, options);
    spec.query = {
      max_tokens: String(params.max_tokens ?? 300),
      view: params.view,
      ...(params.tags?.length ? { tags: params.tags } : {}),
    };
    const etag = cache?.etag(key);
    if (etag) spec.headers = { ...options.headers, "if-none-match": etag };
    try {
      const response = await core.transport.request<AgentMemoryBlock>(spec);
      cache?.store(key, response.data);
      return blockResult(response.data, "network");
    } catch (error) {
      const failure = toNiadraError(error);
      if (failure instanceof NiadraAPIError && failure.status === 304) {
        const current = cache?.touch(key);
        if (current) return blockResult(current, "network");
      }
      if (failure instanceof NiadraAPIError && failure.status === 501) {
        this.logger.debug("agent memory is not served by this cell yet");
        return emptyBlock(failure, false);
      }
      if (failure instanceof NiadraAuthenticationError || failure instanceof NiadraPermissionError) cache?.clear();
      if (this.strict) throw failure;
      this.logger.warn(`agentMemory() failed: ${describe(failure)}`);
      const fallback = cache?.usable(key);
      return fallback ? blockResult(fallback, "fallback", failure) : emptyBlock(failure);
    }
  }

  /** Searches the agent's own working notes by words and tags. Resolves with `data: null` on failure. */
  async searchAgentMemory(
    query: string,
    params: { tags?: string[]; limit?: number; conversation_id?: string; task_id?: string } = {},
    options: RequestOptions = {},
  ): Promise<Result<AgentNote[]>> {
    const result = await this.navigate<AgentMemorySearchResponse>(() => {
      if (!query || query.length > 2000) throw new NiadraValidationError("query must be 1 to 2000 characters");
      checkTags(params.tags);
      if (params.conversation_id && params.task_id) throw new NiadraValidationError("pass `conversation_id` or `task_id`, not both");
      const body: AgentMemorySearchRequest = { query };
      if (params.tags?.length) body.tags = params.tags;
      if (params.limit !== undefined) body.limit = params.limit;
      if (params.conversation_id) body.conversation_id = params.conversation_id;
      if (params.task_id) body.task_id = params.task_id;
      return this.readSpec("POST", "/v1/agent-memory/search", body, this.timeouts.navigation, options);
    });
    return result.error ? result : { data: result.data.notes, error: null };
  }

  /**
   * Saves a working note for this agent: a procedure, how a tool or process behaves, a pitfall.
   * Never anything about a customer: the server refuses a note with personal data (422
   * `personal_data_in_agent_memory`) instead of masking it. Needs the `agent_memory:write` scope.
   * Resolves with the note, or the id of a proposal when the space wants a person to approve it;
   * `data: null` on failure.
   */
  async remember(note: RememberParams, options: RequestOptions = {}): Promise<Result<RememberResult>> {
    return this.navigate(() => {
      checkNote(note);
      const body: CreateAgentNoteRequest = { kind: note.kind, title: note.title, body: note.body };
      if (note.tags?.length) body.tags = note.tags;
      if (note.evidence) body.evidence = note.evidence;
      if (note.visibility) body.visibility = note.visibility;
      if (note.valid_until) {
        const at = note.valid_until instanceof Date ? note.valid_until.toISOString() : note.valid_until;
        if (Number.isNaN(Date.parse(at))) throw new NiadraValidationError("valid_until must be ISO 8601");
        body.valid_until = at;
      }
      return this.readSpec("POST", "/v1/agent-memory/notes", body, this.timeouts.write, options);
    });
  }

  /**
   * Mints a signed, 15-minute token that binds one customer to a session. Your backend calls
   * this and hands the token to the MCP connection, so tools served over MCP can only ever
   * read that customer. Resolves with `data: null` on failure.
   */
  async subjectToken(params: SubjectTokenRequest, options: RequestOptions = {}): Promise<Result<SubjectToken>> {
    return this.navigate(() => this.readSpec("POST", "/v1/subject-tokens", params, this.timeouts.token, options));
  }

  /**
   * Records a message, a system event or an agent action. Returns at once with the event's
   * idempotency key, or `null` when the event was dropped: invalid, unserializable, the queue
   * full or the client disabled. Delivery happens in the background; `flush()` waits for it.
   */
  track(event: TrackEvent): string | null {
    return this.enqueue(() => buildEvent(event));
  }

  /**
   * Records what an agent did in a system of record, such as a credit or a reschedule.
   * With `closes`, the action also resolves the open item it fulfils.
   */
  action(event: ActionEvent): string | null {
    return this.enqueue(() => buildAction(event));
  }

  /**
   * States that several handles belong to the same subject. Sent right away rather than on the
   * next batch, so the next `context()` call already sees the merged profile.
   */
  identify(params: IdentifyParams): Promise<WriteResult> {
    return this.sendNow(() => buildIdentify(params));
  }

  /**
   * Raises the verification level of one conversation or task after the customer proved who
   * they are. Sent right away, and drops the conversation's cached packs, because a pack
   * compiled for the old level may be missing what the new level allows.
   */
  verify(params: VerifyParams): Promise<WriteResult> {
    return this.verifyWith(params);
  }

  /**
   * Corrects what Niadra derived about a subject: retracts or corrects a fact, resolves an open
   * item, or records how a conversation ended. Sent right away; the server records it as an
   * event, so the correction is audited like any other. A rejected correction resolves with
   * `ok: false`.
   */
  async feedback(params: FeedbackParams): Promise<WriteResult> {
    const core = this.core;
    if (!core) return { ok: false, idempotency_key: null, error: this.disabledError() };
    let key: string | null = null;
    try {
      const request = buildFeedback(params);
      key = request.idempotency_key;
      const response = await core.transport.request<Partial<BatchResponse> | null>({
        method: "POST",
        path: "/v1/feedback",
        body: request,
        headers: { "idempotency-key": key },
        timeoutMs: this.timeouts.write,
        retry: { ...core.writes, totalMs: this.timeouts.write },
      });
      const [rejected] = response.data?.errors ?? [];
      if (rejected) {
        throw new NiadraValidationError(`${rejected.code}${rejected.detail ? `: ${rejected.detail}` : ""}`);
      }
      return { ok: true, idempotency_key: key, error: null };
    } catch (error) {
      return { ok: false, idempotency_key: key, error: this.swallow(error, "feedback") };
    }
  }

  /**
   * Up to 500 corrections in one call, each with its own idempotency key (minted when missing).
   * Resolves with `accepted`, `duplicates` for replayed keys and one error per refused item, by index.
   */
  async feedbackBatch(items: FeedbackParams[], options: RequestOptions = {}): Promise<Result<BatchResponse>> {
    return this.navigate(() => {
      if (items.length < 1 || items.length > 500) throw new NiadraValidationError("1 to 500 feedback items");
      const body: { items: FeedbackRequest[] } = { items: items.map((item) => buildFeedback(item)) };
      const spec = this.writeSpec("/v1/feedback/batch", body, null, options);
      return spec;
    });
  }

  /**
   * What this key authenticates as: space, source, vendor, scopes and whether agent memory is on.
   * Any key may ask, whatever its scopes; use it to check a key before wiring an agent to it.
   */
  async whoami(options: RequestOptions = {}): Promise<Result<KeyIdentity>> {
    return this.navigate(() => this.readSpec("GET", "/v1/sources/me", undefined, this.timeouts.write, options));
  }

  /**
   * Hands a file to Niadra, such as a call recording, and returns the reference its event
   * carries. Media never travels inside an event: this reserves an upload, sends the bytes
   * straight to storage over a short-lived signed URL, and resolves with `media_ref` and
   * `media_sha256` for the event's `content`.
   *
   * @example
   * const { data } = await niadra.uploadMedia({ data: recording, content_type: "audio/wav" });
   * if (data) convo.track({ speaker: "customer", content: { type: "audio", media_ref: data.media_ref, media_sha256: data.media_sha256 } });
   */
  async uploadMedia(params: UploadParams, options: { signal?: AbortSignal } = {}): Promise<Result<MediaUpload>> {
    const core = this.core;
    if (!core) return { data: null, error: this.disabledError() };
    try {
      const { bytes, request } = await prepareUpload(params);
      const reserved = await core.transport.request<Partial<MediaUploadResponse> | null>({
        method: "POST",
        path: "/v1/media/uploads",
        body: request,
        timeoutMs: this.timeouts.write,
        retry: { ...core.writes, totalMs: this.timeouts.write },
        signal: options.signal,
      });
      const media_ref = reserved.data?.media_ref;
      if (typeof media_ref !== "string") throw new NiadraError("unexpected response from /v1/media/uploads");
      const url = reserved.data?.upload_url;
      if (url) {
        checkUploadURL(url, core.baseURL);
        await core.transport.upload({
          url,
          body: bytes,
          headers: uploadHeaders(reserved.data?.upload_headers, request.content_type),
          timeoutMs: this.timeouts.upload,
          retry: { ...core.writes, totalMs: this.timeouts.upload },
          signal: options.signal,
        });
      }
      return {
        data: {
          media_ref,
          media_sha256: request.sha256,
          content_type: request.content_type,
          size_bytes: request.size_bytes,
          expires_at: reserved.data?.expires_at ?? null,
        },
        error: null,
      };
    } catch (error) {
      return { data: null, error: this.swallow(error, "media upload") };
    }
  }

  /** Records a transfer to a human or another agent. Sent right away, so the receiver can read context at once. */
  handoff(params: HandoffParams): Promise<WriteResult> {
    return this.sendNow(() => buildHandoff(params));
  }

  /**
   * A helper for one customer conversation: pins the pack across turns, captures turns and
   * emits `conversation.ended` when you call `end()`.
   */
  conversation(params: ConversationParams): Conversation {
    return new Conversation(this, params, {
      endConversation: (id) => this.endScope(buildConversationEnded(id), `conversation:${id}`),
    });
  }

  /** A helper for one internal-agent task: binds `task_id` to reads and writes and emits `task.ended`. */
  task(params: TaskParams): Task {
    return new Task(this, params, {
      endTask: (id) => this.endScope(buildTaskEnded(id), `task:${id}`),
      verifyTask: (verify) => this.verifyWith(verify),
    });
  }

  /**
   * Sends every queued event and resolves when done. Call it before a serverless function
   * returns, or pass it to `waitUntil()` on edge runtimes. Rejects only with `strict` set.
   */
  async flush(): Promise<void> {
    if (!this.core) return;
    const report = await this.core.queue.flush();
    const [first] = report.errors;
    if (this.strict && first) throw first;
  }

  /**
   * Flushes, stops the background timer and releases the exit hook. Events tracked after
   * this are dropped. Call it from your own SIGTERM handler in long-running services.
   */
  async shutdown(): Promise<void> {
    this.unregisterExit();
    if (!this.core) return;
    const report = await this.core.queue.close();
    this.core.cache?.clear();
    const [first] = report.errors;
    if (this.strict && first) throw first;
  }

  private async verifyWith(params: Omit<VerifyParams, "handle"> & { handle: Handle | undefined }): Promise<WriteResult> {
    const result = await this.sendNow(() => buildVerify(params));
    if (result.ok) {
      if (params.conversation_id) this.forgetScope(`conversation:${params.conversation_id}`);
      if (params.task_id) this.forgetScope(`task:${params.task_id}`);
    }
    return result;
  }

  /** Throws under `strict`; otherwise logs what failed, never with content, and returns the error. */
  private swallow(error: unknown, what: string): NiadraError {
    const failure = toNiadraError(error);
    this.observeAuth(failure, null);
    if (this.strict) throw failure;
    this.logger.warn(`${what} failed: ${describe(failure)}`);
    return failure;
  }

  private voiceBudget(voice: boolean): RequestOptions {
    return voice ? { timeout: this.timeouts.navigationVoice } : {};
  }

  private readSpec(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    defaultTimeout: number,
    options: RequestOptions,
  ): RequestSpec {
    const spec: RequestSpec = {
      method,
      path,
      timeoutMs: options.timeout ?? defaultTimeout,
      retry: READ_POLICY,
      signal: options.signal,
      headers: options.headers,
    };
    if (body !== undefined) spec.body = body;
    return spec;
  }

  /** A write sent at once, retried like a batch; the idempotency key makes the retries safe. */
  private writeSpec(path: string, body: unknown, idempotencyKey: string | null, options: RequestOptions): RequestSpec {
    const timeout = options.timeout ?? this.timeouts.write;
    const headers = { ...options.headers, ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) };
    return {
      method: "POST",
      path,
      body,
      headers,
      timeoutMs: timeout,
      retry: this.core ? { ...this.core.writes, totalMs: timeout } : READ_POLICY,
      signal: options.signal,
    };
  }

  private async navigate<T>(build: () => RequestSpec): Promise<Result<T>> {
    if (!this.core) return { data: null, error: this.disabledError() };
    try {
      const response = await this.core.transport.request<T>(build());
      return { data: response.data, error: null };
    } catch (error) {
      const failure = toNiadraError(error);
      this.observeAuth(failure, null);
      if (this.strict) throw failure;
      this.logger.warn(`read failed: ${describe(failure)}`);
      return { data: null, error: failure };
    }
  }

  private async fetchContext(
    core: Core,
    request: ContextRequest,
    timeout: number,
    signal: AbortSignal | undefined,
    headers: Record<string, string> | undefined,
  ): Promise<ContextResponse> {
    const response = await core.transport.request<unknown>(
      this.readSpec("POST", "/v1/context", request, timeout, { signal, headers }),
    );
    return normalizeContext(response.data);
  }

  /**
   * One request for a key, shared by every caller that needs it meanwhile. It sends the
   * cached ETag, so an unchanged pack costs a `not_modified` answer instead of the full text.
   * The caller's signal is deliberately not passed down: other callers may be waiting too.
   */
  private revalidate(
    core: Core,
    cache: ContextCache,
    key: string,
    scope: string,
    request: ContextRequest,
    timeout: number,
    headers: Record<string, string> | undefined,
  ): Promise<Revalidated> {
    return cache.dedupe(key, async () => {
      const cached = cache.lookup(key);
      const generation = cache.generation;
      const body = cached ? { ...request, known_etag: cached.response.etag } : request;
      try {
        const response = await this.fetchContext(core, body, timeout, undefined, headers);
        // A degraded answer never replaces a good pack; the good one is served instead.
        if (response.degraded && !response.not_modified && cached) {
          return { response: cached.response, source: "fallback" };
        }
        const merged = response.not_modified && cached ? mergeNotModified(cached.response, response) : response;
        cache.store(key, scope, merged, generation);
        return { response: merged, source: "network" };
      } catch (error) {
        this.observeAuth(toNiadraError(error), key);
        throw error;
      }
    });
  }

  private contextFailure(error: NiadraError, fallback: ContextResponse | null): ContextResult {
    if (this.strict) throw error;
    if (fallback) {
      this.logger.warn(`context request failed, serving the last good pack: ${describe(error)}`);
      return resultFrom(fallback, "fallback", error);
    }
    this.logger.warn(`context unavailable: ${describe(error)}`);
    return emptyResult(error);
  }

  /**
   * 401 means the key itself is no longer valid, so every cached pack goes. 403 is specific to
   * what was asked, so only that pack goes.
   */
  private observeAuth(error: NiadraError, key: string | null): void {
    const cache = this.core?.cache;
    if (!cache) return;
    if (error instanceof NiadraAuthenticationError) cache.clear();
    else if (error instanceof NiadraPermissionError && key) cache.delete(key);
  }

  private forgetScope(scope: string): void {
    this.core?.cache?.deleteScope(scope);
  }

  private disabledError(): NiadraError {
    return this.disabledReason ?? new NiadraConfigError("client is disabled");
  }

  private enqueue(build: () => BatchItem): string | null {
    if (!this.core) return null;
    let item: BatchItem;
    try {
      item = build();
    } catch (error) {
      const failure = toNiadraError(error);
      if (this.strict) throw failure;
      this.logger.warn(`event dropped: ${failure.message}`);
      return null;
    }
    const accepted = this.core.queue.push(item);
    return accepted && "idempotency_key" in item ? item.idempotency_key : null;
  }

  private sendNow(build: () => BatchItem & { idempotency_key: string }): Promise<WriteResult> {
    const core = this.core;
    if (!core) return Promise.resolve({ ok: false, idempotency_key: null, error: this.disabledError() });
    let item: BatchItem & { idempotency_key: string };
    try {
      item = build();
    } catch (error) {
      const failure = toNiadraError(error);
      if (this.strict) return Promise.reject(failure);
      this.logger.warn(`write dropped: ${failure.message}`);
      return Promise.resolve({ ok: false, idempotency_key: null, error: failure });
    }
    return new Promise<WriteResult>((resolve, reject) => {
      const key = item.idempotency_key;
      let settled = false;
      // The caller waits at most `timeouts.write`. Past it the item stays in the queue, which
      // keeps sending it with its own retries.
      const timer = setTimeout(() => {
        this.logger.warn(`write not confirmed within ${this.timeouts.write} ms; it stays queued`);
        settle(new NiadraTimeoutError(this.timeouts.write));
      }, this.timeouts.write);
      const settle = (error: NiadraError | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!error) resolve({ ok: true, idempotency_key: key, error: null });
        else if (this.strict) reject(error);
        else resolve({ ok: false, idempotency_key: key, error });
      };
      core.queue.push(item, settle);
      core.queue.flushInBackground();
    });
  }

  private async endScope(item: BatchItem & { idempotency_key: string }, scope: string): Promise<WriteResult> {
    const result = await this.sendNow(() => item);
    this.forgetScope(scope);
    return result;
  }

  private async sendBatch(
    transport: Transport,
    items: BatchItem[],
    maxAttempts: number,
    backoff: { retryDelayMs: number; maxRetryDelayMs: number },
  ): Promise<BatchResponse> {
    try {
      const response = await transport.request<BatchResponse>({
        method: "POST",
        path: "/v1/batch",
        body: { items },
        timeoutMs: this.timeouts.write,
        retry: { kind: "write", maxAttempts, baseDelayMs: backoff.retryDelayMs, maxDelayMs: backoff.maxRetryDelayMs },
      });
      const data = response.data as Partial<BatchResponse> | null;
      return { accepted: data?.accepted ?? items.length, duplicates: data?.duplicates ?? 0, errors: data?.errors ?? [] };
    } catch (error) {
      const failure = toNiadraError(error);
      this.observeAuth(failure, null);
      throw failure;
    }
  }
}

/**
 * Checks the fields the SDK relies on and fills list and map defaults, so a leaner response
 * from a future server version cannot turn into a crash in the caller's prompt code.
 */
function normalizeContext(data: unknown): ContextResponse {
  if (typeof data !== "object" || data === null) throw new NiadraError("unexpected response from /v1/context");
  const body = data as Partial<ContextResponse>;
  if (typeof body.etag !== "string" || typeof body.path !== "string" || !body.verification) {
    throw new NiadraError("unexpected response from /v1/context");
  }
  return {
    ...body,
    etag: body.etag,
    path: body.path,
    verification: body.verification,
    version: body.version ?? "",
    not_modified: body.not_modified ?? false,
    variables: body.variables ?? {},
    coverage: body.coverage ?? [],
    live: body.live ?? [],
    live_complete: body.live_complete ?? true,
    timing: body.timing ?? {},
    withheld: body.withheld ?? 0,
    degraded: body.degraded ?? false,
  };
}

/** Exactly what the signature covers; a server that names nothing still signs the content type. */
function uploadHeaders(named: Record<string, string> | undefined, contentType: string): Record<string, string> {
  return named && Object.keys(named).length > 0 ? { ...named } : { "content-type": contentType };
}

/** `response` with the deltas the cache handed out for it; as is when the key is not cached. */
function delivered(response: ContextResponse, taken: string | null | undefined): ContextResponse {
  return taken === undefined ? response : { ...response, delta: taken };
}

/** Lets one caller stop waiting for a shared request without cancelling it for the others. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new NiadraAbortError("request aborted by the caller"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new NiadraAbortError("request aborted by the caller"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new NiadraError(String(error)));
      },
    );
  });
}
