/**
 * The SDK profile in the client's warm cache: `GET /v1/sdk/profile`.
 *
 * The profile says which agent features the space turned on, and carries what the SDK checks locally: the
 * claim contract and the summarized type registry. It is read on first need and again once `valid_for_s` has
 * passed.
 *
 * - A server that answers 404 has no profile for this key (an older cell, or a space with every feature off):
 *   the features count as off for 10 minutes, then the SDK asks again, as it does for prefetch.
 * - A server that does not answer keeps the last profile in use, however old: Niadra being down never turns
 *   what the SDK knew into "not known".
 */

import { NiadraAPIError } from "./errors.js";
import type { ContentMode } from "./capture/frame.js";
import type { ClaimContractSummary, SdkProfile } from "./types/state.js";

/** Milliseconds the features count as off after a 404, before the SDK asks again. */
const OFF_FOR_MS = 600_000;

export class ProfileCache {
  profile: SdkProfile | null = null;
  /** A contract of the company's own, which wins over the profile's (for CI and local runs). */
  claimContract: ClaimContractSummary | null = null;
  private fetchedAt: number | null = null;
  private offUntil = 0;
  private reading: Promise<unknown> | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Whether a read should ask the server: no profile yet, or one past `valid_for_s`. */
  due(): boolean {
    const now = this.now();
    if (now < this.offUntil) return false;
    if (this.profile === null || this.fetchedAt === null) return true;
    return now - this.fetchedAt >= this.profile.valid_for_s * 1000;
  }

  /** Reads the profile with `read` when it is due, one read at a time; never rejects. */
  async refresh(read: () => Promise<SdkProfile>): Promise<SdkProfile | null> {
    if (!this.due()) return this.profile;
    this.reading ??= read().then(
      (profile) => {
        this.profile = profile;
        this.fetchedAt = this.now();
      },
      (error: unknown) => { this.failed(error); },
    );
    try {
      await this.reading;
    } finally {
      this.reading = null;
    }
    return this.profile;
  }

  /** A 404 turns the features off for a while; any other failure keeps the last profile. */
  failed(error: unknown): void {
    if (error instanceof NiadraAPIError && error.status === 404) {
      this.profile = null;
      this.fetchedAt = null;
      this.offUntil = this.now() + OFF_FOR_MS;
    }
  }

  /** The features the space turned on, or `null` while the SDK does not know. */
  get features(): ReadonlySet<string> | null {
    if (this.profile === null) return this.now() < this.offUntil ? new Set() : null;
    return new Set(this.profile.features);
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
