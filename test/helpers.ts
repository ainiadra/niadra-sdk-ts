import { vi } from "vitest";
import type { Mock } from "vitest";
import { Niadra } from "../src/index.js";
import type { ClientOptions, ContextResponse, Logger } from "../src/index.js";

export const KEY = "nia_sk_test_sa-east-1_acme-sandbox_k7Qx_s3cr3t_with_underscores";
export const BASE = "https://acme-sandbox.sa-east-1.api.niadra.com";

export interface Recorded {
  method: string;
  url: URL;
  path: string;
  headers: Record<string, string>;
  body: any;
  /** Non-JSON bodies, such as media bytes, as sent. */
  bytes?: Uint8Array;
}

export interface ReplySpec {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Milliseconds before answering; aborts through the request signal like a real socket. */
  delay?: number;
}

export type Reply = ReplySpec | Error | ((request: Recorded) => ReplySpec | Error);

/**
 * A fetch double that answers by `METHOD /path`. Replies queue per route and the last one
 * repeats, so `on("POST /v1/context", a, b)` answers `a`, then `b` forever.
 */
export class MockServer {
  readonly calls: Recorded[] = [];
  private readonly routes = new Map<string, Reply[]>();

  on(route: string, ...replies: Reply[]): this {
    this.routes.set(route, replies);
    return this;
  }

  callsTo(route: string): Recorded[] {
    return this.calls.filter((call) => `${call.method} ${call.path}` === route);
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const recorded: Recorded = {
      method: init.method ?? "GET",
      url,
      path: url.pathname,
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    if (init.body instanceof Uint8Array) recorded.bytes = init.body;
    this.calls.push(recorded);

    const queue = this.routes.get(`${recorded.method} ${recorded.path}`);
    if (!queue || queue.length === 0) return json(404, { title: "not found", status: 404, code: "not_found" });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    const reply = typeof next === "function" ? next(recorded) : next;
    if (reply instanceof Error) throw reply;
    if (reply.delay) await wait(reply.delay, init.signal ?? undefined);
    const status = reply.status ?? 200;
    const isProblem = status >= 400;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status,
      headers: {
        "content-type": isProblem ? "application/problem+json" : "application/json",
        ...reply.headers,
      },
    });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/problem+json" } });
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });
}

export function problem(status: number, code: string, headers?: Record<string, string>): ReplySpec {
  const spec: ReplySpec = { status, body: { type: "about:blank", title: code, status, code, request_id: "req-1" } };
  if (headers) spec.headers = headers;
  return spec;
}

export function contextBody(overrides: Partial<ContextResponse> = {}): ContextResponse {
  return {
    not_modified: false,
    text: "<context>Marina · customer since 2021</context>",
    variables: { name: "Marina" },
    version: "1",
    etag: "etag-1",
    coverage: [],
    verification: { requested: "V1", effective: "V1" },
    withheld: 0,
    live: [],
    live_complete: true,
    timing: { total_ms: 12 },
    path: "t0",
    degraded: false,
    ...overrides,
  };
}

export function batchOk(accepted = 1): ReplySpec {
  return { status: 200, body: { accepted, duplicates: 0, errors: [] } };
}

type LogFn = (message: string, ...details: unknown[]) => void;

export function spyLogger(): Logger & { debug: Mock<LogFn>; warn: Mock<LogFn>; error: Mock<LogFn> } {
  return { debug: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
}

export function makeClient(server: MockServer, options: ClientOptions = {}): Niadra {
  return new Niadra({
    apiKey: KEY,
    fetch: server.fetch,
    logger: spyLogger(),
    flushOnExit: false,
    ...options,
  });
}

export const marina = { type: "phone_e164", value: "+5511987654321" } as const;
