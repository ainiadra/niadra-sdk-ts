/** The read side: `POST /v1/context` and the history navigation calls. */

import type { Handle, ObjectRef, SourceCoverage } from "./common.js";
import type { DeliveryPath, EventKind, HistoryItemKind, Verification, View } from "./vocabulary.js";

/** The model that will read the pack, so the server can aim at its prompt-cache floor. */
export interface TargetModel {
  provider: string;
  model: string;
}

/** Body of `POST /v1/context`. Exactly one of `subject` or `object` is required. */
export interface ContextRequest {
  subject?: Handle | null;
  object?: ObjectRef | null;
  /** The account or partner the person acts for. */
  about?: Handle | null;
  view?: View;
  verification?: Verification;
  conversation_id?: string | null;
  task_id?: string | null;
  query?: string | null;
  delta?: boolean;
  target?: TargetModel | null;
  known_etag?: string | null;
}

export interface VerificationResult {
  requested: Verification;
  effective: Verification;
  /** Why `effective` is lower than `requested`: `source_ceiling` or `not_proven`. */
  reason?: string | null;
}

/** A recent turn from another channel that the compiled pack has not absorbed yet. */
export interface LiveTurn {
  at: string;
  channel: string;
  kind: EventKind;
  speaker: string;
  text: string;
  source_id: string;
}

/** Where a prompt-cache breakpoint may go, and whether caching this pack is worth it. */
export interface CacheDirectives {
  /** Character offsets into `text` where a cache breakpoint may be placed. */
  breakpoints: number[];
  ttl_seconds?: number | null;
  floor_tokens?: number | null;
  cacheable: boolean;
  /** Stable cache salt for self-hosted inference engines. */
  salt: string;
}

/** Body of a `POST /v1/context` response. */
export interface ContextResponse {
  /** `true` when `known_etag` still matches; `text` is then omitted. */
  not_modified: boolean;
  text?: string | null;
  variables: Record<string, string>;
  version: string;
  etag: string;
  manifest_hash?: string | null;
  as_of?: string | null;
  lag_seconds?: number | null;
  coverage: SourceCoverage[];
  verification: VerificationResult;
  /** How many items policy or verification kept out of the pack. */
  withheld: number;
  live: LiveTurn[];
  live_complete: boolean;
  delta?: string | null;
  cache?: CacheDirectives | null;
  timing: Record<string, number>;
  path: DeliveryPath;
  degraded: boolean;
}

export interface HistoryFilters {
  since?: string | null;
  until?: string | null;
  channels?: string[];
  categories?: string[];
  item_kinds?: HistoryItemKind[];
  outcome?: string | null;
  object?: ObjectRef | null;
}

/** Body of `POST /v1/history/search`. */
export interface SearchRequest {
  subject: Handle;
  about?: Handle | null;
  /** Between 1 and 2,000 characters. */
  query: string;
  filters?: HistoryFilters;
  /** Token budget for the answer, between 50 and 4,000. Defaults to 800. */
  max_tokens?: number;
  verification?: Verification;
  conversation_id?: string | null;
  task_id?: string | null;
}

export interface HistoryItem {
  id: string;
  kind: string;
  text: string;
  at: string;
  channel?: string | null;
  source_id?: string | null;
  outcome?: string | null;
  confidence?: number | null;
  origin_event_id?: string | null;
}

/** How often the same kind of issue came back, computed by the same rule as the recurring-complaint pattern. */
export interface Recurrence {
  category: string;
  occurrences: number;
  window_days: number;
  last_at?: string | null;
  last_outcome?: string | null;
  last_resolution?: string | null;
}

export interface SearchResponse {
  items: HistoryItem[];
  recurrence?: Recurrence | null;
  withheld: number;
  as_of?: string | null;
  tokens_used: number;
  /** `text_only` when semantic search was unavailable and only keyword matching ran. */
  degraded?: string | null;
}

/** Body of `POST /v1/history/timeline`. */
export interface TimelineRequest {
  subject: Handle;
  about?: Handle | null;
  filters?: HistoryFilters;
  cursor?: string | null;
  /** Between 1 and 100. Defaults to 20. */
  limit?: number;
  verification?: Verification;
  conversation_id?: string | null;
}

export interface TimelineResponse {
  items: HistoryItem[];
  next_cursor?: string | null;
  withheld: number;
  as_of?: string | null;
}

/** A commitment recorded in an episode, made by the company or by the customer. */
export interface Commitment {
  by: "company" | "customer";
  what: string;
  due_at?: string | null;
  status: string;
}

/** One history item opened in full: structured summary, outcome and commitments. */
export interface OpenedItem {
  id: string;
  kind: "episode" | "object";
  summary: string;
  requested?: string | null;
  promises: Commitment[];
  outcome?: string | null;
  resolution?: string | null;
  derived: HistoryItem[];
  timeline: HistoryItem[];
  /** Literal transcript excerpt. Only returned to keys with an elevated scope. */
  excerpt?: string | null;
  as_of?: string | null;
}

/** The derived state of a business object, from `GET /v1/objects/{type}/{namespace}/{id}`. */
export interface ObjectState {
  ref: ObjectRef;
  state: Record<string, unknown>;
  as_of: string;
  source_id: string;
  record_ref?: string | null;
  open_items: HistoryItem[];
}

/** System events and agent actions about one object, newest first; never conversation content. */
export interface ObjectTimeline {
  ref: ObjectRef;
  items: HistoryItem[];
  next_cursor?: string | null;
  as_of?: string | null;
}

/** A function-calling tool definition in the JSON Schema shape most model APIs accept. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
