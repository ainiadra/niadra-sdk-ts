/**
 * Coordination in the agent's process: ask before acting, declare after (`spec/coordination.md`).
 *
 * ```ts
 * const decision = await conversation.check("farewell", { purpose: "service", effectKey: `farewell:${conversation.id}` });
 * if (decision.decision === "allow" && decision.effect?.state === "none") {
 *   await send(message);
 *   conversation.declare.effect(`farewell:${conversation.id}`, "done");
 * }
 * ```
 *
 * `check()` answers within its own budget (200 ms by default). When Niadra does not answer in time, the
 * decision comes from the purpose's direction (the coordination spec, 10):
 *
 * - a message the customer sent (`direction: "inbound"`) is never held: `allow`, `unchecked`;
 * - any purpose whose opt-out the local copy of the suppression list holds: `deny`, `suppressed` (each check
 *   about an outbound contact keeps that copy, read in the background once a minute);
 * - an effect with a key: `defer`, `unavailable`, and what may have gone out is never sent again on its own;
 * - a purpose that fails closed (by default `marketing`, `retention` and `collection`, the ones a gateway
 *   refuses without a token): `defer`, `unavailable`;
 * - any other purpose (`transactional`, `service`...): `allow`, `unchecked`, and the declaration says so.
 *
 * A check the API refuses (400, 401, 403 or 422: a purpose or channel the space does not declare, a key without the
 * `coordinate` scope) is the integration's error, not an outage: an outbound contact gets `defer` with the reason
 * `invalid_request` (an inbound message is never held: `allow`), the problem is logged with its request id, and
 * `strict: true` throws it.
 *
 * `failOpen` overrides the purpose's direction when Niadra did not answer; a space that does not coordinate
 * (404) holds nothing back.
 * Declarations (`conversation.declare`) leave in the background with an idempotency key and are sent again
 * until Niadra takes them; a turn records its decisions and the effects it reported.
 */

import { NiadraAPIError, explain } from "../errors.js";
import type { Logger } from "../logger.js";
import { uuidv7 } from "../ids.js";
import type { Outbox } from "../outbox.js";
import { replaying } from "../replay/playback.js";
import { currentTurn } from "../capture/frame.js";
import type { Handle, ObjectRef } from "../types/common.js";
import type { CheckRequest, CheckResult, OwnershipClaim } from "../types/coordination.js";
import type { SuppressionCopy } from "./suppression.js";

/** Statuses of a check the API refused as asked: the integration's error, never an outage. */
const REFUSED = new Set([400, 401, 403, 422]);

/** Whether the API refused the check as asked (`REFUSED`). */
export function refused(error: unknown): error is NiadraAPIError {
  return error instanceof NiadraAPIError && REFUSED.has(error.status);
}

/** Purposes that wait when Niadra cannot decide; every other purpose goes, marked unchecked. */
export const FAIL_CLOSED = new Set(["marketing", "retention", "collection"]);
/** Milliseconds a check may take before the purpose's direction decides. */
export const CHECK_BUDGET_MS = 200;

export type EffectState = "done" | "failed" | "unknown_outcome";

export interface CheckOptions {
  purpose: string;
  direction?: "inbound" | "outbound";
  channel?: string;
  effectKey?: string;
  effectKind?: CheckRequest["effect_kind"];
  object?: ObjectRef;
  task?: string;
  gatewayId?: string;
  destinationHash?: string;
  failOpen?: boolean;
  timeoutMs?: number;
}

/** The decision when Niadra did not answer in time, by the purpose's direction. Nothing reserved, no token. */
function fallback(request: CheckRequest, suppressed: boolean, failOpen?: boolean, windowUntil: Date | null = null): CheckResult {
  let decision: CheckResult["decision"];
  let reason: string;
  if (request.direction === "inbound") [decision, reason] = ["allow", "unchecked"];
  else if (suppressed) [decision, reason] = ["deny", "suppressed"];
  else if (windowUntil !== null) {
    // Inside the subject's own contact window: the contact waits until it ends.
    return {
      decision: "defer",
      decision_id: uuidv7(),
      reasons: ["contact_window"],
      contact_window_until: windowUntil.toISOString(),
      valid_for_s: 0,
    };
  }
  else if (request.effect_key != null) [decision, reason] = ["defer", "unavailable"];
  else if (failOpen ?? !FAIL_CLOSED.has(request.purpose)) [decision, reason] = ["allow", "unchecked"];
  else [decision, reason] = ["defer", "unavailable"];
  return { decision, decision_id: uuidv7(), reasons: [reason], valid_for_s: 0 };
}

/** What a session remembers of the checks it made: the attempt a check reserved for each effect key. */
export class Checked {
  readonly attempts = new Map<string, number>();
}

/** A claim's outcome: `claim` when it is held; otherwise `error`, the code of why not. */
export interface Claimed {
  held: boolean;
  claim: OwnershipClaim | null;
  error: string | null;
}

export function claimed(data: unknown, error?: unknown): Claimed {
  if (error === undefined) return { held: true, claim: data as OwnershipClaim, error: null };
  const code = error instanceof NiadraAPIError ? error.code : error instanceof Error ? error.name : "error";
  return { held: false, claim: null, error: code };
}

/** What a client keeps for coordination: the write outbox, and the local suppression copy the fallback reads. */
export class Coordinator {
  constructor(
    private readonly outbox: Outbox,
    private readonly suppressions: SuppressionCopy,
    private readonly declareNow: (body: Record<string, unknown>, key: string) => Promise<unknown>,
    private readonly logger?: Logger,
  ) {}

  async failed(request: CheckRequest, failOpen: boolean | undefined, error?: unknown): Promise<CheckResult> {
    if (refused(error)) {
      this.logger?.warn(`the coordination check was refused: ${explain(error)}`);
      const decision = request.direction === "inbound" ? "allow" : "defer";
      return recorded({ decision, decision_id: uuidv7(), reasons: ["invalid_request"], valid_for_s: 0 });
    }
    const off = error instanceof NiadraAPIError && error.status === 404;
    const found =
      request.subject != null && request.direction === "outbound"
        ? await this.suppressions.blocking(request.subject, request.purpose, { channel: request.channel ?? null })
        : null;
    const plain = off ? { ...request, effect_key: null } : request;
    return recorded(fallback(plain, found?.suppressed ?? false, off ? true : failOpen, found?.windowUntil ?? null));
  }

  decided(result: CheckResult, request: CheckRequest, checked: Checked): CheckResult {
    if (request.effect_key != null && result.effect?.state === "none") checked.attempts.set(request.effect_key, result.effect.attempt ?? 1);
    return recorded(result);
  }

  /** Queues one declaration; returns its idempotency key, or `""` in a replay, where nothing leaves. */
  declare(kind: string, detail: Record<string, unknown>, who: { agent: string; subject?: Handle | null; object?: ObjectRef | null }): string {
    const played = replaying();
    if (played !== null) {
      played.declared(kind, detail);
      return "";
    }
    const body: Record<string, unknown> = { kind, agent: who.agent, detail };
    if (who.subject) body.subject = who.subject;
    if (who.object) body.object = who.object;
    const key = uuidv7();
    this.outbox.put({ send: () => this.declareNow(body, key), route: "POST /v1/coordination/declare" });
    return key;
  }
}

function recorded(result: CheckResult): CheckResult {
  currentTurn()?.coordinate(result.decision_id, result.decision);
  return result;
}

/**
 * `conversation.declare`: call it with a kind and its detail, or use the helpers of the common kinds. Each
 * returns the declaration's idempotency key; none waits for Niadra.
 */
export class Declarations {
  constructor(
    private readonly coordinator: Coordinator,
    private readonly checked: Checked,
    private readonly who: { agent: string; subject?: Handle | null; object?: ObjectRef | null },
  ) {}

  kind(kind: string, detail: Record<string, unknown>): string {
    return this.coordinator.declare(kind, detail, this.who);
  }

  /**
   * How the attempt a check reserved for `key` ended. A send whose outcome the agent does not know is
   * `unknown_outcome`: it is never sent again on its own.
   */
  effect(key: string, state: EffectState = "done", attempt?: number): string {
    currentTurn()?.effect(key, state);
    return this.kind("effect", { effect_key: key, state, attempt: attempt ?? this.checked.attempts.get(key) ?? 1 });
  }

  /**
   * An outbound contact left: `decision` is the check's (`null` when there was none), `jti` the contact
   * token's. A contact that left on a check Niadra could not answer says `unchecked`.
   */
  contactMade(decision: CheckResult | null, params: { purpose: string; channel: string; gatewayId?: string; jti?: string }): string {
    const unchecked = decision === null || (decision.reasons ?? []).includes("unchecked");
    const detail: Record<string, unknown> = { purpose: params.purpose, channel: params.channel, unchecked };
    if (decision !== null && !unchecked) detail.decision_id = decision.decision_id;
    if (params.gatewayId) detail.gateway_id = params.gatewayId;
    if (params.jti) detail.jti = params.jti;
    return this.kind("contact.made", detail);
  }
}

/** The check request of an intent, with only the fields set. */
export function checkRequest(
  intent: string,
  options: CheckOptions,
  who: { agent: string; subject?: Handle | null; object?: ObjectRef | null; channel?: string | null },
): CheckRequest {
  const request: CheckRequest = { agent: who.agent, intent, purpose: options.purpose, direction: options.direction ?? "outbound" };
  if (who.subject) request.subject = who.subject;
  const channel = options.channel ?? who.channel;
  if (channel) request.channel = channel;
  if (options.effectKey) request.effect_key = options.effectKey;
  if (options.effectKind) request.effect_kind = options.effectKind;
  const object = options.object ?? who.object;
  if (object) request.object = object;
  if (options.task) request.task = options.task;
  if (options.gatewayId) request.gateway_id = options.gatewayId;
  if (options.destinationHash) request.destination_hash = options.destinationHash;
  return request;
}
