import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { describe, expect, it } from "vitest";
import { NiadraCallbackHandler, langchainUsage, niadraContext, niadraTools, withNiadraContext } from "../../src/integrations/langchain.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, sequence, setup, turns } from "./support.js";

/** A chat model that answers from a script and keeps every prompt it received. */
class ScriptedChatModel extends BaseChatModel {
  readonly prompts: BaseMessage[][] = [];
  private step = 0;

  constructor(private readonly script: AIMessage[]) {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  override bindTools(): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.prompts.push(messages);
    const message = this.script[Math.min(this.step++, this.script.length - 1)]!;
    return { generations: [{ text: message.text, message }] };
  }
}

const usage = { input_tokens: 2100, output_tokens: 30, total_tokens: 2130, input_token_details: { cache_read: 2048 } };
// LangChain types `usage_metadata` per message structure; a plain AIMessage carries it at run time.
const answer = (text: string) =>
  new AIMessage({ content: text, usage_metadata: usage, response_metadata: { model_name: "gpt-4.1-2025-04-14", model_provider: "openai" } } as never);

describe("LangChain.js: niadraContext and NiadraCallbackHandler", () => {
  it("puts the pack after the system message and the suffix in the last human message, and records both turns", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "lc-1" });
    const model = new ScriptedChatModel([answer("Your replacement ships today.")]);
    const chain = niadraContext(convo, { verify: { method: "login", level: "V2" } }).pipe(model);

    const reply = await chain.invoke(
      [new SystemMessage("You are Acme's support agent."), new HumanMessage("hi"), new AIMessage("Hello!"), new HumanMessage("Where is my replacement?")],
      { callbacks: [new NiadraCallbackHandler(convo)] },
    );

    expect(reply.text).toBe("Your replacement ships today.");
    expect(model.prompts[0]!.map((message) => [message.type, message.text])).toEqual([
      ["system", "You are Acme's support agent."],
      ["system", PACK],
      ["human", "hi"],
      ["ai", "Hello!"],
      ["human", `Where is my replacement?\n\n${SUFFIX}`],
    ]);
    await niadra.flush();
    expect(sequence(server).indexOf("batch:verify")).toBeLessThan(sequence(server).indexOf("POST /v1/context"));
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Where is my replacement?"],
      ["ai_agent", "Your replacement ships today."],
    ]);
    expect(turns(server)[1]!.item.usage).toEqual({ provider: "openai", model: "gpt-4.1-2025-04-14", prompt_tokens: 2100, cached_tokens: 2048, cache_write_tokens: 0 });
  });

  it("passes the messages through when Niadra fails or no session is found", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(503, "unavailable"));
    const convo = niadra.conversation({ subject: marina, channel: "web_chat" });
    const messages = [new SystemMessage("S"), new HumanMessage("hi")];
    expect((await withNiadraContext(convo, messages)).map((message) => message.text)).toEqual(["S", "hi"]);
    expect((await niadraContext(() => null).invoke({ messages })).map((message) => message.text)).toEqual(["S", "hi"]);
  });

  it("reads LangChain's standard usage, including Anthropic's cache writes", () => {
    const message = new AIMessage({
      content: "ok",
      usage_metadata: { input_tokens: 1000, output_tokens: 5, total_tokens: 1005, input_token_details: { cache_read: 600, cache_creation: 300 } },
      response_metadata: { model: "claude-sonnet-4-5" },
    } as never);
    expect(langchainUsage(message)).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5", prompt_tokens: 1000, cached_tokens: 600, cache_write_tokens: 300 });
    expect(langchainUsage(new AIMessage("no usage"))).toBeNull();
  });
});

describe("LangGraph.js: a graph with the kit", () => {
  it("injects the context in the model node, runs the history tool through ToolNode and keeps the state clean", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "lg-1" });
    const tools = niadraTools(convo);
    const model = new ScriptedChatModel([
      new AIMessage({ content: "", tool_calls: [{ id: "call_1", name: "search_customer_history", args: { query: "refund", filters: { when: "last month" } } }] }),
      answer("You asked for a refund on September 1."),
    ]);
    const graph = new StateGraph(MessagesAnnotation)
      .addNode("agent", async (state) => ({ messages: [await model.invoke(await withNiadraContext(convo, state.messages))] }))
      .addNode("tools", new ToolNode(tools))
      .addEdge(START, "agent")
      .addConditionalEdges("agent", toolsCondition, ["tools", END])
      .addEdge("tools", "agent")
      .compile();

    const result = await graph.invoke({ messages: [new HumanMessage("Did I ask for a refund?")] }, { callbacks: [new NiadraCallbackHandler(convo)] });

    expect(result.messages.at(-1)!.text).toBe("You asked for a refund on September 1.");
    expect(result.messages.some((message) => message.text === PACK)).toBe(false);
    expect(server.callsTo("POST /v1/history/search")[0]!.body).toMatchObject({ subject: marina, query: "refund", filters: { when: "last month" }, conversation_id: "lg-1" });
    const toolMessage = result.messages.find((message) => message.type === "tool")!;
    expect(JSON.parse(toolMessage.text)).toMatchObject({ items: [{ id: "ep_1" }] });
    await niadra.flush();
    expect(turns(server).map((turn) => turn.role)).toEqual(["customer", "ai_agent"]);
  });

  it("names no customer in any tool schema", () => {
    const { niadra } = setup();
    const tools = niadraTools(niadra.conversation({ subject: marina, channel: "web_chat" }), { agentMemory: true });
    expect(tools.map((tool) => tool.name)).toEqual(["search_customer_history", "get_customer_timeline", "open_history_item", "search_agent_memory"]);
    expect(JSON.stringify(tools.map((tool) => tool.schema))).not.toMatch(/subject|phone|customer_id/);
  });
});
