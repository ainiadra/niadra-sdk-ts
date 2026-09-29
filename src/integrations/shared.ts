/**
 * What every framework adapter shares: the five primitives (context before the model call, the
 * turns, the tools, the verification and the handoff) wired the same way, and fail-open.
 *
 * Nothing here throws into the framework: a failed read gives an empty context, a failed write
 * is logged without content, and the agent keeps working without memory.
 */

import { recordedTool } from "../capture/tool.js";
import type { Played } from "../replay/playback.js";
import type { AgentMemoryParams } from "../agent-memory.js";
import type { TurnParams } from "../agent-session.js";
import type { CallCapture, TurnFrame } from "../capture/frame.js";
import type { ContextOptions, ContextResult } from "../context.js";
import { emptyResult } from "../context.js";
import type { Conversation, TurnOptions } from "../conversation.js";
import type { Logger } from "../logger.js";
import type { Task } from "../task.js";
import type { BoundTools } from "../tools.js";
import type { Handle } from "../types/common.js";
import type { Verification, VerifyMethod } from "../types/vocabulary.js";

/** A customer conversation or an internal agent's task. */
export type Session = Conversation | Task;

/** A session, or a function that finds the one the current call belongs to (`null` passes the call through). */
export type SessionResolver<S extends Session = Session> = S | (() => S | null | undefined);

/** What the framework proved about the person, recorded with `verify()` before the first context read. */
export interface Proof {
  method: VerifyMethod;
  level: Verification;
  /** Defaults to the session's subject. */
  handle?: Handle;
}

/** A proof, or a function that reads it from the framework when the first context is needed. */
export type ProofSource =
  | Proof
  | null
  | undefined
  | (() => Proof | null | undefined | PromiseLike<Proof | null | undefined>);

/**
 * The agent's own working notes: `true` puts the block before the customer's context and offers
 * `search_agent_memory`; `{ write: true }` also offers `remember` (for a key with the
 * `agent_memory:write` scope); the other fields go to `agentMemory()`.
 */
export type AgentMemoryOption = boolean | (AgentMemoryParams & { write?: boolean });

/** What goes into the prompt for one model call. */
export interface Read {
  context: ContextResult;
  /** The agent's own notes, or an empty string. */
  memory: string;
  /** What goes after the instructions: the notes, then the customer's pack. */
  prefix: string;
  /** What goes at the end: live turns, the turn's slots and deltas. */
  suffix: string;
}

/** A tool as every framework needs it: the name, the text for the model, the JSON Schema and the call. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. None of them names the customer. */
  parameters: Record<string, unknown>;
  /** Runs the call and returns the text for the model. Never rejects in fail-open mode. */
  execute(args: string | Record<string, unknown>): Promise<string>;
}

const ATTESTED: Record<string, Verification> = { A: "V2", B: "V1", C: "V1" };

/**
 * The proof a carrier's STIR/SHAKEN attestation gives a phone call: `A` proves V2, `B` and `C`
 * prove V1, anything else proves nothing (`null`). Accepts the bare letter or the forms carriers
 * and platforms send, such as Twilio's `TN-Validation-Passed-A`.
 */
export function attestationProof(attestation: string | null | undefined): Proof | null {
  if (!attestation) return null;
  const value = attestation.trim().toUpperCase();
  if (value.includes("FAILED") || value.startsWith("NO-")) return null;
  const letter = value.length === 1 ? value : /PASSED-([ABC])$/.exec(value)?.[1];
  const level = letter ? ATTESTED[letter] : undefined;
  return level ? { method: "network_attestation", level } : null;
}

export function resolveSession<S extends Session>(source: SessionResolver<S>): S | null {
  if (typeof source !== "function") return source;
  try {
    return source() ?? null;
  } catch {
    return null;
  }
}

export function isConversation(session: Session): session is Conversation {
  return "customer" in session && typeof session.customer === "function";
}

/** A phone number as an E.164 handle, or `null` when it does not look like one. */
export function phoneHandle(value: string | null | undefined): Handle | null {
  const raw = value?.trim().replace(/^tel:/i, "").replace(/[\s().-]/g, "");
  if (!raw) return null;
  const e164 = raw.startsWith("+") ? raw : `+${raw}`;
  return /^\+[1-9]\d{6,14}$/.test(e164) ? { type: "phone_e164", value: e164 } : null;
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * One session as an adapter drives it. Keeps the verification to a single call made before the
 * first context read, and turns every failure into a log line.
 */
export class Bridge {
  private proving: Promise<void> | null = null;
  /** `begin()` started the first read of a call: the first `context()` waits for it with `ready()`. */
  private begun = false;
  private opened = false;

  constructor(
    readonly session: Session,
    private readonly proof?: ProofSource,
    private readonly memory: AgentMemoryOption = false,
  ) {}

  /**
   * The context and, when enabled, the agent's notes, read side by side within the same budget.
   * Never rejects.
   */
  async read(options: ContextOptions = {}): Promise<Read> {
    const memoryParams = this.memory === false ? null : this.memory === true ? {} : withoutWrite(this.memory);
    const [context, memory] = await Promise.all([
      this.context(options),
      memoryParams ? this.agentMemory(memoryParams, options) : Promise.resolve(""),
    ]);
    return { context, memory, prefix: [memory, context.text].filter(Boolean).join("\n\n"), suffix: context.suffix };
  }

  get logger(): Logger {
    return this.session.logger;
  }

  /**
   * Starts the first read of a call now, in the background, after the proof when one was given (the
   * pack depends on the level it proves): at call start, so the read runs while the call is set up.
   * The first `context()` then waits for it within `timeouts.contextVoiceStart`. Never throws.
   */
  begin(): void {
    const session = this.session;
    if (!isConversation(session)) return;
    const start = (): void => {
      this.safe("start the first read", () => {
        // False off the voice read path (a chat view, the cache off): reads go on as before.
        this.begun = session.begin();
      });
    };
    if (this.proof === undefined || this.proof === null) start();
    else void this.verifyOnce().then(start);
  }

  /** Verifies once (when a proof was given), then reads the context. Never rejects. */
  async context(options: ContextOptions = {}): Promise<ContextResult> {
    await this.verifyOnce();
    try {
      const session = this.session;
      if (this.begun && !this.opened && isConversation(session)) {
        this.opened = true;
        // The call's first read, begun at call start: waited for within its own, longer budget.
        await session.ready(options.timeout === undefined ? {} : { timeout: options.timeout });
      }
      return await this.session.context(options);
    } catch (error) {
      this.logger.warn(`could not read context (${errorName(error)})`);
      return emptyResult(null);
    }
  }

  /** Records that `context` went into the prompt, unless it was empty for a reason other than the holdout. */
  injected(context: ContextResult): void {
    if (!context.text && !context.suffix && context.response?.path !== "holdout") return;
    this.safe("mark the injection", () => {
      this.session.markInjected(context);
    });
  }

  customer(text: string, options: TurnOptions = {}): void {
    const session = this.session;
    if (!text.trim() || !isConversation(session)) return;
    this.safe("record the customer's turn", () => session.customer(text, options));
  }

  /** Sends the customer's turn so far, while they speak. In the background; never throws. */
  prefetch(text: string): void {
    const session = this.session;
    if (!text.trim() || !isConversation(session)) return;
    this.safe("prefetch the turn", () => session.prefetch(text));
  }

  agent(text: string, options: TurnOptions = {}): void {
    if (!text.trim()) return;
    this.safe("record the agent's turn", () => this.session.agent(text, options));
  }

  /** Records a transfer. Tasks have no transfer; the call is ignored for them. */
  async handoff(target: "agent" | "human", reason?: string): Promise<void> {
    const session = this.session;
    if (!isConversation(session)) return;
    try {
      await session.handoff(reason ? { target, reason } : { target });
    } catch (error) {
      this.logger.warn(`could not record the handoff (${errorName(error)})`);
    }
  }

  async end(): Promise<void> {
    try {
      await this.session.end();
    } catch (error) {
      this.logger.warn(`could not end the session (${errorName(error)})`);
    }
  }

  /** The navigation kit as plain specs (with the agent's memory tools when enabled), or none for a task about an object only. */
  tools(): ToolSpec[] {
    let bound: BoundTools | null;
    try {
      const memory = this.memory;
      bound = this.session.tools(memory === false ? {} : { agentMemory: true, writeAgentMemory: memory !== true && memory.write === true });
    } catch (error) {
      this.logger.warn(`could not build the tools (${errorName(error)})`);
      return [];
    }
    return bound ? toolSpecs(bound) : [];
  }

  private async agentMemory(params: AgentMemoryParams, options: ContextOptions): Promise<string> {
    try {
      const result = await this.session.agentMemory(params, options.timeout === undefined ? {} : { timeout: options.timeout });
      return result.text;
    } catch (error) {
      this.logger.warn(`could not read the agent's memory (${errorName(error)})`);
      return "";
    }
  }

  private async verifyOnce(): Promise<void> {
    if (this.proof === undefined || this.proof === null) return;
    this.proving ??= this.runVerify();
    await this.proving;
  }

  private async runVerify(): Promise<void> {
    try {
      const source = this.proof;
      const proof = typeof source === "function" ? await source() : source;
      if (!proof) return;
      await this.session.verify(proof);
    } catch (error) {
      this.logger.warn(`could not record the verification (${errorName(error)})`);
    }
  }

  private safe(what: string, run: () => unknown): void {
    try {
      run();
    } catch (error) {
      this.logger.warn(`could not ${what} (${errorName(error)})`);
    }
  }
}

function withoutWrite(option: AgentMemoryParams & { write?: boolean }): AgentMemoryParams {
  const { write: _, ...params } = option;
  return params;
}

/** The bound kit as specs. The customer stays inside `bound`; no parameter names them. */
export function toolSpecs(bound: BoundTools): ToolSpec[] {
  return bound.definitions.map(({ function: definition }) => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    execute: (args) => bound.call(definition.name, args),
  }));
}

/** The text of a message content in the shapes model APIs use: a string, or a list of text parts. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content as unknown[]) {
    if (typeof part === "string") parts.push(part);
    else if (isRecord(part) && typeof part.text === "string" && (part.type === undefined || part.type === "text")) {
      parts.push(part.text);
    }
  }
  return parts.join("");
}

export function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

/** A non-negative integer, or `null`. */
export function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The turn records an adapter keeps from its framework's callbacks, keyed by the framework's own ids (a
 * run, a request, a tool call id). A run starting while the session has a turn in progress (yours, from
 * `conversation.turn()`, or a replay's) records into it; otherwise the adapter opens its own turn and closes
 * it when the run ends. A tool call recorded here is taken over by a `tool()` wrapper running inside it, so
 * the call is recorded once. Every method does nothing when turns are off and never throws.
 */
export class TurnHooks {
  /** Runs held open at most; past it the oldest run's turn closes, incomplete (a run whose end never came). */
  static readonly MAX_OPEN = 100;
  private readonly frames = new Map<string, { frame: TurnFrame; own: boolean }>();
  private readonly calls = new Map<string, CallCapture>();

  constructor(
    readonly adapter: string,
    readonly enabled: boolean,
  ) {}

  /** The turn of the run `key`: the session's turn in progress, or a new one of its own. */
  open(session: Session, key: string, params: TurnParams = {}): TurnFrame | undefined {
    if (!this.enabled) return undefined;
    const held = this.frames.get(key);
    if (held !== undefined) return held.frame;
    try {
      const active = session.activeTurn();
      if (active !== undefined && !this.owns(active)) {
        this.frames.set(key, { frame: active, own: false });
        return active;
      }
      const frame = session.openTurn({ ...params, adapter: this.adapter });
      this.frames.set(key, { frame, own: true });
      if (this.frames.size > TurnHooks.MAX_OPEN) {
        const [oldest] = this.frames.keys();
        if (oldest !== undefined) {
          this.frames.get(oldest)?.frame.incomplete();
          this.close(oldest);
        }
      }
      return frame;
    } catch (error) {
      session.logger.warn(`could not open the turn (${errorName(error)})`);
      return undefined;
    }
  }

  /** The turn of `key`, else the session's turn in progress. */
  frame(session: Session, key?: string): TurnFrame | undefined {
    if (!this.enabled) return undefined;
    const held = key === undefined ? undefined : this.frames.get(key);
    const frame = held?.frame ?? session.activeTurn();
    return frame === undefined || frame.closed ? undefined : frame;
  }

  has(key: string): boolean {
    return this.frames.has(key);
  }

  private owns(frame: TurnFrame): boolean {
    for (const held of this.frames.values()) if (held.own && held.frame === frame) return true;
    return false;
  }

  /** Ends the run `key`: a turn the adapter opened closes; the calls it left open failed. */
  close(key: string, error?: unknown): void {
    const held = this.frames.get(key);
    if (held === undefined) return;
    this.frames.delete(key);
    for (const [callKey, call] of this.calls) {
      if (call.frame !== held.frame) continue;
      this.calls.delete(callKey);
      if (held.own) call.failed(error ?? "error");
    }
    if (held.own) held.frame.close(error);
  }

  /** A tool call starting, keyed by `callKey`; `callId` is the provider's id of the call, when there is one. */
  toolStart(session: Session, callKey: string, name: string, args: unknown, options: { frameKey?: string; callId?: string | null } = {}): void {
    const frame = this.frame(session, options.frameKey);
    if (frame === undefined) return;
    try {
      this.calls.set(callKey, frame.toolCall(name, args, { callId: options.callId ?? null, adoptable: true }));
    } catch {
      frame.incomplete();
    }
  }

  /**
   * In a replay, how a framework tool the adapter stands in for answers: the recorded result of a call with the
   * same arguments, or empty (a divergence), never the live tool. `null` outside a replay, and for a function
   * wrapped with `tool()`, which answers itself.
   */
  replayed(session: Session, name: string, args: unknown, fn?: unknown, frameKey?: string): Played | null {
    const frame = this.enabled ? this.frame(session, frameKey) : session.activeTurn();
    if (frame?.playback == null || (fn !== undefined && recordedTool(fn) !== null)) return null;
    return frame.playback.answer(name, args, false);
  }

  toolEnd(callKey: string, result?: unknown, error?: unknown): void {
    const call = this.calls.get(callKey);
    if (call === undefined) return;
    this.calls.delete(callKey);
    try {
      if (error !== undefined) call.failed(error);
      else call.result(result);
    } catch {
      call.frame.incomplete();
    }
  }

  /** A model call that ended, with its tokens when the framework reported them. */
  model(
    session: Session,
    model: string | null | undefined,
    tokens: { in?: number | null; out?: number | null; cached?: number | null } = {},
    frameKey?: string,
  ): void {
    const frame = this.frame(session, frameKey);
    if (frame === undefined) return;
    try {
      frame.modelCall(model, { tokensIn: tokens.in ?? null, tokensOut: tokens.out ?? null, tokensCached: tokens.cached ?? 0 });
    } catch {
      frame.incomplete();
    }
  }
}
