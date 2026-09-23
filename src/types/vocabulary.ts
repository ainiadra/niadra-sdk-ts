/**
 * The contract vocabulary. Every value here travels through the public API unchanged and
 * never changes meaning within `/v1`, so the SDK mirrors it as string literal unions.
 */

/** What an event records: something said, something a system reported, or something an agent did. */
export type EventKind = "message" | "system_event" | "action";

/** Who produced a turn. */
export type Speaker = "customer" | "ai_agent" | "human_agent" | "system";

/** `internal` events (notes between agents, system traces) never reach a customer-facing view. */
export type Visibility = "public" | "internal";

/** Subjects are people by default; accounts and partners are organizations. */
export type SubjectKind = "person" | "account" | "partner";

/**
 * How a handle identifies a subject. Scoped types (`wa_bsuid`, `system_id`, `gov_id_hmac`,
 * `org_registry_hmac`) need `scope` so the same value in two namespaces never collides.
 */
export type HandleType =
  | "phone_e164"
  | "wa_id"
  | "wa_jid"
  | "wa_lid"
  | "wa_bsuid"
  | "email"
  | "gov_id_hmac"
  | "app_user_id"
  | "system_id"
  | "org_registry_hmac"
  | "email_domain"
  | "anon_id";

/** How an `identify` call learned that several handles belong together. */
export type AssertionMethod =
  | "explicit_identify"
  | "otp"
  | "login"
  | "system_import"
  | "same_event"
  | "co_occurrence"
  | "channel_rotation"
  | "accepted_suggestion"
  | "external_resolver"
  | "declared";

/**
 * Session verification level. `V0` is an unverified contact and `V4` the strongest proof;
 * `no_customer` marks internal work with no customer on the other side.
 */
export type Verification = "V0" | "V1" | "V2" | "V3" | "V4" | "no_customer";

/** How a customer proved who they are in a `verify` call. */
export type VerifyMethod =
  | "otp_whatsapp"
  | "otp_sms"
  | "login"
  | "kba"
  | "network_attestation"
  | "human_agent";

/**
 * Which read tier answered a `context()` call. `holdout` means the conversation fell in the
 * control group: the pack is intentionally empty and the SDK treats it as a normal answer.
 */
export type DeliveryPath = "t0" | "t1" | "t2" | "t3" | "t4" | "holdout" | "not_modified";

/** Kinds of history items the navigation calls can filter on. */
export type HistoryItemKind =
  | "episode"
  | "fact"
  | "open_item"
  | "action"
  | "system_event"
  | "object"
  | "trait";

/**
 * The shape of the pack. Channel views (`voice`, `chat`) size it for the medium; `account`
 * and `partner` read an organization; `task:<name>` views serve internal agents.
 */
export type View =
  | "voice"
  | "chat"
  | "brief"
  | "full"
  | "custom"
  | "account"
  | "partner"
  | `task:${string}`;
