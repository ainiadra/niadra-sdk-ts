/**
 * Niadra for VoltAgent (`@voltagent/core` 2.x): agent hooks and the navigation kit as VoltAgent
 * tools. VoltAgent's own memory (conversations, working memory) stays VoltAgent's; Niadra is the
 * customer's memory shared with the company's other agents.
 *
 * - `onPrepareModelMessages` records the customer's newest message, puts the agent's notes and the
 *   customer's pack as a system message after your instructions, and the suffix (deltas and live
 *   turns) at the end of the last user message, only in what goes to the model: nothing of it
 *   lands in VoltAgent's memory.
 * - `onEnd` records the answer with the usage of the whole operation.
 * - `onHandoff` records a delegation to a subagent as a handoff between agents (with a fixed session).
 *
 * The session comes from the operation's context (`context: { niadra: convo }` on
 * `generateText` or `streamText`), or is fixed when the hooks are built for one conversation.
 * Fail-open: when Niadra is slow or down, the messages go to the model as they came.
 *
 * @example
 * import { Agent } from "@voltagent/core";
 * import { openai } from "@ai-sdk/openai";
 * import { niadraHooks, niadraTools } from "@niadra/sdk/voltagent";
 *
 * const support = new Agent({
 *   name: "support",
 *   instructions: "You are Acme's support agent.",
 *   model: openai("gpt-4.1"),
 *   hooks: niadraHooks(),
 * });
 * const convo = niadra.conversation({ subject: handles.appUserId(user.id), channel: "web_chat", conversation_id: chatId });
 * const { text } = await support.generateText("Where is my replacement?", { context: { niadra: convo }, tools: niadraTools(convo) });
 */

import type { AgentHooks, OnEndHookArgs, OnPrepareModelMessagesHookArgs, OnPrepareModelMessagesHookResult, Tool } from "@voltagent/core";
import { createTool } from "@voltagent/core";
import { jsonSchema } from "ai";
import type { ModelUsage } from "../types/events.js";
import { providerOf } from "../usage.js";
import { Bridge, count, errorName, isRecord, resolveSession, textOf } from "./shared.js";
import type { AgentMemoryOption, ProofSource, Session } from "./shared.js";

export { attestationProof } from "./shared.js";
export type { AgentMemoryOption, Proof, ProofSource, Session } from "./shared.js";

/** The key of the operation context the hooks read by default. */
export const NIADRA_CONTEXT_KEY = "niadra";

type OperationContext = OnEndHookArgs["context"];

export interface NiadraHooksOptions {
  /** A fixed session, or a function of the operation context; defaults to `context.get("niadra")`. */
  session?: Session | ((context: OperationContext) => Session | null | undefined);
  /** What your app proved about the user, recorded once before the first context read. */
  verify?: ProofSource;
  /** Records the newest user message as the customer's turn. Defaults to `true`. */
  recordCustomer?: boolean;
  /** Records the answer as the agent's turn. Defaults to `true`. */
  recordAgent?: boolean;
  /** The provider for the usage of the agent's turn, when the model's name does not tell it (`openai` for `gpt-*`). */
  provider?: string;
  /** Puts the agent's own notes before the customer's context. Pass the same to `niadraTools`. */
  agentMemory?: AgentMemoryOption;
}

interface State {
  bridge: Bridge;
  seen: Set<string>;
}

/** The hooks for `new Agent({ hooks })`, or to merge with yours. */
export function niadraHooks(options: NiadraHooksOptions = {}): Pick<Required<AgentHooks>, "onPrepareModelMessages" | "onEnd" | "onHandoff"> {
  const states = new WeakMap<Session, State>();
  const stateOf = (context: OperationContext | undefined): State | null => {
    const choice = options.session;
    const session =
      typeof choice === "function"
        ? context
          ? resolveSession(() => choice(context))
          : null
        : (choice ?? asSession(context?.context.get(NIADRA_CONTEXT_KEY)));
    if (!session) return null;
    let state = states.get(session);
    if (!state) {
      state = { bridge: new Bridge(session, options.verify, options.agentMemory), seen: new Set() };
      states.set(session, state);
    }
    return state;
  };

  return {
    async onPrepareModelMessages({ modelMessages, context }: OnPrepareModelMessagesHookArgs): Promise<OnPrepareModelMessagesHookResult> {
      const state = stateOf(context);
      if (!state) return {};
      try {
        if (options.recordCustomer ?? true) recordNewest(state, modelMessages);
        const read = await state.bridge.read();
        state.bridge.injected(read.context);
        return { modelMessages: inject(modelMessages, read.prefix, read.suffix) };
      } catch (error) {
        state.bridge.logger.warn(`could not inject context (${errorName(error)})`);
        return {};
      }
    },

    onEnd({ output, agent, context }: OnEndHookArgs) {
      if (!(options.recordAgent ?? true) || !output || !("text" in output)) return;
      const state = stateOf(context);
      if (!state) return;
      try {
        const steps = Array.isArray(output.steps) ? (output.steps as unknown[]) : [];
        const last = steps.at(-1);
        const response = isRecord(last) && isRecord(last.response) ? last.response : {};
        const model = typeof response.modelId === "string" ? response.modelId : modelName(agent);
        const usage = model ? voltAgentUsage(output.totalUsage ?? output.usage, model, options.provider) : null;
        state.bridge.agent(output.text, usage ? { usage } : {});
      } catch (error) {
        state.bridge.logger.warn(`could not record the agent's answer (${errorName(error)})`);
      }
    },

    async onHandoff({ agent, sourceAgent }) {
      const state = typeof options.session === "object" ? stateOf(undefined) : null;
      if (state) await state.bridge.handoff("agent", `${sourceAgent.name} to ${agent.name}`);
    },
  };
}

/** The navigation kit as VoltAgent tools, bound to the session's customer, with the canonical JSON Schemas. */
export function niadraTools(session: Session, options: { agentMemory?: AgentMemoryOption } = {}): Tool[] {
  return new Bridge(session, undefined, options.agentMemory).tools().map(
    (spec) =>
      createTool({
        name: spec.name,
        description: spec.description,
        // VoltAgent hands the schema to the AI SDK, which takes a JSON Schema as it takes Zod.
        parameters: jsonSchema(spec.parameters as Parameters<typeof jsonSchema>[0]) as never,
        execute: async (input: unknown) => parsed(await spec.execute(isRecord(input) ? input : {})),
      }) as unknown as Tool,
  );
}

/** The AI SDK usage VoltAgent reports as a `ModelUsage`: the input tokens include the cached ones. */
export function voltAgentUsage(usage: unknown, model: string, provider?: string): ModelUsage | null {
  if (!isRecord(usage)) return null;
  const prompt = count(usage.inputTokens);
  if (prompt === null) return null;
  const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : {};
  const cached = count(details.cacheReadTokens) ?? count(usage.cachedInputTokens) ?? 0;
  const written = count(details.cacheWriteTokens) ?? 0;
  return {
    provider: (provider ?? providerOf(model, usage)).toLowerCase(),
    model,
    prompt_tokens: Math.max(prompt, cached + written),
    cached_tokens: cached,
    cache_write_tokens: written,
  };
}

type Message = OnPrepareModelMessagesHookArgs["modelMessages"][number];

function recordNewest(state: State, messages: readonly Message[]): void {
  const index = lastUser(messages);
  if (index < 0) return;
  const text = textOf(messages[index]?.content);
  const key = `${String(index)}:${text}`;
  if (!text || state.seen.has(key)) return;
  state.seen.add(key);
  state.bridge.customer(text);
}

function inject(messages: readonly Message[], prefix: string, suffix: string): Message[] {
  const result = [...messages];
  const index = lastUser(result);
  const last = result[index];
  if (suffix && last?.role === "user") {
    const content = typeof last.content === "string" ? `${last.content}\n\n${suffix}` : [...last.content, { type: "text" as const, text: suffix }];
    result[index] = { ...last, content };
  }
  if (prefix) {
    let position = 0;
    while (position < result.length && result[position]?.role === "system") position++;
    result.splice(position, 0, { role: "system", content: prefix });
  }
  return result;
}

function lastUser(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.role === "user") return index;
  return -1;
}

function modelName(agent: unknown): string | undefined {
  if (!isRecord(agent) || typeof agent.getModelName !== "function") return undefined;
  try {
    const name: unknown = (agent.getModelName as () => unknown).call(agent);
    return typeof name === "string" && name ? name : undefined;
  } catch {
    return undefined;
  }
}

function asSession(value: unknown): Session | null {
  return isRecord(value) && typeof value.context === "function" && typeof value.agent === "function" ? (value as unknown as Session) : null;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
