/**
 * `conversation.claims`: the claim contract in the agent's process. `check()` classifies and counts;
 * `guard()` and `guardText()` act, as the contract's actions say (`capture/guard.ts`). The contract comes with
 * the SDK profile and stays in the local cache: with Niadra down the checks go on with the last one read.
 */

import type { ClaimContractSummary } from "../types/state.js";
import type { ClaimRecord } from "../types/turns.js";
import { checkSaid } from "./claims.js";
import { currentTurn } from "./frame.js";
import { Guard, guardStream, guardText } from "./guard.js";
import type { GuardOptions, Guarded } from "./guard.js";

export interface CheckOptions {
  /** The output's kind: `chat`, `proposal`, `contestacao`. Defaults to `chat`. */
  context?: string;
  immutable?: boolean;
  agent?: string | null;
}

export class ClaimCheck {
  constructor(private readonly contract: () => Promise<ClaimContractSummary | null>) {}

  /**
   * Classifies and counts the claims of `text` (a message before it goes, a document before it is saved)
   * against what the current turn holds, and records them in the turn. Never changes `text`, never
   * rejects: without a contract, or when the check fails, there is nothing to report.
   */
  async check(text: string, options: CheckOptions = {}): Promise<ClaimRecord[]> {
    const frame = currentTurn();
    const contract = await this.contract();
    if (contract === null) return [];
    try {
      const said = { text, context: options.context ?? "chat", immutable: options.immutable ?? false, agent: options.agent ?? frame?.agent ?? null };
      const records = checkSaid(frame, contract, said);
      frame?.addClaims(records);
      return records;
    } catch {
      frame?.incomplete();
      return [];
    }
  }

  /**
   * `text` as the contract's actions leave it, with its claims recorded in the current turn. An immutable
   * output (the contract's `outputs.immutable`, or `immutable: true`) never changes: a block sends it to a
   * person (`review`). Without a contract the text goes as it is.
   */
  async guardText(text: string, options: CheckOptions = {}): Promise<Guarded> {
    const frame = currentTurn();
    const contract = await this.contract();
    if (contract === null) return { text, claims: [], review: false };
    return guardText(contract, frame, text, options);
  }

  /**
   * The stream of the agent's answer, text chunks, as it may reach the customer: what could start a claim is
   * held until its sentence ends (at most `holdMs`, and `messageMs` in total), checked and let go as the
   * contract's actions leave it. Without a contract the chunks pass untouched.
   */
  async *guard(stream: AsyncIterable<string> | Iterable<string>, options: GuardOptions = {}): AsyncGenerator<string> {
    const frame = currentTurn();
    const contract = await this.contract();
    if (contract === null) {
      for await (const chunk of stream) yield chunk;
      return;
    }
    yield* guardStream(new Guard(contract, frame, options), stream);
  }
}
