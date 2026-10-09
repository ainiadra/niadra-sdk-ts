import type { TurnRecordingOptions } from "./capture/recorder.js";
import type { Logger } from "./logger.js";

/**
 * Per-method time budgets in milliseconds. They are the SDK's own and deliberately short:
 * managed agent platforms allow 7 to 10 seconds per turn and self-hosted frameworks allow no
 * limit at all, so a slow memory call must never become a slow agent.
 *
 * `context` and `navigation` left at their defaults are what the API may take: the client measures
 * the round trip to the region once when it starts (`VoiceOptions.probe`) and adds it on top, so an
 * agent far from the region (Sao Paulo is 170 ms from us-east-2) is not timed out by the network.
 * A value you set is a ceiling the SDK keeps; when the measured round trip plus 50 ms exceeds it,
 * the client logs one warning, since every such read would run out of time. While the probe is on its
 * way, `connect` goes on top of them instead; a probe that failed, or `probe: false`, leaves them as they are.
 */
export interface Timeouts {
  /** `context()` for every view except `voice`. */
  context: number;
  /**
   * `context()` with `view: "voice"`, where the budget is a fraction of a spoken turn. In a voice
   * conversation the pinned pack is read once and then served from memory, so this is not a round
   * trip: it is the most a turn waits for the read of its own words that a prefetch already
   * started (see `voice.ts`). That read starts when the partial transcript has been still for
   * `VoiceOptions.settleMs` (200 ms) and the platform ends the turn later (LiveKit waits at least
   * 500 ms of silence): about 300 ms of head start. With 200 ms of wait on top, the turn gets its
   * slots while round trip plus server time stay under 500 ms, a round trip of up to about 400 ms
   * at the server's p95. A longer wait would be heard: 200 ms is the usual gap between two
   * people's turns.
   */
  contextVoice: number;
  /**
   * The default budget of the first read of a conversation, task or object in this client, before the round
   * trip: the API compiles its pack on that read. One right after a customer's first message took 410 ms on
   * the server (05/10/2026: resolving the customer 153 ms, the pack 120 ms), more than `context`, and the
   * agent answered without memory. Later reads of the same key find the pack compiled. Only when `context`
   * is left at its default.
   */
  contextFirst: number;
  /**
   * The first read of a voice call, made while the phone rings or the inbound webhook runs
   * (`begin()`, `ready()`). A cold connection costs three round trips (TCP, TLS, the request)
   * plus the server's first compile: 3 x 400 ms + 300 ms at a 400 ms round trip.
   */
  contextVoiceStart: number;
  /** `search()`, `timeline()` and `open()`. */
  navigation: number;
  /** Navigation calls made through a voice conversation or voice-bound tools. */
  navigationVoice: number;
  /**
   * The whole of a write the caller waits for: `identify()`, `verify()`, `handoff()`,
   * `feedback()` and the reservation in `uploadMedia()`, retries included. Also each attempt
   * of a background batch, which never holds a caller.
   */
  write: number;
  /** `subjectToken()`, usually called once when a session starts. */
  token: number;
  /** The whole of sending media bytes to storage in `uploadMedia()`, retries included. */
  upload: number;
  /**
   * `prefetch()`, which runs in the background and never holds a turn, and a voice read that goes
   * on after its turn's budget.
   */
  prefetch: number;
  /**
   * Added once to a call's budget when no connection to the API is likely open (no answer within
   * `keepAliveMs`): TCP and TLS take a few round trips, 300 ms or more from another continent. With a
   * connection open, budgets are exact. 0 never adds it. Never to a voice read: the turn waits for it, so it
   * keeps its own budget and answers empty in time; a call's first read made with `begin()` while it rings is
   * where the connection opens.
   */
  connect: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  context: 300,
  contextFirst: 1_000,
  contextVoice: 200,
  contextVoiceStart: 1_500,
  navigation: 600,
  navigationVoice: 300,
  write: 5_000,
  token: 2_000,
  upload: 60_000,
  prefetch: 1_000,
  connect: 1_000,
};

/**
 * How long Node's `fetch` keeps an idle connection open (undici's default). A turn more than this after
 * the previous call opens a new one.
 */
export const FETCH_KEEPALIVE_MS = 4_000;

/** How `context()` reuses packs inside a conversation. */
export interface CacheOptions {
  /** A pack younger than this is returned without any request. */
  ttlMs: number;
  /**
   * After `ttlMs`, the cached pack is still returned at once for this long while a single
   * background request refreshes it.
   */
  staleWhileRevalidateMs: number;
  /**
   * Oldest pack the SDK will fall back to when a request fails. Older packs are dropped
   * rather than shown to a model as if they were current.
   */
  maxStaleMs: number;
  /** Least recently used packs are evicted past this many conversations. */
  maxEntries: number;
}

export const DEFAULT_CACHE: CacheOptions = {
  ttlMs: 10_000,
  staleWhileRevalidateMs: 10 * 60_000,
  maxStaleMs: 30 * 60_000,
  maxEntries: 1_000,
};

/**
 * The voice read path of a conversation in the `voice` view (see `voice.ts`).
 */
export interface VoiceOptions {
  /** `false` sends every voice turn to the API as the other views do. */
  enabled: boolean;
  /** How long a partial transcript must stay the same before the SDK reads the turn with it. */
  settleMs: number;
  /**
   * A read's slots answer the final turn when the final words start with the partial's and the
   * partial carries at least this share of them.
   */
  minCoverage: number;
  /**
   * Measure the round trip to the region once, with `GET /healthz`, when the client starts: the
   * default read budgets add it (`Timeouts`), and a warning says when a budget you set, or a voice
   * budget once the client reads in voice, cannot hold it. `false` measures nothing.
   */
  probe: boolean;
}

export const DEFAULT_VOICE: VoiceOptions = {
  enabled: true,
  settleMs: 200,
  minCoverage: 0.75,
  probe: true,
};

/** How `track()` and the other write methods batch events on their way to `POST /v1/batch`. */
export interface QueueOptions {
  /** Send as soon as this many items are waiting. */
  flushAt: number;
  /** Send whatever is waiting at least this often. */
  flushIntervalMs: number;
  /**
   * Send a conversation turn (a message with a `conversation_id`) at most this long after it was
   * queued, with whatever else is waiting. It is what the other agents read in `live`, so by
   * default it leaves at once. Turns queued while a batch is in flight leave together as the next
   * batch: a burst costs one request per round trip, never one per turn.
   */
  turnFlushIntervalMs: number;
  /** Items per request. The server accepts up to 500. */
  maxBatchSize: number;
  /** Items held in memory before new ones are dropped. Keeps a long outage from exhausting memory. */
  maxQueueSize: number;
  /**
   * Attempts per send of a batch, including the first. 4xx answers other than 408, 421 and 429 are never
   * retried. A batch still failing after them waits at the front of the queue and goes again after a pause
   * that doubles, up to a minute, while Niadra stays down.
   */
  maxAttempts: number;
  /** First backoff delay; each retry doubles it, with full jitter, up to `maxRetryDelayMs`. */
  retryDelayMs: number;
  maxRetryDelayMs: number;
}

export const DEFAULT_QUEUE: QueueOptions = {
  flushAt: 15,
  flushIntervalMs: 1_000,
  turnFlushIntervalMs: 0,
  maxBatchSize: 100,
  maxQueueSize: 10_000,
  maxAttempts: 3,
  retryDelayMs: 250,
  maxRetryDelayMs: 5_000,
};

export interface ClientOptions {
  /**
   * A source key, `nia_sk_<live|test>_<region>_<space>_<key_id>_<secret>`. Defaults to the
   * `NIADRA_API_KEY` environment variable where one exists. Without a key the client is a
   * no-op: every method resolves with an empty result and nothing is sent.
   */
  apiKey?: string | undefined;
  /**
   * Overrides the address derived from the key, for the local emulator or a private endpoint.
   * Defaults to `NIADRA_BASE_URL`, then to `https://<space>.<region>.api.niadra.com`.
   */
  baseURL?: string | undefined;
  timeouts?: Partial<Timeouts>;
  /** Pass `false` to send every `context()` call to the server. */
  cache?: Partial<CacheOptions> | false;
  queue?: Partial<QueueOptions>;
  /** The voice read path of conversations in the `voice` view. `false` turns it off. */
  voice?: Partial<VoiceOptions> | false;
  /**
   * Throw errors instead of logging them and resolving with an empty result. Meant for tests
   * and development, where a silent failure hides a broken integration.
   */
  strict?: boolean;
  /** Flush queued events when a Node process is about to exit. Defaults to `true`. */
  flushOnExit?: boolean;
  /**
   * While a conversation or task is open and the client was used in the last 10 minutes, keep the connection to
   * the region open with a `GET /healthz` every 100 s of quiet, so a turn after a long pause does not pay for a
   * new connection (`warm.ts`). Defaults to `true`; `false` never pings.
   */
  keepWarm?: boolean;
  /** A `fetch` implementation. Defaults to the global one. */
  fetch?: typeof fetch;
  /**
   * How long your `fetch` keeps an idle connection open: 4 s, undici's default over HTTP/1.1. A `fetch` with an undici
   * `Agent({ keepAliveTimeout: 120_000 })` keeps a conversation's turns on one connection; say so here, and
   * `timeouts.connect` is spent only when a connection really closed.
   */
  keepAliveMs?: number;
  logger?: Logger;
  /** Extra headers sent with every request. */
  defaultHeaders?: Record<string, string>;
  /** Turn recording (`niadra.turns`): the content mode and the bounds of the turn queue. */
  turns?: Partial<TurnRecordingOptions>;
}
