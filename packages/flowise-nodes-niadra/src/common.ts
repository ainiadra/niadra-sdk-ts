import { Niadra, handles } from "@niadra/sdk";
import type { Conversation, Handle, Verification } from "@niadra/sdk";
import type { INodeData, INodeParams } from "./flowise";

/** The inputs both nodes share: who the customer is, where they talk and what they proved. */
export const CUSTOMER_INPUTS: INodeParams[] = [
  {
    label: "Customer Handle Type",
    name: "handleType",
    type: "options",
    default: "app_user_id",
    options: [
      { label: "App User ID", name: "app_user_id" },
      { label: "E-Mail", name: "email" },
      { label: "Phone (E.164)", name: "phone_e164" },
      { label: "System ID (CRM, ERP)", name: "system_id" },
      { label: "WhatsApp ID (wa_id)", name: "wa_id" },
    ],
  },
  {
    label: "Customer Handle",
    name: "handleValue",
    type: "string",
    acceptVariable: true,
    placeholder: "{{$vars.customerId}}",
    description: "Bind it to what your app knows (a variable or the override config), never to text the model writes.",
  },
  { label: "System", name: "handleScope", type: "string", optional: true, additionalParams: true, placeholder: "crm", description: "The system a System ID belongs to" },
  { label: "Channel", name: "channel", type: "string", default: "web_chat", optional: true, additionalParams: true },
  {
    label: "Verification Level",
    name: "verification",
    type: "options",
    default: "V0",
    optional: true,
    additionalParams: true,
    options: ["V0", "V1", "V2", "V3", "V4"].map((level) => ({ label: level, name: level })),
    description: "What the customer has proven in this chat, such as V2 after a login",
  },
  { label: "Agent Memory", name: "agentMemory", type: "boolean", default: false, optional: true, additionalParams: true, description: "Also give the agent its own working notes" },
  { label: "API Key", name: "apiKey", type: "password", optional: true, additionalParams: true, description: "A source key; defaults to the NIADRA_API_KEY environment variable" },
  { label: "Base URL", name: "baseUrl", type: "string", optional: true, additionalParams: true, description: "Only for a local emulator" },
];

const clients = new Map<string, Niadra>();

/** One client per key, shared by every chat, as the SDK recommends. */
export function clientFor(nodeData: INodeData): Niadra {
  const apiKey = String(nodeData.inputs?.apiKey ?? "") || undefined;
  const baseURL = String(nodeData.inputs?.baseUrl ?? "") || undefined;
  const key = `${apiKey ?? "env"}|${baseURL ?? ""}`;
  let client = clients.get(key);
  if (!client) {
    client = new Niadra({ ...(apiKey ? { apiKey } : {}), ...(baseURL ? { baseURL } : {}) });
    clients.set(key, client);
  }
  return client;
}

export function handleOf(nodeData: INodeData): Handle | null {
  const type = String(nodeData.inputs?.handleType ?? "app_user_id");
  const value = String(nodeData.inputs?.handleValue ?? "").trim();
  if (!value) return null;
  switch (type) {
    case "phone_e164":
      return handles.phone(value);
    case "email":
      return handles.email(value);
    case "wa_id":
      return handles.waId(value);
    case "system_id":
      return handles.systemId(value, String(nodeData.inputs?.handleScope ?? "") || "crm");
    default:
      return handles.appUserId(value);
  }
}

/** The conversation of a Flowise chat session, or `null` when no customer is configured. */
export function conversationFor(nodeData: INodeData, niadra: Niadra, sessionId: string): Conversation | null {
  const subject = handleOf(nodeData);
  if (!subject || !sessionId) return null;
  return niadra.conversation({
    subject,
    channel: String(nodeData.inputs?.channel ?? "") || "web_chat",
    conversation_id: sessionId,
    verification: (String(nodeData.inputs?.verification ?? "") || "V0") as Verification,
  });
}
