/**
 * Niadra for Genkit (`genkit` 1.x, Firebase Genkit for JavaScript): a model middleware for
 * `generate({ use })` and the navigation kit as Genkit tools.
 *
 * - `niadraMiddleware(session)` runs around every model call, the steps of a tool loop included:
 *   it records the customer's newest message once, adds the agent's notes and the customer's pack
 *   as a text part of your system message (a new system message when there is none), and adds the
 *   suffix (deltas and live turns) as a text part of the last user message. The answer is recorded
 *   as the agent's turn with Genkit's usage (input tokens and cached content tokens) when you name
 *   the model; steps that only request tools record nothing.
 * - `niadraTools(session)` is the kit as Genkit tools (not registered, so each request can carry
 *   the tools bound to its own customer), with the canonical JSON Schemas.
 *
 * Fail-open: when Niadra is slow or down, the request goes to the model as it came.
 *
 * @example
 * import { genkit } from "genkit";
 * import { googleAI } from "@genkit-ai/google-genai";
 * import { niadraMiddleware, niadraTools } from "@niadra/sdk/genkit";
 *
 * const ai = genkit({ plugins: [googleAI()] });
 * const convo = niadra.conversation({ subject: handles.appUserId(user.id), channel: "web_chat", conversation_id: chatId });
 * const { text } = await ai.generate({
 *   model: googleAI.model("gemini-2.5-flash"),
 *   system: "You are Acme's support agent.",
 *   messages: history,
 *   prompt: "Where is my replacement?",
 *   tools: niadraTools(convo),
 *   use: [niadraMiddleware(convo, { model: "googleai/gemini-2.5-flash" })],
 * });
 */

import type { GenerateRequest, GenerateResponseData, MessageData, ModelMiddleware, Part } from "genkit/model";
import { tool } from "genkit/tool";
import type { ToolAction } from "genkit/tool";
import type { ModelUsage } from "../types/events.js";
import { providerOf } from "../usage.js";
import { Bridge, count, errorName, isRecord, resolveSession } from "./shared.js";
import type { AgentMemoryOption, ProofSource, Session, SessionResolver } from "./shared.js";

export { attestationProof } from "./shared.js";
export type { AgentMemoryOption, Proof, ProofSource, Session, SessionResolver } from "./shared.js";

export interface NiadraMiddlewareOptions {
  /** What your app proved about the user, recorded once before the first context read. */
  verify?: ProofSource;
  /** Records the newest user message as the customer's turn. Defaults to `true`. */
  recordCustomer?: boolean;
  /** Records the model's answer as the agent's turn. Defaults to `true`. */
  recordAgent?: boolean;
  /**
   * The model the request goes to, as Genkit names it (`googleai/gemini-2.5-flash`), for the usage
   * of the agent's turn. A model middleware does not see the model's name; without it the turn is
   * recorded without usage.
   */
  model?: string;
  /** Puts the agent's own notes before the customer's context. Pass the same to `niadraTools`. */
  agentMemory?: AgentMemoryOption;
}

interface State {
  bridge: Bridge;
  seen: Set<string>;
}

/**
 * A Genkit model middleware bound to a conversation or task, or to a function that finds the one
 * each call belongs to; when it returns `null`, the call passes through untouched.
 */
export function niadraMiddleware(session: SessionResolver, options: NiadraMiddlewareOptions = {}): ModelMiddleware {
  const states = new WeakMap<Session, State>();
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

  return async (request, next) => {
    const state = stateOf();
    if (!state) return next(request);
    let prepared: GenerateRequest = request;
    try {
      if (options.recordCustomer ?? true) recordNewest(state, request.messages);
      const read = await state.bridge.read();
      state.bridge.injected(read.context);
      prepared = { ...request, messages: inject(request.messages, read.prefix, read.suffix) };
    } catch (error) {
      state.bridge.logger.warn(`could not inject context (${errorName(error)})`);
    }
    const response = await next(prepared);
    if (options.recordAgent ?? true) {
      try {
        const answer = answerOf(response);
        if (answer) {
          const usage = options.model ? genkitUsage(response.usage, options.model) : null;
          state.bridge.agent(answer, usage ? { usage } : {});
        }
      } catch (error) {
        state.bridge.logger.warn(`could not record the agent's answer (${errorName(error)})`);
      }
    }
    return response;
  };
}

/** The navigation kit as Genkit tools, bound to the session's customer. */
export function niadraTools(session: Session, options: { agentMemory?: AgentMemoryOption } = {}): ToolAction[] {
  return new Bridge(session, undefined, options.agentMemory).tools().map(
    (spec) =>
      tool(
        { name: spec.name, description: spec.description, inputJsonSchema: spec.parameters, outputJsonSchema: {} },
        async (input: unknown) => parsed(await spec.execute(isRecord(input) ? input : {})),
      ) as unknown as ToolAction,
  );
}

/** Genkit's usage as a `ModelUsage`: `inputTokens` counts the cached content tokens too. */
export function genkitUsage(usage: unknown, model: string): ModelUsage | null {
  if (!isRecord(usage)) return null;
  const prompt = count(usage.inputTokens);
  if (prompt === null) return null;
  const cached = count(usage.cachedContentTokens) ?? 0;
  const slash = model.indexOf("/");
  const name = slash > 0 ? model.slice(slash + 1) : model;
  return { provider: providerOf(model, usage), model: name, prompt_tokens: Math.max(prompt, cached), cached_tokens: cached, cache_write_tokens: 0 };
}

function recordNewest(state: State, messages: readonly MessageData[]): void {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = textParts(message.content);
    const key = `${String(index)}:${text}`;
    if (text && !state.seen.has(key)) {
      state.seen.add(key);
      state.bridge.customer(text);
    }
    return;
  }
}

/** A copy of the messages: the prefix as a part of the leading system message, the suffix as a part of the last user message. */
function inject(messages: readonly MessageData[], prefix: string, suffix: string): MessageData[] {
  const result = [...messages];
  if (suffix) {
    for (let index = result.length - 1; index >= 0; index--) {
      const message = result[index];
      if (message?.role !== "user") continue;
      result[index] = { ...message, content: [...message.content, { text: suffix }] };
      break;
    }
  }
  if (prefix) {
    let position = 0;
    while (position < result.length && result[position]?.role === "system") position++;
    const system = result[position - 1];
    // Several providers read one system message only, so the pack joins yours.
    if (system) result[position - 1] = { ...system, content: [...system.content, { text: prefix }] };
    else result.unshift({ role: "system", content: [{ text: prefix }] });
  }
  return result;
}

function answerOf(response: GenerateResponseData): string {
  const message = response.message ?? response.candidates?.[0]?.message;
  if (!message || message.content.some((part) => "toolRequest" in part)) return "";
  return textParts(message.content);
}

function textParts(content: readonly Part[]): string {
  return content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
