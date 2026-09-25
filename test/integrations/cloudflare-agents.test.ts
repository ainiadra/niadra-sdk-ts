import type { Agent } from "agents";
import { generateText, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { describe, expect, expectTypeOf, it } from "vitest";
import { TOOL_NAMES } from "../../src/index.js";
import { niadraAgent, workersAiUsage } from "../../src/integrations/cloudflare-agents.js";
import type { AgentLike } from "../../src/integrations/cloudflare-agents.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, setup, turns } from "./support.js";

const usage = { inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 8, text: 8, reasoning: undefined } };

/** A stand-in for an Agent instance: its name and the Durable Object's `ctx.waitUntil`. */
function fakeAgent(name: string) {
  const waited: Promise<unknown>[] = [];
  return { agent: { name, ctx: { waitUntil: (promise: Promise<unknown>) => waited.push(promise) } }, waited };
}

describe("Cloudflare Agents: niadraAgent", () => {
  it("takes an Agent instance as it is (its protected ctx is read at run time)", () => {
    expectTypeOf<Agent>().toExtend<AgentLike>();
  });

  it("wraps the model of onChatMessage, keeps one helper per instance and hands the writes to waitUntil", async () => {
    const { server, niadra } = setup();
    const { agent, waited } = fakeAgent("chat-42");
    const memory = niadraAgent(agent, { niadra, subject: (self) => ({ type: "app_user_id", value: `user-${self.name}` }) });
    expect(niadraAgent(agent, { niadra })).toBe(memory);
    expect(memory.session).toMatchObject({ id: "chat-42", channel: "web_chat" });

    const model = new MockLanguageModelV4({
      provider: "workers-ai.chat",
      modelId: "@cf/openai/gpt-oss-120b",
      doStream: {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "It ships today." },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ] as never[]),
      },
    });
    const result = streamText({
      model: wrapLanguageModel({ model, middleware: memory.middleware }),
      system: "You are Acme's support agent.",
      messages: [{ role: "user", content: "Where is my replacement?" }],
      tools: memory.tools(),
    });

    expect(await result.text).toBe("It ships today.");
    const prompt = model.doStreamCalls[0]!.prompt as any[];
    expect(prompt.slice(0, 2)).toEqual([
      { role: "system", content: "You are Acme's support agent." },
      { role: "system", content: PACK },
    ]);
    expect(prompt[2].content.at(-1)).toEqual({ type: "text", text: SUFFIX });
    expect(model.doStreamCalls[0]!.tools!.map((tool: any) => tool.name)).toEqual([TOOL_NAMES.search, TOOL_NAMES.timeline, TOOL_NAMES.open]);
    expect(waited.length).toBeGreaterThan(0);
    await Promise.all(waited);
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Where is my replacement?"],
      ["ai_agent", "It ships today."],
    ]);
    expect(turns(server)[0]!.item.conversation_id).toBe("chat-42");
    expect(server.callsTo("POST /v1/context")[0]!.body.subject).toEqual({ type: "app_user_id", value: "user-chat-42" });
  });

  it("prepares messages for a model called without the AI SDK, and records its answer", async () => {
    const { server, niadra } = setup();
    const { agent, waited } = fakeAgent("call-7");
    const memory = niadraAgent(agent, { niadra, subject: marina, channel: "voice" });

    const messages = await memory.prepare([
      { role: "system", content: "You are Acme's receptionist." },
      { role: "user", content: "My bill doubled." },
    ]);
    expect(messages).toEqual([
      { role: "system", content: "You are Acme's receptionist." },
      { role: "system", content: PACK },
      { role: "user", content: `My bill doubled.\n\n${SUFFIX}` },
    ]);
    expect(server.callsTo("POST /v1/context")[0]!.body).toMatchObject({ view: "voice", conversation_id: "call-7" });

    const answer = { response: "I see an estimated reading.", usage: { prompt_tokens: 700, completion_tokens: 9, total_tokens: 709 } };
    memory.record(answer.response, { usage: workersAiUsage(answer, "@cf/meta/llama-4-scout-17b-16e-instruct") });
    await memory.end();
    await Promise.all(waited);
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "My bill doubled."],
      ["ai_agent", "I see an estimated reading."],
    ]);
    expect(turns(server)[1]!.item.usage).toEqual({ provider: "workers-ai", model: "cf/meta/llama-4-scout-17b-16e-instruct", prompt_tokens: 700, cached_tokens: 0, cache_write_tokens: 0 });
    expect(workersAiUsage({ response: "no usage" }, "@cf/x")).toBeNull();
  });

  it("answers without memory when Niadra is down, and passes everything through without a customer", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(503, "unavailable"));
    const down = niadraAgent(fakeAgent("chat-1").agent, { niadra, subject: marina });
    expect(await down.prepare([{ role: "user", content: "hi" }])).toEqual([{ role: "user", content: "hi" }]);

    const nobody = niadraAgent({ name: "anonymous" }, { niadra, subject: () => null });
    expect(nobody.session).toBeNull();
    expect(nobody.tools()).toEqual({});
    const model = new MockLanguageModelV4({
      doGenerate: { content: [{ type: "text", text: "ok" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] },
    });
    const result = await generateText({ model: wrapLanguageModel({ model, middleware: nobody.middleware }), prompt: "hi" });
    expect(result.text).toBe("ok");
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).not.toContain("<context>");
  });
});
