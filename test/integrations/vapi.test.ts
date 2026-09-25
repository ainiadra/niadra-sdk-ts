import type { Vapi } from "@vapi-ai/server-sdk";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../../src/index.js";
import { attestationProof, memoryCallStore, vapi, vapiTools } from "../../src/integrations/vapi.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, sent, sequence, setup, turns } from "./support.js";

const SECRET = "vapi-server-secret";
const auth = { "x-vapi-secret": SECRET };
const call = { id: "call_7f3a", orgId: "org_1", type: "inboundPhoneCall", customer: { number: "+5511987654321" } };

/** Server messages in Vapi's shape, typed with its SDK where the type is exported. */
const assistantRequest: { message: Vapi.ServerMessageAssistantRequest & Record<string, unknown> } = {
  message: { type: "assistant-request", call: call as unknown as Vapi.Call, timestamp: 1_758_736_800_000 },
};
const toolCalls = {
  message: {
    type: "tool-calls",
    call,
    toolCallList: [
      { id: "tc_1", type: "function", function: { name: "search_customer_history", arguments: { query: "bill doubled" } } },
      { id: "tc_2", type: "function", function: { name: "book_visit", arguments: '{"date":"2026-09-30"}' } },
    ],
    toolWithToolCallList: [],
  },
};
const endOfCall = {
  message: {
    type: "end-of-call-report",
    call,
    endedReason: "customer-ended-call",
    artifact: {
      messages: [
        { role: "system", message: "You answer for Acme.", time: 1_758_736_800_000, secondsFromStart: 0 },
        { role: "bot", message: "Acme Energy, how can I help?", time: 1_758_736_801_000, endTime: 1_758_736_802_000, secondsFromStart: 1 },
        { role: "user", message: "My bill doubled.", time: 1_758_736_804_000, endTime: 1_758_736_805_000, secondsFromStart: 4 },
        { role: "tool_calls", toolCalls: [], time: 1_758_736_806_000, secondsFromStart: 6 },
        { role: "bot", message: "I see an estimated reading.", time: 1_758_736_808_000, endTime: 1_758_736_809_000, secondsFromStart: 8 },
      ],
      transcript: "AI: Acme Energy...",
    },
    analysis: {},
  },
};

describe("Vapi: assistant-request", () => {
  it("verifies, reads the voice context and answers with the saved assistant and the variables", async () => {
    const { server, niadra } = setup();
    const store = memoryCallStore();
    const handle = vapi({ niadra, secret: SECRET, store, assistant: "asst_acme", verify: () => attestationProof("A") });

    const response = await handle(assistantRequest, auth);

    expect(response).toEqual({
      status: 200,
      body: { assistantId: "asst_acme", assistantOverrides: { variableValues: { niadra_context: PACK, niadra_turn: SUFFIX } } },
    });
    expect(sequence(server).slice(0, 2)).toEqual(["batch:verify", "POST /v1/context"]);
    expect(server.callsTo("POST /v1/context")[0]!.body).toMatchObject({ subject: marina, view: "voice", verification: "V2", conversation_id: "call_7f3a" });
    expect(await store.get("call_7f3a")).toMatchObject({ verification: "V2" });
  });

  it("puts the pack after the system messages of a transient assistant", async () => {
    const { niadra } = setup();
    const assistant = { name: "Acme", model: { provider: "openai", model: "gpt-4.1", messages: [{ role: "system", content: "You answer for Acme." }] } };
    const response = await vapi({ niadra, secret: SECRET, assistant })(assistantRequest, { authorization: `Bearer ${SECRET}` });
    const body = response.body as any;
    expect(body.assistant.model.messages).toEqual([
      { role: "system", content: "You answer for Acme." },
      { role: "system", content: PACK },
    ]);
    expect(assistant.model.messages).toHaveLength(1);
  });

  it("answers without context when Niadra is down, and refuses a request without the secret", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(500, "internal"));
    const handle = vapi({ niadra, secret: SECRET, assistant: "asst_acme" });
    expect((await handle(assistantRequest, auth)).body).toEqual({
      assistantId: "asst_acme",
      assistantOverrides: { variableValues: { niadra_context: "", niadra_turn: "" } },
    });
    expect((await handle(assistantRequest, { "x-vapi-secret": "nope" })).status).toBe(401);
  });
});

describe("Vapi: tool-calls", () => {
  it("runs Niadra's tools for the caller and hands the others to your function", async () => {
    const { server, niadra } = setup();
    const handle = vapi({ niadra, secret: SECRET, assistant: "asst_acme", otherTool: (name, args) => `${name} ${JSON.stringify(args)}` });
    await handle(assistantRequest, auth);
    const response = await handle(toolCalls, auth);
    const results = (response.body as { results: any[] }).results;
    expect(results[0]).toMatchObject({ name: "search_customer_history", toolCallId: "tc_1" });
    expect(JSON.parse(results[0].result)).toMatchObject({ items: [{ id: "ep_1" }] });
    expect(results[1]).toEqual({ name: "book_visit", toolCallId: "tc_2", result: 'book_visit "{\\"date\\":\\"2026-09-30\\"}"' });
    expect(server.callsTo("POST /v1/history/search")[0]!.body).toMatchObject({ subject: marina, query: "bill doubled", conversation_id: "call_7f3a" });
  });

  it("defines the tools with the SDK's words", () => {
    const tools = vapiTools({ url: "https://api.acme.com/vapi", secret: SECRET }) as any[];
    expect(tools.map((tool) => tool.function)).toEqual(TOOL_DEFINITIONS.map((definition) => definition.function));
    expect(tools[0].server).toEqual({ url: "https://api.acme.com/vapi", secret: SECRET });
  });
});

describe("Vapi: transfers and the end of the call", () => {
  it("records the transfer once and answers with your destination", async () => {
    const { server, niadra } = setup();
    const destination = { destination: { type: "number", number: "+551130000000" } };
    const handle = vapi({ niadra, secret: SECRET, transfer: () => destination });
    const request = { message: { type: "transfer-destination-request", call } };
    expect(await handle(request, auth)).toEqual({ status: 200, body: destination });
    await handle({ message: { type: "transfer-update", call, destination: destination.destination } }, auth);
    await niadra.flush();
    expect(sent(server).filter((item) => item.type === "handoff")).toMatchObject([{ target: "human", conversation_id: "call_7f3a" }]);
  });

  it("records every spoken turn and ends the conversation", async () => {
    const { server, niadra } = setup();
    const handle = vapi({ niadra, secret: SECRET, assistant: "asst_acme" });
    await handle(assistantRequest, auth);
    expect(await handle(endOfCall, auth)).toEqual({ status: 200, body: { recorded: 3 } });
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["ai_agent", "Acme Energy, how can I help?"],
      ["customer", "My bill doubled."],
      ["ai_agent", "I see an estimated reading."],
    ]);
    expect(turns(server)[1]!.item).toMatchObject({ idempotency_key: "vapi:call_7f3a:2", occurred_at: "2025-09-24T18:00:04.000Z" });
    expect(turns(server)[0]!.item.context_stamp.etag).toBe("etag-1");
    expect(sent(server).at(-1)).toMatchObject({ type: "conversation.ended", conversation_id: "call_7f3a" });
  });

  it("ignores the messages it does not handle", async () => {
    const { server, niadra } = setup();
    const handle = vapi({ niadra, secret: SECRET });
    expect(await handle({ message: { type: "status-update", status: "ringing", call } }, auth)).toEqual({ status: 200, body: {} });
    expect((await handle({ nothing: true }, auth)).status).toBe(400);
    expect(server.calls).toHaveLength(0);
  });
});
