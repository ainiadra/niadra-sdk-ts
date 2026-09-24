import { afterEach, describe, expect, it, vi } from "vitest";
import { EventQueue, isTurn } from "../src/queue.js";
import { DEFAULT_QUEUE } from "../src/options.js";
import type { BatchItem, BatchResponse } from "../src/index.js";
import { MockServer, batchOk, makeClient, marina, problem, spyLogger } from "./helpers.js";

const message = (text: string) => ({ channel: "whatsapp", speaker: "customer" as const, handles: [marina], text });

function heartbeatFree(items: BatchItem[]): BatchItem[] {
  return items.filter((item) => item.type !== "heartbeat");
}

describe("batching", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends as soon as flushAt items are waiting", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk(3));
    const niadra = makeClient(server, { queue: { flushAt: 3, flushIntervalMs: 60_000 } });
    niadra.track(message("a"));
    niadra.track(message("b"));
    expect(server.calls).toHaveLength(0);
    niadra.track(message("c"));
    await niadra.flush();
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.body.items).toHaveLength(3);
  });

  it("sends whatever is waiting after flushIntervalMs", async () => {
    vi.useFakeTimers();
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server, { queue: { flushAt: 100, flushIntervalMs: 1_000 } });
    niadra.track(message("a"));
    await vi.advanceTimersByTimeAsync(999);
    expect(server.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls).toHaveLength(1);
  });

  it("sends a conversation turn after turnFlushIntervalMs, with what was already waiting", async () => {
    vi.useFakeTimers();
    const server = new MockServer().on("POST /v1/batch", batchOk(2));
    const niadra = makeClient(server, { queue: { flushAt: 100, flushIntervalMs: 60_000, turnFlushIntervalMs: 200 } });
    niadra.track(message("outside any conversation"));
    await vi.advanceTimersByTimeAsync(500);
    expect(server.calls).toHaveLength(0);
    niadra.track({ ...message("I was charged twice"), conversation_id: "wa-1" });
    await vi.advanceTimersByTimeAsync(199);
    expect(server.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls).toHaveLength(1);
    const texts = server.calls[0]!.body.items.map((item: any) => item.content.text);
    expect(texts).toEqual(["outside any conversation", "I was charged twice"]);
  });

  it("by default sends a turn within 200 ms and anything else within a second", async () => {
    vi.useFakeTimers();
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    niadra.track({ ...message("a turn"), conversation_id: "wa-1" });
    await vi.advanceTimersByTimeAsync(199);
    expect(server.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls).toHaveLength(1);
    niadra.track(message("no conversation"));
    niadra.track({ channel: "erp", speaker: "system", kind: "system_event", canonical_type: "invoice.credited", object_refs: ["invoice:erp:0823"], conversation_id: "wa-1" });
    await vi.advanceTimersByTimeAsync(999);
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls).toHaveLength(2);
  });

  it("keeps a send that is due sooner when a later item would wait longer", async () => {
    vi.useFakeTimers();
    const server = new MockServer().on("POST /v1/batch", batchOk(2));
    const niadra = makeClient(server, { queue: { flushAt: 100, flushIntervalMs: 1_000, turnFlushIntervalMs: 200 } });
    niadra.track({ ...message("a turn"), conversation_id: "wa-1" });
    niadra.track(message("no conversation"));
    await vi.advanceTimersByTimeAsync(200);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.body.items).toHaveLength(2);
  });

  it("counts only messages of a conversation as turns", () => {
    const base = { type: "event", kind: "message", idempotency_key: "k", channel: "chat", speaker: { role: "customer" }, occurred_at: "2026-09-24T12:00:00Z" } as const;
    expect(isTurn({ ...base, conversation_id: "wa-1" })).toBe(true);
    expect(isTurn(base)).toBe(false);
    expect(isTurn({ ...base, kind: "action", conversation_id: "wa-1" })).toBe(false);
    expect(isTurn({ type: "conversation.ended", conversation_id: "wa-1" } as BatchItem)).toBe(false);
  });

  it("splits large queues into batches of maxBatchSize, in order", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server, { queue: { flushAt: 1_000, maxBatchSize: 2 } });
    for (const text of ["1", "2", "3", "4", "5"]) niadra.track(message(text));
    await niadra.flush();
    const texts = server.calls.map((call) => call.body.items.map((item: any) => item.content.text));
    expect(texts).toEqual([["1", "2"], ["3", "4"], ["5"]]);
  });

  it("never exceeds the server's 500-item batch limit", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server, { queue: { flushAt: 10_000, maxBatchSize: 5_000 } });
    for (let i = 0; i < 600; i++) niadra.track(message(String(i)));
    await niadra.flush();
    expect(server.calls.map((call) => call.body.items.length)).toEqual([499, 101]);
  });

  it("drops new events when the queue is full, and warns once", async () => {
    const logger = spyLogger();
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server, { logger, queue: { flushAt: 100, maxQueueSize: 2 } });
    expect(niadra.track(message("1"))).not.toBeNull();
    expect(niadra.track(message("2"))).not.toBeNull();
    expect(niadra.track(message("3"))).toBeNull();
    expect(niadra.track(message("4"))).toBeNull();
    expect(logger.warn.mock.calls.filter(([m]) => m.includes("queue is full"))).toHaveLength(1);
    await niadra.flush();
    expect(server.calls[0]!.body.items).toHaveLength(2);
  });

  it("serializes concurrent flushes", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const server = new MockServer().on("POST /v1/batch", () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => inFlight--, 5);
      return { ...batchOk(), delay: 5 };
    });
    const niadra = makeClient(server, { queue: { flushAt: 1, maxBatchSize: 1 } });
    niadra.track(message("a"));
    niadra.track(message("b"));
    niadra.track(message("c"));
    await Promise.all([niadra.flush(), niadra.flush()]);
    expect(maxInFlight).toBe(1);
    expect(server.calls).toHaveLength(3);
  });
});

describe("retries", () => {
  const fast = { retryDelayMs: 1, maxRetryDelayMs: 5 };

  it("retries transient failures with backoff, up to maxAttempts", async () => {
    const server = new MockServer().on("POST /v1/batch", problem(503, "unavailable"), new TypeError("reset"), batchOk());
    const niadra = makeClient(server, { queue: fast });
    niadra.track(message("a"));
    await niadra.flush();
    expect(server.calls).toHaveLength(3);
    expect(new Set(server.calls.map((c) => c.body.items[0].idempotency_key)).size).toBe(1);
  });

  it("gives up after maxAttempts and drops the batch with a log line", async () => {
    const logger = spyLogger();
    const server = new MockServer().on("POST /v1/batch", problem(500, "internal"));
    const niadra = makeClient(server, { logger, queue: { ...fast, maxAttempts: 3 } });
    niadra.track(message("a"));
    await niadra.flush();
    expect(server.calls).toHaveLength(3);
    expect(logger.warn.mock.calls.some(([m]) => m.includes("dropped 1 events"))).toBe(true);
    await niadra.flush();
    expect(server.calls).toHaveLength(3);
  });

  it("never retries a 4xx other than 408, 421 and 429", async () => {
    const server = new MockServer().on("POST /v1/batch", problem(400, "invalid_input"));
    const niadra = makeClient(server, { queue: fast });
    niadra.track(message("a"));
    await niadra.flush();
    expect(server.calls).toHaveLength(1);
  });

  it("retries 421 at once and 429 after Retry-After", async () => {
    const server = new MockServer().on(
      "POST /v1/batch",
      problem(421, "wrong_cell"),
      problem(429, "rate_limited", { "retry-after": "0.02" }),
      batchOk(),
    );
    const niadra = makeClient(server, { queue: { ...fast, maxRetryDelayMs: 100, maxAttempts: 3 } });
    niadra.track(message("a"));
    const started = Date.now();
    await niadra.flush();
    expect(server.calls).toHaveLength(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it("rejects flush() in strict mode when a batch is lost", async () => {
    const server = new MockServer().on("POST /v1/batch", problem(400, "invalid_input"));
    const niadra = makeClient(server, { strict: true });
    niadra.track(message("a"));
    await expect(niadra.flush()).rejects.toMatchObject({ status: 400 });
  });
});

describe("partial failures and heartbeats", () => {
  it("settles each item with its own error from a 207", async () => {
    const send = vi.fn(
      async (): Promise<BatchResponse> => ({ accepted: 1, duplicates: 0, errors: [{ index: 1, code: "invalid_input", detail: "channel" }] }),
    );
    const queue = new EventQueue(send, { ...DEFAULT_QUEUE, flushAt: 100 }, spyLogger());
    const outcomes: (string | null)[] = [];
    queue.push({ type: "task.ended", idempotency_key: "a", task_id: "t", occurred_at: "x" }, (e) => outcomes.push(e?.message ?? null));
    queue.push({ type: "task.ended", idempotency_key: "b", task_id: "t", occurred_at: "x" }, (e) => outcomes.push(e?.message ?? null));
    const report = await queue.flush();
    expect(outcomes).toEqual([null, "invalid_input: channel"]);
    expect(report).toMatchObject({ sent: 1, failed: 1 });
  });

  it("adds a heartbeat with the previous minute's count to the next batch", async () => {
    let now = Date.parse("2026-09-22T17:00:00Z");
    const batches: BatchItem[][] = [];
    const send = vi.fn(async (items: BatchItem[]): Promise<BatchResponse> => {
      batches.push(items);
      return { accepted: items.length, duplicates: 0, errors: [] };
    });
    const queue = new EventQueue(send, { ...DEFAULT_QUEUE, flushAt: 100 }, spyLogger(), () => now);
    const item = (key: string): BatchItem => ({ type: "task.ended", idempotency_key: key, task_id: "t", occurred_at: "x" });

    queue.push(item("a"));
    queue.push(item("b"));
    await queue.flush();
    expect(batches[0]!.some((i) => i.type === "heartbeat")).toBe(false);

    now += 61_000;
    queue.push(item("c"));
    await queue.flush();
    expect(batches[1]!.at(-1)).toEqual({ type: "heartbeat", window_start: "2026-09-22T17:00:00.000Z", sent: 2 });
    expect(heartbeatFree(batches[1]!)).toHaveLength(1);
  });

  it("refuses items after close()", async () => {
    const send = vi.fn(async (): Promise<BatchResponse> => ({ accepted: 0, duplicates: 0, errors: [] }));
    const queue = new EventQueue(send, DEFAULT_QUEUE, spyLogger());
    await queue.close();
    const settle = vi.fn();
    expect(queue.push({ type: "task.ended", idempotency_key: "a", task_id: "t", occurred_at: "x" }, settle)).toBe(false);
    expect(settle.mock.calls[0]![0].message).toContain("shut down");
  });
});
