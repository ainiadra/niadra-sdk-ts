/**
 * The company's content resolver: in a space whose content Niadra keeps by pointer, the text itself stays in
 * the company's storage, and the SDK puts it back in the agent's process.
 *
 * ```ts
 * niadra.content.register((pointer) => ourBucket.readText(pointer));
 * const context = await conversation.context({ include: ["state"] }); // content fields come back with their text
 * ```
 *
 * A state read marks a content field whose text Niadra does not hold with `content: {mode: "pointer",
 * pointer, sha256, scan}` and no value. With a resolver registered, each such field whose scan is `clean` gets
 * its text from the resolver, which is kept only when its SHA-256 is the one Niadra recorded. Content that is
 * `pending` or `flagged` is never fetched: it does not reach the model. A fetch that fails leaves the field
 * without a value, and the read goes on. The same resolver reads the values a replay runs with, in `pointer`
 * mode.
 */

import type { FieldState, StateView } from "./types/state.js";

export type Fetch = (pointer: string) => Promise<string> | string;

export class ContentResolver {
  private fetchText: Fetch | null = null;

  /** `fetch(pointer)` returns the text the pointer names. */
  register(fetch: Fetch): void {
    this.fetchText = fetch;
  }

  get registered(): boolean {
    return this.fetchText !== null;
  }

  /** The text a pointer names; `null` without a resolver, or when it failed. */
  async read(pointer: string): Promise<string | null> {
    if (this.fetchText === null) return null;
    try {
      return await this.fetchText(pointer);
    } catch {
      return null;
    }
  }

  /** `view` with the text of its clean pointer fields. */
  async fill(view: StateView): Promise<StateView> {
    const objects = [];
    for (const item of view.objects ?? []) {
      const fields: Record<string, FieldState> = {};
      for (const [name, field] of Object.entries(item.fields ?? {})) fields[name] = await this.filled(field);
      objects.push({ ...item, fields });
    }
    return { ...view, objects };
  }

  private async filled(field: FieldState): Promise<FieldState> {
    const marker = field.content;
    if (marker?.mode !== "pointer" || marker.scan !== "clean" || !marker.pointer || field.v != null) return field;
    const text = await this.read(marker.pointer);
    if (text === null) return field;
    if (marker.sha256 && (await hex(text)) !== marker.sha256) return field; // not the text Niadra recorded
    return { ...field, v: text };
  }
}

async function hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
