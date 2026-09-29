/**
 * What the route methods of `niadra.api` share. The methods are generated from the server's OpenAPI
 * document (`scripts/sync-spec.ts`); this is the part written by hand.
 */
import type { RequestOptions } from "./context.js";

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One call of a route: what the client turns into a request. */
export interface Route {
  method: RouteMethod;
  path: string;
  body?: unknown;
  /** `null` and `undefined` values are left out of the query string. */
  query?: Record<string, string | number | null | undefined>;
  /** Sent as `Idempotency-Key`; with it, a failed attempt is retried like a batch. */
  idempotencyKey?: string;
}

/** Sends a route and resolves with the answer, or rejects with the API's error: it never fails open. */
export type RouteCall = <T>(route: Route, options: RequestOptions) => Promise<T>;

/** A path parameter, escaped whole: an id may hold `/` or `:`. */
export const segment = (value: string): string => encodeURIComponent(value);
