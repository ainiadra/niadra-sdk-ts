/**
 * The agent's working state: a small state its code keeps between turns, with a declared schema
 * (`spec/agent-state.md`). Written by code, never by a model.
 *
 * ```ts
 * const state = await conversation.agentState.get();
 * await conversation.agentState.put({ offer: { status: "accepted" } }, { mode: "merge_by_key", ifVersion: state.version });
 * ```
 *
 * `cas` replaces the whole state at `ifVersion` (0 when it must not exist yet); `merge_by_key` replaces the
 * top-level fields it names and removes a field written as `{ $delete: true }`, so sub-agents writing
 * different fields never lose each other's writes.
 *
 * The SDK keeps, per scope and agent, the last version it wrote or read, and serves the higher of that and
 * what a read brings (read your writes). With Niadra out of reach, a read serves that copy (`degraded`), and a
 * write applies to it at once and leaves again later with the same `ifVersion`: the answer says `pending`. A
 * compare-and-swap that then conflicts is never merged in silence: it lands in `conflicts` and is logged. Over
 * the cap a write is not stored and the previous state stays (`reason: "over_cap"`), never an error.
 */

import { NiadraAPIError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { Outbox } from "./outbox.js";
import { isTransient } from "./transport.js";
import { currentTurn } from "./capture/frame.js";
import { replaying } from "./replay/playback.js";
import type { Handle } from "./types/common.js";
import type { AgentState, AgentStateWrite, AgentStateWriteResult } from "./types/state.js";

export type StateMode = "cas" | "merge_by_key";
export interface Scope { kind: "conversation" | "task" | "object" | "subject"; id: string }
/** A field written as this, in `merge_by_key`, is removed. */
export const DELETE = Object.freeze({ $delete: true });

export interface WorkingState {
  body: Record<string, unknown>;
  version: number;
  updatedAt: string | null;
  /** Served from the SDK's copy because Niadra did not answer. */
  degraded: boolean;
}

/**
 * A write's answer: `stored` and the version after it; `reason` is `over_cap` or `not_declared_field` (not
 * stored, the state as it was), or `conflict` (412: the version moved; read and try again). `pending` says
 * Niadra did not answer and the write leaves later, already applied to the SDK's copy.
 */
export interface StateWrite {
  stored: boolean;
  version: number;
  reason: string | null;
  pending: boolean;
}

/** A write sent again after an outage that met a newer version. */
export interface Conflict {
  scope: Scope;
  agent: string;
  body: Record<string, unknown>;
  ifVersion: number | null;
}

interface Held {
  body: Record<string, unknown>;
  version: number;
  updatedAt: string | null;
  pending: number;
}



function isConflict(error: unknown): boolean {
  return error instanceof NiadraAPIError && (error.status === 412 || error.code === "agent_state_conflict");
}

const copy = <T>(value: T): T => structuredClone(value);
const key = (scope: Scope, agent: string): string => JSON.stringify([scope.kind, scope.id, agent]);

function applied(base: Record<string, unknown>, write: AgentStateWrite): Record<string, unknown> {
  if (write.mode === "cas") return copy(write.body);
  const out = copy(base);
  for (const [name, value] of Object.entries(write.body)) {
    const removal = typeof value === "object" && value !== null && Object.keys(value).length === 1 && (value as { $delete?: unknown }).$delete === true;
    if (removal) Reflect.deleteProperty(out, name);
    else out[name] = copy(value);
  }
  return out;
}

export interface StateTransport {
  read(scope: Scope, agent: string): Promise<AgentState>;
  write(write: AgentStateWrite): Promise<AgentStateWriteResult>;
}

/** The client's copies, by scope and agent, and the writes waiting for Niadra. */
export class AgentStates {
  private readonly held = new Map<string, Held>();
  readonly conflicts: Conflict[] = [];

  constructor(
    private readonly outbox: Outbox,
    private readonly transport: StateTransport,
    private readonly logger: Logger,
  ) {}

  async get(scope: Scope, agent: string): Promise<WorkingState> {
    const played = replaying();
    if (played !== null) {
      const held = played.states.get(key(scope, agent)) ?? { body: {}, version: 0 };
      return { body: copy(held.body), version: held.version, updatedAt: null, degraded: false };
    }
    let served: WorkingState;
    try {
      const state = await this.transport.read(scope, agent);
      let held = this.held.get(key(scope, agent));
      if (held === undefined || (state.version >= held.version && held.pending === 0)) {
        held = { body: copy(state.body ?? {}), version: state.version, updatedAt: state.updated_at ?? null, pending: 0 };
        this.held.set(key(scope, agent), held);
      }
      served = { body: copy(held.body), version: held.version, updatedAt: held.updatedAt, degraded: false };
    } catch {
      const held = this.held.get(key(scope, agent));
      served = held ? { body: copy(held.body), version: held.version, updatedAt: held.updatedAt, degraded: true } : { body: {}, version: 0, updatedAt: null, degraded: true };
    }
    // The state it served goes with the read, so a replay starts from it.
    currentTurn()?.read("agent_state", { version: String(served.version), value: { scope, agent, version: served.version, body: served.body } });
    return served;
  }

  async put(write: AgentStateWrite): Promise<StateWrite> {
    const played = replaying();
    if (played !== null) {
      // A replayed agent's writes stay in the replay, with the same rules.
      const id = key(write.scope, write.agent);
      const held = played.states.get(id) ?? { body: {}, version: 0 };
      if (write.if_version != null && write.if_version !== held.version) return { stored: false, version: held.version, reason: "conflict", pending: false };
      played.states.set(id, { body: applied(write.mode === "merge_by_key" ? held.body : {}, write), version: held.version + 1 });
      return { stored: true, version: held.version + 1, reason: null, pending: false };
    }
    try {
      return this.written(write, await this.transport.write(write));
    } catch (error) {
      if (isConflict(error)) return { stored: false, version: this.held.get(key(write.scope, write.agent))?.version ?? 0, reason: "conflict", pending: false };
      if (isTransient(error)) return this.later(write);
      return { stored: false, version: 0, reason: error instanceof NiadraAPIError ? error.code : "error", pending: false };
    }
  }

  private written(write: AgentStateWrite, result: AgentStateWriteResult): StateWrite {
    if (result.stored) {
      const held = this.held.get(key(write.scope, write.agent));
      const base = held !== undefined && write.mode === "merge_by_key" ? held.body : {};
      if (held === undefined || result.version >= held.version) {
        this.held.set(key(write.scope, write.agent), { body: applied(base, write), version: result.version, updatedAt: null, pending: 0 });
      }
    }
    return { stored: result.stored, version: result.version, reason: result.reason ?? null, pending: false };
  }

  /** Niadra did not answer: the write applies to the copy now and leaves again later. */
  private later(write: AgentStateWrite): StateWrite {
    const id = key(write.scope, write.agent);
    const held = this.held.get(id) ?? { body: {}, version: 0, updatedAt: null, pending: 0 };
    if (write.mode === "cas" && write.if_version != null && write.if_version !== held.version) {
      return { stored: false, version: held.version, reason: "conflict", pending: false };
    }
    const next: Held = { body: applied(write.mode === "merge_by_key" ? held.body : {}, write), version: held.version + 1, updatedAt: null, pending: held.pending + 1 };
    this.held.set(id, next);
    this.outbox.put({ send: () => this.transport.write(write), settled: (answer, error) => { this.resent(write, answer, error); } });
    return { stored: true, version: next.version, reason: null, pending: true };
  }

  private resent(write: AgentStateWrite, answer: unknown, error: unknown): void {
    const id = key(write.scope, write.agent);
    if (error === null) {
      const held = this.held.get(id);
      if (held !== undefined) {
        held.pending = Math.max(0, held.pending - 1);
        held.version = Math.max(held.version, (answer as AgentStateWriteResult).version);
      }
      return;
    }
    this.held.delete(id); // the copy guessed wrong: the next read takes Niadra's
    if (isConflict(error)) {
      this.conflicts.push({ scope: { ...write.scope }, agent: write.agent, body: copy(write.body), ifVersion: write.if_version ?? null });
      this.logger.warn("a working state write sent after an outage met a newer version");
    }
  }
}

/** `conversation.agentState`: this session's working state for its agent. */
export class AgentStateHandle {
  constructor(
    private readonly states: AgentStates,
    private readonly scope: Scope,
    private readonly agent: string,
    private readonly subject: Handle | null,
  ) {}

  /** The state of this scope and agent: version 0 and an empty body before the first write. */
  get(): Promise<WorkingState> {
    return this.states.get(this.scope, this.agent);
  }

  /** Writes the state: `merge_by_key` by default, `cas` at `ifVersion`. See the module. */
  put(body: Record<string, unknown>, options: { mode?: StateMode; ifVersion?: number } = {}): Promise<StateWrite> {
    const write: AgentStateWrite = { scope: this.scope, agent: this.agent, body, mode: options.mode ?? "merge_by_key" };
    if (options.ifVersion !== undefined) write.if_version = options.ifVersion;
    if (this.subject !== null && this.scope.kind !== "subject") write.subject = this.subject;
    return this.states.put(write);
  }

  /** Writes of this scope and agent, sent after an outage, that met a newer version. */
  get conflicts(): Conflict[] {
    return this.states.conflicts.filter((c) => c.scope.kind === this.scope.kind && c.scope.id === this.scope.id && c.agent === this.agent);
  }
}
