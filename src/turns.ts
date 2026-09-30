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
/** How long a block the space refused is not asked for again. */
export const BLOCK_RECHECK_AFTER_MS = 600_000;

/** The turn as `query`: trimmed, and its last `MAX_TURN` characters when longer. `null` when blank. */
export function turnText(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TURN ? trimmed.slice(-MAX_TURN) : trimmed;
}
