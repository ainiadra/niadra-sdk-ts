/**
 * Niadra for Strands Agents for TypeScript (`@strands-agents/sdk` 1.x, AWS): a plugin with the
 * customer's context before every model call and the navigation kit as tools.
 *
 * `new NiadraPlugin(session)` goes in `plugins` of the `Agent`:
 *
 * - an input middleware of `InvokeModelStage` records the customer's newest message once, adds the
 *   agent's notes and the customer's pack after your system prompt, and folds the suffix (deltas
 *   and live turns) into the last user message, the way Strands' own context injector does. It
 *   changes only what goes to the model: nothing of it lands in `agent.messages`.
 * - an output middleware records the final answer with the model's usage (prompt cache reads and
 *   writes included); tool-use turns record nothing.
 * - `getTools()` gives the kit as Strands tools bound to the customer, with the canonical schemas.
 *
 * Fail-open: when Niadra is slow or down, the model gets the messages as they came.
 *
 * @example
 * import { Agent, BedrockModel } from "@strands-agents/sdk";
 * import { NiadraPlugin } from "@niadra/sdk/strands";
 *
 * const convo = niadra.conversation({ subject: handles.appUserId(user.id), channel: "web_chat", conversation_id: chatId });
 * const support = new Agent({
 *   model: new BedrockModel({ modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" }),
 *   systemPrompt: "You are Acme's support agent.",
 *   plugins: [new NiadraPlugin(convo)],
 * });
 * const result = await support.invoke("Where is my replacement?");
 */

import { InvokeModelStage, Message, TextBlock, tool } from "@strands-agents/sdk";
import type { InvokableTool, InvokeModelContext, InvokeModelResult, JSONValue, LocalAgent, Plugin, SystemPrompt } from "@strands-agents/sdk";
import type { ModelUsage } from "../types/events.js";
import { providerOf } from "../usage.js";
import { Bridge, count, errorName, isRecord, resolveSession } from "./shared.js";
import type { AgentMemoryOption, ProofSource, Session } from "./shared.js";

export { attestationProof } from "./shared.js";
export type { AgentMemoryOption, Proof, ProofSource, Session } from "./shared.js";

export interface NiadraPluginOptions {
  /** What your app proved about the user, recorded once before the first context read. */
  verify?: ProofSource;
  /** Records the newest user message as the customer's turn. Defaults to `true`. */
  recordCustomer?: boolean;
  /** Records the final answer as the agent's turn. Defaults to `true`. */
  recordAgent?: boolean;
  /** Puts the agent's own notes before the customer's context, and adds its memory tools. */
  agentMemory?: AgentMemoryOption;
}

/** Strands' model classes, the provider each serves, and whether its `inputTokens` leaves the cached tokens out. */
const MODELS: Record<string, { provider: string; cacheApart: boolean }> = {
  BedrockModel: { provider: "bedrock", cacheApart: true },
  AnthropicModel: { provider: "anthropic", cacheApart: true },
  OpenAIModel: { provider: "openai", cacheApart: false },
  GoogleModel: { provider: "google", cacheApart: false },
};

interface State {
  bridge: Bridge;
  seen: Set<string>;
  model: { provider: string; name: string; cacheApart: boolean } | null;
}

/**
 * The Niadra plugin for one agent. Takes the conversation or task (Strands agents usually live for
 * one conversation), or a function of the agent that finds it per model call.
 */
export class NiadraPlugin implements Plugin {
  readonly name = "niadra";
  private readonly states = new WeakMap<Session, State>();

  constructor(
    private readonly session: Session | ((agent: LocalAgent) => Session | null | undefined),
    private readonly options: NiadraPluginOptions = {},
  ) {}

  initAgent(agent: LocalAgent): void {
    agent.addMiddleware(InvokeModelStage.Input, (context: InvokeModelContext) => this.prepare(agent, context));
    agent.addMiddleware(InvokeModelStage.Output, (result: InvokeModelResult) => {
      this.record(agent, result);
      return result;
    });
  }

  /** The kit bound to a fixed session; none when the session is found per call. */
  getTools(): InvokableTool<unknown, JSONValue>[] {
    return typeof this.session === "function" ? [] : niadraTools(this.session, this.options.agentMemory === undefined ? {} : { agentMemory: this.options.agentMemory });
  }

  private stateOf(agent: LocalAgent): State | null {
    const choice = this.session;
    const session = typeof choice === "function" ? resolveSession(() => choice(agent)) : choice;
    if (!session) return null;
    let state = this.states.get(session);
    if (!state) {
      state = { bridge: new Bridge(session, this.options.verify, this.options.agentMemory), seen: new Set(), model: null };
      this.states.set(session, state);
    }
    return state;
  }

  private async prepare(agent: LocalAgent, context: InvokeModelContext): Promise<InvokeModelContext> {
    const state = this.stateOf(agent);
    if (!state) return context;
    try {
      const known = MODELS[context.model.constructor.name];
      const name = context.model.modelId ?? "";
      state.model = name ? { provider: known?.provider ?? providerOf(name), name, cacheApart: known?.cacheApart ?? false } : null;
      const messages = [...context.messages];
      const last = lastUserText(messages);
      if ((this.options.recordCustomer ?? true) && last >= 0) {
        const text = textOf(messages[last]);
        const key = `${String(last)}:${text}`;
        if (!state.seen.has(key)) {
          state.seen.add(key);
          state.bridge.customer(text);
        }
      }
      const read = await state.bridge.read();
      state.bridge.injected(read.context);
      let trailing = context.dynamicTrailingBlocks ?? 0;
      const target = messages[last];
      if (read.suffix && target) {
        const separator = target.content.length > 0 ? "\n\n" : "";
        messages[last] = new Message({
          role: target.role,
          content: [...target.content, new TextBlock(`${separator}${read.suffix}`)],
          trackingId: target.trackingId,
          ...(target.metadata === undefined ? {} : { metadata: target.metadata }),
        });
        // The pack's cache point stays before what changes on every call.
        if (last === messages.length - 1) trailing += 1;
      }
      return {
        ...context,
        messages,
        dynamicTrailingBlocks: trailing,
        ...(read.prefix ? { systemPrompt: withPrefix(context.systemPrompt, read.prefix) } : {}),
      };
    } catch (error) {
      state.bridge.logger.warn(`could not inject context (${errorName(error)})`);
      return context;
    }
  }

  private record(agent: LocalAgent, { result }: InvokeModelResult): void {
    if (!(this.options.recordAgent ?? true)) return;
    const state = this.stateOf(agent);
    if (!state) return;
    try {
      if (result.stopReason === "toolUse" || result.message.content.some((block) => block.type === "toolUseBlock")) return;
      const text = textOf(result.message);
      if (!text) return;
      const usage = state.model ? strandsUsage(result.metadata?.usage, state.model.provider, state.model.name, state.model.cacheApart) : null;
      state.bridge.agent(text, usage ? { usage } : {});
    } catch (error) {
      state.bridge.logger.warn(`could not record the agent's answer (${errorName(error)})`);
    }
  }
}

/** The navigation kit as Strands tools, bound to the session's customer, with the canonical JSON Schemas. */
export function niadraTools(session: Session, options: { agentMemory?: AgentMemoryOption } = {}): InvokableTool<unknown, JSONValue>[] {
  return new Bridge(session, undefined, options.agentMemory).tools().map((spec) =>
    tool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.parameters as never,
      callback: async (input: unknown) => parsed(await spec.execute(isRecord(input) ? input : {})),
    }),
  );
}

/**
 * Strands' usage as a `ModelUsage`. Bedrock and Anthropic count the cached tokens apart from
 * `inputTokens`; the other providers count them inside it.
 */
export function strandsUsage(usage: unknown, provider: string, model: string, cacheApart: boolean): ModelUsage | null {
  if (!isRecord(usage)) return null;
  const input = count(usage.inputTokens);
  if (input === null || !model) return null;
  const read = count(usage.cacheReadInputTokens) ?? 0;
  const written = count(usage.cacheWriteInputTokens) ?? 0;
  const prompt = cacheApart ? input + read + written : Math.max(input, read + written);
  return { provider, model, prompt_tokens: prompt, cached_tokens: read, cache_write_tokens: written };
}

function withPrefix(system: SystemPrompt | undefined, prefix: string): SystemPrompt {
  if (system === undefined || system === "") return prefix;
  if (typeof system === "string") return `${system}\n\n${prefix}`;
  return [...system, new TextBlock(prefix)];
}

/** The last user message with text and no tool result, or -1. */
function lastUserText(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (message.content.some((block) => block.type === "toolResultBlock")) return -1;
    return textOf(message) ? index : -1;
  }
  return -1;
}

function textOf(message: Message | undefined): string {
  if (!message) return "";
  return message.content
    .map((block) => (block.type === "textBlock" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function parsed(text: string): JSONValue {
  try {
    return JSON.parse(text) as JSONValue;
  } catch {
    return text;
  }
}
