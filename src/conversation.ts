import type { Niadra, WriteResult } from "./client.js";
import { AgentSession } from "./agent-session.js";
import type { ClaimParams, TurnParams } from "./agent-session.js";
import type { AgentStateHandle } from "./agent-state.js";
import type { ClaimCheck } from "./capture/check.js";
import type { TurnFrame } from "./capture/frame.js";
import type { CheckOptions, Claimed, Declarations } from "./coordination/client.js";
import type { ClaimVerdict } from "./resolvers.js";
import type { CheckResult } from "./types/coordination.js";
import type { StateRef } from "./types/state.js";
import type { AgentMemoryParams, AgentMemoryResult } from "./agent-memory.js";
import type { ContextOptions, ContextParams, ContextResult, RequestOptions } from "./context.js";
import { uuidv7 } from "./ids.js";
import { hasTarget } from "./items.js";
import type { ActionEvent, Timestamp, TrackEvent } from "./items.js";
import type { Logger } from "./logger.js";
import type { BackingReport, UnbackedValue } from "./backing.js";
import { SessionState } from "./session.js";
import type { Timings } from "./session.js";
import type { BoundTools, ToolBinding, ToolOptions } from "./tools.js";
import type { Handle } from "./types/common.js";
import type { TargetModel } from "./types/context.js";
import type { Backing, Content, ContextStamp, ModelUsage, VoiceInfo } from "./types/events.js";
import { asModelUsage } from "./usage.js";
import type { Speaker, Verification, VerifyMethod, View, Visibility } from "./types/vocabulary.js";

export interface ConversationParams {
  /** The customer on the other side. */
  subject: Handle;
  /** Where the conversation happens, such as `whatsapp` or `voice`. */
  channel: string;
  /** Your id for the thread. A UUIDv7 is minted when omitted. */
  conversation_id?: string;
  /** Defaults to `voice` when the channel is `voice`, otherwise `chat`. */
  view?: View;
  /** The level already proven when the conversation starts. Defaults to `V0`. */
  verification?: Verification;
  /** The account or partner the customer acts for. */
  about?: Handle;
  target?: TargetModel;
  /** Your agent's id within the source: its turns, working state and coordination are its own. */
  agent_id?: string;
}

/** Optional details of one captured turn. */
export interface TurnOptions {
  /** The provider's message id, which makes retries of the same turn harmless. */
  idempotency_key?: string;
  occurred_at?: Timestamp;
  /** The agent or attendant id inside your system. */
  speaker_id?: string;
  visibility?: Visibility;
  /** Marks the text as a speech-to-text transcript with this confidence, between 0 and 1. */
  stt_confidence?: number;
  voice?: VoiceInfo;
  /** Overrides the stamp an agent turn would carry from `markInjected()`. */
  context_stamp?: ContextStamp;
  /**
   * More ids of the same person, such as a BSUID next to the `wa_id`. They go along with the
   * subject, which always comes first.
   */
  handles?: Handle[];
  /** Replaces the text content, such as a voice note or an image by reference (`media_ref`). */
  content?: Content;
  /**
   * Agent turns only: what the model provider reported for the call behind the answer, as the
   * provider's response (OpenAI or Anthropic) or a `ModelUsage`. `wrap()` passes it for you. A
   * response without usage is left out; the turn is recorded either way.
   */
  usage?: ModelUsage | object | null;
}

/**
 * Agent turns only: with `strict: true`, an answer stating a value no source backs, or one that
 * goes against a guard line, is not sent; `agent()` returns those values instead (a card or
 * document number masked), and an empty array when the turn was sent.
 */
export interface AgentTurnOptions extends TurnOptions {
  strict?: boolean;
}

export type ConversationEvent = Omit<TrackEvent, "channel" | "conversation_id"> & { channel?: string };
export type ConversationAction = Omit<ActionEvent, "channel" | "conversation_id"> & { channel?: string };

export interface ConversationHooks {
  endConversation(id: string): Promise<WriteResult>;
}

/**
 * One customer conversation.
 *
 * The server pins the pack to the conversation: every turn gets the same bytes, so the prompt
 * prefix stays byte-identical and the model provider's prompt cache keeps hitting. After the
 * first pack, each read also asks for the delta, what changed since this agent last looked
 * (a new open item, an action another agent took). The server sends each delta once, so the
 * conversation keeps them, in order, in `suffix`, after the live turns, for the end of the
 * prompt. A successful `verify()` starts over from the pack the server pins for the new level.
 *
 * Every read sends the customer's last turn along (the text of the last `customer()`). The server
 * picks from memory what that turn needs and the answer carries it as `slots`, in `suffix` between
 * the live turns and the delta; the pinned pack does not change. `prefetch()` sends a partial
 * transcript while the customer is still speaking.
 *
 * In the `voice` view, `begin()` starts the first read when the call starts and `ready()` waits for
 * it there; later turns get the pinned pack from memory at once, and their slots from the read a
 * prefetch made of their words (`voice.ts`). Ending the conversation drops what the SDK kept for it.
 *
 * Call `markInjected()` when the pack goes into the prompt; the agent's later turns and actions
 * carry that moment and the pack's etag as `context_stamp`. `wrap()` does it for you.
 *
 * `agent()` checks the answer first: every number, date, code and amount it states is looked up in
 * what the agent had in this conversation (the packs and suffixes it read, the customer's words, a
 * human attendant's, the results of actions and tools), and against the pack's guard lines. The
 * turn carries what was found as `backing`, kinds and counts only; `strict: true` returns the values
 * with no source instead of sending. `toolResult()` records what a tool of your own returned.
 *
 * @example
 * const convo = niadra.conversation({ subject: handles.waId("5511987654321"), channel: "whatsapp" });
 * convo.customer(inbound.text, { idempotency_key: inbound.id });
 * const ctx = await convo.context();
 * convo.markInjected(ctx);
 * const reply = await llm(ctx.text, history, ctx.suffix);
 * convo.agent(reply);
 */
export class Conversation {
  readonly id: string;
  readonly channel: string;
  readonly subject: Handle;
  private level: Verification;
  private readonly view: View;
  private readonly state = new SessionState();
  private ending: Promise<WriteResult> | null = null;
  private turnText: string | null = null;
  private prefetched: string | null = null;
  private readonly features: AgentSession;

  constructor(
    private readonly client: Niadra,
    private readonly params: ConversationParams,
    private readonly hooks: ConversationHooks,
  ) {
    this.id = params.conversation_id ?? uuidv7();
    this.channel = params.channel;
    this.subject = params.subject;
    this.level = params.verification ?? "V0";
    this.view = params.view ?? (params.channel === "voice" ? "voice" : "chat");
    const scope = { kind: "conversation" as const, id: this.id };
    this.features = new AgentSession(client.agentHost, scope, params.agent_id ?? "agent", params.subject, null, params.channel);
  }

  /** The claim contract: `check()` classifies and counts, `guard()` and `guardText()` act as its actions say. */
  get claims(): ClaimCheck {
    return this.features.claims;
  }

  /** What the agent declares after it acts, sent in the background: `declare.effect(key, "done")`, ... */
  get declare(): Declarations {
    return this.features.declare;
  }

  /** This conversation's working state for its agent: `get()` and `put()` (`agent-state.ts`). */
  get agentState(): AgentStateHandle {
    return this.features.agentState;
  }

  /**
   * Runs `fn` as a turn of this conversation, from its input to the last thing it emits: its reads, the tools
   * wrapped with `niadra.tool()` and what it says are recorded, with the build it ran on. Opened inside another
   * turn, it is a sub-turn of it.
   */
  turn<T>(fn: (frame: TurnFrame) => T | Promise<T>): Promise<T>;
  turn<T>(params: TurnParams, fn: (frame: TurnFrame) => T | Promise<T>): Promise<T>;
  turn<T>(first: TurnParams | ((frame: TurnFrame) => T | Promise<T>), second?: (frame: TurnFrame) => T | Promise<T>): Promise<T> {
    return typeof first === "function" ? this.features.turn({}, first) : this.features.turn(first, second as (frame: TurnFrame) => T | Promise<T>);
  }

  /** A turn opened and closed by hand (`frame.run(fn)`, then `frame.close()`), for adapters. */
  openTurn(params: TurnParams = {}): TurnFrame {
    return this.features.openTurn(params);
  }

  /**
   * Asks before acting: the coordination decision for `intent` of `purpose` about this customer. With
   * `effectKey`, an `allow` whose `effect.state` is `none` reserved the effect: act, then
   * `declare.effect(key, ...)`. Within `timeoutMs` (200 ms), or the purpose's direction decides; never rejects.
   */
  check(intent: string, options: CheckOptions): Promise<CheckResult> {
    return this.features.check(intent, options);
  }

  /**
   * Claims this customer, or with `object` and `task` a task lock on a business object, for `leaseS`
   * seconds: `held` when it is this agent's, otherwise `error` says why. Never rejects.
   */
  claim(params: ClaimParams = {}): Promise<Claimed> {
    return this.features.claim(params);
  }

  /** Whether `value` may be claimed for `field` of `ref` now, about this customer. See `niadra.verifyClaim`. */
  verifyClaim(ref: StateRef | string, field: string, value: unknown, options: { budgetMs?: number } = {}): Promise<ClaimVerdict> {
    return this.features.verifyClaim(ref, field, value, options);
  }

  /** The level in force for this conversation, raised by a successful `verify()`. */
  get verification(): Verification {
    return this.level;
  }

  /**
   * When context first went into the prompt, and when the agent first spoke. Context injected
   * after the agent's first turn is the "late context" signal the usage measurement reports.
   */
  get timings(): Timings {
    return this.state.timings;
  }

  /** What the agent's next turn and action carry: the last `markInjected()`, or `null`. */
  get contextStamp(): ContextStamp | null {
    return this.state.contextStamp;
  }

  /** The last result `context()` returned for this conversation. */
  get lastContext(): ContextResult | null {
    return this.state.lastContext;
  }

  /** The text of the last `customer()` turn, which the next `context()` sends. */
  get lastTurn(): string | null {
    return this.turnText;
  }

  /** The last backing check of an agent's answer: the values with no source, as said. */
  get lastBacking(): BackingReport | null {
    return this.state.lastBacking;
  }

  /** Where `wrap()` reports what it swallowed: the client's logger. */
  get logger(): Logger {
    return this.client.logger;
  }

  /**
   * The pack for this turn: the pinned `text`, and a `suffix` with every delta since the pin,
   * the current live turns and what the customer's last turn selected from memory. `turn` passes
   * the customer's turn when `customer()` has not recorded it yet (`null` reads without one).
   * `query` picks this read's slots by other words than the turn; the pack is the pinned one.
   */
  async context(options: ContextOptions & { query?: string; turn?: string | null } = {}): Promise<ContextResult> {
    const { query, turn, format, explain, include, ...requestOptions } = options;
    const params: ContextParams = {
      subject: this.subject,
      view: this.view,
      verification: this.level,
      conversation_id: this.id,
      ...(this.params.about ? { about: this.params.about } : {}),
      ...(this.params.target ? { target: this.params.target } : {}),
      ...(format === "json" ? { format } : {}),
      ...(explain ? { explain } : {}),
    };
    if (query) params.query = query;
    if (include?.length) params.include = include;
    if (this.state.wantsDelta) params.delta = true;
    params.turn = turn === undefined ? this.turnText : turn;
    const result = await this.client.context(params, requestOptions);
    this.features.observe(result);
    return this.state.observe(this.state.absorb(result));
  }

  /**
   * Starts this conversation's first read now, in the background: call it when the call starts
   * (ringing, the inbound webhook), so the read runs while the call is set up. The voice view
   * only; see `niadra.begin()`.
   */
  begin(): boolean {
    return this.client.begin({
      subject: this.subject,
      view: this.view,
      verification: this.level,
      conversation_id: this.id,
      ...(this.params.about ? { about: this.params.about } : {}),
      ...(this.params.target ? { target: this.params.target } : {}),
    });
  }

  /**
   * `begin()`, then the pack of that first read, waiting for it within what is left of
   * `timeouts.contextVoiceStart`: for the moment the call starts, when the platform waits anyway.
   * Outside the voice view, a `context()` without the customer's turn.
   */
  async ready(options: RequestOptions = {}): Promise<ContextResult> {
    this.begin();
    const timeout = options.timeout ?? this.client.startBudget(`conversation:${this.id}`);
    return this.context({ ...options, turn: null, ...(timeout === undefined ? {} : { timeout }) });
  }

  /**
   * Sends a partial transcript of the customer's turn while they speak, so the read that answers
   * the turn finds their memory warm and, in the voice view, reads the turn with it once the words
   * stop changing. In the background; never rejects. See `niadra.prefetch()`.
   */
  prefetch(text: string): boolean {
    if (text === this.prefetched) return false;
    this.prefetched = text;
    return this.client.prefetch({
      subject: this.subject,
      view: this.view,
      verification: this.level,
      conversation_id: this.id,
      ...(this.params.about ? { about: this.params.about } : {}),
      text,
    });
  }

  /**
   * The agent's own working notes for this conversation's prompt, as `niadra.agentMemory()` with
   * the conversation's view: put `text` after your instructions and before the customer's context.
   */
  agentMemory(params: AgentMemoryParams = {}, options: RequestOptions = {}): Promise<AgentMemoryResult> {
    return this.client.agentMemory({ view: this.view, ...params }, options);
  }

  /**
   * Records that `context` (by default the last one this conversation returned) went into the
   * prompt. Call it each time you build the prompt; `timings.contextInjectedAt` keeps the first.
   */
  markInjected(context?: ContextResult | null, at: Date = new Date()): void {
    this.state.markInjected(context, at);
  }

  /** Captures what the customer said. The text is also the turn the next `context()` sends. */
  customer(text: string, options: TurnOptions = {}): string | null {
    if (text.trim()) {
      this.turnText = text;
      this.state.sources.add(text);
    }
    return this.emit("customer", text, options);
  }

  /**
   * Captures what the AI agent said, stamped with the context its prompt carried and with what the
   * backing check found in it (`backing`: kinds and counts, never a value). With `strict: true` an
   * answer with a value no source backs, or one against a guard line, is not sent: its values come
   * back instead, and an empty array means it was sent.
   */
  agent(text: string, options?: AgentTurnOptions & { strict?: false }): string | null;
  agent(text: string, options: AgentTurnOptions & { strict: true }): UnbackedValue[];
  agent(text: string, options: AgentTurnOptions = {}): string | null | UnbackedValue[] {
    const { strict, ...turnOptions } = options;
    const checked = this.state.checkAnswer(text);
    if (strict && checked?.problems.length) return checked.problems;
    const stamp = this.state.agentTurn();
    const key = this.emit("ai_agent", text, stamp ? { context_stamp: stamp, ...turnOptions } : turnOptions, checked?.backing);
    this.features.said(text, key);
    return strict ? [] : key;
  }

  /** Captures what a human attendant said, for example after a handoff. It backs the agent's answers. */
  human(text: string, options: TurnOptions = {}): string | null {
    this.state.sources.add(text);
    return this.emit("human_agent", text, options);
  }

  /**
   * Records what a tool the agent called returned (text, or anything JSON can write), so the values
   * in it back the agent's answers. Nothing is sent; the history tools of `tools()` are recorded
   * for you.
   */
  toolResult(result: unknown): void {
    this.state.toolResult(result);
  }

  /** Records any event in this conversation. The customer's handle is attached unless you pass your own. */
  track(event: ConversationEvent): string | null {
    return this.client.track({ ...this.bind(event), ...event, channel: event.channel ?? this.channel });
  }

  /** Records an action the agent took during this conversation, stamped like its turns. */
  action(event: ConversationAction): string | null {
    const stamp = this.state.actionStamp(event.speaker);
    // What the system of record answered backs the agent's next words.
    if (event.result) this.state.sources.add(event.result);
    return this.client.action({
      ...this.bind(event),
      ...(stamp ? { context_stamp: stamp } : {}),
      ...event,
      channel: event.channel ?? this.channel,
    });
  }

  /**
   * Records that the customer proved who they are, and raises the level for later reads.
   * `handle` defaults to the conversation's subject.
   */
  async verify(params: { method: VerifyMethod; level: Verification; handle?: Handle }): Promise<WriteResult> {
    const result = await this.client.verify({
      method: params.method,
      level: params.level,
      handle: params.handle ?? this.subject,
      conversation_id: this.id,
    });
    if (result.ok) {
      this.level = params.level;
      this.state.reset();
    }
    return result;
  }

  /** Records a transfer to a human or another agent. */
  handoff(params: {
    target: "human" | "agent";
    target_source?: string;
    reason?: string;
    mode?: "warm" | "cold";
  }): Promise<WriteResult> {
    return this.client.handoff({ ...params, conversation_id: this.id });
  }

  /**
   * The navigation kit bound to this customer and conversation. The verification level is
   * read at each call, so tools created before a `verify()` pick up the new level. With
   * `agentMemory: true` it also offers `search_agent_memory`, and `remember` with
   * `writeAgentMemory: true`, bound to this conversation as the note's evidence.
   */
  tools(options: ToolOptions = {}): BoundTools {
    const read = (): Verification => this.level;
    const binding: ToolBinding = {
      conversation_id: this.id,
      voice: this.view === "voice",
      get verification() {
        return read();
      },
    };
    if (this.params.about) binding.about = this.params.about;
    return this.state.observeTools(this.client.tools(this.subject, binding, options));
  }

  /** Emits `conversation.ended` and drops the conversation's cached packs. Safe to call twice. */
  end(): Promise<WriteResult> {
    this.ending ??= this.hooks.endConversation(this.id);
    return this.ending;
  }

  private bind(event: { handles?: Handle[]; subjects?: unknown[]; object_refs?: unknown[] }): {
    conversation_id: string;
    handles?: Handle[];
  } {
    const own = hasTarget(event);
    return own ? { conversation_id: this.id } : { conversation_id: this.id, handles: [this.subject] };
  }

  private emit(role: Speaker, text: string, options: TurnOptions, backing?: Backing): string | null {
    const transcript = options.stt_confidence !== undefined;
    const content: Content =
      options.content ??
      (transcript ? { type: "audio", transcript: text, stt_confidence: options.stt_confidence ?? null } : { type: "text", text });
    const event: TrackEvent = {
      channel: this.channel,
      conversation_id: this.id,
      handles: withHandles([this.subject], options.handles),
      speaker: options.speaker_id ? { role, id: options.speaker_id } : { role },
      content,
    };
    if (options.idempotency_key) event.idempotency_key = options.idempotency_key;
    if (options.occurred_at) event.occurred_at = options.occurred_at;
    if (options.visibility) event.visibility = options.visibility;
    if (options.voice) event.voice = options.voice;
    if (options.context_stamp) event.context_stamp = options.context_stamp;
    const usage = role === "ai_agent" ? asModelUsage(options.usage) : null;
    if (usage) event.usage = usage;
    if (backing) event.backing = backing;
    return this.client.track(event);
  }
}

/** `base` and the extra handles, without repeating one. */
export function withHandles(base: Handle[], extra: Handle[] | undefined): Handle[] {
  const all = [...base];
  for (const handle of extra ?? []) {
    if (!all.some((known) => known.type === handle.type && known.value === handle.value && known.scope === handle.scope)) all.push(handle);
  }
  return all;
}
