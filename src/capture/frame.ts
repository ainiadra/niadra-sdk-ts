/**
 * A turn in the agent's process: the frame that collects what one turn read, called, said and decided
 * (the Turn Record spec, `turn-record.v0`).
 *
 * Capture never delays the agent and never fails it. At the moment something happens the frame copies it:
 * arguments and results become JSON text right away (`JSON.stringify`, a deep copy by construction), so a
 * later change to the agent's objects never reaches the record. Digests, the claim check and sending happen
 * later, on the sender. When the capture itself fails, the turn goes on and its record says
 * `completeness: incomplete`.
 *
 * The frame in progress is held by an `AsyncLocalStorage` (`capture/context.ts`): `frame.run(fn)` makes it
 * current for `fn` and everything `fn` awaits. A frame opened while another is current is a sub-turn of it:
 * its own `turn_id`, with `agent.parent_turn_id` naming the outer one. A second store holds the call in
 * progress, so a call made inside a tool names it as `parent_call_id`.
 */

import type { RawBinding } from "../constraints/binding.js";
import type { ConstraintsBlock } from "../types/signals.js";
import { uuidv7 } from "../ids.js";
import type { Playback, Played } from "../replay/playback.js";
import type { ClaimRecord, TurnPins } from "../types/turns.js";
import { store } from "./context.js";

export type TurnKind = "message" | "action" | "event" | "timer";
export type CallStatus = "ok" | "error" | "timeout" | "cancelled";
export type Flag =
  | "error"
  | "guard_acted"
  | "guard_budget_exceeded"
  | "handoff"
  | "assertion_failed"
  | "synthetic"
  | "incomplete"
  | "negative_feedback"
  | "truncated";
export type ContentMode = "stored" | "pointer" | "hash_only";

/** The size the queue counts for a frame besides its blobs, and for each of its calls. */
const FRAME_BYTES = 512;
const CALL_BYTES = 256;

/** A value of the record, copied at the moment: its JSON text until the queue drops it, then its digest. */
export interface Blob {
  data: string | null;
  size: number;
  sha256?: string;
  canonicalSize?: number;
  /** Where the company's store keeps it, once written (`pointer` mode). */
  pointer?: string;
}

/** An output of the turn, kept for the claim check that runs on the sender. */
export interface Said {
  text: string;
  context: string;
  immutable: boolean;
  agent: string | null;
}

/**
 * A field of an object a read served the turn: the claim check's evidence, with whether it may back a claim
 * now (`claimSafe`) and the gaps its object declares.
 */
export interface StateValue {
  ref: string;
  field: string;
  value: unknown;
  claimSafe: boolean;
  role?: string | null;
  declaredGaps?: readonly string[];
}

/** A call's entry in the record, as the frame keeps it. */
export type CallEntry = Record<string, unknown> & { call_id: string; kind: "tool" | "model" };

export interface Observation {
  ref: string;
  fields: Record<string, unknown>;
  provenance?: { source: "live" | "snapshot" | "cache"; source_observed_at: string; scope?: string };
}

/** Takes a closed turn; what `TurnRecorder` does. */
export interface Submit {
  submit(frame: TurnFrame): void;
  /** Each field's attribute family, for the tools' bindings (the SDK profile). */
  families?: () => Readonly<Record<string, string>>;
  /** The fields each type hides from this key, for a tool's masked output (the SDK profile). */
  fieldAccess?: () => Readonly<Record<string, Readonly<Record<string, string>>>> | null;
  /** The binding the space serves for a tool, by its name (the SDK profile). */
  bindings?: (tool: string) => RawBinding | null;
}

const turns = (): ReturnType<typeof store<TurnFrame>> => store<TurnFrame>("niadra_turn");
const callStore = (): ReturnType<typeof store<CallCapture>> => store<CallCapture>("niadra_call");

/** The turn open in this async context, if any. */
export function currentTurn(): TurnFrame | undefined {
  return turns()?.getStore();
}

/** The call in progress in this async context, if any. */
export function currentCall(): CallCapture | undefined {
  return callStore()?.getStore();
}

/** `value` as JSON text, now: the copy a record keeps. Throws when it has no JSON form at all. */
export function snapshot(value: unknown): string {
  const text = JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) as string | undefined;
  return text ?? "null";
}

function statusOf(error: unknown): CallStatus {
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError") return "cancelled";
  if (name === "TimeoutError" || name === "NiadraTimeoutError") return "timeout";
  return "error";
}

/**
 * One tool or model call of a turn, open until `result()` or `failed()`. `run(fn)` makes it the call in
 * progress for `fn`, so calls made inside it name it as their parent, and a throw fails it.
 */
export class CallCapture {
  readonly callId: string;
  /** In a replay: how the call answers (`replay/playback.ts`). */
  played: Played | null = null;
  /** What the call's result honored of the constraints block, when the tool has a binding. */
  measure: ((result: unknown) => Record<string, unknown> | null) | null = null;
  private readonly started = performance.now();
  private finished = false;

  constructor(
    readonly frame: TurnFrame,
    readonly entry: CallEntry,
  ) {
    this.callId = entry.call_id;
  }

  get done(): boolean {
    return this.finished;
  }

  /**
   * The call returned `value`, as the model saw it. `ui` is the form the interface got, when it differs.
   * `observations` are the objects the result showed, each `{ref, fields, provenance}`.
   */
  result(
    value: unknown,
    options: { ui?: unknown; observations?: readonly Observation[]; costUnits?: Record<string, number>; cacheHit?: boolean } = {},
  ): void {
    if (this.finished) return;
    const extra: Record<string, unknown> = { result_model: this.frame.blob(value) };
    if (this.measure !== null) {
      try {
        extra.applied = this.measure(value);
      } catch {
        this.frame.incomplete();
      }
    }
    if (options.ui !== undefined) extra.result_ui = this.frame.blob(options.ui);
    if (options.observations?.length) extra.observations = options.observations.map((o) => ({ ...o }));
    if (options.costUnits) extra.cost_units = { ...options.costUnits };
    if (options.cacheHit !== undefined) extra.cache_hit = options.cacheHit;
    this.finish("ok", extra);
  }

  /** The call ended without a result: a throw, or `timeout` or `cancelled`. */
  failed(error: unknown = "error"): void {
    if (this.finished) return;
    const status = typeof error === "string" ? (error as CallStatus) : statusOf(error);
    this.finish(status, {});
    if (status === "error") this.frame.flag("error");
  }

  /** Runs `fn` as the call in progress. */
  run<R>(fn: () => R): R {
    const calls = callStore();
    return calls ? calls.run(this, fn) : fn();
  }

  private finish(status: CallStatus, extra: Record<string, unknown>): void {
    this.finished = true;
    for (const [key, value] of Object.entries(extra)) if (value !== undefined && value !== null) this.entry[key] = value;
    this.entry.status = status;
    this.entry.latency_ms = Math.round(performance.now() - this.started);
  }
}

export interface FrameOptions {
  agent: string;
  role?: string | null;
  kind?: TurnKind;
  conversationId?: string | null;
  taskId?: string | null;
  pins?: TurnPins;
  adapter?: string | null;
  turnId?: string;
  parent?: TurnFrame;
}

/**
 * The record of one turn while it runs. `close()` ends it and hands it to the turn queue; nothing else
 * happens on the agent's path. Every method never throws for a failure of the capture itself, and does
 * nothing once the frame is closed.
 */
export class TurnFrame {
  readonly turnId: string;
  readonly parentTurnId: string | null;
  readonly agent: string;
  readonly role: string | null;
  readonly kind: TurnKind;
  readonly conversationId: string | null;
  readonly taskId: string | null;
  readonly pins: TurnPins & Record<string, unknown>;
  readonly adapter: string | null;
  readonly startedAt = new Date();
  endedAt: Date | null = null;
  latencyMs: number | null = null;
  readonly calls: CallEntry[] = [];
  readonly blobs = new Map<string, Blob>();
  readonly reads: Record<string, unknown>[] = [];
  readonly said: Said[] = [];
  readonly claims: ClaimRecord[] = [];
  /** What the person was shown or did in the turn, as the interaction spec writes it. */
  readonly interactions: Record<string, unknown>[] = [];
  readonly coordination: { decision_id: string; decision: string }[] = [];
  readonly effects = new Map<string, string>();
  readonly eventKeys: string[] = [];
  readonly flags = new Set<Flag>();
  /** Fields of objects the turn read from state, for the claim check. */
  readonly state: StateValue[] = [];
  completeness: "complete" | "partial" | "incomplete" = "complete";
  handoffId: string | null = null;
  /** The content mode this turn must leave in, when the server refused the recorder's. */
  mode: ContentMode | null = null;
  /** The constraints block the turn read last: what its tools' calls are measured against. */
  constraints: ConstraintsBlock | null = null;
  /**
   * Set in a replay: recorded answers for the tools, and where what the turn says goes. A sub-turn of a
   * replayed turn (a framework's run inside it) is replayed with it, and never sent.
   */
  playback: Playback | null = null;
  closed = false;
  private readonly guardedTexts = new Set<string>();
  private readonly adoptable: CallCapture[] = [];
  private readonly counters = { b: 0, k: 0, m: 0 };
  private readonly started = performance.now();

  constructor(
    private readonly recorder: Submit | null,
    options: FrameOptions,
  ) {
    const parent = options.parent;
    this.turnId = options.turnId ?? uuidv7();
    this.parentTurnId = parent?.turnId ?? null;
    this.agent = options.agent;
    this.role = options.role ?? null;
    this.kind = options.kind ?? "message";
    this.conversationId = options.conversationId ?? parent?.conversationId ?? null;
    this.taskId = options.taskId ?? (parent && !options.conversationId ? parent.taskId : null);
    this.pins = { ...(options.pins ?? {}) };
    this.adapter = options.adapter ?? null;
    this.playback = parent?.playback ?? null;
  }

  /** Whether the frame keeps what the turn says for the claim check on the sender. */
  get recording(): boolean {
    return this.recorder !== null;
  }

  // Capture

  /**
   * Opens a tool call, copying its arguments now. `callId` is the provider's id when there is one; otherwise
   * the frame names it `k1`, `k2`, ... Call the capture's `result()` or `failed()` when it ends.
   */
  toolCall(
    name: string,
    args?: unknown,
    options: { callId?: string | null; attempt?: number; synthetic?: boolean; cacheHit?: boolean; effectKey?: string; adoptable?: boolean } = {},
  ): CallCapture {
    const entry: CallEntry = {
      call_id: options.callId ?? `k${++this.counters.k}`,
      kind: "tool",
      name,
      attempt: options.attempt ?? 1,
      synthetic: options.synthetic ?? false,
      cache_hit: options.cacheHit ?? false,
    };
    if (options.effectKey !== undefined) entry.effect_key = options.effectKey;
    const parent = currentCall();
    if (parent?.frame === this) entry.parent_call_id = parent.callId;
    if (args !== undefined) entry.args = this.blob(args);
    if (options.synthetic) this.flag("synthetic");
    const call = this.add(entry);
    if (options.adoptable) this.adoptable.push(call);
    return call;
  }

  /**
   * The open call of `name` an adapter recorded from its framework's callbacks, taken over by the `tool()`
   * wrapper running inside it, so the call is recorded once, with the wrapper's arguments.
   */
  adopt(name: string, args: unknown): CallCapture | undefined {
    for (let i = 0; i < this.adoptable.length; i++) {
      const call = this.adoptable[i];
      if (call === undefined || call.done || call.entry.name !== name) continue;
      this.adoptable.splice(i, 1);
      const before = call.entry.args;
      if (typeof before === "string") this.blobs.delete(before);
      const key = args === undefined ? undefined : this.blob(args);
      if (key === undefined) delete call.entry.args;
      else call.entry.args = key;
      return call;
    }
    return undefined;
  }

  /**
   * Records a model call that already ended, with its tokens when the provider reported them. The first
   * model named becomes the turn's `model` pin unless the build set one.
   */
  modelCall(
    model: string | null | undefined,
    options: { tokensIn?: number | null; tokensOut?: number | null; tokensCached?: number; latencyMs?: number; callId?: string; status?: CallStatus } = {},
  ): void {
    const entry: CallEntry = { call_id: options.callId ?? `m${++this.counters.m}`, kind: "model", status: options.status ?? "ok" };
    if (model) {
      entry.name = model;
      this.pinModel(model);
    }
    if (options.tokensIn != null && options.tokensOut != null) {
      entry.tokens = { in: options.tokensIn, cached: options.tokensCached ?? 0, out: options.tokensOut };
    }
    if (options.latencyMs !== undefined) entry.latency_ms = options.latencyMs;
    const parent = currentCall();
    if (parent?.frame === this) entry.parent_call_id = parent.callId;
    this.add(entry);
  }

  /** The SDK profile of the client that opened this turn, as far as the tools need it. */
  get profile(): Pick<Submit, "families" | "fieldAccess" | "bindings"> {
    return this.recorder ?? {};
  }

  /** The model the turn called, as its `model` pin, unless the build named one. */
  pinModel(model: string): void {
    this.pins.model ??= model;
  }

  /**
   * A read the turn made from Niadra, by its version: the pack by ETag, a block by its version. `value` is what
   * the read served, kept as a blob of the record so a replay and the tool counterfactual have it.
   */
  read(surface: string, options: { etag?: string | null; version?: string | null; receiptId?: string | null; value?: unknown } = {}): void {
    if (this.closed) return;
    const entry: Record<string, unknown> = { surface };
    if (options.etag) entry.etag = options.etag;
    if (options.version) entry.version = options.version;
    if (options.receiptId) entry.receipt_id = options.receiptId;
    if (options.value !== undefined && options.value !== null) {
      const key = this.blob(options.value);
      if (key !== undefined) entry.blob = key;
    }
    this.reads.push(entry);
  }

  /**
   * What the person was shown or did in the turn, as the interaction spec writes it: a `presented` list (with its
   * `exposure_id` and positions), a `seen`, an `engaged` item of it, a preference. A replay and the tool
   * counterfactual read where the person engaged from here.
   */
  interact(item: Record<string, unknown>): void {
    if (this.closed) return;
    this.interactions.push(JSON.parse(JSON.stringify(item)) as Record<string, unknown>);
  }

  /** The pack this turn read: its compiler's version and hash become the turn's `niadra` pins. */
  pack(compiler: string | null | undefined, packHash: string | null | undefined): void {
    const pins: Record<string, string> = {};
    if (compiler) pins.compiler = compiler;
    if (packHash) pins.pack_hash = packHash;
    if (Object.keys(pins).length > 0) this.pins.niadra = pins;
  }

  /** Fields of objects a read served the turn, kept for the claim check. */
  observeState(values: readonly StateValue[]): void {
    if (!this.closed) this.state.push(...values);
  }

  /**
   * Something the turn emitted: `eventKey` names the event `track()` sent for it (the text itself is never
   * repeated in the record), and the text is kept for the claim check the sender runs.
   */
  say(text: string, options: { eventKey?: string | null; context?: string; immutable?: boolean; agent?: string | null } = {}): void {
    if (this.closed) return;
    if (options.eventKey) this.eventKeys.push(options.eventKey);
    if (this.recorder !== null && !this.guardedTexts.has(text)) {
      this.said.push({ text, context: options.context ?? "chat", immutable: options.immutable ?? false, agent: options.agent ?? this.agent });
    }
  }

  /** A coordination decision the turn acted on. */
  coordinate(decisionId: string, decision: string): void {
    if (!this.closed) this.coordination.push({ decision_id: decisionId, decision });
  }

  /** What the turn saw of an effect: its last state by key. */
  effect(key: string, state: string): void {
    if (!this.closed) this.effects.set(key, state);
  }

  /** The claim guard checked `text` and recorded its claims: saying it later adds none. */
  guarded(text: string): void {
    this.guardedTexts.add(text);
  }

  addClaims(records: readonly ClaimRecord[]): void {
    this.claims.push(...records);
  }

  /** Marks the turn: a flagged turn keeps its values longest in the queue and goes to the kept tier. */
  flag(name: Flag): void {
    this.flags.add(name);
  }

  /** The capture failed during the turn: its record says so. */
  incomplete(): void {
    this.completeness = "incomplete";
    this.flags.add("incomplete");
  }

  // Lifecycle

  /** Runs `fn` with this turn current; the turn stays open. */
  run<R>(fn: () => R): R {
    const frames = turns();
    return frames ? frames.run(this, fn) : fn();
  }

  /** Makes this the current turn of the running async context, for adapters that open a turn in one callback. */
  enter(): this {
    turns()?.enterWith(this);
    return this;
  }

  /** Ends the turn and hands its record to the queue. Later calls do nothing. */
  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.endedAt = new Date();
    this.latencyMs = Math.round(performance.now() - this.started);
    if (error !== undefined && error !== null) this.flags.add("error");
    for (const entry of this.calls) entry.status ??= "cancelled"; // a call the turn left open never returned in it
    if (this.recorder !== null && this.playback === null) this.recorder.submit(this);
  }

  // For the queue and the sender

  /** The value of a blob the frame still holds, read back from its copy; `undefined` otherwise. */
  valueOf(key: unknown): unknown {
    const data = typeof key === "string" ? this.blobs.get(key)?.data : null;
    if (data == null) return undefined;
    try {
      return JSON.parse(data) as unknown;
    } catch {
      return undefined;
    }
  }

  get flagged(): boolean {
    return this.flags.size > 0;
  }

  /** Bytes the queue counts for this turn: its blobs' values and an estimate of the frame. */
  get size(): number {
    let values = 0;
    for (const blob of this.blobs.values()) if (blob.data !== null) values += blob.size;
    return this.sizeWithoutValues + values;
  }

  get sizeWithoutValues(): number {
    return FRAME_BYTES + CALL_BYTES * this.calls.length;
  }

  /**
   * Drops the values of the blobs to make room. A blob whose digest is known stays as its digest; the
   * others leave the record, with the call fields that named them. Returns the bytes freed.
   */
  dropBlobs(): number {
    let freed = 0;
    for (const [key, blob] of [...this.blobs]) {
      if (blob.data === null) continue;
      freed += blob.size;
      blob.data = null;
      if (blob.sha256 === undefined) {
        this.blobs.delete(key);
        for (const entry of this.calls) {
          if (entry.args === key) delete entry.args;
          if (entry.result_model === key) delete entry.result_model;
          if (entry.result_ui === key) delete entry.result_ui;
        }
      }
    }
    if (freed > 0 && this.completeness === "complete") this.completeness = "partial";
    return freed;
  }

  /** Copies `value` as a blob of the record; `undefined` when it has no copy, and the turn says so. */
  blob(value: unknown): string | undefined {
    let data: string;
    try {
      data = snapshot(value);
    } catch {
      this.incomplete();
      return undefined;
    }
    const key = `b:${++this.counters.b}`;
    this.blobs.set(key, { data, size: data.length });
    return key;
  }

  private add(entry: CallEntry): CallCapture {
    if (!this.closed) this.calls.push(entry);
    return new CallCapture(this, entry);
  }
}
