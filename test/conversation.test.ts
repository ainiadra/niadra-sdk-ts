import { describe, expect, it } from "vitest";
import { MockServer, batchOk, contextBody, makeClient, marina, problem } from "./helpers.js";

const live = [{ at: "2026-09-22T17:07:02Z", channel: "voice", kind: "message" as const, speaker: "customer", text: "called", source_id: "s" }];

describe("conversation()", () => {
  it("asks for deltas after the first pack and keeps each one until the pack changes", async () => {
    const server = new MockServer().on(
      "POST /v1/context",
      { body: contextBody() },
      { body: contextBody({ delta: "[New] credit of R$ 40", live }) },
      { body: contextBody({ delta: "[New] visit rescheduled" }) },
      { body: contextBody({ delta: "[New] visit rescheduled" }) },
      { body: contextBody({ text: "<context>V2 pack</context>", etag: "e2", delta: "[New] credit of R$ 40" }) },
    );
    const niadra = makeClient(server, { cache: false });
    const convo = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "wa-1" });

    const first = await convo.context();
    const second = await convo.context();
    const third = await convo.context();
    const fourth = await convo.context();
    const repinned = await convo.context();

    expect(server.calls[0]!.body).toEqual({ subject: marina, view: "chat", verification: "V0", conversation_id: "wa-1" });
    expect(server.calls.slice(1).every((call) => call.body.delta === true)).toBe(true);
    expect(first.suffix).toBe("");
    expect(second.text).toBe(first.text);
    expect(second.suffix).toBe(
      '<live_turns source="niadra">\n[2026-09-22T17:07:02Z] voice · customer: called\n</live_turns>\n\n[New] credit of R$ 40',
    );
    expect(third.suffix).toBe("[New] credit of R$ 40\n\n[New] visit rescheduled");
    expect(third.response?.delta).toBe("[New] credit of R$ 40\n\n[New] visit rescheduled");
    expect(fourth.suffix).toBe(third.suffix);
    expect(repinned.text).toBe("<context>V2 pack</context>");
    expect(repinned.suffix).toBe("");
  });

  it("serves nothing, and forgets the deltas, when nothing is left to serve", async () => {
    const server = new MockServer().on(
      "POST /v1/context",
      { body: contextBody() },
      { body: contextBody({ delta: "[New] refund" }) },
      problem(403, "forbidden"),
      { body: contextBody() },
    );
    const convo = makeClient(server, { cache: false }).conversation({ subject: marina, channel: "whatsapp" });
    await convo.context();
    expect((await convo.context()).suffix).toBe("[New] refund");
    const cut = await convo.context();
    expect([cut.source, cut.text, cut.suffix]).toEqual(["none", "", ""]);
    expect((await convo.context()).suffix).toBe("");
    expect(server.calls[3]!.body.delta).toBeUndefined();
  });

  it("leaves the deltas alone for a read with a query", async () => {
    const server = new MockServer().on(
      "POST /v1/context",
      { body: contextBody() },
      { body: contextBody({ etag: "q-1", text: "<context>about billing</context>" }) },
      { body: contextBody({ delta: "[New] refund" }) },
    );
    const convo = makeClient(server, { cache: false }).conversation({ subject: marina, channel: "whatsapp" });
    await convo.context();
    const focused = await convo.context({ query: "billing" });
    const after = await convo.context();
    expect(focused.text).toBe("<context>about billing</context>");
    expect(server.calls[1]!.body).toMatchObject({ query: "billing" });
    expect(server.calls[1]!.body.delta).toBeUndefined();
    expect(after.suffix).toBe("[New] refund");
  });

  it("does not pin an empty pack", async () => {
    const server = new MockServer().on("POST /v1/context", problem(503, "unavailable"), { body: contextBody() });
    const convo = makeClient(server, { cache: false }).conversation({ subject: marina, channel: "whatsapp" });
    expect((await convo.context()).text).toBe("");
    expect((await convo.context()).text).toContain("Marina");
    expect(server.calls[1]!.body.delta).toBeUndefined();
  });

  it("defaults to the voice view on the voice channel", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() });
    await makeClient(server).conversation({ subject: marina, channel: "voice" }).context();
    expect(server.calls[0]!.body.view).toBe("voice");
  });

  it("captures turns with the right speaker, direction and conversation", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    const convo = niadra.conversation({ subject: marina, channel: "voice", conversation_id: "call-9" });
    convo.customer("The technician did not come", { stt_confidence: 0.92, idempotency_key: "turn-1" });
    convo.agent("I see the visit was missed", { speaker_id: "voice-bot" });
    convo.human("Hi Marina, this is Ana", { visibility: "public" });
    await niadra.flush();
    const items = server.calls[0]!.body.items;
    expect(items.map((i: any) => [i.speaker.role, i.direction])).toEqual([
      ["customer", "inbound"],
      ["ai_agent", "outbound"],
      ["human_agent", "outbound"],
    ]);
    expect(items[0]).toMatchObject({
      idempotency_key: "turn-1",
      conversation_id: "call-9",
      handles: [marina],
      content: { type: "audio", transcript: "The technician did not come", stt_confidence: 0.92 },
    });
    expect(items[1].speaker).toEqual({ role: "ai_agent", id: "voice-bot" });
  });

  it("binds conversation and customer to track() and action()", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    const convo = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "wa-1" });
    convo.action({ operation: "reschedule", result: "Visit moved to 23/09 morning" });
    convo.track({ kind: "system_event", speaker: "system", canonical_type: "visit.missed", object_refs: ["visit:fsm:77"], channel: "fsm" });
    await niadra.flush();
    const [action, event] = server.calls[0]!.body.items;
    expect(action).toMatchObject({ kind: "action", channel: "whatsapp", conversation_id: "wa-1", handles: [marina] });
    expect(event).toMatchObject({ channel: "fsm", conversation_id: "wa-1" });
    expect(event.handles).toBeUndefined();
  });

  it("raises the level and releases the pin after verify()", async () => {
    const server = new MockServer()
      .on("POST /v1/context", { body: contextBody() }, { body: contextBody({ text: "<context>V2 pack</context>" }) })
      .on("POST /v1/batch", batchOk());
    const convo = makeClient(server, { cache: false }).conversation({ subject: marina, channel: "whatsapp", conversation_id: "wa-1" });
    await convo.context();
    const verified = await convo.verify({ method: "otp_whatsapp", level: "V2" });
    const after = await convo.context();
    expect(verified.ok).toBe(true);
    expect(convo.verification).toBe("V2");
    expect(server.callsTo("POST /v1/batch")[0]!.body.items[0]).toMatchObject({ type: "verify", handle: marina, conversation_id: "wa-1" });
    expect(server.callsTo("POST /v1/context")[1]!.body).toMatchObject({ verification: "V2" });
    expect(server.callsTo("POST /v1/context")[1]!.body.delta).toBeUndefined();
    expect(after.text).toBe("<context>V2 pack</context>");
  });

  it("keeps the level when verify() fails", async () => {
    const server = new MockServer().on("POST /v1/batch", problem(400, "invalid_input"));
    const convo = makeClient(server).conversation({ subject: marina, channel: "whatsapp" });
    await convo.verify({ method: "kba", level: "V3" });
    expect(convo.verification).toBe("V0");
  });

  it("gives tools that follow the conversation's current level", async () => {
    const server = new MockServer()
      .on("POST /v1/history/search", { body: { items: [], withheld: 0, tokens_used: 0 } })
      .on("POST /v1/batch", batchOk());
    const convo = makeClient(server).conversation({ subject: marina, channel: "whatsapp", conversation_id: "wa-1" });
    const kit = convo.tools();
    await convo.verify({ method: "otp_whatsapp", level: "V2" });
    await kit.call("search_customer_history", { query: "invoice" });
    expect(server.callsTo("POST /v1/history/search")[0]!.body).toMatchObject({ verification: "V2", conversation_id: "wa-1" });
  });

  it("records a handoff for the conversation", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const convo = makeClient(server).conversation({ subject: marina, channel: "whatsapp", conversation_id: "wa-1" });
    await convo.handoff({ target: "human", mode: "cold" });
    expect(server.calls[0]!.body.items[0]).toMatchObject({ type: "handoff", conversation_id: "wa-1", target: "human", mode: "cold" });
  });

  it("stamps the agent's turns and actions with the injected context", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() }).on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    const convo = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "wa-1" });
    expect(convo.timings).toEqual({ contextInjectedAt: null, firstAgentTurnAt: null });
    convo.agent("One moment.");
    await convo.context();
    expect(convo.timings.contextInjectedAt).toBeNull();
    convo.markInjected(undefined, new Date("2026-09-22T17:07:02.180Z"));
    convo.agent("I see the credit.");
    convo.action({ operation: "reschedule" });
    convo.action({ operation: "note", speaker: "human_agent" });
    convo.customer("Thanks");
    await niadra.flush();
    const items = server.callsTo("POST /v1/batch").flatMap((call) => call.body.items);
    const stamp = { etag: "etag-1", injected_at: "2026-09-22T17:07:02.180Z" };
    expect(items.map((item: any) => item.context_stamp)).toEqual([undefined, stamp, stamp, undefined, undefined]);
    expect(convo.contextStamp).toEqual(stamp);
    const { contextInjectedAt, firstAgentTurnAt } = convo.timings;
    expect(contextInjectedAt).toEqual(new Date("2026-09-22T17:07:02.180Z"));
    expect(firstAgentTurnAt).toBeInstanceOf(Date);
  });

  it("stamps an injection without a pack by time alone", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    const convo = niadra.conversation({ subject: marina, channel: "whatsapp" });
    convo.markInjected(null, new Date("2026-09-22T17:07:02Z"));
    convo.agent("Hello");
    await niadra.flush();
    expect(server.calls[0]!.body.items[0].context_stamp).toEqual({ injected_at: "2026-09-22T17:07:02.000Z" });
  });

  it("emits conversation.ended once and drops the conversation's packs", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() }).on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    const convo = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "wa-1" });
    await niadra.context({ subject: marina, conversation_id: "wa-1" });
    const [a, b] = await Promise.all([convo.end(), convo.end()]);
    expect(a).toBe(b);
    const ended = server.callsTo("POST /v1/batch").flatMap((c) => c.body.items);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ type: "conversation.ended", conversation_id: "wa-1" });
    await niadra.context({ subject: marina, conversation_id: "wa-1" });
    expect(server.callsTo("POST /v1/context")).toHaveLength(2);
  });

  it("mints a time-ordered id when none is given", () => {
    const convo = makeClient(new MockServer()).conversation({ subject: marina, channel: "app" });
    expect(convo.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("adds more ids of the same person to a turn and takes a content in place of the text", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    const convo = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "wa-1" });
    const bsuid = { type: "wa_bsuid" as const, value: "BR.1234", scope: "waba-1" };
    convo.customer("voice note", { handles: [bsuid, marina], content: { type: "audio", media_ref: "med_1", transcript: "voice note" } });
    convo.customer("it broke", { stt_confidence: 0.8 });
    convo.agent("Sorry to hear that.", { handles: [bsuid] });
    await niadra.flush();
    const items = server.callsTo("POST /v1/batch").flatMap((call) => call.body.items);
    expect(items[0]).toMatchObject({ handles: [marina, bsuid], content: { type: "audio", media_ref: "med_1", transcript: "voice note" } });
    expect(items[1].content).toEqual({ type: "audio", transcript: "it broke", stt_confidence: 0.8 });
    expect(items[2]).toMatchObject({ handles: [marina, bsuid], content: { type: "text", text: "Sorry to hear that." } });
  });
});
