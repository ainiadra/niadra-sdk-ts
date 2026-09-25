/**
 * Niadra for LlamaIndex.TS (`@llamaindex/core` 0.6, the package `llamaindex` re-exports).
 *
 * - `NiadraMemory` is a LlamaIndex `Memory` for agents (`agent({ memory })`, `multiAgent`) and chat
 *   engines (`SimpleChatEngine`, `ContextChatEngine`). Every model call reads its messages through
 *   `getLLM()`, and there it records the customer's newest message once, puts the agent's notes and
 *   the customer's pack in a system message after the leading system messages, and appends the
 *   suffix (deltas and live turns) to the last user message. What it returns is a copy: the pack
 *   never lands in the stored history. `add()` records the final answer as the agent's turn and a
 *   `handOff` between agents as a handoff.
 * - `NiadraMemoryBlock` is the same context as a fixed memory block (priority 0), for a `Memory`
 *   you build yourself with other blocks. A block can only sit before the history, so the suffix
 *   follows the pack in the same message; answers are not recorded this way.
 * - `niadraTools(session)` is the navigation kit as `FunctionTool`s bound to the customer.
 *
 * Fail-open: when Niadra is slow or down, the model gets the history as LlamaIndex built it.
 *
 * @example
 * import { agent } from "@llamaindex/workflow";
 * import { openai } from "@llamaindex/openai";
 * import { NiadraMemory, niadraTools } from "@niadra/sdk/llamaindex";
 *
 * const convo = niadra.conversation({ subject: handles.appUserId(user.id), channel: "web_chat", conversation_id: chatId });
 * const support = agent({
 *   llm: openai({ model: "gpt-4.1" }),
 *   systemPrompt: "You are Acme's support agent.",
 *   tools: niadraTools(convo),
 *   memory: new NiadraMemory(convo),
 * });
 * const result = await support.run("Where is my replacement?");
 */

import { BaseMemoryBlock, Memory } from "@llamaindex/core/memory";
import type { MemoryMessage } from "@llamaindex/core/memory";
import type { ChatMessage, LLM, MessageContent } from "@llamaindex/core/llms";
import { FunctionTool } from "@llamaindex/core/tools";
import { Bridge, errorName, isRecord, resolveSession, textOf } from "./shared.js";
import type { AgentMemoryOption, ProofSource, Session, SessionResolver } from "./shared.js";

export { attestationProof } from "./shared.js";
export type { AgentMemoryOption, Proof, ProofSource, Session, SessionResolver } from "./shared.js";

/** `Memory`'s own options (token limit, blocks), as `createMemory()` takes them. */
type MemoryOptions = NonNullable<ConstructorParameters<typeof Memory>[1]>;

export interface NiadraMemoryOptions extends MemoryOptions {
  /** What your app proved about the user, recorded once before the first context read. */
  verify?: ProofSource;
  /** Records the newest user message as the customer's turn. Defaults to `true`. */
  recordCustomer?: boolean;
  /** Records the final answer as the agent's turn. Defaults to `true`. */
  recordAgent?: boolean;
  /** Puts the agent's own notes before the customer's context. Pass the same to `niadraTools`. */
  agentMemory?: AgentMemoryOption;
}

interface State {
  bridge: Bridge;
  seen: Set<string>;
}

const states = new WeakMap<Session, State>();

function stateOf(session: Session, options: Pick<NiadraMemoryOptions, "verify" | "agentMemory">): State {
  let state = states.get(session);
  if (!state) {
    state = { bridge: new Bridge(session, options.verify, options.agentMemory), seen: new Set() };
    states.set(session, state);
  }
  return state;
}

/**
 * A LlamaIndex `Memory` that carries the customer's context into every model call and records
 * the conversation. Takes the session (or a function that finds it per call; `null` leaves the
 * call as LlamaIndex built it), then the same messages and options as `createMemory()`.
 */
export class NiadraMemory extends Memory {
  private readonly source: SessionResolver;
  private readonly settings: NiadraMemoryOptions;
  /** Set when the model has been given the messages, so only answers given after that are recorded. */
  private awaitingAnswer = false;

  constructor(session: SessionResolver, messages: MemoryMessage[] = [], options: NiadraMemoryOptions = {}) {
    const { verify: _verify, recordCustomer: _customer, recordAgent: _agent, agentMemory: _memory, ...memoryOptions } = options;
    super(messages, memoryOptions);
    this.source = session;
    this.settings = options;
  }

  override async add(message: unknown): Promise<void> {
    await super.add(message);
    const session = resolveSession(this.source);
    if (!session || !isRecord(message) || message.role !== "assistant") return;
    const bridge = stateOf(session, this.settings).bridge;
    try {
      const calls = toolCalls(message);
      const handoff = calls.find((call) => call.name === "handOff");
      if (handoff) {
        const input = isRecord(handoff.input) ? handoff.input : {};
        const reason = typeof input.toAgent === "string" ? `to ${input.toAgent}` : undefined;
        await bridge.handoff("agent", reason);
        return;
      }
      if (calls.length > 0 || !this.awaitingAnswer || !(this.settings.recordAgent ?? true)) return;
      this.awaitingAnswer = false;
      bridge.agent(textOf(message.content));
    } catch (error) {
      bridge.logger.warn(`could not record the agent's answer (${errorName(error)})`);
    }
  }

  override async getLLM(llm?: LLM, transientMessages?: ChatMessage[]): Promise<ChatMessage[]> {
    const messages = await super.getLLM(llm, transientMessages);
    const session = resolveSession(this.source);
    if (!session) return messages;
    const state = stateOf(session, this.settings);
    this.awaitingAnswer = true;
    try {
      if (this.settings.recordCustomer ?? true) recordNewestUser(state, await this.get());
      const read = await state.bridge.read();
      state.bridge.injected(read.context);
      return inject(messages, read.prefix, read.suffix);
    } catch (error) {
      state.bridge.logger.warn(`could not inject context (${errorName(error)})`);
      return messages;
    }
  }
}

export interface NiadraMemoryBlockOptions {
  /** The block's id in the memory. Defaults to `niadra`. */
  id?: string;
  /** What your app proved about the user, recorded once before the first context read. */
  verify?: ProofSource;
  /** Records the newest user message as the customer's turn. Defaults to `true`. */
  recordCustomer?: boolean;
  /** Puts the agent's own notes before the customer's context. */
  agentMemory?: AgentMemoryOption;
}

/**
 * The context as a fixed memory block (priority 0, always included), for
 * `createMemory({ memoryBlocks: [new NiadraMemoryBlock(convo), ...yours] })`.
 */
export class NiadraMemoryBlock extends BaseMemoryBlock {
  private readonly source: SessionResolver;
  private readonly settings: NiadraMemoryBlockOptions;

  constructor(session: SessionResolver, options: NiadraMemoryBlockOptions = {}) {
    super({ id: options.id ?? "niadra", priority: 0, isLongTerm: false });
    this.source = session;
    this.settings = options;
  }

  async get(messages: MemoryMessage[] = []): Promise<MemoryMessage[]> {
    const session = resolveSession(this.source);
    if (!session) return [];
    const state = stateOf(session, this.settings);
    try {
      if (this.settings.recordCustomer ?? true) recordNewestUser(state, messages);
      const read = await state.bridge.read();
      state.bridge.injected(read.context);
      const text = [read.prefix, read.suffix].filter(Boolean).join("\n\n");
      return text ? [{ id: `${this.id}-context`, role: "system", content: text }] : [];
    } catch (error) {
      state.bridge.logger.warn(`could not inject context (${errorName(error)})`);
      return [];
    }
  }

  async put(): Promise<void> {
    // The context comes from Niadra on every read; nothing is kept here.
  }
}

/** The navigation kit as LlamaIndex `FunctionTool`s, bound to the session's customer. */
export function niadraTools(session: Session, options: { agentMemory?: AgentMemoryOption } = {}): FunctionTool<Record<string, unknown>, Promise<string>>[] {
  return new Bridge(session, undefined, options.agentMemory).tools().map(
    (spec) =>
      new FunctionTool<Record<string, unknown>, Promise<string>>(
        async (input) => spec.execute(isRecord(input) ? input : {}),
        { name: spec.name, description: spec.description, parameters: spec.parameters as never },
      ),
  );
}

/** Records the newest user message that is not a tool result, once per position and text. */
function recordNewestUser(state: State, messages: readonly ChatMessage[]): void {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user" || isToolResult(message)) continue;
    const text = textOf(message.content);
    const key = `${String(index)}:${text}`;
    if (text && !state.seen.has(key)) {
      state.seen.add(key);
      state.bridge.customer(text);
    }
    return;
  }
}

/** A copy of the messages: the prefix after the leading system messages, the suffix at the end of the last user message. */
function inject(messages: readonly ChatMessage[], prefix: string, suffix: string): ChatMessage[] {
  const result = [...messages];
  if (suffix) {
    for (let index = result.length - 1; index >= 0; index--) {
      const message = result[index];
      if (message?.role !== "user" || isToolResult(message)) continue;
      result[index] = { ...message, content: withSuffix(message.content, suffix) };
      break;
    }
  }
  if (prefix) {
    let position = 0;
    while (position < result.length && result[position]?.role === "system") position++;
    result.splice(position, 0, { role: "system", content: prefix });
  }
  return result;
}

function withSuffix(content: MessageContent, suffix: string): MessageContent {
  return typeof content === "string" ? `${content}\n\n${suffix}` : [...content, { type: "text", text: suffix }];
}

function isToolResult(message: ChatMessage): boolean {
  return isRecord(message.options) && "toolResult" in message.options;
}

function toolCalls(message: Record<PropertyKey, unknown>): { name: string; input: unknown }[] {
  const options = isRecord(message.options) ? message.options : {};
  const calls = Array.isArray(options.toolCall) ? (options.toolCall as unknown[]) : [];
  return calls.filter(isRecord).map((call) => ({ name: typeof call.name === "string" ? call.name : "", input: call.input }));
}
