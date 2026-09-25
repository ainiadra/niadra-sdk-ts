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
  /** `json` also returns `pack`: the same pack as typed sections (`context-pack.v1`). Defaults to `text`. */
  format?: ContextFormat;
}

/**
 * Body of `POST /v1/context/prefetch`: a partial transcript of the customer's turn, sent while
 * they are still speaking, so the server warms what the read that answers the turn will need.
 */
export interface PrefetchRequest {
  subject?: Handle | null;
  object?: ObjectRef | null;
  about?: Handle | null;
  view?: View;
  verification?: Verification;
  conversation_id?: string | null;
  task_id?: string | null;
  /** The turn so far, 1 to 2,000 characters. */
  query: string;
}

/** `text` returns the pack as prompt text; `json` returns it as typed sections too. */
export type ContextFormat = "text" | "json";

/** Where a section of the pack sits: the account block, the stable prefix or the volatile part. */
export type PackLayer = "account" | "stable" | "volatile";

/** One section of the pack. Read `name`, which is the same in every language, never `label`. */
export interface PackSection {
  name: string;
  /** The section's label in the space's language, as the text shows it. */
  label: string;
  layer: PackLayer;
  lines: string[];
}

/** What identifies the pack a program built its prompt from. */
export interface PackStamp {
  etag: string;
  version: string;
  as_of?: string | null;
  manifest_hash?: string | null;
}

/** What a derived line of the slots says: a count, no record, or items withheld until verification. */
export type PackSlotDerived = "count" | "no_record" | "withheld";

/**
 * One line of this turn's slots (memory v2): an item the customer's last turn selected, or a
 * line the server derived. The same line as in `ContextResponse.slots`.
 */
export interface PackSlot {
  /** The pack section the item comes from (`episodes`, `objects`...), or `derived`. */
  section: string;
  /** On a derived line: `count`, `no_record` or `withheld`; otherwise `null`. */
  derived?: PackSlotDerived | null;
  /** How the item was found: `exact`, `lexical`, `temporal`, `values`, `semantic`. */
  channels: string[];
  /** The line as `slots` prints it. */
  text: string;
}

/**
 * The pack as data (`context-pack.v1`), for programs that build their own prompt: the same
 * content as `text`, and this turn's `slots`, which are never part of `text`. A server of the
 * earlier version answers `context-pack.v0` and no slots; the SDK gives an empty list then.
 */
export interface ContextPack {
  spec: "context-pack.v1" | "context-pack.v0";
  view: string;
  /** The effective level. */
  verification: Verification;
  withheld: number;
  as_of?: string | null;
  /** The line that says the content is data, not instructions, and the usage rules. */
  preamble: string;
  sections: PackSection[];
  variables: Record<string, string>;
  stamp: PackStamp;
  /** This turn's slots, typed; empty when there are none. */
  slots: PackSlot[];
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
  /**
   * Memory v2, on a read with `query`: what the customer's last turn selected from memory for
   * this turn, a tagged block for the end of the prompt. Never part of `text`. Servers without
   * memory v2 do not send it.
   */
  slots?: string | null;
  cache?: CacheDirectives | null;
  timing: Record<string, number>;
  path: DeliveryPath;
  degraded: boolean;
  /** The pack as typed sections, when the request asked for `format: "json"`. */
  pack?: ContextPack | null;
}

export interface HistoryFilters {
  since?: string | null;
  until?: string | null;
  /**
   * A time expression in the customer's words, such as `last week`, `semana passada`, `en marzo`
   * or `ontem`, read by the server in Portuguese, English or Spanish. The period it was read as
   * comes back as `window`; one it could not read is listed in `ignored`.
   */
  when?: string | null;
  /** Also items whose validity ended (`valid_until` in the past). */
  show_expired?: boolean;
  channels?: string[];
  categories?: string[];
  item_kinds?: HistoryItemKind[];
  outcome?: string | null;
  object?: ObjectRef | null;
  /**
   * Conditions joined by `AND`, `OR` and `NOT` over the row fields `id`, `kind`, `channel`,
   * `category`, `outcome`, `source_id`, `vendor`, `at`, `valid_until`, `confidence`, `text`,
   * `object_type` and `object_namespace`, with `eq`, `ne`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`,
   * `contains`, `icontains` and `exists`. A bare value means `eq`, a list means `in`. It narrows
   * what the policy already let through and never changes the order.
   *
   * @example
   * { AND: [{ kind: ["episode", "action"] }, { NOT: { vendor: "acme" } }, { at: { gte: "2026-09-01" } }] }
   */
  where?: WhereExpression | null;
}

/** A condition tree for `HistoryFilters.where`. */
export type WhereExpression = Record<string, unknown>;

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
  /** At most this many items, after the token budget: 1 to 100. */
  limit?: number | null;
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
  /** Until when what the item states holds; after it, the item leaves reads unless `show_expired`. */
  valid_until?: string | null;
}

/** The period a `when` filter was read as. */
export interface TimeWindow {
  since?: string | null;
  until?: string | null;
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
  /** The period `when` was read as, when it was read. */
  window?: TimeWindow | null;
  /** Filters the server could not read and left out, such as `when`. */
  ignored?: string[];
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

/**
 * Body of `POST /v1/history/open`. A conversation id may be a phone number or an e-mail, and the
 * customer is personal data, so neither goes in a URL.
 */
export interface OpenItemRequest {
  item_id: string;
  /** The customer the item must belong to; any other item answers 404. */
  subject?: Handle | null;
  verification?: Verification;
  conversation_id?: string | null;
}

export interface TimelineResponse {
  items: HistoryItem[];
  next_cursor?: string | null;
  withheld: number;
  as_of?: string | null;
  window?: TimeWindow | null;
  ignored?: string[];
}

/** One version of a history item. */
export interface ItemVersion {
  version: number;
  changed_at: string;
  /** `created`, `outcome`, `resolution`, `summary`, `state`... */
  what_changed: string;
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
  /** The server no longer sends a transcript excerpt; the field stays for code that reads it. */
  excerpt?: string | null;
  as_of?: string | null;
  /** Earlier and current versions, oldest first, when the item has them. */
  versions?: ItemVersion[];
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
