import { initializeLogger, llm, voice } from "@livekit/agents";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  NiadraAgent,
  NiadraMemory,
  attestationProof,
  sipConversationId,
  sipSubject,
} from "../../src/integrations/livekit.js";
import { PACK, SUFFIX, marina, sent, sequence, setup, turns } from "./support.js";
import { contextBody, problem } from "../helpers.js";

beforeAll(() => {
  initializeLogger({ pretty: false, level: "silent" });
});

const INSTRUCTIONS_ID = "lk.agent_task.instructions";

function turnContext(): llm.ChatContext {
  const ctx = llm.ChatContext.empty();
  ctx.addMessage({ id: INSTRUCTIONS_ID, role: "system", content: "You are the support line of Acme.", createdAt: 1 });
  ctx.addMessage({ role: "user", content: "hi", createdAt: 2 });
  ctx.addMessage({ role: "assistant", content: "Hello, how can I help?", createdAt: 3 });
  return ctx;
}

function contents(ctx: llm.ChatContext): [string, string][] {
  return ctx.items.map((item) => (item.type === "message" ? [item.role, item.textContent ?? ""] : [item.type, ""]));
}

describe("LiveKit: NiadraMemory.onUserTurnCompleted", () => {
  it("records the transcript, verifies first, and puts the pack after the instructions and the suffix last", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "voice", conversation_id: "call-1" });
    const agent = new NiadraAgent({
      instructions: "You are the support line of Acme.",
      memory: new NiadraMemory({ conversation: convo, verify: attestationProof("A") }),
    });
    const ctx = turnContext();
    const message = llm.ChatMessage.create({ role: "user", content: "my refund", transcriptConfidence: 0.92 });

    await agent.onUserTurnCompleted(ctx, message);
    // LiveKit adds the new message to this copy by its timestamp after the hook returns.
    ctx.insert(message);

    expect(contents(ctx)).toEqual([
      ["system", "You are the support line of Acme."],
      ["system", PACK],
      ["user", "hi"],
      ["assistant", "Hello, how can I help?"],
      ["user", "my refund"],
      ["system", SUFFIX],
    ]);
    await niadra.flush();
    expect(sequence(server).indexOf("batch:verify")).toBeLessThan(sequence(server).indexOf("POST /v1/context"));
    expect(server.callsTo("POST /v1/context")[0]!.body).toMatchObject({ view: "voice", verification: "V2", conversation_id: "call-1" });
    const [customer] = turns(server);
    expect(customer).toMatchObject({ role: "customer", text: "my refund" });
    expect(customer!.item.content).toEqual({ type: "audio", transcript: "my refund", stt_confidence: 0.92 });
    expect(customer!.item.idempotency_key).toBe(message.id);
    expect(convo.contextStamp?.etag).toBe("etag-1");
  });

  it("replaces its own messages on the next turn instead of piling them up", async () => {
    const { niadra } = setup();
    const memory = new NiadraMemory({ conversation: niadra.conversation({ subject: marina, channel: "voice" }) });
    const ctx = turnContext();
    await memory.onUserTurnCompleted(ctx, llm.ChatMessage.create({ role: "user", content: "one" }));
    await memory.onUserTurnCompleted(ctx, llm.ChatMessage.create({ role: "user", content: "two" }));
    expect(contents(ctx).filter(([, text]) => text === PACK || text === SUFFIX)).toHaveLength(2);
  });

  it("leaves the turn as it was when Niadra fails or misses the voice budget", async () => {
    for (const reply of [problem(503, "unavailable"), { body: contextBody(), delay: 400 }, new TypeError("fetch failed")]) {
      const { server, niadra } = setup();
      server.on("POST /v1/context", reply);
      const memory = new NiadraMemory({ conversation: niadra.conversation({ subject: marina, channel: "voice" }) });
      const ctx = turnContext();
      const before = contents(ctx);
      const started = Date.now();
      await memory.onUserTurnCompleted(ctx, llm.ChatMessage.create({ role: "user", content: "hello" }));
      expect(contents(ctx)).toEqual(before);
      expect(Date.now() - started).toBeLessThan(350);
    }
  });

  it("never throws even with a strict client", async () => {
    const { server } = setup();
    const { makeClient } = await import("../helpers.js");
    server.on("POST /v1/context", problem(500, "internal"));
    const strict = makeClient(server, { strict: true, cache: false });
    const memory = new NiadraMemory({ conversation: strict.conversation({ subject: marina, channel: "voice" }) });
    await expect(memory.onUserTurnCompleted(turnContext(), llm.ChatMessage.create({ role: "user", content: "x" }))).resolves.toBeUndefined();
  });
});

describe("LiveKit: a real AgentSession", () => {
  it("runs the history tool bound to the caller, records the answer with its usage, and ends with the session", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "voice", conversation_id: "call-2" });
    const memory = new NiadraMemory({ conversation: convo });
    const fake = new voice.testing.FakeLLM([
      { input: "what about my refund?", toolCalls: [{ name: "search_customer_history", args: { query: "refund" } }] },
      { input: JSON.stringify({ items: [{ id: "ep_1", kind: "episode", at: "2026-09-01T10:00:00Z", channel: "voice", summary: "Asked for a refund" }], withheld: 0 }), content: "I found your refund request." },
    ]);
    const agent = new NiadraAgent({ instructions: "You are the support line of Acme.", memory });
    const session = new voice.AgentSession({ llm: fake });
    memory.attach(session);
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, () => undefined);
    await session.start({ agent });
    await session.run({ userInput: "what about my refund?" }).wait();
    await session.close();
    await niadra.flush();

    const search = server.callsTo("POST /v1/history/search")[0]!;
    expect(search.body).toMatchObject({ subject: marina, query: "refund", conversation_id: "call-2" });
    const agentTurn = turns(server).find((turn) => turn.role === "ai_agent")!;
    expect(agentTurn.text).toBe("I found your refund request.");
    // The fake LLM reports its usage as "unknown": left out rather than recorded wrong.
    expect(agentTurn.item.usage).toBeUndefined();
    expect(turns(server).find((turn) => turn.role === "customer")?.text).toBe("what about my refund?");
    expect(sent(server).some((item) => item.type === "conversation.ended" && item.conversation_id === "call-2")).toBe(true);
  }, 20_000);

  it("offers the model the three history tools and no parameter for the customer", () => {
    const { niadra } = setup();
    const memory = new NiadraMemory({ conversation: niadra.conversation({ subject: marina, channel: "voice" }) });
    const agent = new NiadraAgent({ instructions: "x", memory, tools: [llm.tool({ name: "book", description: "Books a visit.", execute: async () => "ok" })] });
    const names = Object.keys(agent.toolCtx.functionTools).sort();
    expect(names).toEqual(["book", "get_customer_timeline", "open_history_item", "search_customer_history"]);
    for (const tool of memory.tools()) {
      expect(JSON.stringify(tool.parameters)).not.toMatch(/subject|phone|customer_id|handle/);
    }
  });

  it("carries the usage LiveKit measured for the call onto the answer", async () => {
    const { server, niadra } = setup();
    const memory = new NiadraMemory({ conversation: niadra.conversation({ subject: marina, channel: "voice" }) });
    const session = new voice.AgentSession({});
    memory.attach(session);
    session.emit(voice.AgentSessionEventTypes.MetricsCollected, {
      type: "metrics_collected",
      createdAt: Date.now(),
      metrics: {
        type: "llm_metrics", label: "openai", requestId: "r1", timestamp: 0, durationMs: 1, ttftMs: 1, cancelled: false,
        completionTokens: 5, promptTokens: 900, promptCachedTokens: 600, totalTokens: 905, tokensPerSecond: 1,
        metadata: { modelProvider: "OpenAI", modelName: "gpt-4.1" },
      },
    });
    const say = (text: string): void => {
      session.emit(voice.AgentSessionEventTypes.ConversationItemAdded, {
        type: "conversation_item_added",
        item: llm.ChatMessage.create({ role: "assistant", content: text }),
        createdAt: Date.now(),
      });
    };
    say("Your refund is on its way.");
    say("Anything else?");
    await niadra.flush();
    const answers = turns(server).filter((turn) => turn.role === "ai_agent");
    expect(answers.map((turn) => turn.item.usage)).toEqual([
      { provider: "openai", model: "gpt-4.1", prompt_tokens: 900, cached_tokens: 600, cache_write_tokens: 0 },
      undefined,
    ]);
  });

  it("records a handoff between agents and a transfer to a person", async () => {
    const { server, niadra } = setup();
    const memory = new NiadraMemory({ conversation: niadra.conversation({ subject: marina, channel: "voice", conversation_id: "call-3" }) });
    const session = new voice.AgentSession({});
    memory.attach(session);
    session.emit(voice.AgentSessionEventTypes.ConversationItemAdded, {
      type: "conversation_item_added",
      item: llm.AgentHandoffItem.create({ oldAgentId: "triage", newAgentId: "billing" }),
      createdAt: Date.now(),
    });
    await memory.handoffToHuman("customer asked for a person");
    await niadra.flush();
    const handoffs = sent(server).filter((item) => item.type === "handoff");
    expect(handoffs.map((item) => [item.target, item.reason])).toEqual([
      ["agent", "triage to billing"],
      ["human", "customer asked for a person"],
    ]);
  });
});

describe("LiveKit: the caller's turn", () => {
  it("prefetches the turn so far while the caller speaks, and reads with the final turn", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context/prefetch", { status: 202, body: {} });
    const convo = niadra.conversation({ subject: marina, channel: "voice", conversation_id: "call-9" });
    const memory = new NiadraMemory({ conversation: convo });
    const session = new voice.AgentSession({});
    memory.attach(session);
    const heard = (transcript: string, isFinal: boolean): void => {
      session.emit(voice.AgentSessionEventTypes.UserInputTranscribed, {
        type: "user_input_transcribed", transcript, isFinal, itemId: null, speakerId: null, createdAt: Date.now(), language: null,
      });
    };
    heard("what about", false);
    heard("what about my refund", true);
    heard("it never", false);
    // One at a time per call: the first goes at once, the newest when it ends.
    await vi.waitFor(() => {
      expect(server.callsTo("POST /v1/context/prefetch")).toHaveLength(2);
    });
    expect(server.callsTo("POST /v1/context/prefetch").map((call) => [call.body.query, call.body.conversation_id])).toEqual([
      ["what about", "call-9"],
      ["what about my refund it never", "call-9"],
    ]);

    await memory.onUserTurnCompleted(turnContext(), llm.ChatMessage.create({ role: "user", content: "what about my refund it never came" }));
    expect(server.callsTo("POST /v1/context")[0]!.body.query).toBe("what about my refund it never came");
  });

  it("goes on with the turn when the prefetch fails", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context/prefetch", problem(503, "unavailable"));
    const memory = new NiadraMemory({ conversation: niadra.conversation({ subject: marina, channel: "voice" }) });
    const session = new voice.AgentSession({});
    memory.attach(session);
    session.emit(voice.AgentSessionEventTypes.UserInputTranscribed, {
      type: "user_input_transcribed", transcript: "what about my refund", isFinal: false, itemId: null, speakerId: null, createdAt: Date.now(), language: null,
    });
    const ctx = turnContext();
    await memory.onUserTurnCompleted(ctx, llm.ChatMessage.create({ role: "user", content: "what about my refund" }));
    expect(contents(ctx)[1]).toEqual(["system", PACK]);
  });
});

describe("LiveKit: SIP helpers", () => {
  it("reads the caller and the call id from the SIP attributes", () => {
    const caller = { identity: "sip_5511987654321", attributes: { "sip.phoneNumber": "5511987654321", "sip.callID": "SCL_abc" } };
    expect(sipSubject(caller)).toEqual({ type: "phone_e164", value: "+5511987654321" });
    expect(sipConversationId(caller, "room-1")).toBe("SCL_abc");
    expect(sipSubject({ identity: "user-42" })).toEqual({ type: "app_user_id", value: "user-42" });
    expect(sipConversationId({ identity: "user-42" }, "room-1")).toBe("room-1");
  });

  it("turns a STIR/SHAKEN attestation into a proof", () => {
    expect(attestationProof("A")).toEqual({ method: "network_attestation", level: "V2" });
    expect(attestationProof("TN-Validation-Passed-B")).toEqual({ method: "network_attestation", level: "V1" });
    expect(attestationProof("TN-Validation-Failed-A")).toBeNull();
    expect(attestationProof("No-TN-Validation")).toBeNull();
    expect(attestationProof(undefined)).toBeNull();
  });
});
