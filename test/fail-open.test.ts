import { describe, expect, it, vi } from "vitest";
import { Niadra, NiadraConfigError, NiadraConnectionError, silentLogger } from "../src/index.js";
import type { Niadra as Client } from "../src/index.js";
import { MockServer, makeClient, marina } from "./helpers.js";

/** Calls every public method once and returns what each resolved to. */
async function exercise(niadra: Client) {
  const convo = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "wa-1" });
  const task = niadra.task({ channel: "billing-agent", subject: marina });
  return {
    context: await niadra.context({ subject: marina, conversation_id: "wa-1" }),
    search: await niadra.search({ subject: marina, query: "visit" }),
    timeline: await niadra.timeline({ subject: marina }),
    open: await niadra.open("ep-1"),
    subjectToken: await niadra.subjectToken({ subject: marina }),
    track: niadra.track({ channel: "whatsapp", speaker: "customer", handles: [marina], text: "hi" }),
    action: niadra.action({ channel: "billing-agent", handles: [marina], operation: "credit" }),
    identify: await niadra.identify({ handles: [marina, { type: "email", value: "m@example.com" }] }),
    verify: await niadra.verify({ handle: marina, method: "otp_sms", level: "V2" }),
    handoff: await niadra.handoff({ conversation_id: "wa-1", target: "human" }),
    tool: await niadra.tools(marina).call("search_customer_history", { query: "visit" }),
    convoContext: await convo.context(),
    convoEnd: await convo.end(),
    taskContext: await task.context(),
    taskEnd: await task.end(),
    flush: await niadra.flush(),
    shutdown: await niadra.shutdown(),
  };
}

describe("fail-open", () => {
  it("resolves every method with an empty result when the network is down", async () => {
    const server = new MockServer()
      .on("POST /v1/context", new TypeError("fetch failed"))
      .on("POST /v1/history/search", new TypeError("fetch failed"))
      .on("POST /v1/history/timeline", new TypeError("fetch failed"))
      .on("GET /v1/history/items/ep-1", new TypeError("fetch failed"))
      .on("POST /v1/subject-tokens", new TypeError("fetch failed"))
      .on("POST /v1/batch", new TypeError("fetch failed"));
    const results = await exercise(makeClient(server, { queue: { retryDelayMs: 1, maxRetryDelayMs: 2 } }));

    expect(results.context).toMatchObject({ text: "", suffix: "", source: "none" });
    expect(results.context.error).toBeInstanceOf(NiadraConnectionError);
    for (const read of [results.search, results.timeline, results.open, results.subjectToken]) {
      expect(read.data).toBeNull();
      expect(read.error).toBeInstanceOf(NiadraConnectionError);
    }
    for (const write of [results.identify, results.verify, results.handoff, results.convoEnd, results.taskEnd]) {
      expect(write.ok).toBe(false);
    }
    expect(results.track).not.toBeNull();
    expect(JSON.parse(results.tool)).toMatchObject({ error: "unavailable" });
    expect(results.convoContext.text).toBe("");
    expect(results.taskContext.text).toBe("");
  });

  it("resolves every method without sending anything when the client has no key", async () => {
    vi.stubEnv("NIADRA_API_KEY", "");
    const fetchSpy = vi.fn();
    const niadra = new Niadra({ fetch: fetchSpy, logger: silentLogger });
    const results = await exercise(niadra);
    vi.unstubAllEnvs();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(results.context.error).toBeInstanceOf(NiadraConfigError);
    expect(results.search.error).toBeInstanceOf(NiadraConfigError);
    expect(results.track).toBeNull();
    expect(results.action).toBeNull();
    expect(results.identify.ok).toBe(false);
    expect(niadra.tools(marina).definitions).toHaveLength(3);
  });

  it("never lets an unexpected throw from fetch escape", async () => {
    const niadra = makeClient(new MockServer(), {
      fetch: () => {
        throw new Error("synchronous explosion");
      },
    });
    const result = await niadra.context({ subject: marina });
    expect(result.source).toBe("none");
  });
});

describe("strict mode", () => {
  it("throws from every read that fails", async () => {
    const server = new MockServer();
    const niadra = makeClient(server, {
      strict: true,
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(niadra.context({ subject: marina })).rejects.toBeInstanceOf(NiadraConnectionError);
    await expect(niadra.search({ subject: marina, query: "x" })).rejects.toBeInstanceOf(NiadraConnectionError);
    await expect(niadra.timeline({ subject: marina })).rejects.toBeInstanceOf(NiadraConnectionError);
    await expect(niadra.open("ep-1")).rejects.toBeInstanceOf(NiadraConnectionError);
    await expect(niadra.subjectToken({ subject: marina })).rejects.toBeInstanceOf(NiadraConnectionError);
  });

  it("rejects writes that fail", async () => {
    const niadra = makeClient(new MockServer(), {
      strict: true,
      fetch: () => Promise.reject(new TypeError("fetch failed")),
      queue: { maxAttempts: 1 },
    });
    await expect(niadra.identify({ handles: [marina, marina] })).rejects.toBeInstanceOf(NiadraConnectionError);
    await expect(niadra.identify({ handles: [marina] })).rejects.toThrow(/2 to 16/);
  });
});
