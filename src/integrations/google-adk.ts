/**
 * Niadra for the Agent Development Kit for TypeScript (`@google/adk` 2.x): model callbacks and the
 * navigation kit as ADK tools, for one agent definition that serves every ADK session.
 *
 * `niadraAdk({ session })` finds the Niadra session of each ADK session once (by its session id)
 * and returns:
 *
 * - `beforeModelCallback`: records the user's message of each invocation once, adds the agent's notes and
 *   the customer's pack after your instruction in `config.systemInstruction`, and the suffix
 *   (deltas and live turns) as a text part of the last user content. ADK builds the request from
 *   the session's events on every call, so nothing of it lands in the session.
 * - `afterModelCallback`: records the final answer with `usageMetadata`, and `transfer_to_agent`
 *   as a handoff between agents. Partial (streamed) responses and tool calls record nothing.
 * - `tools`: the kit as ADK tools with the canonical JSON Schemas. Each call finds its customer from
 *   the tool's context, never from the model's arguments.
 *
 * Fail-open: when Niadra is slow or down, the request goes to the model as ADK built it.
 *
 * @example
 * import { LlmAgent, InMemoryRunner } from "@google/adk";
 * import { niadraAdk } from "@niadra/sdk/google-adk";
 *
 * const memory = niadraAdk({
 *   session: (context) => niadra.conversation({ subject: handles.appUserId(context.userId), channel: "web_chat", conversation_id: context.sessionId }),
 * });
 * // `...memory` sets `tools`, `beforeModelCallback` and `afterModelCallback`; give the same to sub-agents.
 * const support = new LlmAgent({ name: "support", model: "gemini-2.5-flash", instruction: "You are Acme's support agent.", ...memory });
 */

import { BaseTool } from "@google/adk";
import type { Context, LlmRequest, LlmResponse, ReadonlyContext, RunAsyncToolRequest } from "@google/adk";
import { AGENT_MEMORY_TOOL_DEFINITIONS, TOOL_DEFINITIONS } from "../tools.js";
import type { ModelUsage } from "../types/events.js";
import { providerOf } from "../usage.js";
import { Bridge, count, errorName, isRecord } from "./shared.js";
import type { AgentMemoryOption, ProofSource, Session } from "./shared.js";

export { attestationProof } from "./shared.js";
export type { AgentMemoryOption, Proof, ProofSource, Session } from "./shared.js";

export interface NiadraAdkOptions {
  /**
   * The Niadra session of an ADK session: a fixed conversation or task, or a function of the
   * callback context (`userId`, `sessionId`, `state`), called once per ADK session id.
   */
  session: Session | ((context: ReadonlyContext) => Session | null | undefined);
  /** What your app proved about the user, recorded once per session before the first context read. */
  verify?: ProofSource;
  /** Records the newest user message as the customer's turn. Defaults to `true`. */
  recordCustomer?: boolean;
  /** Records the final answer as the agent's turn. Defaults to `true`. */
  recordAgent?: boolean;
  /** Puts the agent's own notes before the customer's context, and adds its memory tools. */
  agentMemory?: AgentMemoryOption;
}

type BeforeModel = (params: { context: Context; request: LlmRequest }) => Promise<LlmResponse | undefined>;
type AfterModel = (params: { context: Context; response: LlmResponse }) => Promise<LlmResponse | undefined>;

export interface NiadraAdk {
  beforeModelCallback: BeforeModel;
  afterModelCallback: AfterModel;
  /** The navigation kit as ADK tools. */
  tools: BaseTool[];
}

interface State {
  bridge: Bridge;
  seen: Set<string>;
  model: string;
}

const MAX_SESSIONS = 10_000;

/** The callbacks and tools for one ADK agent, sharing one Niadra session per ADK session. */
export function niadraAdk(options: NiadraAdkOptions): NiadraAdk {
  const bySession = new Map<string, State | null>();
  const fixed = typeof options.session === "function" ? null : newState(options.session, options);

  const stateOf = (context: ReadonlyContext): State | null => {
    if (fixed) return fixed;
    const resolve = options.session as (context: ReadonlyContext) => Session | null | undefined;
    const key = context.sessionId;
    if (bySession.has(key)) return bySession.get(key) ?? null;
    let state: State | null;
    try {
      const session = resolve(context);
      state = session ? newState(session, options) : null;
    } catch {
      state = null;
    }
    bySession.set(key, state);
    if (bySession.size > MAX_SESSIONS) {
      const oldest = bySession.keys().next().value;
      if (oldest !== undefined) bySession.delete(oldest);
    }
    return state;
  };

  const beforeModelCallback: BeforeModel = async ({ context, request }) => {
    const state = stateOf(context);
    if (!state) return undefined;
    state.model = request.model ?? state.model;
    try {
      const contents = request.contents;
      // One customer turn per invocation: the user's message that started it, whatever agent answers.
      const said = textOfParts(context.userContent?.parts);
      if ((options.recordCustomer ?? true) && said && !state.seen.has(context.invocationId)) {
        state.seen.add(context.invocationId);
        if (state.seen.size > MAX_SESSIONS) state.seen.clear();
        state.bridge.customer(said);
      }
      const read = await state.bridge.read();
      state.bridge.injected(read.context);
      if (read.prefix) {
        const config = (request.config ??= {});
        const system = config.systemInstruction;
        if (system === undefined || system === "") config.systemInstruction = read.prefix;
        else if (typeof system === "string") config.systemInstruction = `${system}\n\n${read.prefix}`;
        else if (isRecord(system) && Array.isArray(system.parts)) config.systemInstruction = { ...system, parts: [...(system.parts as unknown[]), { text: read.prefix }] } as typeof system;
        else if (Array.isArray(system)) config.systemInstruction = [...(system as unknown[]), { text: read.prefix }] as typeof system;
      }
      if (read.suffix) {
        for (let index = contents.length - 1; index >= 0; index--) {
          const content = contents[index];
          if (!content || (content.role ?? "user") !== "user" || !textOfParts(content.parts)) continue;
          contents[index] = { ...content, parts: [...(content.parts ?? []), { text: read.suffix }] };
          break;
        }
      }
    } catch (error) {
      state.bridge.logger.warn(`could not inject context (${errorName(error)})`);
    }
    return undefined;
  };

  const afterModelCallback: AfterModel = async ({ context, response }) => {
    const state = stateOf(context);
    if (!state || response.partial === true) return undefined;
    try {
      const parts = response.content?.parts ?? [];
      const transfer = parts.find((part) => part.functionCall?.name === "transfer_to_agent")?.functionCall;
      if (transfer) {
        const target = isRecord(transfer.args) && typeof transfer.args.agent_name === "string" ? transfer.args.agent_name : undefined;
        await state.bridge.handoff("agent", target ? `${context.agentName} to ${target}` : undefined);
        return undefined;
      }
      if (!(options.recordAgent ?? true) || parts.some((part) => part.functionCall)) return undefined;
      const text = textOfParts(parts, "");
      if (!text) return undefined;
      const usage = adkUsage(response, state.model);
      state.bridge.agent(text, usage ? { usage } : {});
    } catch (error) {
      state.bridge.logger.warn(`could not record the agent's answer (${errorName(error)})`);
    }
    return undefined;
  };

  const memory = options.agentMemory;
  const definitions = [
    ...TOOL_DEFINITIONS,
    ...(memory ? AGENT_MEMORY_TOOL_DEFINITIONS.slice(0, memory !== true && memory.write ? 2 : 1) : []),
  ];
  const tools = definitions.map(({ function: definition }) => new NiadraTool(definition, (context) => stateOf(context)));
  return { beforeModelCallback, afterModelCallback, tools };
}

/** `usageMetadata` of an ADK response as a `ModelUsage`: the prompt count includes the cached tokens. */
export function adkUsage(response: LlmResponse, model: string): ModelUsage | null {
  const usage = response.usageMetadata;
  const prompt = count(usage?.promptTokenCount);
  const name = (response.modelVersion ?? model).replace(/^models\//, "");
  if (prompt === null || !name) return null;
  const cached = count(usage?.cachedContentTokenCount) ?? 0;
  return { provider: providerOf(name), model: name, prompt_tokens: Math.max(prompt, cached), cached_tokens: cached, cache_write_tokens: 0 };
}

/** One tool of the kit. The declaration is the canonical one; the customer comes from the tool's context. */
class NiadraTool extends BaseTool {
  constructor(
    private readonly definition: (typeof TOOL_DEFINITIONS)[number]["function"],
    private readonly stateOf: (context: ReadonlyContext) => State | null,
  ) {
    super({ name: definition.name, description: definition.description });
  }

  override _getDeclaration() {
    return { name: this.definition.name, description: this.definition.description, parametersJsonSchema: this.definition.parameters };
  }

  async runAsync({ args, toolContext }: RunAsyncToolRequest): Promise<unknown> {
    const state = this.stateOf(toolContext);
    const spec = state?.bridge.tools().find((candidate) => candidate.name === this.name);
    if (!spec) return { error: "unavailable", detail: "customer history is unavailable right now" };
    const text = await spec.execute(args);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { result: text };
    }
  }
}

function newState(session: Session, options: NiadraAdkOptions): State {
  return { bridge: new Bridge(session, options.verify, options.agentMemory), seen: new Set(), model: "" };
}

function textOfParts(parts: unknown, separator = "\n"): string {
  if (!Array.isArray(parts)) return "";
  return (parts as unknown[])
    .map((part) => (isRecord(part) && typeof part.text === "string" && part.thought !== true ? part.text : ""))
    .filter(Boolean)
    .join(separator);
}
