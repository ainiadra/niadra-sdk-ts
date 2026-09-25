import type { Retell } from "retell-sdk";
import { sign } from "retell-sdk";
import { describe, expect, it, vi } from "vitest";
import { TOOL_DEFINITIONS } from "../../src/index.js";
import { attestationProof, memoryCallStore, retell, validRetellSignature } from "../../src/integrations/retell.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, sent, sequence, setup, turns } from "./support.js";

const API_KEY = "key_retell_webhook_test";

/** The body as Retell sends it, and the headers with a signature made by Retell's own SDK. */
async function signed(body: unknown): Promise<[string, Record<string, string>]> {
  const text = JSON.stringify(body);
  return [text, { "x-retell-signature": await sign(text, API_KEY) }];
}

const call = {
  call_id: "call_b8f2",
  call_type: "phone_call",
  agent_id: "agent_acme",
  agent_version: 3,
  call_status: "ended",
  direction: "inbound",
  from_number: "+5511987654321",
  to_number: "+551140028922",
  start_timestamp: 1_758_736_800_000,
  end_timestamp: 1_758_736_860_000,
  disconnection_reason: "user_hangup",
  transcript: "Agent: Acme Energy...",
  transcript_object: [
    { role: "agent", content: "Acme Energy, how can I help?", words: [{ word: "Acme", start: 0.4, end: 0.8 }] },
    { role: "user", content: "My bill doubled.", words: [{ word: "My", start: 3.1, end: 3.3 }] },
    { role: "agent", content: "I see an estimated reading.", words: [{ word: "I", start: 5.2, end: 5.3 }] },
  ],
} satisfies Partial<Retell.PhoneCallResponse>;

const inboundBody = { event: "call_inbound", call_inbound: { agent_id: "agent_acme", agent_version: 3, from_number: "+5511987654321", to_number: "+551140028922", call_id: "call_b8f2" } };

describe("Retell: inbound webhook", () => {
  it("verifies, reads the voice context and answers it as dynamic variables", async () => {
    const { server, niadra } = setup();
    const store = memoryCallStore();
    const handlers = retell({ niadra, apiKey: API_KEY, store, verify: () => attestationProof("A"), inboundFields: () => ({ override_agent_id: "agent_vip", dynamic_variables: { plan: "gold" } }) });

    const response = await handlers.inbound(...(await signed(inboundBody)));

    expect(response).toEqual({
      status: 200,
      body: { call_inbound: { override_agent_id: "agent_vip", dynamic_variables: { plan: "gold", niadra_context: PACK, niadra_turn: SUFFIX } } },
    });
    expect(sequence(server).slice(0, 2)).toEqual(["batch:verify", "POST /v1/context"]);
    expect(server.callsTo("POST /v1/context")[0]!.body).toMatchObject({ subject: marina, view: "voice", verification: "V2", conversation_id: "call_b8f2" });
    expect(await store.get("call_b8f2")).toMatchObject({ subject: marina, verification: "V2" });
  });

  it("answers empty variables when Niadra is down, and refuses a bad or stale signature", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(500, "internal"));
    const handlers = retell({ niadra, apiKey: API_KEY, agentMemory: true });
    expect((await handlers.inbound(...(await signed(inboundBody)))).body).toEqual({
      call_inbound: { dynamic_variables: { niadra_context: "", niadra_turn: "", niadra_agent_memory: "" } },
    });
    const [text] = await signed(inboundBody);
    expect((await handlers.inbound(text, { "x-retell-signature": await sign(text, "another-key") })).status).toBe(401);
    expect((await handlers.inbound(text, {})).status).toBe(401);
    const stale = retell({ niadra, apiKey: API_KEY, now: () => Date.now() + 6 * 60 * 1000 });
    expect((await stale.inbound(...(await signed(inboundBody)))).status).toBe(401);
  });
});

describe("Retell: custom functions", () => {
  it("runs the history tool for the caller of the call, whatever the arguments say", async () => {
    const { server, niadra } = setup();
    const handlers = retell({ niadra, apiKey: API_KEY, otherTool: (name, args) => ({ booked: args.date, name }) });

    const ours = await handlers.tool(...(await signed({ name: "search_customer_history", call, args: { query: "bill doubled", subject: "+15550000000" } })));
    expect(ours.status).toBe(200);
    expect((ours.body as any).items).toHaveLength(1);
    expect(server.callsTo("POST /v1/history/search")[0]!.body).toMatchObject({ subject: marina, query: "bill doubled", conversation_id: "call_b8f2" });

    const atRoot = await handlers.tool(...(await signed({ name: "book_visit", call, date: "2026-09-30" })));
    expect(atRoot.body).toEqual({ booked: "2026-09-30", name: "book_visit" });
  });

  it("writes the custom function configurations with the canonical definitions", () => {
    const { niadra } = setup();
    const configs = retell({ niadra, apiKey: API_KEY, agentMemory: true }).toolConfigs({ url: "https://api.acme.com/retell/tools" });
    const tools = configs as unknown as Retell.LlmCreateParams.CustomTool[];
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_DEFINITIONS.map((definition) => definition.function.name), "search_agent_memory"]);
    expect(configs[0]).toEqual({
      type: "custom",
      name: TOOL_DEFINITIONS[0]!.function.name,
      description: TOOL_DEFINITIONS[0]!.function.description,
      url: "https://api.acme.com/retell/tools",
      method: "POST",
      parameters: TOOL_DEFINITIONS[0]!.function.parameters,
      speak_during_execution: false,
      speak_after_execution: true,
      timeout_ms: 10_000,
    });
  });
});

describe("Retell: agent webhook", () => {
  it("records every utterance of call_ended with its time and ends the conversation", async () => {
    const { server, niadra } = setup();
    const store = memoryCallStore();
    store.set("call_b8f2", { subject: marina, verification: "V2" });
    const handlers = retell({ niadra, apiKey: API_KEY, store });

    const response = await handlers.webhook(...(await signed({ event: "call_ended", call })));

    expect(response).toEqual({ status: 200, body: { recorded: 3 } });
    expect(turns(server).map((turn) => [turn.role, turn.text, turn.item.idempotency_key, turn.item.occurred_at])).toEqual([
      ["ai_agent", "Acme Energy, how can I help?", "retell:call_b8f2:0", "2025-09-24T18:00:00.400Z"],
      ["customer", "My bill doubled.", "retell:call_b8f2:1", "2025-09-24T18:00:03.100Z"],
      ["ai_agent", "I see an estimated reading.", "retell:call_b8f2:2", "2025-09-24T18:00:05.200Z"],
    ]);
    expect(sent(server).at(-1)).toMatchObject({ type: "conversation.ended", conversation_id: "call_b8f2" });
  });

  it("keeps the callee of an outbound call from call_started, and records a transfer once", async () => {
    const { server, niadra } = setup();
    const store = memoryCallStore();
    const handlers = retell({ niadra, apiKey: API_KEY, store });
    const outbound = { ...call, call_id: "call_out", direction: "outbound", from_number: "+551140028922", to_number: "+5511987654321" };

    expect((await handlers.webhook(...(await signed({ event: "call_started", call: outbound })))).status).toBe(200);
    expect(await store.get("call_out")).toMatchObject({ subject: marina, verification: "V0" });
    await handlers.webhook(...(await signed({ event: "transfer_started", call: outbound })));
    await handlers.webhook(...(await signed({ event: "call_ended", call: { ...outbound, disconnection_reason: "call_transfer" } })));
    await niadra.flush();
    expect(sent(server).filter((item) => item.type === "handoff")).toMatchObject([{ target: "human", conversation_id: "call_out" }]);
    expect((await handlers.webhook(...(await signed({ event: "call_analyzed", call: outbound })))).body).toEqual({ ignored: true });
  });
});

describe("Retell: custom LLM websocket", () => {
  it("asks for the call details, answers pings, and gives the model the messages with the context", async () => {
    const { server, niadra } = setup();
    const events: Record<string, unknown>[] = [];
    const handlers = retell({ niadra, apiKey: API_KEY, verify: () => attestationProof("B"), trustCallDetails: true });
    const session = handlers.llm("call_b8f2", { send: (event) => events.push(event), instructions: "You are Acme's receptionist." });

    session.open("Acme Energy, how can I help?");
    expect(events.splice(0)).toEqual([
      { response_type: "config", config: { auto_reconnect: true, call_details: true } },
      { response_type: "response", response_id: 0, content: "Acme Energy, how can I help?", content_complete: true },
    ]);
    expect(await session.receive({ interaction_type: "call_details", call })).toBeNull();
    expect(await session.receive({ interaction_type: "ping_pong", timestamp: 1 })).toBeNull();
    expect(events.splice(0)).toEqual([{ response_type: "ping_pong", timestamp: 1 }]);

    const turn = await session.receive({
      interaction_type: "response_required",
      response_id: 1,
      transcript: [
        { role: "agent", content: "Acme Energy, how can I help?" },
        { role: "user", content: "My bill doubled." },
      ],
    });

    expect(turn!.messages).toEqual([
      { role: "system", content: "You are Acme's receptionist." },
      { role: "system", content: PACK },
      { role: "assistant", content: "Acme Energy, how can I help?" },
      { role: "user", content: `My bill doubled.\n\n${SUFFIX}` },
    ]);
    turn!.respond("Let me check ", { complete: false });
    turn!.respond("your last reading.");
    expect(events).toEqual([
      { response_type: "response", response_id: 1, content: "Let me check ", content_complete: false },
      { response_type: "response", response_id: 1, content: "your last reading.", content_complete: true },
    ]);
    await session.close();
    expect(sent(server).find((item) => item.type === "verify")).toMatchObject({ level: "V1", conversation_id: "call_b8f2" });
    expect(turns(server).map((turn) => [turn.role, turn.item.idempotency_key])).toEqual([
      ["ai_agent", "retell:call_b8f2:0"],
      ["customer", "retell:call_b8f2:1"],
    ]);
  });

  it("uses the inbound webhook's record, and answers without context when Niadra is down", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(503, "unavailable"));
    const store = memoryCallStore();
    store.set("call_b8f2", { subject: marina, verification: "V2" });
    const events: Record<string, unknown>[] = [];
    const session = retell({ niadra, apiKey: API_KEY, store }).llm("call_b8f2", { send: (event) => events.push(event) });

    const turn = await session.receive({ interaction_type: "response_required", response_id: 2, transcript: [{ role: "user", content: "Hello?" }] });

    expect(turn!.messages).toEqual([{ role: "user", content: "Hello?" }]);
    turn!.respond("Hi, this is Acme.", { transferNumber: "+551140028900" });
    expect(events.at(-1)).toMatchObject({ response_id: 2, transfer_number: "+551140028900" });
    expect(server.callsTo("POST /v1/context")[0]!.body).toMatchObject({ verification: "V2" });
    expect(await session.receive("not an event")).toBeNull();
  });
});

describe("Retell: the caller's turn", () => {
  it("prefetches the caller's utterance on update_only, and reads with it", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context/prefetch", { status: 202, body: {} });
    const store = memoryCallStore();
    store.set("call_b8f2", { subject: marina, verification: "V1" });
    const session = retell({ niadra, apiKey: API_KEY, store }).llm("call_b8f2", { send: () => undefined });
    const update = (transcript: { role: string; content: string }[]): Promise<unknown> =>
      session.receive({ interaction_type: "update_only", transcript });

    expect(await update([{ role: "agent", content: "Acme Energy, how can I help?" }])).toBeNull();
    expect(await update([{ role: "agent", content: "Acme Energy, how can I help?" }, { role: "user", content: "My bill doubled this" }])).toBeNull();
    await vi.waitFor(() => {
      expect(server.callsTo("POST /v1/context/prefetch")).toHaveLength(1);
    });
    expect(server.callsTo("POST /v1/context/prefetch")[0]!.body).toMatchObject({
      subject: marina,
      conversation_id: "call_b8f2",
      view: "voice",
      verification: "V1",
      query: "My bill doubled this",
    });

    await session.receive({
      interaction_type: "response_required",
      response_id: 1,
      transcript: [{ role: "agent", content: "Acme Energy, how can I help?" }, { role: "user", content: "My bill doubled this month." }],
    });
    expect(server.callsTo("POST /v1/context")[0]!.body.query).toBe("My bill doubled this month.");
  });
});

describe("Retell: the unsigned websocket", () => {
  it("never takes the customer from its call details, only from a signed webhook of the call", async () => {
    // Anyone who reaches the socket could name any caller in `call_details` and read their memory,
    // or write turns into it. Without `trustCallDetails`, the socket's own details name nobody.
    const { server, niadra } = setup();
    const store = memoryCallStore();
    const handlers = retell({ niadra, apiKey: API_KEY, store, verify: () => attestationProof("A") });
    const events: Record<string, unknown>[] = [];
    const session = handlers.llm("call_forged", { send: (event) => events.push(event) });

    expect(await session.receive({ interaction_type: "call_details", call: { ...call, call_id: "call_forged" } })).toBeNull();
    const blind = await session.receive({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "user", content: "What is my address?" }] });
    expect(blind!.messages).toEqual([{ role: "user", content: "What is my address?" }]);
    await niadra.flush();
    expect(server.callsTo("POST /v1/context")).toEqual([]);
    expect(turns(server)).toEqual([]);

    // A signed webhook of the same call registers it; the next turn has the caller's context.
    await handlers.webhook(...(await signed({ event: "call_started", call: { ...call, call_id: "call_forged", call_status: "ongoing" } })));
    const next = await session.receive({ interaction_type: "response_required", response_id: 2, transcript: [{ role: "user", content: "What is my address?" }] });
    expect(next!.context).toBe(PACK);
  });
});

describe("Retell: signature", () => {
  it("accepts what retell-sdk signs and nothing else", async () => {
    const body = '{"event":"call_started"}';
    const now = Date.now();
    const signature = await sign(body, API_KEY);
    expect(await validRetellSignature(body, signature, API_KEY, now)).toBe(true);
    expect(await validRetellSignature(`${body} `, signature, API_KEY, now)).toBe(false);
    expect(await validRetellSignature(body, signature, API_KEY, now + 10 * 60 * 1000)).toBe(false);
    expect(await validRetellSignature(body, "v=1,d=zz", API_KEY, now)).toBe(false);
    expect(await validRetellSignature(body, undefined, API_KEY, now)).toBe(false);
  });
});
