/**
 * The AI SDK's language model prompt (`LanguageModelV2Prompt` and later), shared by the adapters
 * that see it: the AI SDK middleware and Mastra's processor.
 */

import type { Bridge, Read } from "./shared.js";
import { isRecord } from "./shared.js";

/**
 * The prefix (the agent's notes and the customer's pack) as a system message right after the leading system messages, and the suffix as a text
 * part at the end of the last user message, where every provider accepts it. Returns a new array.
 */
export function injectPrompt(prompt: readonly unknown[], read: Pick<Read, "prefix" | "suffix">): unknown[] {
  const injected = [...prompt];
  if (read.suffix) {
    const last = lastUserIndex(injected);
    const message = injected[last];
    if (isRecord(message) && Array.isArray(message.content)) {
      injected[last] = { ...message, content: [...(message.content as unknown[]), { type: "text", text: read.suffix }] };
    }
  }
  if (read.prefix) {
    let position = 0;
    while (position < injected.length && roleOf(injected[position]) === "system") position++;
    injected.splice(position, 0, { role: "system", content: read.prefix });
  }
  return injected;
}

/**
 * Records the last user message as the customer's turn once, however many steps of a tool loop
 * send the same prompt again. `seen` keeps what was recorded for this session.
 */
export function recordNewest(bridge: Bridge, seen: Set<string>, prompt: readonly unknown[]): void {
  const index = lastUserIndex(prompt);
  if (index < 0) return;
  const message = prompt[index];
  const text = isRecord(message) ? textParts(message.content) : "";
  const key = `${String(index)}:${text}`;
  if (!text || seen.has(key)) return;
  seen.add(key);
  bridge.customer(text);
}

export function textParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as unknown[])
    .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function lastUserIndex(prompt: readonly unknown[]): number {
  for (let index = prompt.length - 1; index >= 0; index--) if (roleOf(prompt[index]) === "user") return index;
  return -1;
}

function roleOf(message: unknown): string {
  return isRecord(message) && typeof message.role === "string" ? message.role : "";
}
