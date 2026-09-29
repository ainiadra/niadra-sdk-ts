/**
 * The company's resolvers: functions of its own that read an object fresh from its source, inside its
 * boundary. Niadra never calls a company system; the SDK does, in the company's process.
 *
 * ```ts
 * niadra.resolvers.register("health_quote", async (ref) => {
 *   const quote = await pricing.quote(ref.id);
 *   return { price_full: quote.full, price_discounted: quote.discounted };
 * });
 * const verdict = await conversation.verifyClaim("health_quote:op:q-77", "price_full", 511.06);
 * ```
 *
 * `verifyClaim()` asks Niadra first (`POST /v1/state/verify`). A value that is not safe to claim (stale,
 * expired, never observed) is read again with the resolver of its type, within the claim's budget (300 ms by
 * default): the fresh value decides, and it enters the turn as an observation, so the claim contract and the
 * memory see it. A value is never verified from a stale copy: without a resolver, past the budget, or with the
 * resolver's circuit open (5 failures in 30 s open it for 30 s), the answer is `claimSafe: false` with the gap
 * said. The same resolvers serve the resolver worker (`serveRefreshRequests()`).
 */

import { currentTurn } from "./capture/frame.js";
import type { ObjectPush, StateRef, Verdict } from "./types/state.js";

/** Milliseconds `verifyClaim()` may take, the resolver's read included. */
export const CLAIM_BUDGET_MS = 300;
const BREAKER_FAILURES = 5;
const BREAKER_WINDOW_MS = 30_000;
const BREAKER_OPEN_MS = 30_000;

/**
 * What a resolver read: the object's fields, observed now unless `observedAt` says when, and the source's
 * version of the object when it has one (the push keeps a field only from a newer version).
 */
export interface Resolved {
  fields: Record<string, unknown>;
  version?: number;
  observedAt?: Date;
  scope?: "global" | "customer" | "context";
}

export type Resolver = (ref: StateRef, fields: readonly string[] | null) => Promise<Resolved | Record<string, unknown>> | Resolved | Record<string, unknown>;

/** Whether a value may be claimed now, who decided it, and the fresh value a resolver read. */
export interface ClaimVerdict {
  claimSafe: boolean;
  status: "fresh" | "stale" | "expired" | "unknown";
  matches: boolean | null;
  source: "niadra" | "resolver" | "none";
  declaredGaps: string[];
  prohibitions: string[];
  value?: unknown;
}

interface Entry {
  fn: Resolver;
  rate: number | null;
  failures: number[];
  openUntil: number;
  nextAt: number;
}

function isResolved(found: unknown): found is Resolved {
  return typeof found === "object" && found !== null && "fields" in found && typeof (found as Resolved).fields === "object";
}

/** `niadra.resolvers`: the company's resolvers by object type, each with its circuit breaker and rate. */
export class Resolvers {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * `fn(ref, fields)` reads objects of `type` from their source: their fields, or a `Resolved`. `rate` caps
   * the worker's calls per second.
   */
  register(type: string, fn: Resolver, options: { rate?: number } = {}): void {
    this.entries.set(type, { fn, rate: options.rate ?? null, failures: [], openUntil: 0, nextAt: 0 });
  }

  has(type: string): boolean {
    return this.entries.has(type);
  }

  /** A resolver for `type` whose circuit is closed. */
  available(type: string): boolean {
    const entry = this.entries.get(type);
    return entry !== undefined && this.now() >= entry.openUntil;
  }

  /** Milliseconds until the worker may call `type`'s resolver again, taking the slot. */
  wait(type: string): number {
    const entry = this.entries.get(type);
    const rate = entry?.rate ?? null;
    if (entry === undefined || rate === null) return 0;
    const now = this.now();
    const at = Math.max(now, entry.nextAt);
    entry.nextAt = at + 1000 / rate;
    return at - now;
  }

  /** Calls the resolver of `ref.type` within `budgetMs`; `null` when it failed, ran out of time or its circuit is open. */
  async resolve(ref: StateRef, fields: readonly string[] | null, budgetMs: number): Promise<Resolved | null> {
    const entry = this.entries.get(ref.type);
    if (entry === undefined || this.now() < entry.openUntil) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => { resolve(null); }, Math.max(0, budgetMs));
    });
    let found: unknown;
    try {
      found = await Promise.race([Promise.resolve().then(() => entry.fn(ref, fields)), timeout]);
    } catch {
      found = null;
    } finally {
      clearTimeout(timer);
    }
    const resolved = found === null ? null : isResolved(found) ? found : typeof found === "object" ? { fields: found as Record<string, unknown> } : null;
    if (resolved === null) {
      const now = this.now();
      entry.failures = [...entry.failures.filter((t) => now - t < BREAKER_WINDOW_MS), now];
      if (entry.failures.length >= BREAKER_FAILURES) {
        entry.openUntil = now + BREAKER_OPEN_MS;
        entry.failures = [];
      }
    } else entry.failures = [];
    return resolved;
  }
}

/** A reference as `type:namespace:id`, or a `StateRef`. */
export function asRef(ref: StateRef | string): StateRef {
  if (typeof ref !== "string") return ref;
  const [type = "", namespace = "", ...rest] = ref.split(":");
  return { type, namespace, id: rest.join(":") };
}

export function fromNiadra(verdict: Verdict): ClaimVerdict {
  return {
    claimSafe: verdict.claim_safe,
    status: verdict.status,
    matches: verdict.matches ?? null,
    source: "niadra",
    declaredGaps: verdict.declared_gaps ?? [],
    prohibitions: verdict.prohibitions ?? [],
  };
}

/** The verdict once the resolver answered (or not): a fresh value decides; nothing else verifies. */
export function fromResolver(ref: StateRef, field: string, value: unknown, resolved: Resolved | null, verdict: Verdict | null): ClaimVerdict {
  const gaps = verdict?.declared_gaps ?? [];
  if (resolved === null || !(field in resolved.fields)) {
    return { claimSafe: false, status: verdict?.status ?? "unknown", matches: null, source: "none", declaredGaps: [...gaps, "source_unreachable"], prohibitions: verdict?.prohibitions ?? [] };
  }
  const fresh = resolved.fields[field];
  const matches = same(fresh, value);
  observed(ref, resolved);
  return { claimSafe: matches, status: "fresh", matches, source: "resolver", declaredGaps: gaps, prohibitions: [], value: fresh };
}

/** Equal values, numbers by their decimal value (511.06 and "511.06" are the same). */
export function same(a: unknown, b: unknown): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  const numeric = (v: unknown): string | null => (typeof v === "number" ? String(v) : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : null);
  const x = numeric(a);
  const y = numeric(b);
  if (x !== null && y !== null) return Number(x) === Number(y);
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The fresh read enters the turn as a call that observed the object, as a tool's result would. */
function observed(ref: StateRef, resolved: Resolved): void {
  const frame = currentTurn();
  if (frame === undefined) return;
  const key = `${ref.type}:${ref.namespace}:${ref.id}`;
  const at = (resolved.observedAt ?? new Date()).toISOString();
  const call = frame.toolCall(`resolve:${ref.type}`, { ref: key });
  call.result({ ...resolved.fields }, { observations: [{ ref: key, fields: { ...resolved.fields }, provenance: { source: "live", source_observed_at: at, scope: resolved.scope ?? "global" } }] });
}

/** What the worker pushes for one resolved object (`POST /v1/objects/push`). */
export function pushItem(ref: StateRef, resolved: Resolved): ObjectPush {
  const at = resolved.observedAt ?? new Date();
  return {
    ref,
    fields: { ...resolved.fields },
    provenance: { source: "live", source_observed_at: at.toISOString(), scope: resolved.scope ?? "global" },
    version: resolved.version ?? at.getTime(),
  };
}
