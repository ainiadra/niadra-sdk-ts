import { describe, expect, it } from "vitest";
import {
  NiadraAPIError,
  NiadraAbortError,
  NiadraAuthenticationError,
  NiadraConnectionError,
  NiadraRateLimitError,
  NiadraTimeoutError,
  VERSION,
} from "../src/index.js";
import { parseRetryAfter } from "../src/transport.js";
import { KEY, MockServer, contextBody, makeClient, marina, problem } from "./helpers.js";
import pkg from "../package.json" with { type: "json" };

describe("requests", () => {
  it("authenticates with the key and identifies the SDK", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() });
    await makeClient(server).context({ subject: marina });
    const { headers } = server.calls[0]!;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers["x-niadra-sdk"]).toBe(`js/${VERSION}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.accept).toContain("application/problem+json");
  });

  it("keeps the version constant in step with package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("merges default headers and per-call headers such as traceparent", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody() });
    const niadra = makeClient(server, { defaultHeaders: { "x-team": "support" } });
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    await niadra.context({ subject: marina }, { headers: { traceparent } });
    expect(server.calls[0]!.headers).toMatchObject({ "x-team": "support", traceparent });
  });

  it("keeps personal data out of the URL", async () => {
    const server = new MockServer()
      .on("POST /v1/context", { body: contextBody() })
      .on("POST /v1/history/search", { body: { items: [], withheld: 0, tokens_used: 0 } })
      .on("POST /v1/history/timeline", { body: { items: [], withheld: 0 } });
    const niadra = makeClient(server);
    await niadra.context({ subject: marina, conversation_id: "c1", query: "late technician visit" });
    await niadra.search({ subject: marina, query: "late technician visit" });
    await niadra.timeline({ subject: marina });
    for (const call of server.calls) {
      expect(call.url.href).not.toContain("5511987654321");
      expect(call.url.href).not.toContain("technician");
    }
  });
});

describe("errors", () => {
  it("turns problem+json into a typed error with code and request id", async () => {
    const server = new MockServer().on("POST /v1/context", problem(422, "about_without_link"));
    const niadra = makeClient(server, { strict: true });
    const error = await niadra.context({ subject: marina }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NiadraAPIError);
    expect(error).toMatchObject({ status: 422, code: "about_without_link", requestId: "req-1" });
  });

  it("prefers the x-request-id header", async () => {
    const server = new MockServer().on("POST /v1/context", {
      ...problem(500, "internal"),
      headers: { "x-request-id": "hdr-9" },
    });
    const error = await makeClient(server, { strict: true })
      .context({ subject: marina })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ requestId: "hdr-9" });
  });

  it("uses a status-based code when the body is not a problem document", async () => {
    const server = new MockServer().on("POST /v1/context", { status: 502, body: "bad gateway" });
    const error = await makeClient(server, { strict: true })
      .context({ subject: marina })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, code: "http_502" });
  });

  it("maps 401 and 429 to their own classes", async () => {
    const server = new MockServer()
      .on("POST /v1/history/search", problem(401, "unauthenticated"), problem(429, "rate_limited", { "retry-after": "3" }));
    const niadra = makeClient(server, { strict: true });
    await expect(niadra.search({ subject: marina, query: "x" })).rejects.toBeInstanceOf(NiadraAuthenticationError);
    const limited = await niadra.search({ subject: marina, query: "x" }).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(NiadraRateLimitError);
    expect(limited).toMatchObject({ retryAfterMs: 3000 });
  });

  it("reports network failures as connection errors", async () => {
    const server = new MockServer().on("POST /v1/context", new TypeError("fetch failed"));
    await expect(makeClient(server, { strict: true }).context({ subject: marina })).rejects.toBeInstanceOf(
      NiadraConnectionError,
    );
  });
});

describe("time budgets", () => {
  it("aborts a read that runs past its timeout", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody(), delay: 200 });
    const niadra = makeClient(server, { strict: true, timeouts: { context: 30 } });
    const error = await niadra.context({ subject: marina }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NiadraTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 30 });
  });

  it("uses the voice budget for the voice view", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody(), delay: 60 });
    const niadra = makeClient(server, { timeouts: { context: 300, contextVoice: 20 } });
    const voice = await niadra.context({ subject: marina, view: "voice" });
    const chat = await niadra.context({ subject: marina, view: "chat" });
    expect(voice.error).toBeInstanceOf(NiadraTimeoutError);
    expect(chat.text).not.toBe("");
  });

  it("ends a write the caller waits for at its total budget, retries included", async () => {
    const server = new MockServer().on("POST /v1/feedback", { ...problem(503, "unavailable"), delay: 150 });
    const niadra = makeClient(server, { timeouts: { write: 200 }, queue: { retryDelayMs: 1 } });
    const started = Date.now();
    const result = await niadra.feedback({ subject: marina, action: "retract_fact", fact_id: "f-1" });
    expect(Date.now() - started).toBeLessThan(350);
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(NiadraTimeoutError);
    expect(server.calls).toHaveLength(2);
  });

  it("ends a media upload within its budget, retries included", async () => {
    const server = new MockServer()
      .on("POST /v1/media/uploads", {
        status: 201,
        body: { media_ref: "med_1", upload_url: "https://media.example-bucket.s3.amazonaws.com/sp/med_1", expires_at: "2026-09-22T17:22:00Z" },
      })
      .on("PUT /sp/med_1", { status: 200, delay: 400 });
    const niadra = makeClient(server, { timeouts: { upload: 150 }, queue: { retryDelayMs: 1 } });
    const started = Date.now();
    const { data, error } = await niadra.uploadMedia({ data: new Uint8Array([1, 2, 3]), content_type: "image/png" });
    expect(Date.now() - started).toBeLessThan(300);
    expect(data).toBeNull();
    expect(error).toBeInstanceOf(NiadraTimeoutError);
  });

  it("lets the caller cancel through an AbortSignal", async () => {
    const server = new MockServer().on("POST /v1/history/search", { body: {}, delay: 200 });
    const controller = new AbortController();
    const pending = makeClient(server, { strict: true }).search(
      { subject: marina, query: "x" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(NiadraAbortError);
  });
});

describe("421 wrong cell", () => {
  it("retries a read at once and reaches the new cell", async () => {
    const server = new MockServer().on("POST /v1/context", problem(421, "wrong_cell"), { body: contextBody() });
    const result = await makeClient(server).context({ subject: marina });
    expect(server.calls).toHaveLength(2);
    expect(result.source).toBe("network");
  });

  it("gives up after three attempts", async () => {
    const server = new MockServer().on("POST /v1/history/timeline", problem(421, "wrong_cell"));
    const result = await makeClient(server).timeline({ subject: marina });
    expect(server.calls).toHaveLength(3);
    expect(result.error).toMatchObject({ status: 421 });
  });

  it("does not retry other read errors", async () => {
    const server = new MockServer().on("POST /v1/context", problem(503, "unavailable"), { body: contextBody() });
    const result = await makeClient(server).context({ subject: marina });
    expect(server.calls).toHaveLength(1);
    expect(result.source).toBe("none");
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    const date = new Date(Date.now() + 5000).toUTCString();
    expect(parseRetryAfter(date)).toBeGreaterThan(3000);
  });
});
