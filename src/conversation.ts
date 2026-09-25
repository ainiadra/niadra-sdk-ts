import type { Niadra, WriteResult } from "./client.js";
import type { AgentMemoryParams, AgentMemoryResult } from "./agent-memory.js";
import type { ContextOptions, ContextParams, ContextResult, RequestOptions } from "./context.js";
import { uuidv7 } from "./ids.js";
import { hasTarget } from "./items.js";
import type { ActionEvent, Timestamp, TrackEvent } from "./items.js";
import type { Logger } from "./logger.js";
import { SessionState } from "./session.js";
import type { Timings } from "./session.js";
import type { BoundTools, ToolBinding, ToolOptions } from "./tools.js";
import type { Handle } from "./types/common.js";
import type { TargetModel } from "./types/context.js";
import type { Content, ContextStamp, ModelUsage, VoiceInfo } from "./types/events.js";
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
 * conversation keeps them, in order, in `suffix`, with the live turns, for the end of the
 * prompt. A successful `verify()` starts over from the pack the server pins for the new level.
 *
 * Call `markInjected()` when the pack goes into the prompt; the agent's later turns and actions
 * carry that moment and the pack's etag as `context_stamp`. `wrap()` does it for you.
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

  /** Where `wrap()` reports what it swallowed: the client's logger. */
  get logger(): Logger {
    return this.client.logger;
  }

  /**
   * The pack for this turn: the pinned `text`, and a `suffix` with every delta since the pin
   * and the current live turns. A read with `query` is compiled for that query and never
   * pinned, so it leaves the conversation's deltas alone.
   */
  async context(options: ContextOptions & { query?: string } = {}): Promise<ContextResult> {
    const { query, format, ...requestOptions } = options;
    const params: ContextParams = {
      subject: this.subject,
      view: this.view,
      verification: this.level,
      conversation_id: this.id,
      ...(this.params.about ? { about: this.params.about } : {}),
      ...(this.params.target ? { target: this.params.target } : {}),
      ...(format === "json" ? { format } : {}),
    };
    if (query) return this.client.context({ ...params, query }, requestOptions);
    if (this.state.wantsDelta) params.delta = true;
    return this.state.absorb(await this.client.context(params, requestOptions));
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

  /** Captures what the customer said. */
  customer(text: string, options: TurnOptions = {}): string | null {
    return this.turn("customer", text, options);
  }

  /** Captures what the AI agent said, stamped with the context its prompt carried. */
  agent(text: string, options: TurnOptions = {}): string | null {
    const stamp = this.state.agentTurn();
    return this.turn("ai_agent", text, stamp ? { context_stamp: stamp, ...options } : options);
  }

  /** Captures what a human attendant said, for example after a handoff. */
  human(text: string, options: TurnOptions = {}): string | null {
    return this.turn("human_agent", text, options);
  }

  /** Records any event in this conversation. The customer's handle is attached unless you pass your own. */
  track(event: ConversationEvent): string | null {
    return this.client.track({ ...this.bind(event), ...event, channel: event.channel ?? this.channel });
  }

  /** Records an action the agent took during this conversation, stamped like its turns. */
  action(event: ConversationAction): string | null {
    const stamp = this.state.actionStamp(event.speaker);
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
    return this.client.tools(this.subject, binding, options);
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

  private turn(role: Speaker, text: string, options: TurnOptions): string | null {
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
