import type { HandleType, SubjectKind } from "./vocabulary.js";

/**
 * An identifier of a subject in some channel or system: a phone number, an e-mail address,
 * a CRM id. Handles carry personal data, so the SDK only ever sends them in request bodies.
 */
export interface Handle {
  type: HandleType;
  /** Up to 320 characters. Phones are E.164 (`+5511987654321`). */
  value: string;
  /**
   * Namespace for scoped identifiers: the WhatsApp Business account for `wa_bsuid`, the
   * system for `system_id`, the country for `gov_id_hmac`.
   */
  scope?: string | null;
  /** Defaults to `person` on the server, except for organization-only handle types. */
  subject_kind?: SubjectKind | null;
}

/** A business object in a system of record, such as `invoice` / `erp` / `0823`. */
export interface ObjectRef {
  type: string;
  namespace: string;
  id: string;
}

/** A participant of an event other than the speaker, for example the account a person acts for. */
export interface Subject {
  kind: SubjectKind;
  role?: string | null;
  /** Between 1 and 16 handles. */
  handles: Handle[];
}

/** Whether a source is still sending. `silent` means it stopped, so the pack may be missing recent turns. */
export interface SourceCoverage {
  source_id: string;
  status: "ok" | "silent" | (string & {});
  last_event_at?: string | null;
}

/** RFC 9457 problem details, as returned with `application/problem+json`. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string | null;
  /** Stable code from the versioned error catalog, such as `rate_limited` or `wrong_cell`. */
  code: string;
  request_id?: string | null;
}
