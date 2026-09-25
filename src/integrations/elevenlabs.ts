/**
 * Niadra for the ElevenLabs Agents Platform, on the server side: a phone call reaches ElevenLabs,
 * ElevenLabs calls your webhooks, and these handlers answer them. No ElevenLabs package is needed.
 *
 * - `initiation`: the "conversation initiation client data" webhook. Opens the conversation by
 *   ElevenLabs' `conversation_id`, records what the call proved, reads the context and answers it
 *   as dynamic variables: put `{{niadra_context}}` in the agent's system prompt (and
 *   `{{niadra_turn}}` where the live turns from other channels should go).
 * - `tool`: server tools (`type: "webhook"`) for the navigation kit. `toolConfigs()` writes their
 *   configuration: the conversation id and the caller come from ElevenLabs' system variables,
 *   never from the model, so no tool parameter names a customer.
 * - `postCall`: the `post_call_transcription` webhook. Checks `ElevenLabs-Signature`, records every
 *   turn of the transcript, the transfers (`transfer_to_agent`, `transfer_to_number`) as handoffs,
 *   and ends the conversation.
 *
 * Each handler takes the body and the headers and resolves to `{ status, body }`; the example in
 * `examples/elevenlabs-hono.ts` mounts them on Hono. They only use web APIs, so they run on Node,
 * Deno, Bun, Cloudflare Workers and the Vercel Edge Runtime.
 */

import type { Niadra } from "../client.js";
import type { Conversation } from "../conversation.js";
import { TOOL_DEFINITIONS } from "../tools.js";
import type { Handle } from "../types/common.js";
import type { ModelUsage } from "../types/events.js";
import { providerOf } from "../usage.js";
import { Bridge, count, errorName, isRecord, phoneHandle } from "./shared.js";
import type { Proof } from "./shared.js";
import { bodyText, header, hmac, hex, memoryCallStore, parseJson, safeEqual } from "./webhook.js";
import type { CallRecord, CallStore, HeadersLike, WebhookResponse } from "./webhook.js";

export { attestationProof } from "./shared.js";
export type { Proof } from "./shared.js";
export { memoryCallStore } from "./webhook.js";
export type { CallRecord, CallStore, HeadersLike, WebhookResponse } from "./webhook.js";

/** The fields ElevenLabs sends to the initiation webhook, and the system variables it passes to tools. */
export interface ElevenLabsCall {
  conversationId: string;
  callerId?: string | undefined;
  calledNumber?: string | undefined;
  agentId?: string | undefined;
  callSid?: string | undefined;
}

export interface ElevenLabsOptions {
  niadra: Niadra;
  /**
   * A secret only you and ElevenLabs know, sent by ElevenLabs in `secretHeader` on the initiation
   * webhook and on every tool call (store it as a workspace secret and reference it in the
   * request headers). Required: these endpoints return customer context.
   */
  secret: string;
  /** Defaults to `x-niadra-secret`. */
  secretHeader?: string;
  /** The post-call webhook's HMAC secret, from the ElevenLabs webhook settings. */
  webhookSecret?: string;
  /** Who is calling. Defaults to the caller id as an E.164 phone number. */
  subject?: (call: ElevenLabsCall) => Handle | null | undefined;
  /** What the call proved, such as the carrier's attestation you read from your telephony provider. */
  verify?: (call: ElevenLabsCall) => Proof | null | undefined | PromiseLike<Proof | null | undefined>;
  /** Keeps the caller and level between the webhooks of one call. Defaults to an in-memory store. */
  store?: CallStore;
  /** More dynamic variables for the agent, next to `niadra_context` and `niadra_turn`. */
  dynamicVariables?: (call: ElevenLabsCall) => Record<string, string | number | boolean>;
  /** Time budget of the context read in the initiation webhook, in milliseconds. Defaults to the voice budget. */
  contextTimeout?: number;
  /** The clock for the signature's 30-minute window, in milliseconds. */
  now?: () => number;
}

export interface ElevenLabsToolConfigOptions {
  /** Where your `tool` handler is served, such as `https://api.acme.com/elevenlabs/tools`. */
  url: string;
  /** The id of the ElevenLabs workspace secret that holds `secret`. */
  secretId: string;
  /** Defaults to `x-niadra-secret`. */
  secretHeader?: string;
}

export interface ElevenLabsHandlers {
  initiation(body: unknown, headers: HeadersLike): Promise<WebhookResponse>;
  tool(body: unknown, headers: HeadersLike): Promise<WebhookResponse>;
  /** Takes the raw body: the signature is computed over the exact bytes ElevenLabs sent. */
  postCall(rawBody: string | Uint8Array | ArrayBuffer, headers: HeadersLike): Promise<WebhookResponse>;
  /** The server tool configurations for the ElevenLabs API (`tool_config`) or its dashboard. */
  toolConfigs(options: ElevenLabsToolConfigOptions): Record<string, unknown>[];
}

const TOOL_FIELD = "niadra_tool";
const CONVERSATION_FIELD = "niadra_conversation_id";
const CALLER_FIELD = "niadra_caller_id";
const SIGNATURE_WINDOW_MS = 30 * 60 * 1000;
const TRANSFERS: Record<string, "agent" | "human"> = { transfer_to_agent: "agent", transfer_to_number: "human" };

/** The webhook handlers for one ElevenLabs agent. */
export function elevenLabs(options: ElevenLabsOptions): ElevenLabsHandlers {
  const store = options.store ?? memoryCallStore();
  const secretHeader = options.secretHeader ?? "x-niadra-secret";
  const now = options.now ?? Date.now;
  const logger = options.niadra.logger;

  const authorized = (headers: HeadersLike): boolean => {
    const given = header(headers, secretHeader);
    return Boolean(options.secret) && given !== undefined && safeEqual(given, options.secret);
  };

  const subjectOf = (call: ElevenLabsCall): Handle | null => {
    try {
      return (options.subject ? options.subject(call) : phoneHandle(call.callerId)) ?? null;
    } catch {
      return null;
    }
  };

  const open = (conversationId: string, record: CallRecord): Conversation =>
    options.niadra.conversation({
      subject: record.subject,
      channel: "voice",
      conversation_id: conversationId,
      verification: record.verification,
    });

  /** The call's record from the store, or rebuilt from what this webhook carries (without verifying again). */
  const recall = async (call: ElevenLabsCall): Promise<CallRecord | null> => {
    try {
      const stored = await store.get(call.conversationId);
      if (stored) return stored;
    } catch (error) {
      logger.warn(`could not read the call store (${errorName(error)})`);
    }
    const subject = subjectOf(call);
    return subject ? { subject, verification: "V0" } : null;
  };

  async function initiation(body: unknown, headers: HeadersLike): Promise<WebhookResponse> {
    if (!authorized(headers)) return { status: 401, body: { error: "unauthorized" } };
    const call = initiationCall(body);
    const variables: Record<string, string | number | boolean> = { niadra_context: "", niadra_turn: "" };
    try {
      Object.assign(variables, call && options.dynamicVariables ? options.dynamicVariables(call) : {});
    } catch (error) {
      logger.warn(`could not build the dynamic variables (${errorName(error)})`);
    }
    const answer = (): WebhookResponse => ({
      status: 200,
      body: { type: "conversation_initiation_client_data", dynamic_variables: variables },
    });
    const subject = call ? subjectOf(call) : null;
    if (!call || !subject) return answer();

    const conversation = options.niadra.conversation({ subject, channel: "voice", conversation_id: call.conversationId });
    const bridge = new Bridge(conversation, options.verify ? () => options.verify?.(call) : undefined);
    const context = await bridge.context(options.contextTimeout ? { timeout: options.contextTimeout } : {});
    bridge.injected(context);
    variables.niadra_context = context.text;
    variables.niadra_turn = context.suffix;
    try {
      await store.set(call.conversationId, {
        subject,
        verification: conversation.verification,
        stamp: conversation.contextStamp,
      });
    } catch (error) {
      logger.warn(`could not write the call store (${errorName(error)})`);
    }
    return answer();
  }

  async function tool(body: unknown, headers: HeadersLike): Promise<WebhookResponse> {
    if (!authorized(headers)) return { status: 401, body: { error: "unauthorized" } };
    if (!isRecord(body)) return { status: 400, body: { error: "invalid_body" } };
    const name = str(body[TOOL_FIELD]);
    const conversationId = str(body[CONVERSATION_FIELD]);
    if (!name || !conversationId) return { status: 400, body: { error: "invalid_body" } };
    const record = await recall({ conversationId, callerId: str(body[CALLER_FIELD]) });
    if (!record) return { status: 200, body: { error: "unavailable", detail: "customer history is unavailable right now" } };

    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key !== TOOL_FIELD && key !== CONVERSATION_FIELD && key !== CALLER_FIELD) args[key] = value;
    }
    const specs = new Bridge(open(conversationId, record)).tools();
    const spec = specs.find((candidate) => candidate.name === name);
    if (!spec) return { status: 404, body: { error: "unknown_tool" } };
    return { status: 200, body: parseJson(await spec.execute(args)) ?? null };
  }

  async function postCall(rawBody: string | Uint8Array | ArrayBuffer, headers: HeadersLike): Promise<WebhookResponse> {
    const text = bodyText(rawBody);
    if (!options.webhookSecret) {
      logger.warn("the ElevenLabs post-call webhook needs `webhookSecret`");
      return { status: 401, body: { error: "unauthorized" } };
    }
    if (!(await validSignature(text, header(headers, "elevenlabs-signature"), options.webhookSecret, now()))) {
      return { status: 401, body: { error: "invalid_signature" } };
    }
    const event = parseJson(text);
    if (!isRecord(event) || event.type !== "post_call_transcription" || !isRecord(event.data)) {
      return { status: 200, body: { ignored: true } };
    }
    const data = event.data;
    const conversationId = str(data.conversation_id);
    if (!conversationId) return { status: 400, body: { error: "invalid_body" } };
    const record = await recall({ conversationId, callerId: callerOf(data) });
    if (!record) return { status: 200, body: { recorded: 0 } };

    const bridge = new Bridge(open(conversationId, record));
    const started = count(isRecord(data.metadata) ? data.metadata.start_time_unix_secs : undefined);
    const transcript = Array.isArray(data.transcript) ? (data.transcript as unknown[]) : [];
    let recorded = 0;
    for (const [index, turn] of transcript.entries()) {
      if (!isRecord(turn)) continue;
      const message = str(turn.message);
      const at = typeof turn.time_in_call_secs === "number" && started !== null ? new Date((started + turn.time_in_call_secs) * 1000) : undefined;
      const base = { idempotency_key: `elevenlabs:${conversationId}:${index}`, ...(at ? { occurred_at: at } : {}) };
      if (message && turn.role === "user") {
        bridge.customer(message, base);
        recorded++;
      } else if (message && turn.role === "agent") {
        const usage = usageOf(turn.llm_usage);
        bridge.agent(message, { ...base, ...(usage ? { usage } : {}), ...(record.stamp ? { context_stamp: record.stamp } : {}) });
        recorded++;
      }
      for (const result of Array.isArray(turn.tool_results) ? (turn.tool_results as unknown[]) : []) {
        if (!isRecord(result) || result.is_error === true) continue;
        const target = TRANSFERS[str(result.tool_name) ?? ""];
        if (target) await bridge.handoff(target, transferReason(result));
      }
    }
    await bridge.end();
    await options.niadra.flush();
    return { status: 200, body: { recorded } };
  }

  function toolConfigs(config: ElevenLabsToolConfigOptions): Record<string, unknown>[] {
    const headerName = config.secretHeader ?? secretHeader;
    return TOOL_DEFINITIONS.map(({ function: definition }) => {
      const parameters = definition.parameters as { properties?: Record<string, unknown>; required?: string[] };
      const properties: Record<string, unknown> = {};
      for (const [key, schema] of Object.entries(parameters.properties ?? {})) properties[key] = literal(schema);
      properties[TOOL_FIELD] = { type: "string", constant_value: definition.name };
      properties[CONVERSATION_FIELD] = { type: "string", dynamic_variable: "system__conversation_id" };
      properties[CALLER_FIELD] = { type: "string", dynamic_variable: "system__caller_id" };
      return {
        type: "webhook",
        name: definition.name,
        description: definition.description,
        api_schema: {
          url: config.url,
          method: "POST",
          request_headers: { [headerName]: { secret_id: config.secretId } },
          request_body_schema: {
            type: "object",
            properties,
            required: [...(parameters.required ?? []), TOOL_FIELD, CONVERSATION_FIELD, CALLER_FIELD],
          },
        },
      };
    });
  }

  return { initiation, tool, postCall, toolConfigs };
}

/** Checks `ElevenLabs-Signature: t=<seconds>,v0=<hex HMAC-SHA256 of "<t>.<body>">` within 30 minutes. */
export async function validSignature(body: string, signature: string | undefined, secret: string, now = Date.now()): Promise<boolean> {
  if (!signature || !secret) return false;
  const parts = signature.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const given = parts.find((part) => part.startsWith("v0="));
  if (!timestamp || !given || !/^\d+$/.test(timestamp)) return false;
  const at = Number(timestamp) * 1000;
  if (at < now - SIGNATURE_WINDOW_MS || at > now + SIGNATURE_WINDOW_MS) return false;
  const expected = `v0=${hex(await hmac("SHA-256", secret, `${timestamp}.${body}`))}`;
  return safeEqual(given, expected);
}

function initiationCall(body: unknown): ElevenLabsCall | null {
  if (!isRecord(body)) return null;
  const conversationId = str(body.conversation_id);
  if (!conversationId) return null;
  return {
    conversationId,
    callerId: str(body.caller_id),
    calledNumber: str(body.called_number),
    agentId: str(body.agent_id),
    callSid: str(body.call_sid),
  };
}

function callerOf(data: Record<PropertyKey, unknown>): string | undefined {
  const phone = isRecord(data.metadata) && isRecord(data.metadata.phone_call) ? data.metadata.phone_call : null;
  const external = phone ? str(phone.external_number) : undefined;
  if (external) return external;
  const client = isRecord(data.conversation_initiation_client_data) ? data.conversation_initiation_client_data : null;
  const variables = client && isRecord(client.dynamic_variables) ? client.dynamic_variables : null;
  return variables ? str(variables.system__caller_id) : undefined;
}

function transferReason(result: Record<PropertyKey, unknown>): string | undefined {
  const detail = isRecord(result.result) ? result.result : null;
  if (!detail) return undefined;
  return str(detail.reason) ?? str(detail.condition) ?? undefined;
}

/** ElevenLabs reports the tokens of each model the turn used; the first model is the agent's. */
function usageOf(value: unknown): ModelUsage | null {
  if (!isRecord(value) || !isRecord(value.model_usage)) return null;
  for (const [model, usage] of Object.entries(value.model_usage)) {
    if (!isRecord(usage)) continue;
    const tokens = (key: string): number => {
      const category = usage[key];
      return isRecord(category) ? (count(category.tokens) ?? 0) : 0;
    };
    const input = tokens("input");
    const read = tokens("input_cache_read");
    const written = tokens("input_cache_write");
    if (input + read + written === 0) continue;
    return { provider: providerOf(model), model, prompt_tokens: input + read + written, cached_tokens: read, cache_write_tokens: written };
  }
  return null;
}

/** A JSON Schema property in the subset ElevenLabs accepts, with the same description. */
function literal(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return { type: "string" };
  const out: Record<string, unknown> = { type: schema.type };
  if (typeof schema.description === "string") out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (schema.type === "array") {
    const items = isRecord(schema.items) ? schema.items : {};
    out.items = { type: items.type ?? "string", description: schema.description, ...(Array.isArray(items.enum) ? { enum: items.enum } : {}) };
  }
  return out;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
