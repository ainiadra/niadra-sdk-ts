/**
 * A voice read keeps its turn's budget whatever the connection (benchmark of 09/10/2026, memory slowed to 2 s):
 * the cold-connection allowance (`timeouts.connect`) took the first voice read of a new client to 1.2 s, past a
 * 1 s voice turn. Chat and task reads keep the allowance and the first-read budget, which fixed first reads that
 * timed out while their pack compiled.
 */
import { describe, expect, it } from "vitest";
import { NiadraTimeoutError } from "../src/index.js";
import { Transport, voiced } from "../src/transport.js";
import type { RequestSpec } from "../src/transport.js";
import { KEY, MockServer, contextBody, makeClient, marina, spyLogger } from "./helpers.js";

/** Every request waits `ms`, the probe included: the fault proxy of the benchmark. */
function slow(ms: number): MockServer {
  return new MockServer()
    .on("GET /healthz", { status: 200, body: { status: "ok" }, delay: ms })
    .on("POST /v1/context", { status: 200, body: contextBody(), delay: ms })
    .on("POST /v1/history/search", { status: 200, body: { items: [] }, delay: ms })
    .on("GET /v1/agent-memory/block", { status: 200, body: {}, delay: ms });
}

describe("the cold-connection allowance and a voice turn", () => {
  it("never takes a request past its ceiling", async () => {
    const answers = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response("{}", { status: 200 })), 100);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as typeof fetch;
    const transport = new Transport({
      baseURL: "https://api.example.test",
      apiKey: KEY,
      fetch: answers,
      defaultHeaders: {},
      logger: spyLogger(),
      coldAllowanceMs: 1000,
      keepAliveMs: 30_000,
    });
    const read: RequestSpec = { method: "POST", path: "/v1/context", body: {}, timeoutMs: 50, retry: { kind: "read", maxAttempts: 1 } };
    const voice = await transport.request(voiced(read, true)).catch((e: unknown) => e);
    expect(voice).toBeInstanceOf(NiadraTimeoutError);
    expect(voice).toMatchObject({ timeoutMs: 50 });
    expect((await transport.request(read)).status).toBe(200);
    expect(voiced(read, false).ceilingMs).toBeUndefined();
  });

  it("answers a voice read of a new client within the voice budget when memory is slow", async () => {
    const niadra = makeClient(slow(2000), { timeouts: { connect: 1000 } });
    const started = Date.now();
    const context = await niadra.context({ subject: marina, view: "voice", conversation_id: "call-1" }, { cache: false });
    const elapsed = Date.now() - started;
    await niadra.shutdown();
    expect(context.error).not.toBeNull(); // a 2 s memory cannot answer a voice turn
    expect(elapsed).toBeLessThan(500); // a voice read never takes the cold-connection allowance
  });

  it("answers a voice search of a new client within the voice budget when memory is slow", async () => {
    const niadra = makeClient(slow(2000), { timeouts: { connect: 1000 } });
    const kit = niadra.tools(marina, { conversation_id: "call-1", voice: true });
    const started = Date.now();
    await kit.call("search_customer_history", { query: "pedido" });
    const elapsed = Date.now() - started;
    await niadra.shutdown();
    expect(elapsed).toBeLessThan(600); // a voice search keeps `timeouts.navigationVoice`
  });

  it("answers the agent memory of a new client within the voice budget when memory is slow", async () => {
    const niadra = makeClient(slow(2000), { timeouts: { connect: 1000 } });
    const started = Date.now();
    const block = await niadra.agentMemory({ view: "voice" });
    const elapsed = Date.now() - started;
    await niadra.shutdown();
    expect(block.error).not.toBeNull();
    expect(elapsed).toBeLessThan(500); // the voice view keeps `timeouts.contextVoice`
  });

  it("still gives a chat read of a new client the first-read and connection allowances", async () => {
    const niadra = makeClient(slow(900), { timeouts: { connect: 1000 } });
    const context = await niadra.context({ subject: marina, view: "chat", conversation_id: "c-1" }, { cache: false });
    await niadra.shutdown();
    expect(context.error).toBeNull(); // 0.9 s for a first chat read: within the first-read and connection allowances
  });
});
