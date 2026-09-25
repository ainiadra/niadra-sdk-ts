import type { Niadra, WriteResult } from "./client.js";
import type { AgentMemoryParams, AgentMemoryResult } from "./agent-memory.js";
import type { ContextOptions, ContextParams, ContextResult, RequestOptions } from "./context.js";
import type { TurnOptions } from "./conversation.js";
import { uuidv7 } from "./ids.js";
import { hasTarget } from "./items.js";
import type { ActionEvent, TrackEvent, VerifyParams } from "./items.js";
import type { Logger } from "./logger.js";
import { SessionState } from "./session.js";
import type { Timings } from "./session.js";
import type { BoundTools, ToolBinding, ToolOptions } from "./tools.js";
import type { Handle, ObjectRef } from "./types/common.js";
import type { TargetModel } from "./types/context.js";
import type { ContextStamp } from "./types/events.js";
import type { Verification, VerifyMethod, View } from "./types/vocabulary.js";
import { asModelUsage } from "./usage.js";

export interface TaskParams {
  /** Your id for the task. A UUIDv7 is minted when omitted. */
  task_id?: string;
  /** The internal agent or system doing the work, such as `billing-agent`. */
  channel: string;
  /** The person the task is about. Pass this, `object`, or both. */
  subject?: Handle;
  /** The business object the task is about, as an `ObjectRef` or `type:namespace:id`. */
  object?: ObjectRef | string;
  about?: Handle;
  /** A task view such as `task:billing`. Defaults to `brief`. */
  view?: View;
  verification?: Verification;
  target?: TargetModel;
}

export type TaskEvent = Omit<TrackEvent, "channel" | "task_id"> & { channel?: string };
export type TaskAction = Omit<ActionEvent, "channel" | "task_id"> & { channel?: string };

export interface TaskHooks {
  endTask(id: string): Promise<WriteResult>;
  /** `verify()` for a task, which may have no subject to default the handle to. */
  verifyTask(params: Omit<VerifyParams, "handle"> & { handle: Handle | undefined }): Promise<WriteResult>;
}

/**
 * One unit of work by an internal agent: a collection run, a ticket triage, a refund. The task
 * plays the role a conversation plays for customer-facing agents: the server pins its pack,
 * deltas arrive and are kept the same way, it scopes the context cache, groups the events for
 * billing and closes with `task.ended`. Without `end()`, the server closes the task after 10
 * minutes of inactivity.
 */
export class Task {
  readonly id: string;
  private readonly object: ObjectRef | string | null;
  private level: Verification | undefined;
  private readonly state = new SessionState();
  private ending: Promise<WriteResult> | null = null;

  constructor(
    private readonly client: Niadra,
    private readonly params: TaskParams,
    private readonly hooks: TaskHooks,
  ) {
    this.id = params.task_id ?? uuidv7();
    // Kept raw so a malformed shorthand fails open in context() and track() instead of throwing here.
    this.object = params.object ?? null;
    this.level = params.verification;
  }

  /** When context first went into the prompt, and when the agent first acted. */
  get timings(): Timings {
    return this.state.timings;
  }

  /** What the agent's next turn and action carry: the last `markInjected()`, or `null`. */
  get contextStamp(): ContextStamp | null {
    return this.state.contextStamp;
  }

  /** The last result `context()` returned for this task. */
  get lastContext(): ContextResult | null {
    return this.state.lastContext;
  }

  /** Where `wrap()` reports what it swallowed: the client's logger. */
  get logger(): Logger {
    return this.client.logger;
  }

  /**
   * Context for the task, centered on its object when it has one, otherwise on its subject.
   * Resolves with an empty result, never rejects, unless the client is strict.
   */
  async context(options: ContextOptions & { query?: string } = {}): Promise<ContextResult> {
    const { query, format, ...requestOptions } = options;
    const target = this.object ? { object: this.object } : this.params.subject ? { subject: this.params.subject } : {};
    const params: ContextParams = {
      ...target,
      view: this.params.view ?? "brief",
      task_id: this.id,
      ...(this.params.about ? { about: this.params.about } : {}),
      ...(this.level ? { verification: this.level } : {}),
      ...(this.params.target ? { target: this.params.target } : {}),
      ...(format === "json" ? { format } : {}),
    };
    if (query) return this.client.context({ ...params, query }, requestOptions);
    if (this.state.wantsDelta) params.delta = true;
    return this.state.absorb(await this.client.context(params, requestOptions));
  }

  /**
   * The agent's own working notes for this task's prompt, as `niadra.agentMemory()` with
   * the task's view: put `text` after your instructions and before the customer's context.
   */
  agentMemory(params: AgentMemoryParams = {}, options: RequestOptions = {}): Promise<AgentMemoryResult> {
    return this.client.agentMemory({ view: this.params.view ?? "brief", ...params }, options);
  }

  /** Records that `context` (by default the last one this task returned) went into the prompt. */
  markInjected(context?: ContextResult | null, at: Date = new Date()): void {
    this.state.markInjected(context, at);
  }

  /** Captures what the agent answered, stamped with the context its prompt carried. */
  agent(text: string, options: TurnOptions = {}): string | null {
    const stamp = this.state.agentTurn();
    const event: TaskEvent = {
      ...this.bind({}),
      speaker: options.speaker_id ? { role: "ai_agent", id: options.speaker_id } : "ai_agent",
      text,
    };
    const context_stamp = options.context_stamp ?? stamp;
    if (context_stamp) event.context_stamp = context_stamp;
    if (options.idempotency_key) event.idempotency_key = options.idempotency_key;
    if (options.occurred_at) event.occurred_at = options.occurred_at;
    if (options.visibility) event.visibility = options.visibility;
    const usage = asModelUsage(options.usage);
    if (usage) event.usage = usage;
    return this.track(event);
  }

  /**
   * Records that the person the task is about proved who they are, and reads at the new level
   * from then on. `handle` defaults to the task's subject.
   */
  async verify(params: { method: VerifyMethod; level: Verification; handle?: Handle }): Promise<WriteResult> {
    const handle = params.handle ?? this.params.subject;
    const result = await this.hooks.verifyTask({ method: params.method, level: params.level, handle, task_id: this.id });
    if (result.ok) {
      this.level = params.level;
      this.state.reset();
    }
    return result;
  }

  /** Records an event in this task, attaching the task's subject and object unless you pass your own. */
  track(event: TaskEvent): string | null {
    return this.client.track({ ...this.bind(event), ...event, channel: event.channel ?? this.params.channel });
  }

  /** Records an action taken in a system of record, such as `credit` on an invoice, stamped like its turns. */
  action(event: TaskAction): string | null {
    const stamp = this.state.actionStamp(event.speaker);
    return this.client.action({
      ...this.bind(event),
      ...(stamp ? { context_stamp: stamp } : {}),
      ...event,
      channel: event.channel ?? this.params.channel,
    });
  }

  /**
   * The navigation kit bound to the task's subject, or `null` for a task about an object only.
   * The verification level is read at each call, so tools created before a `verify()` pick up
   * the new level.
   */
  tools(options: ToolOptions = {}): BoundTools | null {
    const subject = this.params.subject;
    if (!subject) return null;
    const read = (): Verification => this.level ?? "V0";
    const binding: ToolBinding = {
      task_id: this.id,
      voice: this.params.view === "voice",
      get verification() {
        return read();
      },
    };
    if (this.params.about) binding.about = this.params.about;
    return this.client.tools(subject, binding, options);
  }

  /** Emits `task.ended` and drops the task's cached packs. Safe to call twice. */
  end(): Promise<WriteResult> {
    this.ending ??= this.hooks.endTask(this.id);
    return this.ending;
  }

  private bind(event: { handles?: Handle[]; subjects?: unknown[]; object_refs?: unknown[] }): {
    task_id: string;
    handles?: Handle[];
    object_refs?: (ObjectRef | string)[];
  } {
    const own = hasTarget(event);
    const bound: { task_id: string; handles?: Handle[]; object_refs?: (ObjectRef | string)[] } = {
      task_id: this.id,
    };
    if (own) return bound;
    if (this.params.subject) bound.handles = [this.params.subject];
    if (this.object) bound.object_refs = [this.object];
    return bound;
  }
}
