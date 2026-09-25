/**
 * Niadra for the OpenAI Agents SDK for JavaScript (`@openai/agents` 0.18).
 *
 * - `NiadraSession` is a `Session` for `run(agent, input, { session })`: it keeps the run's items
 *   in the session you give it (a `MemorySession` by default) and records what the customer said
 *   and what the agent answered as turns, the same way on every run.
 * - `niadraInstructions(base, conversation)` makes the agent's instructions dynamic: your text,
 *   then the agent's notes and the customer's pack, then the suffix.
 * - `niadraTools(conversation)` is the navigation kit as function tools bound to the customer.
 * - `niadraRunHooks(runner, conversation)` records handoffs between agents.
 *
 * Fail-open: when Niadra is slow or down, the instructions are yours alone and the run goes on.
 */

import { MemorySession, tool } from "@openai/agents";
import type { Agent, AgentInputItem, FunctionTool, RunContext, Runner, Session as AgentsSession } from "@openai/agents";
import type { Conversation } from "../conversation.js";
import { Bridge, isRecord } from "./shared.js";
import type { AgentMemoryOption, ProofSource, Session } from "./shared.js";

export { attestationProof } from "./shared.js";
export type { AgentMemoryOption, Proof, ProofSource, Session } from "./shared.js";

export interface NiadraSessionOptions {
  /** Where the run's items live. Defaults to a new `MemorySession`. */
  inner?: AgentsSession;
  /** Records what the customer said. Defaults to `true`. */
  recordCustomer?: boolean;
  /** Records what the agent answered. Defaults to `true`. */
  recordAgent?: boolean;
}

/**
 * A `Session` that records the conversation's turns in Niadra while another session keeps the
 * run's items. Pass it to `run()`: `run(agent, input, { session: new NiadraSession(convo) })`.
 */
export class NiadraSession implements AgentsSession {
  private readonly inner: AgentsSession;
  private readonly bridge: Bridge;

  constructor(
    readonly conversation: Session,
    private readonly options: NiadraSessionOptions = {},
  ) {
    this.inner = options.inner ?? new MemorySession({ sessionId: conversation.id });
    this.bridge = new Bridge(conversation);
  }

  getSessionId(): Promise<string> {
    return this.inner.getSessionId();
  }

  getItems(limit?: number): Promise<AgentInputItem[]> {
    return this.inner.getItems(limit);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    await this.inner.addItems(items);
    for (const item of items as unknown[]) {
      if (!isRecord(item)) continue;
      if (item.role === "user" && (this.options.recordCustomer ?? true)) this.bridge.customer(textOf(item.content));
      if (item.role === "assistant" && (this.options.recordAgent ?? true)) this.bridge.agent(textOf(item.content));
    }
  }

  popItem(): Promise<AgentInputItem | undefined> {
    return this.inner.popItem();
  }

  clearSession(): Promise<void> {
    return this.inner.clearSession();
  }
}

export interface NiadraInstructionsOptions {
  /** What your app proved about the user, recorded once before the first context read. */
  verify?: ProofSource;
  /** Puts the agent's own notes before the customer's context. Pass the same to `niadraTools`. */
  agentMemory?: AgentMemoryOption;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the same shape as the SDK's own `instructions`,
   which takes an agent of any context and output type. */
type InstructionsFunction = (runContext: RunContext<any>, agent: Agent<any, any>) => string | Promise<string>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Dynamic instructions: your text, then the agent's notes and the customer's pack, then the
 * suffix. The Agents SDK builds the system prompt from the instructions alone, so the suffix
 * closes it rather than the input. Use as `new Agent({ instructions: niadraInstructions(...) })`.
 */
export function niadraInstructions(
  base: string | InstructionsFunction,
  session: Session,
  options: NiadraInstructionsOptions = {},
): (...args: Parameters<InstructionsFunction>) => Promise<string> {
  const bridge = new Bridge(session, options.verify, options.agentMemory);
  return async (runContext, agent) => {
    const own = typeof base === "function" ? await base(runContext, agent) : base;
    const read = await bridge.read();
    bridge.injected(read.context);
    return [own, read.prefix, read.suffix].filter(Boolean).join("\n\n");
  };
}

/** The navigation kit as Agents SDK function tools, bound to the session's customer. */
export function niadraTools(session: Session, options: { agentMemory?: AgentMemoryOption } = {}): FunctionTool[] {
  return new Bridge(session, undefined, options.agentMemory).tools().map((spec) =>
    tool({
      name: spec.name,
      description: spec.description,
      // The canonical schemas have optional fields, so the tool is not strict.
      parameters: spec.parameters as never,
      strict: false,
      execute: async (input: unknown) => spec.execute(isRecord(input) ? input : {}),
    }) as unknown as FunctionTool,
  );
}

/**
 * Records each handoff between agents of a run as a handoff to another agent. Returns a function
 * that stops listening.
 */
export function niadraRunHooks(runner: Runner, conversation: Conversation): () => void {
  const bridge = new Bridge(conversation);
  const onHandoff = (_context: unknown, from: { name: string }, to: { name: string }): void => {
    void bridge.handoff("agent", `${from.name} to ${to.name}`);
  };
  runner.on("agent_handoff", onHandoff);
  return () => {
    runner.off("agent_handoff", onHandoff);
  };
}

/** The text of a user or assistant item: a string, or its `input_text` and `output_text` parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as unknown[])
    .map((part) => (isRecord(part) && (part.type === "input_text" || part.type === "output_text") && typeof part.text === "string" ? part.text : ""))
    .join("");
}
