import { describe, expect, it } from "vitest";
import { NiadraValidationError } from "../src/index.js";
import { MockServer, batchOk, makeClient, marina, problem, spyLogger } from "./helpers.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function sent(server: MockServer, run: (niadra: ReturnType<typeof makeClient>) => unknown) {
  const niadra = makeClient(server);
  run(niadra);
  await niadra.flush();
  return server.callsTo("POST /v1/batch").flatMap((call) => call.body.items);
}

describe("track()", () => {
  it("builds a message with a minted key, a timestamp and an inferred direction", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    const key = niadra.track({ channel: "whatsapp", speaker: "customer", handles: [marina], text: "Hi", conversation_id: "wa-1" });
    await niadra.flush();
    const [item] = server.calls[0]!.body.items;
    expect(key).toMatch(UUID_V7);
    expect(item).toMatchObject({
      type: "event",
      kind: "message",
      idempotency_key: key,
      channel: "whatsapp",
      conversation_id: "wa-1",
      handles: [marina],
      speaker: { role: "customer" },
      direction: "inbound",
      content: { type: "text", text: "Hi" },
    });
    expect(Number.isNaN(Date.parse(item.occurred_at))).toBe(false);
  });

  it("keeps the provider's message id and converts Date timestamps", async () => {
    const items = await sent(new MockServer().on("POST /v1/batch", batchOk()), (niadra) =>
      niadra.track({
        channel: "whatsapp",
        speaker: { role: "ai_agent", id: "bot-7" },
        handles: [marina],
        text: "On it",
        idempotency_key: "wamid.HBgM",
        occurred_at: new Date("2026-09-22T17:02:00Z"),
      }),
    );
    expect(items[0]).toMatchObject({
      idempotency_key: "wamid.HBgM",
      occurred_at: "2026-09-22T17:02:00.000Z",
      direction: "outbound",
      speaker: { role: "ai_agent", id: "bot-7" },
    });
  });

  it("records system events with their canonical type and fields", async () => {
    const items = await sent(new MockServer().on("POST /v1/batch", batchOk()), (niadra) =>
      niadra.track({
        kind: "system_event",
        channel: "erp",
        speaker: "system",
        object_refs: ["invoice:erp:0823"],
        canonical_type: "invoice.credited",
        fields: { amount: 40, currency: "BRL" },
      }),
    );
    expect(items[0]).toMatchObject({
      kind: "system_event",
      object_refs: [{ type: "invoice", namespace: "erp", id: "0823" }],
      canonical_type: "invoice.credited",
      fields: { amount: 40, currency: "BRL" },
    });
    expect(items[0].direction).toBeUndefined();
  });

  it.each([
    ["a message without text", { channel: "app", speaker: "customer", handles: [marina] }],
    ["an event with no handle, subject or object", { channel: "app", speaker: "customer", text: "hi" }],
    ["a system event without canonical_type", { kind: "system_event", channel: "erp", speaker: "system", handles: [marina] }],
    ["an action without the action block", { kind: "action", channel: "erp", speaker: "ai_agent", handles: [marina] }],
    ["an action block on a message", { channel: "app", speaker: "customer", handles: [marina], text: "x", action: { operation: "credit" } }],
    ["both text and content", { channel: "app", speaker: "customer", handles: [marina], text: "x", content: { text: "y" } }],
    ["an empty channel", { channel: "", speaker: "customer", handles: [marina], text: "x" }],
    ["more than 16 handles", { channel: "app", speaker: "customer", handles: Array(17).fill(marina), text: "x" }],
    ["text over 200,000 characters", { channel: "app", speaker: "customer", handles: [marina], text: "x".repeat(200_001) }],
    ["a timestamp that is not ISO 8601", { channel: "app", speaker: "customer", handles: [marina], text: "x", occurred_at: "yesterday" }],
    ["fields JSON cannot encode", { kind: "system_event", channel: "erp", speaker: "system", handles: [marina], canonical_type: "x.y", fields: { n: 1n } }],
  ])("drops %s with a log line and returns null", async (_, event) => {
    const logger = spyLogger();
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server, { logger });
    expect(niadra.track(event as never)).toBeNull();
    await niadra.flush();
    expect(server.calls).toHaveLength(0);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/^event dropped: /);
  });

  it("throws the validation error in strict mode", () => {
    const niadra = makeClient(new MockServer(), { strict: true });
    expect(() => niadra.track({ channel: "app", speaker: "customer", text: "hi" })).toThrow(NiadraValidationError);
  });
});

describe("action()", () => {
  it("records an action with the ai_agent speaker and a closes reference", async () => {
    const items = await sent(new MockServer().on("POST /v1/batch", batchOk()), (niadra) =>
      niadra.action({
        channel: "billing-agent",
        handles: [marina],
        operation: "credit",
        result: "R$ 40 credited on the August invoice",
        closes: { object: { type: "invoice", namespace: "erp", id: "0823" }, operation: "credit" },
      }),
    );
    expect(items[0]).toMatchObject({
      kind: "action",
      speaker: { role: "ai_agent" },
      action: {
        operation: "credit",
        result: "R$ 40 credited on the August invoice",
        closes: { object: { type: "invoice", namespace: "erp", id: "0823" }, operation: "credit" },
      },
    });
  });

  it("rejects closes that names both an item and an object", () => {
    const niadra = makeClient(new MockServer(), { strict: true });
    expect(() =>
      niadra.action({
        channel: "billing-agent",
        handles: [marina],
        operation: "credit",
        closes: { item_id: "oi-1", object: { type: "invoice", namespace: "erp", id: "1" }, operation: "credit" },
      }),
    ).toThrow(/either item_id/);
  });
});

describe("identify(), verify() and handoff()", () => {
  it("sends identify right away and resolves once the server accepted it", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server, { queue: { flushIntervalMs: 60_000 } });
    const result = await niadra.identify({ handles: [marina, { type: "email", value: "marina@example.com" }], conversation_id: "wa-1" });
    expect(result).toMatchObject({ ok: true, error: null });
    expect(server.calls[0]!.body.items[0]).toMatchObject({
      type: "identify",
      idempotency_key: result.idempotency_key,
      method: "explicit_identify",
      subject_kind: "person",
      conversation_id: "wa-1",
    });
  });

  it("requires at least two handles", async () => {
    const result = await makeClient(new MockServer()).identify({ handles: [marina] });
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(NiadraValidationError);
  });

  it("sends verify with the proven level", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    await niadra.verify({
      handle: marina,
      method: "otp_whatsapp",
      level: "V2",
      conversation_id: "wa-1",
      valid_until: new Date("2026-09-22T18:00:00Z"),
    });
    expect(server.calls[0]!.body.items[0]).toMatchObject({
      type: "verify",
      method: "otp_whatsapp",
      level: "V2",
      handle: marina,
      conversation_id: "wa-1",
      valid_until: "2026-09-22T18:00:00.000Z",
    });
  });

  it("sends handoff with warm as the default mode", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    await makeClient(server).handoff({ conversation_id: "wa-1", target: "human", reason: "asked for a person" });
    expect(server.calls[0]!.body.items[0]).toMatchObject({
      type: "handoff",
      conversation_id: "wa-1",
      target: "human",
      mode: "warm",
      reason: "asked for a person",
    });
  });

  it("resolves with the item's own error when the server rejects it in a 207", async () => {
    const server = new MockServer().on("POST /v1/batch", {
      status: 207,
      body: { accepted: 0, duplicates: 0, errors: [{ index: 0, code: "verification_not_allowed" }] },
    });
    const result = await makeClient(server).verify({ handle: marina, method: "kba", level: "V4", conversation_id: "c" });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("verification_not_allowed");
  });

  it("resolves not ok when the batch fails, and rejects in strict mode", async () => {
    const server = new MockServer().on("POST /v1/batch", problem(400, "invalid_input"));
    const handoff = { conversation_id: "wa-1", target: "agent" as const };
    expect((await makeClient(server).handoff(handoff)).ok).toBe(false);
    await expect(makeClient(server, { strict: true }).handoff(handoff)).rejects.toMatchObject({ status: 400 });
  });
});
