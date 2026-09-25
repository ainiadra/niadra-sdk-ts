/**
 * The agent's own memory on the client side: the block for the prompt with its ETag cache, and
 * the checks of a note before it leaves the process.
 */

import { NiadraValidationError } from "./errors.js";
import type { NiadraError } from "./errors.js";
import type { AgentMemoryBlock, AgentNoteKind, AgentNoteVisibility, Evidence } from "./types/agent-memory.js";
import type { Timestamp } from "./items.js";

/** Arguments of `agentMemory()`. */
export interface AgentMemoryParams {
  /** Token budget of the block. Defaults to 300. */
  max_tokens?: number;
  /** Notes with these tags come first. Up to 8. */
  tags?: string[];
  /** The view or task the agent works in, so notes tagged for it come first. */
  view?: string;
}

/** Where an `agentMemory()` result came from, as for `context()`. */
export type AgentMemorySource = "network" | "cache" | "fallback" | "none";

/** What `agentMemory()` resolves to. Always usable: on failure `text` is empty. */
export interface AgentMemoryResult {
  /** The notes as text for the prompt, after your instructions and before the customer's context. */
  text: string;
  /** The ids of the notes in `text`. */
  notes: string[];
  etag: string | null;
  tokens: number;
  /** `false` when agent memory is off for the space (or not served yet by its cell). */
  enabled: boolean;
  source: AgentMemorySource;
  error: NiadraError | null;
}

/** Arguments of `remember()`: one working note, never about a customer. */
export interface RememberParams {
  kind: AgentNoteKind;
  /** Up to 120 characters. */
  title: string;
  /** Up to 2,000 characters. */
  body: string;
  /** Up to 8, such as `invoice`, `credit`, `erp`. */
  tags?: string[];
  /** The conversation or task it came from: the id only, never its text. */
  evidence?: Evidence | null;
  /** Defaults to `source`: only this agent reads it. */
  visibility?: AgentNoteVisibility;
  valid_until?: Timestamp | null;
}

const TAG = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const KINDS = new Set<string>(["procedure", "tool_note", "process_note", "pitfall"]);

export function checkTags(tags: string[] | undefined): void {
  if (!tags) return;
  if (tags.length > 8) throw new NiadraValidationError("up to 8 tags");
  for (const tag of tags) if (!TAG.test(tag)) throw new NiadraValidationError("tags are lowercase words such as `invoice` or `erp`");
}

export function checkNote(note: RememberParams): void {
  if (!KINDS.has(note.kind)) throw new NiadraValidationError("kind is procedure, tool_note, process_note or pitfall");
  if (!note.title || note.title.length > 120) throw new NiadraValidationError("title must be 1 to 120 characters");
  if (!note.body || note.body.length > 2000) throw new NiadraValidationError("body must be 1 to 2000 characters");
  checkTags(note.tags);
}

export function emptyBlock(error: NiadraError | null, enabled = true): AgentMemoryResult {
  return { text: "", notes: [], etag: null, tokens: 0, enabled, source: "none", error };
}

export function blockResult(block: AgentMemoryBlock, source: AgentMemorySource, error: NiadraError | null = null): AgentMemoryResult {
  return {
    text: block.enabled === false ? "" : block.text,
    notes: block.notes ?? [],
    etag: block.etag,
    tokens: block.tokens ?? 0,
    enabled: block.enabled ?? true,
    source,
    error,
  };
}

interface Entry {
  block: AgentMemoryBlock;
  storedAt: number;
}

/**
 * The last block per request shape. A fresh one is served without a request; an older one is
 * revalidated with its ETag (a 304 costs no text); a failed request falls back to it while it is
 * not too old.
 */
export class AgentMemoryCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxStaleMs: number,
    private readonly maxEntries = 64,
  ) {}

  static key(params: AgentMemoryParams): string {
    return JSON.stringify([params.max_tokens ?? 300, [...(params.tags ?? [])].sort(), params.view ?? null]);
  }

  fresh(key: string, now = Date.now()): AgentMemoryBlock | null {
    const entry = this.entries.get(key);
    return entry && now - entry.storedAt < this.ttlMs ? entry.block : null;
  }

  usable(key: string, now = Date.now()): AgentMemoryBlock | null {
    const entry = this.entries.get(key);
    return entry && now - entry.storedAt < this.maxStaleMs ? entry.block : null;
  }

  etag(key: string): string | null {
    return this.entries.get(key)?.block.etag ?? null;
  }

  store(key: string, block: AgentMemoryBlock, now = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { block, storedAt: now });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** A 304: the cached block is current again. */
  touch(key: string, now = Date.now()): AgentMemoryBlock | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    entry.storedAt = now;
    return entry.block;
  }

  clear(): void {
    this.entries.clear();
  }
}
