// The node's layout (resource and operation options, execution through
// httpRequestWithAuthentication, continueOnFail) follows Mem0's n8n node, MIT License,
// Copyright (c) 2023-2026 Taranjeet Singh; see NOTICE. The operations are Niadra's.
import { randomUUID } from "node:crypto";
import type {
  IDataObject,
  IExecuteFunctions,
  IHttpRequestMethods,
  INodeExecutionData,
  INodeProperties,
  INodeType,
  INodeTypeDescription,
  JsonObject,
} from "n8n-workflow";
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from "n8n-workflow";

type Operation = "getContext" | "trackTurn" | "searchHistory" | "verify" | "handoff" | "endConversation";

const ALL: Operation[] = ["getContext", "trackTurn", "searchHistory", "verify", "handoff", "endConversation"];
const WITH_SUBJECT: Operation[] = ["getContext", "trackTurn", "searchHistory", "verify"];
const WITH_LEVEL: Operation[] = ["getContext", "searchHistory"];

const show = (operation: Operation[]) => ({ displayOptions: { show: { resource: ["conversation"], operation } } });

const subject: INodeProperties[] = [
  {
    displayName: "Customer Handle Type",
    name: "handleType",
    type: "options",
    default: "phone_e164",
    options: [
      { name: "App User ID", value: "app_user_id" },
      { name: "E-Mail", value: "email" },
      { name: "Phone (E.164)", value: "phone_e164" },
      { name: "System ID (CRM, ERP)", value: "system_id" },
      { name: "WhatsApp ID (wa_id)", value: "wa_id" },
    ],
    description: "How the customer is identified. Bind it to your trigger's data, never to a value the model writes.",
    ...show(WITH_SUBJECT),
  },
  {
    displayName: "Customer Handle",
    name: "handleValue",
    type: "string",
    default: "",
    required: true,
    placeholder: "+5511987654321",
    ...show(WITH_SUBJECT),
  },
  {
    displayName: "System",
    name: "handleScope",
    type: "string",
    default: "",
    placeholder: "crm",
    description: "The system a System ID belongs to",
    displayOptions: { show: { resource: ["conversation"], operation: WITH_SUBJECT, handleType: ["system_id"] } },
  },
];

const properties: INodeProperties[] = [
  {
    displayName: "Resource",
    name: "resource",
    type: "options",
    noDataExpression: true,
    options: [{ name: "Conversation", value: "conversation" }],
    default: "conversation",
  },
  {
    displayName: "Operation",
    name: "operation",
    type: "options",
    noDataExpression: true,
    displayOptions: { show: { resource: ["conversation"] } },
    options: [
      { name: "End", value: "endConversation", action: "End a conversation", description: "Record that the conversation ended" },
      { name: "Get Context", value: "getContext", action: "Get the customer context", description: "What the company knows about the customer, for the agent's prompt" },
      { name: "Handoff", value: "handoff", action: "Record a handoff", description: "Record a transfer to a person or to another agent" },
      { name: "Search History", value: "searchHistory", action: "Search the customer history", description: "Search past conversations, promises, actions and business objects" },
      { name: "Track Turn", value: "trackTurn", action: "Record a turn", description: "Record what the customer or the agent said" },
      { name: "Verify", value: "verify", action: "Record a verification", description: "Record that the customer proved who they are" },
    ],
    default: "getContext",
  },
  ...subject,
  {
    displayName: "Conversation ID",
    name: "conversationId",
    type: "string",
    default: "",
    required: true,
    description: "Your id for the thread or the call, the same in every step of the conversation",
    ...show(ALL),
  },
  {
    displayName: "Channel",
    name: "channel",
    type: "string",
    default: "whatsapp",
    description: "Where the conversation happens, such as whatsapp, voice, email or web_chat",
    ...show(["getContext", "trackTurn"]),
  },
  {
    displayName: "View",
    name: "view",
    type: "options",
    default: "chat",
    options: [
      { name: "Brief", value: "brief" },
      { name: "Chat", value: "chat" },
      { name: "Full", value: "full" },
      { name: "Voice", value: "voice" },
    ],
    ...show(["getContext"]),
  },
  {
    displayName: "Verification Level",
    name: "verification",
    type: "options",
    default: "V0",
    options: ["V0", "V1", "V2", "V3", "V4"].map((level) => ({ name: level, value: level })),
    description: "What the customer has proven in this conversation",
    ...show(WITH_LEVEL),
  },
  {
    displayName: "Speaker",
    name: "speaker",
    type: "options",
    default: "customer",
    options: [
      { name: "AI Agent", value: "ai_agent" },
      { name: "Customer", value: "customer" },
      { name: "Human Agent", value: "human_agent" },
    ],
    ...show(["trackTurn"]),
  },
  {
    displayName: "Text",
    name: "text",
    type: "string",
    typeOptions: { rows: 3 },
    default: "",
    required: true,
    ...show(["trackTurn"]),
  },
  {
    displayName: "Message ID",
    name: "messageId",
    type: "string",
    default: "",
    description: "The provider's message id, so a retried step is recorded once",
    ...show(["trackTurn"]),
  },
  {
    displayName: "Query",
    name: "query",
    type: "string",
    default: "",
    required: true,
    description: "What to look for, in the customer's words",
    ...show(["searchHistory"]),
  },
  {
    displayName: "When",
    name: "when",
    type: "string",
    default: "",
    placeholder: "last week",
    description: "The period in the customer's own words, in Portuguese, English or Spanish",
    ...show(["searchHistory"]),
  },
  {
    displayName: "Method",
    name: "method",
    type: "options",
    default: "otp_whatsapp",
    options: [
      { name: "Human Agent", value: "human_agent" },
      { name: "Knowledge-Based Questions", value: "kba" },
      { name: "Login", value: "login" },
      { name: "Network Attestation (STIR/SHAKEN)", value: "network_attestation" },
      { name: "OTP by SMS", value: "otp_sms" },
      { name: "OTP by WhatsApp", value: "otp_whatsapp" },
    ],
    ...show(["verify"]),
  },
  {
    displayName: "Level Proven",
    name: "level",
    type: "options",
    default: "V2",
    options: ["V1", "V2", "V3", "V4"].map((level) => ({ name: level, value: level })),
    ...show(["verify"]),
  },
  {
    displayName: "Target",
    name: "target",
    type: "options",
    default: "human",
    options: [
      { name: "Agent", value: "agent" },
      { name: "Human", value: "human" },
    ],
    ...show(["handoff"]),
  },
  {
    displayName: "Reason",
    name: "reason",
    type: "string",
    default: "",
    ...show(["handoff"]),
  },
  {
    displayName: "Fail Open",
    name: "failOpen",
    type: "boolean",
    default: true,
    description: "Whether a Niadra error returns an empty result with the error instead of stopping the workflow, so the agent keeps working without memory",
    ...show(ALL),
  },
];

export class Niadra implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Niadra",
    name: "niadra",
    icon: { light: "file:niadra.svg", dark: "file:niadra.svg" },
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: "The shared customer memory for every AI agent: context before the model call, turns, history search, verification and handoffs",
    defaults: { name: "Niadra" },
    usableAsTool: true,
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "niadraApi", required: true }],
    properties,
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const credentials = await this.getCredentials("niadraApi");
    const baseURL = baseUrlOf(String(credentials.apiKey ?? ""), String(credentials.baseUrl ?? ""));
    const output: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const operation = this.getNodeParameter("operation", i) as Operation;
      const failOpen = this.getNodeParameter("failOpen", i, true) as boolean;
      try {
        if (!baseURL) throw new NodeOperationError(this.getNode(), "The API key does not name a space; set the Base URL", { itemIndex: i });
        const request = (method: IHttpRequestMethods, url: string, body: IDataObject) =>
          this.helpers.httpRequestWithAuthentication.call(this, "niadraApi", { method, baseURL, url, body, json: true }) as Promise<IDataObject>;
        const json = await run.call(this, operation, i, request);
        output.push({ json, pairedItem: { item: i } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (failOpen || this.continueOnFail()) {
          output.push({ json: { ...emptyResult(operation), error: message }, pairedItem: { item: i } });
          continue;
        }
        if (error instanceof NodeOperationError || error instanceof NodeApiError) throw error;
        throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
      }
    }
    return [output];
  }
}

type Request = (method: IHttpRequestMethods, url: string, body: IDataObject) => Promise<IDataObject>;

async function run(this: IExecuteFunctions, operation: Operation, i: number, request: Request): Promise<IDataObject> {
  const parameter = (name: string, fallback: unknown = "") => this.getNodeParameter(name, i, fallback) as string;
  const conversationId = parameter("conversationId");
  const now = new Date().toISOString();
  const handle = (): IDataObject => {
    const type = parameter("handleType", "phone_e164");
    const value = parameter("handleValue").trim();
    if (!value) throw new NodeOperationError(this.getNode(), "The customer handle is empty", { itemIndex: i });
    const scope = type === "system_id" ? parameter("handleScope") : "";
    return scope ? { type, value, scope } : { type, value };
  };
  const batch = async (item: IDataObject): Promise<IDataObject> => {
    const answer = await request("POST", "/v1/batch", { items: [item] });
    return { accepted: answer.accepted ?? 0, idempotency_key: item.idempotency_key as string, errors: answer.errors ?? [] };
  };

  switch (operation) {
    case "getContext": {
      const view = parameter("view", "chat");
      const answer = await request("POST", "/v1/context", {
        subject: handle(),
        view,
        verification: parameter("verification", "V0"),
        conversation_id: conversationId,
      });
      return {
        text: answer.path === "holdout" ? "" : ((answer.text as string | null | undefined) ?? ""),
        suffix: renderSuffix(answer),
        etag: answer.etag ?? null,
        verification: answer.verification ?? null,
        withheld: answer.withheld ?? 0,
        path: answer.path ?? null,
      };
    }
    case "trackTurn": {
      const role = parameter("speaker", "customer");
      const messageId = parameter("messageId");
      return batch({
        type: "event",
        kind: "message",
        idempotency_key: messageId || randomUUID(),
        channel: parameter("channel", "whatsapp"),
        conversation_id: conversationId,
        handles: [handle()],
        speaker: { role },
        direction: role === "customer" ? "inbound" : "outbound",
        content: { type: "text", text: parameter("text") },
        occurred_at: now,
      });
    }
    case "searchHistory": {
      const when = parameter("when").trim();
      return request("POST", "/v1/history/search", {
        subject: handle(),
        query: parameter("query"),
        filters: when ? { when } : {},
        verification: parameter("verification", "V0"),
        conversation_id: conversationId,
      });
    }
    case "verify":
      return batch({
        type: "verify",
        idempotency_key: randomUUID(),
        method: parameter("method", "otp_whatsapp"),
        level: parameter("level", "V2"),
        handle: handle(),
        conversation_id: conversationId,
        occurred_at: now,
      });
    case "handoff": {
      const reason = parameter("reason");
      return batch({
        type: "handoff",
        idempotency_key: randomUUID(),
        conversation_id: conversationId,
        target: parameter("target", "human"),
        mode: "warm",
        ...(reason ? { reason } : {}),
        occurred_at: now,
      });
    }
    case "endConversation":
      return batch({ type: "conversation.ended", idempotency_key: randomUUID(), conversation_id: conversationId, occurred_at: now });
  }
}

/** The address of the space the key names, as the SDKs derive it, unless a base URL is set. */
export function baseUrlOf(apiKey: string, baseUrl: string): string {
  if (baseUrl.trim()) return baseUrl.trim().replace(/\/+$/, "");
  const parts = apiKey.startsWith("nia_sk_") ? apiKey.slice("nia_sk_".length).split("_") : [];
  const [mode, region, space] = parts;
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (parts.length < 5 || (mode !== "live" && mode !== "test") || !region || !space || !label.test(region) || !label.test(space)) return "";
  return `https://${space}.${region}.api.niadra.com`;
}

/** The deltas and live turns for the end of the prompt, rendered as the SDKs render them. */
export function renderSuffix(answer: IDataObject): string {
  if (answer.path === "holdout") return "";
  const live = Array.isArray(answer.live) ? (answer.live as IDataObject[]) : [];
  const lines = live.map((turn) => {
    const at = Date.parse(String(turn.at));
    const stamp = Number.isNaN(at) ? String(turn.at) : `${new Date(at).toISOString().slice(0, 19)}Z`;
    return `[${stamp}] ${String(turn.channel)} · ${String(turn.speaker)}: ${String(turn.text)}`;
  });
  const complete = answer.live_complete === false ? ' complete="false"' : "";
  const block = lines.length ? `<live_turns source="niadra"${complete}>\n${lines.join("\n")}\n</live_turns>` : "";
  return [typeof answer.delta === "string" ? answer.delta : "", block].filter(Boolean).join("\n\n");
}

function emptyResult(operation: Operation): IDataObject {
  if (operation === "getContext") return { text: "", suffix: "" };
  if (operation === "searchHistory") return { items: [] };
  return { accepted: 0 };
}
