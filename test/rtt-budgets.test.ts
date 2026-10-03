/**
 * The read budgets and the round trip to the region (B22): a default budget is what the API may take and the
 * measured round trip goes on top, so a caller far from the region (Sao Paulo, 170 ms from us-east-2) is not
 * timed out by the network; a budget the caller set stays a ceiling, and the SDK says once when the network
 * alone exceeds it.
 */
import { describe, expect, it } from "vitest";
import { NiadraTimeoutError } from "../src/index.js";
import { MockServer, contextBody, makeClient, marina, spyLogger } from "./helpers.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A region `rtt` ms away: the probe and every read answer that late. */
function farRegion(rtt: number): MockServer {
  return new MockServer()
    .on("GET /healthz", { status: 200, body: { status: "ok" }, delay: rtt })
    .on("POST /v1/context", { status: 200, body: contextBody(), delay: rtt + 30 });
}

describe("read budgets and the round trip", () => {
  it("measures the round trip when the client starts and adds it to the default budgets", async () => {
    const server = farRegion(400);
    const niadra = makeClient(server);
    await sleep(900); // the probe: two round trips
    expect(niadra.rtt).toBeGreaterThan(380);
    expect(server.callsTo("GET /healthz")).toHaveLength(2);
    const result = await niadra.context({ subject: marina, conversation_id: "c-far" }, { cache: false });
    expect(result.error).toBeNull();
    expect(result.text).toContain("Marina");
    await niadra.shutdown();
  });

  it("keeps a budget the caller set as a ceiling and says so once", async () => {
    const server = farRegion(400);
    const logger = spyLogger();
    const niadra = makeClient(server, { logger, timeouts: { context: 250 } });
    await sleep(900);
    const result = await niadra.context({ subject: marina, conversation_id: "c-ceiling" }, { cache: false });
    expect(result.error).toBeInstanceOf(NiadraTimeoutError);
    const warnings = logger.warn.mock.calls.map(([message]) => message);
    expect(warnings.filter((w) => w.includes("timeouts.context (250 ms) is shorter than the round trip"))).toHaveLength(1);
    expect(warnings.some((w) => w.includes("timeouts.navigation"))).toBe(false); // left at its default
    await niadra.shutdown();
  });

  it("says nothing about the voice budgets to a client that only chats", async () => {
    const server = farRegion(300);
    const logger = spyLogger();
    const niadra = makeClient(server, { logger });
    await sleep(700);
    expect(logger.warn).not.toHaveBeenCalled(); // a client that only chats hears nothing about voice budgets
    await niadra.shutdown();
  });
});
