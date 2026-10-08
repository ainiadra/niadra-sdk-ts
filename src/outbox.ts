/**
 * Writes the agent's code made that must reach Niadra, sent in the background and in order: coordination
 * declarations, and agent state writes made while Niadra was out of reach.
 *
 * A write carries its `Idempotency-Key`, so sending it again is harmless. A failure that may pass (a
 * connection, a 408, a 421, a 429, a 5xx) keeps the write at the front and pauses, doubling the pause while
 * the API stays down; any other failure hands the error to the write's `settled` callback, which is also how a
 * write that went through hears the answer. Putting a write never waits. Past `capacity` writes the oldest go.
 */

import { explain } from "./errors.js";
import type { Logger } from "./logger.js";
import { isTransient } from "./transport.js";

const CAPACITY = 1000;
const MAX_PAUSE_MS = 60_000;

interface Write {
  send(): Promise<unknown>;
  /** `POST /v1/coordination/declare`: what a refusal names in the log. */
  route?: string;
  settled?: (answer: unknown, error: unknown) => void;
}


export class Outbox {
  private readonly writes: Write[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pause = 0;
  private resumeAt = 0;
  dropped = 0;

  constructor(
    private readonly logger: Logger,
    private readonly intervalMs = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  get length(): number {
    return this.writes.length;
  }

  put(write: Write): void {
    this.writes.push(write);
    while (this.writes.length > CAPACITY) {
      this.writes.shift();
      this.dropped++;
      this.logger.warn("the write outbox is full; the oldest write was dropped");
    }
    this.schedule(Math.max(0, this.resumeAt - this.now()));
  }

  /** Sends what waits. Resolves `true` when nothing is left. */
  flush(timeoutMs?: number): Promise<boolean> {
    const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : this.now() + timeoutMs;
    const run = this.tail.then(async () => {
      for (let write = this.writes[0]; write !== undefined; write = this.writes[0]) {
        if (this.now() >= deadline) return false;
        if (!(await this.attempt(write))) return false;
      }
      return true;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Clears a pause after failures, for a caller that knows the API is back. */
  resume(): void {
    this.pause = 0;
    this.resumeAt = 0;
  }

  stop(timeoutMs?: number): Promise<boolean> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    return this.flush(timeoutMs);
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().then((done) => {
        if (!done && this.writes.length > 0) this.schedule(Math.max(0, this.resumeAt - this.now()));
      });
    }, delayMs);
    const handle = this.timer as { unref?: () => void };
    handle.unref?.();
  }

  private async attempt(write: Write): Promise<boolean> {
    let answer: unknown;
    try {
      answer = await write.send();
    } catch (error) {
      if (isTransient(error)) {
        this.pause = Math.min(MAX_PAUSE_MS, Math.max(this.intervalMs, this.pause * 2));
        this.resumeAt = this.now() + this.pause;
        return false;
      }
      this.writes.shift();
      this.logger.warn(`${write.route ?? "a write"} was refused: ${explain(error)}`);
      this.settle(write, undefined, error);
      return true;
    }
    this.writes.shift();
    this.resume();
    this.settle(write, answer, null);
    return true;
  }

  private settle(write: Write, answer: unknown, error: unknown): void {
    try {
      write.settled?.(answer, error);
    } catch {
      this.logger.warn("a write's callback failed");
    }
  }
}
