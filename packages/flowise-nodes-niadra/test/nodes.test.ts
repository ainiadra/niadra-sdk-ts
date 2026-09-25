import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeClass as MemoryNode } from "../src/NiadraMemory";
import { nodeClass as ToolsNode } from "../src/NiadraTools";
import type { INodeData, MemoryMethods } from "../src/flowise";

const KEY = "nia_sk_test_sa-east-1_acme-sandbox_k7Qx_s3cr3t";
const PACK = "<context>Marina · customer since 2021</context>";

/** Answers like a Niadra space and keeps what the nodes sent. */
function space() {
  const calls: { path: string; body: any }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, body });
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/context") {
      return json({ not_modified: false, text: PACK, variables: {}, version: "1", etag: "e1", coverage: [], verification: { requested: "V2", effective: "V2" }, withheld: 0, live: [], live_complete: true, timing: {}, path: "t0", degraded: false });
    }
    if (url.pathname === "/v1/history/search") return json({ items: [{ id: "ep_1", kind: "episode", text: "refund", at: "2026-09-01T10:00:00Z" }], withheld: 0, tokens_used: 1 });
    return json({ accepted: 1, duplicates: 0, errors: [] });
  });
  return calls;
}

function nodeData(inputs: Record<string, unknown>): INodeData {
  return { id: "n1", label: "", name: "", type: "", icon: "", version: 1, category: "", baseClasses: [], inputs: { apiKey: `${KEY}${Math.random().toString(36).slice(2)}`, ...inputs } };
}

beforeEach(() => {
  vi.stubEnv("NIADRA_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Flowise: Niadra Customer Memory", () => {
  it("puts the customer's context right after the agent's system prompt, as the Tool Agent builds it", async () => {
    const calls = space();
    const memory = await new MemoryNode().init(nodeData({ handleType: "phone_e164", handleValue: "+5511987654321", verification: "V2" }), "", { sessionId: "chat-1" });
    // The Tool Agent's prompt: system, the memory's messages, the input, the scratchpad.
    const prompt = ChatPromptTemplate.fromMessages([
      ["system", "You are Acme's support agent."],
      new MessagesPlaceholder("chat_history"),
      ["human", "{input}"],
    ]);
    const messages = await prompt.formatMessages({ input: "Where is my replacement?", chat_history: await memory.getChatMessages("chat-1", true) });
    expect(messages.map((message) => [message.type, message.text])).toEqual([
      ["system", "You are Acme's support agent."],
      ["system", PACK],
      ["human", "Where is my replacement?"],
    ]);
    expect(calls[0]).toMatchObject({ path: "/v1/context", body: { subject: { type: "phone_e164", value: "+5511987654321" }, verification: "V2", conversation_id: "chat-1" } });
  });

  it("records what the agent adds as turns and keeps the chat's messages", async () => {
    const calls = space();
    const memory = await new MemoryNode().init(nodeData({ handleType: "app_user_id", handleValue: "user-42" }), "", { sessionId: "chat-2" });
    await memory.addChatMessages([{ text: "Did I ask for a refund?", type: "userMessage" }, { text: "Yes, on September 1.", type: "apiMessage" }], "chat-2");
    const history = (await memory.getChatMessages("chat-2", false)) as { message: string; type: string }[];
    expect(history.slice(1)).toEqual([
      { message: "Did I ask for a refund?", type: "userMessage" },
      { message: "Yes, on September 1.", type: "apiMessage" },
    ]);
    await vi.waitFor(() => expect(calls.some((call) => call.path === "/v1/batch")).toBe(true));
    const turns = calls.filter((call) => call.path === "/v1/batch").flatMap((call) => call.body.items);
    expect(turns.map((item: any) => [item.speaker.role, item.content.text])).toEqual([
      ["customer", "Did I ask for a refund?"],
      ["ai_agent", "Yes, on September 1."],
    ]);
  });

  it("uses a connected chat history memory for the chat's own messages", async () => {
    space();
    const stored: { text: string; type: "userMessage" | "apiMessage" }[] = [];
    const chatHistory: MemoryMethods = {
      getChatMessages: async () => stored.map((message) => ({ message: message.text, type: message.type })),
      addChatMessages: async (messages) => {
        stored.push(...messages);
      },
      clearChatMessages: async () => undefined,
    };
    const memory = await new MemoryNode().init(nodeData({ handleValue: "user-7", chatHistory }), "", { sessionId: "chat-3" });
    await memory.addChatMessages([{ text: "hi", type: "userMessage" }]);
    expect(stored).toEqual([{ text: "hi", type: "userMessage" }]);
  });

  it("returns only the chat's messages when no customer is set or Niadra is down", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const memory = await new MemoryNode().init(nodeData({ handleValue: "user-1" }), "", { sessionId: "chat-4" });
    expect(await memory.getChatMessages("chat-4", true)).toEqual([]);
    const anonymous = await new MemoryNode().init(nodeData({ handleValue: "" }), "", { sessionId: "chat-4" });
    expect(await anonymous.getChatMessages("chat-4", true)).toEqual([]);
  });
});

describe("Flowise: Niadra Customer History", () => {
  it("gives the agent the kit bound to the chat's customer", async () => {
    const calls = space();
    const tools = await new ToolsNode().init(nodeData({ handleType: "email", handleValue: "marina@example.com" }), "", { sessionId: "chat-5" });
    expect(tools.map((tool) => tool.name)).toEqual(["search_customer_history", "get_customer_timeline", "open_history_item"]);
    const output = await tools[0]!.invoke({ query: "refund" });
    expect(JSON.parse(String(output))).toMatchObject({ items: [{ id: "ep_1" }] });
    expect(calls.find((call) => call.path === "/v1/history/search")?.body).toMatchObject({ subject: { type: "email", value: "marina@example.com" }, query: "refund", conversation_id: "chat-5" });
  });

  it("describes nodes Flowise can list and connect", () => {
    const memory = new MemoryNode();
    const tools = new ToolsNode();
    expect(memory.baseClasses).toContain("BaseChatMemory");
    expect(memory.category).toBe("Memory");
    expect(tools.baseClasses).toContain("Tool");
    expect(tools.category).toBe("Tools");
  });
});
