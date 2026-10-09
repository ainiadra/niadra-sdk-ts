/**
 * The local copy of the suppression list (`spec/suppression-list.md`): the opt-out holds with Niadra down.
 *
 * The copy is read by cursor from `GET /v1/suppressions` (a page shorter than the limit is the end of the
 * changes for now, and its cursor is where the next read starts), with this reader's salt from
 * `GET /v1/suppressions/salt`, and read again once it is a minute old. Before an outbound contact the SDK
 * computes the destination's key and looks it up here, in memory:
 *
 * - an entry with that key, the purpose, the channel (or every channel), in force now, forbids the contact;
 * - when the list cannot be read, the last copy keeps applying, however old: an opt-out does not wait for
 *   Niadra;
 * - with no copy at all and Niadra out of reach, the purpose decides: transactional and service contacts go
 *   (they fail open), marketing, retention and collection wait (they fail closed);
 * - a space that keeps no list (the route answers 404) has nothing to suppress.
 *
 * The salt and the keys never leave the process.
 */

import { NiadraAPIError } from "../errors.js";
import type { Handle } from "../types/common.js";
import type { Suppression, SuppressionPage, SuppressionSalt } from "../types/coordination.js";
import { NiadraDestinationError, canonicalDestination, suppressionKey } from "./destination.js";

/** Milliseconds after which the copy is read again. */
const REFRESH_MS = 60_000;
/** Purposes whose contacts go when Niadra cannot say; every other purpose waits. */
const FAIL_OPEN = new Set(["transactional", "service"]);
const PAGE = 200;
/** Pages one read takes at most; the next read goes on from its cursor. */
export const MAX_PAGES = 50;
/**
 * Round trips the first check waits for, each within its own budget: the salt and the first page, the whole
 * list of a space with up to `PAGE` entries. A read stopped at one budget for all of them: from Sao Paulo the
 * salt on a new connection took that budget alone (09/10/2026), the first page was never asked for, and the
 * first check of a purpose that fails closed said no on every channel. A longer list goes on in the background.
 */
export const FIRST_READ_ROUNDS = 2;

interface SuppressionReader {
  salt(): Promise<SuppressionSalt>;
  page(cursor: string | null, limit: number): Promise<SuppressionPage>;
}

export class SuppressionCopy {
  private saltValue: SuppressionSalt | null = null;
  private readonly entries = new Map<string, Suppression>();
  private cursor: string | null = null;
  private readAt: number | null = null;
  /** The space keeps no list: nothing is suppressed. */
  private absent = false;
  private reading: Promise<void> | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  due(): boolean {
    return this.readAt === null || this.now() - this.readAt >= REFRESH_MS;
  }

  /** Whether the SDK has a copy (or knows there is no list to copy). */
  get held(): boolean {
    return this.absent || this.readAt !== null;
  }

  /**
   * Reads the list with `reader`, one read at a time, in up to `rounds` round trips, each within the reader's
   * own budget; never rejects. A read already under way is the one returned.
   */
  read(reader: SuppressionReader, rounds: number = MAX_PAGES): Promise<void> {
    this.reading ??= this.readAll(reader, rounds).finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async readAll(reader: SuppressionReader, rounds: number): Promise<void> {
    try {
      for (let i = 0; i < rounds; i++) {
        if (this.saltValue === null) {
          this.takeSalt(await reader.salt());
          continue;
        }
        if (!this.apply(await reader.page(this.cursor, PAGE))) return;
      }
    } catch (error) {
      this.failed(error);
    }
  }

  takeSalt(salt: SuppressionSalt): void {
    if (this.saltValue !== null && this.saltValue.salt_id !== salt.salt_id) {
      this.entries.clear(); // keys of another salt name no one now
      this.cursor = null;
    }
    this.saltValue = salt;
  }

  /**
   * Applies one page, in order. `true` when more pages follow: a full page. Every page carries the cursor to
   * read from next, the last one too, which the next read starts from.
   */
  apply(page: SuppressionPage): boolean {
    if (page.salt_id !== this.saltValue?.salt_id) {
      // The salt changed: the keys held name no one now. Take the new salt, then read it all.
      this.saltValue = null;
      this.cursor = null;
      this.entries.clear();
      return true;
    }
    if (page.reset) this.entries.clear();
    for (const entry of page.items) {
      if (entry.removed) this.entries.delete(entry.id);
      else this.entries.set(entry.id, entry);
    }
    this.cursor = page.next_cursor ?? this.cursor;
    this.absent = false;
    const more = Boolean(page.next_cursor) && page.items.length >= PAGE;
    if (!more) this.readAt = this.now();
    return more;
  }

  /** A 404: the space keeps no list. Anything else: the copy stays as it is. */
  failed(error: unknown): void {
    if (error instanceof NiadraAPIError && error.status === 404) {
      this.absent = true;
      this.readAt = this.now();
      this.entries.clear();
    }
  }

  /**
   * Whether an outbound contact of `purpose` to `handle` may go, by the local copy. `failOpen` overrides the
   * purpose's direction when there is no copy.
   */
  async mayContact(handle: Handle, purpose: string, options: { channel?: string | null; at?: Date; failOpen?: boolean } = {}): Promise<boolean> {
    if (this.absent) return true;
    if (this.saltValue === null || this.readAt === null) return options.failOpen ?? FAIL_OPEN.has(purpose);
    let key: string;
    try {
      key = await suppressionKey(this.saltValue.salt, canonicalDestination(handle.type, handle.value));
    } catch (error) {
      if (error instanceof NiadraDestinationError) return true; // not a destination the list covers
      throw error;
    }
    const at = (options.at ?? new Date()).getTime();
    for (const e of this.entries.values()) {
      if (e.key !== key || e.purpose !== purpose) continue;
      if (e.channel != null && e.channel !== options.channel) continue;
      if (Date.parse(e.since) > at) continue;
      if (e.until != null && Date.parse(e.until) <= at) continue;
      return false;
    }
    return true;
  }
}
