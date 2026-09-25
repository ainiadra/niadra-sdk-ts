import { BaseLlm, InMemoryRunner, LlmAgent } from "@google/adk";
import type { BaseLlmConnection, LlmRequest, LlmResponse } from "@google/adk";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../../src/index.js";
import { adkUsage, niadraAdk } from "../../src/integrations/google-adk.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, sent, setup, turns } from "./support.js";

type Step = { text: string } | { call: string; args: Record<string, unknown> };

/** A model that answers from a script and keeps a copy of every request it received. */
class ScriptedLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  private step = 0;

  constructor(private readonly script: Step[]) {
    super({ model: "gemini-2.5-flash" });
  }

  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.requests.push(structuredClone({ contents: request.contents, config: { systemInstruction: request.config?.systemInstruction, tools: request.config?.tools } }) as LlmRequest);
    const current = this.script[Math.min(this.step++, this.script.length - 1)]!;
    const part = "text" in current ? { text: current.text } : { functionCall: { id: `f${String(this.step)}`, name: current.call, args: current.args } };
    yield {
      content: { role: "model", parts: [part] },
      usageMetadata: { promptTokenCount: 1400, cachedContentTokenCount: 1024, candidatesTokenCount: 12 },
      modelVersion: "gemini-2.5-flash-001",
    };
  }

  connect(): Promise<BaseLlmConnection> {
    return Promise.reject(new Error("live is not used here"));
  }
}

async function run(agent: LlmAgent, text: string, sessionId = "s1"): Promise<string> {
  const runner = new InMemoryRunner({ agent, appName: "acme" });
  await runner.sessionService.createSession({ appName: "acme", userId: "user-1", sessionId });
  let answer = "";
  for await (const event of runner.runAsync({ userId: "user-1", sessionId, newMessage: { role: "user", parts: [{ text }] } })) {
    const parts = event.content?.parts ?? [];
    const said = parts.map((part) => part.text ?? "").join("");
    if (said) answer = said;
  }
  return answer;
}

describe("Google ADK: niadraAdk", () => {
  it("puts the pack after the instruction and the suffix in the last user content, and records both turns", async () => {
    const { server, niadra } = setup();
    const memory = niadraAdk({
      session: (context) => niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: `adk-${context.sessionId}` }),
      verify: { method: "login", level: "V2" },
    });
    const llm = new ScriptedLlm([{ text: "Your replacement ships today." }]);
    const agent = new LlmAgent({ name: "support", model: llm, instruction: "You are Acme's support agent.", ...memory });

    expect(await run(agent, "Where is my replacement?")).toBe("Your replacement ships today.");

    const request = llm.requests[0]!;
    const system = request.config!.systemInstruction;
    const systemText = typeof system === "string" ? system : JSON.stringify(system);
    expect(systemText.indexOf("You are Acme's support agent.")).toBeGreaterThanOrEqual(0);
    expect(systemText.indexOf("You are Acme's support agent.")).toBeLessThan(systemText.indexOf(PACK));
    expect(request.contents.at(-1)!.parts!.map((part) => part.text)).toEqual(["Where is my replacement?", SUFFIX]);
    await niadra.flush();
    expect(sent(server).find((item) => item.type === "verify")).toMatchObject({ level: "V2", conversation_id: "adk-s1" });
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Where is my replacement?"],
      ["ai_agent", "Your replacement ships today."],
    ]);
    expect(turns(server)[1]!.item.usage).toEqual({ provider: "google", model: "gemini-2.5-flash-001", prompt_tokens: 1400, cached_tokens: 1024, cache_write_tokens: 0 });
  });

  it("runs the history tool for the customer of the ADK session, and records only the final answer", async () => {
    const { server, niadra } = setup();
    const memory = niadraAdk({ session: () => niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "adk-2" }) });
    const llm = new ScriptedLlm([{ call: "search_customer_history", args: { query: "refund" } }, { text: "You asked for a refund on September 1." }]);
    const agent = new LlmAgent({ name: "support", model: llm, instruction: "Be brief.", ...memory });

    expect(await run(agent, "Did I ask for a refund?")).toBe("You asked for a refund on September 1.");

    const declared = (llm.requests[0]!.config!.tools as any[]).flatMap((tool) => tool.functionDeclarations ?? []);
    expect(declared.map((declaration: any) => declaration.name)).toEqual(TOOL_DEFINITIONS.map((definition) => definition.function.name));
    expect(declared[0].parametersJsonSchema).toEqual(TOOL_DEFINITIONS[0]!.function.parameters);
    expect(server.callsTo("POST /v1/history/search")[0]!.body).toMatchObject({ subject: marina, query: "refund", conversation_id: "adk-2" });
    await niadra.flush();
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Did I ask for a refund?"],
      ["ai_agent", "You asked for a refund on September 1."],
    ]);
  });

  it("records a transfer between agents as a handoff", async () => {
    const { server, niadra } = setup({ live: false });
    const memory = niadraAdk({ session: niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "adk-3" }) });
    const billing = new LlmAgent({ name: "billing", description: "Invoices", model: new ScriptedLlm([{ text: "Your invoice is paid." }]), ...memory });
    const front = new LlmAgent({
      name: "front",
      model: new ScriptedLlm([{ call: "transfer_to_agent", args: { agent_name: "billing" } }]),
      instruction: "Route the customer.",
      subAgents: [billing],
      ...memory,
    });

    expect(await run(front, "Is my invoice paid?")).toBe("Your invoice is paid.");
    await niadra.flush();
    expect(sent(server).filter((item) => item.type === "handoff")).toMatchObject([{ target: "agent", reason: "front to billing", conversation_id: "adk-3" }]);
    expect(turns(server).map((turn) => turn.role)).toEqual(["customer", "ai_agent"]);
  });

  it("answers without memory when Niadra is down, and passes through without a session", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(503, "unavailable"));
    const down = niadraAdk({ session: () => niadra.conversation({ subject: marina, channel: "web_chat" }) });
    const llm = new ScriptedLlm([{ text: "ok" }]);
    expect(await run(new LlmAgent({ name: "a", model: llm, instruction: "Hi.", ...down }), "hi")).toBe("ok");
    const nobody = niadraAdk({ session: () => null });
    expect(await run(new LlmAgent({ name: "b", model: llm, instruction: "Hi.", ...nobody }), "hi", "s2")).toBe("ok");
    expect(llm.requests.every((request) => !JSON.stringify(request).includes("<context>"))).toBe(true);
  });

  it("reads usageMetadata", () => {
    expect(adkUsage({ usageMetadata: { promptTokenCount: 300 } }, "models/gemini-2.5-pro")).toEqual({
      provider: "google", model: "gemini-2.5-pro", prompt_tokens: 300, cached_tokens: 0, cache_write_tokens: 0,
    });
    expect(adkUsage({}, "gemini-2.5-pro")).toBeNull();
  });
});
