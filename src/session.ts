import { renderSuffix } from "./context.js";
import { isUnpinned } from "./turns.js";
import type { ContextResult } from "./context.js";
import type { ContextResponse } from "./types/context.js";
import type { ContextStamp, SpeakerRef } from "./types/events.js";
import type { Speaker } from "./types/vocabulary.js";

/** Bounds the suffix of a very long conversation; the oldest deltas go first. */
const MAX_DELTAS = 20;

/** When context first went into the prompt, and when the agent first spoke. */
export interface Timings {
  contextInjectedAt: Date | null;
  firstAgentTurnAt: Date | null;
}

/**
 * What a conversation and a task keep between turns: the deltas received against the pack the
 * server pinned for them, and the stamp of the last context that went into the prompt.
 *
 * The server sends each delta once, relative to what this agent last read, so the deltas are
 * kept, in order, for as long as the pack stays the same. A new pack (after a verification,
 * say) already includes them, and so does the delta that arrives with it: both are dropped.
 */
export class SessionState {
  private etag: string | null = null;
  private deltas: string[] = [];
  private stamp: ContextStamp | null = null;
  private firstInjection: Date | null = null;
  private firstAgentTurn: Date | null = null;
  private last: ContextResult | null = null;

  /** After the first pack, every read also asks what changed since. */
  get wantsDelta(): boolean {
    return this.etag !== null;
  }

  get lastContext(): ContextResult | null {
    return this.last;
  }

  get contextStamp(): ContextStamp | null {
    return this.stamp;
  }

  get timings(): Timings {
    return { contextInjectedAt: this.firstInjection, firstAgentTurnAt: this.firstAgentTurn };
  }

  /** Folds one `context()` result into the session and returns it with every delta since the pin. */
  absorb(result: ContextResult): ContextResult {
    // An answer compiled for the turn by a space without memory v2 is not the pinned pack.
    if (isUnpinned(result)) return result;
    const response = result.response;
    if (result.source === "none" || !response) {
      // Nothing is being served, not even the last good pack (a 401 or 403 lands here):
      // deltas mean nothing without the pack they are relative to.
      this.reset();
    } else if (response.etag !== this.etag) {
      this.etag = response.etag;
      this.deltas = [];
    } else if (response.delta && !this.deltas.includes(response.delta)) {
      this.deltas = [...this.deltas, response.delta].slice(-MAX_DELTAS);
    }
    const absorbed = response ? withDeltas(result, response, this.deltas) : result;
    this.last = absorbed;
    return absorbed;
  }

  /** Starts over from the next pack the server pins, as after a raised verification level. */
  reset(): void {
    this.etag = null;
    this.deltas = [];
  }

  markInjected(context: ContextResult | null | undefined, at: Date): void {
    const etag = (context ?? this.last)?.response?.etag;
    this.firstInjection ??= at;
    this.stamp = etag ? { etag, injected_at: at.toISOString() } : { injected_at: at.toISOString() };
  }

  /** Notes an agent turn and returns the stamp it carries, if context went in before it. */
  agentTurn(): ContextStamp | null {
    this.firstAgentTurn ??= new Date();
    return this.stamp;
  }

  /** The stamp for an action, which only the AI agent took on the injected context. */
  actionStamp(speaker: SpeakerRef | Speaker | undefined): ContextStamp | null {
    const role = typeof speaker === "string" ? speaker : (speaker?.role ?? "ai_agent");
    return role === "ai_agent" ? this.stamp : null;
  }
}

function withDeltas(result: ContextResult, response: ContextResponse, deltas: string[]): ContextResult {
  const merged = { ...response, delta: deltas.join("\n\n") || null };
  return { ...result, response: merged, suffix: renderSuffix(merged) };
}
