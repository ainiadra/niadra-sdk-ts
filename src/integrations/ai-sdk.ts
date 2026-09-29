/**
 * Niadra for the Vercel AI SDK (`ai` 5, 6 and 7), the idiomatic way: a language model middleware
 * for `wrapLanguageModel({ model, middleware })`, which works with every provider, and the
 * navigation kit as AI SDK tools.
 *
 * - `transformParams` records the customer's newest message, puts the pack as a system message
 *   right after your system messages and the suffix (deltas and live turns) as a text part at the
 *   end of the last user message, where every provider accepts it.
 * - `wrapGenerate` and `wrapStream` record the model's text as the agent's turn, with the usage the
 *   provider reported (prompt tokens, cache reads and writes). Tool-only steps record nothing.
 * - Turn records: inside a turn of the session (`conversation.turn()` around `generateText`, or
 *   `niadraTurn()` for `streamText`, whose steps run after the call returns), each model call is
 *   recorded with its tokens, and `recordTools(tools)` records each tool call with the provider's
 *   call id; in a replay those tools answer from the record.
 *
 * Nothing here can fail the model call: a context that cannot be read is left out, and a failure
 * to record is logged without content.
 *
 * @example
 * const convo = niadra.conversation({ subject: handles.appUserId(user.id), channel: "web_chat", conversation_id: chatId });
 * const result = streamText({
 *   model: wrapLanguageModel({ model: openai("gpt-4.1"), middleware: niadraMiddleware(convo) }),
 *   system: "You are Acme's support agent.",
 *   messages,
 *   tools: { ...niadraTools(convo), ...yourTools },
 * });
 *
 * @example
 * const turn = niadraTurn(convo);
 * const result = turn.run(() =>
 *   streamText({ model, messages, tools: recordTools(yourTools, { session: convo }), onFinish: turn.onFinish, onError: turn.onError }),
 * );
 */

import { jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";
import type { TurnParams } from "../agent-session.js";
import type { TurnFrame } from "../capture/frame.js";
import { tool as recorded } from "../capture/tool.js";
import type { ModelUsage } from "../types/events.js";
import { injectPrompt, recordNewest } from "./prompt.js";
import { Bridge, TurnHooks, count, errorName, isRecord, resolveSession } from "./shared.js";
import type { AgentMemoryOption, ProofSource, Session, SessionResolver } from "./shared.js";

export { attestationProof } from "./shared.js";
export type { AgentMemoryOption, Proof, ProofSource, Session, SessionResolver } from "./shared.js";

export interface NiadraMiddlewareOptions {
  /** What your app proved about the user (a login, say), recorded once before the first context read. */
  verify?: ProofSource;
  /** Records the newest user message as the customer's turn. Defaults to `true`. */
  recordCustomer?: boolean;
  /** Records the model's text as the agent's turn. Defaults to `true`. */
  recordAgent?: boolean;
  /** Puts the agent's own notes before the customer's context. Pass the same to `niadraTools`. */
  agentMemory?: AgentMemoryOption;
}

type Params = Record<string, unknown> & { prompt?: unknown };
interface ModelInfo {
  provider?: string;
  modelId?: string;
}

/**
 * The middleware, in the shape `wrapLanguageModel` takes from AI SDK 5 on. `specificationVersion`
 * is the one AI SDK 6 requires; AI SDK 5 and 7 do not read it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the AI SDK majors type these with their own
   call options and results; `any` keeps one middleware assignable to all three. */
export interface NiadraMiddleware {
  readonly specificationVersion: "v3";
  transformParams(options: { type: "generate" | "stream"; params: any; model: any }): PromiseLike<any>;
  wrapGenerate(options: { doGenerate: () => PromiseLike<any>; doStream: () => PromiseLike<any>; params: any; model: any }): PromiseLike<any>;
  wrapStream(options: { doGenerate: () => PromiseLike<any>; doStream: () => PromiseLike<any>; params: any; model: any }): PromiseLike<any>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

interface State {
  bridge: Bridge;
  seen: Set<string>;
}

/**
 * A middleware bound to a conversation or task, or to a function that finds the one each call
 * belongs to (for a model wrapped once at startup). When the function returns `null`, the call
 * passes through untouched.
 */
export function niadraMiddleware(session: SessionResolver, options: NiadraMiddlewareOptions = {}): NiadraMiddleware {
  const states = new WeakMap<Session, State>();
  const hooks = new TurnHooks("ai-sdk", true);
  const modelCall = (usage: unknown, model: ModelInfo, modelId: unknown): void => {
    const current = resolveSession(session);
    if (!current) return;
    const name = typeof modelId === "string" && modelId ? modelId : model.modelId;
    const reported = aiSdkUsage(usage, model, modelId);
    const out = isRecord(usage) ? (count(usage.outputTokens) ?? (isRecord(usage.outputTokens) ? count(usage.outputTokens.total) : null)) : null;
    hooks.model(current, name, reported ? { in: reported.prompt_tokens, out, cached: reported.cached_tokens ?? 0 } : {});
  };
  const stateOf = (): State | null => {
    const current = resolveSession(session);
    if (!current) return null;
    let state = states.get(current);
    if (!state) {
      state = { bridge: new Bridge(current, options.verify, options.agentMemory), seen: new Set() };
      states.set(current, state);
    }
    return state;
  };

  return {
    specificationVersion: "v3",

    async transformParams({ params }: { params: Params }) {
      const state = stateOf();
      if (!state || !Array.isArray(params.prompt)) return params;
      try {
        const prompt = params.prompt as unknown[];
        if (options.recordCustomer ?? true) recordNewest(state.bridge, state.seen, prompt);
        const read = await state.bridge.read();
        state.bridge.injected(read.context);
        return { ...params, prompt: injectPrompt(prompt, read) };
      } catch (error) {
        state.bridge.logger.warn(`could not inject context (${errorName(error)})`);
        return params;
      }
    },

    async wrapGenerate({ doGenerate, model }: { doGenerate: () => PromiseLike<unknown>; model: ModelInfo }) {
      const result = await doGenerate();
      if (isRecord(result)) modelCall(result.usage, model, isRecord(result.response) ? result.response.modelId : undefined);
      if (options.recordAgent ?? true) {
        const state = stateOf();
        if (state) {
          try {
            const content = isRecord(result) && Array.isArray(result.content) ? (result.content as unknown[]) : [];
            const text = content.map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
            const response = isRecord(result) && isRecord(result.response) ? result.response : {};
            record(state, text, isRecord(result) ? result.usage : undefined, model, response.modelId);
          } catch (error) {
            state.bridge.logger.warn(`could not capture the model's answer (${errorName(error)})`);
          }
        }
      }
      return result;
    },

    async wrapStream({ doStream, model }: { doStream: () => PromiseLike<unknown>; model: ModelInfo }) {
      const result = await doStream();
      const state = (options.recordAgent ?? true) ? stateOf() : null;
      if (!state || !isRecord(result) || !(result.stream instanceof ReadableStream)) return result;
      const parts: string[] = [];
      let usage: unknown;
      let modelId: unknown;
      const capture = new TransformStream<unknown, unknown>({
        transform(chunk, controller) {
          if (isRecord(chunk)) {
            if (chunk.type === "text-delta") parts.push(typeof chunk.delta === "string" ? chunk.delta : typeof chunk.textDelta === "string" ? chunk.textDelta : "");
            else if (chunk.type === "finish") usage = chunk.usage;
            else if (chunk.type === "response-metadata") modelId = chunk.modelId;
          }
          controller.enqueue(chunk);
        },
        flush() {
          try {
            modelCall(usage, model, modelId);
            record(state, parts.join(""), usage, model, modelId);
          } catch (error) {
            state.bridge.logger.warn(`could not capture the model's answer (${errorName(error)})`);
          }
        },
      });
      return { ...result, stream: (result.stream as ReadableStream<unknown>).pipeThrough(capture) };
    },
  };
}

/**
 * The navigation kit as AI SDK tools (`search_customer_history`, `get_customer_timeline`,
 * `open_history_item`), bound to the session's customer. Spread them next to your own tools.
 */
export function niadraTools(session: Session, options: { agentMemory?: AgentMemoryOption } = {}): ToolSet {
  const tools: ToolSet = {};
  for (const spec of new Bridge(session, undefined, options.agentMemory).tools()) {
    tools[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema<Record<string, unknown>>(spec.parameters as Parameters<typeof jsonSchema>[0]),
      execute: async (input: Record<string, unknown>) => parsed(await spec.execute(input)),
    });
  }
  return tools;
}

/**
 * A turn of the session for one `streamText` or `generateText` call: run the call inside `run()` and pass
 * `onFinish` and `onError` (call them from yours when you have your own), which close the turn.
 */
export function niadraTurn(
  session: Session,
  params: TurnParams = {},
): { frame: TurnFrame; run<T>(fn: () => T): T; onFinish(): void; onError(event: { error: unknown }): void; onAbort(): void } {
  const frame = session.openTurn({ ...params, adapter: "ai-sdk" });
  return {
    frame,
    run: (fn) => frame.run(fn),
    onFinish: () => {
      frame.close();
    },
    onError: (event) => {
      frame.close(event.error);
    },
    onAbort: () => {
      frame.close();
    },
  };
}

export interface RecordToolsOptions {
  /** The session whose turn in progress the calls go to when the async context does not carry it. */
  session?: Session;
  /** The tools a replay may run for real when the record has no answer: their names, or all. */
  dryRun?: boolean | readonly string[];
}

/**
 * Your tools with each call recorded in the turn it runs in, named by the tool's key, with the provider's
 * call id. In a replay a call answers from the record. Tools without `execute` pass as they are.
 */
export function recordTools<T extends ToolSet>(tools: T, options: RecordToolsOptions = {}): T {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(tools)) {
    const execute = isRecord(spec) ? spec.execute : undefined;
    if (typeof execute !== "function") {
      out[name] = spec;
      continue;
    }
    const dryRun = Array.isArray(options.dryRun) ? options.dryRun.includes(name) : options.dryRun === true;
    const session = options.session;
    out[name] = {
      ...spec,
      execute: recorded<[unknown, unknown?], unknown>(name, execute as (input: unknown, context?: unknown) => unknown, {
        args: (input) => input,
        callId: (_input: unknown, context?: unknown) => (isRecord(context) && typeof context.toolCallId === "string" ? context.toolCallId : null),
        ...(session ? { frame: () => session.activeTurn() } : {}),
        dryRun,
      }),
    };
  }
  return out as T;
}

/** What the AI SDK reports as usage, as a `ModelUsage`: v2 counts are numbers, v3 and v4 split the input. */
export function aiSdkUsage(usage: unknown, model: ModelInfo, modelId?: unknown): ModelUsage | null {
  if (!isRecord(usage)) return null;
  const name = typeof modelId === "string" && modelId ? modelId : model.modelId;
  const provider = model.provider?.split(".")[0]?.toLowerCase();
  if (!name || !provider) return null;
  let prompt: number | null;
  let cached: number;
  let written: number;
  if (isRecord(usage.inputTokens)) {
    const input = usage.inputTokens;
    cached = count(input.cacheRead) ?? 0;
    written = count(input.cacheWrite) ?? 0;
    prompt = count(input.total) ?? (count(input.noCache) === null ? null : (count(input.noCache) ?? 0) + cached + written);
  } else {
    prompt = count(usage.inputTokens);
    cached = count(usage.cachedInputTokens) ?? 0;
    written = 0;
  }
  if (prompt === null) return null;
  return { provider, model: name, prompt_tokens: Math.max(prompt, cached + written), cached_tokens: cached, cache_write_tokens: written };
}

function record(state: State, text: string, usage: unknown, model: ModelInfo, modelId: unknown): void {
  const reported = aiSdkUsage(usage, model, modelId);
  state.bridge.agent(text, reported ? { usage: reported } : {});
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
