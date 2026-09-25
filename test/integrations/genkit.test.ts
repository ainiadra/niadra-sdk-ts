import { genkit } from "genkit";
import { mockModel } from "genkit/testing";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../../src/index.js";
import { genkitUsage, niadraMiddleware, niadraTools } from "../../src/integrations/genkit.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, setup, turns } from "./support.js";

const usage = { inputTokens: 1300, outputTokens: 20, cachedContentTokens: 1024 };

describe("Genkit: niadraMiddleware", () => {
  it("puts the pack in the system message and the suffix in the last user message, and records both turns", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "gk-1" });
    const ai = genkit({});
    const model = mockModel(ai, { name: "scripted", respond: { text: "Your replacement ships today.", usage } });

    const response = await ai.generate({
      model,
      system: "You are Acme's support agent.",
      messages: [
        { role: "user", content: [{ text: "hi" }] },
        { role: "model", content: [{ text: "Hello!" }] },
      ],
      prompt: "Where is my replacement?",
      use: [niadraMiddleware(convo, { model: "googleai/gemini-2.5-flash", verify: { method: "login", level: "V2" } })],
    });

    expect(response.text).toBe("Your replacement ships today.");
    const messages = model.lastRequest!.messages;
    expect(messages.map((message) => [message.role, message.content.map((part) => part.text)])).toEqual([
      ["system", ["You are Acme's support agent.", PACK]],
      ["user", ["hi"]],
      ["model", ["Hello!"]],
      ["user", ["Where is my replacement?", SUFFIX]],
    ]);
    await niadra.flush();
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Where is my replacement?"],
      ["ai_agent", "Your replacement ships today."],
    ]);
    expect(turns(server)[1]!.item.usage).toEqual({ provider: "googleai", model: "gemini-2.5-flash", prompt_tokens: 1300, cached_tokens: 1024, cache_write_tokens: 0 });
  });

  it("runs the history tool in a tool loop, records the customer once and only the final answer", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "gk-2" });
    const ai = genkit({});
    const model = mockModel(ai, {
      name: "looping",
      respond: [{ toolRequests: [{ name: "search_customer_history", input: { query: "refund" }, ref: "t1" }] }, { text: "You asked for a refund on September 1." }],
    });

    const response = await ai.generate({ model, prompt: "Did I ask for a refund?", tools: niadraTools(convo), use: [niadraMiddleware(convo)] });

    expect(response.text).toBe("You asked for a refund on September 1.");
    expect(model.requestCount).toBe(2);
    expect(model.toolResponses.map((result) => result.name)).toEqual(["search_customer_history"]);
    expect(server.callsTo("POST /v1/history/search")[0]!.body).toMatchObject({ subject: marina, query: "refund", conversation_id: "gk-2" });
    // No system message of its own: the pack becomes one.
    expect(model.lastRequest!.messages[0]).toEqual({ role: "system", content: [{ text: PACK }] });
    await niadra.flush();
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Did I ask for a refund?"],
      ["ai_agent", "You asked for a refund on September 1."],
    ]);
    expect(turns(server)[1]!.item.usage).toBeUndefined();
  });

  it("answers without memory when Niadra is down, and passes through without a session", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(503, "unavailable"));
    const convo = niadra.conversation({ subject: marina, channel: "web_chat" });
    const ai = genkit({});
    const model = mockModel(ai, { name: "plain", respond: "ok" });
    expect((await ai.generate({ model, prompt: "hi", use: [niadraMiddleware(convo)] })).text).toBe("ok");
    expect((await ai.generate({ model, prompt: "hi", use: [niadraMiddleware(() => null)] })).text).toBe("ok");
    expect(model.requests.every((request) => !JSON.stringify(request.messages).includes("<context>"))).toBe(true);
  });
});

describe("Genkit: tools and usage", () => {
  it("describes the tools with the canonical definitions", () => {
    const { niadra } = setup();
    const tools = niadraTools(niadra.conversation({ subject: marina, channel: "web_chat" }), { agentMemory: true });
    expect(tools.map((action) => action.__action.name)).toEqual([...TOOL_DEFINITIONS.map((definition) => definition.function.name), "search_agent_memory"]);
    expect(tools[0]!.__action.description).toBe(TOOL_DEFINITIONS[0]!.function.description);
    expect(tools[0]!.__action.inputJsonSchema).toEqual(TOOL_DEFINITIONS[0]!.function.parameters);
  });

  it("reads Genkit's usage", () => {
    expect(genkitUsage({ inputTokens: 500 }, "claude-sonnet-4-5")).toEqual({
      provider: "anthropic", model: "claude-sonnet-4-5", prompt_tokens: 500, cached_tokens: 0, cache_write_tokens: 0,
    });
    expect(genkitUsage({}, "googleai/gemini-2.5-flash")).toBeNull();
  });
});
