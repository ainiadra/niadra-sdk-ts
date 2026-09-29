/**
 * What a conversation or a task does with the agent features of its space: turn records, the claim contract,
 * coordination, the working state and claim verification, for its own scope and agent.
 */

import { AgentStateHandle } from "./agent-state.js";
import type { AgentStates, Scope } from "./agent-state.js";
import { stateValues } from "./capture/claims.js";
import { ClaimCheck } from "./capture/check.js";
import { currentTurn } from "./capture/frame.js";
import type { TurnFrame, TurnKind } from "./capture/frame.js";
import type { OpenTurn, TurnRecorder } from "./capture/recorder.js";
import { CHECK_BUDGET_MS, Checked, Declarations, checkRequest, claimed } from "./coordination/client.js";
import type { CheckOptions, Claimed, Coordinator } from "./coordination/client.js";
import type { ContextResult } from "./context.js";
import { toObjectRef } from "./handles.js";
import { replaying } from "./replay/playback.js";
import type { ClaimVerdict } from "./resolvers.js";
import type { Handle, ObjectRef } from "./types/common.js";
import type { CheckRequest, CheckResult, ClaimRequest, OwnershipClaim } from "./types/coordination.js";
import type { ClaimContractSummary, StateRef } from "./types/state.js";
import type { TurnPins } from "./types/turns.js";

/** What a conversation or a task needs of its client for the agent features. */
export interface AgentHost {
  recorder: TurnRecorder;
  coordinator: Coordinator;
  states: AgentStates;
  contract(): Promise<ClaimContractSummary | null>;
  check(request: CheckRequest, timeoutMs: number): Promise<CheckResult>;
  claim(request: ClaimRequest, timeoutMs: number): Promise<OwnershipClaim>;
  verifyClaim(ref: StateRef | string, field: string, value: unknown, options: { subject?: Handle; budgetMs?: number }): Promise<ClaimVerdict>;
  enabled: boolean;
  navigationMs: number;
}

/** A turn's options: its kind, the build it runs on, the agent and its role, and an id of your own. */
export interface TurnParams {
  kind?: TurnKind;
  build?: TurnPins;
  agent?: string;
  role?: string;
  turnId?: string;
}

export interface ClaimParams {
  /** A business object, for a task lock: `type:namespace:id` or an `ObjectRef`. */
  object?: ObjectRef | string;
  task?: string;
  kind?: ClaimRequest["kind"];
  leaseS?: number;
  level?: string;
  intents?: string[];
  timeoutMs?: number;
}

export class AgentSession {
  readonly claims: ClaimCheck;
  readonly declare: Declarations;
  readonly agentState: AgentStateHandle;
  private readonly checked = new Checked();

  constructor(
    private readonly host: AgentHost,
    private readonly scope: Scope,
    private readonly agent: string,
    private readonly subject: Handle | null,
    private readonly object: ObjectRef | null,
    private readonly channel: string | null,
  ) {
    this.claims = new ClaimCheck(() => host.contract());
    this.declare = new Declarations(host.coordinator, this.checked, { agent, subject, object });
    this.agentState = new AgentStateHandle(host.states, scope, agent, subject);
  }

  /** A new turn of this session, not yet current; opened inside another turn, a sub-turn of it. */
  openTurn(params: TurnParams = {}): TurnFrame {
    const options: OpenTurn & { agent: string } = { agent: params.agent ?? this.agent, kind: params.kind ?? "message" };
    if (params.build) options.build = params.build;
    if (params.role) options.role = params.role;
    if (params.turnId) options.turnId = params.turnId;
    if (currentTurn() === undefined) {
      if (this.scope.kind === "conversation") options.conversationId = this.scope.id;
      else options.taskId = this.scope.id;
    }
    return this.host.recorder.open(options);
  }

  /** Runs `fn` as a turn of this session, from its input to the last thing it emits, and closes it. */
  async turn<T>(params: TurnParams, fn: (frame: TurnFrame) => T | Promise<T>): Promise<T> {
    const frame = this.openTurn(params);
    try {
      const result = await frame.run(() => fn(frame));
      frame.close();
      return result;
    } catch (error) {
      frame.close(error);
      throw error;
    }
  }

  /** What a read gave the agent, recorded in the current turn: the pack by ETag, the blocks by version. */
  observe(result: ContextResult): void {
    const frame = currentTurn();
    const response = result.response;
    if (frame === undefined || response === null) return;
    if (response.etag) {
      frame.read("pack", { etag: response.etag });
      frame.pack(response.version || null, response.manifest_hash ?? response.etag);
    }
    if (result.constraints) frame.read("constraints", { version: result.constraints.version });
    if (result.state) {
      frame.read("state");
      frame.observeState(stateValues(result.state.objects ?? []));
    }
  }

  /** What the agent said, for the turn and its claim check. */
  said(text: string, eventKey: string | null): void {
    const frame = currentTurn();
    if (frame === undefined) return;
    frame.say(text, { eventKey });
    frame.playback?.say(frame, text);
  }

  async check(intent: string, options: CheckOptions): Promise<CheckResult> {
    const request = checkRequest(intent, options, { agent: this.agent, subject: this.subject, object: this.object, channel: this.channel });
    const played = replaying();
    if (played !== null) return played.checked(request);
    if (!this.host.enabled) return this.host.coordinator.failed(request, options.failOpen);
    try {
      return this.host.coordinator.decided(await this.host.check(request, options.timeoutMs ?? CHECK_BUDGET_MS), request, this.checked);
    } catch (error) {
      return this.host.coordinator.failed(request, options.failOpen, error);
    }
  }

  async claim(params: ClaimParams = {}): Promise<Claimed> {
    const object = params.object !== undefined ? toObjectRef(params.object) : null;
    const request: ClaimRequest = {
      holder: this.agent,
      kind: params.kind ?? (params.task !== undefined ? "task_lock" : "owner"),
      lease_s: params.leaseS ?? 600,
      intents: params.intents ?? [],
    };
    if (params.level) request.level = params.level;
    if (params.task) request.task = params.task;
    if (object !== null) request.object = object;
    else if (this.subject !== null) request.subject = this.subject;
    try {
      return claimed(await this.host.claim(request, params.timeoutMs ?? this.host.navigationMs));
    } catch (error) {
      return claimed(null, error);
    }
  }

  verifyClaim(ref: StateRef | string, field: string, value: unknown, options: { budgetMs?: number } = {}): Promise<ClaimVerdict> {
    return this.host.verifyClaim(ref, field, value, { ...options, ...(this.subject ? { subject: this.subject } : {}) });
  }
}
