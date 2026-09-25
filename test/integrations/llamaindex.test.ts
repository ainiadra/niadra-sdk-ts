import { SimpleChatEngine } from "@llamaindex/core/chat-engine";
import { ToolCallLLM } from "@llamaindex/core/llms";
import type { ChatMessage, ChatResponse, ChatResponseChunk, LLMChatParamsNonStreaming, LLMChatParamsStreaming, LLMMetadata, ToolCall } from "@llamaindex/core/llms";
import { createMemory } from "@llamaindex/core/memory";
import { agent, multiAgent } from "@llamaindex/workflow";
import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../../src/index.js";
import { NiadraMemory, NiadraMemoryBlock, niadraTools } from "../../src/integrations/llamaindex.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, sent, setup, turns } from "./support.js";

type Step = { text: string } | { tool: ToolCall };

/** A tool-calling LLM that answers from a script and keeps every list of messages it received. */
class ScriptedLLM extends ToolCallLLM {
  supportToolCall = true;
  metadata: LLMMetadata = { model: "scripted", temperature: 0, topP: 1, contextWindow: 128_000, tokenizer: undefined, structuredOutput: false };
  readonly prompts: ChatMessage[][] = [];
  private step = 0;

  constructor(private readonly script: Step[]) {
    super();
  }

  chat(params: LLMChatParamsStreaming): Promise<AsyncIterable<ChatResponseChunk>>;
  chat(params: LLMChatParamsNonStreaming): Promise<ChatResponse>;
  async chat(params: LLMChatParamsStreaming | LLMChatParamsNonStreaming): Promise<AsyncIterable<ChatResponseChunk> | ChatResponse> {
    this.prompts.push(params.messages.map((message) => ({ ...message })));
    const current = this.script[Math.min(this.step++, this.script.length - 1)]!;
    const text = "text" in current ? current.text : "";
    const options = "tool" in current ? { toolCall: [current.tool] } : {};
    if (!params.stream) return { message: { role: "assistant", content: text, options }, raw: null };
    return (async function* () {
      yield { delta: text, raw: null, options };
    })();
  }
}

describe("LlamaIndex.TS: NiadraMemory with an agent", () => {
  it("puts the pack after the system prompt and the suffix in the last user message, and records both turns", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "li-1" });
    const llm = new ScriptedLLM([{ text: "Your replacement ships today." }]);
    const memory = new NiadraMemory(convo, [], { verify: { method: "login", level: "V2" } });
    const support = agent({ llm, systemPrompt: "You are Acme's support agent.", tools: [], memory });

    const result = await support.run("Where is my replacement?");

    expect(result.data.result).toBe("Your replacement ships today.");
    expect(llm.prompts[0]!.map((message) => [message.role, message.content])).toEqual([
      ["system", "You are Acme's support agent."],
      ["system", PACK],
      ["user", `Where is my replacement?\n\n${SUFFIX}`],
    ]);
    // The stored history keeps what the customer said, without the pack or the suffix.
    expect((await memory.get()).map((message) => message.content)).toEqual(["Where is my replacement?", "Your replacement ships today."]);
    await niadra.flush();
    expect(sent(server).find((item) => item.type === "verify")).toMatchObject({ level: "V2", conversation_id: "li-1" });
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Where is my replacement?"],
      ["ai_agent", "Your replacement ships today."],
    ]);
  });

  it("runs the history tool for the customer and records only the final answer", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "li-2" });
    const llm = new ScriptedLLM([
      { tool: { id: "c1", name: "search_customer_history", input: { query: "refund" } } },
      { text: "You asked for a refund on September 1." },
    ]);
    const support = agent({ llm, tools: niadraTools(convo), memory: new NiadraMemory(convo) });

    const result = await support.run("Did I ask for a refund?");

    expect(result.data.result).toBe("You asked for a refund on September 1.");
    expect(server.callsTo("POST /v1/history/search")[0]!.body).toMatchObject({ subject: marina, query: "refund", conversation_id: "li-2" });
    // The second model call sees the tool result, and the context again at the end of the customer's message.
    const second = llm.prompts[1]!;
    expect(second.some((message) => typeof message.content === "string" && message.content.includes("Asked for a refund"))).toBe(true);
    await niadra.flush();
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Did I ask for a refund?"],
      ["ai_agent", "You asked for a refund on September 1."],
    ]);
  });

  it("records a handoff between agents", async () => {
    const { server, niadra } = setup({ live: false });
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "li-3" });
    const front = new ScriptedLLM([{ tool: { id: "h1", name: "handOff", input: { toAgent: "Billing", reason: "invoice" } } }]);
    const billing = new ScriptedLLM([{ text: "Your invoice is paid." }]);
    const frontAgent = agent({ name: "Front", description: "Answers first", llm: front, tools: [], canHandoffTo: ["Billing"] }).getAgents()[0]!;
    const billingAgent = agent({ name: "Billing", description: "Invoices", llm: billing, tools: [] }).getAgents()[0]!;
    const workflow = multiAgent({ agents: [frontAgent, billingAgent], rootAgent: frontAgent, memory: new NiadraMemory(convo) });

    const result = await workflow.run("Is my invoice paid?");

    expect(result.data.result).toBe("Your invoice is paid.");
    await niadra.flush();
    expect(sent(server).filter((item) => item.type === "handoff")).toMatchObject([{ target: "agent", reason: "to Billing", conversation_id: "li-3" }]);
    expect(turns(server).map((turn) => turn.role)).toEqual(["customer", "ai_agent"]);
  });

  it("answers without memory when Niadra is down, and passes through without a session", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(503, "unavailable"));
    const convo = niadra.conversation({ subject: marina, channel: "web_chat" });
    const llm = new ScriptedLLM([{ text: "ok" }]);
    expect((await agent({ llm, tools: [], memory: new NiadraMemory(convo) }).run("hi")).data.result).toBe("ok");
    expect((await agent({ llm, tools: [], memory: new NiadraMemory(() => null) }).run("hi")).data.result).toBe("ok");
    expect(llm.prompts.every((prompt) => !JSON.stringify(prompt).includes("<context>"))).toBe(true);
  });
});

describe("LlamaIndex.TS: chat engine, memory block and tools", () => {
  it("works with SimpleChatEngine", async () => {
    const { server, niadra } = setup({ live: false });
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "li-4" });
    const llm = new ScriptedLLM([{ text: "Hello Marina." }]);
    const engine = new SimpleChatEngine({ llm, memory: new NiadraMemory(convo) });

    const response = await engine.chat({ message: "hi" });

    expect(response.message.content).toBe("Hello Marina.");
    expect(llm.prompts[0]!.map((message) => [message.role, message.content])).toEqual([
      ["system", PACK],
      ["user", "hi"],
    ]);
    await niadra.flush();
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "hi"],
      ["ai_agent", "Hello Marina."],
    ]);
  });

  it("gives the context as a fixed block of a memory built elsewhere", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "li-5" });
    const memory = createMemory({ memoryBlocks: [new NiadraMemoryBlock(convo)] });
    await memory.add({ role: "user", content: "Where is my replacement?" });
    const messages = await memory.getLLM();
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["system", `${PACK}\n\n${SUFFIX}`],
      ["user", "Where is my replacement?"],
    ]);
    await niadra.flush();
    expect(turns(server).map((turn) => turn.text)).toEqual(["Where is my replacement?"]);
  });

  it("describes the tools with the canonical definitions and binds the customer", async () => {
    const { server, niadra } = setup();
    const tools = niadraTools(niadra.conversation({ subject: marina, channel: "web_chat" }), { agentMemory: { write: true } });
    expect(tools.slice(0, 3).map((tool) => tool.metadata)).toEqual(
      TOOL_DEFINITIONS.map(({ function: definition }) => ({ name: definition.name, description: definition.description, parameters: definition.parameters })),
    );
    expect(tools.map((tool) => tool.metadata.name).slice(3)).toEqual(["search_agent_memory", "remember"]);
    const output = await tools[0]!.call({ query: "refund", subject: { type: "phone_e164", value: "+15550000000" } });
    expect(JSON.parse(output).items).toHaveLength(1);
    expect(server.callsTo("POST /v1/history/search")[0]!.body.subject).toEqual(marina);
  });
});
