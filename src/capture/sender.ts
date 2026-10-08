/**
 * The sender of the turn queue: `POST /v1/turns`, in the background, one request in flight per client.
 *
 * Each request carries up to 50 records, gzip-compressed where the runtime has `CompressionStream`, at most
 * 4 MB compressed and 16 MB decompressed; a record too large alone leaves with digests only, so a
 * `turn_too_large` never loops. What the answer decides:
 *
 * - 200 or 207: the turns are taken. A turn refused with `content_mode_refused` (the source records less
 *   than the SDK sent) goes again with digests only, which every source accepts; any other refusal is counted
 *   and dropped.
 * - 404: the space does not record turns. The batch is dropped and the recorder stops recording for a while.
 * - 408, 421, 429, 5xx and network errors: the batch goes back to the front of the queue and the sender
 *   pauses, doubling the pause while the API stays down.
 * - Any other error: the batch is counted and dropped.
 */

import { NiadraAPIError, explain, toNiadraError } from "../errors.js";
import type { Logger } from "../logger.js";
import { unref } from "../queue.js";
import { isTransient } from "../transport.js";
import type { TurnsResponse } from "../types/turns.js";
import type { TurnFrame } from "./frame.js";
import type { TurnQueue } from "./queue.js";
import { asHashOnly } from "./record.js";
import type { TurnRecordJson } from "./record.js";
import type { TurnRecorder } from "./recorder.js";

export const MAX_TURNS = 50;
const COMPRESSED_ROOM = 4 * 1024 * 1024 - 64 * 1024;
const DECODED_ROOM = 16 * 1024 * 1024 - 256 * 1024;
const MAX_PAUSE_MS = 60_000;

/** A request body: its bytes, and whether they are gzip. */
interface Body {
  bytes: Uint8Array<ArrayBuffer>;
  gzip: boolean;
}

/** Sends one body to `POST /v1/turns` and resolves with the answer. */
type SendTurns = (body: Body) => Promise<TurnsResponse>;

interface Batch {
  frames: TurnFrame[];
  records: TurnRecordJson[];
  body: Body;
}

const encoder = new TextEncoder();

async function encode(records: readonly TurnRecordJson[]): Promise<Body> {
  const raw = encoder.encode(JSON.stringify({ turns: records }));
  if (typeof CompressionStream === "undefined") return { bytes: raw, gzip: false };
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"));
  return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), gzip: true };
}

function sized(record: TurnRecordJson): [TurnRecordJson, number] {
  let size = encoder.encode(JSON.stringify(record)).length;
  if (size <= DECODED_ROOM) return [record, size];
  const reduced = asHashOnly(record);
  size = encoder.encode(JSON.stringify(reduced)).length;
  return [reduced, size];
}

async function compressed(frames: TurnFrame[], records: TurnRecordJson[]): Promise<Batch[]> {
  const body = await encode(records);
  if (body.bytes.length <= COMPRESSED_ROOM) return [{ frames, records, body }];
  const [only] = records;
  if (records.length === 1 && only !== undefined) {
    const record = asHashOnly(only);
    return [{ frames, records: [record], body: await encode([record]) }];
  }
  const half = Math.floor(records.length / 2);
  return [...(await compressed(frames.slice(0, half), records.slice(0, half))), ...(await compressed(frames.slice(half), records.slice(half)))];
}

/** Requests of up to 50 records within the size limits, in queue order. */
async function batches(frames: TurnFrame[], records: TurnRecordJson[]): Promise<Batch[]> {
  const out: Batch[] = [];
  let group: [TurnFrame, TurnRecordJson][] = [];
  let groupBytes = 0;
  const close = async (): Promise<void> => {
    if (group.length > 0) out.push(...(await compressed(group.map((g) => g[0]), group.map((g) => g[1]))));
  };
  for (const [i, frame] of frames.entries()) {
    const raw = records[i];
    if (raw === undefined) continue;
    const [record, size] = sized(raw);
    if (group.length > 0 && (group.length === MAX_TURNS || groupBytes + size > DECODED_ROOM)) {
      await close();
      group = [];
      groupBytes = 0;
    }
    group.push([frame, record]);
    groupBytes += size;
  }
  await close();
  return out;
}


export class TurnSender {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private pause = 0;
  private resumeAt = 0;
  private stopping = false;

  constructor(
    private readonly recorder: TurnRecorder,
    private readonly queue: TurnQueue,
    private readonly send: SendTurns,
    private readonly logger: Logger,
    private readonly intervalMs: number,
    private readonly refresh: (() => Promise<unknown>) | null = null,
    private readonly now: () => number = Date.now,
  ) {}

  /** A turn closed: schedule the next batch. Never waits and never throws. */
  notify(): void {
    if (this.stopping) return;
    const due = this.queue.nextDue();
    if (due === null) return;
    const wait = Math.max(0, due - this.now(), this.resumeAt - this.now());
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run().catch((error: unknown) => { this.logger.error(`turn sender failed: ${toNiadraError(error).message}`); });
    }, wait);
    unref(this.timer);
  }

  /** Sends everything queued. Resolves `true` when the queue emptied before `timeoutMs`. */
  flush(timeoutMs?: number): Promise<boolean> {
    const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : this.now() + timeoutMs;
    const run = this.tail.then(async () => {
      while (this.queue.length > 0) {
        if (this.now() >= deadline) return false;
        if (!(await this.sendNext())) return false;
      }
      return true;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  async stop(timeoutMs?: number): Promise<boolean> {
    this.stopping = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    return this.flush(timeoutMs);
  }

  /** Clears a pause after failures, for a caller that knows the API is back. */
  resume(): void {
    this.pause = 0;
    this.resumeAt = 0;
  }

  private async run(): Promise<void> {
    const run = this.tail.then(async () => {
      if (this.now() < this.resumeAt) return;
      const due = this.queue.nextDue();
      if (due !== null && due <= this.now()) await this.sendNext();
    });
    this.tail = run.catch(() => undefined);
    await run;
    this.notify();
  }

  private async sendNext(): Promise<boolean> {
    const frames = this.queue.take(MAX_TURNS);
    if (frames.length === 0) return true;
    if (this.refresh !== null) await this.refresh().catch(() => undefined);
    if (!this.recorder.recording) {
      this.recorder.notRecorded(frames.length, false);
      return true;
    }
    let prepared: Batch[];
    try {
      const records = await Promise.all(frames.map((frame) => this.recorder.record(frame)));
      prepared = await batches(frames, records);
    } catch (error) {
      this.logger.error(`turn records could not be built: ${toNiadraError(error).message}`);
      this.recorder.rejected(frames.length, ["build_failed"]);
      return true;
    }
    for (const [i, batch] of prepared.entries()) {
      let answer: TurnsResponse;
      try {
        answer = await this.send(batch.body);
      } catch (error) {
        if (!this.settleError(batch, error)) {
          this.queue.requeue(prepared.slice(i + 1).flatMap((b) => b.frames));
          return false;
        }
        continue;
      }
      this.accepted(batch, answer);
    }
    return true;
  }

  /** A failed batch: false when the sender should pause and try again later. */
  private settleError(batch: Batch, error: unknown): boolean {
    if (error instanceof NiadraAPIError && error.status === 404) {
      this.recorder.notRecorded(batch.frames.length, true);
      return true;
    }
    if (isTransient(error)) {
      this.queue.requeue(batch.frames);
      this.pause = Math.min(MAX_PAUSE_MS, Math.max(this.intervalMs, this.pause * 2));
      this.resumeAt = this.now() + this.pause;
      this.logger.warn(`could not deliver ${batch.frames.length} turns, will retry (${toNiadraError(error).name})`);
      return false;
    }
    const [frame] = batch.frames;
    if (error instanceof NiadraAPIError && error.status === 413 && batch.frames.length === 1 && frame !== undefined) {
      if (frame.mode !== "hash_only") {
        frame.mode = "hash_only";
        this.queue.requeue(batch.frames);
        return true;
      }
    }
    this.recorder.rejected(batch.frames.length, [explain(error)]);
    return true;
  }

  private accepted(batch: Batch, answer: TurnsResponse): void {
    this.pause = 0;
    this.resumeAt = 0;
    this.recorder.sent(answer.accepted, answer.duplicates);
    const again: TurnFrame[] = [];
    const reasons = new Set<string>();
    let refused = 0;
    for (const error of answer.errors ?? []) {
      const frame = batch.frames[error.index];
      if (frame === undefined) continue;
      if (error.code === "content_mode_refused" && frame.mode !== "hash_only") {
        frame.mode = "hash_only";
        this.recorder.modeRefused();
        again.push(frame);
      } else {
        refused++;
        reasons.add(error.detail ? `${error.code}: ${error.detail.slice(0, 300)}` : error.code);
      }
    }
    if (again.length > 0) this.queue.requeue(again);
    if (refused > 0) this.recorder.rejected(refused, [...reasons]);
  }
}

/** In Node, a pending send timer must not keep an otherwise finished process alive. */
