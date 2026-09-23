import type { Problem } from "./types/common.js";

/**
 * Base class of every error the SDK produces. In the default fail-open mode these errors are
 * logged and returned in results rather than thrown; with `strict: true` they are thrown.
 */
export class NiadraError extends Error {
  override readonly name: string = "NiadraError";
}

/** The client was built without a usable API key, or with an option the SDK cannot honour. */
export class NiadraConfigError extends NiadraError {
  override readonly name = "NiadraConfigError";
}

/** A request failed validation before it left the process. Nothing was sent. */
export class NiadraValidationError extends NiadraError {
  override readonly name = "NiadraValidationError";
}

/** The request did not finish within its time budget. */
export class NiadraTimeoutError extends NiadraError {
  override readonly name = "NiadraTimeoutError";

  constructor(readonly timeoutMs: number) {
    super(`request timed out after ${timeoutMs} ms`);
  }
}

/** The network call failed before an HTTP response arrived (DNS, TLS, reset connection). */
export class NiadraConnectionError extends NiadraError {
  override readonly name = "NiadraConnectionError";
}

/** The request was cancelled through the caller's `AbortSignal`. */
export class NiadraAbortError extends NiadraError {
  override readonly name = "NiadraAbortError";
}

/**
 * The API answered with an error status. `code` comes from the problem document when the
 * server sent one; `requestId` is what Niadra support needs to find the call.
 */
export class NiadraAPIError extends NiadraError {
  override readonly name: string = "NiadraAPIError";
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly problem: Problem | null;
  /** How long the server asked callers to wait, from `Retry-After`, when it said so. */
  readonly retryAfterMs: number | null;

  constructor(status: number, problem: Problem | null, requestId: string | null, retryAfterMs: number | null = null) {
    const code = problem?.code ?? `http_${status}`;
    const detail = problem?.detail ? `: ${problem.detail}` : "";
    super(`${status} ${code}${detail}`);
    this.status = status;
    this.code = code;
    this.problem = problem;
    this.requestId = requestId ?? problem?.request_id ?? null;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 401: the key is missing, malformed, rotated or revoked. */
export class NiadraAuthenticationError extends NiadraAPIError {
  override readonly name = "NiadraAuthenticationError";
}

/** 403: the key is valid but lacks the scope, or its source was cut off. */
export class NiadraPermissionError extends NiadraAPIError {
  override readonly name = "NiadraPermissionError";
}

/** 429: over the rate limit. Batches wait `retryAfterMs` before trying again. */
export class NiadraRateLimitError extends NiadraAPIError {
  override readonly name = "NiadraRateLimitError";
}

/** Builds the most specific `NiadraAPIError` subclass for a status code. */
export function apiErrorFor(
  status: number,
  problem: Problem | null,
  requestId: string | null,
  retryAfterMs: number | null,
): NiadraAPIError {
  if (status === 401) return new NiadraAuthenticationError(status, problem, requestId, retryAfterMs);
  if (status === 403) return new NiadraPermissionError(status, problem, requestId, retryAfterMs);
  if (status === 429) return new NiadraRateLimitError(status, problem, requestId, retryAfterMs);
  return new NiadraAPIError(status, problem, requestId, retryAfterMs);
}

/** Wraps anything thrown into a `NiadraError`, keeping the original as `cause`. */
export function toNiadraError(error: unknown): NiadraError {
  if (error instanceof NiadraError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new NiadraError(message, { cause: error });
}
