/**
 * Niadra for Mastra (`@mastra/core` 1.x): a processor for the agent and the navigation kit as
 * Mastra tools. Mastra's own `Memory` (threads, working memory) stays Mastra's; Niadra is the
 * customer's memory shared with the company's other agents.
 *
 * - `processLLMRequest` rewrites the prompt of each model call without touching the message list:
 *   the pack goes after the system messages and the suffix at the end of the last user message,
 *   so nothing of it lands in Mastra's memory. The customer's newest message is recorded once.
 * - `processOutputResult` records the final answer with the usage Mastra summed for the run.
 *
 * The session comes from the request context (`requestContext.set("niadra", convo)`), or is fixed
 * when the processor is built for one conversation.
 *
 * @example
 * const niadraContext = niadraProcessor();
 * const agent = new Agent({
 *   id: "support", name: "Support", model: openai("gpt-4.1"),
 *   instructions: "You are Acme's support agent.",
 *   tools: ({ requestContext }) => niadraTools(requestContext.get("niadra")),
 *   inputProcessors: [niadraContext],
 *   outputProcessors: [niadraContext],
 * });
 * const requestContext = new RequestContext([["niadra", convo]]);
 * await agent.generate(messages, { requestContext });
 */

import type { Processor, ProcessLLMRequestArgs, ProcessLLMRequestResult, ProcessOutputResultArgs } from "@mastra/core/processors";
import { createTool } from "@mastra/core/tools";
import type { ModelUsage } from "../types/events.js";
import { injectPrompt, recordNewest } from "./prompt.js";
import { Bridge, count, errorName, isRecord, resolveSession } from "./shared.js";
import type { ProofSource, Session } from "./shared.js";

export { attestationProof } from "./shared.js";
export type { Proof, ProofSource, Session } from "./shared.js";

/** The request context key the processor and `niadraTools` read by default. */
export const NIADRA_CONTEXT_KEY = "niadra";

interface RequestContextLike {
  get(key: string): unknown;
}

export interface NiadraProcessorOptions {
  /** A fixed session, or a function of the request context; defaults to `requestContext.get("niadra")`. */
  session?: Session | ((requestContext: RequestContextLike | undefined) => Session | null | undefined);
  /** What your app proved about the user, recorded once before the first context read. */
  verify?: ProofSource;
  /** Records the newest user message as the customer's turn. Defaults to `true`. */
  recordCustomer?: boolean;
  /** Records the final answer as the agent's turn. Defaults to `true`. */
  recordAgent?: boolean;
}

interface State {
  bridge: Bridge;
  seen: Set<string>;
  model: { provider?: string; modelId?: string } | null;
}

/** A Mastra processor that is both an input processor (the request) and an output processor (the result). */
export type NiadraProcessor = Processor<"niadra"> & Required<Pick<Processor<"niadra">, "processLLMRequest" | "processOutputResult">>;

/** One processor serves both lists: put the same instance in `inputProcessors` and `outputProcessors`. */
export function niadraProcessor(options: NiadraProcessorOptions = {}): NiadraProcessor {
  const states = new WeakMap<Session, State>();
  const stateOf = (requestContext: unknown): State | null => {
    const context = isContext(requestContext) ? requestContext : undefined;
    const choice = options.session;
    const session =
      typeof choice === "function"
        ? resolveSession(() => choice(context))
        : (choice ?? asSession(context?.get(NIADRA_CONTEXT_KEY)));
    if (!session) return null;
    let state = states.get(session);
    if (!state) {
      state = { bridge: new Bridge(session, options.verify), seen: new Set(), model: null };
      states.set(session, state);
    }
    return state;
  };

  return {
    id: "niadra",
    name: "Niadra customer context",

    async processLLMRequest({ prompt, model, requestContext }: ProcessLLMRequestArgs): Promise<ProcessLLMRequestResult> {
      const state = stateOf(requestContext);
      if (!state) return undefined;
      try {
        if (isRecord(model)) {
          state.model = {
            ...(typeof model.provider === "string" ? { provider: model.provider } : {}),
            ...(typeof model.modelId === "string" ? { modelId: model.modelId } : {}),
          };
        }
        if (options.recordCustomer ?? true) recordNewest(state.bridge, state.seen, prompt);
        const context = await state.bridge.context();
        state.bridge.injected(context);
        return { prompt: injectPrompt(prompt, context) as typeof prompt };
      } catch (error) {
        state.bridge.logger.warn(`could not inject context (${errorName(error)})`);
        return undefined;
      }
    },

    processOutputResult({ messageList, result, requestContext }: ProcessOutputResultArgs) {
      if (!(options.recordAgent ?? true)) return messageList;
      const state = stateOf(requestContext);
      if (!state || typeof result.text !== "string") return messageList;
      try {
        const usage = mastraUsage(result.usage, state.model);
        state.bridge.agent(result.text, usage ? { usage } : {});
      } catch (error) {
        state.bridge.logger.warn(`could not record the agent's answer (${errorName(error)})`);
      }
      return messageList;
    },
  };
}

/**
 * The navigation kit as Mastra tools, bound to the session's customer. Pass the session, or
 * nothing inside `tools: ({ requestContext }) => niadraTools(requestContext.get("niadra"))`;
 * without a session it returns no tools.
 */
export function niadraTools(session: unknown): Record<string, ReturnType<typeof createTool>> {
  const resolved = asSession(session);
  if (!resolved) return {};
  const tools: Record<string, ReturnType<typeof createTool>> = {};
  for (const spec of new Bridge(resolved).tools()) {
    tools[spec.name] = createTool({
      id: spec.name,
      description: spec.description,
      inputSchema: spec.parameters as Parameters<typeof createTool>[0]["inputSchema"],
      execute: async (input: unknown) => parsed(await spec.execute(isRecord(input) ? (input as Record<string, unknown>) : {})),
    });
  }
  return tools;
}

/**
 * Instructions that carry the context, for agents that cannot take a processor: pass as
 * `instructions`. The pack follows your instructions; turns are not recorded this way.
 */
export function niadraInstructions(base: string, options: { session?: Session } = {}) {
  return async ({ requestContext }: { requestContext: RequestContextLike }): Promise<string> => {
    const session = options.session ?? asSession(requestContext.get(NIADRA_CONTEXT_KEY));
    if (!session) return base;
    const bridge = new Bridge(session);
    const context = await bridge.context();
    bridge.injected(context);
    return [base, context.text, context.suffix].filter(Boolean).join("\n\n");
  };
}

/** Mastra's usage (AI SDK 5 numbers, or the split input of later versions) as a `ModelUsage`. */
export function mastraUsage(usage: unknown, model: { provider?: string; modelId?: string } | null): ModelUsage | null {
  const provider = model?.provider?.split(".")[0]?.toLowerCase();
  const name = model?.modelId;
  if (!isRecord(usage) || !provider || !name) return null;
  let prompt: number | null;
  let cached: number;
  let written = 0;
  if (isRecord(usage.inputTokens)) {
    cached = count(usage.inputTokens.cacheRead) ?? 0;
    written = count(usage.inputTokens.cacheWrite) ?? 0;
    prompt = count(usage.inputTokens.total);
  } else {
    prompt = count(usage.inputTokens) ?? count(usage.promptTokens);
    cached = count(usage.cachedInputTokens) ?? 0;
  }
  if (prompt === null) return null;
  return { provider, model: name, prompt_tokens: Math.max(prompt, cached + written), cached_tokens: cached, cache_write_tokens: written };
}

function isContext(value: unknown): value is RequestContextLike {
  return isRecord(value) && typeof value.get === "function";
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
