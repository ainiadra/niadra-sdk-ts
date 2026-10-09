import { uuidv7 } from "./ids.js";
import { Admin } from "./admin.js";
import { InternalText } from "./claims/internal.js";
import { AgentStates } from "./agent-state.js";
import type { AgentHost } from "./agent-session.js";
import { checkTurn } from "./capture/claims.js";
import { tool as recordTool } from "./capture/tool.js";
import type { ToolOptions as RecordedToolOptions } from "./capture/tool.js";
import { TurnRecorder, DEFAULT_TURNS } from "./capture/recorder.js";
import { TurnSender } from "./capture/sender.js";
import { ContentResolver } from "./content.js";
import { Coordinator } from "./coordination/client.js";
import { SuppressionCopy } from "./coordination/suppression.js";
import { ContactGateway } from "./coordination/token.js";
import type { SeenTokens } from "./coordination/token.js";
import { Outbox } from "./outbox.js";
import { ProfileCache } from "./profile.js";
import { replaying } from "./replay/playback.js";
import { CLAIM_BUDGET_MS, Resolvers, asRef, fromNiadra, fromResolver } from "./resolvers.js";
import type { ClaimVerdict } from "./resolvers.js";
import { Api } from "./api.js";
import { AgentMemoryCache, blockResult, checkNote, checkTags, emptyBlock } from "./agent-memory.js";
import type { AgentMemoryParams, AgentMemoryResult, RememberParams } from "./agent-memory.js";
import { ContextCache } from "./cache.js";
import type { Revalidated } from "./cache.js";
import {
  buildContextRequest,
  buildPrefetchRequest,
  cacheKey,
  cacheScope,
  emptyResult,
  mergeNotModified,
  resultFrom,
} from "./context.js";
import type { ContextOptions, ContextParams, ContextResult, PrefetchParams, RequestOptions, ServedContext } from "./context.js";
import { Conversation } from "./conversation.js";
import { EVERY_MS as KEEP_WARM_EVERY_MS, KeepWarm } from "./warm.js";
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
import { DEFAULT_CACHE, DEFAULT_QUEUE, DEFAULT_TIMEOUTS, DEFAULT_VOICE, FETCH_KEEPALIVE_MS } from "./options.js";
import type { ClientOptions, Timeouts } from "./options.js";
import { EventQueue, unref } from "./queue.js";
import { Task } from "./task.js";
import type { TaskParams } from "./task.js";
import { bindTools } from "./tools.js";
import type { BoundTools, Navigator, Result, ToolBinding, ToolOptions } from "./tools.js";
import type { Route } from "./routes.js";
import { READ_POLICY, Transport, voiced } from "./transport.js";
import { BLOCK_RECHECK_AFTER_MS, MIN_PREFETCH, turnText } from "./turns.js";
import { VoiceLines, budgetWarnings, compose, rttWarnings, wordsOf } from "./voice.js";
import type { TurnRead, VoiceLine } from "./voice.js";
import type { RequestSpec, RetryPolicy } from "./transport.js";
import type { Handle, ObjectRef } from "./types/common.js";
import type {
  ContextRequest,
  ContextResponse,
  Include,
  ObjectTimeline,
  OpenedItem,
  OpenItemRequest,
  PrefetchRequest,
  SearchRequest,
  SearchResponse,
  TimelineRequest,
  TimelineResponse,
} from "./types/context.js";
import type {
  ContextUseParams,
  ContextUseReport,
  IngestStatus,
  KeyIdentity,
  Link,
  LinkMethod,
  LinkRequest,
} from "./types/admin.js";
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
import type { DeclareRequest } from "./types/coordination.js";
import type { ClaimContractSummary, ObjectRead, SdkProfile, StateRef, StateVerifyResponse } from "./types/state.js";
import type { TurnPins, TurnsResponse } from "./types/turns.js";
import type { Verification } from "./types/vocabulary.js";

/** A read's options inside the client: `voice` when a voice turn waits for it, so its budget is its ceiling. */
interface ReadOptions extends RequestOptions {
  voice?: boolean;
}

/** Keys of answered reads a client remembers to tell a first read from the next (`timeouts.contextFirst`). */
const READ_KEYS_KEPT = 4096;

/** What `identify()`, `verify()`, `handoff()` and the `end()` helpers resolve to. */
export type WriteResult =
  | { ok: true; idempotency_key: string; error: null }
  | { ok: false; idempotency_key: string | null; error: NiadraError };

/** Scope of `open()`: the same verification and conversation the rest of the session uses. */
export interface OpenParams {
  verification?: Verification;
  conversation_id?: string;
  /**
   * The customer the item must belong to: the server opens it only when it is theirs, and answers
   * 404 otherwise. `tools()` passes the bound customer.
   */
  subject?: Handle;
  /**
   * The organization the customer acts for: also an item of it the customer's view shows (the pack's
   * account block). Needs `subject`; `tools()` passes the bound one.
   */
  about?: Handle;
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
  private readonly keepWarm: KeepWarm;
  private warmTimer: ReturnType<typeof setInterval> | undefined;
  /** The read budgets the caller left at their defaults: they take the measured round trip on top. */
  private readonly defaultReads: ReadonlySet<"context" | "navigation">;
  private voiceStarted = false;
  /** A probe is on its way: until it ends, default read budgets get `timeouts.connect` on top. */
  private measuring = false;
  /** The keys whose read answered in this client, oldest first: a first read gets `timeouts.contextFirst`. */
  private readonly answeredReads = new Map<string, true>();
  private voiceWarned = false;
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
  /**
   * The routes of turn records, typed state, signals and coordination, one method each. Unlike the rest
   * of the client they never fail open: they reject with the API's error. See `Api`.
   */
  readonly api: Api;
  /** Whether this client's server answers prefetches. */
  /** Per conversation or task, the prefetch in flight and the newest text waiting behind it. */
  private readonly prefetching = new Map<string, PrefetchRequest | null>();
  /** The voice read path's lines, by conversation or task (`voice.ts`). */
  private readonly voice: VoiceLines;
  /** Turn records: `conversation.turn()` opens one, and a background sender posts the closed ones. */
  readonly turns: TurnRecorder;
  /** The company's resolvers by object type: `resolvers.register(type, fn)` (`resolvers.ts`). */
  readonly resolvers = new Resolvers();
  /**
   * Fingerprints of the company's own prompt, by version: `internalText.register("prompts@v16", text)`. An
   * output that repeats a passage of it gives way to the claim contract's line; the prompt never leaves the
   * process (`claims/internal.ts`).
   */
  readonly internalText = new InternalText();
  /** The company's content resolver, for content kept by pointer: `content.register(fetch)`. */
  readonly content = new ContentResolver();
  private readonly profileCache = new ProfileCache();
  private readonly suppressions = new SuppressionCopy();
  private readonly outbox: Outbox;
  private readonly coordinator: Coordinator;
  private readonly states: AgentStates;
  private readonly turnSender: TurnSender | null = null;
  /** Blocks of `include` the space refused, and until when they are not asked for. */
  private readonly refusedBlocks = new Map<string, number>();

  constructor(options: ClientOptions = {}) {
    this.strict = options.strict ?? false;
    this.logger = options.logger ?? consoleLogger;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.keepWarm = new KeepWarm(options.keepWarm ?? true);
    this.defaultReads = new Set((["context", "navigation"] as const).filter((name) => options.timeouts?.[name] === undefined));
    this.voice = new VoiceLines(
      options.voice === false ? { ...DEFAULT_VOICE, enabled: false } : { ...DEFAULT_VOICE, ...options.voice },
    );
    this.admin = new Admin({
      send: (build) => this.navigate(build),
      read: (method, path, body, opts) => this.readSpec(method, path, body, this.timeouts.write, opts),
      write: (path, body, key, opts) => this.writeSpec(path, body, key, opts),
    });
    this.api = new Api((route, opts) => this.route(route, opts));

    const setup = this.setup(options);
    this.turns = new TurnRecorder({ ...DEFAULT_TURNS, ...options.turns }, !(setup instanceof NiadraConfigError), this.logger);
    this.turns.features = () => this.profileCache.features;
    this.turns.recordingMode = () => this.profileCache.recordingMode();
    this.turns.requiredPins = () => this.profileCache.requiredPins();
    this.turns.families = () => this.profileCache.families();
    this.turns.fieldAccess = () => this.profileCache.fieldAccess();
    this.turns.bindings = (tool) => this.profileCache.toolBinding(tool);
    this.turns.claims = (frame) => {
      const contract = this.profileCache.contract();
      return contract === null ? [] : checkTurn(frame, contract, this.internalText);
    };
    this.outbox = new Outbox(this.logger);
    this.coordinator = new Coordinator(
      this.outbox,
      this.suppressions,
      (body, key) => this.api.declare(body as unknown as DeclareRequest, { idempotency_key: key }),
      this.logger,
    );
    this.states = new AgentStates(
      this.outbox,
      {
        read: (scope, agent) => this.api.readAgentState({ scope, agent }, { timeout: this.readBudget("navigation") }),
        write: (write) => this.api.writeAgentState(write, { timeout: this.readBudget("navigation") }),
      },
      this.logger,
    );
    if (!(setup instanceof NiadraConfigError)) {
      const core = setup;
      this.turnSender = new TurnSender(
        this.turns,
        this.turns.queue,
        (body) => this.sendTurns(core, body),
        this.logger,
        this.turns.options.intervalMs,
        () => this.profile(),
      );
      this.turns.sender = this.turnSender;
    }
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
    // The round trip to the region, measured now: the default read budgets take it on top, and the
    // connection it opens is warm for the first read.
    this.probe(setup);
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
      logger: this.logger,
      coldAllowanceMs: this.timeouts.connect,
      keepAliveMs: options.keepAliveMs ?? FETCH_KEEPALIVE_MS,
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
    const played = replaying();
    if (played !== null) return played.context ? resultFrom(played.context, "cache") : emptyResult(new NiadraError("replay"));
    if (!this.core) return emptyResult(this.disabledReason);
    let request: ContextRequest;
    try {
      request = buildContextRequest(params);
    } catch (error) {
      return this.contextFailure(toNiadraError(error), null);
    }
    if (request.include) {
      const now = Date.now();
      const wanted = request.include.filter((name) => (this.refusedBlocks.get(name) ?? 0) <= now);
      if (wanted.length > 0) request.include = wanted;
      else delete request.include;
    }
    const result = await this.readContext(this.core, params, request, options);
    if (this.content.registered && result.state) result.state = await this.content.fill(result.state);
    return result;
  }

  private async readContext(core: Core, params: ContextParams, request: ContextRequest, options: ContextOptions): Promise<ContextResult> {
    // The read's own `query`, else the customer's turn: either picks the slots, never the pack.
    const { query: own, ...pinned } = request;
    const query = turnText(own ?? params.turn);
    const readKey = cacheKey(pinned);
    const first = !this.answeredReads.has(readKey);
    const timeout = options.timeout ?? (request.view === "voice" ? this.timeouts.contextVoice : this.readBudget("context", first));
    const voiceCache = this.voiceCache(core, pinned, options.cache);
    let result: ContextResult;
    if (voiceCache) result = await this.voiceContext(core, voiceCache, pinned, query, timeout, options);
    else if (query !== null) result = await this.turnContext(core, pinned, query, timeout, options);
    else result = await this.pinnedContext(core, pinned, timeout, options);
    if (result.error === null) this.readAnswered(readKey);
    return result;
  }

  private readAnswered(key: string): void {
    this.answeredReads.delete(key);
    this.answeredReads.set(key, true);
    while (this.answeredReads.size > READ_KEYS_KEPT) {
      const oldest = this.answeredReads.keys().next().value;
      if (oldest === undefined) break;
      this.answeredReads.delete(oldest);
    }
  }

  /**
   * The SDK profile of this key's space: the features it turned on, the claim contract and the summarized
   * type registry, from the local cache, read again once `valid_for_s` has passed. When Niadra does not
   * answer, the last profile read stays in use; `null` when there is none yet, or the space serves none (the
   * SDK then asks again in 10 minutes). Never rejects.
   */
  async profile(): Promise<SdkProfile | null> {
    if (!this.core) return null;
    return this.profileCache.refresh(() => this.api.sdkProfile({ timeout: this.readBudget("navigation") }));
  }

  /**
   * Checks outputs against this claim contract instead of the one the profile serves (a company's own copy,
   * in CI or a local run); `null` goes back to the profile's.
   */
  claimContract(contract: ClaimContractSummary | null): void {
    this.profileCache.claimContract = contract;
  }

  /** The claim contract in force, the profile read first when it is due. */
  async currentContract(): Promise<ClaimContractSummary | null> {
    await this.profile();
    return this.profileCache.contract();
  }

  /**
   * Whether an outbound contact of `purpose` (`marketing`, `service`...) to `handle` may go, by the local
   * copy of the space's suppression list: the opt-out holds with Niadra down, from the last copy read. Only
   * messages the agent starts need it; an answer to the customer is never suppressed.
   *
   * The copy is read on the first call (within `timeouts.navigation`) and again in the background once a
   * minute. With no copy and Niadra out of reach, the purpose decides: `transactional` and `service` go,
   * every other purpose waits; `failOpen` overrides that. A space without a list suppresses nothing.
   */
  async mayContact(handle: Handle, purpose: string, options: { channel?: string; failOpen?: boolean } = {}): Promise<boolean> {
    if (this.core && this.suppressions.due()) {
      const read = this.readSuppressions(this.suppressions.held ? this.timeouts.write : this.readBudget("navigation"));
      if (!this.suppressions.held) await read;
    }
    const checkOptions: { channel?: string | null; failOpen?: boolean } = { channel: options.channel ?? null };
    if (options.failOpen !== undefined) checkOptions.failOpen = options.failOpen;
    return this.suppressions.mayContact(handle, purpose, checkOptions);
  }

  private readSuppressions(budgetMs: number): Promise<void> {
    return this.suppressions.read(
      {
        salt: () => this.api.suppressionSalt({ timeout: this.readBudget("navigation") }),
        page: (cursor, limit) => this.api.suppressions({ cursor, limit }, { timeout: this.readBudget("navigation") }),
      },
      budgetMs,
    );
  }

  /**
   * Reads the local copy of the suppression list in the background when it is due: a check that Niadra does not
   * answer falls back on it, so an opt-out holds through an outage.
   */
  private keepSuppressions(): void {
    if (this.core && this.suppressions.due()) void this.readSuppressions(this.timeouts.write);
  }

  /**
   * The build a turn runs on, for `conversation.turn({ build })`: each prompt's version, the digest of the
   * corpus the agent consults (computed by you, never the files), the model, your context assembler's version
   * and your tools' schema digests. A replay compares them before it runs.
   */
  static build(pins: TurnPins): TurnPins {
    return { ...pins };
  }

  build(pins: TurnPins): TurnPins {
    return Niadra.build(pins);
  }

  /**
   * Records each call of a tool of yours in the turn it runs in: arguments, result, latency and failure, and
   * with `provenance` the objects the result showed. Outside a turn the tool runs untouched. `dryRun` lets a
   * replay run it for real when the record has no answer.
   */
  static tool<A extends unknown[], R>(name: string, fn: (...args: A) => R, options: RecordedToolOptions<A, R> = {}): (...args: A) => R {
    return recordTool(name, fn, options);
  }

  /** `Niadra.tool`, with this client's SDK profile as the fields a masked output hides and the bindings it serves. */
  tool<A extends unknown[], R>(name: string, fn: (...args: A) => R, options: RecordedToolOptions<A, R> = {}): (...args: A) => R {
    return recordTool(name, fn, {
      access: () => this.profileCache.fieldAccess(),
      served: (tool) => this.profileCache.toolBinding(tool),
      ...options,
    });
  }

  /**
   * The contact token's offline check for a gateway of yours: its id, the space's id and the key it shares
   * with Niadra. The space's public keys are read through this client and kept; `seen` shares the tokens let
   * through between processes.
   */
  contactGateway(gatewayId: string, options: { space: string; key: string | Uint8Array; seen?: SeenTokens }): ContactGateway {
    const gateway: ConstructorParameters<typeof ContactGateway>[1] = {
      space: options.space,
      key: options.key,
      read: () => this.api.contactKeys({ space: options.space }),
    };
    if (options.seen) gateway.seen = options.seen;
    return new ContactGateway(gatewayId, gateway);
  }

  /**
   * Whether `value` may be claimed for `field` of the object `ref` (`type:namespace:id`) now: Niadra's
   * verdict, and when that is not safe, a fresh read by your resolver of the type, all within `budgetMs`
   * (300 ms). Never a stale value as verified; never rejects.
   */
  async verifyClaim(ref: StateRef | string, field: string, value: unknown, options: { subject?: Handle; budgetMs?: number } = {}): Promise<ClaimVerdict> {
    const target = asRef(ref);
    const budget = options.budgetMs ?? CLAIM_BUDGET_MS;
    const deadline = Date.now() + budget;
    let verdict = null;
    if (this.core) {
      try {
        const body = { checks: [{ ref: target, field, value }], ...(options.subject ? { subject: options.subject } : {}) };
        const answer: StateVerifyResponse = await this.api.stateVerify(body, { timeout: budget });
        verdict = answer.verdicts[0] ?? null;
      } catch {
        verdict = null;
      }
    }
    if (verdict !== null && (verdict.claim_safe || !this.resolvers.available(target.type))) return fromNiadra(verdict);
    const left = deadline - Date.now();
    const resolved = left > 0 ? await this.resolvers.resolve(target, [field], left) : null;
    return fromResolver(target, field, value, resolved, verdict);
  }

  /** What a conversation or a task needs of its client for the agent features. */
  get agentHost(): AgentHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getter below reads the budget when used
    const client = this;
    return {
      recorder: this.turns,
      coordinator: this.coordinator,
      states: this.states,
      contract: () => this.currentContract(),
      internalText: this.internalText,
      check: (request, timeoutMs) => {
        if (request.direction === "outbound") this.keepSuppressions();
        return this.api.check(request, { timeout: timeoutMs });
      },
      claim: (request, timeoutMs) => this.api.claim(request, {}, { timeout: timeoutMs }),
      verifyClaim: (ref, field, value, options) => this.verifyClaim(ref, field, value, options),
      enabled: this.enabled,
      strict: this.strict,
      get navigationMs() {
        return client.readBudget("navigation");
      },
    };
  }

  /**
   * Starts a voice conversation's first read now, in the background: call it when the call starts
   * (ringing, the inbound webhook, the caller joining), so the read runs while the call is set up.
   * It is bounded by `timeouts.contextVoiceStart`. The `context()` calls that follow, with the same
   * arguments, take its pack instead of starting their own read; a turn that finds it still
   * running waits for it only within its own budget. `true` when the read runs or its pack is
   * already here; `false` outside the voice read path (another view, no conversation or task id,
   * the cache or `voice` off). Never throws, unless `strict` is set.
   */
  begin(params: Omit<ContextParams, "query" | "turn" | "delta">): boolean {
    const core = this.core;
    if (!core) return false;
    let request: ContextRequest;
    try {
      request = buildContextRequest({ view: "voice", ...params });
    } catch (error) {
      const failure = toNiadraError(error);
      if (this.strict) throw failure;
      this.logger.warn(`begin failed: ${describe(failure)}`);
      return false;
    }
    const cache = this.voiceCache(core, request, undefined);
    if (!cache) return false;
    const key = cacheKey(request);
    const line = this.voice.line(cacheScope(request) ?? "");
    this.startVoice(core);
    line.request = request;
    if (!cache.has(key) && line.inFlight().length === 0) {
      this.voiceRead(core, cache, line, key, request, null, this.timeouts.contextVoiceStart);
    }
    return true;
  }

  /**
   * What is left of `timeouts.contextVoiceStart` for the first read of a conversation's voice line,
   * for `ready()`; `undefined` without one.
   */
  startBudget(scope: string): number | undefined {
    const first = this.voice.find(scope)?.reads[0];
    if (!first) return undefined;
    return Math.max(0, this.timeouts.contextVoiceStart - (Date.now() - first.startedAt));
  }

  /** The round trip to the region in milliseconds, measured once with the first voice read; `null` before. */
  get rtt(): number | null {
    return this.voice.rtt;
  }

  /**
   * Items that will never reach memory and that no caller heard about: what `track()` and `action()` queued,
   * or a write that stayed queued after its caller stopped waiting, when the queue was full or the API
   * refused it, the whole batch or the item alone in a 207 (`unknown_object`, say).
   */
  get dropped(): number {
    return this.core?.queue.dropped ?? 0;
  }

  /** `dropped` by reason: `queue_full`, or the code the API refused the item with. */
  get droppedByReason(): Record<string, number> {
    return this.core?.queue.droppedByReason ?? {};
  }

  /**
   * Sends a partial transcript of the customer's turn while they are still speaking, to
   * `POST /v1/context/prefetch`. The server reads it the way it will read the final turn and warms
   * what that read needs, so the `context()` that answers the turn spends less of its
   * budget. It runs in the background: it returns at once, never rejects and never holds a turn.
   * `true` when it was sent or queued: while one runs for the same conversation, the newest text
   * waits and goes when it ends, and older waiting texts are dropped. `false` when there was
   * nothing worth sending (blank or very short text).
   */
  prefetch(params: PrefetchParams, options: RequestOptions = {}): boolean {
    const core = this.core;
    const text = turnText(params.text);
    if (!core || !text || text.length < MIN_PREFETCH) return false;
    let body: PrefetchRequest;
    try {
      body = buildPrefetchRequest({ ...params, text });
    } catch {
      return false;
    }
    const scope = cacheScope(body) ?? "";
    this.heard(core, scope, text);
    if (this.prefetching.has(scope)) {
      this.prefetching.set(scope, body); // the newest text waits for the one in flight
      return true;
    }
    this.prefetching.set(scope, null);
    void this.sendPrefetches(core, scope, body, options);
    return true;
  }

  /** Sends one prefetch, then the newest text that arrived meanwhile, until none is waiting. */
  private async sendPrefetches(core: Core, scope: string, first: PrefetchRequest, options: RequestOptions): Promise<void> {
    let body: PrefetchRequest | null = first;
    while (body) {
      try {
        await core.transport.request<unknown>(this.readSpec("POST", "/v1/context/prefetch", body, this.timeouts.prefetch, options));
      } catch (error) {
        this.logger.debug(`prefetch skipped: ${describe(toNiadraError(error))}`);
      }
      body = this.prefetching.get(scope) ?? null;
      if (body) this.prefetching.set(scope, null);
      else {
        body = null;
        this.prefetching.delete(scope);
      }
    }
  }

  /** A read without the turn: the conversation's pinned pack, from the cache when it is fresh. */
  private async pinnedContext(core: Core, request: ContextRequest, timeout: number, options: ContextOptions): Promise<ContextResult> {
    const cache = options.cache === false ? null : core.cache;
    const scope = cacheScope(request);

    if (!cache || !scope) {
      try {
        const response = await this.fetchContext(core, request, timeout, options.signal, options.headers);
        return resultFrom(response, "network");
      } catch (error) {
        const failure = toNiadraError(error);
        this.observeAuth(failure, null);
        return this.contextFailure(failure, null);
      }
    }

    const key = cacheKey(request);
    const hit = cache.lookup(key);
    if (hit?.freshness === "fresh") return resultFrom(delivered(hit.response, cache.take(key)), "cache", null, cache.age(key));
    if (hit?.freshness === "stale") {
      this.revalidate(core, cache, key, scope, request, timeout, options.headers).catch((error: unknown) => {
        this.logger.debug(`background context refresh failed: ${describe(toNiadraError(error))}`);
      });
      return resultFrom(delivered(hit.response, cache.take(key)), "stale", null, cache.age(key));
    }

    try {
      const pending = this.revalidate(core, cache, key, scope, request, timeout, options.headers);
      const { response, source } = await abortable(pending, options.signal);
      return resultFrom(delivered(response, cache.take(key)), source, null, source === "network" ? 0 : cache.age(key));
    } catch (error) {
      const failure = toNiadraError(error);
      const fallback = cache.lookup(key);
      return this.contextFailure(failure, fallback ? delivered(fallback.response, cache.take(key)) : null, cache.age(key));
    }
  }

  /**
   * A read that sends the customer's turn: always asked of the API, since the slots are this
   * turn's. The pack is the conversation's pinned one: cached as the read without `query`, and
   * served from there when the read fails; the slots stay on this answer only.
   */
  private async turnContext(
    core: Core,
    request: ContextRequest,
    query: string,
    timeout: number,
    options: ContextOptions,
  ): Promise<ContextResult> {
    const cache = options.cache === false ? null : core.cache;
    const scope = cacheScope(request);
    const key = cache && scope ? cacheKey(request) : null;
    const cached = cache && key ? cache.lookup(key) : null;
    const generation = cache?.generation ?? 0;
    // A `not_modified` answer carries no `pack`, so a read as data asks for the whole answer.
    const known = cached && request.format !== "json" ? { known_etag: cached.response.etag } : {};
    let response: ContextResponse;
    try {
      response = await this.fetchContext(core, { ...request, query, ...known }, timeout, options.signal, options.headers);
    } catch (error) {
      const failure = toNiadraError(error);
      this.observeAuth(failure, key);
      const fallback = cache && key ? cache.lookup(key) : null;
      return this.contextFailure(failure, cache && key && fallback ? delivered(fallback.response, cache.take(key)) : null, key ? (cache?.age(key) ?? null) : null);
    }
    if (!cache || !key || !scope) return resultFrom(response, "network");
    if (response.degraded && !response.not_modified && cached) {
      // A degraded answer never replaces a good pack; the good one is served, with this turn's slots.
      return resultFrom(delivered({ ...cached.response, slots: response.slots ?? null }, cache.take(key)), "fallback", null, cache.age(key));
    }
    const merged = response.not_modified && cached ? mergeNotModified(cached.response, response) : response;
    cache.store(key, scope, withoutSlots(merged), generation);
    return resultFrom(delivered(merged, cache.take(key)), "network");
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
      return this.readSpec("POST", "/v1/history/search", params, this.readBudget("navigation"), options);
    });
  }

  /** The customer's history, newest first, one line per item, paginated by cursor. */
  async timeline(params: TimelineRequest, options: RequestOptions = {}): Promise<Result<TimelineResponse>> {
    return this.navigate(() =>
      this.readSpec("POST", "/v1/history/timeline", params, this.readBudget("navigation"), options),
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
      if (params.about) body.about = params.about;
      if (params.verification) body.verification = params.verification;
      if (params.conversation_id) body.conversation_id = params.conversation_id;
      return this.readSpec("POST", "/v1/history/open", body, this.readBudget("navigation"), options);
    });
  }

  /**
   * A business object as a `display` state read serves it: each field its systems of record reported, with
   * its logical value, stamps and freshness, under this source's purpose (the object state spec). A type the
   * space does not declare reads as one with no rules.
   *
   * @example
   * const { data: invoice } = await niadra.objectState("invoice:erp:0823");
   */
  async objectState(object: ObjectRef | string, options: RequestOptions = {}): Promise<Result<ObjectRead>> {
    return this.navigate(() => this.readSpec("GET", objectPath(object), undefined, this.readBudget("navigation"), options));
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
      const spec = this.readSpec("GET", path, undefined, this.readBudget("navigation"), options);
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
        // The bound customer goes along, so the server opens only an item of theirs, or of the organization
        // they act for when the kit is bound to one (`about`), as the pack's account block shows it.
        const scope: OpenParams = { subject: customer };
        if (bound.about) scope.about = bound.about;
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

    const readKey = `agent-memory:${key}`;
    const first = !this.answeredReads.has(readKey);
    const timeout = options.timeout ?? (params.view === "voice" ? this.timeouts.contextVoice : this.readBudget("context", first));
    const spec = this.readSpec("GET", "/v1/agent-memory/block", undefined, timeout, { ...options, voice: params.view === "voice" });
    spec.query = {
      max_tokens: String(params.max_tokens ?? 300),
      view: params.view,
      ...(params.tags?.length ? { tags: params.tags } : {}),
    };
    const etag = cache?.etag(key);
    if (etag) spec.headers = { ...options.headers, "if-none-match": etag };
    try {
      const response = await core.transport.request<AgentMemoryBlock>(spec);
      this.readAnswered(readKey);
      cache?.store(key, response.data);
      return blockResult(response.data, "network");
    } catch (error) {
      const failure = toNiadraError(error);
      if (failure instanceof NiadraAPIError && failure.status === 304) {
        const current = cache?.touch(key);
        if (current) return blockResult(current, "network");
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
      return this.readSpec("POST", "/v1/agent-memory/search", body, this.readBudget("navigation"), options);
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
   * How the space's agents used the context they read (`GET /v1/context-use`): sessions, deliveries, use,
   * repetition, transfers and recontact, with intervals, grouped by `group_by`. A key of an `analyst` source
   * with the `analytics` scope reads every source of the space; a key with `admin` reads its own source.
   */
  contextUse(params: ContextUseParams = {}, options: RequestOptions = {}): Promise<Result<ContextUseReport>> {
    return this.navigate(() => {
      const { group_by: groups, ...filters } = params;
      const query: Record<string, string | string[] | undefined> = { ...filters };
      if (groups?.length) query.group_by = groups;
      return { ...this.readSpec("GET", "/v1/context-use", undefined, this.timeouts.write, options), query };
    });
  }

  /**
   * Links a person to the organization they act for (an account or a partner), as a system of record that
   * knows who works for whom: a CRM, an HR system. Needs a key with the `identity:link` scope (or `admin`);
   * `can_see_contacts` needs `admin`. Reads with `about` reach the organization through the link.
   */
  link(
    params: Omit<LinkRequest, "method"> & { method?: LinkMethod; idempotency_key?: string },
    options: RequestOptions = {},
  ): Promise<Result<Link>> {
    const { idempotency_key: key, ...rest } = params;
    const body: LinkRequest = { can_see_contacts: false, method: "system_import", ...rest };
    return this.navigate(() => this.writeSpec("/v1/identity/links", body, key ?? uuidv7(), options));
  }

  /**
   * Ends a link, from `valid_to` (now when absent): the person no longer acts for the organization, and reads
   * with `about` for the pair go on with the person's own memory. Needs `identity:link` or `admin`.
   */
  endLink(
    linkId: string,
    params: { valid_to?: string; idempotency_key?: string } = {},
    options: RequestOptions = {},
  ): Promise<Result<Link>> {
    return this.navigate(() => {
      if (!linkId) throw new NiadraValidationError("endLink() needs a link id");
      const body = params.valid_to ? { valid_to: params.valid_to } : {};
      const path = `/v1/identity/links/${encodeURIComponent(linkId)}/end`;
      return this.writeSpec(path, body, params.idempotency_key ?? uuidv7(), options);
    });
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
   * Whether what was sent for a conversation or task became memory yet: `open` (still receiving
   * turns), `processing`, `ready` (memory applies it in seconds), `failed` or `unknown`. States and
   * times only. Call `flush()` first if the turns went through `track()`.
   */
  async ingestStatus(
    thread: { conversation_id: string } | { task_id: string },
    options: RequestOptions = {},
  ): Promise<Result<IngestStatus>> {
    return this.navigate(() => {
      if (("conversation_id" in thread) === ("task_id" in thread)) {
        throw new NiadraValidationError("pass exactly one of conversation_id or task_id");
      }
      return this.readSpec("POST", "/v1/ingest/status", thread, this.timeouts.write, options);
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
    const conversation = new Conversation(this, params, {
      endConversation: (id) => this.endScope(buildConversationEnded(id), `conversation:${id}`),
    });
    this.warm(`conversation:${conversation.id}`, conversation);
    return conversation;
  }

  /** A helper for one internal-agent task: binds `task_id` to reads and writes and emits `task.ended`. */
  task(params: TaskParams): Task {
    const task = new Task(this, params, {
      endTask: (id) => this.endScope(buildTaskEnded(id), `task:${id}`),
      verifyTask: (verify) => this.verifyWith(verify),
    });
    this.warm(`task:${task.id}`, task);
    return task;
  }

  /**
   * Sends every queued event and resolves when done. Call it before a serverless function
   * returns, or pass it to `waitUntil()` on edge runtimes. Rejects only with `strict` set.
   */
  async flush(): Promise<void> {
    if (!this.core) return;
    await this.turnSender?.flush();
    await this.outbox.flush();
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
    clearInterval(this.warmTimer);
    this.warmTimer = undefined;
    if (!this.core) return;
    await this.turnSender?.stop(this.timeouts.write);
    await this.outbox.stop(this.timeouts.write);
    const report = await this.core.queue.close();
    this.core.cache?.clear();
    this.voice.clear();
    const [first] = report.errors;
    if (this.strict && first) throw first;
  }

  private async verifyWith(params: Omit<VerifyParams, "handle"> & { handle: Handle | undefined }): Promise<WriteResult> {
    const result = await this.sendNow(() => buildVerify(params));
    if (result.ok) {
      if (params.conversation_id) this.forgetScope(`conversation:${params.conversation_id}`, false);
      if (params.task_id) this.forgetScope(`task:${params.task_id}`, false);
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

  private voiceBudget(voice: boolean): ReadOptions {
    return voice ? { timeout: this.timeouts.navigationVoice, voice: true } : {};
  }

  private readSpec(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    defaultTimeout: number,
    options: ReadOptions,
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
    return voiced(spec, options.voice === true);
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

  /** Sends one route as `niadra.api` does, for the SDK's own modules (the replay runner, the resolver worker). */
  callRoute<T>(route: Route, options: RequestOptions = {}): Promise<T> {
    return this.route(route, options);
  }

  /** One route of `niadra.api`: the error rejects, whatever `strict` says. */
  private async route<T>(route: Route, options: RequestOptions): Promise<T> {
    if (!this.core) throw this.disabledError();
    const timeout = options.timeout ?? this.timeouts.write;
    const key = route.idempotencyKey;
    const query: Record<string, string> = {};
    for (const [name, value] of Object.entries(route.query ?? {})) if (value != null) query[name] = String(value);
    const spec: RequestSpec = {
      method: route.method,
      path: route.path,
      query,
      headers: { ...options.headers, ...(key ? { "idempotency-key": key } : {}) },
      timeoutMs: timeout,
      // Only a keyed write is sent again after a failure: the key makes the repeat harmless.
      retry: key ? { ...this.core.writes, totalMs: timeout } : READ_POLICY,
      signal: options.signal,
    };
    if (route.body !== undefined) spec.body = route.body;
    try {
      return (await this.core.transport.request<T>(spec)).data;
    } catch (error) {
      const failure = toNiadraError(error);
      this.observeAuth(failure, null);
      throw failure;
    }
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
    const started = Date.now();
    // A voice read keeps its budget whatever the connection (`RequestSpec.ceilingMs`).
    const voice = request.view === "voice";
    try {
      const response = await core.transport.request<unknown>(this.readSpec("POST", "/v1/context", request, timeout, { signal, headers, voice }));
      return normalizeContext(response.data, request.include ?? undefined);
    } catch (error) {
      // A space that serves none of the blocks answers 404: the read goes on without them. `/v1/context` also
      // answers 404 for an object or a profile it does not know, so the blocks count as refused only when the
      // read without them answers; otherwise every read of this client would go without its constraints.
      const refused = error instanceof NiadraAPIError && error.status === 404;
      const left = timeout - (Date.now() - started);
      if (!request.include?.length || !refused || left <= 0) throw error;
      const { include: _dropped, ...plain } = request;
      const response = await core.transport.request<unknown>(this.readSpec("POST", "/v1/context", plain, left, { signal, headers, voice }));
      for (const name of request.include) this.refusedBlocks.set(name, Date.now() + BLOCK_RECHECK_AFTER_MS);
      return normalizeContext(response.data);
    }
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

  private contextFailure(error: NiadraError, fallback: ContextResponse | null, ageMs: number | null = null): ContextResult {
    if (this.strict) throw error;
    if (fallback) {
      this.logger.warn(`context request failed, serving the last good pack: ${describe(error)}`);
      return resultFrom(fallback, "fallback", error, ageMs);
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

  /**
   * Drops a conversation's packs; when it `ended`, its voice line too, else only the line's reads
   * (they were made for the pack being dropped).
   */
  private forgetScope(scope: string, ended = true): void {
    this.core?.cache?.deleteScope(scope);
    if (ended) this.voice.drop(scope);
    else this.voice.find(scope)?.reset();
  }

  // The voice read path (voice.ts).

  /** The cache a read goes through on the voice read path, or `null` when it does not take that path. */
  private voiceCache(core: Core, request: ContextRequest, cache: boolean | undefined): ContextCache | null {
    const onPath = this.voice.options.enabled && request.view === "voice" && cache !== false && cacheScope(request) !== null;
    return onPath ? core.cache : null;
  }

  /** Measures the round trip to the region once per client, in the background. */
  private probe(core: Core): void {
    if (!this.voice.claimProbe()) return;
    this.measuring = true;
    void (async () => {
      const samples: number[] = [];
      // The first may pay for the connection; the second is the round trip.
      for (let i = 0; i < 2; i++) {
        const started = Date.now();
        try {
          await core.transport.request<unknown>({
            method: "GET",
            path: "/healthz",
            timeoutMs: 2_000,
            retry: { kind: "read", maxAttempts: 1 },
          });
        } catch (error) {
          this.logger.debug(`round trip probe failed: ${describe(toNiadraError(error))}`);
          this.measuring = false;
          return;
        }
        samples.push(Date.now() - started);
      }
      const rtt = Math.min(...samples);
      this.voice.rtt = rtt;
      this.measuring = false;
      this.logger.debug(`round trip to the region ${Math.round(rtt)} ms`);
      const explicit = (["context", "navigation"] as const).filter((name) => !this.defaultReads.has(name));
      for (const warning of budgetWarnings(rtt, this.timeouts, explicit)) this.logger.warn(warning);
      if (this.voiceStarted) this.warnVoice();
    })();
  }

  /**
   * A read budget: one the caller left at its default is what the API may take, and the measured round trip
   * to the region goes on top, so an agent far from the region (Sao Paulo, 170 ms from us-east-2) is not
   * timed out by the network; one the caller set is a ceiling.
   */
  private readBudget(name: "context" | "navigation", first = false): number {
    if (!this.defaultReads.has(name)) return this.timeouts[name];
    // A first read of a key may take the compile of its pack (`timeouts.contextFirst`).
    const base = first && name === "context" ? Math.max(this.timeouts.context, this.timeouts.contextFirst) : this.timeouts[name];
    const rtt = this.voice.rtt;
    if (rtt !== null) return base + rtt;
    // While the probe is on its way, `connect` on top: a read made right after the client starts timed out at
    // the bare default from Sao Paulo (03/10/2026). With no connection open the transport adds it itself, never
    // twice; a probe that failed leaves the defaults as they are.
    const open = this.core?.transport.connectionOpen() ?? false;
    return this.measuring && open ? base + this.timeouts.connect : base;
  }

  /** The client reads in voice: the voice budgets' warnings matter from now on. */
  private startVoice(core: Core): void {
    this.voiceStarted = true;
    this.probe(core);
    this.warnVoice();
  }

  private warnVoice(): void {
    const rtt = this.voice.rtt;
    if (this.voiceWarned || rtt === null) return;
    this.voiceWarned = true;
    for (const warning of rttWarnings(rtt, this.timeouts)) this.logger.warn(warning);
  }

  /**
   * A voice turn: the pinned body from memory, and the slots of the read of its words when that
   * read lands within `timeout`. See `voice.ts`.
   */
  private async voiceContext(
    core: Core,
    cache: ContextCache,
    request: ContextRequest,
    query: string | null,
    timeout: number,
    options: ContextOptions,
  ): Promise<ContextResult> {
    const scope = cacheScope(request) ?? "";
    const key = cacheKey(request);
    const deadline = Date.now() + timeout;
    const line = this.voice.line(scope);
    this.startVoice(core);
    line.request = request;
    const words = wordsOf(query);
    const background = this.timeouts.prefetch;
    try {
      let opening: TurnRead[] = [];
      if (!cache.has(key)) {
        opening = line.inFlight();
        if (opening.length === 0) opening = [this.voiceRead(core, cache, line, key, request, query, background)];
        await waitFor(opening, deadline, options.signal, () => cache.has(key));
        if (!cache.has(key)) {
          const failed = opening.find((read) => read.failed)?.failed ?? new NiadraTimeoutError(timeout);
          return this.contextFailure(failed, null);
        }
      }
      let chosen: TurnRead | null = null;
      let asked = opening.length > 0;
      if (words.length > 0) {
        let candidates = line.covering(words, this.voice.options.minCoverage);
        if (candidates.length === 0) {
          candidates = [this.voiceRead(core, cache, line, key, request, query, background)];
          asked = true;
        }
        const [newest] = candidates;
        if (newest && !newest.done) await waitFor([newest], deadline, options.signal);
        chosen = candidates.find((read) => read.done && read.result) ?? null;
        if (!chosen && newest?.failed && this.strict) throw newest.failed;
      }
      const hit = cache.lookup(key);
      if (!hit) return this.contextFailure(new NiadraTimeoutError(timeout), null);
      // A read this turn started revalidates the body; without one, an old body is revalidated now.
      if (hit.freshness !== "fresh" && !asked && line.inFlight().length === 0) {
        this.revalidate(core, cache, key, scope, request, background, options.headers).catch((error: unknown) => {
          this.logger.debug(`background context refresh failed: ${describe(toNiadraError(error))}`);
        });
      }
      const response = compose(delivered(hit.response, cache.take(key)), chosen);
      // A body this call waited for came over the network; otherwise it was already in memory.
      return resultFrom(response, opening.length > 0 ? "network" : hit.freshness === "fresh" ? "cache" : "stale", null, cache.age(key));
    } catch (error) {
      const failure = toNiadraError(error);
      const fallback = cache.lookup(key);
      return this.contextFailure(failure, fallback ? delivered(fallback.response, cache.take(key)) : null, cache.age(key));
    }
  }

  /** Starts one read of a line in the background. */
  private voiceRead(
    core: Core,
    cache: ContextCache,
    line: VoiceLine,
    key: string,
    request: ContextRequest,
    query: string | null,
    timeout: number,
    speculative = false,
  ): TurnRead {
    const text = turnText(query);
    const etag = cache.etag(key);
    // A `not_modified` answer carries no `pack`, so a read as data asks for the whole answer.
    const known = etag && request.format !== "json" ? { known_etag: etag } : {};
    const body: ContextRequest = { ...request, ...(text ? { query: text } : {}), ...known };
    const generation = cache.generation;
    const scopeEpoch = cache.scopeEpoch(line.scope);
    const read: TurnRead = {
      words: wordsOf(text),
      startedAt: Date.now(),
      speculative,
      settled: Promise.resolve(),
      result: null,
      failed: null,
      done: false,
    };
    line.add(read);
    read.settled = (async () => {
      try {
        const response = await this.fetchContext(core, body, timeout, undefined, undefined);
        const cached = cache.lookup(key);
        // A degraded answer never replaces a good pack.
        if (!(response.degraded && !response.not_modified && cached)) {
          const merged = response.not_modified && cached ? mergeNotModified(cached.response, response) : response;
          cache.store(key, line.scope, { ...withoutSlots(merged), guards: [] }, generation, scopeEpoch);
        }
        read.result = response;
      } catch (error) {
        const failure = toNiadraError(error);
        this.observeAuth(failure, key);
        read.failed = failure;
        this.logger.debug(`voice read failed: ${describe(failure)}`);
      } finally {
        read.done = true;
        if (line.speculating === read) {
          line.speculating = null;
          const following = line.waiting;
          line.waiting = null;
          if (following !== null && !line.closed) this.speculate(core, line, following);
        }
      }
    })();
    return read;
  }

  /** A partial transcript of a voice line: read the turn with it once it has settled. */
  private heard(core: Core, scope: string, text: string): void {
    const line = this.voice.find(scope);
    if (!line || line.closed || !line.request) return;
    if (text !== line.heard) {
      line.heard = text;
      line.heardAt = Date.now();
    }
    if (!line.timer) this.arm(core, line, this.voice.options.settleMs);
  }

  private arm(core: Core, line: VoiceLine, delay: number): void {
    line.timer = setTimeout(() => {
      line.timer = null;
      this.settle(core, line);
    }, Math.max(0, delay));
    unref(line.timer);
  }

  private settle(core: Core, line: VoiceLine): void {
    if (line.closed || line.heard === null) return;
    const left = line.heardAt + this.voice.options.settleMs - Date.now();
    if (left > 0) {
      this.arm(core, line, left);
      return;
    }
    const text = line.heard;
    line.heard = null;
    this.speculate(core, line, text);
  }

  /** Reads the turn with a settled partial: one such read in flight per line, the newest text next. */
  private speculate(core: Core, line: VoiceLine, text: string): void {
    const words = wordsOf(text);
    const request = line.request;
    const cache = core.cache;
    if (line.closed || !request || !cache || words.length === 0 || line.alreadyRead(words)) return;
    if (line.speculating && !line.speculating.done) {
      line.waiting = text;
      return;
    }
    line.speculating = this.voiceRead(core, cache, line, cacheKey(request), request, text, this.timeouts.prefetch, true);
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
    const played = replaying();
    if (played !== null) {
      played.muted(item);
      return "idempotency_key" in item ? item.idempotency_key : null;
    }
    const accepted = this.core.queue.push(item);
    return accepted && "idempotency_key" in item ? item.idempotency_key : null;
  }

  private async sendTurns(core: Core, body: { bytes: Uint8Array<ArrayBuffer>; gzip: boolean }): Promise<TurnsResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (body.gzip) headers["content-encoding"] = "gzip";
    const spec: RequestSpec = { method: "POST", path: "/v1/turns", bytes: body.bytes, headers, timeoutMs: this.timeouts.write, retry: { ...core.writes, maxAttempts: 1 } };
    return (await core.transport.request<TurnsResponse>(spec)).data;
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
      const settle = (error: NiadraError | null): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        if (!error) resolve({ ok: true, idempotency_key: key, error: null });
        else if (this.strict) reject(error);
        else resolve({ ok: false, idempotency_key: key, error });
        return true;
      };
      core.queue.push(item, settle);
      core.queue.flushInBackground(true);
    });
  }

  /** Notes an open conversation or task; the first one starts the keep-warm timer (`warm.ts`). */
  private warm(scope: string, session: object): void {
    const core = this.core;
    if (!core || !this.keepWarm.enabled) return;
    this.keepWarm.add(scope, session, Date.now());
    if (this.warmTimer !== undefined) return;
    const timer = setInterval(() => {
      this.warmTick(core);
    }, KEEP_WARM_EVERY_MS);
    // Never what keeps a Node process alive.
    (timer as { unref?: () => void }).unref?.();
    this.warmTimer = timer;
  }

  private warmTick(core: Core): void {
    const step = this.keepWarm.step(Date.now(), core.transport.lastActivityAt);
    if (step === "stop") {
      clearInterval(this.warmTimer);
      this.warmTimer = undefined;
      return;
    }
    if (step !== "ping") return;
    core.transport
      .request<unknown>({
        method: "GET",
        path: "/healthz",
        timeoutMs: 2_000,
        retry: { kind: "read", maxAttempts: 1 },
        activity: false,
      })
      .catch((error: unknown) => {
        this.logger.debug(`keep-warm ping failed: ${describe(toNiadraError(error))}`);
      });
  }

  private async endScope(item: BatchItem & { idempotency_key: string }, scope: string): Promise<WriteResult> {
    // What the SDK kept for the conversation goes now, not once the server confirmed the end.
    this.forgetScope(scope);
    this.keepWarm.end(scope);
    return this.sendNow(() => item);
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
      return {
        accepted: data?.accepted ?? items.length,
        duplicates: data?.duplicates ?? 0,
        errors: data?.errors ?? [],
        masked: data?.masked ?? {},
      };
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
/** The answer as the SDK keeps it, with the blocks the read asked by `include` (`ContextResult.unreadBlocks`). */
function normalizeContext(data: unknown, asked?: Include[]): ServedContext {
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
    asked_blocks: asked ?? [],
    // A read without a turn may send a pack without `slots`: the list is then empty.
    ...(body.pack ? { pack: { ...body.pack, slots: Array.isArray(body.pack.slots) ? body.pack.slots : [] } } : {}),
  };
}

/** Exactly what the signature covers; a server that names nothing still signs the content type. */
function uploadHeaders(named: Record<string, string> | undefined, contentType: string): Record<string, string> {
  return named && Object.keys(named).length > 0 ? { ...named } : { "content-type": contentType };
}

/** What the cache keeps of an answer: never the slots, which belong to the turn that asked. */
function withoutSlots(response: ContextResponse): ContextResponse {
  const pack = response.pack ? { ...response.pack, slots: [] } : response.pack;
  return { ...response, slots: null, ...(pack === undefined ? {} : { pack }) };
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

/**
 * Resolves when one of `reads` is done (with `until`, once it holds), at `deadline`, or rejects
 * when `signal` aborts. The reads go on either way.
 */
async function waitFor(
  reads: TurnRead[],
  deadline: number,
  signal: AbortSignal | undefined,
  until?: () => boolean,
): Promise<void> {
  for (;;) {
    const pending = reads.filter((read) => !read.done);
    const left = deadline - Date.now();
    if (pending.length === 0 || left <= 0 || until?.()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, left);
    });
    try {
      await abortable(Promise.race([...pending.map((read) => read.settled), expiry]), signal);
    } finally {
      clearTimeout(timer);
    }
    if (!until) return;
  }
}

