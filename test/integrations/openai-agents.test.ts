import { Agent, Runner, Usage, setTracingDisabled } from "@openai/agents";
import type { Model, ModelRequest, ModelResponse } from "@openai/agents";
import { beforeAll, describe, expect, it } from "vitest";
import { NiadraSession, niadraInstructions, niadraRunHooks, niadraTools } from "../../src/integrations/openai-agents.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, sent, setup, turns } from "./support.js";

beforeAll(() => {
  setTracingDisabled(true);
});

/** A model that answers from a script and keeps every request. */
class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];
  private step = 0;

  constructor(private readonly script: ModelResponse["output"][]) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const output = this.script[Math.min(this.step++, this.script.length - 1)]!;
    return { usage: new Usage({ requests: 1, inputTokens: 900, outputTokens: 10, totalTokens: 910 }), output };
  }

  // eslint-disable-next-line require-yield
  async *getStreamedResponse(): AsyncIterable<never> {
    throw new Error("not used");
  }
}

const say = (text: string): ModelResponse["output"] => [
  { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] },
];

describe("OpenAI Agents SDK", () => {
  it("puts the context in the instructions, runs the kit bound to the customer and records the turns through the session", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "oa-1" });
    const model = new ScriptedModel([
      [{ type: "function_call", callId: "call_1", name: "search_customer_history", arguments: JSON.stringify({ query: "refund" }), status: "completed" }],
      say("You asked for a refund on September 1."),
    ]);
    const agent = new Agent({
      name: "Support",
      model,
      instructions: niadraInstructions("You are Acme's support agent.", convo, { verify: { method: "login", level: "V2" } }),
      tools: niadraTools(convo),
    });

    const result = await new Runner().run(agent, "Did I ask for a refund?", { session: new NiadraSession(convo) });

    expect(result.finalOutput).toBe("You asked for a refund on September 1.");
    expect(model.requests[0]!.systemInstructions).toBe(`You are Acme's support agent.\n\n${PACK}\n\n${SUFFIX}`);
    expect(model.requests[0]!.tools.map((tool) => tool.name)).toEqual(["search_customer_history", "get_customer_timeline", "open_history_item"]);
    expect(server.callsTo("POST /v1/history/search")[0]!.body).toMatchObject({ subject: marina, query: "refund", verification: "V2", conversation_id: "oa-1" });
    await niadra.flush();
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Did I ask for a refund?"],
      ["ai_agent", "You asked for a refund on September 1."],
    ]);
  });

  it("keeps the run's items in the inner session", async () => {
    const { niadra } = setup();
    const session = new NiadraSession(niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "oa-2" }));
    const agent = new Agent({ name: "Support", model: new ScriptedModel([say("Hi!")]), instructions: "Be brief." });
    await new Runner().run(agent, "hello", { session });
    const items = await session.getItems();
    expect(items.map((item: any) => item.role)).toEqual(["user", "assistant"]);
    expect(await session.getSessionId()).toBe("oa-2");
  });

  it("records a handoff between agents", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "oa-3" });
    const billing = new Agent({ name: "Billing", model: new ScriptedModel([say("I can credit that.")]), instructions: "You handle billing." });
    const triage = new Agent({
      name: "Triage",
      model: new ScriptedModel([[{ type: "function_call", callId: "h1", name: "transfer_to_Billing", arguments: "{}", status: "completed" }]]),
      instructions: "Route the customer.",
      handoffs: [billing],
    });
    const runner = new Runner();
    const stop = niadraRunHooks(runner, convo);
    const result = await runner.run(triage, "My bill doubled.");
    stop();
    expect(result.finalOutput).toBe("I can credit that.");
    await niadra.flush();
    expect(sent(server).filter((item) => item.type === "handoff")).toMatchObject([{ target: "agent", reason: "Triage to Billing", conversation_id: "oa-3" }]);
  });

  it("keeps your instructions alone when Niadra is down", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(503, "unavailable"));
    const model = new ScriptedModel([say("ok")]);
    const convo = niadra.conversation({ subject: marina, channel: "web_chat" });
    await new Runner().run(new Agent({ name: "S", model, instructions: niadraInstructions("Be brief.", convo) }), "hi");
    expect(model.requests[0]!.systemInstructions).toBe("Be brief.");
  });
});
