import { createHmac } from "node:crypto";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../../src/index.js";
import { attestationProof, elevenLabs, memoryCallStore, validSignature } from "../../src/integrations/elevenlabs.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, sent, sequence, setup, turns } from "./support.js";

const SECRET = "shared-secret-for-tests";
const WEBHOOK_SECRET = "wsec_test_4f1c";
const NOW = Date.parse("2026-09-24T18:00:00Z");
const auth = { "X-Niadra-Secret": SECRET };

/** The initiation webhook body, in the documented shape. */
const initiation = {
  caller_id: "+5511987654321",
  agent_id: "agent_8201k5",
  called_number: "+551140028922",
  call_sid: "CA5f1e0c",
  conversation_id: "conv_01k5x7",
};

/** A post_call_transcription event, in the documented shape (fields trimmed to what matters). */
const postCall = {
  type: "post_call_transcription",
  event_timestamp: NOW / 1000,
  data: {
    agent_id: "agent_8201k5",
    conversation_id: "conv_01k5x7",
    status: "done",
    transcript: [
      { role: "agent", message: "Acme Energy, how can I help?", time_in_call_secs: 0, tool_calls: [], tool_results: [] },
      { role: "user", message: "My bill doubled this month.", time_in_call_secs: 4, tool_calls: [], tool_results: [] },
      {
        role: "agent",
        message: "I see a reading estimate on your last bill.",
        time_in_call_secs: 9,
        llm_usage: { model_usage: { "gpt-4o-mini": { input: { tokens: 300, price: 0 }, input_cache_read: { tokens: 1200, price: 0 }, output_total: { tokens: 40, price: 0 } } } },
        tool_calls: [],
        tool_results: [],
      },
      {
        role: "agent",
        message: null,
        time_in_call_secs: 15,
        tool_calls: [{ request_id: "t1", tool_name: "transfer_to_number", params_as_json: "{}", tool_has_been_called: true }],
        tool_results: [
          {
            request_id: "t1",
            tool_name: "transfer_to_number",
            result_value: "{}",
            is_error: false,
            tool_has_been_called: true,
            type: "system",
            result: { result_type: "transfer_to_number_twilio_success", status: "success", transfer_number: "+551130000000", reason: "billing dispute", agent_message: "", conference_name: "c1" },
          },
        ],
      },
    ],
    metadata: {
      start_time_unix_secs: NOW / 1000 - 60,
      call_duration_secs: 20,
      phone_call: { direction: "inbound", phone_number_id: "pn_1", agent_number: "+551140028922", external_number: "+5511987654321", call_sid: "CA5f1e0c", type: "twilio" },
    },
    conversation_initiation_client_data: { dynamic_variables: { system__caller_id: "+5511987654321" } },
  },
};

function sign(body: string, at = NOW / 1000, secret = WEBHOOK_SECRET): string {
  return `t=${at},v0=${createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`;
}

describe("ElevenLabs: initiation webhook", () => {
  it("verifies first, reads the voice context and answers it as dynamic variables", async () => {
    const { server, niadra } = setup();
    const store = memoryCallStore();
    const handlers = elevenLabs({ niadra, secret: SECRET, store, verify: () => attestationProof("A"), dynamicVariables: () => ({ brand: "Acme" }) });

    const response = await handlers.initiation(initiation, auth);

    expect(response).toEqual({
      status: 200,
      body: { type: "conversation_initiation_client_data", dynamic_variables: { niadra_context: PACK, niadra_turn: SUFFIX, brand: "Acme" } },
    });
    expect(sequence(server).slice(0, 2)).toEqual(["batch:verify", "POST /v1/context"]);
    expect(server.callsTo("POST /v1/context")[0]!.body).toMatchObject({ subject: marina, view: "voice", verification: "V2", conversation_id: "conv_01k5x7" });
    expect(await store.get("conv_01k5x7")).toMatchObject({ subject: marina, verification: "V2", stamp: { etag: "etag-1" } });
  });

  it("refuses a request without the shared secret", async () => {
    const { server, niadra } = setup();
    const handlers = elevenLabs({ niadra, secret: SECRET });
    expect((await handlers.initiation(initiation, {})).status).toBe(401);
    expect((await handlers.initiation(initiation, { "x-niadra-secret": "wrong" })).status).toBe(401);
    expect((await handlers.tool({}, new Headers())).status).toBe(401);
    expect(server.calls).toHaveLength(0);
  });

  it("lets the call through with empty variables when Niadra is down or the caller is unknown", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(503, "unavailable"));
    const handlers = elevenLabs({ niadra, secret: SECRET });
    const empty = { type: "conversation_initiation_client_data", dynamic_variables: { niadra_context: "", niadra_turn: "" } };
    expect(await handlers.initiation(initiation, auth)).toEqual({ status: 200, body: empty });
    expect(await handlers.initiation({ ...initiation, caller_id: "anonymous" }, auth)).toEqual({ status: 200, body: empty });
  });
});

describe("ElevenLabs: server tools", () => {
  it("answers a tool call for the caller the initiation webhook saw, at the level they proved", async () => {
    const { server, niadra } = setup();
    const handlers = elevenLabs({ niadra, secret: SECRET, verify: () => attestationProof("B") });
    await handlers.initiation(initiation, auth);

    const response = await handlers.tool(
      { query: "bill doubled", niadra_tool: "search_customer_history", niadra_conversation_id: "conv_01k5x7", niadra_caller_id: "+5511987654321" },
      auth,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ items: [{ id: "ep_1" }] });
    expect(server.callsTo("POST /v1/history/search")[0]!.body).toMatchObject({
      subject: marina,
      query: "bill doubled",
      verification: "V1",
      conversation_id: "conv_01k5x7",
    });
  });

  it("describes the tools with the SDK's words and takes the call ids from system variables, not the model", () => {
    const { niadra } = setup();
    const configs = elevenLabs({ niadra, secret: SECRET }).toolConfigs({ url: "https://api.acme.com/elevenlabs/tools", secretId: "sec_1" }) as any[];
    expect(configs.map((config) => [config.name, config.description])).toEqual(
      TOOL_DEFINITIONS.map((definition) => [definition.function.name, definition.function.description]),
    );
    const search = configs[0].api_schema;
    expect(search.request_headers).toEqual({ "x-niadra-secret": { secret_id: "sec_1" } });
    expect(search.request_body_schema.properties.niadra_conversation_id).toEqual({ type: "string", dynamic_variable: "system__conversation_id" });
    expect(search.request_body_schema.properties.niadra_caller_id).toEqual({ type: "string", dynamic_variable: "system__caller_id" });
    expect(search.request_body_schema.properties.niadra_tool).toEqual({ type: "string", constant_value: "search_customer_history" });
    expect(search.request_body_schema.properties.query.description).toBe("What to look for, in the customer's own terms.");
    expect(search.request_body_schema.properties.channels.items.type).toBe("string");
  });
});

describe("ElevenLabs: post-call webhook", () => {
  it("checks the signature the same way the ElevenLabs SDK does", async () => {
    const body = JSON.stringify(postCall);
    const signature = sign(body, Math.floor(Date.now() / 1000));
    const client = new ElevenLabsClient({ apiKey: "unused" });
    await expect(client.webhooks.constructEvent(body, signature, WEBHOOK_SECRET)).resolves.toMatchObject({ type: "post_call_transcription" });
    expect(await validSignature(body, signature, WEBHOOK_SECRET)).toBe(true);
    expect(await validSignature(body, signature, "other")).toBe(false);
    expect(await validSignature(`${body} `, signature, WEBHOOK_SECRET)).toBe(false);
    expect(await validSignature(body, sign(body, NOW / 1000 - 31 * 60), WEBHOOK_SECRET, NOW)).toBe(false);
  });

  it("records the transcript, the usage, the transfer and the end of the call", async () => {
    const { server, niadra } = setup();
    const store = memoryCallStore();
    const handlers = elevenLabs({ niadra, secret: SECRET, webhookSecret: WEBHOOK_SECRET, store, now: () => NOW });
    await handlers.initiation(initiation, auth);
    const body = JSON.stringify(postCall);

    const response = await handlers.postCall(new TextEncoder().encode(body), { "ElevenLabs-Signature": sign(body) });

    expect(response).toEqual({ status: 200, body: { recorded: 3 } });
    const recorded = turns(server);
    expect(recorded.map((turn) => [turn.role, turn.text])).toEqual([
      ["ai_agent", "Acme Energy, how can I help?"],
      ["customer", "My bill doubled this month."],
      ["ai_agent", "I see a reading estimate on your last bill."],
    ]);
    expect(recorded[1]!.item).toMatchObject({ conversation_id: "conv_01k5x7", idempotency_key: "elevenlabs:conv_01k5x7:1", occurred_at: "2026-09-24T17:59:04.000Z" });
    expect(recorded[2]!.item.usage).toEqual({ provider: "openai", model: "gpt-4o-mini", prompt_tokens: 1500, cached_tokens: 1200, cache_write_tokens: 0 });
    expect(recorded[2]!.item.context_stamp.etag).toBe("etag-1");
    const handoff = sent(server).find((item) => item.type === "handoff");
    expect(handoff).toMatchObject({ target: "human", reason: "billing dispute", conversation_id: "conv_01k5x7" });
    expect(sent(server).at(-1)).toMatchObject({ type: "conversation.ended", conversation_id: "conv_01k5x7" });
  });

  it("finds the caller in the event itself when another instance handled the start of the call", async () => {
    const { server, niadra } = setup();
    const handlers = elevenLabs({ niadra, secret: SECRET, webhookSecret: WEBHOOK_SECRET, now: () => NOW });
    const body = JSON.stringify(postCall);
    await handlers.postCall(body, { "elevenlabs-signature": sign(body) });
    expect(turns(server)[0]!.item.handles).toEqual([marina]);
  });

  it("rejects a bad signature and ignores other event types", async () => {
    const { server, niadra } = setup();
    const handlers = elevenLabs({ niadra, secret: SECRET, webhookSecret: WEBHOOK_SECRET, now: () => NOW });
    const body = JSON.stringify(postCall);
    expect((await handlers.postCall(body, { "elevenlabs-signature": sign(body, NOW / 1000, "leaked") })).status).toBe(401);
    expect((await handlers.postCall(body, {})).status).toBe(401);
    const audio = JSON.stringify({ type: "post_call_audio", event_timestamp: NOW / 1000, data: {} });
    expect(await handlers.postCall(audio, { "elevenlabs-signature": sign(audio) })).toEqual({ status: 200, body: { ignored: true } });
    expect(server.calls).toHaveLength(0);
  });
});
