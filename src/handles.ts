import { NiadraValidationError } from "./errors.js";
import type { Handle, ObjectRef } from "./types/common.js";
import type { SubjectKind } from "./types/vocabulary.js";

interface HandleOptions {
  /** Overrides the subject kind the server would infer from the handle type. */
  subjectKind?: SubjectKind;
}

function build(type: Handle["type"], value: string, scope?: string, options?: HandleOptions): Handle {
  const handle: Handle = { type, value };
  if (scope !== undefined) handle.scope = scope;
  if (options?.subjectKind !== undefined) handle.subject_kind = options.subjectKind;
  return handle;
}

/**
 * Builders for the handle types the API accepts. They only assemble the object; the value is
 * normalized and validated on the server, which is the single source of truth for matching.
 *
 * @example
 * niadra.context({ subject: handles.phone("+5511987654321"), conversation_id: "wa-8812" })
 */
export const handles = {
  /** A phone number in E.164 form, such as `+5511987654321`. */
  phone: (e164: string, options?: HandleOptions): Handle => build("phone_e164", e164, undefined, options),
  email: (address: string, options?: HandleOptions): Handle => build("email", address, undefined, options),
  /** The WhatsApp id (`wa_id`) the Cloud API reports for a contact. */
  waId: (value: string, options?: HandleOptions): Handle => build("wa_id", value, undefined, options),
  waJid: (value: string, options?: HandleOptions): Handle => build("wa_jid", value, undefined, options),
  waLid: (value: string, options?: HandleOptions): Handle => build("wa_lid", value, undefined, options),
  /** A business-scoped WhatsApp user id; `businessAccount` is the WhatsApp Business account it belongs to. */
  waBsuid: (value: string, businessAccount: string, options?: HandleOptions): Handle =>
    build("wa_bsuid", value, businessAccount, options),
  /** The user id in your own app or site. */
  appUserId: (value: string, options?: HandleOptions): Handle => build("app_user_id", value, undefined, options),
  /** The id of a person or organization in a system of record; `system` names that system, such as `crm`. */
  systemId: (value: string, system: string, options?: HandleOptions): Handle =>
    build("system_id", value, system, options),
  /** An HMAC of a national document number; `country` is its ISO 3166-1 alpha-2 code. */
  govIdHmac: (value: string, country: string, options?: HandleOptions): Handle =>
    build("gov_id_hmac", value, country, options),
  /** An HMAC of a company registry number. Identifies an organization. */
  orgRegistryHmac: (value: string, country: string): Handle =>
    build("org_registry_hmac", value, country, { subjectKind: "account" }),
  /** An e-mail domain, such as `acme.com`. Identifies an organization. */
  emailDomain: (domain: string): Handle => build("email_domain", domain, undefined, { subjectKind: "account" }),
  /** An anonymous visitor or device id, before the person is known. */
  anonId: (value: string, options?: HandleOptions): Handle => build("anon_id", value, undefined, options),
} as const;

/**
 * Accepts an `ObjectRef` or the `type:namespace:id` shorthand. The id may itself contain
 * colons (`invoice:erp:2026:0823`); only the first two separate the parts.
 */
export function toObjectRef(object: ObjectRef | string): ObjectRef {
  if (typeof object !== "string") return object;
  const first = object.indexOf(":");
  const second = first < 0 ? -1 : object.indexOf(":", first + 1);
  if (first <= 0 || second <= first + 1 || second === object.length - 1) {
    throw new NiadraValidationError("object must look like `type:namespace:id`");
  }
  return { type: object.slice(0, first), namespace: object.slice(first + 1, second), id: object.slice(second + 1) };
}
