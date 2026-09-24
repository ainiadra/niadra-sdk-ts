/**
 * Reads what a model provider reported for one call: every input token, the ones read from the
 * provider's prompt cache and the ones written to it.
 *
 * Two shapes are understood, from the response or its `usage` (plain objects or class instances):
 *
 * - OpenAI chat completions and compatible gateways: `usage.prompt_tokens` (cached tokens included)
 *   and `usage.prompt_tokens_details.cached_tokens`; the Responses API's `input_tokens` with
 *   `input_tokens_details.cached_tokens` too. Gateways that pass Anthropic's cache fields through
 *   (`cache_read_input_tokens`, `cache_creation_input_tokens`) are read as well.
 * - Anthropic messages: `usage.input_tokens` counts only the uncached rest, so the prompt is
 *   `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
 *
 * Nothing here throws: a response without usage gives `null`.
 */

import type { ModelUsage } from "./types/events.js";

type Bag = Record<PropertyKey, unknown>;

const PROVIDER = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}$/;

function get(value: unknown, name: string): unknown {
  return (typeof value === "object" || typeof value === "function") && value !== null
    ? (value as Bag)[name]
    : undefined;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** `prompt_tokens`, `cached_tokens` and `cache_write_tokens` from a provider's usage, or `null`. */
export function tokenCounts(
  usage: unknown,
): Pick<ModelUsage, "prompt_tokens" | "cached_tokens" | "cache_write_tokens"> | null {
  const read = count(get(usage, "cache_read_input_tokens")) ?? 0;
  const written = count(get(usage, "cache_creation_input_tokens")) ?? 0;
  let prompt = count(get(usage, "prompt_tokens"));
  let cached: number;
  if (prompt !== null) {
    const reported = count(get(get(usage, "prompt_tokens_details"), "cached_tokens"));
    cached = reported !== null && reported > 0 ? reported : read;
  } else {
    const inputs = count(get(usage, "input_tokens"));
    if (inputs === null) return null;
    const details = get(usage, "input_tokens_details");
    if (details !== undefined && details !== null) {
      // The Responses API counts cached tokens inside `input_tokens`, as chat completions do.
      prompt = inputs;
      cached = count(get(details, "cached_tokens")) ?? 0;
    } else {
      prompt = inputs + read + written;
      cached = read;
    }
  }
  // A gateway can report a cache that does not fit its own prompt count; the prompt is at least that.
  return { prompt_tokens: Math.max(prompt, cached + written), cached_tokens: cached, cache_write_tokens: written };
}

/**
 * Who served the call: the router prefix of `vendor/model` names, else what the name or the usage
 * shape says, else `openai` (the client `wrap()` takes).
 */
export function providerOf(model: string, usage?: unknown): string {
  const slash = model.indexOf("/");
  if (slash > 0) return model.slice(0, slash).trim().toLowerCase();
  const name = model.trim().toLowerCase();
  if (name.startsWith("claude") || `.${name}`.includes(".anthropic.")) return "anthropic";
  if (name.startsWith("gemini")) return "google";
  if (get(usage, "prompt_tokens") === undefined && get(usage, "cache_read_input_tokens") !== undefined) {
    return "anthropic";
  }
  return "openai";
}

/**
 * The usage of an OpenAI or Anthropic response (or of its bare `usage`, with `options.model`), for
 * the agent's turn: `convo.agent(text, { usage: modelUsage(response) })`. `null` without usage.
 */
export function modelUsage(
  response: unknown,
  options: { provider?: string; model?: string } = {},
): ModelUsage | null {
  try {
    let usage = get(response, "usage");
    if (usage === undefined || usage === null || typeof usage !== "object") usage = response;
    const counts = tokenCounts(usage);
    const name = options.model ?? get(response, "model");
    if (!counts || typeof name !== "string" || !MODEL.test(name)) return null;
    const provider = (options.provider ?? providerOf(name, usage)).toLowerCase();
    if (!PROVIDER.test(provider)) return null;
    return { provider, model: name, ...counts };
  } catch {
    return null;
  }
}

/** A `ModelUsage` as given, or read from a provider's response; `null` when neither works. */
export function asModelUsage(value: unknown): ModelUsage | null {
  if (value === undefined || value === null) return null;
  if (isModelUsage(value)) return value;
  return modelUsage(value);
}

/** A `ModelUsage` the server accepts as it is; anything else is read like a provider's usage. */
function isModelUsage(value: unknown): value is ModelUsage {
  const provider = get(value, "provider");
  const model = get(value, "model");
  const prompt = count(get(value, "prompt_tokens"));
  const cached = get(value, "cached_tokens") === undefined ? 0 : count(get(value, "cached_tokens"));
  const written = get(value, "cache_write_tokens") === undefined ? 0 : count(get(value, "cache_write_tokens"));
  return (
    typeof provider === "string" &&
    PROVIDER.test(provider) &&
    typeof model === "string" &&
    MODEL.test(model) &&
    prompt !== null &&
    cached !== null &&
    written !== null &&
    cached + written <= prompt
  );
}
