/**
 * Niadra for Retell AI, on the server side: a call reaches Retell, Retell calls your webhooks
 * (and, with a custom LLM, opens a websocket to your server), and these handlers answer them. No
 * Retell package is needed.
 *
 * - `inbound`: the inbound call webhook. Opens the conversation by Retell's `call_id`, records what
 *   the call proved, reads the voice context and answers it as dynamic variables: put
 *   `{{niadra_context}}` in the agent's prompt (and `{{niadra_turn}}` where the live turns from other
 *   channels go).
 * - `tool`: custom functions for the navigation kit. `toolConfigs()` writes them for Retell's
 *   `general_tools`; the customer comes from the call, never from the model's arguments.
 * - `webhook`: the agent webhook. `call_started` keeps the caller of calls that had no inbound
 *   webhook (outbound and web calls), `transfer_started` records a transfer to a person, and
 *   `call_ended` records every utterance of `transcript_object` and ends the conversation.
 * - `llm(callId)`: for a custom LLM, one session per websocket (`/llm-websocket/:call_id`). It asks
 *   for the call details, answers Retell's pings, records each utterance once a response is
 *   required, and gives your model the messages with the context in place. Retell does not sign the
 *   websocket, so the customer comes from a signed webhook of the same call (`inbound` or
 *   `call_started`, kept in the store), never from the socket's `call_details`: anyone who reaches
 *   the socket could name any caller there. Until a signed webhook registers the call, the model gets
 *   no context and nothing is recorded. Set `trustCallDetails` only when the socket accepts Retell
 *   alone (an IP allowlist, a secret in its URL).
 *
 * Every request is checked against `X-Retell-Signature` (HMAC-SHA256 of the raw body and its
 * timestamp, keyed with your Retell API key, within five minutes). Utterances carry the same
 * idempotency key on the websocket and in `call_ended`, so recording both ways stores them once.
 * Only web APIs: runs on Node, Deno, Bun, Cloudflare Workers and the Vercel Edge Runtime.
 *
 * @example
 * import { retell } from "@niadra/sdk/retell";
 *
 * const handlers = retell({ niadra, apiKey: process.env.RETELL_API_KEY! });
 * app.post("/retell/inbound", async (c) => answer(c, await handlers.inbound(await c.req.text(), c.req.raw.headers)));
 * app.post("/retell/webhook", async (c) => answer(c, await handlers.webhook(await c.req.text(), c.req.raw.headers)));
 * app.post("/retell/tools", async (c) => answer(c, await handlers.tool(await c.req.text(), c.req.raw.headers)));
 *
 * // Custom LLM: one session per websocket Retell opens.
 * wss.on("connection", (ws, request) => {
 *   const session = handlers.llm(callIdFrom(request.url), { send: (event) => ws.send(JSON.stringify(event)), instructions: "You are Acme's receptionist." });
 *   session.open("Acme Energy, how can I help?");
 *   ws.on("message", async (data) => {
 *     const turn = await session.receive(JSON.parse(String(data)));
 *     if (turn) turn.respond(await yourModel(turn.messages));
 *   });
 * });
 */

import type { Niadra } from "../client.js";
import type { Conversation } from "../conversation.js";
import { AGENT_MEMORY_TOOL_DEFINITIONS, AGENT_MEMORY_TOOL_NAMES, TOOL_DEFINITIONS, TOOL_NAMES } from "../tools.js";
import type { Handle } from "../types/common.js";
import { Bridge, errorName, isRecord, phoneHandle } from "./shared.js";
import type { AgentMemoryOption, Proof } from "./shared.js";
import { bodyText, header, hex, hmac, memoryCallStore, parseJson, safeEqual } from "./webhook.js";
import type { CallRecord, CallStore, HeadersLike, WebhookResponse } from "./webhook.js";

export { attestationProof } from "./shared.js";
export type { AgentMemoryOption, Proof } from "./shared.js";
export { memoryCallStore } from "./webhook.js";
export type { CallRecord, CallStore, HeadersLike, WebhookResponse } from "./webhook.js";

/** What the handlers read from a Retell call object (or from the inbound webhook). */
export interface RetellCall {
  /** Retell's `call_id`, used as the `conversation_id`. */
  id: string;
  fromNumber?: string | undefined;
  toNumber?: string | undefined;
  direction?: string | undefined;
  agentId?: string | undefined;
  /** The whole call object, for anything else you need (`metadata`, `retell_llm_dynamic_variables`). */
  call: Record<string, unknown>;
}

export interface RetellOptions {
  niadra: Niadra;
  /** The Retell API key that signs the webhooks (the one marked for webhooks in the dashboard). Required. */
  apiKey: string;
  /** Who the customer is. Defaults to the caller of inbound calls and the callee of outbound ones, as E.164. */
  subject?: (call: RetellCall) => Handle | null | undefined;
  /** What the call proved, such as the carrier's attestation you read from your telephony provider. */
  verify?: (call: RetellCall) => Proof | null | undefined | PromiseLike<Proof | null | undefined>;
  /** Keeps the caller and level between the webhooks of one call. Defaults to an in-memory store. */
  store?: CallStore;
  /** More fields for the inbound answer, such as `override_agent_id` or more `dynamic_variables`. */
  inboundFields?: (call: RetellCall) => Record<string, unknown>;
  /** Runs custom functions that are not Niadra's, so one URL can serve all of them. */
  otherTool?: (name: string, args: Record<string, unknown>, call: RetellCall) => unknown;
  /** Time budget of each context read, in milliseconds. Defaults to the voice budget. */
  contextTimeout?: number;
  /** The clock for the signature's five-minute window, in milliseconds. */
  now?: () => number;
  /**
   * The agent's own notes as the dynamic variable `niadra_agent_memory` (put it before
   * `{{niadra_context}}`), before the pack in the custom LLM's messages, and its memory tools.
   */
  agentMemory?: AgentMemoryOption;
  /**
   * Lets the custom LLM websocket open the conversation from its own `call_details` when no signed
   * webhook registered the call. Retell does not sign the websocket: turn this on only when your
   * server accepts that socket from Retell alone. Defaults to `false`.
   */
  trustCallDetails?: boolean;
}

/** A chat message in the shape every chat completions API takes. */
export interface RetellMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RetellRespondOptions {
  /** `false` while streaming chunks; the last chunk (or an empty one) closes the response. Defaults to `true`. */
  complete?: boolean;
  /** Hangs up after this response. */
  endCall?: boolean;
  /** Transfers the call to this number after this response, recorded as a transfer to a person. */
  transferNumber?: string;
}

/** One response Retell is waiting for. */
export interface RetellTurn {
  responseId: number;
  interactionType: "response_required" | "reminder_required";
  /** Your instructions, the agent's notes and the pack, then the call so far, the suffix at the end of the last user message. */
  messages: RetellMessage[];
  /** The pack, or an empty string. */
  context: string;
  /** Deltas and live turns from other channels, or an empty string. */
  suffix: string;
  /** Sends a response event to Retell for this turn. */
  respond(content: string, options?: RetellRespondOptions): void;
}

export interface RetellLlmOptions {
  /** Sends one event to Retell over the websocket, such as `(event) => ws.send(JSON.stringify(event))`. */
  send: (event: Record<string, unknown>) => void;
  /** Your system prompt; the context goes right after it. */
  instructions?: string;
}

/** One custom LLM websocket. */
export interface RetellLlmSession {
  /** Sends the config (asking for the call details) and, when given, the agent's first words. */
  open(greeting?: string): void;
  /** Handles one event from Retell; resolves to a turn when Retell needs a response. Never rejects. */
  receive(event: unknown): Promise<RetellTurn | null>;
  /** Sends what is queued for Niadra. Call it when the websocket closes. */
  close(): Promise<void>;
}

export interface RetellHandlers {
  /** The inbound call webhook, with the raw body: the signature covers the exact bytes. */
  inbound(rawBody: string | Uint8Array | ArrayBuffer, headers: HeadersLike): Promise<WebhookResponse>;
  /** The agent webhook (`call_started`, `call_ended`, `transfer_started`), with the raw body. */
  webhook(rawBody: string | Uint8Array | ArrayBuffer, headers: HeadersLike): Promise<WebhookResponse>;
  /** Custom function calls, with the raw body. */
  tool(rawBody: string | Uint8Array | ArrayBuffer, headers: HeadersLike): Promise<WebhookResponse>;
  /** A session for the custom LLM websocket of one call. */
  llm(callId: string, options: RetellLlmOptions): RetellLlmSession;
  /** The custom function configurations for Retell's `general_tools`, all pointing at your `tool` URL. */
  toolConfigs(options: { url: string; timeoutMs?: number }): Record<string, unknown>[];
}

const OURS = new Set<string>([...Object.values(TOOL_NAMES), ...Object.values(AGENT_MEMORY_TOOL_NAMES)]);
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** The handlers for one Retell agent. */
export function retell(options: RetellOptions): RetellHandlers {
  const store = options.store ?? memoryCallStore();
  const now = options.now ?? Date.now;
  const logger = options.niadra.logger;
  const readOptions = options.contextTimeout ? { timeout: options.contextTimeout } : {};
  const transferred = new Set<string>();

  const subjectOf = (call: RetellCall): Handle | null => {
    try {
      if (options.subject) return options.subject(call) ?? null;
      return phoneHandle(call.direction === "outbound" ? call.toNumber : call.fromNumber);
    } catch {
      return null;
    }
  };

  const remember = async (id: string, record: CallRecord): Promise<void> => {
    try {
      await store.set(id, record);
    } catch (error) {
      logger.warn(`could not write the call store (${errorName(error)})`);
    }
  };

  /** The call's record from the store, or rebuilt from what this request carries (without verifying again). */
  const recall = async (call: RetellCall): Promise<CallRecord | null> => {
    try {
      const stored = await store.get(call.id);
      if (stored) return stored;
    } catch (error) {
      logger.warn(`could not read the call store (${errorName(error)})`);
    }
    const subject = subjectOf(call);
    return subject ? { subject, verification: "V0" } : null;
  };

  const open = (id: string, record: CallRecord): Conversation =>
    options.niadra.conversation({ subject: record.subject, channel: "voice", conversation_id: id, verification: record.verification });

  /** Opens the conversation for a call that has not been seen yet, verifying it once. */
  const start = (call: RetellCall): { bridge: Bridge; conversation: Conversation } | null => {
    const subject = subjectOf(call);
    if (!subject) return null;
    const conversation = options.niadra.conversation({ subject, channel: "voice", conversation_id: call.id });
    const bridge = new Bridge(conversation, options.verify ? () => options.verify?.(call) : undefined, options.agentMemory);
    return { bridge, conversation };
  };

  const signed = async (text: string, headers: HeadersLike): Promise<boolean> =>
    validRetellSignature(text, header(headers, "x-retell-signature"), options.apiKey, now());

  async function inbound(rawBody: string | Uint8Array | ArrayBuffer, headers: HeadersLike): Promise<WebhookResponse> {
    const text = bodyText(rawBody);
    if (!(await signed(text, headers))) return { status: 401, body: { error: "unauthorized" } };
    const body = parseJson(text);
    const data = isRecord(body) && isRecord(body.call_inbound) ? body.call_inbound : null;
    if (!data) return { status: 400, body: { error: "invalid_body" } };
    const call = callOf({ ...data, direction: "inbound" });
    const variables: Record<string, string> = { niadra_context: "", niadra_turn: "" };
    if (options.agentMemory) variables.niadra_agent_memory = "";
    let extra: Record<string, unknown> = {};
    try {
      extra = call && options.inboundFields ? options.inboundFields(call) : {};
    } catch (error) {
      logger.warn(`could not build the inbound fields (${errorName(error)})`);
    }
    const answer = (): WebhookResponse => {
      const own = isRecord(extra.dynamic_variables) ? (extra.dynamic_variables as Record<string, unknown>) : {};
      return { status: 200, body: { call_inbound: { ...extra, dynamic_variables: { ...own, ...variables } } } };
    };
    const started = call ? start(call) : null;
    if (!call || !started) return answer();
    const read = await started.bridge.read(readOptions);
    started.bridge.injected(read.context);
    variables.niadra_context = read.context.text;
    variables.niadra_turn = read.suffix;
    if (options.agentMemory) variables.niadra_agent_memory = read.memory;
    await remember(call.id, { subject: started.conversation.subject, verification: started.conversation.verification, stamp: started.conversation.contextStamp });
    return answer();
  }

  async function webhook(rawBody: string | Uint8Array | ArrayBuffer, headers: HeadersLike): Promise<WebhookResponse> {
    const text = bodyText(rawBody);
    if (!(await signed(text, headers))) return { status: 401, body: { error: "unauthorized" } };
    const body = parseJson(text);
    const call = isRecord(body) ? callOf(body.call) : null;
    if (!isRecord(body) || typeof body.event !== "string" || !call) return { status: 400, body: { error: "invalid_body" } };
    switch (body.event) {
      case "call_started":
        return callStarted(call);
      case "transfer_started":
        await transfer(call);
        return { status: 200, body: {} };
      case "call_ended":
        return callEnded(call);
      default:
        return { status: 200, body: { ignored: true } };
    }
  }

  async function callStarted(call: RetellCall): Promise<WebhookResponse> {
    try {
      if (await store.get(call.id)) return { status: 200, body: {} };
    } catch (error) {
      logger.warn(`could not read the call store (${errorName(error)})`);
    }
    const started = start(call);
    if (started) {
      // Verifies through the context read's path, once, so later reads carry the level.
      await started.bridge.context(readOptions);
      await remember(call.id, { subject: started.conversation.subject, verification: started.conversation.verification, stamp: started.conversation.contextStamp });
    }
    return { status: 200, body: {} };
  }

  async function transfer(call: RetellCall): Promise<void> {
    if (transferred.has(call.id)) return;
    transferred.add(call.id);
    if (transferred.size > 10_000) transferred.clear();
    const record = await recall(call);
    if (record) await new Bridge(open(call.id, record)).handoff("human", "transfer");
  }

  async function callEnded(call: RetellCall): Promise<WebhookResponse> {
    const record = await recall(call);
    if (!record) return { status: 200, body: { recorded: 0 } };
    const bridge = new Bridge(open(call.id, record));
    const started = typeof call.call.start_timestamp === "number" ? call.call.start_timestamp : null;
    const utterances = Array.isArray(call.call.transcript_object) ? (call.call.transcript_object as unknown[]) : [];
    let recorded = 0;
    for (const [index, utterance] of utterances.entries()) {
      if (recordUtterance(bridge, call.id, index, utterance, started, record)) recorded++;
    }
    if (call.call.disconnection_reason === "call_transfer") await transfer(call);
    await bridge.end();
    await options.niadra.flush();
    return { status: 200, body: { recorded } };
  }

  async function tool(rawBody: string | Uint8Array | ArrayBuffer, headers: HeadersLike): Promise<WebhookResponse> {
    const text = bodyText(rawBody);
    if (!(await signed(text, headers))) return { status: 401, body: { error: "unauthorized" } };
    const body = parseJson(text);
    const call = isRecord(body) ? callOf(body.call) : null;
    const name = isRecord(body) && typeof body.name === "string" ? body.name : "";
    if (!isRecord(body) || !call || !name) return { status: 400, body: { error: "invalid_body" } };
    const args: Record<string, unknown> = {};
    if (isRecord(body.args)) Object.assign(args, body.args);
    else for (const [key, value] of Object.entries(body)) if (key !== "name" && key !== "call") args[key] = value;

    if (!OURS.has(name)) {
      if (!options.otherTool) return { status: 200, body: { error: `unknown tool: ${name}` } };
      try {
        return { status: 200, body: (await options.otherTool(name, args, call)) ?? null };
      } catch (error) {
        logger.warn(`a tool outside Niadra failed (${errorName(error)})`);
        return { status: 200, body: { error: "tool failed" } };
      }
    }
    const record = await recall(call);
    const spec = record ? new Bridge(open(call.id, record), undefined, options.agentMemory).tools().find((candidate) => candidate.name === name) : undefined;
    if (!spec) return { status: 200, body: { error: "unavailable", detail: "customer history is unavailable right now" } };
    return { status: 200, body: parseJson(await spec.execute(args)) ?? null };
  }

  function llm(callId: string, config: RetellLlmOptions): RetellLlmSession {
    let bridge: Bridge | null = null;
    let record: CallRecord | null = null;
    let recorded = 0;
    const send = (event: Record<string, unknown>): void => {
      try {
        config.send(event);
      } catch (error) {
        logger.warn(`could not send to Retell (${errorName(error)})`);
      }
    };

    const ensure = async (call: RetellCall | null): Promise<Bridge | null> => {
      if (bridge) return bridge;
      let stored: CallRecord | undefined;
      try {
        stored = await store.get(callId);
      } catch (error) {
        logger.warn(`could not read the call store (${errorName(error)})`);
      }
      if (stored) {
        record = stored;
        bridge = new Bridge(open(callId, stored), undefined, options.agentMemory);
        return bridge;
      }
      // The socket is not signed: its call details never name the customer unless the server said so.
      const started = call && options.trustCallDetails ? start(call) : null;
      if (!started) return null;
      bridge = started.bridge;
      await bridge.context(readOptions);
      record = { subject: started.conversation.subject, verification: started.conversation.verification, stamp: started.conversation.contextStamp };
      await remember(callId, record);
      return bridge;
    };

    async function receive(event: unknown): Promise<RetellTurn | null> {
      try {
        if (!isRecord(event) || typeof event.interaction_type !== "string") return null;
        switch (event.interaction_type) {
          case "ping_pong":
            send({ response_type: "ping_pong", timestamp: event.timestamp });
            return null;
          case "call_details":
            await ensure(callOf(event.call));
            return null;
          case "response_required":
          case "reminder_required":
            return await turnFor(event, event.interaction_type);
          default:
            return null;
        }
      } catch (error) {
        logger.warn(`could not handle a Retell event (${errorName(error)})`);
        return null;
      }
    }

    async function turnFor(event: Record<PropertyKey, unknown>, interactionType: RetellTurn["interactionType"]): Promise<RetellTurn> {
      const responseId = typeof event.response_id === "number" ? event.response_id : 0;
      const transcript = Array.isArray(event.transcript) ? (event.transcript as unknown[]) : [];
      const current = await ensure(null);
      let prefix = "";
      let suffix = "";
      let context = "";
      if (current) {
        for (let index = recorded; index < transcript.length; index++) {
          recordUtterance(current, callId, index, transcript[index], null, record);
        }
        recorded = Math.max(recorded, transcript.length);
        const read = await current.read(readOptions);
        current.injected(read.context);
        ({ prefix, suffix } = read);
        context = read.context.text;
      }
      const messages: RetellMessage[] = [];
      if (config.instructions) messages.push({ role: "system", content: config.instructions });
      if (prefix) messages.push({ role: "system", content: prefix });
      for (const utterance of transcript) {
        if (!isRecord(utterance) || typeof utterance.content !== "string") continue;
        if (utterance.role === "user") messages.push({ role: "user", content: utterance.content });
        else if (utterance.role === "agent") messages.push({ role: "assistant", content: utterance.content });
      }
      if (suffix) {
        const last = messages.map((message) => message.role).lastIndexOf("user");
        const message = messages[last];
        if (message) messages[last] = { role: "user", content: `${message.content}\n\n${suffix}` };
        else messages.push({ role: "user", content: suffix });
      }
      return {
        responseId,
        interactionType,
        messages,
        context,
        suffix,
        respond(content, respondOptions = {}) {
          const response: Record<string, unknown> = {
            response_type: "response",
            response_id: responseId,
            content,
            content_complete: respondOptions.complete ?? true,
          };
          if (respondOptions.endCall) response.end_call = true;
          if (respondOptions.transferNumber) {
            response.transfer_number = respondOptions.transferNumber;
            void transferOnce();
          }
          send(response);
        },
      };
    }

    async function transferOnce(): Promise<void> {
      if (transferred.has(callId)) return;
      transferred.add(callId);
      await bridge?.handoff("human", "transfer");
    }

    return {
      open(greeting) {
        send({ response_type: "config", config: { auto_reconnect: true, call_details: true } });
        if (greeting) send({ response_type: "response", response_id: 0, content: greeting, content_complete: true });
      },
      receive,
      async close() {
        try {
          await options.niadra.flush();
        } catch (error) {
          logger.warn(`could not flush (${errorName(error)})`);
        }
      },
    };
  }

  function toolConfigs(config: { url: string; timeoutMs?: number }): Record<string, unknown>[] {
    const memory = options.agentMemory;
    const definitions = [
      ...TOOL_DEFINITIONS,
      ...(memory ? AGENT_MEMORY_TOOL_DEFINITIONS.slice(0, memory !== true && memory.write ? 2 : 1) : []),
    ];
    return definitions.map(({ function: definition }) => ({
      type: "custom",
      name: definition.name,
      description: definition.description,
      url: config.url,
      method: "POST",
      parameters: definition.parameters,
      speak_during_execution: false,
      speak_after_execution: true,
      timeout_ms: config.timeoutMs ?? 10_000,
    }));
  }

  return { inbound, webhook, tool, llm, toolConfigs };
}

/** Checks `X-Retell-Signature: v=<milliseconds>,d=<hex HMAC-SHA256 of body + milliseconds>` within five minutes. */
export async function validRetellSignature(body: string, signature: string | undefined, apiKey: string, now = Date.now()): Promise<boolean> {
  if (!signature || !apiKey) return false;
  const match = /^v=(\d+),d=([0-9a-f]{64})$/i.exec(signature.trim());
  if (!match) return false;
  const [, stamp = "", digest = ""] = match;
  if (Math.abs(now - Number(stamp)) > SIGNATURE_WINDOW_MS) return false;
  return safeEqual(digest.toLowerCase(), hex(await hmac("SHA-256", apiKey, body + stamp)));
}

/** Records one utterance with the key both the websocket and `call_ended` use. Returns whether it was recorded. */
function recordUtterance(bridge: Bridge, callId: string, index: number, utterance: unknown, started: number | null, record: CallRecord | null): boolean {
  if (!isRecord(utterance) || typeof utterance.content !== "string" || !utterance.content.trim()) return false;
  const words = Array.isArray(utterance.words) ? (utterance.words as unknown[]) : [];
  const first = isRecord(words[0]) && typeof words[0].start === "number" ? words[0].start : null;
  const at = started !== null && first !== null ? new Date(started + first * 1000) : undefined;
  const base = { idempotency_key: `retell:${callId}:${String(index)}`, ...(at ? { occurred_at: at } : {}) };
  if (utterance.role === "user") {
    bridge.customer(utterance.content, base);
    return true;
  }
  if (utterance.role === "agent") {
    bridge.agent(utterance.content, record?.stamp ? { ...base, context_stamp: record.stamp } : base);
    return true;
  }
  return false;
}

function callOf(value: unknown): RetellCall | null {
  if (!isRecord(value) || typeof value.call_id !== "string" || !value.call_id) return null;
  const text = (key: string): string | undefined => {
    const field = value[key];
    return typeof field === "string" && field ? field : undefined;
  };
  return {
    id: value.call_id,
    fromNumber: text("from_number"),
    toNumber: text("to_number"),
    direction: text("direction"),
    agentId: text("agent_id"),
    call: value,
  };
}
