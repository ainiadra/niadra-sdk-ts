import { describe, expect, it } from "vitest";
import { injectContext, wrap } from "../src/index.js";
import type { Conversation } from "../src/index.js";
import { MockServer, batchOk, contextBody, makeClient, marina, problem, spyLogger } from "./helpers.js";
import type { Reply } from "./helpers.js";

const live = [{ at: "2026-09-22T17:02:00Z", channel: "voice", kind: "message" as const, speaker: "customer", text: "called", source_id: "s" }];

function completion(text: string): unknown {
  return { choices: [{ index: 0, message: { role: "assistant", content: text } }] };
}

function chunk(text: string | null, index = 0): unknown {
  return { choices: [{ index, delta: { content: text } }] };
}

/** Shaped like the `openai` package's APIPromise: awaitable, plus `withResponse()` and `asResponse()`. */
class APIPromise<T> extends Promise<T> {
  static of<T>(value: T): APIPromise<T> {
    const promise = new APIPromise<T>((resolve) => {
      resolve(value);
    });
    promise.value = value;
    return promise;
  }

  value!: T;

  withResponse(): Promise<{ data: T; response: Response; request_id: string }> {
    return Promise.resolve({ data: this.value, response: new Response("{}"), request_id: "req-1" });
  }

  asResponse(): Promise<Response> {
    return Promise.resolve(new Response("raw"));
  }
}

class FakeStream {
  readonly controller = new AbortController();

  constructor(private readonly chunks: unknown[]) {}

  async *[Symbol.asyncIterator](): AsyncGenerator {
    for (const item of this.chunks) {
      await Promise.resolve();
      yield item;
    }
  }
}

class Completions {
  readonly bodies: any[] = [];
  #secret = "private fields need the real object";

  create(body: any, _options?: unknown): APIPromise<unknown> {
    this.bodies.push(body);
    if (!this.#secret) throw new Error("called on a proxy");
    if (body.stream) return APIPromise.of(new FakeStream([chunk("Your "), chunk("other", 1), chunk("credit "), chunk(null), chunk("is issued.")]));
    return APIPromise.of(completion("Your credit is issued."));
  }

  parse(body: any): APIPromise<unknown> {
    this.bodies.push(body);
    return APIPromise.of(completion('{"intent":"refund"}'));
  }
}

function fakeClient(): { chat: { completions: Completions }; beta: { chat: { completions: Completions } }; models: string } {
  const completions = new Completions();
  return { chat: { completions }, beta: { chat: { completions } }, models: "untouched" };
}

async function setup(replies: Reply[] = [{ body: contextBody({ live }) }]) {
  const server = new MockServer().on("POST /v1/context", ...replies).on("POST /v1/batch", batchOk());
  const logger = spyLogger();
  const niadra = makeClient(server, { logger });
  const convo = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "wa-1" });
  const client = fakeClient();
  const openai = wrap(client, convo);
  const recorded = async (): Promise<any[]> => {
    await niadra.flush();
    return server.callsTo("POST /v1/batch").flatMap((call) => call.body.items);
  };
  return { server, logger, niadra, convo, client, openai, recorded };
}

describe("wrap()", () => {
  it("injects the pack after the instructions and the suffix at the end", async () => {
    const { client, openai, convo, recorded } = await setup();
    const messages = [
      { role: "system", content: "You are Acme's agent." },
      { role: "user", content: "hi" },
    ];
    const response: any = await openai.chat.completions.create({ model: "m", messages });
    expect(response.choices[0].message.content).toBe("Your credit is issued.");
    const sent = client.chat.completions.bodies[0];
    expect(sent.messages.map((m: any) => m.role)).toEqual(["system", "system", "user", "system"]);
    expect(sent.messages[1].content).toContain("Marina");
    expect(sent.messages[3].content).toContain("voice · customer: called");
    expect(messages).toHaveLength(2);
    expect(openai.models).toBe("untouched");

    const [turn] = await recorded();
    expect(turn).toMatchObject({ speaker: { role: "ai_agent" }, content: { text: "Your credit is issued." } });
    expect(turn.context_stamp.etag).toBe("etag-1");
    expect(convo.timings.contextInjectedAt).toBeInstanceOf(Date);
  });

  it("records a stream's first choice when it ends", async () => {
    const { openai, recorded } = await setup();
    const stream: any = await openai.chat.completions.create({ model: "m", messages: [], stream: true, n: 2 });
    const parts: string[] = [];
    for await (const item of stream) parts.push(item.choices[0].delta.content ?? "");
    expect(parts.join("")).toBe("Your othercredit is issued.");
    expect(stream.controller).toBeInstanceOf(AbortController);
    const [turn] = await recorded();
    expect(turn.content.text).toBe("Your credit is issued.");
  });

  it("records what a stream delivered before the caller stopped reading", async () => {
    const { openai, recorded } = await setup();
    const stream: any = await openai.chat.completions.create({ model: "m", messages: [], stream: true });
    for await (const item of stream) {
      expect(item).toBeDefined();
      break;
    }
    const [turn] = await recorded();
    expect(turn.content.text).toBe("Your ");
  });

  it("keeps withResponse() and asResponse() working, and records once", async () => {
    const { openai, recorded } = await setup();
    const call: any = openai.chat.completions.create({ model: "m", messages: [] });
    const { data, request_id } = await call.withResponse();
    expect(data.choices[0].message.content).toBe("Your credit is issued.");
    expect(request_id).toBe("req-1");
    await call;
    const raw: Response = await (openai.chat.completions.create({ model: "m", messages: [] }) as any).asResponse();
    expect(await raw.text()).toBe("raw");
    const turns = (await recorded()).filter((item) => item.type === "event");
    expect(turns).toHaveLength(1);
  });

  it("intercepts structured outputs under chat and beta", async () => {
    const { client, openai, recorded } = await setup();
    await openai.chat.completions.parse({ model: "m", messages: [] });
    await openai.beta.chat.completions.parse({ model: "m", messages: [] });
    expect(client.chat.completions.bodies.every((body) => body.messages[0].content.includes("Marina"))).toBe(true);
    const texts = (await recorded()).filter((item) => item.type === "event").map((item) => item.content.text);
    expect(texts).toEqual(['{"intent":"refund"}', '{"intent":"refund"}']);
  });

  it("sends the call without context when context fails", async () => {
    const { client, openai, recorded } = await setup([problem(503, "unavailable")]);
    const response: any = await openai.chat.completions.create({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(response.choices[0].message.content).toBe("Your credit is issued.");
    expect(client.chat.completions.bodies[0].messages).toEqual([{ role: "user", content: "hi" }]);
    const [turn] = await recorded();
    expect(turn.context_stamp).toBeUndefined();
  });

  it("never lets a capture failure reach the caller, and logs no content", async () => {
    const { convo, openai, logger } = await setup();
    (convo as { agent: Conversation["agent"] }).agent = () => {
      throw new Error("Your credit is issued.");
    };
    const response: any = await openai.chat.completions.create({ model: "m", messages: [] });
    expect(response.choices[0].message.content).toBe("Your credit is issued.");
    const stream: any = await openai.chat.completions.create({ model: "m", messages: [], stream: true });
    let count = 0;
    for await (const item of stream) if (item) count++;
    expect(count).toBe(5);
    const warnings = logger.warn.mock.calls.map(([message]) => message);
    expect(warnings).toEqual(["could not record the model's answer (Error)", "could not record the model's answer (Error)"]);
  });

  it("passes calls through untouched when there is no session", async () => {
    const client = fakeClient();
    const openai = wrap(client, () => null);
    const call = openai.chat.completions.create({ model: "m", messages: [] });
    expect(call).toBeInstanceOf(APIPromise);
    await call;
    expect(client.chat.completions.bodies[0].messages).toEqual([]);
  });

  it("refuses a client without chat completions", () => {
    expect(() => wrap({}, () => null)).toThrow(TypeError);
  });

  it("places the pack and suffix with injectContext() too", () => {
    const messages = [{ role: "developer", content: "rules" }, { role: "user", content: "hi" }];
    const placed = injectContext(
      { text: "<context/>", suffix: "<delta/>", variables: {}, pack: null, source: "network", response: null, error: null },
      messages,
    );
    expect(placed).toEqual([
      { role: "developer", content: "rules" },
      { role: "system", content: "<context/>" },
      { role: "user", content: "hi" },
      { role: "system", content: "<delta/>" },
    ]);
  });

  it("works with a task", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() }).on("POST /v1/batch", batchOk());
    const niadra = makeClient(server);
    const task = niadra.task({ task_id: "t-1", channel: "billing-agent", subject: marina });
    const openai = wrap(fakeClient(), task);
    await openai.chat.completions.create({ model: "m", messages: [] });
    await niadra.flush();
    const [turn] = server.callsTo("POST /v1/batch")[0]!.body.items;
    expect(turn).toMatchObject({ task_id: "t-1", speaker: { role: "ai_agent" }, context_stamp: { etag: "etag-1" } });
  });
});
