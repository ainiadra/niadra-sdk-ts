import type { Handle, ObjectRef } from "./common.js";

/** `GET /v1/sources/me`: what a key authenticates as. */
export interface KeyIdentity {
  space_id: string;
  tenant_id: string;
  region: string;
  environment: string;
  source_id: string;
  source_name?: string | null;
  vendor?: string | null;
  key_id: string;
  /** Sorted. */
  scopes: string[];
  audience: string;
  verification_ceiling: string;
  /** Sorted. */
  purposes: string[];
  /** Whether the space has the agents' own notes turned on. */
  agent_memory: boolean;
}

/** `POST /v1/ingest/status`: whether what was sent for a conversation or task became memory yet. */
export interface IngestStatus {
  /** `open`, `processing`, `ready`, `failed` or `unknown`. */
  state: "open" | "processing" | "ready" | "failed" | "unknown";
  last_event_at?: string | null;
  closed_at?: string | null;
  close_reason?: string | null;
  /** `ok`, `minimal`, `invalid` or `failed`. */
  extraction?: string | null;
  /**
   * Values held back from this conversation's or task's events before storage, by type (`card`,
   * `cvv`, `password`, `secret`); absent when none was.
   */
  masked?: Record<string, number> | null;
}

/** Where an item came from: the event, its source, channel and time. Never its content. */
export interface Origin {
  event_id?: string | null;
  kind?: string | null;
  source_id?: string | null;
  channel?: string | null;
  at?: string | null;
  speaker?: string | null;
  conversation_id?: string | null;
  task_id?: string | null;
}

export interface FactOut {
  id: string;
  predicate: string;
  /** `null` when the policy masks it for this reader. */
  value: string | null;
  masked?: boolean;
  category: string;
  sensitivity: string;
  /** `active`, `expired`, `quarantined` or `retracted`. */
  status: string;
  confidence: number;
  valid_at: string;
  invalid_at?: string | null;
  last_confirmed_at: string;
  times_seen: number;
  about_handle_id?: string | null;
  object?: ObjectRef | null;
  evidence_event_ids?: string[];
  origin?: Origin | null;
}

export interface OpenItemOut {
  id: string;
  description: string | null;
  masked?: boolean;
  owner: "company" | "customer";
  promise: boolean;
  status: string;
  due_at?: string | null;
  created_at: string;
  object?: ObjectRef | null;
  expected_operation?: string | null;
  closed_by_action_id?: string | null;
  closed_at?: string | null;
  origin?: Origin | null;
}

export interface EpisodeOut {
  id: string;
  version: number;
  summary: string | null;
  masked?: boolean;
  intent: string;
  category: string;
  normalized_category: string;
  outcome: string;
  resolution?: string | null;
  sentiment?: number | null;
  session_id: string;
  started_at: string;
  ended_at: string;
  origin: Origin;
}

export interface TraitOut {
  id: string;
  name: string;
  value: string | null;
  masked?: boolean;
  layer: string;
  rule_version: string;
  first_seen: string;
  last_evidence_at: string;
  expires_at: string;
  confidence: number;
  active: boolean;
  retracted_at?: string | null;
  evidence?: { kind: string; id: string; origin?: Origin | null }[];
}

/** `GET /v1/profiles/{profile_id}/memory`: everything memory holds about one customer. */
export interface ProfileMemory {
  profile_id: string;
  policy_version: string;
  audience: string;
  facts: FactOut[];
  open_items: OpenItemOut[];
  /** Episodes, newest first. */
  timeline: EpisodeOut[];
  traits: TraitOut[];
  /** Items left out, by reason. */
  withheld: Record<string, number>;
}

/** `GET /v1/profiles/{profile_id}/facts/{fact_id}/history`. */
export interface FactHistory {
  profile_id: string;
  fact_id: string;
  predicate: string;
  policy_version: string;
  /** Every value the fact's slot held, oldest first. */
  versions: FactOut[];
  /** `from_fact_id` is the newer fact; `type` is `supersedes`, `contradicts`, ... */
  relations: { from_fact_id: string; to_fact_id: string; type: string }[];
  withheld: Record<string, number>;
}

export interface ProfileMatch {
  profile_id: string;
  pseudonym: string;
  kind: string;
  partial: boolean;
  /** Masked by the key's role. */
  handles: Record<string, unknown>[];
  last_seen: string | null;
}

export type CorrectionAction = "retract_fact" | "correct_fact" | "resolve_open_item";

/** Body of `POST /v1/corrections`, and one item of `POST /v1/corrections/batch`. */
export interface CorrectionRequest {
  profile_id: string;
  action: CorrectionAction;
  fact_id?: string | null;
  open_item_id?: string | null;
  /** 1 to 2,000 characters, for `correct_fact`. */
  value?: string | null;
  /** Up to 500 characters. */
  reason?: string | null;
}

/** What to erase: exactly one of the three. */
export type ForgetTarget = { profile_id: string } | { handle: Handle } | { conversation_id: string };

export interface Erasure {
  request_id: string;
  /** `pending`, `running`, `completed` or `failed`. */
  status: string;
  target_kind: string;
  target_id: string;
  requested_at: string;
  completed_at?: string | null;
  erased: Record<string, number>;
  export_run_ids: string[];
  receipt_hash?: string | null;
}

export interface ExportPackage {
  run_id: string;
  profile_id: string;
  download_url: string;
  download_expires_at: string;
  /** File name inside the zip to SHA-256. */
  files: Record<string, string>;
  sha256: string;
}

/**
 * One measured delivery of context (`GET /v1/context-use/{conversation_id}`): what it carried,
 * whether the conversation used it, and, with `explain`, why each slot was chosen.
 */
export interface ContextUseEntry {
  manifest_hash: string;
  source_id: string;
  measure_version: string;
  channel: string;
  view: string;
  experiment_group: string;
  items: Record<string, unknown>[];
  questions: number;
  repeated: number;
  used: number;
  contradicted: number;
  late: boolean;
  measured_at: string;
  not_measured_reason?: string | null;
  transfer_unread?: boolean | null;
  /** Tokens this delivery's pack left out for lack of use. */
  tokens_saved: number;
  /**
   * Memory v2: one entry per read of this delivery that carried slots: `channels` (hits per
   * retrieval channel, `skipped`), `items` (per slot: `id`, `kind`, `channels`, `position`,
   * `used`, `repeated`, `contradicted`, and `why`: `score`, per channel its `position`, `weight`
   * and `contribution`, `via` for a linked item), `derived` (the rule of each derived line) and
   * `weights_version`. The same numbers as the slots receipt, never a line.
   */
  slots: Record<string, unknown>[];
}
