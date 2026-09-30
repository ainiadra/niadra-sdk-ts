import type { CacheOptions } from "./options.js";
import type { ContextResponse } from "./types/context.js";

/** Scopes whose epoch is remembered after a purge; past this, the oldest are forgotten. */
const MAX_EPOCHS = 4096;

/** How usable a cached pack is at the moment of a lookup. */
type Freshness = "fresh" | "stale" | "expired";

interface Entry {
  response: ContextResponse;
  /** When the server last confirmed this pack, by sending it or by answering `not_modified`. */
  confirmedAt: number;
  /** The conversation or task the pack belongs to, so ending one drops its packs. */
  scope: string;
  /** Deltas received for this pack that no caller has been given yet. */
  pending: string[];
}

interface Lookup {
  response: ContextResponse;
  freshness: Freshness;
}

/** What one request for a key settled on: the server's answer, or the good pack it could not replace. */
export interface Revalidated {
  response: ContextResponse;
  source: "network" | "fallback";
}

/**
 * Packs per conversation, with stale-while-revalidate.
 *
 * Every agent framework rebuilds its prompt on every turn and none of them cache, so without
 * this each turn would cost a network round trip on the hot path. An entry moves through
 * three states as it ages: `fresh` (served as is), `stale` (served at once while one
 * background request refreshes it) and `expired` (only used as a last good value when a
 * request fails). Past `maxStaleMs` it is dropped entirely.
 *
 * Keys hold handle values, so the cache lives in process memory only and is never logged.
 *
 * A delta is what changed since this agent last read the subject, and the server moves that
 * mark as it answers, so a delta it sent once never comes back. Each one is therefore handed
 * out exactly once through `take()`: a delta fetched by a background refresh waits in its
 * entry for the next reader instead of being overwritten or served twice.
 */
export class ContextCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Revalidated>>();
  private epoch = 0;
  /** Per scope, bumped by `deleteScope()`: an answer to a read started before is not stored. */
  private readonly scopeEpochs = new Map<string, number>();

  constructor(
    private readonly options: CacheOptions,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /**
   * Bumped by `clear()`. A request started before a purge carries the old epoch, and its
   * answer is not stored: a revoked key must not repopulate the cache on its way out.
   */
  get generation(): number {
    return this.epoch;
  }

  lookup(key: string): Lookup | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const age = this.now() - entry.confirmedAt;
    if (age > this.options.maxStaleMs) {
      this.entries.delete(key);
      return null;
    }
    // Re-insert so iteration order doubles as least-recently-used order for eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    let freshness: Freshness = "expired";
    if (age <= this.options.ttlMs) freshness = "fresh";
    else if (age <= this.options.ttlMs + this.options.staleWhileRevalidateMs) freshness = "stale";
    return { response: entry.response, freshness };
  }

  /** The epoch of one conversation or task now; pass it to `store()` from a read started under it. */
  scopeEpoch(scope: string): number {
    return this.scopeEpochs.get(scope) ?? 0;
  }

  /** Whether a pack for `key` is held (and not past `maxStaleMs`). Delivers nothing. */
  has(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (this.now() - entry.confirmedAt > this.options.maxStaleMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /** Milliseconds since the server last sent or confirmed the pack held for `key`; `null` when none is held. */
  age(key: string): number | null {
    const entry = this.entries.get(key);
    return entry ? this.now() - entry.confirmedAt : null;
  }

  /** The cached pack's ETag, without touching the order of eviction. */
  etag(key: string): string | null {
    return this.entries.get(key)?.response.etag ?? null;
  }

  store(
    key: string,
    scope: string,
    response: ContextResponse,
    generation: number = this.epoch,
    scopeEpoch: number = this.scopeEpoch(scope),
  ): void {
    if (generation !== this.epoch || scopeEpoch !== this.scopeEpoch(scope)) return;
    const previous = this.entries.get(key);
    // A new pack already contains every change the deltas pending against the old one carried.
    const pending = previous?.response.etag === response.etag ? [...previous.pending] : [];
    if (response.delta) pending.push(response.delta);
    this.entries.delete(key);
    this.entries.set(key, { response: { ...response, delta: null }, confirmedAt: this.now(), scope, pending });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /**
   * The deltas pending for `key`, joined, which then count as delivered: `null` when there are
   * none, `undefined` when the key is not cached at all.
   */
  take(key: string): string | null | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const delta = entry.pending.join("\n\n") || null;
    entry.pending = [];
    return delta;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Drops every pack of one conversation or task; an answer to a read started before is not stored. */
  deleteScope(scope: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.scope === scope) this.entries.delete(key);
    }
    const next = this.scopeEpoch(scope) + 1;
    this.scopeEpochs.delete(scope); // re-inserted last, the most recent
    this.scopeEpochs.set(scope, next);
    while (this.scopeEpochs.size > MAX_EPOCHS) {
      const oldest = this.scopeEpochs.keys().next();
      if (oldest.done) break;
      this.scopeEpochs.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
    this.epoch++;
  }

  /**
   * Runs `load` for a key unless a request for the same key is already in flight, in which
   * case every caller shares that one request. This is what keeps a burst of turns in one
   * conversation, or a stale entry read by many callers, down to a single refresh.
   */
  dedupe(key: string, load: () => Promise<Revalidated>): Promise<Revalidated> {
    const running = this.inflight.get(key);
    if (running) return running;
    const started = load().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, started);
    return started;
  }
}
