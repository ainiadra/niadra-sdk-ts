import { Agent } from "@voltagent/core";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../../src/index.js";
import { niadraHooks, niadraTools, voltAgentUsage } from "../../src/integrations/voltagent.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, setup, turns } from "./support.js";

// VoltAgent 2.x runs on AI SDK 6 (the repository's .pnpmfile.cjs gives it that copy), which takes
// models of the v3 specification.
const usage = { inputTokens: { total: 1500, noCache: 476, cacheRead: 1024, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: undefined } };

/** A mock model that answers in turn: a text, or a call to one tool. */
function scripted(steps: ({ text: string } | { tool: string; input: unknown })[]) {
  let step = 0;
  return new MockLanguageModelV3({
    provider: "openai.responses",
    modelId: "gpt-4.1",
    doGenerate: () => {
      const current = steps[Math.min(step++, steps.length - 1)]!;
      return Promise.resolve(
        "text" in current
          ? { content: [{ type: "text" as const, text: current.text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [], response: { modelId: "gpt-4.1-2025-04-14" } }
          : {
              content: [{ type: "tool-call" as const, toolCallId: `c${String(step)}`, toolName: current.tool, input: JSON.stringify(current.input) }],
              finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
              usage,
              warnings: [],
            },
      );
    },
  });
}

function agentWith(model: MockLanguageModelV3, hooks = niadraHooks()) {
  // The mock comes from AI SDK 7's copy of the v3 types; VoltAgent types the model with AI SDK 6's.
  return new Agent({ name: "support", instructions: "You are Acme's support agent.", model: model as never, hooks });
}

describe("VoltAgent: niadraHooks", () => {
  it("puts the pack after the instructions and the suffix in the last user message, and records both turns", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "va-1" });
    const model = scripted([{ text: "Your replacement ships today." }]);

    const result = await agentWith(model).generateText("Where is my replacement?", { context: { niadra: convo } });

    expect(result.text).toBe("Your replacement ships today.");
    const prompt = model.doGenerateCalls[0]!.prompt as any[];
    const packAt = prompt.findIndex((message) => message.role === "system" && message.content === PACK);
    expect(packAt).toBeGreaterThan(0);
    expect(prompt.slice(0, packAt).every((message) => message.role === "system")).toBe(true);
    expect(prompt[0].content).toContain("You are Acme's support agent.");
    expect(prompt.at(-1).content.at(-1)).toEqual({ type: "text", text: SUFFIX });
    await niadra.flush();
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Where is my replacement?"],
      ["ai_agent", "Your replacement ships today."],
    ]);
    expect(turns(server)[1]!.item.usage).toEqual({ provider: "openai", model: "gpt-4.1-2025-04-14", prompt_tokens: 1500, cached_tokens: 1024, cache_write_tokens: 0 });
  });

  it("runs the history tool for the customer of the operation", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "va-2" });
    const model = scripted([{ tool: "search_customer_history", input: { query: "refund" } }, { text: "You asked for a refund on September 1." }]);

    const result = await agentWith(model).generateText("Did I ask for a refund?", { context: { niadra: convo }, tools: niadraTools(convo), maxSteps: 3 });

    expect(result.text).toBe("You asked for a refund on September 1.");
    expect(server.callsTo("POST /v1/history/search")[0]!.body).toMatchObject({ subject: marina, query: "refund", conversation_id: "va-2" });
    await niadra.flush();
    expect(turns(server).map((turn) => turn.role)).toEqual(["customer", "ai_agent"]);
  });

  it("answers without memory when Niadra is down, and passes through without a session", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(503, "unavailable"));
    const convo = niadra.conversation({ subject: marina, channel: "web_chat" });
    const model = scripted([{ text: "ok" }]);
    const agent = agentWith(model);
    expect((await agent.generateText("hi", { context: { niadra: convo } })).text).toBe("ok");
    expect((await agent.generateText("hi")).text).toBe("ok");
    expect(model.doGenerateCalls.every((call) => !JSON.stringify(call.prompt).includes("<context>"))).toBe(true);
  });
});

describe("VoltAgent: tools and usage", () => {
  it("describes the tools with the canonical definitions", () => {
    const { niadra } = setup();
    const tools = niadraTools(niadra.conversation({ subject: marina, channel: "web_chat" }), { agentMemory: { write: true } });
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_DEFINITIONS.map((definition) => definition.function.name), "search_agent_memory", "remember"]);
    expect(tools[0]!.description).toBe(TOOL_DEFINITIONS[0]!.function.description);
    expect((tools[0]!.parameters as any).jsonSchema).toEqual(TOOL_DEFINITIONS[0]!.function.parameters);
  });

  it("reads the usage VoltAgent reports", () => {
    expect(voltAgentUsage({ inputTokens: 800, cachedInputTokens: 512 }, "claude-sonnet-4-5")).toEqual({
      provider: "anthropic", model: "claude-sonnet-4-5", prompt_tokens: 800, cached_tokens: 512, cache_write_tokens: 0,
    });
    expect(voltAgentUsage({}, "gpt-4.1")).toBeNull();
  });
});
