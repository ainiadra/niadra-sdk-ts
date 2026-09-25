import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../../src/index.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, setup, turns } from "./support.js";

// Strands Agents for TypeScript needs Node 22 or later; CI also runs Node 20, where these skip.
const supported = Number(process.versions.node.split(".")[0]) >= 22;
const strands = supported ? await import("@strands-agents/sdk") : null;
const vercel = supported ? await import("@strands-agents/sdk/models/vercel") : null;
const adapter = supported ? await import("../../src/integrations/strands.js") : null;

const usage = { inputTokens: { total: 1600, noCache: 576, cacheRead: 1024, cacheWrite: 0 }, outputTokens: { total: 9, text: 9, reasoning: undefined } };

/** A model that answers in turn through Strands' AI SDK adapter: a text, or a call to one tool. */
function scripted(steps: ({ text: string } | { tool: string; input: unknown })[]) {
  let step = 0;
  const mock = new MockLanguageModelV3({
    provider: "openai.responses",
    modelId: "gpt-4.1",
    doStream: () => {
      const current = steps[Math.min(step++, steps.length - 1)]!;
      const parts =
        "text" in current
          ? [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: current.text },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ]
          : [
              { type: "tool-call", toolCallId: `c${String(step)}`, toolName: current.tool, input: JSON.stringify(current.input) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
            ];
      return Promise.resolve({ stream: convertArrayToReadableStream([{ type: "stream-start", warnings: [] }, ...parts] as never[]) });
    },
  });
  return { mock, model: new vercel!.VercelModel({ provider: mock }) };
}

describe.runIf(supported)("Strands Agents: NiadraPlugin", () => {
  it("puts the pack after the system prompt and the suffix in the last user message, and records both turns", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "st-1" });
    const { mock, model } = scripted([{ text: "Your replacement ships today." }]);
    const agent = new strands!.Agent({
      model,
      systemPrompt: "You are Acme's support agent.",
      plugins: [new adapter!.NiadraPlugin(convo, { verify: { method: "login", level: "V2" } })],
      printer: false,
    });

    const result = await agent.invoke("Where is my replacement?");

    expect(String(result)).toContain("Your replacement ships today.");
    const prompt = mock.doStreamCalls[0]!.prompt as any[];
    expect(prompt[0]).toEqual({ role: "system", content: `You are Acme's support agent.\n\n${PACK}` });
    const user = prompt.at(-1);
    expect(user.role).toBe("user");
    expect(user.content.map((part: any) => part.text)).toEqual(["Where is my replacement?", `\n\n${SUFFIX}`]);
    // The agent's own history keeps what the customer said, without the suffix.
    expect(JSON.stringify(agent.messages)).not.toContain("live_turns");
    await niadra.flush();
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Where is my replacement?"],
      ["ai_agent", "Your replacement ships today."],
    ]);
    expect(turns(server)[1]!.item.usage).toEqual({ provider: "openai", model: "gpt-4.1", prompt_tokens: 1600, cached_tokens: 1024, cache_write_tokens: 0 });
  });

  it("gives the tools, runs the history tool for the customer and records only the final answer", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "st-2" });
    const { mock, model } = scripted([{ tool: "search_customer_history", input: { query: "refund" } }, { text: "You asked for a refund on September 1." }]);
    const agent = new strands!.Agent({ model, plugins: [new adapter!.NiadraPlugin(convo)], printer: false });

    const result = await agent.invoke("Did I ask for a refund?");

    expect(String(result)).toContain("You asked for a refund on September 1.");
    expect(mock.doStreamCalls[0]!.tools!.map((tool: any) => tool.name)).toEqual(TOOL_DEFINITIONS.map((definition) => definition.function.name));
    expect(server.callsTo("POST /v1/history/search")[0]!.body).toMatchObject({ subject: marina, query: "refund", conversation_id: "st-2" });
    await niadra.flush();
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Did I ask for a refund?"],
      ["ai_agent", "You asked for a refund on September 1."],
    ]);
  });

  it("answers without memory when Niadra is down, and passes through without a session", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(503, "unavailable"));
    const convo = niadra.conversation({ subject: marina, channel: "web_chat" });
    const { mock, model } = scripted([{ text: "ok" }]);
    expect(String(await new strands!.Agent({ model, plugins: [new adapter!.NiadraPlugin(convo)], printer: false }).invoke("hi"))).toContain("ok");
    const nobody = new adapter!.NiadraPlugin(() => null);
    expect(nobody.getTools()).toEqual([]);
    expect(String(await new strands!.Agent({ model, plugins: [nobody], printer: false }).invoke("hi"))).toContain("ok");
    expect(mock.doStreamCalls.every((call) => !JSON.stringify(call.prompt).includes("<context>"))).toBe(true);
  });

  it("reads the usage of each provider", () => {
    expect(adapter!.strandsUsage({ inputTokens: 200, cacheReadInputTokens: 1024, cacheWriteInputTokens: 64 }, "bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", true)).toEqual({
      provider: "bedrock", model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", prompt_tokens: 1288, cached_tokens: 1024, cache_write_tokens: 64,
    });
    expect(adapter!.strandsUsage({ inputTokens: 1200, cacheReadInputTokens: 1024 }, "openai", "gpt-4.1", false)).toMatchObject({ prompt_tokens: 1200, cached_tokens: 1024 });
    expect(adapter!.strandsUsage({}, "openai", "gpt-4.1", false)).toBeNull();
  });
});
