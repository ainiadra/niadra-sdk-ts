import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { mastraUsage, niadraInstructions, niadraProcessor, niadraTools } from "../../src/integrations/mastra.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, setup, turns } from "./support.js";

const usage = { inputTokens: { total: 1200, noCache: 176, cacheRead: 1024, cacheWrite: 0 }, outputTokens: { total: 12, text: 12, reasoning: undefined } };
const finish = { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage };

function streamOf(parts: unknown[]) {
  return { stream: convertArrayToReadableStream(parts as never[]) };
}

function textStream(text: string) {
  return streamOf([
    { type: "stream-start", warnings: [] },
    { type: "response-metadata", id: "r1", modelId: "gpt-4.1-2025-04-14" },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    finish,
  ]);
}

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage,
  warnings: [],
  response: { modelId: "gpt-4.1-2025-04-14" },
});

/** A mock model that answers in turn, by generate or by stream, whichever Mastra calls. */
function scripted(steps: ({ text: string } | { tool: string; input: unknown })[], options: { provider?: string; modelId?: string } = {}) {
  let step = 0;
  const next = () => steps[Math.min(step++, steps.length - 1)]!;
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    ...options,
    doGenerate: () => {
      const current = next();
      return Promise.resolve(
        "text" in current
          ? textResult(current.text)
          : {
              content: [{ type: "tool-call" as const, toolCallId: `c${String(step)}`, toolName: current.tool, input: JSON.stringify(current.input) }],
              finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
              usage,
              warnings: [],
            },
      );
    },
    doStream: () => {
      const current = next();
      return Promise.resolve(
        "text" in current
          ? textStream(current.text)
          : streamOf([
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: `c${String(step)}`, toolName: current.tool, input: JSON.stringify(current.input) },
              { ...finish, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
            ]),
      );
    },
  });
  return model;
}

function calls(model: MockLanguageModelV4) {
  return [...model.doGenerateCalls, ...model.doStreamCalls];
}

function agentWith(model: MockLanguageModelV4) {
  const processor = niadraProcessor();
  return new Agent({
    id: "support",
    name: "Support",
    model,
    instructions: "You are Acme's support agent.",
    tools: ({ requestContext }) => niadraTools(requestContext.get("niadra")),
    inputProcessors: [processor],
    outputProcessors: [processor],
  });
}

describe("Mastra", () => {
  it("injects the context into the model call only, and records the customer and the answer", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "m-1" });
    const model = scripted([{ text: "It ships today." }], { provider: "openai.responses", modelId: "gpt-4.1" });

    const result = await agentWith(model).generate("Where is my replacement?", { requestContext: new RequestContext([["niadra", convo]]) });

    expect(result.text).toBe("It ships today.");
    const prompt = calls(model)[0]!.prompt as any[];
    const systemIndex = prompt.findIndex((message) => message.content === PACK);
    expect(systemIndex).toBeGreaterThan(0);
    expect(prompt.slice(0, systemIndex).every((message) => message.role === "system")).toBe(true);
    const lastUser = prompt.filter((message) => message.role === "user").at(-1);
    expect(lastUser.content.at(-1)).toEqual({ type: "text", text: SUFFIX });
    await niadra.flush();
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Where is my replacement?"],
      ["ai_agent", "It ships today."],
    ]);
    expect(turns(server)[1]!.item.usage).toEqual({ provider: "openai", model: "gpt-4.1", prompt_tokens: 1200, cached_tokens: 1024, cache_write_tokens: 0 });
  });

  it("runs the history tool for the customer in the request context", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "m-2" });
    const model = scripted([{ tool: "search_customer_history", input: { query: "refund" } }, { text: "You asked for a refund on September 1." }], {
      provider: "openai.responses",
      modelId: "gpt-4.1",
    });
    const result = await agentWith(model).generate("Did I ask for a refund?", {
      requestContext: new RequestContext([["niadra", convo]]),
      maxSteps: 3,
    });
    expect(result.text).toBe("You asked for a refund on September 1.");
    expect(server.callsTo("POST /v1/history/search")[0]!.body).toMatchObject({ subject: marina, query: "refund", conversation_id: "m-2" });
    await niadra.flush();
    expect(turns(server).filter((turn) => turn.role === "customer")).toHaveLength(1);
  });

  it("answers without memory when Niadra is down, and without tools when no conversation is set", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(503, "unavailable"));
    const convo = niadra.conversation({ subject: marina, channel: "web_chat" });
    const model = scripted([{ text: "ok" }]);
    const agent = agentWith(model);
    expect((await agent.generate("hi", { requestContext: new RequestContext([["niadra", convo]]) })).text).toBe("ok");
    expect((await agent.generate("hi")).text).toBe("ok");
    const prompts = calls(model).map((call) => JSON.stringify(call.prompt));
    expect(prompts.every((prompt) => !prompt.includes("<context>"))).toBe(true);
    expect(niadraTools(undefined)).toEqual({});
  });

  it("builds instructions with the context for agents without processors", async () => {
    const { niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat" });
    const instructions = niadraInstructions("You are Acme's support agent.");
    expect(await instructions({ requestContext: new RequestContext([["niadra", convo]]) })).toBe(
      `You are Acme's support agent.\n\n${PACK}\n\n${SUFFIX}`,
    );
  });

  it("reads Mastra's usage", () => {
    expect(mastraUsage({ inputTokens: 500, cachedInputTokens: 256 }, { provider: "anthropic.messages", modelId: "claude-sonnet-4-5" })).toEqual({
      provider: "anthropic", model: "claude-sonnet-4-5", prompt_tokens: 500, cached_tokens: 256, cache_write_tokens: 0,
    });
    expect(mastraUsage({}, null)).toBeNull();
  });
});
