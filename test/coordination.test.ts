import { describe, expect, it } from "vitest";
import { NiadraContactTokenError, Niadra, silentLogger } from "../src/index.js";
import type { Handle } from "../src/index.js";
import { Cell, SPACE } from "./support/cell.js";
import { KEY, marina } from "./helpers.js";

const OTHER: Handle = { type: "phone_e164", value: "+5511998765432" };
const GATEWAY_KEY = new Uint8Array(32).fill(107);
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function setup(): { cell: Cell; niadra: Niadra } {
  const cell = new Cell();
  cell.features.add("coordination");
  cell.gateways.set("wa_gateway", GATEWAY_KEY);
  const niadra = new Niadra({ apiKey: KEY, fetch: cell.fetch, logger: silentLogger, flushOnExit: false, turns: { intervalMs: 3_600_000 } });
  return { cell, niadra };
}

describe("coordination in the agent's process", () => {
  it("lets a farewell go once and declares its effect", async () => {
    const { cell, niadra } = setup();
    const key = "farewell:c-1";
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-1", agent_id: "closing" });
    const second = await conversation.turn(async () => {
      const first = await conversation.check("farewell", { purpose: "service", effectKey: key });
      expect([first.decision, first.effect?.state]).toEqual(["allow", "none"]);
      conversation.declare.effect(key, "done");
      await niadra.flush();
      return conversation.check("farewell", { purpose: "service", effectKey: key });
    });
    expect([second.decision, second.reasons]).toEqual(["deny", ["effect_done"]]);
    expect(cell.declarations[0]?.detail).toEqual({ effect_key: key, state: "done", attempt: 1 });
    await niadra.flush();
    const [record] = [...cell.turns.values()];
    expect((record?.coordination as { decision: string }[]).map((c) => c.decision)).toEqual(["allow", "deny"]);
    expect(record?.effects).toEqual([{ key, state: "done" }]);
  });

  it.each([
    ["marketing", "outbound", undefined, "defer", "unavailable"],
    ["collection", "outbound", undefined, "defer", "unavailable"],
    ["service", "outbound", undefined, "allow", "unchecked"],
    ["transactional", "outbound", undefined, "allow", "unchecked"],
    ["marketing", "inbound", undefined, "allow", "unchecked"],
    ["service", "outbound", "farewell:c-2", "defer", "unavailable"],
  ] as const)("with Niadra down, a %s %s check fails its own way", async (purpose, direction, effectKey, decision, reason) => {
    const { cell, niadra } = setup();
    cell.failNext("/", 503, 100);
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-2" });
    const result = await conversation.check("offer", { purpose, direction, ...(effectKey ? { effectKey } : {}) });
    expect([result.decision, result.reasons, result.contact_token]).toEqual([decision, [reason], undefined]);
  });

  it("holds the local opt-out with Niadra down", async () => {
    const { cell, niadra } = setup();
    await cell.suppress(marina, "service");
    expect(await niadra.mayContact(marina, "service")).toBe(false);
    cell.failNext("/", 503, 100);
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-3" });
    const result = await conversation.check("follow_up", { purpose: "service" });
    expect([result.decision, result.reasons]).toEqual(["deny", ["suppressed"]]);
  });

  it("reads the suppression list to a short page, which still names the cursor to go on from", async () => {
    const cell = new Cell();
    cell.features.add("coordination");
    await cell.suppress(marina, "service");
    const reads: string[] = [];
    const niadra = new Niadra({
      apiKey: KEY,
      logger: silentLogger,
      flushOnExit: false,
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/v1/suppressions") reads.push(url.searchParams.get("cursor") ?? "");
        return cell.fetch(input, init);
      },
    });
    expect(await niadra.mayContact(marina, "service")).toBe(false);
    expect(reads).toEqual([""]);
  });

  it("holds nothing back in a space that does not coordinate", async () => {
    const { cell, niadra } = setup();
    cell.features.delete("coordination");
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-4" });
    const result = await conversation.check("offer", { purpose: "marketing" });
    expect([result.decision, result.reasons]).toEqual(["allow", ["unchecked"]]);
  });

  it("keeps a declaration until Niadra takes it", async () => {
    const { cell, niadra } = setup();
    cell.failNext("/v1/coordination/declare", 503, 1000);
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-5", agent_id: "closing" });
    conversation.declare.effect("farewell:c-5", "unknown_outcome", 1);
    await niadra.flush();
    expect(cell.declarations).toEqual([]);
    cell.clearFailures();
    await niadra.flush();
    expect(cell.declarations[0]?.detail.state).toBe("unknown_outcome");
  });

  it("gives a task lock to one agent at a time", async () => {
    const { niadra } = setup();
    const first = niadra.task({ task_id: "t-1", channel: "legal", agent_id: "summarizer" });
    const second = niadra.task({ task_id: "t-2", channel: "legal", agent_id: "drafter" });
    const mine = await first.claim({ object: "hearing:tj:123", task: "hearing_summary", leaseS: 1500 });
    const theirs = await second.claim({ object: "hearing:tj:123", task: "hearing_summary", leaseS: 1500 });
    expect([mine.held, mine.claim?.kind]).toEqual([true, "task_lock"]);
    expect([theirs.held, theirs.error]).toEqual([false, "task_locked"]);
  });

  it("lets a marketing token through the gateway once, and refuses it for another destination", async () => {
    const { cell, niadra } = setup();
    cell.budgets.set("marketing", 1);
    const gateway = niadra.contactGateway("wa_gateway", { space: SPACE, key: b64(GATEWAY_KEY) });
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-6", agent_id: "retention" });
    const decision = await conversation.check("winback", { purpose: "marketing", gatewayId: "wa_gateway" });
    const again = await conversation.check("winback", { purpose: "marketing", gatewayId: "wa_gateway" });
    expect(decision.decision).toBe("allow");
    expect([again.decision, again.reasons]).toEqual(["deny", ["budget_exhausted"]]);
    const token = decision.contact_token!;
    await expect(gateway.verify(token, { handle: OTHER, channel: "whatsapp" })).rejects.toMatchObject({ code: "wrong_recipient" });
    const claims = await gateway.verify(token, { handle: marina, channel: "whatsapp" });
    expect([claims.purpose, claims.gateway]).toEqual(["marketing", "wa_gateway"]);
    const replayed = await gateway.verify(token, { handle: marina, channel: "whatsapp" }).catch((error: unknown) => error);
    expect(replayed).toBeInstanceOf(NiadraContactTokenError);
    expect((replayed as NiadraContactTokenError).code).toBe("replayed");
    conversation.declare.contactMade(decision, { purpose: "marketing", channel: "whatsapp", gatewayId: "wa_gateway", jti: claims.jti });
    await niadra.flush();
    expect(cell.declarations.at(-1)?.detail).toMatchObject({ jti: claims.jti, unchecked: false });
  });

  it("keeps checking tokens with the last keys while Niadra is down", async () => {
    const { cell, niadra } = setup();
    const gateway = niadra.contactGateway("wa_gateway", { space: SPACE, key: b64(GATEWAY_KEY) });
    expect(await gateway.refresh()).toBe(true);
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-8" });
    const decision = await conversation.check("winback", { purpose: "marketing", gatewayId: "wa_gateway" });
    cell.failNext("/", 503, 100);
    expect(await gateway.refresh()).toBe(false);
    expect((await gateway.verify(decision.contact_token!, { handle: marina, channel: "whatsapp" })).purpose).toBe("marketing");
  });
});
