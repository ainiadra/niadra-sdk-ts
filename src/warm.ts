/**
 * Keeps the connection to the region open while a conversation is in use (B23).
 *
 * An idle connection closes after a while (`keepAliveMs` on your side, 180 s at the API's edge), and chat turns
 * are often further apart: the next read then opens a connection again, TCP and TLS first, two more round trips
 * (330 ms from Sao Paulo), and a DNS lookup whenever the resolver's copy expired (about 300 ms more). While a
 * conversation or task is open (created and not ended) and the client was used in the last `WARM_FOR_MS`, the
 * client sends `GET /healthz` every `EVERY_MS` when nothing else went out for `IDLE_MS`: one attempt, a
 * 2-second budget, never counted as the client's own use. The API answers it in a fraction of a millisecond
 * without touching a database.
 */

/** Under the 120 s an SDK connection is commonly kept idle and the 180 s the edge keeps one. */
export const EVERY_MS = 100_000;
/** A ping goes only when nothing else went out for this long. */
const IDLE_MS = 90_000;
/** How long after the client's last use an open conversation keeps the connection warm. */
const WARM_FOR_MS = 600_000;

type WarmStep = "ping" | "wait" | "stop";

/** The open conversations of a client, by scope, held weakly: one nobody holds any more is gone. */
export class KeepWarm {
  private readonly open = new Map<string, WeakRef<object>>();
  private openedAt = 0;

  constructor(readonly enabled: boolean) {}

  /** Notes an open conversation or task. */
  add(scope: string, session: object, now: number): void {
    if (!this.enabled || typeof WeakRef === "undefined") return;
    this.open.set(scope, new WeakRef(session));
    this.openedAt = now;
  }

  /** The conversation or task ended. */
  end(scope: string): void {
    this.open.delete(scope);
  }

  step(now: number, lastActivityAt: number | undefined, idleMs = IDLE_MS, warmForMs = WARM_FOR_MS): WarmStep {
    for (const [scope, ref] of this.open) if (ref.deref() === undefined) this.open.delete(scope);
    const used = Math.max(lastActivityAt ?? 0, this.openedAt);
    if (this.open.size === 0 || now - used > warmForMs) return "stop";
    return now - used >= idleMs ? "ping" : "wait";
  }
}
