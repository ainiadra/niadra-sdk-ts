import { NiadraError, NiadraValidationError, toNiadraError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { QueueOptions } from "./options.js";
import type { BatchItem, BatchResponse, HeartbeatItem } from "./types/events.js";

/** Called once per item with `null` when the server accepted it, or the reason it did not. */
export type Settle = (error: NiadraError | null) => void;

interface Pending {
  item: BatchItem;
  settle?: Settle | undefined;
}

export interface DrainReport {
  sent: number;
  failed: number;
  errors: NiadraError[];
}

const HEARTBEAT_WINDOW_MS = 60_000;

/**
 * A bounded in-memory queue in front of `POST /v1/batch`.
 *
 * Items leave in batches when `flushAt` of them are waiting, `flushIntervalMs` after the first
 * one was queued, or `turnFlushIntervalMs` after the first conversation turn was queued,
 * whichever comes first. Only one batch is in flight at a time, so items reach the server in
 * the order they were queued. A batch that still fails after its retries is dropped and logged:
 * holding it would let one bad outage grow the queue without bound.
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
   * Starts a flush without waiting for it. Item failures are logged and settled inside the
   * drain, so only an unexpected error reaches this catch.
   */
  flushInBackground(): void {
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
      const wire = batch.map((pending) => pending.item);
      if (heartbeat) wire.push(heartbeat);
      await this.sendBatch(batch, wire, report);
    }
    return report;
  }

  private async sendBatch(batch: Pending[], wire: BatchItem[], report: DrainReport): Promise<void> {
    let response: BatchResponse;
    try {
      response = await this.send(wire);
    } catch (error) {
      const failure = toNiadraError(error);
      report.failed += batch.length;
      report.errors.push(failure);
      this.logger.warn(`dropped ${batch.length} events after retries: ${failure.message}`);
      for (const pending of batch) pending.settle?.(failure);
      return;
    }

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
function unref(timer: unknown): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    (timer as { unref(): void }).unref();
  }
}
