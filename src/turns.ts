/**
 * The customer's turn on the read path (memory v2): sent as `query`, and prefetched while they speak.
 *
 * A conversation sends the customer's last turn as `query` on every `context()`. In a space with
 * memory v2 the server keeps serving the conversation's pinned pack and adds `slots`, what that turn
 * selected from memory, so the SDK caches the pack as a read without `query` and never caches the
 * slots. A space without memory v2 compiles a read with `query` for that query and does not pin it,
 * so there the turn is not sent: the client learns which kind of space it talks to from the answers
 * (a key belongs to one space) and asks again after `RECHECK_AFTER_MS`, in case the space turned
 * memory v2 on.
 */

import type { ContextResponse } from "./types/context.js";

export const RECHECK_AFTER_MS = 600_000;
/** The least budget, in milliseconds, worth a second read when a space answered the turn without slots. */
export const MIN_REREAD_MS = 20;
export const MAX_TURN = 2000;
/** A partial transcript shorter than this says nothing the server can use yet. */
export const MIN_PREFETCH = 8;
/** Statuses of a server without the prefetch route. */
export const NO_PREFETCH = new Set([404, 405, 501]);

/**
 * Whether the server read the turn for slots: it sends `slots`, or times the stage that picks them,
 * which it runs on every read with `query` in a space with memory v2 that has a pack.
 */
export function readsTurn(response: ContextResponse): boolean {
  return (response.slots !== undefined && response.slots !== null) || "slots" in response.timing;
}

/** The turn as `query`: trimmed, and its last `MAX_TURN` characters when longer. `null` when blank. */
export function turnText(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TURN ? trimmed.slice(-MAX_TURN) : trimmed;
}

/** What a client learned about its space: whether it reads the turn, and whether it has the prefetch route. */
export class TurnSupport {
  private reads: boolean | null = null;
  private recheckAt = 0;
  private prefetchAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** `true` or `false` once an answer said so; `null` before that. */
  get readsTurn(): boolean | null {
    return this.reads;
  }

  /** Whether to send the turn: unless the space answered without slots less than `RECHECK_AFTER_MS` ago. */
  wanted(): boolean {
    return this.reads !== false || this.now() >= this.recheckAt;
  }

  /** Learns from an answer to a read that sent the turn. `null` when the answer cannot tell (no pack). */
  observe(response: ContextResponse): boolean | null {
    if (readsTurn(response)) {
      this.reads = true;
      return true;
    }
    if (!response.text && !response.not_modified) return null;
    this.reads = false;
    this.recheckAt = this.now() + RECHECK_AFTER_MS;
    return false;
  }

  prefetchWanted(): boolean {
    return this.reads !== false && this.now() >= this.prefetchAt;
  }

  /** The server has no prefetch route: stop sending for `RECHECK_AFTER_MS`. */
  prefetchRefused(): void {
    this.prefetchAt = this.now() + RECHECK_AFTER_MS;
  }
}

const UNPINNED = new WeakSet();

/** Marks an answer compiled for the turn by a space without memory v2: not the conversation's pinned pack. */
export function markUnpinned<T extends object>(result: T): T {
  UNPINNED.add(result);
  return result;
}

/** Whether a conversation must leave this answer out of what it keeps (its pack and deltas). */
export function isUnpinned(result: object): boolean {
  return UNPINNED.has(result);
}
