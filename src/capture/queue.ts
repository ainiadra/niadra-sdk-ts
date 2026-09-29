/**
 * The bounded turn queue: closed turns wait here for the sender, apart from the event queue.
 *
 * It is bounded twice, by bytes and by turns (`TurnRecordingOptions`). `put` never waits and never does I/O.
 * When a turn does not fit, the queue makes room in this order:
 *
 * 1. it drops the values of turns that carry no flag, oldest first. Each such turn keeps its frame, and its
 *    blobs keep their keys: the record leaves with digests only, `completeness: partial`;
 * 2. only then does it drop the oldest turns whole.
 *
 * A flagged turn (an error, a guard that acted, a handoff, a synthetic call...) keeps its values longest,
 * because it is the one someone will replay. Both kinds of loss are counted, and logged at most once a minute.
 */

import type { Logger } from "../logger.js";
import type { TurnFrame } from "./frame.js";

const LOG_EVERY_MS = 60_000;

export class TurnQueue {
  private turns: TurnFrame[] = [];
  /** Unflagged turns whose values may still go, oldest first; a turn that left is skipped lazily. */
  private sheddable: TurnFrame[] = [];
  private readonly sizes = new Map<TurnFrame, number>();
  private total = 0;
  private firstAt: number | null = null;
  private loggedAt = Number.NEGATIVE_INFINITY;
  /** Turns that left with digests only, to make room. */
  valuesDropped = 0;
  /** Turns dropped whole: the queue was full of flagged turns, or of frames alone. */
  turnsDropped = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly maxTurns: number,
    private readonly intervalMs: number,
    private readonly batch: number,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  put(frame: TurnFrame): void {
    this.add(frame, false);
    if (this.makeRoom()) this.log();
  }

  /** Puts turns the sender could not deliver back at the front, keeping only what fits. */
  requeue(frames: readonly TurnFrame[]): void {
    for (const frame of [...frames].reverse()) this.add(frame, true);
    if (this.makeRoom()) this.log();
  }

  take(limit: number): TurnFrame[] {
    const taken = this.turns.splice(0, limit);
    for (const frame of taken) {
      this.total -= this.sizes.get(frame) ?? 0;
      this.sizes.delete(frame);
    }
    for (let head = this.sheddable[0]; head !== undefined && !this.sizes.has(head); head = this.sheddable[0]) this.sheddable.shift();
    this.firstAt = this.turns.length > 0 ? this.now() : null;
    return taken;
  }

  /** When what is waiting should leave: at once with a full batch, else `intervalMs` after the first. */
  nextDue(): number | null {
    if (this.turns.length === 0 || this.firstAt === null) return null;
    return this.turns.length >= this.batch ? this.firstAt : this.firstAt + this.intervalMs;
  }

  get length(): number {
    return this.turns.length;
  }

  get bytes(): number {
    return this.total;
  }

  private add(frame: TurnFrame, front: boolean): void {
    const size = frame.size;
    if (front) this.turns.unshift(frame);
    else this.turns.push(frame);
    this.sizes.set(frame, size);
    this.total += size;
    if (!frame.flagged && size > frame.sizeWithoutValues) {
      if (front) this.sheddable.unshift(frame);
      else this.sheddable.push(frame);
    }
    this.firstAt ??= this.now();
  }

  private makeRoom(): boolean {
    let shed = false;
    // Values make room for bytes only: past the count of turns, only whole turns can go.
    while (this.total > this.maxBytes) {
      const frame = this.sheddable.shift();
      if (frame === undefined) break;
      const before = this.sizes.get(frame);
      if (before === undefined) continue; // it left already
      frame.dropBlobs();
      const size = frame.size;
      this.total += size - before;
      this.sizes.set(frame, size);
      this.valuesDropped++;
      shed = true;
    }
    while (this.total > this.maxBytes || this.turns.length > this.maxTurns) {
      const frame = this.turns.shift();
      if (frame === undefined) break;
      this.total -= this.sizes.get(frame) ?? 0;
      this.sizes.delete(frame);
      this.turnsDropped++;
      shed = true;
    }
    return shed;
  }

  private log(): void {
    const now = this.now();
    if (now - this.loggedAt < LOG_EVERY_MS) return;
    this.loggedAt = now;
    this.logger.warn(
      `the turn queue is full: ${this.valuesDropped} turns left with digests only and ${this.turnsDropped} were dropped so far`,
    );
  }
}
