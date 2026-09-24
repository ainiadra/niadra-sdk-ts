import type { Logger } from "./logger.js";

/**
 * Per-method time budgets in milliseconds. They are the SDK's own and deliberately short:
 * managed agent platforms allow 7 to 10 seconds per turn and self-hosted frameworks allow no
 * limit at all, so a slow memory call must never become a slow agent.
 */
export interface Timeouts {
  /** `context()` for every view except `voice`. */
  context: number;
  /** `context()` with `view: "voice"`, where the budget is a fraction of a spoken turn. */
  contextVoice: number;
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
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  context: 300,
  contextVoice: 150,
  navigation: 600,
  navigationVoice: 300,
  write: 5_000,
  token: 2_000,
  upload: 60_000,
};

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

/** How `track()` and the other write methods batch events on their way to `POST /v1/batch`. */
export interface QueueOptions {
  /** Send as soon as this many items are waiting. */
  flushAt: number;
  /** Send whatever is waiting at least this often. */
  flushIntervalMs: number;
  /** Items per request. The server accepts up to 500. */
  maxBatchSize: number;
  /** Items held in memory before new ones are dropped. Keeps a long outage from exhausting memory. */
  maxQueueSize: number;
  /** Attempts per batch, including the first. 4xx answers other than 408, 421 and 429 are never retried. */
  maxAttempts: number;
  /** First backoff delay; each retry doubles it, with full jitter, up to `maxRetryDelayMs`. */
  retryDelayMs: number;
  maxRetryDelayMs: number;
}

export const DEFAULT_QUEUE: QueueOptions = {
  flushAt: 15,
  flushIntervalMs: 1_000,
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
  /**
   * Throw errors instead of logging them and resolving with an empty result. Meant for tests
   * and development, where a silent failure hides a broken integration.
   */
  strict?: boolean;
  /** Flush queued events when a Node process is about to exit. Defaults to `true`. */
  flushOnExit?: boolean;
  /** A `fetch` implementation. Defaults to the global one. */
  fetch?: typeof fetch;
  logger?: Logger;
  /** Extra headers sent with every request. */
  defaultHeaders?: Record<string, string>;
}
