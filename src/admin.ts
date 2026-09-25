import { NiadraValidationError } from "./errors.js";
import { uuidv7 } from "./ids.js";
import type { RequestOptions } from "./context.js";
import type { Result } from "./tools.js";
import type { RequestSpec } from "./transport.js";
import type {
  CorrectionAction,
  CorrectionRequest,
  Erasure,
  ExportPackage,
  FactHistory,
  ForgetTarget,
  ProfileMatch,
  ProfileMemory,
} from "./types/admin.js";
import type { Handle } from "./types/common.js";
import type { BatchResponse } from "./types/events.js";

/** What `Admin` needs from the client: sending a request with its fail-open policy, and the specs. */
export interface AdminPort {
  send<T>(build: () => RequestSpec): Promise<Result<T>>;
  read(method: "GET" | "POST", path: string, body: unknown, options: RequestOptions): RequestSpec;
  write(path: string, body: unknown, idempotencyKey: string, options: RequestOptions): RequestSpec;
}

export interface CorrectParams {
  action: CorrectionAction;
  fact_id?: string | null;
  open_item_id?: string | null;
  value?: string | null;
  reason?: string | null;
  idempotency_key?: string;
}

const segment = (value: string) => encodeURIComponent(value);

function correction(profileId: string, params: CorrectParams): CorrectionRequest {
  const body: CorrectionRequest = { profile_id: profileId, action: params.action };
  if (params.fact_id) body.fact_id = params.fact_id.replace(/^fact:/, "");
  if (params.open_item_id) body.open_item_id = params.open_item_id;
  if (params.value) body.value = params.value;
  if (params.reason) body.reason = params.reason;
  return body;
}

/**
 * Governance calls for a key with the `admin` scope: `niadra.admin`. Find a customer, read their
 * memory and a fact's history, correct it, erase it, export it. They fail open like every other
 * method: `{ data: null, error }` unless `strict` is set.
 */
export class Admin {
  constructor(private readonly port: AdminPort) {}

  /** Profiles by pseudonym (`p_...`) or identifier; the value travels in the body, handles come back masked. */
  findProfiles(
    query: string,
    params: { type?: string; scope?: string; limit?: number } = {},
    options: RequestOptions = {},
  ): Promise<Result<{ items: ProfileMatch[] }>> {
    return this.port.send(() =>
      this.port.read("POST", "/v1/profiles/search", { query, limit: params.limit ?? 20, ...params }, options),
    );
  }

  /** Everything memory holds about one customer, every status, with provenance. Leaves an admin receipt. */
  memory(profileId: string, options: RequestOptions = {}): Promise<Result<ProfileMemory>> {
    return this.port.send(() =>
      this.port.read("GET", `/v1/profiles/${segment(profileId)}/memory`, undefined, options),
    );
  }

  /** Every value a fact's slot held, oldest first, with who replaced whom. Takes `fact:<id>` or the bare id. */
  factHistory(profileId: string, factId: string, options: RequestOptions = {}): Promise<Result<FactHistory>> {
    const fact = segment(factId.replace(/^fact:/, ""));
    return this.port.send(() =>
      this.port.read("GET", `/v1/profiles/${segment(profileId)}/facts/${fact}/history`, undefined, options),
    );
  }

  /** The data subject's correction: retract or correct a fact, or resolve an open item. */
  correct(profileId: string, params: CorrectParams, options: RequestOptions = {}): Promise<Result<BatchResponse>> {
    const key = params.idempotency_key ?? uuidv7();
    return this.port.send(() => this.port.write("/v1/corrections", correction(profileId, params), key, options));
  }

  /** Up to 100 corrections; item `n` is keyed `<idempotency_key>:<n>`, so a retry repeats none. */
  correctBatch(
    items: (CorrectionRequest | (CorrectParams & { profile_id: string }))[],
    params: { idempotency_key?: string } = {},
    options: RequestOptions = {},
  ): Promise<Result<BatchResponse>> {
    const key = params.idempotency_key ?? uuidv7();
    return this.port.send(() => {
      if (items.length < 1 || items.length > 100) throw new NiadraValidationError("1 to 100 corrections");
      const body = { items: items.map((item) => correction(item.profile_id, item)) };
      return this.port.write("/v1/corrections/batch", body, key, options);
    });
  }

  /** Erases a customer, one identifier or one conversation, with a receipt. Follow it with `forgetStatus`. */
  forget(
    target: ForgetTarget,
    params: { idempotency_key?: string } = {},
    options: RequestOptions = {},
  ): Promise<Result<Erasure>> {
    const key = params.idempotency_key ?? uuidv7();
    return this.port.send(() => {
      const named = (["profile_id", "handle", "conversation_id"] as const).filter((k) => k in target);
      const [only] = named;
      if (named.length !== 1 || !only) {
        throw new NiadraValidationError("pass exactly one of profile_id, handle or conversation_id");
      }
      const kind = { profile_id: "profile", handle: "handle", conversation_id: "conversation" }[only];
      return this.port.write("/v1/forget", { target: kind, ...target }, key, options);
    });
  }

  forgetStatus(requestId: string, options: RequestOptions = {}): Promise<Result<Erasure>> {
    return this.port.send(() => this.port.read("GET", `/v1/forget/${segment(requestId)}`, undefined, options));
  }

  /** One customer's portable package: JSON lines per kind of record, zipped, behind a signed link. */
  export(
    subject: { profile_id: string } | { handle: Handle },
    options: RequestOptions = {},
  ): Promise<Result<ExportPackage>> {
    return this.port.send(() => {
      if (("profile_id" in subject) === ("handle" in subject)) {
        throw new NiadraValidationError("pass exactly one of profile_id or handle");
      }
      return this.port.write("/v1/export", subject, uuidv7(), options);
    });
  }
}
