import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS, TOOL_NAMES } from "../src/index.js";
import { MockServer, makeClient, marina, problem } from "./helpers.js";

const searchBody = { items: [{ id: "ep-1", kind: "episode", text: "Missed visit", at: "2026-09-12T14:00:00Z" }], withheld: 0, tokens_used: 90 };

describe("tools()", () => {
  it("defines the three navigation tools without any way to name a customer", () => {
    const kit = makeClient(new MockServer()).tools(marina);
    expect(kit.definitions.map((d) => d.function.name)).toEqual([
      "search_customer_history",
      "get_customer_timeline",
      "open_history_item",
    ]);
    for (const definition of kit.definitions) {
      expect(definition.type).toBe("function");
      const schema = JSON.stringify(definition.function.parameters);
      expect(schema).not.toMatch(/subject|customer_id|phone|handle/);
      expect(definition.function.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("hands out copies, so callers cannot edit the shared definitions", () => {
    const kit = makeClient(new MockServer()).tools(marina);
    kit.definitions[0]!.function.description = "changed";
    expect(TOOL_DEFINITIONS[0]!.function.description).not.toBe("changed");
  });

  it("runs a search bound to the customer, ignoring any subject the model invents", async () => {
    const server = new MockServer().on("POST /v1/history/search", { body: searchBody });
    const kit = makeClient(server).tools(marina, { conversation_id: "wa-1", verification: "V1" });
    const output = await kit.call(
      TOOL_NAMES.search,
      JSON.stringify({ query: "visit", channels: ["voice"], item_kinds: ["episode", "bogus"], subject: { type: "email", value: "x@evil.test" } }),
    );
    expect(server.calls[0]!.body).toEqual({
      subject: marina,
      query: "visit",
      filters: { channels: ["voice"], item_kinds: ["episode"] },
      verification: "V1",
      conversation_id: "wa-1",
    });
    expect(JSON.parse(output)).toEqual({ items: searchBody.items, withheld: 0 });
  });

  it("runs the timeline and open tools with parsed arguments", async () => {
    const server = new MockServer()
      .on("POST /v1/history/timeline", { body: { items: [], withheld: 0 } })
      .on("POST /v1/history/open", { body: { id: "ep-1", kind: "episode", summary: "s", promises: [], derived: [], timeline: [] } });
    const kit = makeClient(server).tools(marina, { task_id: "t-1" });
    await kit.call(TOOL_NAMES.timeline, { limit: 500, since: "2026-09-01T00:00:00Z" });
    await kit.call(TOOL_NAMES.open, '{"id":"ep-1"}');
    expect(server.calls[0]!.body).toEqual({ subject: marina, limit: 100, filters: { since: "2026-09-01T00:00:00Z" } });
    // The bound customer goes in the body, so the server opens only an item of theirs.
    expect(server.calls[1]!.body).toEqual({ item_id: "ep-1", subject: marina });
  });

  it("opens an item with the bound customer and the conversation in the body, never in the URL", async () => {
    const server = new MockServer().on("POST /v1/history/open", {
      body: { id: "ep-1", kind: "episode", summary: "s", promises: [], derived: [], timeline: [] },
    });
    const kit = makeClient(server).tools(marina, { conversation_id: "wa-1", verification: "V1" });
    expect(JSON.parse(await kit.call(TOOL_NAMES.open, { id: "ep-1" }))).toMatchObject({ kind: "episode" });
    expect(server.calls[0]!.body).toEqual({ item_id: "ep-1", subject: marina, verification: "V1", conversation_id: "wa-1" });
    expect(server.calls[0]!.url.search).toBe("");
  });

  it("answers the model with a readable error instead of throwing", async () => {
    const server = new MockServer().on("POST /v1/history/search", problem(503, "unavailable"));
    const kit = makeClient(server).tools(marina);
    expect(JSON.parse(await kit.call(TOOL_NAMES.search, "{not json"))).toMatchObject({ error: "invalid_call" });
    expect(JSON.parse(await kit.call(TOOL_NAMES.search, "{}"))).toMatchObject({ error: "invalid_call" });
    expect(JSON.parse(await kit.call("delete_customer", "{}"))).toMatchObject({ error: "invalid_call" });
    expect(JSON.parse(await kit.call(TOOL_NAMES.search, '{"query":"x"}'))).toEqual({
      error: "unavailable",
      detail: "customer history is unavailable right now",
    });
  });

  it("throws in strict mode", async () => {
    const server = new MockServer().on("POST /v1/history/search", problem(503, "unavailable"));
    const kit = makeClient(server, { strict: true }).tools(marina);
    await expect(kit.call(TOOL_NAMES.search, '{"query":"x"}')).rejects.toMatchObject({ status: 503 });
    await expect(kit.call("nope", "{}")).rejects.toThrow(/unknown tool/);
  });

  it("uses the voice navigation budget for voice-bound tools", async () => {
    const server = new MockServer().on("POST /v1/history/search", { body: searchBody, delay: 60 });
    const niadra = makeClient(server, { timeouts: { navigation: 500, navigationVoice: 20 } });
    const voice = await niadra.tools(marina, { voice: true }).call(TOOL_NAMES.search, { query: "x" });
    const chat = await niadra.tools(marina).call(TOOL_NAMES.search, { query: "x" });
    expect(JSON.parse(voice)).toMatchObject({ error: "unavailable" });
    expect(JSON.parse(chat)).toMatchObject({ items: searchBody.items });
  });

  it("recognizes its own tool names", () => {
    const kit = makeClient(new MockServer()).tools(marina);
    expect(kit.has("open_history_item")).toBe(true);
    expect(kit.has("get_weather")).toBe(false);
  });
});
