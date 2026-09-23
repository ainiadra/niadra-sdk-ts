import { afterEach, describe, expect, it, vi } from "vitest";
import { registerExitFlush } from "../src/exit.js";
import { MockServer, batchOk, makeClient, marina } from "./helpers.js";

describe("flush on exit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("installs one beforeExit listener however many clients register", () => {
    const before = process.listenerCount("beforeExit");
    const offs = [registerExitFlush({ flush: async () => undefined }), registerExitFlush({ flush: async () => undefined })];
    expect(process.listenerCount("beforeExit")).toBe(before + 1);
    offs.forEach((off) => off());
    expect(process.listenerCount("beforeExit")).toBe(before);
  });

  it("flushes registered clients when the process is about to exit", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server, { flushOnExit: true, queue: { flushIntervalMs: 60_000 } });
    niadra.track({ channel: "app", speaker: "customer", handles: [marina], text: "bye" });
    process.emit("beforeExit", 0);
    await vi.waitFor(() => expect(server.calls).toHaveLength(1));
    await niadra.shutdown();
  });

  it("releases the listener on shutdown()", async () => {
    const before = process.listenerCount("beforeExit");
    const niadra = makeClient(new MockServer(), { flushOnExit: true });
    expect(process.listenerCount("beforeExit")).toBe(before + 1);
    await niadra.shutdown();
    expect(process.listenerCount("beforeExit")).toBe(before);
  });

  it("does nothing on runtimes without a Node process", () => {
    vi.stubGlobal("process", undefined);
    const off = registerExitFlush({ flush: async () => undefined });
    vi.unstubAllGlobals();
    expect(typeof off).toBe("function");
    off();
  });

  it("drops events tracked after shutdown()", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    await niadra.shutdown();
    expect(niadra.track({ channel: "app", speaker: "customer", handles: [marina], text: "late" })).toBeNull();
  });
});
