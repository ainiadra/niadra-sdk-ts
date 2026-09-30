/**
 * The SDK profile in the client's warm cache: `GET /v1/sdk/profile`.
 *
 * The profile says which agent features the space turned on, and carries what the SDK checks locally: the
 * claim contract, the summarized type registry and the bindings of this source's tools. It is read on first
 * need and again once `valid_for_s` has passed. A server that does not answer keeps the last profile in use,
 * however old: Niadra being down never turns what the SDK knew into "not known".
 */

import type { RawBinding } from "./constraints/binding.js";
import type { ContentMode } from "./capture/frame.js";
import type { ClaimContractSummary, SdkProfile } from "./types/state.js";

export class ProfileCache {
  profile: SdkProfile | null = null;
  /** A contract of the company's own, which wins over the profile's (for CI and local runs). */
  claimContract: ClaimContractSummary | null = null;
  private fetchedAt: number | null = null;
  private reading: Promise<unknown> | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether a read should ask the server: no profile yet, or one past `valid_for_s`. */
  due(): boolean {
    if (this.profile === null || this.fetchedAt === null) return true;
    return this.now() - this.fetchedAt >= this.profile.valid_for_s * 1000;
  }

  /** Reads the profile with `read` when it is due, one read at a time; never rejects. */
  async refresh(read: () => Promise<SdkProfile>): Promise<SdkProfile | null> {
    if (!this.due()) return this.profile;
    this.reading ??= read().then(
      (profile) => {
        this.profile = profile;
        this.fetchedAt = this.now();
      },
      () => undefined, // a failure keeps the last profile
    );
    try {
      await this.reading;
    } finally {
      this.reading = null;
    }
    return this.profile;
  }

  /** The features the space turned on, or `null` while the SDK does not know. */
  get features(): ReadonlySet<string> | null {
    return this.profile === null ? null : new Set(this.profile.features);
  }

  /** The claim contract the SDK checks outputs against: the company's own, else the profile's. */
  contract(): ClaimContractSummary | null {
    return this.claimContract ?? this.profile?.claim_contract ?? null;
  }

  /** The pins the space's recording needs for a turn to be replayable, when the profile says them. */
  requiredPins(): readonly string[] {
    return this.profile?.recording?.required_pins ?? [];
  }

  /**
   * The fields each type hides from this key (`mask` or `deny`), by type; `null` while no profile was ever read.
   * When Niadra does not answer, the last profile read keeps applying.
   */
  fieldAccess(): Record<string, Record<string, string>> | null {
    if (this.profile === null) return null;
    return Object.fromEntries((this.profile.types ?? []).map((t) => [String(t.type), { ...((t.field_access ?? {}) as Record<string, string>) }]));
  }

  /**
   * The binding the space serves this source for `tool`; `null` when it binds no such tool or no profile was
   * ever read. The last profile read keeps applying.
   */
  toolBinding(tool: string): RawBinding | null {
    return this.profile?.tool_bindings?.find((b) => b.tool === tool) ?? null;
  }

  /** Each field's attribute family (`item_variant.size_label` to `size`), from the type registry. */
  families(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of this.profile?.types ?? []) {
      for (const [name, spec] of Object.entries((t.fields ?? {}) as Record<string, { attribute?: { family?: string } | null }>)) {
        if (spec.attribute?.family) out[`${String(t.type)}.${name}`] = spec.attribute.family;
      }
    }
    return out;
  }

  /** The content mode the space's recording names for this source, when the profile says it. */
  recordingMode(): ContentMode | null {
    return this.profile?.recording?.content_mode ?? null;
  }
}
