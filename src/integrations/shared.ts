/**
 * What every framework adapter shares: the five primitives (context before the model call, the
 * turns, the tools, the verification and the handoff) wired the same way, and fail-open.
 *
 * Nothing here throws into the framework: a failed read gives an empty context, a failed write
 * is logged without content, and the agent keeps working without memory.
 */

import type { ContextResult } from "../context.js";
import { emptyResult } from "../context.js";
import type { Conversation, TurnOptions } from "../conversation.js";
import type { Logger } from "../logger.js";
import type { Task } from "../task.js";
import type { BoundTools } from "../tools.js";
import type { Handle } from "../types/common.js";
import type { Verification, VerifyMethod } from "../types/vocabulary.js";

/** A customer conversation or an internal agent's task. */
export type Session = Conversation | Task;

/** A session, or a function that finds the one the current call belongs to (`null` passes the call through). */
export type SessionResolver<S extends Session = Session> = S | (() => S | null | undefined);

/** What the framework proved about the person, recorded with `verify()` before the first context read. */
export interface Proof {
  method: VerifyMethod;
  level: Verification;
  /** Defaults to the session's subject. */
  handle?: Handle;
}

/** A proof, or a function that reads it from the framework when the first context is needed. */
export type ProofSource =
  | Proof
  | null
  | undefined
  | (() => Proof | null | undefined | PromiseLike<Proof | null | undefined>);

/** A tool as every framework needs it: the name, the text for the model, the JSON Schema and the call. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. None of them names the customer. */
  parameters: Record<string, unknown>;
  /** Runs the call and returns the text for the model. Never rejects in fail-open mode. */
  execute(args: string | Record<string, unknown>): Promise<string>;
}

const ATTESTED: Record<string, Verification> = { A: "V2", B: "V1", C: "V1" };

/**
 * The proof a carrier's STIR/SHAKEN attestation gives a phone call: `A` proves V2, `B` and `C`
 * prove V1, anything else proves nothing (`null`). Accepts the bare letter or the forms carriers
 * and platforms send, such as Twilio's `TN-Validation-Passed-A`.
 */
export function attestationProof(attestation: string | null | undefined): Proof | null {
  if (!attestation) return null;
  const value = attestation.trim().toUpperCase();
  if (value.includes("FAILED") || value.startsWith("NO-")) return null;
  const letter = value.length === 1 ? value : /PASSED-([ABC])$/.exec(value)?.[1];
  const level = letter ? ATTESTED[letter] : undefined;
  return level ? { method: "network_attestation", level } : null;
}

export function resolveSession<S extends Session>(source: SessionResolver<S>): S | null {
  if (typeof source !== "function") return source;
  try {
    return source() ?? null;
  } catch {
    return null;
  }
}

export function isConversation(session: Session): session is Conversation {
  return "customer" in session && typeof session.customer === "function";
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * One session as an adapter drives it. Keeps the verification to a single call made before the
 * first context read, and turns every failure into a log line.
 */
export class Bridge {
  private proving: Promise<void> | null = null;

  constructor(
    readonly session: Session,
    private readonly proof?: ProofSource,
  ) {}

  get logger(): Logger {
    return this.session.logger;
  }

  /** Verifies once (when a proof was given), then reads the context. Never rejects. */
  async context(): Promise<ContextResult> {
    await this.verifyOnce();
    try {
      return await this.session.context();
    } catch (error) {
      this.logger.warn(`could not read context (${errorName(error)})`);
      return emptyResult(null);
    }
  }

  /** Records that `context` went into the prompt, unless it was empty for a reason other than the holdout. */
  injected(context: ContextResult): void {
    if (!context.text && !context.suffix && context.response?.path !== "holdout") return;
    this.safe("mark the injection", () => {
      this.session.markInjected(context);
    });
  }

  customer(text: string, options: TurnOptions = {}): void {
    const session = this.session;
    if (!text.trim() || !isConversation(session)) return;
    this.safe("record the customer's turn", () => session.customer(text, options));
  }

  agent(text: string, options: TurnOptions = {}): void {
    if (!text.trim()) return;
    this.safe("record the agent's turn", () => this.session.agent(text, options));
  }

  /** Records a transfer. Tasks have no transfer; the call is ignored for them. */
  async handoff(target: "agent" | "human", reason?: string): Promise<void> {
    const session = this.session;
    if (!isConversation(session)) return;
    try {
      await session.handoff(reason ? { target, reason } : { target });
    } catch (error) {
      this.logger.warn(`could not record the handoff (${errorName(error)})`);
    }
  }

  async end(): Promise<void> {
    try {
      await this.session.end();
    } catch (error) {
      this.logger.warn(`could not end the session (${errorName(error)})`);
    }
  }

  /** The navigation kit as plain specs, or an empty list for a task about an object only. */
  tools(): ToolSpec[] {
    let bound: BoundTools | null;
    try {
      bound = this.session.tools();
    } catch (error) {
      this.logger.warn(`could not build the tools (${errorName(error)})`);
      return [];
    }
    return bound ? toolSpecs(bound) : [];
  }

  private async verifyOnce(): Promise<void> {
    if (this.proof === undefined || this.proof === null) return;
    this.proving ??= this.runVerify();
    await this.proving;
  }

  private async runVerify(): Promise<void> {
    try {
      const source = this.proof;
      const proof = typeof source === "function" ? await source() : source;
      if (!proof) return;
      await this.session.verify(proof);
    } catch (error) {
      this.logger.warn(`could not record the verification (${errorName(error)})`);
    }
  }

  private safe(what: string, run: () => unknown): void {
    try {
      run();
    } catch (error) {
      this.logger.warn(`could not ${what} (${errorName(error)})`);
    }
  }
}

/** The bound kit as specs. The customer stays inside `bound`; no parameter names them. */
export function toolSpecs(bound: BoundTools): ToolSpec[] {
  return bound.definitions.map(({ function: definition }) => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    execute: (args) => bound.call(definition.name, args),
  }));
}

/** The text of a message content in the shapes model APIs use: a string, or a list of text parts. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content as unknown[]) {
    if (typeof part === "string") parts.push(part);
    else if (isRecord(part) && typeof part.text === "string" && (part.type === undefined || part.type === "text")) {
      parts.push(part.text);
    }
  }
  return parts.join("");
}

export function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

/** A non-negative integer, or `null`. */
export function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
