/**
 * While a conversation is open and in use, the client keeps its connection to the region open (B23): a turn after
 * a long pause would otherwise pay TCP, TLS and often DNS again, 330 to 650 ms from Sao Paulo.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeepWarm } from "../src/warm.js";
import { MockServer, makeClient, marina } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("keep-warm", () => {
  it("pings only while a conversation is open, used lately and the line is quiet", () => {
    const warm = new KeepWarm(true);
    const session = {};
    warm.add("conversation:c1", session, 0);
    expect(warm.step(30_000, 0)).toBe("wait");
    expect(warm.step(120_000, 0)).toBe("ping");
    expect(warm.step(700_000, 0)).toBe("stop"); // not used for more than ten minutes
    warm.end("conversation:c1");
    expect(warm.step(120_000, 100_000)).toBe("stop");
  });

  it("keeps the line warm every 100 s of quiet and stops when the conversation ends", async () => {
    vi.useFakeTimers();
    const server = new MockServer();
    const niadra = makeClient(server);
    await vi.advanceTimersByTimeAsync(10);
    const probes = server.probes.length; // the round trip probe at start
    const conversation = niadra.conversation({ subject: marina, channel: "chat", conversation_id: "c-warm" });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(server.probes.length).toBe(probes + 1);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(server.probes.length).toBe(probes + 2);
    void conversation.end();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(server.probes.length).toBe(probes + 2);
    await niadra.shutdown();
  });

  it("never pings with keepWarm: false", async () => {
    vi.useFakeTimers();
    const server = new MockServer();
    const niadra = makeClient(server, { keepWarm: false });
    await vi.advanceTimersByTimeAsync(10);
    const probes = server.probes.length;
    const conversation = niadra.conversation({ subject: marina, channel: "chat", conversation_id: "c-cold" });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(server.probes.length).toBe(probes);
    expect(conversation.id).toBe("c-cold");
    await niadra.shutdown();
  });
});
