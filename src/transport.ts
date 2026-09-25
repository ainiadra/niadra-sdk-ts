import {
  NiadraAPIError,
  NiadraAbortError,
  NiadraConnectionError,
  NiadraError,
  NiadraTimeoutError,
  apiErrorFor,
} from "./errors.js";
import type { Problem } from "./types/common.js";
import { VERSION } from "./version.js";

/**
 * When a request may be sent again.
 *
 * Reads run against one deadline for the whole call and are only retried on 421, which means
 * the space just moved to another cell: the answer was not "no", it was "not here". Writes
 * give each attempt its own timeout and retry anything transient, because every batch item
 * carries an idempotency key and a repeat is harmless. A write someone waits on also carries
 * `totalMs`: every attempt and every wait between them ends by then.
 */
export type RetryPolicy =
  | { kind: "read"; maxAttempts: number }
  | { kind: "write"; maxAttempts: number; baseDelayMs: number; maxDelayMs: number; totalMs?: number };

type WritePolicy = Extract<RetryPolicy, { kind: "write" }>;

export interface RequestSpec {
  method: "GET" | "POST";
  path: string;
  /** A list becomes the parameter repeated, as `?tags=a&tags=b`. */
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  timeoutMs: number;
  retry: RetryPolicy;
  signal?: AbortSignal | undefined;
  headers?: Record<string, string> | undefined;
}

/** Bytes for a pre-signed storage URL. The URL is the credential; nothing of the API's goes along. */
export interface UploadSpec {
  url: string;
  body: Uint8Array<ArrayBuffer>;
  /** Exactly the headers the signature covers, as the reservation named them. */
  headers: Record<string, string>;
  timeoutMs: number;
  retry: WritePolicy;
  signal?: AbortSignal | undefined;
}

export interface TransportResponse<T> {
  status: number;
  data: T;
  requestId: string | null;
}

export interface TransportConfig {
  baseURL: string;
  apiKey: string;
  fetch: typeof fetch;
  defaultHeaders: Record<string, string>;
}

const RETRYABLE_WRITE_STATUS = new Set([408, 421, 429, 500, 502, 503, 504]);
const READ_421_ATTEMPTS = 3;

export const READ_POLICY: RetryPolicy = { kind: "read", maxAttempts: READ_421_ATTEMPTS };

export class Transport {
  private readonly baseURL: string;

  constructor(private readonly config: TransportConfig) {
    this.baseURL = config.baseURL.replace(/\/+$/, "");
  }

  async request<T>(spec: RequestSpec): Promise<TransportResponse<T>> {
    return spec.retry.kind === "read" ? this.read<T>(spec, spec.retry) : this.write<T>(spec, spec.retry);
  }

  private async read<T>(spec: RequestSpec, policy: { maxAttempts: number }): Promise<TransportResponse<T>> {
    const deadline = new Deadline(spec.timeoutMs, spec.signal);
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.send<T>(spec, deadline);
        } catch (error) {
          // The old cell closes the connection with its 421, so the retry reaches the new one.
          if (isStatus(error, 421) && attempt < policy.maxAttempts && !deadline.expired) continue;
          throw error;
        }
      }
    } finally {
      deadline.clear();
    }
  }

  private async write<T>(spec: RequestSpec, policy: WritePolicy): Promise<TransportResponse<T>> {
    return this.retrying(spec.timeoutMs, policy, spec.signal, (deadline) => this.send<T>(spec, deadline));
  }

  /**
   * Sends media bytes to the signed URL `POST /v1/media/uploads` returned, with the write retry
   * rules. Only the headers the reservation named go along: the signature covers them (content
   * type, and the digest the store checks the body against), and the key must never reach a
   * host other than the API.
   */
  async upload(spec: UploadSpec): Promise<void> {
    await this.retrying(spec.timeoutMs, spec.retry, spec.signal, (deadline) =>
      this.exchange<unknown>(
        spec.url,
        { method: "PUT", headers: spec.headers, body: spec.body, signal: deadline.signal },
        deadline,
      ),
    );
  }

  private async retrying<T>(
    timeoutMs: number,
    policy: WritePolicy,
    signal: AbortSignal | undefined,
    attempt: (deadline: Deadline) => Promise<T>,
  ): Promise<T> {
    const end = policy.totalMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + policy.totalMs;
    for (let count = 1; ; count++) {
      const left = end - Date.now();
      if (left <= 0) throw new NiadraTimeoutError(policy.totalMs ?? timeoutMs);
      const deadline = new Deadline(Math.min(timeoutMs, left), signal);
      try {
        return await attempt(deadline);
      } catch (error) {
        if (count >= policy.maxAttempts || !isTransient(error)) throw error;
        const delay = retryDelay(error, count, policy.baseDelayMs, policy.maxDelayMs);
        if (Date.now() + delay >= end) throw error;
        await sleep(delay, signal);
      } finally {
        deadline.clear();
      }
    }
  }

  private async send<T>(spec: RequestSpec, deadline: Deadline): Promise<TransportResponse<T>> {
    const headers: Record<string, string> = {
      accept: "application/json, application/problem+json",
      authorization: `Bearer ${this.config.apiKey}`,
      "x-niadra-sdk": `js/${VERSION}`,
      ...this.config.defaultHeaders,
      ...spec.headers,
    };
    const init: RequestInit = { method: spec.method, headers, signal: deadline.signal };
    if (spec.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(spec.body);
    }
    return this.exchange<T>(this.url(spec.path, spec.query), init, deadline);
  }

  private async exchange<T>(url: string, init: RequestInit, deadline: Deadline): Promise<TransportResponse<T>> {
    let response: Response;
    try {
      response = await this.config.fetch(url, init);
    } catch (error) {
      throw deadline.explain(error);
    }

    const requestId = response.headers.get("x-request-id");
    let payload: unknown;
    try {
      payload = await readBody(response);
    } catch (error) {
      throw deadline.explain(error);
    }

    if (!response.ok) {
      throw apiErrorFor(
        response.status,
        asProblem(payload),
        requestId,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    return { status: response.status, data: payload as T, requestId };
  }

  private url(path: string, query?: Record<string, string | string[] | undefined>): string {
    const url = `${this.baseURL}${path}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (Array.isArray(value)) for (const entry of value) params.append(name, entry);
      else if (value !== undefined) params.set(name, value);
    }
    const encoded = params.toString();
    return encoded ? `${url}?${encoded}` : url;
  }
}

/**
 * One time budget, optionally tied to the caller's own signal. `AbortSignal.any` would do
 * this, but it is missing from Node 18 and several edge runtimes.
 */
class Deadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly detach: () => void;
  private timedOut = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly outer?: AbortSignal,
  ) {
    this.signal = this.controller.signal;
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, timeoutMs);
    const onAbort = (): void => {
      this.controller.abort();
    };
    if (outer?.aborted) this.controller.abort();
    outer?.addEventListener("abort", onAbort, { once: true });
    this.detach = () => {
      outer?.removeEventListener("abort", onAbort);
    };
  }

  get expired(): boolean {
    return this.signal.aborted;
  }

  clear(): void {
    clearTimeout(this.timer);
    this.detach();
  }

  explain(error: unknown): NiadraError {
    if (this.timedOut) return new NiadraTimeoutError(this.timeoutMs);
    if (this.outer?.aborted) return new NiadraAbortError("request aborted by the caller", { cause: error });
    if (error instanceof NiadraError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new NiadraConnectionError(`connection failed: ${message}`, { cause: error });
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function asProblem(payload: unknown): Problem | null {
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Partial<Problem>;
  if (typeof candidate.code !== "string" || typeof candidate.status !== "number") return null;
  return candidate as Problem;
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof NiadraAPIError && error.status === status;
}

function isTransient(error: unknown): boolean {
  if (error instanceof NiadraTimeoutError || error instanceof NiadraConnectionError) return true;
  return error instanceof NiadraAPIError && RETRYABLE_WRITE_STATUS.has(error.status);
}

function retryDelay(error: unknown, attempt: number, baseMs: number, maxMs: number): number {
  if (isStatus(error, 421)) return 0;
  if (error instanceof NiadraAPIError && error.retryAfterMs !== null) return Math.min(error.retryAfterMs, maxMs);
  const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + (Math.random() * ceiling) / 2);
}

/** `Retry-After` is either delay seconds or an HTTP date. */
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new NiadraAbortError("request aborted by the caller"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
