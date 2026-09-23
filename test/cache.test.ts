import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NiadraPermissionError } from "../src/index.js";
import { ContextCache } from "../src/cache.js";
import { DEFAULT_CACHE } from "../src/options.js";
import { MockServer, batchOk, contextBody, makeClient, marina, problem } from "./helpers.js";

const inConversation = { subject: marina, conversation_id: "wa-8812" } as const;

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

describe("per-conversation context cache", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-22T17:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a fresh pack without a request", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() });
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    vi.advanceTimersByTime(5_000);
    const second = await niadra.context(inConversation);
    expect(server.calls).toHaveLength(1);
    expect(second.source).toBe("cache");
    expect(second.text).toContain("Marina");
  });

  it("serves a stale pack at once and refreshes it in the background with the etag", async () => {
    const server = new MockServer().on(
      "POST /v1/context",
      { body: contextBody() },
      { body: contextBody({ text: "<context>v2</context>", etag: "etag-2" }) },
    );
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    vi.advanceTimersByTime(11_000);

    const stale = await niadra.context(inConversation);
    expect(stale.source).toBe("stale");
    expect(stale.text).toContain("Marina");
    await settle();
    expect(server.calls[1]!.body.known_etag).toBe("etag-1");

    const refreshed = await niadra.context(inConversation);
    expect(refreshed.source).toBe("cache");
    expect(refreshed.text).toBe("<context>v2</context>");
  });

  it("keeps the cached text on not_modified but takes the new live turns", async () => {
    const live = [{ at: "t", channel: "voice", kind: "message" as const, speaker: "customer", text: "called", source_id: "s" }];
    const server = new MockServer().on(
      "POST /v1/context",
      { body: contextBody() },
      { body: contextBody({ not_modified: true, text: null, variables: {}, live, path: "not_modified" }) },
    );
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    vi.advanceTimersByTime(11 * 60_000);
    const result = await niadra.context(inConversation);
    expect(result.source).toBe("network");
    expect(result.text).toContain("Marina");
    expect(result.variables).toEqual({ name: "Marina" });
    expect(result.suffix).toContain("called");
  });

  it("shares one request among concurrent callers", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody(), delay: 20 });
    const niadra = makeClient(server);
    vi.useRealTimers();
    const results = await Promise.all([niadra.context(inConversation), niadra.context(inConversation), niadra.context(inConversation)]);
    expect(server.calls).toHaveLength(1);
    expect(results.every((r) => r.text.includes("Marina"))).toBe(true);
  });

  it("refreshes a stale key once however many callers read it", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() }, { body: contextBody(), delay: 20 });
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    vi.advanceTimersByTime(11_000);
    await Promise.all([niadra.context(inConversation), niadra.context(inConversation), niadra.context(inConversation)]);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(server.calls).toHaveLength(2);
  });

  it("falls back to the last good pack when a refresh fails", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() }, problem(503, "unavailable"));
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    vi.advanceTimersByTime(11 * 60_000);
    const result = await niadra.context(inConversation);
    expect(result.source).toBe("fallback");
    expect(result.text).toContain("Marina");
    expect(result.error).toMatchObject({ status: 503 });
  });

  it("drops packs older than maxStaleMs instead of falling back to them", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() }, problem(503, "unavailable"));
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    vi.advanceTimersByTime(31 * 60_000);
    const result = await niadra.context(inConversation);
    expect(result.source).toBe("none");
    expect(result.text).toBe("");
  });

  it("purges every cached pack on 401 and returns empty", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() }, { body: contextBody() }, problem(401, "unauthenticated"));
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    await niadra.context({ ...inConversation, conversation_id: "other" });
    vi.advanceTimersByTime(11 * 60_000);

    const revoked = await niadra.context(inConversation);
    expect(revoked).toMatchObject({ text: "", source: "none" });

    vi.setSystemTime(new Date("2026-09-22T17:00:00Z"));
    const other = await niadra.context({ ...inConversation, conversation_id: "other" });
    expect(other.source).toBe("none");
  });

  it("purges the pack on 403 seen by a background refresh, so the next call returns empty", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() }, problem(403, "forbidden"));
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    vi.advanceTimersByTime(11_000);
    const stale = await niadra.context(inConversation);
    expect(stale.source).toBe("stale");
    await settle();
    const after = await niadra.context(inConversation);
    expect(after.source).toBe("none");
    expect(after.error).toBeInstanceOf(NiadraPermissionError);
  });

  it("purges packs when any request, even a batch, comes back 401", async () => {
    const server = new MockServer()
      .on("POST /v1/context", { body: contextBody() }, problem(503, "unavailable"))
      .on("POST /v1/batch", problem(401, "unauthenticated"));
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    await niadra.identify({ handles: [marina, { type: "email", value: "m@example.com" }] });
    vi.advanceTimersByTime(11 * 60_000);
    const result = await niadra.context(inConversation);
    expect(result.source).toBe("none");
  });

  it("does not cache outside a conversation or task", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() });
    const niadra = makeClient(server);
    await niadra.context({ subject: marina });
    await niadra.context({ subject: marina });
    expect(server.calls).toHaveLength(2);
  });

  it("can be bypassed per call or turned off", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() });
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    await niadra.context(inConversation, { cache: false });
    const off = makeClient(server, { cache: false });
    await off.context(inConversation);
    await off.context(inConversation);
    expect(server.calls).toHaveLength(4);
  });

  it("keys packs by everything that changes the compilation", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() });
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    await niadra.context({ ...inConversation, verification: "V2" });
    await niadra.context({ ...inConversation, view: "voice" });
    await niadra.context({ ...inConversation, view: "chat" });
    expect(server.calls).toHaveLength(3);
  });

  it("drops a conversation's packs after a successful verify()", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() }).on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    const verified = await niadra.verify({ handle: marina, method: "otp_whatsapp", level: "V2", conversation_id: "wa-8812" });
    expect(verified.ok).toBe(true);
    await niadra.context(inConversation);
    expect(server.callsTo("POST /v1/context")).toHaveLength(2);
  });
  it("shares one entry between plain and delta reads of a conversation", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() });
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    await niadra.context({ ...inConversation, delta: true });
    expect(server.calls).toHaveLength(1);
  });

  it("hands each delta out once", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody({ delta: "[New] refund" }) });
    const niadra = makeClient(server);
    const first = await niadra.context({ ...inConversation, delta: true });
    const again = await niadra.context({ ...inConversation, delta: true });
    expect(first.suffix).toBe("[New] refund");
    expect(again.source).toBe("cache");
    expect(again.suffix).toBe("");
  });

  it("keeps a delta fetched in the background for the next read", async () => {
    const server = new MockServer().on(
      "POST /v1/context",
      { body: contextBody() },
      { body: contextBody({ not_modified: true, text: null, path: "not_modified", delta: "[New] refund" }) },
    );
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    vi.advanceTimersByTime(11_000);
    expect((await niadra.context({ ...inConversation, delta: true })).suffix).toBe("");
    await settle();
    const next = await niadra.context({ ...inConversation, delta: true });
    expect(next.source).toBe("cache");
    expect(next.text).toContain("Marina");
    expect(next.suffix).toBe("[New] refund");
  });

  it("drops deltas pending against a pack the server replaced", () => {
    const cache = new ContextCache(DEFAULT_CACHE);
    cache.store("k", "conversation:c", contextBody());
    cache.store("k", "conversation:c", contextBody({ delta: "[New] refund" }));
    cache.store("k", "conversation:c", contextBody({ etag: "etag-2", text: "<context>v2</context>" }));
    expect(cache.take("k")).toBeNull();
    expect(cache.take("missing")).toBeUndefined();
  });

  it("serves the last good pack, with its pending deltas, when a request fails", async () => {
    const server = new MockServer().on(
      "POST /v1/context",
      { body: contextBody() },
      { body: contextBody({ not_modified: true, text: null, path: "not_modified", delta: "[New] refund" }) },
      problem(503, "unavailable"),
    );
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    vi.advanceTimersByTime(11_000);
    await niadra.context({ ...inConversation, delta: true });
    await settle();
    vi.advanceTimersByTime(11 * 60_000);
    const failed = await niadra.context({ ...inConversation, delta: true });
    expect(failed.source).toBe("fallback");
    expect(failed.text).toContain("Marina");
    expect(failed.suffix).toBe("[New] refund");
  });

  it("never replaces a good pack with a degraded answer", async () => {
    const server = new MockServer().on(
      "POST /v1/context",
      { body: contextBody() },
      { body: contextBody({ text: null, etag: "", degraded: true, path: "t4" }) },
    );
    const niadra = makeClient(server);
    await niadra.context(inConversation);
    vi.advanceTimersByTime(11 * 60_000);
    const degraded = await niadra.context(inConversation);
    expect(degraded.source).toBe("fallback");
    expect(degraded.error).toBeNull();
    expect(degraded.text).toContain("Marina");
  });
});

describe("ContextCache", () => {
  it("evicts the least recently used pack past maxEntries", () => {
    const cache = new ContextCache({ ...DEFAULT_CACHE, maxEntries: 2 });
    cache.store("a", "s", contextBody());
    cache.store("b", "s", contextBody());
    cache.lookup("a");
    cache.store("c", "s", contextBody());
    expect(cache.lookup("a")).not.toBeNull();
    expect(cache.lookup("b")).toBeNull();
    expect(cache.size).toBe(2);
  });

  it("ignores answers to requests that started before a purge", () => {
    const cache = new ContextCache(DEFAULT_CACHE);
    const generation = cache.generation;
    cache.clear();
    cache.store("a", "s", contextBody(), generation);
    expect(cache.lookup("a")).toBeNull();
  });

  it("drops a whole conversation at once", () => {
    const cache = new ContextCache(DEFAULT_CACHE);
    cache.store("a", "conversation:1", contextBody());
    cache.store("b", "conversation:1", contextBody());
    cache.store("c", "conversation:2", contextBody());
    cache.deleteScope("conversation:1");
    expect(cache.size).toBe(1);
  });

  it("classifies entries by age", () => {
    let now = 0;
    const cache = new ContextCache({ ttlMs: 10, staleWhileRevalidateMs: 10, maxStaleMs: 30, maxEntries: 5 }, () => now);
    cache.store("a", "s", contextBody());
    expect(cache.lookup("a")?.freshness).toBe("fresh");
    now = 15;
    expect(cache.lookup("a")?.freshness).toBe("stale");
    now = 25;
    expect(cache.lookup("a")?.freshness).toBe("expired");
    now = 31;
    expect(cache.lookup("a")).toBeNull();
  });

});
