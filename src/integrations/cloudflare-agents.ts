/**
 * Niadra for the Cloudflare Agents SDK (`agents` 0.x): one helper per `Agent` instance (a Durable
 * Object), with the customer's context before every model call and the navigation kit as tools.
 * Only web APIs and the AI SDK (which `agents` already requires), so it runs on Workers as it is.
 *
 * `niadraAgent(this, { niadra, subject })` returns the same helper for the life of the instance,
 * bound to one conversation whose id is the agent's name (the id you route to, such as a chat or
 * a user) unless you give another:
 *
 * - `middleware`: the `@niadra/sdk/ai-sdk` middleware for `wrapLanguageModel()`, the way agents call
 *   models (`AIChatAgent.onChatMessage`, `streamText`, `generateText`): the pack after your system
 *   prompt, the suffix at the end of the last user message, the customer's newest message and the
 *   answer recorded with the provider's usage. After each answer it hands the queued writes to
 *   `ctx.waitUntil()`, so the instance does not go idle before Niadra has them.
 * - `tools()`: the kit as AI SDK tools bound to the customer.
 * - `prepare(messages)` and `record(text)`: the same for a model called without the AI SDK, such
 *   as the Workers AI binding (`env.AI.run(model, { messages })`, whose usage `workersAiUsage()`
 *   reads) or a voice agent's `onTurn()` (pass `channel: "voice"` for the voice budget).
 *
 * Fail-open: when Niadra is slow or down, the model gets the messages as they came.
 *
 * @example
 * import { AIChatAgent } from "@cloudflare/ai-chat";
 * import { convertToModelMessages, streamText, wrapLanguageModel } from "ai";
 * import { createWorkersAI } from "workers-ai-provider";
 * import { Niadra, handles } from "@niadra/sdk";
 * import { niadraAgent } from "@niadra/sdk/cloudflare-agents";
 *
 * let niadra: Niadra | undefined; // one client per isolate
 *
 * export class Support extends AIChatAgent<Env> {
 *   async onChatMessage() {
 *     niadra ??= new Niadra({ apiKey: this.env.NIADRA_API_KEY });
 *     const memory = niadraAgent(this, { niadra, subject: handles.appUserId(this.name) });
 *     const result = streamText({
 *       model: wrapLanguageModel({ model: createWorkersAI({ binding: this.env.AI })("@cf/openai/gpt-oss-120b"), middleware: memory.middleware }),
 *       system: "You are Acme's support agent.",
 *       messages: await convertToModelMessages(this.messages),
 *       tools: { ...memory.tools(), ...yourTools },
 *     });
 *     return result.toUIMessageStreamResponse();
 *   }
 * }
 */

import type { ToolSet } from "ai";
import type { Niadra } from "../client.js";
import type { TurnOptions } from "../conversation.js";
import type { Handle } from "../types/common.js";
import type { ModelUsage } from "../types/events.js";
import type { NiadraMiddleware } from "./ai-sdk.js";
import { niadraMiddleware, niadraTools } from "./ai-sdk.js";
import { Bridge, count, errorName, isRecord, textOf } from "./shared.js";
import type { AgentMemoryOption, ProofSource, Session } from "./shared.js";

export { attestationProof } from "./shared.js";
export type { NiadraMiddleware } from "./ai-sdk.js";
export type { AgentMemoryOption, Proof, ProofSource, Session } from "./shared.js";

/** What the helper reads from an `Agent`: its name (and, at run time, `ctx.waitUntil` when there). */
export interface AgentLike {
  readonly name: string;
}

export interface NiadraAgentOptions {
  niadra: Niadra;
  /**
   * Who the customer is: a handle, or a function of the agent (its name is often your user or chat
   * id). Never from the model. Leave it out when you pass `session`.
   */
  subject?: Handle | ((agent: AgentLike) => Handle | null | undefined);
  /** Defaults to `web_chat`; `voice` gives the voice budget and view. */
  channel?: string;
  /** Defaults to the agent's name. */
  conversationId?: string;
  /** A conversation or an internal agent's task you opened yourself, in place of `subject`. */
  session?: Session;
  /** What your app proved about the user, recorded once before the first context read. */
  verify?: ProofSource;
  /** Records the newest user message as the customer's turn. Defaults to `true`. */
  recordCustomer?: boolean;
  /** Records the model's answer as the agent's turn. Defaults to `true`. */
  recordAgent?: boolean;
  /** Puts the agent's own notes before the customer's context, and adds its memory tools. */
  agentMemory?: AgentMemoryOption;
  /** Keeps the instance alive until a promise settles. Defaults to the agent's `ctx.waitUntil`. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** A chat message in the `{ role, content }` shape the Workers AI binding and most chat APIs take. */
export interface ChatMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

export interface NiadraForAgent {
  /** The conversation or task, or `null` when no customer could be found (everything then passes through). */
  readonly session: Session | null;
  /** For `wrapLanguageModel({ model, middleware })`. */
  readonly middleware: NiadraMiddleware;
  /** The navigation kit as AI SDK tools; none without a session. */
  tools(): ToolSet;
  /** The messages with the context in place, for a model called without the AI SDK. Never rejects. */
  prepare<M extends ChatMessage>(messages: readonly M[]): Promise<M[]>;
  /** Records an answer given without the AI SDK middleware, with the provider's response or usage when you have it. */
  record(text: string, options?: TurnOptions): void;
  /** Hands the queued writes to `ctx.waitUntil()` (the middleware and `record` do it for you). */
  flush(): void;
  /** Ends the conversation (or task) and sends what is queued. */
  end(): Promise<void>;
}

const helpers = new WeakMap<object, NiadraForAgent>();

/**
 * The helper for one agent instance. The first call builds it; later calls on the same instance
 * return the same helper, so the conversation keeps its pinned pack and its deltas across turns.
 */
export function niadraAgent(agent: AgentLike, options: NiadraAgentOptions): NiadraForAgent {
  const existing = helpers.get(agent);
  if (existing) return existing;
  const helper = build(agent, options);
  helpers.set(agent, helper);
  return helper;
}

function build(agent: AgentLike, options: NiadraAgentOptions): NiadraForAgent {
  const logger = options.niadra.logger;
  const session = options.session ?? open(agent, options);
  const waitUntil = options.waitUntil ?? waitUntilOf(agent);
  const flush = (): void => {
    try {
      const sending = options.niadra.flush().catch((error: unknown) => {
        logger.warn(`could not send to Niadra (${errorName(error)})`);
      });
      waitUntil?.(sending);
    } catch (error) {
      logger.warn(`could not schedule the flush (${errorName(error)})`);
    }
  };
  const base = niadraMiddleware(session ?? (() => null), {
    ...(options.verify === undefined ? {} : { verify: options.verify }),
    ...(options.recordCustomer === undefined ? {} : { recordCustomer: options.recordCustomer }),
    ...(options.recordAgent === undefined ? {} : { recordAgent: options.recordAgent }),
    ...(options.agentMemory === undefined ? {} : { agentMemory: options.agentMemory }),
  });
  const middleware: NiadraMiddleware = {
    specificationVersion: base.specificationVersion,
    transformParams: (call) => base.transformParams(call),
    async wrapGenerate(call) {
      const result: unknown = await base.wrapGenerate(call);
      flush();
      return result;
    },
    async wrapStream(call) {
      const result: unknown = await base.wrapStream(call);
      if (!isRecord(result) || !(result.stream instanceof ReadableStream)) return result;
      // Runs after the middleware's own capture has recorded the answer.
      const after = new TransformStream<unknown, unknown>({ flush });
      return { ...result, stream: (result.stream as ReadableStream<unknown>).pipeThrough(after) };
    },
  };
  const bridge = session ? new Bridge(session, options.verify, options.agentMemory) : null;
  const seen = new Set<string>();

  return {
    session,
    middleware,
    tools: () => (session ? niadraTools(session, options.agentMemory === undefined ? {} : { agentMemory: options.agentMemory }) : {}),
    async prepare(messages) {
      if (!bridge) return [...messages];
      try {
        if (options.recordCustomer ?? true) {
          const index = lastUser(messages);
          const text = index >= 0 ? textOf(messages[index]?.content) : "";
          const key = `${String(index)}:${text}`;
          if (text && !seen.has(key)) {
            seen.add(key);
            bridge.customer(text);
          }
        }
        const read = await bridge.read();
        bridge.injected(read.context);
        return inject(messages, read.prefix, read.suffix);
      } catch (error) {
        logger.warn(`could not inject context (${errorName(error)})`);
        return [...messages];
      }
    },
    record(text, turn = {}) {
      if (!bridge || !(options.recordAgent ?? true)) return;
      bridge.agent(text, turn);
      flush();
    },
    flush,
    async end() {
      if (bridge) await bridge.end();
      flush();
    },
  };
}

function open(agent: AgentLike, options: NiadraAgentOptions): Session | null {
  let subject: Handle | null | undefined;
  try {
    subject = typeof options.subject === "function" ? options.subject(agent) : options.subject;
  } catch (error) {
    options.niadra.logger.warn(`could not find the customer (${errorName(error)})`);
    return null;
  }
  if (!subject) return null;
  return options.niadra.conversation({ subject, channel: options.channel ?? "web_chat", conversation_id: options.conversationId ?? agent.name });
}

/**
 * The usage of a Workers AI binding answer (`{ usage: { prompt_tokens } }`) as a `ModelUsage`, for
 * `record(text, { usage: workersAiUsage(answer, model) })`. The model id loses its leading `@`.
 */
export function workersAiUsage(answer: unknown, model: string): ModelUsage | null {
  const usage = isRecord(answer) && isRecord(answer.usage) ? answer.usage : null;
  const prompt = usage ? count(usage.prompt_tokens) : null;
  const name = model.replace(/^@/, "");
  if (prompt === null || !name) return null;
  const details = usage && isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cached = Math.min(count(details.cached_tokens) ?? 0, prompt);
  return { provider: "workers-ai", model: name, prompt_tokens: prompt, cached_tokens: cached, cache_write_tokens: 0 };
}

/** The Durable Object's `ctx.waitUntil`, which the class keeps protected. */
function waitUntilOf(agent: AgentLike): ((promise: Promise<unknown>) => void) | undefined {
  const ctx = (agent as { ctx?: unknown }).ctx;
  if (!isRecord(ctx) || typeof ctx.waitUntil !== "function") return undefined;
  const waitUntil = ctx.waitUntil as (promise: Promise<unknown>) => void;
  return (promise) => {
    waitUntil.call(ctx, promise);
  };
}

function lastUser(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.role === "user") return index;
  return -1;
}

/** A copy: the prefix as a system message after the leading ones, the suffix at the end of the last user message. */
function inject<M extends ChatMessage>(messages: readonly M[], prefix: string, suffix: string): M[] {
  const result = [...messages];
  const index = lastUser(result);
  const last = result[index];
  if (suffix && last) {
    const content = last.content;
    const next = typeof content === "string" ? `${content}\n\n${suffix}` : Array.isArray(content) ? [...(content as unknown[]), { type: "text", text: suffix }] : content;
    result[index] = { ...last, content: next };
  }
  if (prefix) {
    let position = 0;
    while (position < result.length && result[position]?.role === "system") position++;
    result.splice(position, 0, { role: "system", content: prefix } as M);
  }
  return result;
}
