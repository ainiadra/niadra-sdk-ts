/** The read side: `POST /v1/context` and the history navigation calls. */

import type { Handle, ObjectRef, SourceCoverage } from "./common.js";
import type { CommitmentRef, ContactBudget, Owner } from "./coordination.js";
import type { ConstraintsBlock } from "./signals.js";
import type { StateView } from "./state.js";
import type { DeliveryPath, EventKind, HistoryItemKind, Verification, View } from "./vocabulary.js";

/** A block `POST /v1/context` adds to the pack in the same round trip. */
export type Include = "state" | "constraints" | "coordination" | "budget";

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
  /**
   * With `format: "json"` and `query`: each of `pack.slots` also says `why` it was
   * chosen (its position in each retrieval channel, each channel's weighted share of the fused
   * score, the weights version, the rule of a derived line). Requires `format: "json"`. It changes
   * nothing else: the pinned text, the slots chosen and the receipt are the same bytes with or
   * without it.
   */
  explain?: boolean;
  /** Blocks read in the same round trip: `constraints`, `state`. Each only where the space turned its feature on. */
  include?: Include[] | null;
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

/** One retrieval channel's part in a slot's fused score (weighted reciprocal rank fusion). */
export interface SlotChannelRank {
  /** `exact`, `values`, `lexical`, `temporal`, `semantic` or `linked`. */
  channel: string;
  /** 1-based, in that channel's own ranking for the turn. */
  position: number;
  /** The channel's weight in this fusion. */
  weight: number;
  /** `weight / (60 + position)`: what the channel added to `score`. */
  contribution: number;
}

/** Why a line took a slot (`explain`). Ids, positions and numbers; never a line or a value. */
export interface SlotWhy {
  /** The item, as manifests and context-use name it; absent for a derived line. */
  item_id?: string | null;
  /** The fused score: the sum of the channels' contributions. */
  score?: number | null;
  /** Each channel that ranked the item, in fusion order. */
  channels: SlotChannelRank[];
  /** The space's learned fusion weights used; absent for the defaults. */
  weights_version?: number | null;
  /** The line was cut to the sentences that answer the turn. */
  excerpt?: boolean;
  /**
   * For a derived line: `guard_<value type>` (a guard line), `count_complaints`,
   * `count_conversations`, `no_record` or `withheld_may_hold`.
   */
  rule?: string | null;
  /**
   * For a derived line, what the rule counted or missed: `basis` (the conversation that chose
   * the category), `category`, `counted`, `window_days`; `asked_types`, `identifiers` (how many
   * numbers the turn named, never which), `withheld`.
   */
  basis: Record<string, unknown>;
}

/**
 * One line of this turn's slots: an item the customer's last turn selected, or a
 * line the server derived. The same line as in `ContextResponse.slots`.
 */
export interface PackSlot {
  /** The pack section the item comes from (`episodes`, `objects`...), `guard` for a guard line, or `derived`. */
  section: string;
  /**
   * The short id of the item the line states: the last eight hex digits of its public id. A guard
   * line's names its guard in `Backing.guard_violations`. `null` on a derived line.
   */
  id?: string | null;
  /** On a derived line: `count`, `no_record` or `withheld`; otherwise `null`. */
  derived?: PackSlotDerived | null;
  /** How the item was found: `exact`, `lexical`, `temporal`, `values`, `semantic`, `linked`. */
  channels: string[];
  /** The line as `slots` prints it. */
  text: string;
  /** With `explain`: why this line was chosen. */
  why?: SlotWhy | null;
}

/**
 * What one guard line states: the value memory holds for a kind the customer's turn
 * asked about, by the precedence of who stated it (the system of record, then a human agent). The
 * agent must not state another; `agent()` checks its answer against it.
 */
export interface PackGuard {
  /** The value's short id, as the guard line's `PackSlot.id`. */
  id: string;
  /** `protocol`, `ticket`, `order`, `record`, `receipt`, `postal_code`, `amount`, `date` or `code`. */
  value_type: string;
  /** The value as the line writes it. */
  value: string;
}

/**
 * The pack as data (`context-pack.v1`), for programs that build their own prompt: the same
 * content as `text`, and this turn's `slots`, which are never part of `text`; an empty list on a
 * read without a turn.
 */
export interface ContextPack {
  spec: "context-pack.v1";
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

/** What coordination knows of the subject, read beside the pack by `include`: advice for the turn, never a decision. */
export interface CoordinationBlock {
  owner?: Owner | null;
  suppressions?: string[];
  contact_budget?: Record<string, ContactBudget>;
  commitments_active?: CommitmentRef[];
}

/** What this agent's recorded turns added up to, in one conversation or one case. */
export interface BudgetUse {
  turns: number;
  /** Each one reads the prompt's prefix again. */
  model_calls: number;
  tool_calls: number;
  tokens_in: number;
  tokens_cached: number;
  tokens_out: number;
  cost_usd: number;
}

/** What the pack of this read costs, in estimated tokens, whole and per section. */
export interface BudgetPack {
  total: number;
  sections: Record<string, number>;
}

/**
 * What the measurement of context use says this agent leaves unused, by unit of items: delivered in enough
 * measured conversations and never used.
 */
export interface BudgetCut {
  units: string[];
  /** The pack already leaves them out. */
  applied: boolean;
  window_days: number;
  min_deliveries: number;
}

/**
 * The context budget of one read, beside the pack by `include`: what the pack costs, what this agent already
 * spent in the conversation and the case, and what can go without loss. Shown, never enforced: the agent's
 * loop decides.
 */
export interface BudgetBlock {
  /** Absent when the read served no pack. */
  pack?: BudgetPack | null;
  /** This agent's turns in the conversation; absent without one. */
  conversation?: BudgetUse | null;
  /** This agent's turns in the case (`task_id`). */
  case?: BudgetUse | null;
  /** Turns other agents recorded in the same conversation. */
  other_agents_turns?: number;
  /** Absent until the measurement found a unit. */
  cut?: BudgetCut | null;
  /** False when the counters could not be read: the numbers above are then missing, not zero. */
  counted: boolean;
}

/** Body of a `POST /v1/context` response. */
export interface ContextResponse {
  /** `true` when `known_etag` still matches; `text` is then omitted. */
  not_modified: boolean;
  /**
   * `about` named an organization with no active link to the subject: the pack is the subject's own, without
   * that organization's block. It never says whether the organization exists.
   */
  about_unlinked?: boolean;
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
   * On a read with `query`: what the customer's last turn selected from memory for this turn, a
   * tagged block for the end of the prompt. Never part of `text`.
   */
  slots?: string | null;
  /**
   * What the guard lines among `slots` state, typed. `agent()` checks the answer against
   * them and names a guard it went against on the turn.
   */
  guards?: PackGuard[];
  /** With `include: ["constraints"]`: what the subject wants, refuses and is, for the tools. */
  constraints?: ConstraintsBlock | null;
  /** With `include: ["state"]`: the subject's objects of the declared types, as a `display` read serves them. */
  state?: StateView | null;
  /**
   * With `include: ["coordination"]`: who holds the subject, the purposes it may not be contacted for, the
   * contacts each purpose with a budget has left and the commitments that hold. Advice: only a check decides.
   */
  coordination?: CoordinationBlock | null;
  /**
   * With `include: ["budget"]`: what the pack costs per section, what this agent already spent in the
   * conversation and the case, and what the measurement says can go; shown, never enforced.
   */
  budget?: BudgetBlock | null;
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
  /**
   * The open items to list, by status. Unset: the open and overdue ones and the promises kept in
   * the last 7 days. `resolved` reaches every resolved item, with `closed_at` and `closed_by`;
   * `merged`, the twins merged into another item, with `merged_into`. Named, the timeline lists
   * open items too.
   */
  item_statuses?: ItemStatus[];
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

/** The open items history lists by status (`HistoryFilters.item_statuses`). */
export type ItemStatus = "open" | "overdue" | "resolved" | "merged";

/** What closed an open item: the same object the `open_item.closed` webhook carried. */
export interface ClosedBy {
  /** `action`, `system_event`, `conversation` or `feedback`. */
  kind: string;
  action_id?: string | null;
  event_id?: string | null;
  session_id?: string | null;
  operation?: string | null;
  source_id?: string | null;
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
  /** The business object the row is about: an open item's, a fact's, its own. */
  object?: ObjectRef | null;
  /** An open item's: the operation that closes it when done on its object. */
  expected_operation?: string | null;
  /** An open item's: `open`, `overdue`, `resolved` or `merged`. */
  status?: string | null;
  /** A resolved item's: when it was closed. */
  closed_at?: string | null;
  /** A resolved item's: what closed it. */
  closed_by?: ClosedBy | null;
  /** A merged item's: the `open_item:<id>` it was merged into, which carries it on. */
  merged_into?: string | null;
  /** An open item's: a promise someone made, a dispute raised or a request. */
  item_kind?: "promise" | "dispute" | "request" | null;
  /** A row about an object: `shared` reaches every participant, a customer-facing agent included; `internal`, internal readers only. */
  audience?: "shared" | "internal" | null;
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
  /**
   * `about` named an organization with no active link to the subject: the rows are the subject's own. It
   * never says whether the organization exists.
   */
  about_unlinked?: boolean;
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
  /** The organization the customer acts for: also an item of it the customer's view shows. */
  about?: Handle | null;
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
  /**
   * `about` named an organization with no active link to the subject: the rows are the subject's own. It
   * never says whether the organization exists.
   */
  about_unlinked?: boolean;
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
  kind: "episode" | "object" | "open_item";
  summary: string;
  requested?: string | null;
  promises: Commitment[];
  outcome?: string | null;
  resolution?: string | null;
  derived: HistoryItem[];
  timeline: HistoryItem[];
  as_of?: string | null;
  /** Earlier and current versions, oldest first, when the item has them. */
  versions?: ItemVersion[];
  /**
   * An open item's status: `open`, `overdue`, `resolved`, or `merged` when the id is a twin of
   * another item, which answers for it from then on.
   */
  status?: string | null;
  /** The item a merged id answers for (`open_item:<id>`); `summary` is that item's. */
  merged_into?: string | null;
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
