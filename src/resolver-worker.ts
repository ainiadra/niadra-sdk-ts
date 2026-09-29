/**
 * The resolver worker: the space's refresh requests, served inside the company's boundary.
 *
 * Niadra never calls a company system. When a value must be read again (a claim waits on it, a timer is due,
 * someone watches the object), Niadra queues a refresh request with the budget it admitted. The worker leases
 * the waiting requests (`GET /v1/state/refresh-requests`, 60 s), reads each object with the company's resolver
 * of its type (`niadra.resolvers`), at the resolver's rate and behind its circuit breaker, and pushes what it
 * read (`POST /v1/objects/push`), which settles the request. A request of a type with no resolver, or whose
 * resolver fails, is left to its lease.
 *
 * ```ts
 * const worker = new ResolverWorker(niadra);
 * await worker.run(abortController.signal);
 * ```
 */

import type { Niadra } from "./client.js";
import { pushItem } from "./resolvers.js";
import type { Resolvers } from "./resolvers.js";
import type { ObjectPush } from "./types/state.js";

const PUSH_MAX = 1000;
const LEASE_MS = 60_000;

export class ResolverWorker {
  pushed = 0;
  skipped = 0;
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
    for (const request of page.items) {
      const type = request.ref.type;
      if (!this.resolvers.has(type)) {
        if (!this.missing.has(type)) {
          this.missing.add(type);
          this.niadra.logger.warn(`no resolver for objects of type ${type}; their requests wait`);
        }
        this.skipped++;
        continue;
      }
      const wait = this.resolvers.wait(type);
      if (Date.now() + wait - leasedAt >= LEASE_MS) {
        this.skipped++; // past the lease: another worker may take it
        continue;
      }
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const resolved = await this.resolvers.resolve(request.ref, null, this.options.budgetMs ?? 5000);
      if (resolved === null) {
        this.skipped++;
        continue;
      }
      objects.push(pushItem(request.ref, resolved));
    }
    for (let start = 0; start < objects.length; start += PUSH_MAX) {
      await this.niadra.api.pushObjects({ objects: objects.slice(start, start + PUSH_MAX) });
    }
    this.pushed += objects.length;
    return objects.length;
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
