/**
 * `niadra.turns`: opens turns, keeps the closed ones in the bounded queue, and holds what the sender needs.
 *
 * Recording is on as long as the client has a key and the space records turns: a `404` on `POST /v1/turns`
 * means it does not, and the recorder then stops recording for 10 minutes before it tries again. While it is
 * off, a turn still opens and closes (the agent's code runs the same), and its record is not kept.
 */

import type { RawBinding } from "../constraints/binding.js";
import type { Logger } from "../logger.js";
import type { ClaimRecord, TurnPins } from "../types/turns.js";
import type { ContentMode, FrameOptions, Submit, TurnKind } from "./frame.js";
import { TurnFrame, currentTurn } from "./frame.js";
import { TurnQueue } from "./queue.js";
import { buildRecord } from "./record.js";
import type { BlobStore, TurnRecordJson } from "./record.js";
import { MAX_TURNS } from "./sender.js";
import type { TurnSender } from "./sender.js";

/** Seconds a recorder stays off after the space answered that it does not record turns. */
const OFF_FOR_MS = 600_000;

/** Turn recording, apart from the event queue. */
export interface TurnRecordingOptions {
  /**
   * Where recorded values go: `stored`, `pointer` or `hash_only`. By default `pointer` once a store is set
   * (`turns.store()`), otherwise the mode the space's recording names, otherwise `stored`; a source that
   * records less refuses more, and the SDK then sends digests only.
   */
  contentMode?: ContentMode;
  /** Copied values and frames the queue holds at most; past it, values of unflagged turns go first. */
  maxBytes: number;
  maxTurns: number;
  /** A batch leaves this long after its first turn closed, or at once with 50 turns waiting. */
  intervalMs: number;
}

export const DEFAULT_TURNS: TurnRecordingOptions = { maxBytes: 64 * 1024 * 1024, maxTurns: 2000, intervalMs: 1000 };

export interface OpenTurn {
  agent?: string | null;
  role?: string | null;
  kind?: TurnKind;
  build?: TurnPins;
  conversationId?: string | null;
  taskId?: string | null;
  turnId?: string;
  adapter?: string | null;
}

export class TurnRecorder implements Submit {
  readonly queue: TurnQueue;
  sender: TurnSender | null = null;
  blobStore: BlobStore | null = null;
  /** The claim check the sender runs on a turn's outputs, when a claim contract applies. */
  claims: ((frame: TurnFrame) => ClaimRecord[]) | null = null;
  /** The mode the space's recording names, when the client knows it (the SDK profile). */
  recordingMode: () => ContentMode | null = () => null;
  /** The pins a turn needs to be replayable, when the client knows them (the SDK profile). */
  requiredPins: () => readonly string[] = () => [];
  /** Each field's attribute family, for the tools' bindings (the SDK profile). */
  families: () => Readonly<Record<string, string>> = () => ({});
  /** The fields each type hides from this key, for a tool's masked output (the SDK profile). */
  fieldAccess: () => Readonly<Record<string, Readonly<Record<string, string>>>> | null = () => null;
  /** The binding the space serves for a tool, by its name (the SDK profile). */
  bindings: (tool: string) => RawBinding | null = () => null;
  /** The features the space turned on, when the client knows them (the SDK profile). */
  features: () => ReadonlySet<string> | null = () => null;
  accepted = 0;
  duplicates = 0;
  rejectedTurns = 0;
  notKept = 0;
  private offUntil = 0;
  private refused = false;
  private readonly warned = new Set<string>();

  constructor(
    readonly options: TurnRecordingOptions,
    private readonly enabled: boolean,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.queue = new TurnQueue(options.maxBytes, options.maxTurns, options.intervalMs, MAX_TURNS, logger, now);
  }

  /**
   * A new turn, not yet current: run code in it with `frame.run(fn)`, then `frame.close()`. Opened while
   * another turn is current, it is a sub-turn of it, in its conversation unless one is named.
   */
  open(options: OpenTurn & { agent: string }): TurnFrame {
    const parent = currentTurn();
    const frameOptions: FrameOptions = {
      agent: options.agent,
      role: options.role ?? null,
      kind: options.kind ?? "message",
      conversationId: options.conversationId ?? null,
      taskId: options.taskId ?? null,
      pins: options.build ?? {},
      adapter: options.adapter ?? null,
    };
    if (options.turnId !== undefined) frameOptions.turnId = options.turnId;
    if (parent !== undefined) frameOptions.parent = parent;
    return new TurnFrame(this.recording ? this : null, frameOptions);
  }

  /** Takes a closed turn into the queue. Never waits and never throws. */
  submit(frame: TurnFrame): void {
    if (frame.conversationId === null && frame.taskId === null) {
      this.warnOnce("no_session", "a turn outside a conversation or a task is not recorded");
      return;
    }
    if (!this.recording) return;
    const pins = frame.pins as Record<string, unknown>;
    const missing = this.requiredPins().filter((pin) => !pinned(pins[pin]));
    if (missing.length > 0) {
      const names = missing.join(", ");
      this.warnOnce(`pins:${names}`, `turns without the ${names} pin are kept but cannot be replayed; name them in Niadra.build()`);
    }
    try {
      this.queue.put(frame);
      this.sender?.notify();
    } catch {
      this.logger.warn("a closed turn could not be queued");
    }
  }

  /**
   * Keeps recorded values in the company's storage (`pointer` mode): Niadra receives only pointers and
   * digests. `put(key, data)` writes the canonical JSON `data` under `key` with the company's credentials
   * and returns the pointer (`s3://bucket/key`).
   */
  store(put: BlobStore): void {
    this.blobStore = put;
  }

  /** Where recorded values go now. See `TurnRecordingOptions.contentMode`. */
  get contentMode(): ContentMode {
    if (this.refused) return "hash_only";
    if (this.options.contentMode !== undefined) return this.options.contentMode;
    if (this.blobStore !== null) return "pointer";
    const mode = this.recordingMode();
    return mode === "pointer" || mode === "hash_only" ? mode : "stored";
  }

  /** The wire record of a closed turn, in its content mode. */
  record(frame: TurnFrame): Promise<TurnRecordJson> {
    return buildRecord(frame, frame.mode ?? this.contentMode, { store: this.blobStore, claims: this.claims, logger: this.logger });
  }

  /**
   * Whether closed turns are kept: the client has a key, and the space records turns as far as the SDK
   * knows (the profile lists `turns`, or it has not been read yet).
   */
  get recording(): boolean {
    const features = this.features();
    return this.enabled && (features === null || features.has("turns")) && this.now() >= this.offUntil;
  }

  /** Closed turns waiting in the queue. */
  get pending(): number {
    return this.queue.length;
  }

  /** Turns lost so far: dropped whole by a full queue, refused by the API, or not kept by the space. */
  get dropped(): number {
    return this.queue.turnsDropped + this.rejectedTurns + this.notKept;
  }

  sent(accepted: number, duplicates: number): void {
    this.accepted += accepted;
    this.duplicates += duplicates;
  }

  rejected(count: number, codes: readonly string[]): void {
    this.rejectedTurns += count;
    this.logger.warn(`${count} turn records were refused (${[...codes].sort().join(", ")})`);
  }

  /** The space does not record turns: these are dropped, and with `off` (a 404) recording stops a while. */
  notRecorded(count: number, off: boolean): void {
    this.notKept += count;
    if (off) this.offUntil = this.now() + OFF_FOR_MS;
    this.warnOnce("off", "this space does not record turns; turn recording is off for now");
  }

  modeRefused(): void {
    this.refused = true;
    this.warnOnce(
      "refused",
      "the source records less than this SDK sent; turns now leave with digests only (set turns.contentMode, or turns.store() for pointer mode)",
    );
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(message);
  }
}

function pinned(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  return typeof value !== "object" || Object.keys(value).length > 0;
}
