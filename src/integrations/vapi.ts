/**
 * Niadra for Vapi, on your server URL. One handler takes every server message Vapi sends
 * (`{ message: { type, call, ... } }`) and answers the ones that matter:
 *
 * - `assistant-request`: opens the conversation by the call id, records what the call proved,
 *   reads the voice context and answers with your assistant, the context in its variables
 *   (`{{niadra_context}}`, `{{niadra_turn}}`) and, for a transient assistant, as a system message
 *   right after its own.
 * - `tool-calls`: runs the navigation kit (define the tools in Vapi with `vapiTools()`); the
 *   customer comes from the call, never from the model's arguments.
 * - `transfer-destination-request` and `transfer-update`: records the transfer to a person.
 * - `end-of-call-report`: records every turn of the call and ends the conversation.
 *
 * Requests are checked against the server secret (`x-vapi-secret`, or `Authorization: Bearer`).
 * Only web APIs: runs on Node, Deno, Bun, Cloudflare Workers and the Vercel Edge Runtime.
 */

import type { Niadra } from "../client.js";
import type { Conversation } from "../conversation.js";
import { TOOL_DEFINITIONS, TOOL_NAMES } from "../tools.js";
import type { Handle } from "../types/common.js";
import { Bridge, errorName, isRecord, phoneHandle } from "./shared.js";
import type { Proof } from "./shared.js";
import { header, memoryCallStore, safeEqual } from "./webhook.js";
import type { CallRecord, CallStore, HeadersLike, WebhookResponse } from "./webhook.js";

export { attestationProof } from "./shared.js";
export type { Proof } from "./shared.js";
export { memoryCallStore } from "./webhook.js";
export type { CallRecord, CallStore, HeadersLike, WebhookResponse } from "./webhook.js";

/** What the handlers read from a Vapi server message. */
export interface VapiCall {
  /** Vapi's call id, used as the `conversation_id`. */
  id: string;
  /** The customer's number, when Vapi reports one. */
  customerNumber?: string | undefined;
  /** The whole server message, for anything else you need. */
  message: Record<string, unknown>;
}

/** The context of the call, for building the assistant. */
export interface VapiContext {
  /** The pack, for the system prompt. Empty when there is nothing to inject. */
  context: string;
  /** Deltas and live turns from other channels. */
  turn: string;
}

type Assistant = Record<string, unknown>;

export interface VapiOptions {
  niadra: Niadra;
  /** The secret configured on the server URL (sent in `x-vapi-secret`) or its bearer token. Required. */
  secret: string;
  /**
   * What `assistant-request` answers with: a saved assistant's id (the context goes in its
   * variables), a transient assistant (the context also goes into `model.messages`), or a
   * function of the call and its context that returns either, or a full response object.
   */
  assistant?: string | Assistant | ((call: VapiCall, context: VapiContext) => Assistant | string | PromiseLike<Assistant | string>);
  /** Who is calling. Defaults to the customer's number as E.164. */
  subject?: (call: VapiCall) => Handle | null | undefined;
  /** What the call proved, such as the carrier's attestation. */
  verify?: (call: VapiCall) => Proof | null | undefined | PromiseLike<Proof | null | undefined>;
  /** The answer to `transfer-destination-request`, such as `{ destination: { type: "number", number } }`. */
  transfer?: (call: VapiCall) => Record<string, unknown> | PromiseLike<Record<string, unknown>>;
  /** Runs tool calls that are not Niadra's, so one server URL can serve all of them. */
  otherTool?: (name: string, args: unknown, call: VapiCall) => string | PromiseLike<string>;
  /** Keeps the caller and level between the messages of one call. Defaults to an in-memory store. */
  store?: CallStore;
  /** Time budget of the context read in `assistant-request`, in milliseconds. Defaults to the voice budget. */
  contextTimeout?: number;
}

const OURS = new Set<string>(Object.values(TOOL_NAMES));
const AGENT_ROLES = new Set(["bot", "assistant"]);

/** The navigation kit as Vapi `function` tools, pointing at your server URL, with the SDK's descriptions. */
export function vapiTools(server: { url: string; secret?: string }): Record<string, unknown>[] {
  return TOOL_DEFINITIONS.map(({ function: definition }) => ({
    type: "function",
    function: { name: definition.name, description: definition.description, parameters: definition.parameters },
    server: server.secret ? { url: server.url, secret: server.secret } : { url: server.url },
  }));
}

/** The handler for your Vapi server URL. */
export function vapi(options: VapiOptions): (body: unknown, headers: HeadersLike) => Promise<WebhookResponse> {
  const store = options.store ?? memoryCallStore();
  const logger = options.niadra.logger;
  const transferred = new Set<string>();

  const authorized = (headers: HeadersLike): boolean => {
    if (!options.secret) return false;
    const given = header(headers, "x-vapi-secret") ?? header(headers, "authorization")?.replace(/^Bearer\s+/i, "");
    return given !== undefined && safeEqual(given, options.secret);
  };

  const subjectOf = (call: VapiCall): Handle | null => {
    try {
      return (options.subject ? options.subject(call) : phoneHandle(call.customerNumber)) ?? null;
    } catch {
      return null;
    }
  };

  const recall = async (call: VapiCall): Promise<CallRecord | null> => {
    try {
      const stored = await store.get(call.id);
      if (stored) return stored;
    } catch (error) {
      logger.warn(`could not read the call store (${errorName(error)})`);
    }
    const subject = subjectOf(call);
    return subject ? { subject, verification: "V0" } : null;
  };

  const open = (call: VapiCall, record: CallRecord): Conversation =>
    options.niadra.conversation({ subject: record.subject, channel: "voice", conversation_id: call.id, verification: record.verification });

  async function assistantRequest(call: VapiCall): Promise<WebhookResponse> {
    const context: VapiContext = { context: "", turn: "" };
    const subject = subjectOf(call);
    if (subject) {
      const conversation = options.niadra.conversation({ subject, channel: "voice", conversation_id: call.id });
      const bridge = new Bridge(conversation, options.verify ? () => options.verify?.(call) : undefined);
      const result = await bridge.context(options.contextTimeout ? { timeout: options.contextTimeout } : {});
      bridge.injected(result);
      context.context = result.text;
      context.turn = result.suffix;
      try {
        await store.set(call.id, { subject, verification: conversation.verification, stamp: conversation.contextStamp });
      } catch (error) {
        logger.warn(`could not write the call store (${errorName(error)})`);
      }
    }
    let chosen: Assistant | string | undefined;
    try {
      chosen = typeof options.assistant === "function" ? await options.assistant(call, context) : options.assistant;
    } catch (error) {
      logger.warn(`could not build the assistant (${errorName(error)})`);
      return { status: 200, body: { error: "The assistant is not available right now." } };
    }
    return { status: 200, body: assistantResponse(chosen, context) };
  }

  async function toolCalls(call: VapiCall): Promise<WebhookResponse> {
    const list = Array.isArray(call.message.toolCallList) ? (call.message.toolCallList as unknown[]) : [];
    const record = await recall(call);
    const specs = record ? new Bridge(open(call, record)).tools() : [];
    const results: Record<string, unknown>[] = [];
    for (const item of list) {
      if (!isRecord(item) || !isRecord(item.function)) continue;
      const id = typeof item.id === "string" ? item.id : "";
      const name = typeof item.function.name === "string" ? item.function.name : "";
      const args = item.function.arguments as string | Record<string, unknown> | undefined;
      let result: string;
      if (OURS.has(name)) {
        const spec = specs.find((candidate) => candidate.name === name);
        result = spec
          ? await spec.execute(args ?? {})
          : JSON.stringify({ error: "unavailable", detail: "customer history is unavailable right now" });
      } else if (options.otherTool) {
        try {
          result = await options.otherTool(name, args, call);
        } catch (error) {
          logger.warn(`a tool outside Niadra failed (${errorName(error)})`);
          results.push({ name, toolCallId: id, error: "tool failed" });
          continue;
        }
      } else {
        results.push({ name, toolCallId: id, error: `unknown tool: ${name}` });
        continue;
      }
      results.push({ name, toolCallId: id, result });
    }
    return { status: 200, body: { results } };
  }

  async function transfer(call: VapiCall, answer: boolean): Promise<WebhookResponse> {
    if (!transferred.has(call.id)) {
      transferred.add(call.id);
      if (transferred.size > 10_000) transferred.clear();
      const record = await recall(call);
      if (record) await new Bridge(open(call, record)).handoff("human", "transfer");
    }
    if (!answer) return { status: 200, body: {} };
    try {
      return { status: 200, body: options.transfer ? await options.transfer(call) : {} };
    } catch (error) {
      logger.warn(`could not choose the transfer destination (${errorName(error)})`);
      return { status: 200, body: { error: "The transfer is not available right now." } };
    }
  }

  async function endOfCall(call: VapiCall): Promise<WebhookResponse> {
    const record = await recall(call);
    if (!record) return { status: 200, body: { recorded: 0 } };
    const bridge = new Bridge(open(call, record));
    const artifact = isRecord(call.message.artifact) ? call.message.artifact : {};
    const messages = Array.isArray(artifact.messages) ? (artifact.messages as unknown[]) : [];
    let recorded = 0;
    for (const [index, message] of messages.entries()) {
      if (!isRecord(message) || typeof message.message !== "string" || !message.message.trim()) continue;
      const role = typeof message.role === "string" ? message.role : "";
      const at = typeof message.time === "number" ? new Date(message.time) : undefined;
      const base = { idempotency_key: `vapi:${call.id}:${index}`, ...(at ? { occurred_at: at } : {}) };
      if (role === "user") {
        bridge.customer(message.message, base);
        recorded++;
      } else if (AGENT_ROLES.has(role)) {
        bridge.agent(message.message, record.stamp ? { ...base, context_stamp: record.stamp } : base);
        recorded++;
      }
    }
    await bridge.end();
    await options.niadra.flush();
    return { status: 200, body: { recorded } };
  }

  return async (body, headers) => {
    if (!authorized(headers)) return { status: 401, body: { error: "unauthorized" } };
    const call = callOf(body);
    if (!call) return { status: 400, body: { error: "invalid_body" } };
    switch (call.message.type) {
      case "assistant-request":
        return assistantRequest(call);
      case "tool-calls":
        return toolCalls(call);
      case "transfer-destination-request":
        return transfer(call, true);
      case "transfer-update":
        return transfer(call, false);
      case "end-of-call-report":
        return endOfCall(call);
      default:
        return { status: 200, body: {} };
    }
  };
}

function callOf(body: unknown): VapiCall | null {
  const message = isRecord(body) && isRecord(body.message) ? body.message : null;
  if (!message || typeof message.type !== "string") return null;
  const call = isRecord(message.call) ? message.call : {};
  const id = typeof call.id === "string" ? call.id : undefined;
  if (!id) return null;
  const customer = isRecord(call.customer) ? call.customer : isRecord(message.customer) ? message.customer : {};
  return { id, customerNumber: typeof customer.number === "string" ? customer.number : undefined, message };
}

function assistantResponse(chosen: Assistant | string | undefined, context: VapiContext): Record<string, unknown> {
  const variableValues = { niadra_context: context.context, niadra_turn: context.turn };
  if (typeof chosen === "string") return { assistantId: chosen, assistantOverrides: { variableValues } };
  if (!chosen) return { assistantOverrides: { variableValues } };
  // A full response, such as `{ assistantId, assistantOverrides }` or `{ squadId }`, gets the variables merged in.
  if (!("model" in chosen) && ("assistantId" in chosen || "squadId" in chosen || "assistant" in chosen)) {
    const overrides = isRecord(chosen.assistantOverrides) ? chosen.assistantOverrides : {};
    const values = isRecord(overrides.variableValues) ? overrides.variableValues : {};
    return { ...chosen, assistantOverrides: { ...overrides, variableValues: { ...values, ...variableValues } } };
  }
  const model = isRecord(chosen.model) ? chosen.model : null;
  const messages = model && Array.isArray(model.messages) ? [...(model.messages as unknown[])] : [];
  if (model && context.context) {
    let position = 0;
    while (position < messages.length && isRecord(messages[position]) && (messages[position] as Assistant).role === "system") position++;
    messages.splice(position, 0, { role: "system", content: context.context });
  }
  const assistant = model ? { ...chosen, model: { ...model, messages } } : chosen;
  return { assistant, assistantOverrides: { variableValues } };
}
