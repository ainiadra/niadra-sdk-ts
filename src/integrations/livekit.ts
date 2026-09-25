/**
 * Niadra for LiveKit Agents (Node, `@livekit/agents` 1.9).
 *
 * The same hook as LiveKit's own RAG recipe: `onUserTurnCompleted(turnCtx, newMessage)`. There
 * the customer's final transcript is recorded, the conversation's pack goes into the turn's chat
 * context as a system message right after the agent's instructions, and the suffix (deltas and
 * live turns from other channels) goes after the new message. The turn context is a copy LiveKit
 * builds for this reply only, so nothing piles up in the agent's history and the prompt prefix
 * stays byte-identical turn after turn. Session events record the agent's answers (with the
 * LLM usage LiveKit measured), handoffs between agents and the end of the call.
 *
 * Voice reads use the 150 ms budget; a read that misses it leaves the context out and the agent
 * answers anyway.
 *
 * @example
 * const caller = ctx.room.remoteParticipants.values().next().value;
 * const convo = niadra.conversation({ subject: sipSubject(caller), channel: "voice", conversation_id: sipConversationId(caller, ctx.room.name) });
 * const memory = new NiadraMemory({ conversation: convo, verify: attestationProof(caller.attributes["sip.h.x-stir-verstat"]) });
 * const agent = new NiadraAgent({ instructions: "You are the support line of Acme.", memory });
 * memory.attach(session);
 * await session.start({ agent, room: ctx.room });
 */

import { llm, voice } from "@livekit/agents";
import type { Conversation } from "../conversation.js";
import { handles } from "../handles.js";
import type { Handle } from "../types/common.js";
import type { ModelUsage } from "../types/events.js";
import { Bridge, count, errorName } from "./shared.js";
import type { AgentMemoryOption, ProofSource } from "./shared.js";

export { attestationProof } from "./shared.js";
export type { AgentMemoryOption, Proof, ProofSource } from "./shared.js";

/** Instructions LiveKit keeps at the head of the chat context; the pack goes after them. */
const LEADING_IDS = new Set(["lk.agent_task.instructions", "lk.expressive.instructions"]);
const INSTRUCTION_ROLES = new Set(["system", "developer"]);
const CONTEXT_ID = "niadra.context";

/** `llm.tool` with a raw JSON Schema, which it accepts but cannot infer argument types from. */
const rawTool = llm.tool as unknown as (options: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown> | undefined) => Promise<unknown>;
}) => llm.FunctionTool;
const SUFFIX_ID = "niadra.suffix";

export interface NiadraMemoryOptions {
  /** The call, opened with `channel: "voice"` so reads use the voice view and budget. */
  conversation: Conversation;
  /**
   * What the call proved before the first read, such as the carrier's attestation
   * (`attestationProof(...)`). Recorded once with `verify()` before the first context.
   */
  verify?: ProofSource;
  /** Records the agent's answers from `conversation_item_added`. Defaults to `true`. */
  recordAgent?: boolean;
  /** Puts the agent's own notes before the caller's context and adds its memory tools. */
  agentMemory?: AgentMemoryOption;
}

/** Participant fields the helpers read. A `RemoteParticipant` has them. */
export interface ParticipantLike {
  identity: string;
  attributes?: Record<string, string> | undefined;
}

/**
 * The caller as a handle: the phone number LiveKit SIP puts in `sip.phoneNumber` (E.164, `+` added
 * when missing), otherwise the participant identity as your app's user id.
 */
export function sipSubject(participant: ParticipantLike): Handle {
  const phone = participant.attributes?.["sip.phoneNumber"]?.trim();
  if (phone) return handles.phone(phone.startsWith("+") ? phone : `+${phone}`);
  return handles.appUserId(participant.identity);
}

/** The call id LiveKit SIP puts in `sip.callID`, otherwise the room name. */
export function sipConversationId(participant: ParticipantLike, roomName: string): string {
  const callId = participant.attributes?.["sip.callID"]?.trim();
  if (callId) return callId;
  return roomName;
}

/**
 * The memory of one call, shared by every agent that takes part in it. Put its
 * `onUserTurnCompleted` in your agent (or use `NiadraAgent`), its `toolset()` in the agent's
 * tools, and `attach()` it to the session.
 */
export class NiadraMemory {
  readonly conversation: Conversation;
  private readonly bridge: Bridge;
  private readonly recordAgent: boolean;
  private readonly customerTurns = new Set<string>();
  private usage: ModelUsage | null = null;

  constructor(options: NiadraMemoryOptions) {
    this.conversation = options.conversation;
    this.bridge = new Bridge(options.conversation, options.verify, options.agentMemory);
    this.recordAgent = options.recordAgent ?? true;
  }

  /**
   * Records the customer's final transcript, then puts the pack after the instructions and the
   * suffix after the new message, for this reply only. Never throws.
   */
  async onUserTurnCompleted(turnCtx: llm.ChatContext, newMessage: llm.ChatMessage): Promise<void> {
    this.recordCustomer(newMessage);
    const read = await this.bridge.read();
    try {
      const items = turnCtx.items;
      for (const id of [CONTEXT_ID, SUFFIX_ID]) {
        const index = items.findIndex((item) => item.id === id);
        if (index >= 0) items.splice(index, 1);
      }
      if (read.prefix) {
        let position = 0;
        while (position < items.length && isInstruction(items[position])) position++;
        const message = turnCtx.addMessage({ id: CONTEXT_ID, role: "system", content: read.prefix });
        items.splice(items.indexOf(message), 1);
        items.splice(position, 0, message);
      }
      // Pushed last with the current time: LiveKit inserts the new message by its own, earlier,
      // timestamp, so the suffix stays after it.
      if (read.suffix) turnCtx.addMessage({ id: SUFFIX_ID, role: "system", content: read.suffix });
      this.bridge.injected(read.context);
    } catch (error) {
      this.bridge.logger.warn(`could not inject context (${errorName(error)})`);
    }
  }

  /**
   * Listens to the session: the agent's answers, handoffs between agents and the end of the call.
   * Returns a function that stops listening.
   */
  attach(session: voice.AgentSession): () => void {
    const onItem = (event: voice.ConversationItemAddedEvent): void => {
      this.onItem(event.item);
    };
    const onMetrics = (event: voice.MetricsCollectedEvent): void => {
      const metrics = event.metrics;
      if (metrics.type === "llm_metrics") this.usage = usageOf(metrics);
    };
    const onClose = (): void => {
      void this.bridge.end();
    };
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, onItem);
    session.on(voice.AgentSessionEventTypes.MetricsCollected, onMetrics);
    session.on(voice.AgentSessionEventTypes.Close, onClose);
    return () => {
      session.off(voice.AgentSessionEventTypes.ConversationItemAdded, onItem);
      session.off(voice.AgentSessionEventTypes.MetricsCollected, onMetrics);
      session.off(voice.AgentSessionEventTypes.Close, onClose);
    };
  }

  /** The navigation kit as LiveKit function tools, bound to this caller. */
  tools(): llm.FunctionTool[] {
    return this.bridge.tools().map((spec) =>
      rawTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        // LiveKit serializes what a tool returns; the parsed result keeps the model's JSON unescaped.
        execute: async (args) => parsed(await spec.execute(args ?? {})),
      }),
    );
  }

  /** The same tools grouped as one toolset, to add next to your own. */
  toolset(): llm.Toolset {
    return new llm.Toolset({ id: "niadra", tools: this.tools() });
  }

  /**
   * Records a transfer to a person, such as a SIP transfer to the queue. Call it right before
   * the transfer, so the attendant's screen can read the context at once.
   */
  handoffToHuman(reason?: string): Promise<void> {
    return this.bridge.handoff("human", reason);
  }

  private onItem(item: llm.ChatMessage | llm.AgentHandoffItem): void {
    if (item.type === "agent_handoff") {
      const reason = item.oldAgentId ? `${item.oldAgentId} to ${item.newAgentId}` : `to ${item.newAgentId}`;
      void this.bridge.handoff("agent", reason);
      return;
    }
    if (item.role === "user") {
      this.recordCustomer(item);
      return;
    }
    if (item.role !== "assistant" || !this.recordAgent) return;
    const text = item.textContent ?? "";
    const usage = this.usage;
    this.usage = null;
    this.bridge.agent(text, usage ? { usage, idempotency_key: item.id } : { idempotency_key: item.id });
  }

  private recordCustomer(message: llm.ChatMessage): void {
    if (this.customerTurns.has(message.id)) return;
    this.customerTurns.add(message.id);
    const confidence = message.transcriptConfidence;
    this.bridge.customer(message.textContent ?? "", {
      idempotency_key: message.id,
      ...(typeof confidence === "number" && confidence >= 0 && confidence <= 1 ? { stt_confidence: confidence } : {}),
    });
  }
}

export interface NiadraAgentOptions<UserData> extends voice.AgentOptions<UserData> {
  memory: NiadraMemory;
  /** Adds the navigation kit to the agent's tools. Defaults to `true`. */
  historyTools?: boolean;
}

/**
 * A LiveKit `Agent` with Niadra wired in: context before each reply and the navigation kit
 * among its tools. Subclasses that override `onUserTurnCompleted` call `super.onUserTurnCompleted`.
 */
export class NiadraAgent<UserData = unknown> extends voice.Agent<UserData> {
  readonly memory: NiadraMemory;

  constructor({ memory, historyTools = true, ...options }: NiadraAgentOptions<UserData>) {
    const tools = historyTools ? withToolset(options.tools, memory.toolset()) : options.tools;
    super(tools === undefined ? options : { ...options, tools });
    this.memory = memory;
  }

  override async onUserTurnCompleted(turnCtx: llm.ChatContext, newMessage: llm.ChatMessage): Promise<void> {
    await this.memory.onUserTurnCompleted(turnCtx, newMessage);
  }
}

function withToolset<UserData>(
  tools: llm.ToolContextLike<UserData> | undefined,
  toolset: llm.Toolset,
): llm.ToolContextLike<UserData> {
  const base = tools === undefined ? [] : llm.toToolContext(tools).tools;
  return new llm.ToolContext<UserData>([...base, toolset]);
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isInstruction(item: llm.ChatItem | undefined): boolean {
  if (!item) return false;
  if (LEADING_IDS.has(item.id)) return true;
  return item.type === "message" && INSTRUCTION_ROLES.has(item.role);
}

function usageOf(metrics: { promptTokens: number; promptCachedTokens: number; cacheCreationTokens?: number | undefined; metadata?: { modelProvider?: string | undefined; modelName?: string | undefined } | undefined }): ModelUsage | null {
  const provider = metrics.metadata?.modelProvider?.toLowerCase();
  const model = metrics.metadata?.modelName;
  const prompt = count(metrics.promptTokens);
  // Test doubles and some plugins report "unknown"; a turn without usage is better than a wrong one.
  if (!provider || !model || provider === "unknown" || model === "unknown" || !prompt) return null;
  const cached = count(metrics.promptCachedTokens) ?? 0;
  const written = count(metrics.cacheCreationTokens) ?? 0;
  return { provider, model, prompt_tokens: Math.max(prompt, cached + written), cached_tokens: cached, cache_write_tokens: written };
}
