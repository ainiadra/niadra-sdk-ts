/**
 * Niadra for Amazon Bedrock's Converse API (`@aws-sdk/client-bedrock-runtime`), as `wrap()` is for
 * OpenAI. Each `ConverseCommand` and `ConverseStreamCommand` sent through the wrapped client gets
 * the agent's notes and the customer's pack as one more `system` block, the suffix as a text
 * block at the end of the last user message, the newest user text recorded as the customer's
 * turn, and the answer recorded as the agent's with Bedrock's `usage` (`inputTokens`,
 * `cacheReadInputTokens`, `cacheWriteInputTokens`). Every other command passes through untouched.
 * Nothing here can fail the model call.
 *
 * @example
 * const bedrock = wrapBedrock(new BedrockRuntimeClient({ region }), convo);
 * const response = await bedrock.send(new ConverseCommand({ modelId, system, messages }));
 */

import type { ModelUsage } from "../types/events.js";
import { States, isAsyncIterable, isBag, observeStream, overlay, property } from "./intercept.js";
import type { CallState, WrapOptions } from "./intercept.js";
import type { Read, SessionResolver } from "./shared.js";
import { count, errorName } from "./shared.js";

export { attestationProof } from "./shared.js";
export type { AgentMemoryOption, Proof, ProofSource, Session, SessionResolver } from "./shared.js";
export type { WrapOptions } from "./intercept.js";

type Input = Record<string, unknown>;
type Send = (command: unknown, ...rest: unknown[]) => Promise<unknown>;

/** A proxy of a `BedrockRuntimeClient` whose Converse commands carry the context and record the turns. */
export function wrapBedrock<C extends object>(client: C, session: SessionResolver, options: WrapOptions = {}): C {
  const original = property(client, "send");
  if (typeof original !== "function") throw new TypeError("wrapBedrock() expects a BedrockRuntimeClient");
  const send = (original as Send).bind(client);
  const states = new States(options);
  return overlay(client, {
    send: async (command: unknown, ...rest: unknown[]): Promise<unknown> => {
      const input = property(command, "input");
      const state = isConverse(input) ? states.resolve(session) : null;
      if (!state || !isBag(input) || !isBag(command)) return send(command, ...rest);
      const prepared = await prepare(state, states, input);
      const Command = command.constructor as new (input: Input) => unknown;
      const response = await send(prepared === input ? command : new Command(prepared), ...rest);
      return finish(state, states, response, typeof input.modelId === "string" ? input.modelId : "");
    },
  });
}

/** Bedrock's `usage` as a `ModelUsage`: `inputTokens` counts only the uncached rest, as Anthropic's does. */
export function bedrockUsage(usage: unknown, modelId: string): ModelUsage | null {
  const input = count(property(usage, "inputTokens"));
  if (input === null || !modelId) return null;
  const read = count(property(usage, "cacheReadInputTokens")) ?? 0;
  const written = count(property(usage, "cacheWriteInputTokens")) ?? 0;
  const model = modelId.replace(/^arn:.*\//, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}$/.test(model)) return null;
  return { provider: "bedrock", model, prompt_tokens: input + read + written, cached_tokens: read, cache_write_tokens: written };
}

function isConverse(input: unknown): boolean {
  return isBag(input) && typeof input.modelId === "string" && Array.isArray(input.messages);
}

async function prepare(state: CallState, states: States, input: Input): Promise<Input> {
  try {
    const messages = input.messages as unknown[];
    const last = lastUserWithText(messages);
    if (last >= 0) states.customer(state, last, textOfBlocks(property(messages[last], "content")));
    const read = await state.bridge.read();
    state.bridge.injected(read.context);
    return read.prefix || read.suffix ? inject(input, messages, read) : input;
  } catch (error) {
    state.bridge.logger.warn(`could not inject context (${errorName(error)})`);
    return input;
  }
}

function inject(input: Input, messages: unknown[], read: Read): Input {
  const next: Input = { ...input };
  if (read.prefix) next.system = [...(Array.isArray(input.system) ? (input.system as unknown[]) : []), { text: read.prefix }];
  if (read.suffix) {
    let index = -1;
    for (let at = messages.length - 1; at >= 0; at--) if (property(messages[at], "role") === "user") { index = at; break; }
    const message = messages[index];
    if (isBag(message)) {
      const copy = [...messages];
      const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
      copy[index] = { ...message, content: [...content, { text: read.suffix }] };
      next.messages = copy;
    }
  }
  return next;
}

function finish(state: CallState, states: States, response: unknown, modelId: string): unknown {
  if (!states.recordsAgent) return response;
  try {
    const stream = property(response, "stream");
    if (isAsyncIterable(stream) && isBag(response)) {
      const parts: string[] = [];
      let usage: unknown = null;
      response.stream = observeStream(
        stream,
        (event) => {
          const text = property(property(property(event, "contentBlockDelta"), "delta"), "text");
          if (typeof text === "string") parts.push(text);
          const metadata = property(event, "metadata");
          if (property(metadata, "usage")) usage = property(metadata, "usage");
        },
        () => {
          const reported = bedrockUsage(usage, modelId);
          state.bridge.agent(parts.join(""), reported ? { usage: reported } : {});
        },
        state.bridge.logger,
      );
      return response;
    }
    const content = property(property(property(response, "output"), "message"), "content");
    const reported = bedrockUsage(property(response, "usage"), modelId);
    state.bridge.agent(textOfBlocks(content), reported ? { usage: reported } : {});
  } catch (error) {
    state.bridge.logger.warn(`could not capture the model's answer (${errorName(error)})`);
  }
  return response;
}

function lastUserWithText(messages: unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (property(messages[index], "role") === "user" && textOfBlocks(property(messages[index], "content"))) return index;
  }
  return -1;
}

function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as unknown[])
    .map((block) => (typeof property(block, "text") === "string" ? (property(block, "text") as string) : ""))
    .filter(Boolean)
    .join("\n");
}
