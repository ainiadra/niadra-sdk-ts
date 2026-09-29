import { describe, expect, it } from "vitest";
import { DELETE, Niadra, silentLogger } from "../src/index.js";
import { Cell } from "./support/cell.js";
import { KEY, marina } from "./helpers.js";

function setup(): { cell: Cell; niadra: Niadra } {
  const cell = new Cell();
  cell.features.add("agent_state");
  return { cell, niadra: new Niadra({ apiKey: KEY, fetch: cell.fetch, logger: silentLogger, flushOnExit: false, turns: { intervalMs: 3_600_000 } }) };
}

const key = (id: string): string => JSON.stringify(["conversation", id, "closing"]);

describe("the agent's working state", () => {
  it("creates by compare-and-swap and conflicts at an old version", async () => {
    const { niadra } = setup();
    const state = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-1", agent_id: "closing" }).agentState;
    expect((await state.get()).version).toBe(0);
    expect(await state.put({ step: "quote" }, { mode: "cas", ifVersion: 0 })).toMatchObject({ stored: true, version: 1 });
    expect(await state.put({ step: "close" }, { mode: "cas", ifVersion: 0 })).toMatchObject({ stored: false, reason: "conflict" });
    expect((await state.get()).body).toEqual({ step: "quote" });
  });

  it("merges by key and keeps a removed field gone", async () => {
    const { niadra } = setup();
    const state = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-2", agent_id: "closing" }).agentState;
    await state.put({ cart: ["sku-1"], offer: { status: "shown" } });
    await state.put({ offer: { status: "accepted" } });
    await state.put({ cart: DELETE });
    expect(await state.get()).toMatchObject({ version: 3, body: { offer: { status: "accepted" } } });
  });

  it("keeps the previous state over the cap, without failing", async () => {
    const { niadra } = setup();
    const state = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-3", agent_id: "closing" }).agentState;
    await state.put({ note: "short" });
    expect(await state.put({ note: "x".repeat(20_000) })).toMatchObject({ stored: false, reason: "over_cap", version: 1 });
    expect((await state.get()).body).toEqual({ note: "short" });
  });

  it("never reads behind its own write", async () => {
    const { cell, niadra } = setup();
    const state = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-4", agent_id: "closing" }).agentState;
    await state.put({ step: "quote" });
    await state.put({ step: "close" });
    cell.agentStates.set(key("c-4"), { body: { step: "quote" }, version: 1 });
    expect((await state.get()).version).toBe(2);
  });

  it("keeps a write made with Niadra down and sends it again", async () => {
    const { cell, niadra } = setup();
    const state = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-5", agent_id: "closing" }).agentState;
    await state.put({ step: "quote" }, { mode: "cas", ifVersion: 0 });
    cell.failNext("/", 503, 1000);
    expect(await state.put({ step: "close" }, { mode: "cas", ifVersion: 1 })).toMatchObject({ stored: true, pending: true, version: 2 });
    expect(await state.get()).toMatchObject({ degraded: true, body: { step: "close" }, version: 2 });
    cell.clearFailures();
    await niadra.flush();
    expect((await state.get()).body).toEqual({ step: "close" });
    expect(state.conflicts).toEqual([]);
  });

  it("reports a write sent again that met a newer version", async () => {
    const { cell, niadra } = setup();
    const state = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-6", agent_id: "closing" }).agentState;
    await state.put({ step: "quote" }, { mode: "cas", ifVersion: 0 });
    cell.failNext("/", 503, 1000);
    expect((await state.put({ step: "close" }, { mode: "cas", ifVersion: 1 })).pending).toBe(true);
    cell.clearFailures();
    cell.agentStates.set(key("c-6"), { body: { step: "lost" }, version: 2 });
    await niadra.flush();
    expect(state.conflicts).toEqual([{ scope: { kind: "conversation", id: "c-6" }, agent: "closing", body: { step: "close" }, ifVersion: 1 }]);
    expect((await state.get()).body).toEqual({ step: "lost" });
  });
});
