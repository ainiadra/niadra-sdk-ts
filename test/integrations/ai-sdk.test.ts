import { generateText, isStepCount, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV3, MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { aiSdkUsage, niadraMiddleware, niadraTools } from "../../src/integrations/ai-sdk.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, sequence, setup, turns } from "./support.js";

const usageV4 = {
  inputTokens: { total: 1800, noCache: 200, cacheRead: 1536, cacheWrite: 64 },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function answer(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: usageV4,
    warnings: [],
    response: { modelId: "gpt-4.1-2025-04-14" },
  };
}

function prompts(model: MockLanguageModelV4): unknown[][] {
  return [...model.doGenerateCalls, ...model.doStreamCalls].map((call) => call.prompt as unknown[]);
}

describe("Vercel AI SDK: niadraMiddleware", () => {
  it("puts the pack after the system prompt, the suffix in the last user message, and records both turns", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "chat-1" });
    const model = new MockLanguageModelV4({ provider: "openai.chat", modelId: "gpt-4.1", doGenerate: answer("Your replacement ships today.") });

    const result = await generateText({
      model: wrapLanguageModel({ model, middleware: niadraMiddleware(convo, { verify: { method: "login", level: "V2" } }) }),
      system: "You are Acme's support agent.",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "Where is my replacement?" },
      ],
    });

    expect(result.text).toBe("Your replacement ships today.");
    expect(prompts(model)[0]).toEqual([
      { role: "system", content: "You are Acme's support agent." },
      { role: "system", content: PACK },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
      { role: "user", content: [{ type: "text", text: "Where is my replacement?" }, { type: "text", text: SUFFIX }] },
    ]);
    await niadra.flush();
    expect(sequence(server).indexOf("batch:verify")).toBeLessThan(sequence(server).indexOf("POST /v1/context"));
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Where is my replacement?"],
      ["ai_agent", "Your replacement ships today."],
    ]);
    expect(turns(server)[1]!.item.usage).toEqual({ provider: "openai", model: "gpt-4.1-2025-04-14", prompt_tokens: 1800, cached_tokens: 1536, cache_write_tokens: 64 });
    expect(turns(server)[1]!.item.context_stamp.etag).toBe("etag-1");
  });

  it("runs the history tool in a tool loop, recording the customer once and the final answer", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "chat-2" });
    const model = new MockLanguageModelV4({
      provider: "anthropic.messages",
      modelId: "claude-sonnet-4-5",
      doGenerate: [
        {
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "search_customer_history", input: JSON.stringify({ query: "refund" }) }],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage: usageV4,
          warnings: [],
        },
        answer("You asked for a refund on September 1."),
      ],
    });

    const result = await generateText({
      model: wrapLanguageModel({ model, middleware: niadraMiddleware(convo) }),
      tools: niadraTools(convo),
      stopWhen: isStepCount(3),
      prompt: "Did I ask for a refund before?",
    });

    expect(result.text).toBe("You asked for a refund on September 1.");
    expect(server.callsTo("POST /v1/history/search")[0]!.body).toMatchObject({ subject: marina, query: "refund", conversation_id: "chat-2" });
    const toolResult = (prompts(model)[1]!.find((message: any) => message.role === "tool") as any).content[0];
    expect(toolResult.output).toMatchObject({ type: "json", value: { items: [{ id: "ep_1" }] } });
    await niadra.flush();
    expect(turns(server).map((turn) => turn.role)).toEqual(["customer", "ai_agent"]);
  });

  it("records a streamed answer when the stream ends, with its usage", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat" });
    const model = new MockLanguageModelV4({
      provider: "openai.responses",
      modelId: "gpt-4.1",
      doStream: {
        stream: convertArrayToReadableStream([
          { type: "response-metadata", id: "r1", modelId: "gpt-4.1-2025-04-14" },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Ships " },
          { type: "text-delta", id: "t", delta: "today." },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usageV4 },
        ]),
      },
    });
    const result = streamText({ model: wrapLanguageModel({ model, middleware: niadraMiddleware(convo) }), prompt: "When?" });
    expect(await result.text).toBe("Ships today.");
    await niadra.flush();
    const agentTurn = turns(server).find((turn) => turn.role === "ai_agent")!;
    expect(agentTurn.text).toBe("Ships today.");
    expect(agentTurn.item.usage).toMatchObject({ provider: "openai", model: "gpt-4.1-2025-04-14", cached_tokens: 1536 });
  });

  it("wraps an AI SDK 6 model (specification v3) the same way", async () => {
    const { niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat" });
    const model = new MockLanguageModelV3({ provider: "google.generative-ai", modelId: "gemini-2.5-flash", doGenerate: answer("ok") as never });
    await generateText({ model: wrapLanguageModel({ model, middleware: niadraMiddleware(convo) }), system: "Be brief.", prompt: "hi" });
    expect((model.doGenerateCalls[0]!.prompt as unknown[])[1]).toEqual({ role: "system", content: PACK });
  });

  it("leaves the call untouched when Niadra fails, or when the resolver finds no session", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(503, "unavailable"));
    const model = new MockLanguageModelV4({ doGenerate: answer("fine") });
    const convo = niadra.conversation({ subject: marina, channel: "web_chat" });
    await generateText({ model: wrapLanguageModel({ model, middleware: niadraMiddleware(convo) }), system: "S", prompt: "hi" });
    await generateText({ model: wrapLanguageModel({ model, middleware: niadraMiddleware(() => null) }), system: "S", prompt: "hi" });
    for (const prompt of prompts(model)) {
      expect(prompt).toEqual([
        { role: "system", content: "S" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ]);
    }
  });

  it("offers the model the kit with the SDK's descriptions and no customer parameter", async () => {
    const { niadra } = setup();
    const tools = niadraTools(niadra.conversation({ subject: marina, channel: "web_chat" }));
    expect(Object.keys(tools)).toEqual(["search_customer_history", "get_customer_timeline", "open_history_item"]);
    const schema = await (tools.search_customer_history!.inputSchema as any).jsonSchema;
    expect(Object.keys(schema.properties)).not.toContain("subject");
  });

  it("puts the agent's own notes before the customer's pack and offers its memory tools", async () => {
    const { server, niadra } = setup({ live: false });
    const notes = "<agent_memory>\n- Credit shows after refresh\n</agent_memory>";
    server.on("GET /v1/agent-memory/block", { body: { text: notes, notes: ["n1"], etag: "am-1", tokens: 9, enabled: true } });
    const convo = niadra.conversation({ subject: marina, channel: "web_chat" });
    const model = new MockLanguageModelV4({ doGenerate: answer("ok") });
    await generateText({ model: wrapLanguageModel({ model, middleware: niadraMiddleware(convo, { agentMemory: true }) }), system: "S", prompt: "hi" });
    expect(prompts(model)[0]![1]).toEqual({ role: "system", content: `${notes}\n\n${PACK}` });
    expect(server.callsTo("GET /v1/agent-memory/block")[0]!.url.searchParams.get("view")).toBe("chat");
    expect(Object.keys(niadraTools(convo, { agentMemory: { write: true } }))).toEqual([
      "search_customer_history", "get_customer_timeline", "open_history_item", "search_agent_memory", "remember",
    ]);
  });

  it("reads the usage of AI SDK 5 (numbers) and 6 and 7 (split input)", () => {
    expect(aiSdkUsage({ inputTokens: 900, outputTokens: 10, cachedInputTokens: 512 }, { provider: "openai.chat", modelId: "gpt-4o" })).toEqual({
      provider: "openai", model: "gpt-4o", prompt_tokens: 900, cached_tokens: 512, cache_write_tokens: 0,
    });
    expect(aiSdkUsage({ inputTokens: { noCache: 100, cacheRead: 50, cacheWrite: 10 } }, { provider: "anthropic.messages", modelId: "claude" })).toMatchObject({ prompt_tokens: 160 });
    expect(aiSdkUsage({ inputTokens: undefined }, { provider: "x", modelId: "y" })).toBeNull();
  });
});
