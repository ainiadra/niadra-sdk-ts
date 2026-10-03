/**
 * The voice read path: a spoken turn never waits on a round trip for what can be known in advance.
 *
 * A read in the `voice` view with a conversation (or task) id, and the cache on, goes through the
 * conversation's `VoiceLine`:
 *
 * - The pinned pack is the same bytes for the whole conversation (the server guarantees it), so
 *   once a read brought it, every later turn gets it from memory at once, whatever its age, and
 *   the SDK revalidates it by ETag in the background.
 * - `begin()` starts the first read when the call starts (ringing, the inbound webhook, the caller
 *   joining the room), so it runs while the call is set up, and `ready()` waits for it there,
 *   within `Timeouts.contextVoiceStart`. A turn that finds it still running waits for it only
 *   within its own budget.
 * - While the customer speaks, `prefetch()` warms the server as before and, once the partial
 *   transcript has stayed the same for `VoiceOptions.settleMs`, reads the turn with it (one such
 *   read in flight per conversation; the newest settled text waits behind it). The slots and the
 *   delta of that read answer the final turn when the final words start with the partial's and
 *   the partial carries at least `VoiceOptions.minCoverage` of them. Otherwise the turn reads its
 *   own words.
 * - A turn waits for the read of its words at most its budget (`Timeouts.contextVoice`). Past it,
 *   the turn gets the pinned body without slots, and the read goes on in the background: its
 *   answer revalidates the body and leaves its delta for the next turn.
 * - The first voice read of a client measures the round trip to the region once (`GET /healthz`,
 *   twice, the faster) and logs a warning when the budgets cannot hold it.
 *
 * What a line keeps is what the server sent for this conversation, in process memory only; ending
 * the conversation drops the line and the conversation's packs, and an answer still on its way is
 * then not stored. Nothing here does I/O: the client runs the reads and the waits.
 */
import type { NiadraError } from "./errors.js";
import type { Timeouts, VoiceOptions } from "./options.js";
import type { ContextRequest, ContextResponse } from "./types/context.js";

/** Reads a line remembers for matching turns; older ones are forgotten. */
const MAX_READS = 4;
/** Conversations with a line at once; past this, the least recently used line goes. */
const MAX_LINES = 1000;

const WORD = /[\p{L}\p{N}_]+/gu;
const MARKS = /\p{M}/gu;

/**
 * The words of a transcript, compared the way speech-to-text revises them: case, accents and
 * punctuation left out.
 */
export function wordsOf(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.toLowerCase().normalize("NFKD").replace(MARKS, "").match(WORD) ?? [];
}

/**
 * Whether a read of `partial` answers the turn `final`: the final words start with the partial's,
 * and the partial carries at least `minCoverage` of them. A read without words answers only a read
 * without words.
 */
export function covers(partial: readonly string[], final: readonly string[], minCoverage: number): boolean {
  if (partial.length === 0 || final.length === 0) return partial.length === final.length;
  if (partial.length > final.length) return false;
  for (let i = 0; i < partial.length; i++) if (partial[i] !== final[i]) return false;
  return partial.length >= minCoverage * final.length;
}

/** One read of a line: its words (none for the first read), and its answer once it lands. */
export interface TurnRead {
  words: string[];
  startedAt: number;
  speculative: boolean;
  /** Settles when the read is done; never rejects. */
  settled: Promise<void>;
  result: ContextResponse | null;
  failed: NiadraError | null;
  done: boolean;
}

/** What the SDK keeps for one voice conversation between its turns. */
export class VoiceLine {
  /** The conversation's read without the turn: what a speculative read sends with the partial. */
  request: ContextRequest | null = null;
  reads: TurnRead[] = [];
  /** The newest partial transcript not read yet, and when it last changed. */
  heard: string | null = null;
  heardAt = 0;
  timer: ReturnType<typeof setTimeout> | null = null;
  speculating: TurnRead | null = null;
  /** The newest settled text, waiting for the speculative read in flight. */
  waiting: string | null = null;
  closed = false;

  constructor(readonly scope: string) {}

  add(read: TurnRead): void {
    this.reads.push(read);
    if (this.reads.length > MAX_READS) this.reads.splice(0, this.reads.length - MAX_READS);
  }

  inFlight(): TurnRead[] {
    return this.reads.filter((read) => !read.done);
  }

  /** The reads that answer a turn of `words`, newest first, failed ones left out. */
  covering(words: readonly string[], minCoverage: number): TurnRead[] {
    return [...this.reads]
      .reverse()
      .filter((read) => covers(read.words, words, minCoverage) && !(read.done && !read.result));
  }

  alreadyRead(words: readonly string[]): boolean {
    return this.reads.some(
      (read) => read.words.length === words.length && read.words.every((w, i) => w === words[i]) && !(read.done && !read.result),
    );
  }

  /** Forgets the reads, which were made for a pack being dropped (a raised verification level). */
  reset(): void {
    this.reads = [];
    this.speculating = null;
    this.waiting = null;
  }

  close(): void {
    this.closed = true;
    this.reset();
    this.heard = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** The lines of one client, by scope, least recently used first out, and its round trip. */
export class VoiceLines {
  private readonly lines = new Map<string, VoiceLine>();
  /** The round trip to the region in milliseconds, once measured. */
  rtt: number | null = null;
  private probed = false;

  constructor(readonly options: VoiceOptions) {}

  line(scope: string): VoiceLine {
    let line = this.lines.get(scope);
    if (line) this.lines.delete(scope);
    else line = new VoiceLine(scope);
    this.lines.set(scope, line);
    while (this.lines.size > MAX_LINES) {
      const oldest = this.lines.keys().next();
      if (oldest.done) break;
      this.lines.get(oldest.value)?.close();
      this.lines.delete(oldest.value);
    }
    return line;
  }

  find(scope: string): VoiceLine | null {
    return this.lines.get(scope) ?? null;
  }

  drop(scope: string): void {
    this.lines.get(scope)?.close();
    this.lines.delete(scope);
  }

  clear(): void {
    for (const line of this.lines.values()) line.close();
    this.lines.clear();
  }

  /** True once per client: the caller measures the round trip. */
  claimProbe(): boolean {
    if (this.probed || !this.options.probe) return false;
    this.probed = true;
    return true;
  }

  get size(): number {
    return this.lines.size;
  }
}

/** The pinned body from the cache with the slots and guards of the read that answers the turn. */
export function compose(body: ContextResponse, read: TurnRead | null): ContextResponse {
  const fetched = read?.result ?? null;
  const pack = body.pack ? { pack: { ...body.pack, slots: fetched?.pack?.slots ?? [] } } : {};
  return { ...body, slots: fetched?.slots ?? null, guards: fetched?.guards ?? [], ...pack };
}

/** What to warn about once the round trip to the region is known. Log-safe: numbers only. */
/** What a read needs on top of the round trip at the least: the API's own time (20 to 40 ms at its p95). */
export const RTT_MARGIN_MS = 50;

/**
 * The read budgets the caller set below the round trip plus `RTT_MARGIN_MS`: every such read would run out of
 * time. Log-safe: numbers only.
 */
export function budgetWarnings(rttMs: number, timeouts: Timeouts, explicit: readonly ("context" | "navigation")[]): string[] {
  const ms = Math.round(rttMs);
  return [...explicit]
    .sort()
    .filter((name) => timeouts[name] < rttMs + RTT_MARGIN_MS)
    .map(
      (name) =>
        `timeouts.${name} (${timeouts[name]} ms) is shorter than the round trip to the region (${ms} ms) plus ` +
        `${RTT_MARGIN_MS} ms for the API: its reads will run out of time. Leave it at its default, which adds the ` +
        "measured round trip, or raise it",
    );
}

export function rttWarnings(rttMs: number, timeouts: Timeouts): string[] {
  const ms = Math.round(rttMs);
  const found: string[] = [];
  if (timeouts.contextVoice <= rttMs) {
    found.push(
      `the round trip to the region (${ms} ms) is longer than timeouts.contextVoice (${timeouts.contextVoice} ms): ` +
        "a voice turn whose words were not prefetched gets the pinned pack without slots. Send partial transcripts " +
        "with prefetch() (the voice adapters do) or raise the budget",
    );
  }
  if (timeouts.contextVoiceStart <= 3 * rttMs) {
    found.push(
      `the round trip to the region (${ms} ms) leaves timeouts.contextVoiceStart (${timeouts.contextVoiceStart} ms) ` +
        "short of a cold connection (three round trips): the first read of a call may miss it. Raise the budget",
    );
  }
  return found;
}
