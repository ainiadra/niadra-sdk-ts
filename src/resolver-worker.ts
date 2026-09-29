/**
 * The resolver worker: the space's refresh requests, served inside the company's boundary.
 *
 * Niadra never calls a company system. When a value must be read again (a claim waits on it, a timer is due,
 * someone watches the object), Niadra queues a refresh request with the budget it admitted. The worker leases
 * the waiting requests (`GET /v1/state/refresh-requests`, 60 s), reads each object with the company's resolver
 * of its type (`niadra.resolvers`), at the resolver's rate and behind its circuit breaker, and pushes what it
 * read (`POST /v1/objects/push`) with the request's id, which settles it.
 *
 * A watch fires only on a value its source confirmed: its `watch_revalidation` requests go first, and the
 * answer decides every due watch of the object, even when the value did not change. A request the worker
 * cannot answer, the object gone from the source (`NOT_FOUND`) or the resolver failing, is released at once
 * (`POST .../release`), so a watch falls back to its type's rule without waiting out the leases. A request of a
 * type with no resolver, or whose resolver's circuit is open, is left to its lease, for a worker that can read
 * it. A worker that leases regularly is what tells Niadra a company worker is there to revalidate.
 *
 * ```ts
 * const worker = new ResolverWorker(niadra);
 * await worker.run(abortController.signal);
 * ```
 */

import type { Niadra } from "./client.js";
import { pushItem } from "./resolvers.js";
import type { Resolvers } from "./resolvers.js";
import type { ObjectPush, RefreshRequest } from "./types/state.js";

const PUSH_MAX = 1000;
const LEASE_MS = 60_000;
const WATCH = "watch_revalidation";
const PRIORITY: Record<string, number> = { high: 0, normal: 1, low: 2 };

/** Watches first, since a customer waits on them; then by the priority Niadra gave. */
const order = (a: RefreshRequest, b: RefreshRequest): number =>
  Number(a.reason !== WATCH) - Number(b.reason !== WATCH) || (PRIORITY[a.priority] ?? 1) - (PRIORITY[b.priority] ?? 1);

export class ResolverWorker {
  pushed = 0;
  skipped = 0;
  released = 0;
  private readonly missing = new Set<string>();

  constructor(
    private readonly niadra: Niadra,
    private readonly options: { limit?: number; pollMs?: number; budgetMs?: number; resolvers?: Resolvers } = {},
  ) {}

  private get resolvers(): Resolvers {
    return this.options.resolvers ?? this.niadra.resolvers;
  }

  /** Leases the waiting requests, resolves them and pushes what was read. Resolves with how many were pushed. */
  async runOnce(): Promise<number> {
    const leasedAt = Date.now();
    const page = await this.niadra.api.refreshRequests({ limit: this.options.limit ?? 50 });
    const objects: ObjectPush[] = [];
    for (const request of [...page.items].sort(order)) {
      const type = request.ref.type;
      if (!this.resolvers.has(type)) {
        if (!this.missing.has(type)) {
          this.missing.add(type);
          this.niadra.logger.warn(`no resolver for objects of type ${type}; their requests wait`);
        }
        this.skipped++;
        continue;
      }
      if (!this.resolvers.available(type)) {
        this.skipped++; // the circuit is open: the lease brings it back
        continue;
      }
      const wait = this.resolvers.wait(type);
      if (Date.now() + wait - leasedAt >= LEASE_MS) {
        this.skipped++; // past the lease: another worker may take it
        continue;
      }
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const found = await this.resolvers.fetch(request.ref, null, this.options.budgetMs ?? 5000);
      if (typeof found === "string") await this.release(request, found);
      else objects.push({ ...pushItem(request.ref, found), request_id: request.request_id });
    }
    for (let start = 0; start < objects.length; start += PUSH_MAX) {
      await this.niadra.api.pushObjects({ objects: objects.slice(start, start + PUSH_MAX) });
    }
    this.pushed += objects.length;
    return objects.length;
  }

  /** Gives back a request the worker cannot answer; one that failed to go back waits out its lease. */
  private async release(request: RefreshRequest, outcome: "not_found" | "failed"): Promise<void> {
    try {
      await this.niadra.api.releaseRefreshRequest(request.request_id, { outcome });
      this.released++;
    } catch {
      this.niadra.logger.warn("a refresh request could not be released");
      this.skipped++;
    }
  }

  /** Serves requests until `signal` aborts, pausing when none wait, and longer while Niadra does not answer. */
  async run(signal?: AbortSignal): Promise<void> {
    const poll = this.options.pollMs ?? 2000;
    let pause = poll;
    while (!signal?.aborted) {
      let done = 0;
      try {
        done = await this.runOnce();
        pause = poll;
      } catch {
        this.niadra.logger.warn("the resolver worker could not reach Niadra");
        pause = Math.min(pause * 2, 60_000);
      }
      if (done === 0) await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
}
