/**
 * Niadra for Mastra (`@mastra/core` 1.x): a processor for the agent and the navigation kit as
 * Mastra tools. Mastra's own `Memory` (threads, working memory) stays Mastra's; Niadra is the
 * customer's memory shared with the company's other agents.
 *
 * - `processLLMRequest` rewrites the prompt of each model call without touching the message list:
 *   the pack goes after the system messages and the suffix at the end of the last user message,
 *   so nothing of it lands in Mastra's memory. The customer's newest message is recorded once.
 * - `processOutputResult` records the final answer with the usage Mastra summed for the run.
 * - With `turns: true`, each request is a turn record, closed with the final answer: each model
 *   call with its tokens, each tool call with Mastra's call id and its result. A request inside a
 *   turn in progress (`conversation.turn()` around `agent.generate`) records into it. A function
 *   wrapped with `tool()` inside a tool takes over its call, which is how a replay answers it.
 * - In a replay the processor wraps every tool of each step with `tool()` (`processInputStep`), so a
 *   call answers from the record and never runs live, unless the tool is marked safe to run again.
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

import type {
  Processor,
  ProcessInputStepArgs,
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  ProcessLLMResponseArgs,
  ProcessOutputResultArgs,
  ProcessOutputStepArgs,
  ProcessToolResultArgs,
} from "@mastra/core/processors";
import { tool as recorded, recordedTool } from "../capture/tool.js";
import { uuidv7 } from "../ids.js";
import { replaying } from "../replay/playback.js";
import { createTool } from "@mastra/core/tools";
import type { ModelUsage } from "../types/events.js";
import { injectPrompt, recordNewest } from "./prompt.js";
import { Bridge, TurnHooks, count, errorName, isRecord, resolveSession } from "./shared.js";
import type { AgentMemoryOption, ProofSource, Session } from "./shared.js";

export { attestationProof } from "./shared.js";
export type { AgentMemoryOption, Proof, ProofSource, Session } from "./shared.js";

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
  /** Puts the agent's own notes before the customer's context. Pass the same to `niadraTools`. */
  agentMemory?: AgentMemoryOption;
  /** Records each request as a turn, with its model and tool calls. Defaults to `false`. */
  turns?: boolean;
}

/** The key of the request's run in the processor's state. */
const RUN = "niadraRun";

interface State {
  bridge: Bridge;
  seen: Set<string>;
  model: { provider?: string; modelId?: string } | null;
}

/** A Mastra processor that is both an input processor (the request) and an output processor (the result). */
export type NiadraProcessor = Processor<"niadra"> &
  Required<Pick<Processor<"niadra">, "processLLMRequest" | "processOutputResult" | "processLLMResponse" | "processOutputStep" | "processToolResult" | "processInputStep">>;

/** One processor serves both lists: put the same instance in `inputProcessors` and `outputProcessors`. */
export function niadraProcessor(options: NiadraProcessorOptions = {}): NiadraProcessor {
  const states = new WeakMap<Session, State>();
  const hooks = new TurnHooks("mastra", options.turns ?? false);
  /** The request's run: its turn opened on first use, keyed in the processor's per-request state. */
  const runOf = (state: Record<string, unknown>, session: Session): string | undefined => {
    if (!hooks.enabled) return undefined;
    let key = state[RUN];
    if (typeof key !== "string") {
      key = uuidv7();
      state[RUN] = key;
    }
    hooks.open(session, key as string);
    return key as string;
  };
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
      state = { bridge: new Bridge(session, options.verify, options.agentMemory), seen: new Set(), model: null };
      states.set(session, state);
    }
    return state;
  };

  return {
    id: "niadra",
    name: "Niadra customer context",

    async processLLMRequest({ prompt, model, requestContext, state: kept }: ProcessLLMRequestArgs): Promise<ProcessLLMRequestResult> {
      const state = stateOf(requestContext);
      if (!state) return undefined;
      runOf(kept, state.bridge.session);
      try {
        if (isRecord(model)) {
          state.model = {
            ...(typeof model.provider === "string" ? { provider: model.provider } : {}),
            ...(typeof model.modelId === "string" ? { modelId: model.modelId } : {}),
          };
        }
        if (options.recordCustomer ?? true) recordNewest(state.bridge, state.seen, prompt);
        const read = await state.bridge.read();
        state.bridge.injected(read.context);
        return { prompt: injectPrompt(prompt, read) as typeof prompt };
      } catch (error) {
        state.bridge.logger.warn(`could not inject context (${errorName(error)})`);
        return undefined;
      }
    },

    processLLMResponse({ model, chunks, requestContext, state: kept, fromCache }: ProcessLLMResponseArgs) {
      const state = hooks.enabled && !fromCache ? stateOf(requestContext) : null; // a cached answer called no model
      if (!state) return;
      const key = runOf(kept, state.bridge.session);
      // This step's usage is on its `finish` chunk; `steps` holds the ones before it.
      const finished: unknown = chunks.find((chunk) => chunk.type === "finish");
      const payload = isRecord(finished) && isRecord(finished.payload) ? finished.payload : {};
      const usage = isRecord(payload.output) ? payload.output.usage : undefined;
      const name = isRecord(model) && typeof model.modelId === "string" ? model.modelId : state.model?.modelId;
      const reported = mastraUsage(usage, state.model);
      const out = isRecord(usage) ? (count(usage.outputTokens) ?? (isRecord(usage.outputTokens) ? count(usage.outputTokens.total) : null)) : null;
      hooks.model(state.bridge.session, name, reported ? { in: reported.prompt_tokens, out, cached: reported.cached_tokens ?? 0 } : {}, key);
    },

    processInputStep({ tools }: ProcessInputStepArgs) {
      if (replaying() === null || tools === undefined) return undefined;
      return { tools: replayed(tools) };
    },

    processOutputStep({ messageList, toolCalls, requestContext, state: kept }: ProcessOutputStepArgs) {
      const state = hooks.enabled ? stateOf(requestContext) : null;
      if (!state) return messageList;
      const key = runOf(kept, state.bridge.session);
      for (const call of toolCalls ?? []) {
        hooks.toolStart(state.bridge.session, call.toolCallId, call.toolName, call.args, { ...(key ? { frameKey: key } : {}), callId: call.toolCallId });
      }
      return messageList;
    },

    processToolResult({ toolCallId, result }: ProcessToolResultArgs) {
      hooks.toolEnd(toolCallId, result);
    },

    processOutputResult({ messageList, result, requestContext, state: kept }: ProcessOutputResultArgs) {
      const state = stateOf(requestContext);
      const key = kept[RUN];
      try {
        if (!(options.recordAgent ?? true) || !state || typeof result.text !== "string") return messageList;
        try {
          const usage = mastraUsage(result.usage, state.model);
          state.bridge.agent(result.text, usage ? { usage } : {});
        } catch (error) {
          state.bridge.logger.warn(`could not record the agent's answer (${errorName(error)})`);
        }
        return messageList;
      } finally {
        if (typeof key === "string") hooks.close(key);
      }
    },
  };
}

/**
 * The navigation kit as Mastra tools, bound to the session's customer. Pass the session, or
 * nothing inside `tools: ({ requestContext }) => niadraTools(requestContext.get("niadra"))`;
 * without a session it returns no tools.
 */
export function niadraTools(session: unknown, options: { agentMemory?: AgentMemoryOption } = {}): Record<string, ReturnType<typeof createTool>> {
  const resolved = asSession(session);
  if (!resolved) return {};
  const tools: Record<string, ReturnType<typeof createTool>> = {};
  for (const spec of new Bridge(resolved, undefined, options.agentMemory).tools()) {
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
export function niadraInstructions(base: string, options: { session?: Session; agentMemory?: AgentMemoryOption } = {}) {
  return async ({ requestContext }: { requestContext: RequestContextLike }): Promise<string> => {
    const session = options.session ?? asSession(requestContext.get(NIADRA_CONTEXT_KEY));
    if (!session) return base;
    const bridge = new Bridge(session, undefined, options.agentMemory);
    const read = await bridge.read();
    bridge.injected(read.context);
    return [base, read.prefix, read.suffix].filter(Boolean).join("\n\n");
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

/** The step's tools with each `execute` wrapped with `tool()`: in a replay, a call answers from the record. */
function replayed(tools: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(tools)) {
    const execute = isRecord(spec) ? spec.execute : undefined;
    if (typeof execute !== "function" || recordedTool(execute)) {
      out[name] = spec;
      continue;
    }
    const wrapped = recorded<[unknown, unknown?], unknown>(name, execute as (input: unknown, context?: unknown) => unknown, {
      args: (input) => input,
      callId: (_input: unknown, context?: unknown) => (isRecord(context) && typeof context.toolCallId === "string" ? context.toolCallId : null),
    });
    out[name] = Object.assign(Object.create(Object.getPrototypeOf(spec) as object) as object, spec, { execute: wrapped });
  }
  return out;
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
