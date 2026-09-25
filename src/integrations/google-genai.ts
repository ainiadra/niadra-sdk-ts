/**
 * Niadra for the Google Gen AI SDK (`@google/genai`), as `wrap()` is for OpenAI.
 *
 * Each `models.generateContent` and `models.generateContentStream` call through the wrapper gets
 * the agent's notes and the customer's pack after your `config.systemInstruction`, the suffix as a
 * part at the end of the last user content, the newest user text recorded as the customer's turn,
 * and the answer recorded as the agent's with `usageMetadata` (`promptTokenCount`, with the
 * `cachedContentTokenCount` read from the context cache) as its usage. Nothing here can fail the
 * model call.
 *
 * @example
 * const ai = wrapGoogleGenAI(new GoogleGenAI({}), convo);
 * const response = await ai.models.generateContent({ model: "gemini-2.5-flash", contents, config: { systemInstruction } });
 */

import type { ModelUsage } from "../types/events.js";
import { States, isAsyncIterable, isBag, observeStream, overlay, property } from "./intercept.js";
import type { CallState, WrapOptions } from "./intercept.js";
import type { Read, SessionResolver } from "./shared.js";
import { count, errorName } from "./shared.js";

export { attestationProof } from "./shared.js";
export type { AgentMemoryOption, Proof, ProofSource, Session, SessionResolver } from "./shared.js";
export type { WrapOptions } from "./intercept.js";

type Params = Record<string, unknown>;
type Method = (...args: unknown[]) => Promise<unknown>;

/** A proxy of a `GoogleGenAI` client whose `models` calls carry the context and record the turns. */
export function wrapGoogleGenAI<C extends object>(client: C, session: SessionResolver, options: WrapOptions = {}): C {
  const models = property(client, "models");
  if (!isBag(models) || typeof models.generateContent !== "function") {
    throw new TypeError("wrapGoogleGenAI() expects a GoogleGenAI client with models.generateContent");
  }
  const states = new States(options);
  const overrides: Record<string, unknown> = {};
  for (const name of ["generateContent", "generateContentStream"] as const) {
    const original = models[name];
    if (typeof original !== "function") continue;
    const call = (original as Method).bind(models);
    overrides[name] = async (params: unknown, ...rest: unknown[]): Promise<unknown> => {
      const state = states.resolve(session);
      if (!state || !isBag(params)) return call(params, ...rest);
      const prepared = await prepare(state, states, params);
      const result = await call(prepared, ...rest);
      return finish(state, states, result, name === "generateContentStream", typeof params.model === "string" ? params.model : "");
    };
  }
  return overlay(client, { models: overlay(models, overrides) });
}

/** `usageMetadata` as a `ModelUsage`: the prompt count already includes the cached tokens. */
export function googleUsage(response: unknown, model: string): ModelUsage | null {
  const usage = property(response, "usageMetadata");
  const prompt = count(property(usage, "promptTokenCount"));
  const version = property(response, "modelVersion");
  const name = (typeof version === "string" && version ? version : model).replace(/^models\//, "");
  if (prompt === null || !name) return null;
  const cached = count(property(usage, "cachedContentTokenCount")) ?? 0;
  return { provider: "google", model: name, prompt_tokens: Math.max(prompt, cached), cached_tokens: cached, cache_write_tokens: 0 };
}

async function prepare(state: CallState, states: States, params: Params): Promise<Params> {
  try {
    const contents = normalize(params.contents);
    const last = lastUserWithText(contents);
    if (last >= 0) states.customer(state, last, textOfParts(property(contents[last], "parts")));
    const read = await state.bridge.read();
    state.bridge.injected(read.context);
    return inject(params, contents, read);
  } catch (error) {
    state.bridge.logger.warn(`could not inject context (${errorName(error)})`);
    return params;
  }
}

function inject(params: Params, contents: Params[], read: Read): Params {
  const next: Params = { ...params };
  if (read.prefix) {
    const config = isBag(params.config) ? { ...params.config } : {};
    const system = config.systemInstruction;
    if (system === undefined || system === null || system === "") config.systemInstruction = read.prefix;
    else if (typeof system === "string") config.systemInstruction = `${system}\n\n${read.prefix}`;
    else if (isBag(system) && Array.isArray(system.parts)) config.systemInstruction = { ...system, parts: [...(system.parts as unknown[]), { text: read.prefix }] };
    else if (Array.isArray(system)) config.systemInstruction = [...(system as unknown[]), { text: read.prefix }];
    next.config = config;
  }
  if (read.suffix) {
    let index = -1;
    for (let at = contents.length - 1; at >= 0; at--) if ((contents[at]?.role ?? "user") === "user") { index = at; break; }
    const content = contents[index];
    if (content) {
      const copy = [...contents];
      copy[index] = { ...content, parts: [...(Array.isArray(content.parts) ? (content.parts as unknown[]) : []), { text: read.suffix }] };
      next.contents = copy;
    }
  }
  return next;
}

function finish(state: CallState, states: States, result: unknown, stream: boolean, model: string): unknown {
  if (!states.recordsAgent) return result;
  try {
    if (!stream) {
      const usage = googleUsage(result, model);
      state.bridge.agent(textOf(result), usage ? { usage } : {});
      return result;
    }
    if (!isAsyncIterable(result)) return result;
    const parts: string[] = [];
    let last: unknown = null;
    return observeStream(
      result,
      (chunk) => {
        parts.push(textOf(chunk));
        if (property(chunk, "usageMetadata")) last = chunk;
      },
      () => {
        const usage = last ? googleUsage(last, model) : null;
        state.bridge.agent(parts.join(""), usage ? { usage } : {});
      },
      state.bridge.logger,
    );
  } catch (error) {
    state.bridge.logger.warn(`could not capture the model's answer (${errorName(error)})`);
    return result;
  }
}

/** `contents` as a list of `{ role, parts }`, whatever form the caller used. */
function normalize(contents: unknown): Params[] {
  const asContent = (value: unknown): Params | null => {
    if (typeof value === "string") return { role: "user", parts: [{ text: value }] };
    if (isBag(value) && Array.isArray(value.parts)) return value;
    if (isBag(value) && typeof value.text === "string") return { role: "user", parts: [value] };
    return null;
  };
  if (!Array.isArray(contents)) {
    const single = asContent(contents);
    return single ? [single] : [];
  }
  const list = contents as unknown[];
  // A list of parts (strings or `{ text }`) is one user content.
  if (list.every((item) => typeof item === "string" || (isBag(item) && !Array.isArray(item.parts)))) {
    return [{ role: "user", parts: list.map((item) => (typeof item === "string" ? { text: item } : item)) }];
  }
  return list.map(asContent).filter((item): item is Params => item !== null);
}

function lastUserWithText(contents: Params[]): number {
  for (let index = contents.length - 1; index >= 0; index--) {
    const content = contents[index];
    if ((content?.role ?? "user") === "user" && textOfParts(content?.parts)) return index;
  }
  return -1;
}

function textOfParts(parts: unknown, separator = "\n"): string {
  if (!Array.isArray(parts)) return "";
  return (parts as unknown[])
    .map((part) => (typeof property(part, "text") === "string" && property(part, "thought") !== true ? (property(part, "text") as string) : ""))
    .filter(Boolean)
    .join(separator);
}

/** The first candidate's text, as the SDK's `text` getter reads it. */
function textOf(response: unknown): string {
  const candidates = property(response, "candidates");
  const first = Array.isArray(candidates) ? (candidates as unknown[])[0] : undefined;
  return textOfParts(property(property(first, "content"), "parts"), "");
}
