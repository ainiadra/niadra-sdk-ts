import { describe, expect, it } from "vitest";
import { NiadraAPIError, NiadraValidationError } from "../src/index.js";
import { MockServer, makeClient, marina, problem } from "./helpers.js";

const searchBody = {
  items: [{ id: "ep-1", kind: "episode", text: "Missed technician visit", at: "2026-09-12T14:00:00Z", channel: "voice" }],
  recurrence: { category: "technician_visit", occurrences: 3, window_days: 90 },
  withheld: 0,
  tokens_used: 120,
};

describe("search()", () => {
  it("posts the request and returns the typed response", async () => {
    const server = new MockServer().on("POST /v1/history/search", { body: searchBody });
    const result = await makeClient(server).search({
      subject: marina,
      query: "technician did not come",
      filters: { channels: ["voice"], item_kinds: ["episode"] },
      verification: "V1",
      conversation_id: "wa-1",
    });
    expect(server.calls[0]!.body).toEqual({
      subject: marina,
      query: "technician did not come",
      filters: { channels: ["voice"], item_kinds: ["episode"] },
      verification: "V1",
      conversation_id: "wa-1",
    });
    expect(result.error).toBeNull();
    expect(result.data?.recurrence?.occurrences).toBe(3);
  });

  it("uses the navigation budget", async () => {
    const server = new MockServer().on("POST /v1/history/search", { body: searchBody, delay: 60 });
    const result = await makeClient(server, { timeouts: { navigation: 20 } }).search({ subject: marina, query: "x" });
    expect(result.error?.name).toBe("NiadraTimeoutError");
  });

  it("refuses an empty query without a request", async () => {
    const server = new MockServer();
    const result = await makeClient(server).search({ subject: marina, query: "" });
    expect(server.calls).toHaveLength(0);
    expect(result.error).toBeInstanceOf(NiadraValidationError);
  });
});

describe("timeline()", () => {
  it("posts filters and the cursor in the body", async () => {
    const server = new MockServer().on("POST /v1/history/timeline", { body: { items: [], next_cursor: "c2", withheld: 1 } });
    const result = await makeClient(server).timeline({ subject: marina, cursor: "c1", limit: 10, filters: { since: "2026-01-01T00:00:00Z" } });
    expect(server.calls[0]!.body).toEqual({ subject: marina, cursor: "c1", limit: 10, filters: { since: "2026-01-01T00:00:00Z" } });
    expect(result.data).toEqual({ items: [], next_cursor: "c2", withheld: 1 });
  });
});

describe("open()", () => {
  it("keeps the conversation id out of the URL: the item and the session scope go in the body", async () => {
    const server = new MockServer().on("POST /v1/history/open", {
      body: { id: "ep-1", kind: "episode", summary: "Visit missed", promises: [], derived: [], timeline: [] },
    });
    // A conversation id may be a phone number: it travels in the body of POST /v1/history/open.
    const result = await makeClient(server).open("ep-1", { verification: "V2", conversation_id: "+5511912345678" });
    const call = server.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.href).toBe(`${call.url.origin}/v1/history/open`);
    expect(call.body).toEqual({ item_id: "ep-1", verification: "V2", conversation_id: "+5511912345678" });
    expect(result.data?.summary).toBe("Visit missed");
  });

  it("sends the customer when given, and never a task id, which the server does not read here", async () => {
    const server = new MockServer().on("POST /v1/history/open", {
      body: { id: "ep/1", kind: "episode", summary: "s", promises: [], derived: [], timeline: [] },
    });
    await makeClient(server).open("ep/1", { subject: marina, task_id: "t-1" });
    expect(server.calls[0]!.body).toEqual({ item_id: "ep/1", subject: marina });
    expect(server.calls[0]!.url.pathname).toBe("/v1/history/open");
  });

  it("refuses an empty id", async () => {
    const result = await makeClient(new MockServer()).open("");
    expect(result.error).toBeInstanceOf(NiadraValidationError);
  });
});

describe("subjectToken()", () => {
  it("mints a token bound to the customer and conversation", async () => {
    const server = new MockServer().on("POST /v1/subject-tokens", {
      body: { token: "nst_abc", expires_at: "2026-09-22T17:15:00Z" },
    });
    const result = await makeClient(server).subjectToken({ subject: marina, conversation_id: "wa-1", verification: "V1" });
    expect(server.calls[0]!.body).toEqual({ subject: marina, conversation_id: "wa-1", verification: "V1" });
    expect(result.data).toEqual({ token: "nst_abc", expires_at: "2026-09-22T17:15:00Z" });
  });

  it("uses its own time budget", async () => {
    const server = new MockServer().on("POST /v1/subject-tokens", { body: {}, delay: 60 });
    const result = await makeClient(server, { timeouts: { token: 20 } }).subjectToken({ subject: marina });
    expect(result.data).toBeNull();
  });
});

describe("failures", () => {
  it("resolves with the error instead of throwing", async () => {
    const server = new MockServer().on("POST /v1/history/search", problem(503, "unavailable"));
    const result = await makeClient(server).search({ subject: marina, query: "x" });
    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(NiadraAPIError);
  });

  it("throws in strict mode", async () => {
    const server = new MockServer().on("POST /v1/history/timeline", problem(403, "forbidden"));
    await expect(makeClient(server, { strict: true }).timeline({ subject: marina })).rejects.toMatchObject({ status: 403 });
  });
});
