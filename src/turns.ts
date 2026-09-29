/**
 * The customer's turn on the read path: sent as `query`, and prefetched while they speak.
 *
 * A conversation sends the customer's last turn as `query` on every `context()`. The server keeps
 * serving the conversation's pinned pack and adds `slots`, what that turn selected from memory, so
 * the SDK caches the pack as a read without `query` and never caches the slots.
 */

const MAX_TURN = 2000;
/** A partial transcript shorter than this says nothing the server can use yet. */
export const MIN_PREFETCH = 8;
/** Statuses of a server without the prefetch route. */
export const NO_PREFETCH = new Set([404, 405, 501]);
/** How long a server without the prefetch route is not asked again. */
export const PREFETCH_RECHECK_AFTER_MS = 600_000;

/** The turn as `query`: trimmed, and its last `MAX_TURN` characters when longer. `null` when blank. */
export function turnText(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TURN ? trimmed.slice(-MAX_TURN) : trimmed;
}

/** Whether a client's server answers prefetches: a route it lacks is not asked for a while. */
export class PrefetchSupport {
  private prefetchAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  prefetchWanted(): boolean {
    return this.now() >= this.prefetchAt;
  }

  /** The server has no prefetch route: stop sending for `PREFETCH_RECHECK_AFTER_MS`. */
  prefetchRefused(): void {
    this.prefetchAt = this.now() + PREFETCH_RECHECK_AFTER_MS;
  }
}
