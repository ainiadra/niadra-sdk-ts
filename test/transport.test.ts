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
import { READ_POLICY, Transport, parseRetryAfter } from "../src/transport.js";
import { KEY, MockServer, contextBody, makeClient, marina, problem, spyLogger } from "./helpers.js";
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

describe("opening a connection", () => {
  it("gives a cold call the connect allowance once, then keeps the exact budget", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody(), delay: 80 });
    const niadra = makeClient(server, { strict: true, timeouts: { context: 30, connect: 200 }, keepAliveMs: 60_000 });
    expect((await niadra.context({ subject: marina, conversation_id: "c1" })).text).not.toBe("");
    const late = await niadra.context({ subject: marina, conversation_id: "c2" }).catch((e: unknown) => e);
    expect(late).toBeInstanceOf(NiadraTimeoutError);
    expect(late).toMatchObject({ timeoutMs: 30 });
  });

  it("gives the allowance again once the connection was idle past the keepalive", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody(), delay: 80 });
    const niadra = makeClient(server, { strict: true, timeouts: { context: 30, connect: 200 }, keepAliveMs: 20 });
    await niadra.context({ subject: marina, conversation_id: "c1" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await niadra.context({ subject: marina, conversation_id: "c2" })).text).not.toBe("");
  });

  it("gives the allowance once in an outage, not on every turn", async () => {
    const server = new MockServer().on("POST /v1/context", { body: contextBody(), delay: 80 });
    const niadra = makeClient(server, { strict: true, timeouts: { context: 30, connect: 200 }, keepAliveMs: 20 });
    await niadra.context({ subject: marina, conversation_id: "c1" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    server.on("POST /v1/context", { body: contextBody(), delay: 1_000 });
    const first = Date.now();
    await niadra.context({ subject: marina, conversation_id: "c2" }).catch(() => undefined);
    expect(Date.now() - first).toBeGreaterThanOrEqual(200);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = Date.now();
    const late = await niadra.context({ subject: marina, conversation_id: "c3" }).catch((e: unknown) => e);
    expect(Date.now() - second).toBeLessThan(150);
    expect(late).toMatchObject({ timeoutMs: 30 });
  });

  it("gives the allowance to reads that start while every open connection is busy", async () => {
    // juridico-zero, 09/10/2026: the keep-warm ping kept one connection open; a turn read its context, notes and
    // state at once, two of them opened a connection again from Sao Paulo, and the notes' 300 ms ran out.
    let calls = 0;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const n = ++calls;
      // The first call opens the connection; of the turn's three, the first finds it and the others open one;
      // after that the three are open.
      const ms = n === 3 || n === 4 ? 120 : 10;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(JSON.stringify({ n }), { status: 200, headers: { "content-type": "application/json" } })), ms);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    const t = new Transport({
      baseURL: "https://api.example.test",
      apiKey: KEY,
      fetch: fetchFn,
      defaultHeaders: {},
      logger: spyLogger(),
      coldAllowanceMs: 500,
      keepAliveMs: 60_000,
    });
    const read = () => t.request<{ n: number }>({ method: "POST", path: "/v1/context", body: {}, timeoutMs: 60, retry: READ_POLICY });
    expect((await read()).data.n).toBe(1);
    const turn = await Promise.all([read(), read(), read()]);
    expect(turn.map((r) => r.data.n).sort()).toEqual([2, 3, 4]);
    const again = await Promise.all([read(), read(), read()]);
    expect(again.map((r) => r.data.n).sort()).toEqual([5, 6, 7]);
  });

  it("leaves a batch of the background queue with its own timeout", async () => {
    const slow = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response("{}", { status: 200 })), 100);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as typeof fetch;
    const t = new Transport({
      baseURL: "https://api.example.test",
      apiKey: KEY,
      fetch: slow,
      defaultHeaders: {},
      logger: spyLogger(),
      coldAllowanceMs: 1000,
      keepAliveMs: 4000,
    });
    const batch = { kind: "write", maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } as const;
    const error = await t.request({ method: "POST", path: "/v1/batch", body: {}, timeoutMs: 50, retry: batch }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NiadraTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 50 });
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

describe("deprecation", () => {
  const since = "@1790812800";
  const sunset = "Sat, 02 Oct 2027 00:00:00 GMT";
  const note = (anchor: string): string => `<https://docs.niadra.com/en/changelog#${anchor}>; rel="deprecation"`;

  function transport(server: MockServer): { transport: Transport; logger: ReturnType<typeof spyLogger> } {
    const logger = spyLogger();
    const config = { baseURL: "https://api.test", apiKey: KEY, fetch: server.fetch, defaultHeaders: {}, logger };
    return { transport: new Transport(config), logger };
  }

  it("warns once per deprecated route per process, with the dates and the link, never the path", async () => {
    const headers = { deprecation: since, sunset, link: note("ts-old") };
    const server = new MockServer()
      .on("GET /v1/old/a-customer-id", { body: {}, headers })
      .on("GET /v1/old/another-id", { body: {}, headers })
      .on("GET /v1/new", { body: {} });
    const { transport: t, logger } = transport(server);
    for (const path of ["/v1/old/a-customer-id", "/v1/old/another-id", "/v1/new"]) {
      await t.request({ method: "GET", path, timeoutMs: 1000, retry: READ_POLICY });
    }
    expect(logger.warn.mock.calls).toEqual([
      [
        "the API deprecated a GET route this client calls, since 2026-10-01; it stops answering on 2027-10-02. " +
          "See https://docs.niadra.com/en/changelog#ts-old",
      ],
    ]);
  });

  it("warns for each deprecated route on its own, on an error answer too", async () => {
    const server = new MockServer()
      .on("GET /v1/one", { body: {}, headers: { deprecation: since, sunset, link: note("ts-one") } })
      .on("POST /v1/two", problem(422, "invalid_input", { deprecation: since, link: note("ts-two") }));
    const { transport: t, logger } = transport(server);
    await t.request({ method: "GET", path: "/v1/one", timeoutMs: 1000, retry: READ_POLICY });
    await expect(
      t.request({ method: "POST", path: "/v1/two", body: {}, timeoutMs: 1000, retry: READ_POLICY }),
    ).rejects.toBeInstanceOf(NiadraAPIError);
    expect(logger.warn.mock.calls.map(([message]) => message.split(" ").at(-1))).toEqual([
      "https://docs.niadra.com/en/changelog#ts-one",
      "https://docs.niadra.com/en/changelog#ts-two",
    ]);
    expect(logger.warn.mock.calls[1]?.[0]).toContain("stops answering on a date not announced yet");
  });

  it("points at the versioning policy when the answer links no note", async () => {
    const server = new MockServer().on("GET /v1/unlinked", { body: {}, headers: { deprecation: since } });
    const { transport: t, logger } = transport(server);
    await t.request({ method: "GET", path: "/v1/unlinked", timeoutMs: 1000, retry: READ_POLICY });
    expect(logger.warn).toHaveBeenCalledWith(
      "the API deprecated a GET route this client calls, since 2026-10-01; it stops answering on a date not " +
        "announced yet. See https://docs.niadra.com/en/security/api-versioning",
    );
  });
});
