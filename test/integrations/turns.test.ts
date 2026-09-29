import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { generateText, isStepCount, jsonSchema, streamText, tool as aiTool, wrapLanguageModel } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { Niadra, Replayer, silentLogger, tool } from "../../src/index.js";
import { recordTools, niadraMiddleware, niadraTurn } from "../../src/integrations/ai-sdk.js";
import { NiadraCallbackHandler, recordTools as recordLangChainTools } from "../../src/integrations/langchain.js";
import { niadraProcessor } from "../../src/integrations/mastra.js";
import { KEY, marina } from "../helpers.js";
import { Cell } from "../support/cell.js";

type Json = Record<string, any>;

function client(cell: Cell): Niadra {
  return new Niadra({ apiKey: KEY, fetch: cell.fetch, logger: silentLogger, flushOnExit: false, cache: false, turns: { intervalMs: 3_600_000 } });
}

const records = (cell: Cell): Json[] => [...cell.turns.values()];
const summary = (record: Json | undefined): unknown[] =>
  (record?.calls as Json[]).map((c) => (c.kind === "tool" ? ["tool", c.name, c.call_id, c.status] : ["model", c.name, c.tokens ?? null]));
const args = (record: Json, call: Json): unknown => record.blobs[call.args]?.content;

class ScriptedChatModel extends BaseChatModel {
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

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.script[Math.min(this.step++, this.script.length - 1)]!;
    return { generations: [{ text: message.text, message }] };
  }
}

const lcUsage = { input_tokens: 900, output_tokens: 12, total_tokens: 912, input_token_details: { cache_read: 512 } };
const lcAnswer = (text: string, extra: Json = {}) =>
  new AIMessage({ content: text, usage_metadata: lcUsage, response_metadata: { model_name: "gpt-4.1-2025-04-14" }, ...extra } as never);

function graphWith(model: ScriptedChatModel, tools: DynamicStructuredTool[]) {
  return new StateGraph(MessagesAnnotation)
    .addNode("agent", async (state) => ({ messages: [await model.invoke(state.messages)] }))
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition, ["tools", END])
    .addEdge("tools", "agent")
    .compile();
}

const stockLookup = tool("stock", async (sku: string) => ({ sku, qty: 3 }));

describe("LangChain.js turn records", () => {
  it("record a graph run as one turn, with the provider's tool call id and each model call", async () => {
    const cell = new Cell();
    const niadra = client(cell);
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "lg-1", agent_id: "store" });
    const stock = new DynamicStructuredTool({
      name: "stock",
      description: "Units in stock",
      schema: { type: "object" as const, properties: { sku: { type: "string" as const } }, required: ["sku"] },
      func: async (input: Json) => JSON.stringify({ sku: input.sku, qty: 3 }),
    });
    const model = new ScriptedChatModel([
      lcAnswer("", { tool_calls: [{ id: "call_7", name: "stock", args: { sku: "PX" } }] }),
      lcAnswer("Three units of PX."),
    ]);
    await graphWith(model, [stock]).invoke({ messages: [new HumanMessage("Is PX in stock?")] }, { callbacks: [new NiadraCallbackHandler(convo, { turns: true })] });
    await niadra.flush();
    const [record, ...rest] = records(cell);
    expect(rest).toEqual([]);
    expect([record?.build.adapter, record?.conversation_id, record?.agent]).toEqual(["langchain", "lg-1", { name: "store" }]);
    expect(summary(record)).toEqual([
      ["model", "gpt-4.1-2025-04-14", { in: 900, cached: 512, out: 12 }],
      ["tool", "stock", "call_7", "ok"],
      ["model", "gpt-4.1-2025-04-14", { in: 900, cached: 512, out: 12 }],
    ]);
    expect(args(record!, (record!.calls as Json[])[1]!)).toEqual({ sku: "PX" });
    expect(record?.build.pins.model).toBe("gpt-4.1-2025-04-14");
    expect((record?.output as Json).event_keys).toHaveLength(1); // a tool-call answer says nothing
  });

  it("record into the turn in progress, and a tool() inside a tool takes over its call", async () => {
    const cell = new Cell();
    const niadra = client(cell);
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "lg-2" });
    const stock = new DynamicStructuredTool({
      name: "stock",
      description: "Units in stock",
      schema: { type: "object" as const, properties: { sku: { type: "string" as const } }, required: ["sku"] },
      func: async (input: Json) => JSON.stringify(await stockLookup(String(input.sku))),
    });
    const model = new ScriptedChatModel([lcAnswer("", { tool_calls: [{ id: "call_8", name: "stock", args: { sku: "PX" } }] }), lcAnswer("Three.")]);
    const graph = graphWith(model, [stock]);
    await convo.turn(() => graph.invoke({ messages: [new HumanMessage("PX?")] }, { callbacks: [new NiadraCallbackHandler(convo, { turns: true })] }));
    await niadra.flush();
    const [record, ...rest] = records(cell);
    expect(rest).toEqual([]);
    expect(record?.build.adapter).toBeUndefined();
    const tools = (record?.calls as Json[]).filter((c) => c.kind === "tool");
    expect(tools.map((c) => [c.name, c.call_id, c.status])).toEqual([["stock", "call_8", "ok"]]);
    expect(args(record!, tools[0]!)).toBe("PX"); // the arguments the wrapped function recorded
  });

  it("records nothing without turns", async () => {
    const cell = new Cell();
    const niadra = client(cell);
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "lg-3" });
    await new ScriptedChatModel([lcAnswer("ok")]).invoke([new HumanMessage("hi")], { callbacks: [new NiadraCallbackHandler(convo)] });
    await niadra.flush();
    expect(records(cell)).toEqual([]);
  });
});

const aiUsage = { inputTokens: { total: 1800, noCache: 200, cacheRead: 1536, cacheWrite: 64 }, outputTokens: { total: 20, text: 20, reasoning: undefined } };
const aiAnswer = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: aiUsage,
  warnings: [],
  response: { modelId: "gpt-4.1-2025-04-14" },
});

describe("Vercel AI SDK turn records", () => {
  it("record the model calls and the recorded tools of a generateText tool loop inside a turn", async () => {
    const cell = new Cell();
    const niadra = client(cell);
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "ai-1" });
    const model = new MockLanguageModelV4({
      provider: "openai.responses",
      modelId: "gpt-4.1",
      doGenerate: [
        {
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "stock", input: JSON.stringify({ sku: "PX" }) }],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: aiUsage,
          warnings: [],
        },
        aiAnswer("Three units."),
      ],
    });
    const tools = recordTools({
      stock: aiTool({ inputSchema: jsonSchema<{ sku: string }>({ type: "object", properties: { sku: { type: "string" } } }), execute: async ({ sku }) => ({ sku, qty: 3 }) }),
    });
    const result = await convo.turn(() =>
      generateText({ model: wrapLanguageModel({ model, middleware: niadraMiddleware(convo) }), tools, stopWhen: isStepCount(3), prompt: "PX?" }),
    );
    expect(result.text).toBe("Three units.");
    await niadra.flush();
    const [record] = records(cell);
    expect(summary(record)).toEqual([
      ["model", "gpt-4.1", { in: 1800, cached: 1536, out: 20 }],
      ["tool", "stock", "call_1", "ok"],
      ["model", "gpt-4.1-2025-04-14", { in: 1800, cached: 1536, out: 20 }],
    ]);
    expect(args(record!, (record!.calls as Json[])[1]!)).toEqual({ sku: "PX" });
  });

  it("keep a streamText turn open until the stream finishes", async () => {
    const cell = new Cell();
    const niadra = client(cell);
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "ai-2" });
    const model = new MockLanguageModelV4({
      provider: "openai.responses",
      modelId: "gpt-4.1",
      doStream: {
        stream: convertArrayToReadableStream([
          { type: "response-metadata", id: "r1", modelId: "gpt-4.1-2025-04-14" },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Ships today." },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: aiUsage },
        ]),
      },
    });
    const turn = niadraTurn(convo);
    const result = turn.run(() =>
      streamText({ model: wrapLanguageModel({ model, middleware: niadraMiddleware(convo) }), prompt: "When?", onFinish: turn.onFinish, onError: turn.onError }),
    );
    expect(turn.frame.closed).toBe(false);
    expect(await result.text).toBe("Ships today.");
    await niadra.flush();
    const [record] = records(cell);
    expect([record?.build.adapter, record?.turn_id]).toEqual(["ai-sdk", turn.frame.turnId]);
    expect(summary(record)).toEqual([["model", "gpt-4.1-2025-04-14", { in: 1800, cached: 1536, out: 20 }]]);
    expect((record?.output as Json).event_keys).toHaveLength(1);
  });
});

describe("an adapter's turns in a replay", () => {
  it("answer the AI SDK's recorded tools from the record", async () => {
    const cell = new Cell();
    const niadra = client(cell);
    const ran: string[] = [];
    const tools = recordTools({
      stock: aiTool({
        inputSchema: jsonSchema<{ sku: string }>({ type: "object", properties: { sku: { type: "string" } } }),
        execute: async ({ sku }) => {
          ran.push(sku);
          return { sku, qty: 3 };
        },
      }),
    });
    const agent = async (): Promise<string> => {
      const model = new MockLanguageModelV4({
        provider: "openai.responses",
        modelId: "gpt-4.1",
        doGenerate: [
          {
            content: [{ type: "tool-call", toolCallId: "call_1", toolName: "stock", input: JSON.stringify({ sku: "PX" }) }],
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: aiUsage,
            warnings: [],
          },
          aiAnswer("Three units."),
        ],
      });
      const result = await generateText({ model: wrapLanguageModel({ model, middleware: niadraMiddleware(convo) }), tools, stopWhen: isStepCount(3), prompt: "PX?" });
      return result.text;
    };
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "ai-3" });
    const build = Niadra.build({ prompts: { core: "v1" }, model: "gpt-4.1" });
    const turnId = await convo.turn({ build }, async (frame) => {
      convo.agent(await agent());
      return frame.turnId;
    });
    await niadra.flush();
    expect(ran).toEqual(["PX"]);
    const scenario = cell.createScenario([turnId]);
    const run = await new Replayer(niadra, () => agent, { build }).run([scenario.scenario_id], { runs: 3 });
    expect([run.status, run.verdict, run.scenarios[0]?.completed]).toEqual(["done", "pass", 3]);
    expect(ran).toEqual(["PX"]); // every replayed call answered from the record
  });
});

const mastraUsage = { inputTokens: { total: 1200, noCache: 176, cacheRead: 1024, cacheWrite: 0 }, outputTokens: { total: 12, text: 12, reasoning: undefined } };

describe("Mastra turn records", () => {
  it("record a request as one turn, with Mastra's tool call id and each model call", async () => {
    const cell = new Cell();
    const niadra = client(cell);
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "m-1" });
    const model = new MockLanguageModelV4({
      provider: "openai.responses",
      modelId: "gpt-4.1",
      doGenerate: [
        {
          content: [{ type: "tool-call", toolCallId: "c1", toolName: "stock", input: JSON.stringify({ sku: "PX" }) }],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: mastraUsage,
          warnings: [],
        },
        { ...aiAnswer("Three units."), usage: mastraUsage },
      ],
    });
    const processor = niadraProcessor({ turns: true });
    const agent = new Agent({
      id: "store",
      name: "Store",
      model,
      instructions: "You are Acme's store agent.",
      tools: {
        stock: createTool({
          id: "stock",
          description: "Units in stock",
          inputSchema: jsonSchema({ type: "object", properties: { sku: { type: "string" } } }) as never,
          execute: async (input: unknown) => ({ ...(input as Json), qty: 3 }),
        }),
      },
      inputProcessors: [processor],
      outputProcessors: [processor],
    });
    const result = await agent.generate("PX?", { requestContext: new RequestContext([["niadra", convo]]), maxSteps: 3 });
    expect(result.text).toBe("Three units.");
    await niadra.flush();
    const [record, ...rest] = records(cell);
    expect(rest).toEqual([]);
    expect(record?.build.adapter).toBe("mastra");
    expect(summary(record)).toEqual([
      ["model", "gpt-4.1", { in: 1200, cached: 1024, out: 12 }],
      ["tool", "stock", "c1", "ok"],
      ["model", "gpt-4.1", { in: 1200, cached: 1024, out: 12 }],
    ]);
    expect(args(record!, (record!.calls as Json[])[1]!)).toEqual({ sku: "PX" });
    expect((record?.output as Json).event_keys).toHaveLength(1);
  });
});

describe("framework tools in a replay", () => {
  const build = Niadra.build({ prompts: { core: "v1" }, model: "gpt-4.1" });

  it("answer LangChain tools passed through recordTools from the record, and refuse any other", async () => {
    const cell = new Cell();
    const niadra = client(cell);
    const ran: string[] = [];
    const make = (name: string): DynamicStructuredTool =>
      new DynamicStructuredTool({
        name,
        description: "Units in stock",
        schema: { type: "object" as const, properties: { sku: { type: "string" as const } }, required: ["sku"] },
        func: async (input: Json) => {
          ran.push(String(input.sku));
          return JSON.stringify({ sku: input.sku, qty: 3 });
        },
      });
    const [stock] = recordLangChainTools([make("stock")]);
    const script = () => new ScriptedChatModel([new AIMessage({ content: "", tool_calls: [{ id: "call_1", name: "stock", args: { sku: "PX" } }] }), lcAnswer("Three units.")]);
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "lg-r", agent_id: "store" });
    const handler = new NiadraCallbackHandler(convo, { turns: true });
    const agent = (tools: DynamicStructuredTool[]) => async (): Promise<string> => {
      const out = await graphWith(script(), tools).invoke({ messages: [new HumanMessage("PX?")] }, { callbacks: [handler] });
      return JSON.stringify(out.messages.at(-1)?.content);
    };
    const turnId = await convo.turn({ build }, async (frame) => {
      convo.agent(await agent([stock!])());
      return frame.turnId;
    });
    await niadra.flush();
    expect(ran).toEqual(["PX"]);
    const scenario = cell.createScenario([turnId]);
    const run = await new Replayer(niadra, () => agent([stock!]), { build }).run([scenario.scenario_id], { runs: 2 });
    expect([run.verdict, run.scenarios[0]?.completed]).toEqual(["pass", 2]);
    // A tool not passed through recordTools is refused before it runs: the graph's tool node gets the error.
    const refused = await new Replayer(niadra, () => agent([make("stock")]), { build }).run([scenario.scenario_id], { runs: 1 });
    expect(refused.verdict).not.toBe("pass");
    expect(ran).toEqual(["PX"]); // no replayed call ran live
  });

  it("answer every Mastra tool from the record, never live", async () => {
    const cell = new Cell();
    const niadra = client(cell);
    const ran: string[] = [];
    const stock = () =>
      createTool({
        id: "stock",
        description: "Units in stock",
        inputSchema: jsonSchema({ type: "object", properties: { sku: { type: "string" } } }) as never,
        execute: async (input: unknown) => {
          ran.push(String((input as Json).sku));
          return { ...(input as Json), qty: 3 };
        },
      });
    const agent = (tools: Record<string, unknown>) => async (): Promise<string> => {
      const model = new MockLanguageModelV4({
        provider: "openai.responses",
        modelId: "gpt-4.1",
        doGenerate: [
          { content: [{ type: "tool-call", toolCallId: "c1", toolName: "stock", input: JSON.stringify({ sku: "PX" }) }], finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: mastraUsage, warnings: [] },
          { ...aiAnswer("Three units."), usage: mastraUsage },
        ],
      });
      const processor = niadraProcessor({ turns: true });
      const mastra = new Agent({ id: "store", name: "Store", model, instructions: "You are Acme's store agent.", tools: tools as never, inputProcessors: [processor], outputProcessors: [processor] });
      const result = await mastra.generate("PX?", { requestContext: new RequestContext([["niadra", convo]]), maxSteps: 3 });
      if (result.tripwire) throw new Error(result.tripwire.reason);
      return result.text;
    };
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "m-r" });
    const turnId = await convo.turn({ build }, async (frame) => {
      convo.agent(await agent({ stock: stock() })());
      return frame.turnId;
    });
    await niadra.flush();
    expect(ran).toEqual(["PX"]);
    const scenario = cell.createScenario([turnId]);
    const run = await new Replayer(niadra, () => agent({ stock: stock() }), { build }).run([scenario.scenario_id], { runs: 2 });
    expect([run.verdict, run.scenarios[0]?.completed]).toEqual(["pass", 2]);
    expect(ran).toEqual(["PX"]); // no replayed call ran live
  });
});

describe("OpenAI Agents JS turn records", () => {
  it("record a run as one turn, with each tool call and model request", async () => {
    const { Agent: OpenAIAgent, Runner, Usage, setTracingDisabled, tool: agentsTool } = await import("@openai/agents");
    const { niadraRunHooks } = await import("../../src/integrations/openai-agents.js");
    setTracingDisabled(true);
    const cell = new Cell();
    const niadra = client(cell);
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "oa-t" });
    const outputs = [
      [{ type: "function_call", callId: "call_7", name: "stock", arguments: JSON.stringify({ sku: "PX" }), status: "completed" }],
      [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Three units." }] }],
    ];
    let step = 0;
    const model = {
      async getResponse() {
        return { usage: new Usage({ requests: 1, inputTokens: 900, outputTokens: 10, totalTokens: 910 }), output: outputs[Math.min(step++, 1)] as never };
      },
      // eslint-disable-next-line require-yield
      async *getStreamedResponse(): AsyncIterable<never> {
        throw new Error("not used");
      },
    };
    const stock = agentsTool({ name: "stock", description: "Units in stock", parameters: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"], additionalProperties: false } as never, strict: false, execute: async (input) => JSON.stringify({ ...(input as Json), qty: 3 }) });
    const agent = new OpenAIAgent({ name: "Store", model: model, instructions: "Be brief.", tools: [stock] });
    const runner = new Runner();
    const stop = niadraRunHooks(runner, convo, { turns: true });
    const result = await runner.run(agent, "PX?");
    stop();
    expect(result.finalOutput).toBe("Three units.");
    await niadra.flush();
    const [record, ...rest] = records(cell);
    expect(rest).toEqual([]);
    expect(record?.build.adapter).toBe("openai-agents");
    const tool = (record?.calls as Json[]).find((c) => c.kind === "tool");
    expect([tool?.name, tool?.call_id, tool?.status]).toEqual(["stock", "call_7", "ok"]);
    expect(args(record!, tool!)).toEqual({ sku: "PX" });
    expect((record?.calls as Json[]).filter((c) => c.kind === "model").length).toBeGreaterThanOrEqual(1);
  });
});

describe("Google ADK TS turn records", () => {
  const scripted = async (steps: ({ text: string } | { call: string; args: Json })[]) => {
    const { BaseLlm } = await import("@google/adk");
    class ScriptedLlm extends BaseLlm {
      private step = 0;
      async *generateContentAsync(): AsyncGenerator<never, void> {
        const current = steps[Math.min(this.step++, steps.length - 1)]!;
        const part = "text" in current ? { text: current.text } : { functionCall: { id: `f${String(this.step)}`, name: current.call, args: current.args } };
        yield { content: { role: "model", parts: [part] }, usageMetadata: { promptTokenCount: 1400, cachedContentTokenCount: 1024, candidatesTokenCount: 12 } } as never;
      }
      connect(): Promise<never> {
        return Promise.reject(new Error("not used"));
      }
    }
    return new ScriptedLlm({ model: "gemini-2.5-flash" });
  };
  const runAdk = async (agent: unknown, text: string, sessionId: string): Promise<void> => {
    const { InMemoryRunner } = await import("@google/adk");
    const runner = new InMemoryRunner({ agent: agent as never, appName: "acme" });
    await runner.sessionService.createSession({ appName: "acme", userId: "u", sessionId });
    const events: unknown[] = [];
    for await (const event of runner.runAsync({ userId: "u", sessionId, newMessage: { role: "user", parts: [{ text }] } })) events.push(event);
  };

  it("record each agent's run as a turn with its tools and model calls, and answer tools from the record in a replay", async () => {
    const { FunctionTool, LlmAgent } = await import("@google/adk");
    const { niadraAdk } = await import("../../src/integrations/google-adk.js");
    const cell = new Cell();
    const niadra = client(cell);
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "adk-t" });
    const ran: string[] = [];
    const reserve = new FunctionTool({
      name: "reserve",
      description: "Holds one unit",
      parameters: { type: "object", properties: { sku: { type: "string" } } } as never,
      execute: async (input: unknown) => {
        ran.push(String((input as Json).sku));
        return { sku: (input as Json).sku, held: true };
      },
    });
    const agent = async () => {
      const memory = niadraAdk({ session: () => convo, turns: true });
      return new LlmAgent({ name: "store", model: await scripted([{ call: "reserve", args: { sku: "PX" } }, { text: "Held." }]), instruction: "Be brief.", ...memory, tools: [reserve] });
    };
    await runAdk(await agent(), "Hold one PX.", "s1");
    await niadra.flush();
    const [record] = records(cell);
    expect(record?.build.adapter).toBe("google-adk");
    expect(summary(record)).toEqual([
      ["model", "gemini-2.5-flash", { in: 1400, cached: 1024, out: 12 }],
      ["tool", "reserve", "f1", "ok"],
      ["model", "gemini-2.5-flash", { in: 1400, cached: 1024, out: 12 }],
    ]);
    expect(ran).toEqual(["PX"]);
    const build = Niadra.build({ prompts: { core: "v1" }, model: "gemini-2.5-flash" });
    const turnId = await convo.turn({ build }, async (frame) => {
      await runAdk(await agent(), "Hold one PX.", "s2");
      convo.agent("Held.");
      return frame.turnId;
    });
    await niadra.flush();
    ran.length = 0;
    const scenario = cell.createScenario([turnId]);
    const run = await new Replayer(niadra, () => async () => {
      await runAdk(await agent(), "Hold one PX.", `r-${String(Math.random())}`);
      return "Held.";
    }, { build }).run([scenario.scenario_id], { runs: 2 });
    expect(run.scenarios[0]?.completed).toBe(2);
    expect(ran).toEqual([]); // every replayed call answered from the record
  });
});

describe("VoltAgent turn records", () => {
  it("record an operation as one turn, with VoltAgent's tool call id and each model step", async () => {
    const { Agent: VoltAgent, createTool: voltTool } = await import("@voltagent/core");
    const { MockLanguageModelV3 } = await import("ai/test");
    const { niadraHooks } = await import("../../src/integrations/voltagent.js");
    const cell = new Cell();
    const niadra = client(cell);
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "va-t" });
    const usage = { inputTokens: { total: 1500, noCache: 476, cacheRead: 1024, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: undefined } };
    let step = 0;
    const model = new MockLanguageModelV3({
      provider: "openai.responses",
      modelId: "gpt-4.1",
      doGenerate: () =>
        Promise.resolve(
          step++ === 0
            ? { content: [{ type: "tool-call" as const, toolCallId: "call_9", toolName: "stock", input: JSON.stringify({ sku: "PX" }) }], finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [] }
            : { content: [{ type: "text" as const, text: "Three units." }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [], response: { modelId: "gpt-4.1-2025-04-14" } },
        ),
    });
    const stock = voltTool({ name: "stock", description: "Units in stock", parameters: jsonSchema({ type: "object", properties: { sku: { type: "string" } } }) as never, execute: async (input: unknown) => ({ ...(input as Json), qty: 3 }) });
    // VoltAgent types the model and the tool with AI SDK 6's copy of the v3 types.
    const agent = new VoltAgent({ name: "store", instructions: "Be brief.", model: model as never, tools: [stock as never], hooks: niadraHooks({ turns: true }) });
    const result = await agent.generateText("PX?", { context: { niadra: convo }, maxSteps: 3 });
    expect(result.text).toBe("Three units.");
    await niadra.flush();
    const [record, ...rest] = records(cell);
    expect(rest).toEqual([]);
    expect(record?.build.adapter).toBe("voltagent");
    const found = (record?.calls as Json[]).find((c) => c.kind === "tool");
    expect([found?.name, found?.call_id, found?.status]).toEqual(["stock", "call_9", "ok"]);
    expect(args(record!, found!)).toEqual({ sku: "PX" });
    expect((record?.calls as Json[]).filter((c) => c.kind === "model").length).toBe(2);
  });

  it("records nothing without turns", async () => {
    const { Agent: VoltAgent } = await import("@voltagent/core");
    const { MockLanguageModelV3 } = await import("ai/test");
    const { niadraHooks } = await import("../../src/integrations/voltagent.js");
    const cell = new Cell();
    const niadra = client(cell);
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "va-n" });
    const model = new MockLanguageModelV3({ doGenerate: () => Promise.resolve({ content: [{ type: "text" as const, text: "ok" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] }) });
    const agent = new VoltAgent({ name: "store", instructions: "Be brief.", model: model as never, hooks: niadraHooks() });
    await agent.generateText("hi", { context: { niadra: convo } });
    await niadra.flush();
    expect(records(cell)).toEqual([]);
  });
});
