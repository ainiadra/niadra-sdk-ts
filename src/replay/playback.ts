/**
 * What a replayed turn answers with: the recorded tool results, matched by the digest of their arguments, the
 * pack of the time, and where what the agent says and declares goes instead of Niadra (the replay spec, 6).
 */

import { canonicalJson, jsonDigest } from "../digest.js";
import { sha256Hex } from "../sha256.js";
import { currentTurn, snapshot } from "../capture/frame.js";
import type { TurnFrame } from "../capture/frame.js";
import type { CheckRequest, CheckResult } from "../types/coordination.js";
import type { ContextResponse } from "../types/context.js";
import { uuidv7 } from "../ids.js";

export type Mode = "hermetic_turn" | "hermetic_conversation" | "era_memory";

/** A recorded value that could not be read, or is not the value its digest names. */
export class BlobError extends Error {
  override readonly name = "BlobError";
}

/** How one tool call answers: `live` runs the tool; otherwise `value` is the answer, recorded or empty. */
export interface Played {
  live: boolean;
  value: unknown;
  recorded: boolean;
}

interface Recorded {
  argsHash: string | null;
  value: unknown;
  used: boolean;
}

/** One execution's answers and what it collected. */
export class Playback {
  divergent = 0;
  readonly said: string[] = [];
  /** Effect keys the agent declared done, and how many times. */
  readonly done = new Map<string, number>();
  handoff = false;
  /**
   * The working state in this execution, by scope and agent: what the recorded turn read first, then what the
   * replayed agent wrote. It stays here.
   */
  readonly states = new Map<string, { body: Record<string, unknown>; version: number }>();

  constructor(
    private readonly calls: Map<string, Recorded[]>,
    readonly mode: Mode = "hermetic_turn",
    readonly context: ContextResponse | null = null,
  ) {}

  /** An item the replayed agent tried to send: it never leaves, and a handoff is noted. */
  muted(item: unknown): true {
    if ((item as { type?: unknown } | null)?.type === "handoff") this.handoff = true;
    return true;
  }

  /** What the replayed agent said: the text its assertions read, and its claims. */
  say(frame: TurnFrame, text: string): void {
    this.said.push(text);
    frame.said.push({ text, context: "chat", immutable: false, agent: frame.agent });
  }

  /** A declaration the replayed agent made: kept here, never sent. */
  declared(kind: string, detail: Record<string, unknown>): void {
    if (kind === "effect" && detail.state === "done") {
      const key = String(detail.effect_key);
      this.done.set(key, (this.done.get(key) ?? 0) + 1);
    }
    if (kind === "handoff") this.handoff = true;
  }

  /** A check the replayed agent made, answered here: an effect it already declared done is denied, anything else goes. */
  checked(request: CheckRequest): CheckResult {
    const done = request.effect_key != null && (this.done.get(request.effect_key) ?? 0) > 0;
    const result: CheckResult = { decision: done ? "deny" : "allow", decision_id: uuidv7(), reasons: done ? ["effect_done"] : [], valid_for_s: 0 };
    if (request.effect_key != null) result.effect = { state: done ? "done" : "none", attempt: 1 };
    return result;
  }

  /**
   * A recorded call of `tool` with the same arguments, the recorded ones of one tool taken in order; else the
   * tool runs when it is safe to run dry (in `era_memory`, first), or answers empty.
   */
  answer(tool: string, args: unknown, dryRun: boolean): Played {
    if (this.mode === "era_memory" && dryRun) return { live: true, value: undefined, recorded: false };
    const wanted = this.hash(args);
    for (const recorded of this.calls.get(tool) ?? []) {
      if (!recorded.used && recorded.argsHash === wanted) {
        recorded.used = true;
        return { live: false, value: recorded.value, recorded: true };
      }
    }
    this.divergent++;
    return { live: dryRun, value: undefined, recorded: false };
  }

  /** The digest of the arguments as a record names them: SHA-256 over their canonical JSON, computed now. */
  private hash(args: unknown): string | null {
    try {
      const canonical = canonicalJson(JSON.parse(snapshot(args)) as unknown);
      return `sha256:${sha256Hex(new TextEncoder().encode(canonical))}`;
    } catch {
      return null;
    }
  }
}

/** The playback of the turn replayed in this async context, if any. */
export function replaying(): Playback | null {
  return currentTurn()?.playback ?? null;
}

/**
 * The answers of a recorded turn. Every value used is fetched (by pointer, inside the company's boundary) and
 * must match its digest; rejects with `BlobError` otherwise.
 */
export async function playback(
  record: Record<string, unknown>,
  read: ((pointer: string) => Promise<string>) | null,
  mode: Mode = "hermetic_turn",
): Promise<Playback> {
  const blobs = (record.blobs ?? {}) as Record<string, Record<string, unknown>>;
  const values = new Map<string, unknown>();
  const value = async (key: unknown): Promise<unknown> => {
    const blob = typeof key === "string" ? blobs[key] : undefined;
    if (typeof key !== "string" || blob === undefined) return undefined;
    if (!values.has(key)) values.set(key, await materialized(blob, read));
    return values.get(key);
  };
  const calls = new Map<string, Recorded[]>();
  for (const call of (record.calls ?? []) as Record<string, unknown>[]) {
    if (call.kind !== "tool" || (call.status ?? "ok") !== "ok" || !("result_model" in call)) continue;
    const recorded: Recorded = { argsHash: (call.args_hash as string | undefined) ?? null, value: await value(call.result_model), used: false };
    const name = String(call.name);
    calls.set(name, [...(calls.get(name) ?? []), recorded]);
  }
  const pack = ((record.reads ?? []) as Record<string, unknown>[]).find((r) => r.surface === "pack");
  let context: ContextResponse | null = null;
  if (pack !== undefined && typeof pack.blob === "string" && pack.blob in blobs) {
    const found = await value(pack.blob);
    if (typeof found === "object" && found !== null) context = found as ContextResponse;
  }
  const played = new Playback(calls, mode, context);
  for (const read of (record.reads ?? []) as Record<string, unknown>[]) {
    if (read.surface !== "agent_state" || typeof read.blob !== "string") continue;
    const held = (await value(read.blob)) as { scope?: { kind?: unknown; id?: unknown }; agent?: unknown; version?: unknown; body?: unknown } | undefined;
    if (typeof held !== "object") continue;
    const id = JSON.stringify([String(held.scope?.kind), String(held.scope?.id), String(held.agent)]);
    if (!played.states.has(id)) played.states.set(id, { body: { ...((held.body ?? {}) as Record<string, unknown>) }, version: Number(held.version ?? 0) });
  }
  return played;
}

export async function materialized(blob: Record<string, unknown>, read: ((pointer: string) => Promise<string>) | null): Promise<unknown> {
  let found: unknown;
  if ("content" in blob) found = blob.content;
  else if (typeof blob.pointer === "string") {
    if (read === null) throw new BlobError("a value kept by pointer needs a reader: niadra.content.register(), or read");
    try {
      found = JSON.parse(await read(blob.pointer)) as unknown;
    } catch (error) {
      throw new BlobError("a value kept by pointer could not be read", { cause: error });
    }
  } else throw new BlobError("the record keeps only the digest of a value the replay needs");
  if ((await jsonDigest(found)).sha256 !== blob.sha256) throw new BlobError("a recorded value does not match its digest");
  return found;
}
