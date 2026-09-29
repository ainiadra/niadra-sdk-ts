/**
 * Niadra for LangChain.js and LangGraph.js (`@langchain/core` 1.x).
 *
 * - `niadraContext(session)` is a runnable for LCEL chains (`niadraContext(convo).pipe(model)`):
 *   it takes the messages (or `{ messages }`), records the customer's newest message, and returns
 *   them with the pack as a system message after the leading system messages and the suffix
 *   appended to the last human message. `withNiadraContext(session, messages)` does the same
 *   inside a LangGraph node, right before the model call, so nothing lands in the graph's state.
 * - `NiadraCallbackHandler` records the model's answers with the usage LangChain standardizes
 *   (`usage_metadata`, prompt cache reads and writes included). Answers that only call tools
 *   record nothing. With `{ turns: true }` each top-level run (a chain, a graph, an agent, or a
 *   chat model called alone) is a turn record, with its tool calls (the provider's call ids) and
 *   its model calls with their tokens; a run inside a turn in progress (`conversation.turn()`)
 *   records into it. A function wrapped with `tool()` inside a tool takes over its call, which is
 *   how a replay answers it from the record.
 * - `niadraTools(session)` is the navigation kit as structured tools bound to the customer.
 *
 * Fail-open: when Niadra is slow or down, the messages go to the model as they came.
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { RunnableLambda } from "@langchain/core/runnables";
import type { Runnable } from "@langchain/core/runnables";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { tool as recorded, recordedTool } from "../capture/tool.js";
import { NiadraReplayRefusedError } from "../errors.js";
import { replaying } from "../replay/playback.js";
import type { ModelUsage } from "../types/events.js";
import { providerOf } from "../usage.js";
import { Bridge, TurnHooks, count, errorName, isRecord, resolveSession } from "./shared.js";
import type { AgentMemoryOption, ProofSource, Session, SessionResolver } from "./shared.js";
import type { Serialized } from "@langchain/core/load/serializable";

export { attestationProof } from "./shared.js";
export type { AgentMemoryOption, Proof, ProofSource, Session, SessionResolver } from "./shared.js";

export interface NiadraContextOptions {
  /** What your app proved about the user, recorded once before the first context read. */
  verify?: ProofSource;
  /** Records the newest human message as the customer's turn. Defaults to `true`. */
  recordCustomer?: boolean;
  /** Puts the agent's own notes before the customer's context. Pass the same to `niadraTools`. */
  agentMemory?: AgentMemoryOption;
}

interface State {
  bridge: Bridge;
  seen: Set<string>;
}

const states = new WeakMap<Session, State>();

function stateOf(session: Session, options: NiadraContextOptions): State {
  let state = states.get(session);
  if (!state) {
    state = { bridge: new Bridge(session, options.verify, options.agentMemory), seen: new Set() };
    states.set(session, state);
  }
  return state;
}

/**
 * The messages with the context in place: the prefix (the agent's notes and the customer's pack)
 * after the leading system messages, the suffix at the end of the last human message. Records
 * the newest human message once. Returns a new array; never throws.
 */
export async function withNiadraContext(
  session: Session,
  messages: readonly BaseMessage[],
  options: NiadraContextOptions = {},
): Promise<BaseMessage[]> {
  const state = stateOf(session, options);
  try {
    const last = lastHumanIndex(messages);
    const human = messages[last];
    if ((options.recordCustomer ?? true) && human) {
      const text = human.text;
      const key = `${String(last)}:${text}`;
      if (text && !state.seen.has(key)) {
        state.seen.add(key);
        state.bridge.customer(text);
      }
    }
    const read = await state.bridge.read();
    state.bridge.injected(read.context);
    const result = [...messages];
    if (read.suffix && human) result[last] = withSuffix(human, read.suffix);
    if (read.prefix) {
      let position = 0;
      while (position < result.length && result[position]?.type === "system") position++;
      result.splice(position, 0, new SystemMessage(read.prefix));
    }
    return result;
  } catch (error) {
    state.bridge.logger.warn(`could not inject context (${errorName(error)})`);
    return [...messages];
  }
}

/**
 * A runnable that puts the context into the messages, for LCEL: `niadraContext(convo).pipe(model)`.
 * Takes a list of messages or `{ messages }`. With a function in place of the session, it finds
 * the session per call; `null` passes the messages through.
 */
export function niadraContext(
  session: SessionResolver,
  options: NiadraContextOptions = {},
): Runnable<BaseMessage[] | { messages: BaseMessage[] }, BaseMessage[]> {
  return RunnableLambda.from(async (input: BaseMessage[] | { messages: BaseMessage[] }) => {
    const messages = Array.isArray(input) ? input : input.messages;
    const current = resolveSession(session);
    return current ? withNiadraContext(current, messages, options) : [...messages];
  }).withConfig({ runName: "niadra_context" });
}

export interface NiadraCallbackOptions {
  /** Records each top-level run as a turn, with its tool and model calls. Defaults to `false`. */
  turns?: boolean;
}

/**
 * Records the model's answers as the agent's turns, with their usage, and with `turns: true` the
 * turn record of each top-level run. Pass it in `callbacks` of the model or of the whole run; with
 * a function in place of the session, it finds the session per callback.
 */
export class NiadraCallbackHandler extends BaseCallbackHandler {
  name = "niadra";
  private readonly hooks: TurnHooks;
  /** Each nested run's top-level run, whose turn it records into. */
  private readonly roots = new Map<string, string>();

  constructor(
    private readonly session: SessionResolver,
    options: NiadraCallbackOptions = {},
  ) {
    super();
    this.hooks = new TurnHooks("langchain", options.turns ?? false);
    // The handler runs before the tool: a turn's call is recorded first, so a `tool()` inside it takes the call
    // over, and in a replay the refusal of a tool that would run live stops the run. The handler throws nothing
    // else.
    this.awaitHandlers = true;
    this.raiseError = true;
  }

  /** The same handler: the turns it holds open are shared by every run it is passed to. */
  override copy(): this {
    return this;
  }

  override handleChainStart(
    _chain: Serialized,
    _inputs: unknown,
    runId: string,
    runType?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    _runName?: string,
    parentRunId?: string,
  ): void {
    // The declared order puts the parent last; @langchain/core 1.x passes it fourth, in place of the run type.
    this.started(runId, [runType, parentRunId].find(isRunId));
  }

  override handleChainEnd(_outputs: unknown, runId: string): void {
    this.ended(runId);
  }

  override handleChainError(error: Error, runId: string): void {
    this.ended(runId, error);
  }

  override handleChatModelStart(_llm: Serialized, _messages: BaseMessage[][], runId: string, parentRunId?: string): void {
    this.started(runId, parentRunId);
  }

  override handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
    toolCallId?: string,
  ): void {
    if (replaying() !== null && _metadata?.[RECORDED] !== true) {
      throw new NiadraReplayRefusedError(runName ?? (isRecord(tool) && typeof tool.name === "string" ? tool.name : "tool"));
    }
    const current = this.hooks.enabled ? resolveSession(this.session) : null;
    if (!current) return;
    const root = parentRunId === undefined ? undefined : this.rootOf(parentRunId);
    this.roots.set(runId, root ?? runId);
    const name = runName ?? (isRecord(tool) && typeof tool.name === "string" ? tool.name : "tool");
    this.hooks.toolStart(current, runId, name, parsed(input), { ...(root ? { frameKey: root } : {}), callId: toolCallId ?? null });
  }

  override handleToolEnd(output: unknown, runId: string): void {
    this.roots.delete(runId);
    this.hooks.toolEnd(runId, isRecord(output) && "content" in output ? output.content : output);
  }

  override handleToolError(error: Error, runId: string): void {
    this.roots.delete(runId);
    this.hooks.toolEnd(runId, undefined, error);
  }

  override handleLLMEnd(output: LLMResult, runId?: string): void {
    const current = resolveSession(this.session);
    if (!current) return;
    const bridge = states.get(current)?.bridge ?? new Bridge(current);
    try {
      const generation = output.generations[0]?.[0];
      if (!generation) return;
      const message = isRecord(generation) && "message" in generation ? (generation.message as BaseMessage) : null;
      if (message && runId !== undefined) this.model(current, message, runId);
      const text = message ? message.text : generation.text;
      const usage = message ? langchainUsage(message) : null;
      bridge.agent(text, usage ? { usage } : {});
    } catch (error) {
      bridge.logger.warn(`could not record the agent's answer (${errorName(error)})`);
    } finally {
      if (runId !== undefined) this.ended(runId);
    }
  }

  override handleLLMError(error: Error, runId: string): void {
    this.ended(runId, error);
  }

  private started(runId: string, parentRunId: string | undefined): void {
    if (!this.hooks.enabled) return;
    if (parentRunId !== undefined) {
      this.roots.set(runId, this.rootOf(parentRunId));
      return;
    }
    const current = resolveSession(this.session);
    if (current) this.hooks.open(current, runId);
  }

  private ended(runId: string, error?: unknown): void {
    if (!this.hooks.enabled) return;
    this.roots.delete(runId);
    if (!this.hooks.has(runId)) return;
    for (const [run, root] of this.roots) if (root === runId) this.roots.delete(run);
    this.hooks.close(runId, error);
  }

  private rootOf(runId: string): string {
    return this.roots.get(runId) ?? runId;
  }

  private model(session: Session, message: BaseMessage, runId: string): void {
    if (!this.hooks.enabled) return;
    const usage = (message as { usage_metadata?: unknown }).usage_metadata;
    const metadata = message.response_metadata as Record<string, unknown> | undefined;
    const name = [metadata?.model_name, metadata?.model].find((value): value is string => typeof value === "string" && value.length > 0);
    const details = isRecord(usage) && isRecord(usage.input_token_details) ? usage.input_token_details : {};
    this.hooks.model(
      session,
      name,
      isRecord(usage) ? { in: count(usage.input_tokens), out: count(usage.output_tokens), cached: count(details.cache_read) } : {},
      this.rootOf(runId),
    );
  }
}

/** The navigation kit as LangChain structured tools, bound to the session's customer. */
/** The tool metadata key `recordTools()` sets: a replay answers the tool from the record. */
export const RECORDED = "niadra_recorded";

/**
 * Your LangChain tools with each call recorded in the turn it runs in, and answered from the record in a replay.
 * `dryRun` names the tools a replay may run for real when the record has no answer. A tool without a function
 * of its own (`func`) is refused: wrap what it calls with `tool()`.
 */
export function recordTools(tools: readonly DynamicStructuredTool[], options: { dryRun?: readonly string[] } = {}): DynamicStructuredTool[] {
  return tools.map((item) => {
    if (typeof item.func !== "function") throw new TypeError(`${item.name} has no function to wrap: wrap what it calls with tool()`);
    const func = recordedTool(item.func) ? item.func : recorded(item.name, item.func, { args: (input: unknown) => input, dryRun: (options.dryRun ?? []).includes(item.name) });
    return new DynamicStructuredTool({
      name: item.name,
      description: item.description,
      schema: item.schema,
      func,
      metadata: { ...(item.metadata ?? {}), [RECORDED]: true },
    });
  });
}

export function niadraTools(session: Session, options: { agentMemory?: AgentMemoryOption } = {}): DynamicStructuredTool[] {
  return new Bridge(session, undefined, options.agentMemory).tools().map(
    (spec) =>
      new DynamicStructuredTool({
        name: spec.name,
        description: spec.description,
        schema: spec.parameters,
        func: async (input: unknown) => spec.execute(isRecord(input) ? input : {}),
      }),
  );
}

/** An AI message's `usage_metadata` as a `ModelUsage`: input tokens include the cached ones. */
export function langchainUsage(message: BaseMessage): ModelUsage | null {
  const usage = (message as { usage_metadata?: unknown }).usage_metadata;
  const metadata = message.response_metadata as Record<string, unknown> | undefined;
  if (!isRecord(usage)) return null;
  const model = [metadata?.model_name, metadata?.model].find((value): value is string => typeof value === "string" && value.length > 0);
  const prompt = count(usage.input_tokens);
  if (!model || prompt === null) return null;
  const details = isRecord(usage.input_token_details) ? usage.input_token_details : {};
  const cached = count(details.cache_read) ?? 0;
  const written = count(details.cache_creation) ?? 0;
  const declared = typeof metadata?.model_provider === "string" ? metadata.model_provider.toLowerCase() : "";
  const provider = /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(declared) ? declared : providerOf(model, usage);
  return { provider, model, prompt_tokens: Math.max(prompt, cached + written), cached_tokens: cached, cache_write_tokens: written };
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID.test(value);
}

function parsed(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function lastHumanIndex(messages: readonly BaseMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.type === "human") return index;
  return -1;
}

function withSuffix(message: BaseMessage, suffix: string): BaseMessage {
  const content = message.content;
  const next = typeof content === "string" ? `${content}\n\n${suffix}` : [...content, { type: "text", text: suffix }];
  return new HumanMessage({ ...(message.id ? { id: message.id } : {}), content: next });
}
