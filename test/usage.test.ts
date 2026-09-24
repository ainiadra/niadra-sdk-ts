import { describe, expect, it } from "vitest";
import { NiadraValidationError, modelUsage, providerOf, tokenCounts, wrap } from "../src/index.js";
import { buildEvent } from "../src/items.js";
import { MockServer, batchOk, contextBody, makeClient, marina } from "./helpers.js";

function openaiCompletion(text: string, cached: number | null = 2048): unknown {
  return {
    model: "gpt-4.1-2025-04-14",
    choices: [{ index: 0, message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 3000, completion_tokens: 40, prompt_tokens_details: cached === null ? null : { cached_tokens: cached } },
  };
}

const anthropicMessage = {
  type: "message",
  model: "claude-sonnet-4-5-20250929",
  content: [{ type: "text", text: "Your visit is tomorrow." }],
  usage: { input_tokens: 120, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 60 },
};

class Stream {
  constructor(private readonly chunks: unknown[]) {}

  async *[Symbol.asyncIterator](): AsyncGenerator {
    for (const item of this.chunks) {
      await Promise.resolve();
      yield item;
    }
  }
}

function fakeClient(response: unknown, chunks: unknown[] = []) {
  return {
    chat: {
      completions: {
        create: (body: any) => Promise.resolve(body.stream ? new Stream(chunks) : response),
      },
    },
  };
}

async function setup() {
  const server = new MockServer().on("POST /v1/context", { body: contextBody() }).on("POST /v1/batch", batchOk());
  const niadra = makeClient(server);
  const convo = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "wa-1" });
  const agentTurns = async (): Promise<any[]> => {
    await niadra.flush();
    return server
      .callsTo("POST /v1/batch")
      .flatMap((call) => call.body.items)
      .filter((item: any) => item.speaker?.role === "ai_agent");
  };
  return { convo, agentTurns };
}

describe("the provider's usage on the agent's turn", () => {
  it("wrap() sends the usage of each call with the turn", async () => {
    const { convo, agentTurns } = await setup();
    const openai = wrap(fakeClient(openaiCompletion("Your credit is issued.")), convo);
    await openai.chat.completions.create({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] });
    const [turn] = await agentTurns();
    expect(turn.usage).toEqual({
      provider: "openai",
      model: "gpt-4.1-2025-04-14",
      prompt_tokens: 3000,
      cached_tokens: 2048,
      cache_write_tokens: 0,
    });
  });

  it("a stream reports its usage when the caller asked for it", async () => {
    const { convo, agentTurns } = await setup();
    const piece = (text: string) => ({ model: "gpt-4.1-mini-2025-04-14", choices: [{ index: 0, delta: { content: text } }] });
    const last = { model: "gpt-4.1-mini-2025-04-14", choices: [], usage: { prompt_tokens: 1800, prompt_tokens_details: { cached_tokens: 1024 } } };
    const openai = wrap(fakeClient(null, [piece("Your "), piece("credit."), last]), convo);
    const stream: any = await openai.chat.completions.create({ model: "m", messages: [], stream: true, stream_options: { include_usage: true } });
    const seen: unknown[] = [];
    for await (const item of stream) seen.push(item);
    expect(seen).toHaveLength(3);
    const [turn] = await agentTurns();
    expect(turn.content.text).toBe("Your credit.");
    expect([turn.usage.model, turn.usage.cached_tokens]).toEqual(["gpt-4.1-mini-2025-04-14", 1024]);
  });

  it("a call without usage records the turn without it", async () => {
    const { convo, agentTurns } = await setup();
    const openai = wrap(fakeClient({ choices: [{ index: 0, message: { content: "ok" } }] }), convo);
    await openai.chat.completions.create({ model: "m", messages: [] });
    const [turn] = await agentTurns();
    expect(turn.usage).toBeUndefined();
  });

  it("agents without wrap() pass the provider's response with the turn", async () => {
    const { convo, agentTurns } = await setup();
    convo.agent(anthropicMessage.content[0]!.text, { usage: anthropicMessage });
    convo.agent("And the invoice is credited.", { usage: modelUsage(openaiCompletion("x")) });
    convo.agent("A turn whose usage cannot be read is still recorded.", { usage: { nothing: true } });
    convo.customer("A customer turn never carries usage.", { usage: anthropicMessage });
    const turns = await agentTurns();
    expect(turns[0].usage).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      prompt_tokens: 4620,
      cached_tokens: 4000,
      cache_write_tokens: 500,
    });
    expect(turns[1].usage.provider).toBe("openai");
    expect(turns[2].usage).toBeUndefined();
  });

  it("reads the shapes of OpenAI, the Responses API, Anthropic and gateways", () => {
    expect(tokenCounts({ prompt_tokens: 3000, prompt_tokens_details: { cached_tokens: 2048 } })).toEqual({
      prompt_tokens: 3000,
      cached_tokens: 2048,
      cache_write_tokens: 0,
    });
    expect(tokenCounts({ input_tokens: 120, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500 })).toEqual({
      prompt_tokens: 4620,
      cached_tokens: 4000,
      cache_write_tokens: 500,
    });
    expect(tokenCounts({ input_tokens: 2500, input_tokens_details: { cached_tokens: 1200 } })).toEqual({
      prompt_tokens: 2500,
      cached_tokens: 1200,
      cache_write_tokens: 0,
    });
    expect(tokenCounts({ prompt_tokens: 120, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500 })).toEqual({
      prompt_tokens: 4500,
      cached_tokens: 4000,
      cache_write_tokens: 500,
    });
    expect(tokenCounts({ completion_tokens: 5 })).toBeNull();
    expect(tokenCounts(null)).toBeNull();
    expect(providerOf("anthropic/claude-sonnet-4.5")).toBe("anthropic");
    expect(providerOf("claude-haiku-4-5")).toBe("anthropic");
    expect(providerOf("gpt-4.1")).toBe("openai");
    expect(modelUsage({ prompt_tokens: 10 })).toBeNull();
    expect(modelUsage({ prompt_tokens: 10 }, { model: "gpt-4o", provider: "Azure" })?.provider).toBe("azure");
  });

  it("usage rides only on the agent's message, with parts that fit", () => {
    const usage = { provider: "openai", model: "gpt-4.1", prompt_tokens: 10, cached_tokens: 5 };
    const base = { channel: "whatsapp", handles: [marina], text: "hi" };
    expect(buildEvent({ ...base, speaker: "ai_agent", usage }).usage).toEqual(usage);
    expect(() => buildEvent({ ...base, speaker: "customer", usage })).toThrow(NiadraValidationError);
    expect(() => buildEvent({ ...base, speaker: "ai_agent", usage: { ...usage, cache_write_tokens: 6 } })).toThrow(
      /part of prompt_tokens/,
    );
    expect(() => buildEvent({ ...base, speaker: "ai_agent", usage: { ...usage, provider: "Open AI" } })).toThrow(/lowercase/);
  });
});

describe("usage given by hand", () => {
  it("keeps a valid ModelUsage and reads an invalid one like a provider's usage, never dropping the turn", async () => {
    const server = new MockServer().on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    const convo = niadra.conversation({ subject: marina, channel: "whatsapp" });
    convo.agent("one", { usage: { provider: "openai", model: "gpt-4.1", prompt_tokens: 10, cached_tokens: 4 } });
    convo.agent("two", { usage: { provider: "Open AI", model: "gpt-4.1", prompt_tokens: 10 } });
    await niadra.flush();
    const turns = server.callsTo("POST /v1/batch").flatMap((call) => call.body.items);
    expect(turns.map((t: any) => t.content.text)).toEqual(["one", "two"]);
    expect(turns[0].usage).toEqual({ provider: "openai", model: "gpt-4.1", prompt_tokens: 10, cached_tokens: 4 });
    expect(turns[1].usage.provider).toBe("openai");
  });
});
