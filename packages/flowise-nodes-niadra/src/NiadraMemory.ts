// The node's layout follows Flowise's Mem0 memory node (Apache License 2.0, Copyright (c)
// 2023-present FlowiseAI, Inc.; see NOTICE). The behavior is Niadra's.
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { Conversation } from "@niadra/sdk";
import { CUSTOMER_INPUTS, clientFor, conversationFor } from "./common";
import type { ICommonObject, IMessage, INode, INodeData, INodeParams, MemoryMethods, MessageType } from "./flowise";

/**
 * The memory an agent node (Tool Agent, Conversational Agent) reads before the model call. The
 * chat history it returns starts with a system message holding the agent's notes, the
 * customer's pack and the live turns, so they sit right after the agent's system prompt; the
 * chat's own messages follow, from the memory connected as "Chat History" or kept here. What
 * the agent adds is recorded as the customer's and the agent's turns.
 */
export class NiadraCustomerMemory implements MemoryMethods {
  memoryKey = "chat_history";
  inputKey = "input";
  private readonly conversations = new Map<string, Conversation>();
  private readonly local = new Map<string, { text: string; type: MessageType }[]>();

  constructor(
    private readonly nodeData: INodeData,
    private readonly defaultSession: string,
    private readonly history?: MemoryMethods,
  ) {}

  async getChatMessages(overrideSessionId?: string, returnBaseMessages = false, prependMessages: IMessage[] = []): Promise<IMessage[] | BaseMessage[]> {
    const sessionId = overrideSessionId ?? this.defaultSession;
    const own = this.history
      ? await this.history.getChatMessages(sessionId, false, prependMessages) as IMessage[]
      : [...prependMessages, ...(this.local.get(sessionId) ?? []).map((message) => ({ message: message.text, type: message.type }))];
    const context = await this.context(sessionId);
    if (!returnBaseMessages) return context ? [{ message: context, type: "apiMessage" as const }, ...own] : own;
    const messages: BaseMessage[] = own.map((message) => (message.type === "userMessage" ? new HumanMessage(message.message) : new AIMessage(message.message)));
    return context ? [new SystemMessage(context), ...messages] : messages;
  }

  async addChatMessages(msgArray: { text: string; type: MessageType }[], overrideSessionId?: string): Promise<void> {
    const sessionId = overrideSessionId ?? this.defaultSession;
    const conversation = this.conversation(sessionId);
    for (const message of msgArray) {
      if (!message.text) continue;
      if (message.type === "userMessage") conversation?.customer(message.text);
      else conversation?.agent(message.text);
    }
    if (this.history) await this.history.addChatMessages(msgArray, sessionId);
    else this.local.set(sessionId, [...(this.local.get(sessionId) ?? []), ...msgArray].slice(-100));
  }

  async clearChatMessages(overrideSessionId?: string): Promise<void> {
    const sessionId = overrideSessionId ?? this.defaultSession;
    this.local.delete(sessionId);
    await this.conversations.get(sessionId)?.end();
    this.conversations.delete(sessionId);
    if (this.history) await this.history.clearChatMessages(sessionId);
  }

  /** The agent's notes, the pack and the suffix, as one block; empty when Niadra has nothing or fails. */
  private async context(sessionId: string): Promise<string> {
    const conversation = this.conversation(sessionId);
    if (!conversation) return "";
    try {
      const [context, notes] = await Promise.all([
        conversation.context(),
        this.nodeData.inputs?.agentMemory ? conversation.agentMemory() : Promise.resolve({ text: "" }),
      ]);
      if (context.text || context.suffix) conversation.markInjected(context);
      return [notes.text, context.text, context.suffix].filter(Boolean).join("\n\n");
    } catch {
      return "";
    }
  }

  private conversation(sessionId: string): Conversation | null {
    let conversation = this.conversations.get(sessionId);
    if (!conversation) {
      const created = conversationFor(this.nodeData, clientFor(this.nodeData), sessionId);
      if (!created) return null;
      conversation = created;
      this.conversations.set(sessionId, conversation);
    }
    return conversation;
  }
}

class NiadraMemory_Memory implements INode {
  label = "Niadra Customer Memory";
  name = "niadraCustomerMemory";
  version = 1;
  type = "NiadraCustomerMemory";
  icon = "niadra.svg";
  category = "Memory";
  description = "The customer's context from Niadra before every model call, and the chat recorded as turns";
  documentation = "https://docs.niadra.com/en";
  baseClasses = [this.type, "BaseChatMemory", "BaseMemory"];
  inputs: INodeParams[] = [
    { label: "Chat History", name: "chatHistory", type: "BaseChatMemory", optional: true, description: "Where the chat's own messages are kept; without it, the last 100 stay in this process" },
    ...CUSTOMER_INPUTS,
  ];

  async init(nodeData: INodeData, _input: string, options: ICommonObject = {}): Promise<NiadraCustomerMemory> {
    const sessionId = String(options.sessionId ?? options.chatId ?? "");
    return new NiadraCustomerMemory(nodeData, sessionId, nodeData.inputs?.chatHistory as MemoryMethods | undefined);
  }
}

export const nodeClass = NiadraMemory_Memory;
