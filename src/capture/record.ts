/**
 * The record of a closed turn as it travels (`turn-record.v0`), built on the sender, off the agent's path.
 *
 * Here each value gets its digest (SHA-256 over its canonical JSON, `jsonDigest`) and takes the form of the
 * content mode:
 *
 * - `stored`: the value travels in the record, and Niadra keeps it encrypted;
 * - `pointer`: the value goes to the company's storage first (`turns.store()`), and only the pointer and the
 *   digest travel. A record whose values cannot all be pointed at leaves as `hash_only`, `partial`;
 * - `hash_only`: only digests travel.
 *
 * A value the queue had to drop leaves as its digest when the sender computed it before, and otherwise leaves
 * the record, with the call fields that named it. Either way the record says `partial`.
 */

import { canonicalJson, jsonDigest } from "../digest.js";
import type { Logger } from "../logger.js";
import type { ClaimRecord } from "../types/turns.js";
import { VERSION } from "../version.js";
import type { Blob, ContentMode, TurnFrame } from "./frame.js";

export const SDK = `niadra-js/${VERSION}`;
const MAX_CALLS = 500;
const MAX_BLOBS = 1000;
const MAX_READS = 20;
const MAX_CLAIMS = 500;
const MAX_EVENT_KEYS = 50;
const MAX_DECISIONS = 50;
const BLOB_FIELDS = ["args", "result_model", "result_ui"];

/** Writes a value to the company's storage and returns the pointer to it (`s3://bucket/key`). */
export type BlobStore = (key: string, data: string) => Promise<string> | string;

export type TurnRecordJson = Record<string, unknown> & {
  turn_id: string;
  blobs: Record<string, Record<string, unknown>>;
  completeness: string;
  content_mode: ContentMode;
};

/** The blob's value, when the queue still holds it, with its digest computed and kept on the blob. */
async function blobValue(blob: Blob): Promise<[boolean, unknown]> {
  if (blob.data === null) return [false, undefined];
  const value = JSON.parse(blob.data) as unknown;
  if (blob.sha256 === undefined) {
    const { sha256, size } = await jsonDigest(value);
    blob.sha256 = sha256;
    blob.canonicalSize = size;
  }
  return [true, value];
}

/**
 * The wire record of `frame` in `mode`. Never throws for a value: one that fails is left out and the record
 * says what it lost.
 */
export async function buildRecord(
  frame: TurnFrame,
  requested: ContentMode,
  options: { store?: BlobStore | null; claims?: ((frame: TurnFrame) => ClaimRecord[]) | null; logger?: Logger } = {},
): Promise<TurnRecordJson> {
  let mode = requested;
  let completeness: string = frame.completeness;
  let blobs: Record<string, Record<string, unknown>> = {};
  let unpointed = false;
  for (const [key, blob] of [...frame.blobs].slice(0, MAX_BLOBS)) {
    let present: boolean;
    let value: unknown;
    try {
      [present, value] = await blobValue(blob);
    } catch {
      completeness = "incomplete";
      continue;
    }
    if (blob.sha256 === undefined) continue;
    const entry: Record<string, unknown> = { sha256: blob.sha256, size: blob.canonicalSize };
    if (mode === "stored" && present) entry.content = value;
    else if (mode === "pointer") {
      if (blob.pointer === undefined && present && options.store) {
        const pointer = await put(options.store, frame.turnId, key, value, options.logger);
        if (pointer !== null) blob.pointer = pointer;
      }
      if (blob.pointer === undefined) unpointed = true;
      entry.pointer = blob.pointer;
    }
    if (!present && completeness === "complete") completeness = "partial";
    blobs[key] = entry;
  }
  if (mode === "pointer" && unpointed) {
    mode = "hash_only";
    if (completeness === "complete") completeness = "partial";
  }
  if (mode !== "stored") {
    blobs = Object.fromEntries(
      Object.entries(blobs).map(([k, b]) => [k, { sha256: b.sha256, size: b.size, ...(mode === "pointer" ? { pointer: b.pointer } : {}) }]),
    );
  }
  const calls = frame.calls.slice(0, MAX_CALLS).map((entry) => callOf(entry, blobs));
  const found = claimsOf(frame, options.claims ?? null, options.logger);
  if (found === null) completeness = "incomplete";
  const lost = frame.calls.length > MAX_CALLS || frame.blobs.size > MAX_BLOBS || frame.reads.length > MAX_READS;
  if (lost && completeness === "complete") completeness = "partial";
  const agent: Record<string, unknown> = { name: frame.agent };
  if (frame.role) agent.role = frame.role;
  if (frame.parentTurnId) agent.parent_turn_id = frame.parentTurnId;
  const flags = new Set<string>(frame.flags);
  if (completeness === "incomplete") flags.add("incomplete");
  const output: Record<string, unknown> = { event_keys: frame.eventKeys.slice(0, MAX_EVENT_KEYS) };
  if (frame.handoffId) output.handoff_id = frame.handoffId;
  const record: TurnRecordJson = {
    spec: "turn-record.v0",
    turn_id: frame.turnId,
    agent,
    kind: frame.kind,
    started_at: frame.startedAt.toISOString(),
    fidelity: "gold",
    completeness,
    content_mode: mode,
    build: { pins: frame.pins, sdk: SDK, ...(frame.adapter ? { adapter: frame.adapter } : {}) },
    reads: frame.reads.slice(0, MAX_READS),
    calls,
    claims: (found ?? []).slice(0, MAX_CLAIMS),
    coordination: frame.coordination.slice(0, MAX_DECISIONS),
    effects: [...frame.effects].slice(0, MAX_DECISIONS).map(([key, state]) => ({ key, state })),
    output,
    flags: [...flags].sort(),
    blobs,
  };
  if (frame.conversationId) record.conversation_id = frame.conversationId;
  else record.task_id = frame.taskId;
  if (frame.endedAt !== null) {
    record.ended_at = frame.endedAt.toISOString();
    record.latency_ms = frame.latencyMs;
  }
  return record;
}

/** The same record with digests only: what any source accepts, and what fits any request. */
export function asHashOnly(record: TurnRecordJson): TurnRecordJson {
  const blobs = Object.fromEntries(Object.entries(record.blobs).map(([k, b]) => [k, { sha256: b.sha256, size: b.size }]));
  const hadValues = Object.values(record.blobs).some((b) => "content" in b || "pointer" in b);
  const completeness = hadValues && record.completeness === "complete" ? "partial" : record.completeness;
  return { ...record, content_mode: "hash_only", blobs, completeness };
}

async function put(store: BlobStore, turnId: string, key: string, value: unknown, logger?: Logger): Promise<string | null> {
  try {
    return await store(`${turnId}/${key.replace(":", "-")}.json`, canonicalJson(value));
  } catch {
    logger?.warn("a turn value could not be written to the company's store");
    return null;
  }
}

function callOf(entry: Record<string, unknown>, blobs: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const call: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (BLOB_FIELDS.includes(key) && !(typeof value === "string" && value in blobs)) continue;
    call[key] = value;
  }
  const args = call.args;
  if (typeof args === "string" && args in blobs) call.args_hash = blobs[args]?.sha256;
  return call;
}

/** The claims found at capture, then the ones the claim check finds now; `null` when the check failed. */
function claimsOf(frame: TurnFrame, claims: ((frame: TurnFrame) => ClaimRecord[]) | null, logger?: Logger): ClaimRecord[] | null {
  const found = [...frame.claims];
  if (claims === null || frame.said.length === 0) return found;
  try {
    return [...found, ...claims(frame)];
  } catch {
    logger?.warn("the claim check of a turn failed");
    return null;
  }
}
