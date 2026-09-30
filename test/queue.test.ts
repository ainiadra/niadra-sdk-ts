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

  it("by default sends a turn at once and anything else within a second", async () => {
    vi.useFakeTimers();
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    niadra.track({ ...message("a turn"), conversation_id: "wa-1" });
    await vi.advanceTimersByTimeAsync(0);
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

describe("one batch in flight per client", () => {
  // A flush that sends while the background sender has the turns in flight puts
  // `conversation.ended` beside them; it can land first, and the session reopens.
  function slowServer(firstDelayMs: number) {
    const state = { inFlight: 0, maxInFlight: 0, answered: [] as string[][] };
    const server = new MockServer().on("POST /v1/batch", (request) => {
      const first = server.calls.length === 1;
      const kinds = heartbeatFree(request.body.items).map((item) => item.type);
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      const delay = first ? firstDelayMs : 1;
      setTimeout(() => {
        state.inFlight--;
        state.answered.push(kinds);
      }, delay);
      return { ...batchOk(), delay };
    });
    return { server, state };
  }

  async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  const eagerTurns = { queue: { flushAt: 100, flushIntervalMs: 60_000, turnFlushIntervalMs: 5 } };

  it("sends conversation.ended after the turns the background send has in flight", async () => {
    const { server, state } = slowServer(100);
    const niadra = makeClient(server, eagerTurns);
    const convo = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "wa-1" });
    convo.customer("I was charged twice");
    convo.customer("on the 12th");
    await until(() => server.calls.length === 1);
    const ended = convo.end();
    await niadra.flush();
    expect((await ended).ok).toBe(true);
    expect(state.maxInFlight).toBe(1);
    expect(state.answered).toEqual([["event", "event"], ["conversation.ended"]]);
  });

  it("flush() with an empty queue waits for the batch in flight", async () => {
    const { server, state } = slowServer(100);
    const niadra = makeClient(server, eagerTurns);
    niadra.track({ ...message("I was charged twice"), conversation_id: "wa-1" });
    await until(() => server.calls.length === 1);
    await niadra.flush();
    expect(state.answered).toEqual([["event"]]);
  });

  it("shutdown() waits for the batch in flight, then sends the rest in order", async () => {
    const { server, state } = slowServer(100);
    const niadra = makeClient(server, eagerTurns);
    niadra.track({ ...message("I was charged twice"), conversation_id: "wa-1" });
    await until(() => server.calls.length === 1);
    niadra.track(message("after the turn"));
    await niadra.shutdown();
    expect(state.maxInFlight).toBe(1);
    expect(state.answered).toEqual([["event"], ["event"]]);
    expect(server.calls.map((call) => call.body.items[0].content.text)).toEqual(["I was charged twice", "after the turn"]);
  });
});

describe("turns leave at once and coalesce behind the batch in flight", () => {
  function timedServer(delayMs: number) {
    const state = { inFlight: 0, maxInFlight: 0, texts: [] as string[] };
    const server = new MockServer().on("POST /v1/batch", (request) => {
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      const items = heartbeatFree(request.body.items);
      setTimeout(() => {
        state.inFlight--;
        state.texts.push(...items.map((item: any) => item.content.text));
      }, delayMs);
      return { ...batchOk(items.length), delay: delayMs };
    });
    return { server, state };
  }

  async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  it("sends a burst of 40 turns as few batches, one in flight, in order", async () => {
    const { server, state } = timedServer(100);
    const niadra = makeClient(server);
    const texts = Array.from({ length: 40 }, (_, i) => `turn ${i}`);
    for (const text of texts) niadra.track({ ...message(text), conversation_id: "wa-1" });
    await until(() => state.texts.length === texts.length);
    expect(state.texts).toEqual(texts);
    expect(server.calls.length).toBeLessThanOrEqual(3);
    expect(state.maxInFlight).toBe(1);
  });

  it("at 25 turns a second, sends at most one request per round trip", async () => {
    const { server, state } = timedServer(100);
    const niadra = makeClient(server);
    const texts = Array.from({ length: 25 }, (_, i) => `turn ${i}`);
    const started = Date.now();
    for (const [i, text] of texts.entries()) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + i * 40 - Date.now())));
      niadra.track({ ...message(text), conversation_id: `wa-${i % 5}` });
    }
    await until(() => state.texts.length === texts.length);
    const elapsed = Date.now() - started;
    expect(state.texts).toEqual(texts);
    expect(state.maxInFlight).toBe(1);
    expect(server.calls.length).toBeLessThanOrEqual(elapsed / 100 + 2);
    expect(server.calls.length).toBeLessThan(texts.length);
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

  it("keeps a batch that still fails after maxAttempts and sends it again, with the same key", async () => {
    const logger = spyLogger();
    const server = new MockServer().on("POST /v1/batch", problem(500, "internal"), problem(500, "internal"), problem(500, "internal"), batchOk());
    const niadra = makeClient(server, { logger, queue: { ...fast, maxAttempts: 3 } });
    niadra.track(message("a"));
    await niadra.flush();
    expect(server.calls).toHaveLength(3);
    expect(logger.warn.mock.calls.some(([m]) => m.includes("could not deliver 1 events, will retry"))).toBe(true);
    await niadra.flush();
    expect(server.calls).toHaveLength(4);
    expect(new Set(server.calls.map((c) => c.body.items[0].idempotency_key)).size).toBe(1);
    await niadra.flush();
    expect(server.calls).toHaveLength(4);
  });

  it("pauses the background sends after a failed batch, then sends it once Niadra is back", async () => {
    const server = new MockServer().on("POST /v1/batch", new TypeError("fetch failed"), new TypeError("fetch failed"), batchOk());
    const niadra = makeClient(server, { queue: { ...fast, maxAttempts: 2, flushAt: 1, flushIntervalMs: 20 } });
    niadra.track(message("a"));
    for (let i = 0; i < 50 && server.calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    niadra.track(message("b"));
    expect(server.calls).toHaveLength(2);
    for (let i = 0; i < 100 && server.calls.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(server.calls).toHaveLength(3);
    expect(server.calls[2]!.body.items.map((item: { idempotency_key: string }) => item.idempotency_key)).toEqual([
      server.calls[0]!.body.items[0].idempotency_key,
      expect.any(String),
    ]);
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
      async (): Promise<BatchResponse> => ({ accepted: 1, duplicates: 0, errors: [{ index: 1, code: "invalid_input", detail: "channel" }], masked: {} }),
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
      return { accepted: items.length, duplicates: 0, errors: [], masked: {} };
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
    const send = vi.fn(async (): Promise<BatchResponse> => ({ accepted: 0, duplicates: 0, errors: [], masked: {} }));
    const queue = new EventQueue(send, DEFAULT_QUEUE, spyLogger());
    await queue.close();
    const settle = vi.fn();
    expect(queue.push({ type: "task.ended", idempotency_key: "a", task_id: "t", occurred_at: "x" }, settle)).toBe(false);
    expect(settle.mock.calls[0]![0].message).toContain("shut down");
  });
});
