import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { anthropicParams, recordAnthropic, wrapAnthropic } from "../../src/integrations/anthropic.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, sequence, setup, turns } from "./support.js";

const usage = { input_tokens: 120, output_tokens: 20, cache_read_input_tokens: 1800, cache_creation_input_tokens: 64 };
const message = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5-20250929",
  content: [{ type: "text", text: "Your replacement ships today." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage,
};

/** The real Anthropic SDK over a fetch that answers like the API and keeps the request bodies. */
function anthropic(reply: (body: any) => Response) {
  const bodies: any[] = [];
  const client = new Anthropic({
    apiKey: "test",
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      bodies.push(body);
      return reply(body);
    },
  });
  return { client, bodies };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function sse(events: { type: string; [key: string]: unknown }[]): Response {
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("Anthropic: wrapAnthropic", () => {
  it("adds the pack to the system text and the suffix to the last user message, and records both turns with the cache usage", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "an-1" });
    const { client, bodies } = anthropic(() => json(message));
    const wrapped = wrapAnthropic(client, convo, { verify: { method: "login", level: "V2" } });

    const answer = await wrapped.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: "You are Acme's support agent.",
      messages: [{ role: "user", content: "Where is my replacement?" }],
    });

    expect(answer.content[0]).toMatchObject({ type: "text", text: "Your replacement ships today." });
    expect(bodies[0].system).toBe(`You are Acme's support agent.\n\n${PACK}`);
    expect(bodies[0].messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Where is my replacement?" }, { type: "text", text: SUFFIX }] },
    ]);
    await niadra.flush();
    expect(sequence(server).indexOf("batch:verify")).toBeLessThan(sequence(server).indexOf("POST /v1/context"));
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Where is my replacement?"],
      ["ai_agent", "Your replacement ships today."],
    ]);
    expect(turns(server)[1]!.item.usage).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      prompt_tokens: 1984,
      cached_tokens: 1800,
      cache_write_tokens: 64,
    });
  });

  it("adds a cache breakpoint to its system block only when you already use them and one is left", async () => {
    const { niadra } = setup({ live: false });
    const { client, bodies } = anthropic(() => json(message));
    const wrapped = wrapAnthropic(client, niadra.conversation({ subject: marina, channel: "web_chat" }));
    const cached = { type: "text" as const, text: "Rules", cache_control: { type: "ephemeral" as const } };
    await wrapped.messages.create({ model: "claude-sonnet-4-5", max_tokens: 10, system: [cached], messages: [{ role: "user", content: "hi" }] });
    await wrapped.messages.create({ model: "claude-sonnet-4-5", max_tokens: 10, system: [{ type: "text", text: "Rules" }], messages: [{ role: "user", content: "hi" }] });
    expect(bodies[0].system).toEqual([cached, { type: "text", text: PACK, cache_control: { type: "ephemeral" } }]);
    expect(bodies[1].system).toEqual([{ type: "text", text: "Rules" }, { type: "text", text: PACK }]);
  });

  it("records a streamed answer when the stream ends", async () => {
    const { server, niadra } = setup({ live: false });
    const { client } = anthropic(() =>
      sse([
        { type: "message_start", message: { ...message, content: [], usage: { ...usage, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ships " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "today." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ]),
    );
    const wrapped = wrapAnthropic(client, niadra.conversation({ subject: marina, channel: "web_chat" }));
    const stream = await wrapped.messages.create({ model: "claude-sonnet-4-5", max_tokens: 10, stream: true, messages: [{ role: "user", content: "When?" }] });
    let events = 0;
    for await (const event of stream) events += event.type === "message_stop" ? 0 : 1;
    expect(events).toBe(6);
    await niadra.flush();
    const agentTurn = turns(server).find((turn) => turn.role === "ai_agent")!;
    expect(agentTurn.text).toBe("Ships today.");
    expect(agentTurn.item.usage).toMatchObject({ provider: "anthropic", cached_tokens: 1800 });
  });

  it("keeps withResponse(), and leaves the call as it was when Niadra is down", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(503, "unavailable"));
    const { client, bodies } = anthropic(() => json(message));
    const wrapped = wrapAnthropic(client, niadra.conversation({ subject: marina, channel: "web_chat" }));
    const { data, response } = await wrapped.messages
      .create({ model: "claude-sonnet-4-5", max_tokens: 10, system: "S", messages: [{ role: "user", content: "hi" }] })
      .withResponse();
    expect(data.id).toBe("msg_01");
    expect(response.status).toBe(200);
    expect(bodies[0]).toMatchObject({ system: "S", messages: [{ role: "user", content: "hi" }] });
  });

  it("prepares a body for messages.stream() and records its final message", async () => {
    const { server, niadra } = setup({ live: false });
    const convo = niadra.conversation({ subject: marina, channel: "web_chat" });
    const body = await anthropicParams(convo, { model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user" as const, content: "hi" }] });
    expect((body as any).system).toBe(PACK);
    recordAnthropic(convo, message);
    await niadra.flush();
    expect(turns(server).map((turn) => turn.role)).toEqual(["customer", "ai_agent"]);
  });
});
