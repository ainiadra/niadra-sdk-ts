/**
 * Niadra for the Anthropic TypeScript SDK (`@anthropic-ai/sdk`), as `wrap()` is for OpenAI.
 *
 * Each `messages.create` call through the wrapper, streaming or not, gets:
 * - the agent's notes and the customer's pack in `system`, after your own system text (appended to
 *   a string, or as one more text block, with a cache breakpoint only when you already use prompt
 *   caching and a breakpoint is left);
 * - the suffix (deltas and live turns) as a text block at the end of the last user message;
 * - the newest user text recorded as the customer's turn, and the answer as the agent's, with
 *   `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` as its usage.
 *
 * For `messages.stream()`, prepare the body with `anthropicParams()` and record the final message
 * with `recordAnthropic()`. Nothing here can fail the model call.
 *
 * @example
 * const anthropic = wrapAnthropic(new Anthropic(), convo);
 * const message = await anthropic.messages.create({ model: "claude-sonnet-4-5", max_tokens: 1024, system, messages });
 */

import { modelUsage } from "../usage.js";
import { Pending, States, isAsyncIterable, isBag, observeStream, overlay, property } from "./intercept.js";
import type { CallState, WrapOptions } from "./intercept.js";
import type { Read, SessionResolver } from "./shared.js";
import { errorName, resolveSession } from "./shared.js";

export { attestationProof } from "./shared.js";
export type { AgentMemoryOption, Proof, ProofSource, Session, SessionResolver } from "./shared.js";
export type { WrapOptions } from "./intercept.js";

type Body = Record<string, unknown>;
type Block = Record<string, unknown>;

const MAX_BREAKPOINTS = 4;

/** A proxy of an Anthropic client whose `messages.create` carries the context and records the turns. */
export function wrapAnthropic<C extends object>(client: C, session: SessionResolver, options: WrapOptions = {}): C {
  const states = new States(options);
  const overrides: Record<string, unknown> = {};
  const messages = property(client, "messages");
  if (!isBag(messages) || typeof messages.create !== "function") {
    throw new TypeError("wrapAnthropic() expects an Anthropic client with messages.create");
  }
  overrides.messages = overlay(messages, { create: intercept(messages, states, session) });
  const beta = property(client, "beta");
  const betaMessages = property(beta, "messages");
  if (isBag(beta) && isBag(betaMessages) && typeof betaMessages.create === "function") {
    overrides.beta = overlay(beta, { messages: overlay(betaMessages, { create: intercept(betaMessages, states, session) }) });
  }
  return overlay(client, overrides);
}

/**
 * The body with the context in place, for `messages.stream()` or any call the wrapper does not
 * see. Records the newest user text. Never rejects: on failure the body comes back as it was.
 */
export async function anthropicParams<B extends object>(session: SessionResolver, body: B, options: WrapOptions = {}): Promise<B> {
  const state = helperStates.resolve(session, options);
  return state ? ((await prepare(state, helperStates, body as Body)) as B) : body;
}

/** The helpers' state per session, so a customer message is recorded once across calls. */
const helperStates = new States({});

/** Records a final Anthropic message as the agent's turn, with its usage. */
export function recordAnthropic(session: SessionResolver, message: unknown): void {
  const current = resolveSession(session);
  if (!current) return;
  try {
    const text = textOfBlocks(property(message, "content"));
    const usage = modelUsage(message);
    if (text) current.agent(text, usage ? { usage } : {});
  } catch (error) {
    current.logger.warn(`could not record the model's answer (${errorName(error)})`);
  }
}

function intercept(messages: Record<PropertyKey, unknown>, states: States, session: SessionResolver) {
  const create = (messages.create as (...args: unknown[]) => unknown).bind(messages);
  return (body: unknown, ...rest: unknown[]): unknown => {
    const state = states.resolve(session);
    if (!state || !isBag(body)) return create(body, ...rest);
    const started = prepare(state, states, body).then((prepared) => ({ call: create(prepared, ...rest) }));
    return new Pending(started, (value) => finish(state, states, value, body.stream === true));
  };
}

async function prepare(state: CallState, states: States, body: Body): Promise<Body> {
  try {
    const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : null;
    if (!messages) return body;
    const last = lastUserWithText(messages);
    if (last >= 0) states.customer(state, last, textOfContent(property(messages[last], "content")));
    const read = await state.bridge.read();
    state.bridge.injected(read.context);
    return inject(body, messages, read);
  } catch (error) {
    state.bridge.logger.warn(`could not inject context (${errorName(error)})`);
    return body;
  }
}

function inject(body: Body, messages: unknown[], read: Read): Body {
  const next: Body = { ...body };
  if (read.prefix) {
    const system = body.system;
    if (system === undefined || system === null || system === "") next.system = read.prefix;
    else if (typeof system === "string") next.system = `${system}\n\n${read.prefix}`;
    else if (Array.isArray(system)) {
      const block: Block = { type: "text", text: read.prefix };
      if (breakpoints(body) > 0 && breakpoints(body) < MAX_BREAKPOINTS) block.cache_control = { type: "ephemeral" };
      next.system = [...(system as unknown[]), block];
    }
  }
  if (read.suffix) {
    const index = lastIndexOfRole(messages, "user");
    const message = messages[index];
    if (isBag(message)) {
      const content = message.content;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? [...(content as unknown[])] : [];
      const copy = [...messages];
      copy[index] = { ...message, content: [...blocks, { type: "text", text: read.suffix }] };
      next.messages = copy;
    }
  }
  return next;
}

function finish(state: CallState, states: States, value: unknown, stream: boolean): unknown {
  if (!states.recordsAgent) return value;
  try {
    if (!stream) {
      const text = textOfBlocks(property(value, "content"));
      const usage = modelUsage(value);
      state.bridge.agent(text, usage ? { usage } : {});
      return value;
    }
    if (!isAsyncIterable(value)) return value;
    const parts: string[] = [];
    let start: unknown = null;
    return observeStream(
      value,
      (event) => {
        const type = property(event, "type");
        if (type === "message_start") start = property(event, "message");
        else if (type === "content_block_delta") {
          const delta = property(event, "delta");
          if (property(delta, "type") === "text_delta" && typeof property(delta, "text") === "string") parts.push(property(delta, "text") as string);
        }
      },
      () => {
        const usage = start ? modelUsage(start) : null;
        state.bridge.agent(parts.join(""), usage ? { usage } : {});
      },
      state.bridge.logger,
    );
  } catch (error) {
    state.bridge.logger.warn(`could not capture the model's answer (${errorName(error)})`);
    return value;
  }
}

/** How many cache breakpoints the body already sets, in `system`, `messages` and `tools`. */
function breakpoints(body: Body): number {
  let total = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) for (const item of value as unknown[]) visit(item);
    else if (isBag(value)) {
      if (isBag(value.cache_control)) total++;
      if (Array.isArray(value.content)) visit(value.content);
    }
  };
  visit(body.system);
  visit(body.messages);
  visit(body.tools);
  return total;
}

function lastUserWithText(messages: unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (property(messages[index], "role") === "user" && textOfContent(property(messages[index], "content"))) return index;
  }
  return -1;
}

function lastIndexOfRole(messages: unknown[], role: string): number {
  for (let index = messages.length - 1; index >= 0; index--) if (property(messages[index], "role") === role) return index;
  return -1;
}

function textOfContent(content: unknown): string {
  return typeof content === "string" ? content : textOfBlocks(content);
}

function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as unknown[])
    .map((block) => (property(block, "type") === "text" && typeof property(block, "text") === "string" ? (property(block, "text") as string) : ""))
    .filter(Boolean)
    .join("\n");
}
