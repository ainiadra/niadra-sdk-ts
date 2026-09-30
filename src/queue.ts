import { NiadraError, NiadraValidationError, toNiadraError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { QueueOptions } from "./options.js";
import { isTransient } from "./transport.js";
import type { BatchItem, BatchResponse, HeartbeatItem } from "./types/events.js";

/**
 * Called with `null` when the server accepted the item, or the reason it did not. An item that goes back to
 * the queue after an error that may pass hears that error first, and its answer later; a caller keeps the first.
 */
type Settle = (error: NiadraError | null) => void;

interface Pending {
  item: BatchItem;
  settle?: Settle | undefined;
}

interface DrainReport {
  sent: number;
  failed: number;
  errors: NiadraError[];
}

const HEARTBEAT_WINDOW_MS = 60_000;
const MAX_PAUSE_MS = 60_000;

/**
 * A bounded in-memory queue in front of `POST /v1/batch`.
 *
 * Items leave in batches when `flushAt` of them are waiting, `flushIntervalMs` after the first
 * one was queued, or `turnFlushIntervalMs` after the first conversation turn was queued,
 * whichever comes first. Only one batch is in flight at a time, so items reach the server in
 * the order they were queued. A batch that still fails after its retries with an error that may
 * pass (a connection, a timeout, a 408, 421, 429 or 5xx) goes back to the front of the queue, and
 * the queue pauses, doubling the pause up to a minute while Niadra stays down: what an agent
 * said during an outage arrives once Niadra is back, each item under its own idempotency key.
 * `maxQueueSize` bounds what an outage can hold. A batch refused for any other reason is dropped.
 */
export class EventQueue {
  private items: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAt = Number.POSITIVE_INFINITY;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private droppedSinceWarning = 0;
  private windowStart: number;
  private sentInWindow = 0;
  private pauseMs = 0;
  private resumeAt = 0;

  constructor(
    private readonly send: (items: BatchItem[]) => Promise<BatchResponse>,
    private readonly options: QueueOptions,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.windowStart = now();
  }

  /** Items waiting to be sent, not counting a batch already in flight. */
  get size(): number {
    return this.items.length;
  }

  /** Queues one item. Returns `false`, and settles it with an error, when the queue is full or closed. */
  push(item: BatchItem, settle?: Settle): boolean {
    if (this.closed || this.items.length >= this.options.maxQueueSize) {
      this.droppedSinceWarning++;
      if (this.droppedSinceWarning === 1) {
        this.logger.warn(this.closed ? "client is shut down; dropping events" : "event queue is full; dropping events");
      }
      settle?.(new NiadraError(this.closed ? "client is shut down" : "event queue is full"));
      return false;
    }
    this.droppedSinceWarning = 0;
    this.items.push({ item, settle });
    if (this.items.length >= this.options.flushAt) {
      this.flushInBackground();
    } else {
      const { flushIntervalMs, turnFlushIntervalMs } = this.options;
      this.schedule(isTurn(item) ? Math.min(turnFlushIntervalMs, flushIntervalMs) : flushIntervalMs);
    }
    return true;
  }

  /**
   * Sends everything queued so far and resolves when it is done. Concurrent calls are
   * serialized behind the batch already in flight rather than sending in parallel.
   */
  flush(): Promise<DrainReport> {
    this.cancelTimer();
    const run = this.tail.then(() => this.drain());
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Starts a flush without waiting for it: once the pause after a failed batch ends, or at once with
   * `now` (a caller waits for an item). Item failures are logged and settled inside the drain, so only
   * an unexpected error reaches this catch.
   */
  flushInBackground(now = false): void {
    const paused = this.resumeAt - this.now();
    if (!now && paused > 0) {
      this.schedule(paused);
      return;
    }
    this.flush().catch((error: unknown) => {
      this.logger.error(`event flush failed: ${toNiadraError(error).message}`);
    });
  }

  /** Flushes, then refuses new items. */
  async close(): Promise<DrainReport> {
    const report = await this.flush();
    this.closed = true;
    this.cancelTimer();
    return report;
  }

  private async drain(): Promise<DrainReport> {
    const report: DrainReport = { sent: 0, failed: 0, errors: [] };
    while (this.items.length > 0) {
      const batch = this.items.splice(0, this.options.maxBatchSize);
      const heartbeat = this.heartbeat();
      if (heartbeat) batch.push({ item: heartbeat });
      if (!(await this.sendBatch(batch, report))) break;
    }
    return report;
  }

  /** Sends one batch; `false` when it went back to the queue and the queue pauses. */
  private async sendBatch(batch: Pending[], report: DrainReport): Promise<boolean> {
    const wire = batch.map((pending) => pending.item);
    let response: BatchResponse;
    try {
      response = await this.send(wire);
    } catch (error) {
      const failure = toNiadraError(error);
      report.errors.push(failure);
      if (isTransient(failure)) {
        // A caller waiting on an item hears the failure now; the item stays and leaves again later.
        for (const pending of batch) pending.settle?.(failure);
        this.requeue(batch);
        this.pauseMs = Math.min(MAX_PAUSE_MS, Math.max(this.options.flushIntervalMs, this.pauseMs * 2));
        this.resumeAt = this.now() + this.pauseMs;
        this.logger.warn(`could not deliver ${batch.length} events, will retry: ${failure.message}`);
        this.schedule(this.pauseMs);
        return false;
      }
      report.failed += batch.length;
      this.logger.warn(`dropped ${batch.length} events refused by the API: ${failure.message}`);
      for (const pending of batch) pending.settle?.(failure);
      return true;
    }
    this.pauseMs = 0;
    this.resumeAt = 0;

    const rejected = new Map<number, NiadraError>();
    for (const itemError of response.errors) {
      const detail = itemError.detail ? `: ${itemError.detail}` : "";
      rejected.set(itemError.index, new NiadraValidationError(`${itemError.code}${detail}`));
    }
    if (rejected.size > 0) {
      const codes = [...new Set(response.errors.map((e) => e.code))].join(", ");
      this.logger.warn(`server rejected ${rejected.size} of ${wire.length} items (${codes})`);
    }
    batch.forEach((pending, index) => {
      if (pending.item.type === "heartbeat") return;
      const error = rejected.get(index) ?? null;
      if (error) {
        report.failed++;
        report.errors.push(error);
      } else {
        report.sent++;
        this.sentInWindow++;
      }
      pending.settle?.(error);
    });
    return true;
  }

  /** Puts a batch back at the front, keeping only what still fits; what does not is dropped. */
  private requeue(batch: Pending[]): void {
    const room = Math.max(0, this.options.maxQueueSize - this.items.length);
    const lost = batch.slice(room);
    this.items.unshift(...batch.slice(0, room));
    if (lost.length > 0) {
      this.logger.warn(`event queue is full; dropped ${lost.length} events`);
      for (const pending of lost) pending.settle?.(new NiadraError("event queue is full"));
    }
  }

  /**
   * Once a minute, the next batch carries the number of items sent in the previous window.
   * The server uses it to tell a source that went quiet from one whose events are being lost.
   */
  private heartbeat(): HeartbeatItem | null {
    const now = this.now();
    if (now - this.windowStart < HEARTBEAT_WINDOW_MS) return null;
    const item: HeartbeatItem = {
      type: "heartbeat",
      window_start: new Date(this.windowStart).toISOString(),
      sent: this.sentInWindow,
    };
    this.windowStart = now;
    this.sentInWindow = 0;
    return item;
  }

  /** Sends what is waiting in `delayMs`, unless a send is already due sooner. */
  private schedule(delayMs: number): void {
    const dueAt = this.now() + delayMs;
    if (this.timer !== null && this.timerDueAt <= dueAt) return;
    this.cancelTimer();
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDueAt = Number.POSITIVE_INFINITY;
      this.flushInBackground();
    }, delayMs);
    unref(this.timer);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.timerDueAt = Number.POSITIVE_INFINITY;
  }
}

/** A message of a conversation: what the other agents read in `live` while it goes on. */
export function isTurn(item: BatchItem): boolean {
  return item.type === "event" && item.kind === "message" && Boolean(item.conversation_id);
}

/** In Node, a pending flush timer must not keep an otherwise finished process alive. */
export function unref(timer: unknown): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    (timer as { unref(): void }).unref();
  }
}
