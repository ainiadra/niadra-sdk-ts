// Offline tests: they stub IExecuteFunctions and the HTTP helper, as Mem0's n8n node tests do
// (MIT License, Copyright (c) 2023-2026 Taranjeet Singh; see NOTICE), and use n8n-workflow's
// own error classes.
import { NodeApiError } from "n8n-workflow";
import { describe, expect, it, vi } from "vitest";
import { NiadraApi } from "../credentials/NiadraApi.credentials";
import { Niadra, baseUrlOf, renderSuffix } from "../nodes/Niadra/Niadra.node";

const KEY = "nia_sk_test_sa-east-1_acme-sandbox_k7Qx_s3cr3t";
const marina = { type: "phone_e164", value: "+5511987654321" };

function context(operation: string, parameters: Record<string, unknown>, reply: (options: any) => unknown, credentials: Record<string, string> = { apiKey: KEY, baseUrl: "" }) {
  const requests: any[] = [];
  const node = { name: "Niadra", type: "n8n-nodes-niadra.niadra", typeVersion: 1 };
  const ctx: any = {
    getInputData: () => [{ json: {} }],
    getCredentials: async () => credentials,
    getNodeParameter: (name: string, _i: number, fallback?: unknown) => (name === "operation" ? operation : name in parameters ? parameters[name] : fallback),
    getNode: () => node,
    continueOnFail: () => false,
    helpers: {
      httpRequestWithAuthentication: vi.fn(async (credential: string, options: any) => {
        requests.push({ credential, ...options });
        const answer = reply(options);
        if (answer instanceof Error) throw answer;
        return answer;
      }),
    },
  };
  return { ctx, requests };
}

const run = async (ctx: any) => (await new Niadra().execute.call(ctx))[0]!.map((item) => item.json);
const conversation = { handleType: "phone_e164", handleValue: "+5511987654321", conversationId: "wa-8812" };

describe("Niadra n8n node", () => {
  it("gets the context from the space the key names, with the suffix rendered as the SDKs do", async () => {
    const { ctx, requests } = context("getContext", { ...conversation, view: "chat", verification: "V1" }, () => ({
      text: "<context>Marina</context>",
      etag: "e1",
      path: "t0",
      withheld: 0,
      verification: { requested: "V1", effective: "V1" },
      live: [{ at: "2026-09-22T17:07:02.123Z", channel: "voice", speaker: "customer", text: "called" }],
      live_complete: true,
      delta: "[New] credit",
    }));
    const [json] = await run(ctx);
    expect(requests[0]).toMatchObject({
      credential: "niadraApi",
      method: "POST",
      baseURL: "https://acme-sandbox.sa-east-1.api.niadra.com",
      url: "/v1/context",
      body: { subject: marina, view: "chat", verification: "V1", conversation_id: "wa-8812" },
    });
    expect(json).toMatchObject({
      text: "<context>Marina</context>",
      suffix: '[New] credit\n\n<live_turns source="niadra">\n[2026-09-22T17:07:02Z] voice · customer: called\n</live_turns>',
      etag: "e1",
    });
  });

  it("records a turn keyed by the provider's message id", async () => {
    const { ctx, requests } = context("trackTurn", { ...conversation, speaker: "customer", text: "My order arrived broken", channel: "whatsapp", messageId: "wamid.1" }, () => ({ accepted: 1, duplicates: 0, errors: [] }));
    const [json] = await run(ctx);
    expect(requests[0].url).toBe("/v1/batch");
    expect(requests[0].body.items[0]).toMatchObject({
      type: "event",
      kind: "message",
      idempotency_key: "wamid.1",
      channel: "whatsapp",
      conversation_id: "wa-8812",
      handles: [marina],
      speaker: { role: "customer" },
      direction: "inbound",
      content: { type: "text", text: "My order arrived broken" },
    });
    expect(json).toMatchObject({ accepted: 1, idempotency_key: "wamid.1" });
  });

  it("searches with the customer's words for the period, verifies and hands off", async () => {
    const search = context("searchHistory", { ...conversation, query: "refund", when: "semana passada", verification: "V2" }, () => ({ items: [], withheld: 0, tokens_used: 1 }));
    await run(search.ctx);
    expect(search.requests[0]).toMatchObject({ url: "/v1/history/search", body: { subject: marina, query: "refund", filters: { when: "semana passada" }, verification: "V2", conversation_id: "wa-8812" } });

    const verify = context("verify", { ...conversation, method: "otp_whatsapp", level: "V2" }, () => ({ accepted: 1 }));
    await run(verify.ctx);
    expect(verify.requests[0].body.items[0]).toMatchObject({ type: "verify", method: "otp_whatsapp", level: "V2", handle: marina, conversation_id: "wa-8812" });

    const handoff = context("handoff", { conversationId: "wa-8812", target: "human", reason: "billing dispute" }, () => ({ accepted: 1 }));
    await run(handoff.ctx);
    expect(handoff.requests[0].body.items[0]).toMatchObject({ type: "handoff", target: "human", mode: "warm", reason: "billing dispute", conversation_id: "wa-8812" });

    const end = context("endConversation", { conversationId: "wa-8812" }, () => ({ accepted: 1 }));
    await run(end.ctx);
    expect(end.requests[0].body.items[0]).toMatchObject({ type: "conversation.ended", conversation_id: "wa-8812" });
  });

  it("fails open by default and stops the workflow when asked to", async () => {
    const down = () => new NodeApiError({ name: "Niadra", type: "n8n-nodes-niadra.niadra", typeVersion: 1 } as never, { message: "503" } as never);
    const open = context("getContext", conversation, down);
    const [json] = await run(open.ctx);
    expect(json).toMatchObject({ text: "", suffix: "" });
    expect(json!.error).toBeTruthy();
    const strict = context("getContext", { ...conversation, failOpen: false }, down);
    await expect(run(strict.ctx)).rejects.toBeInstanceOf(NodeApiError);
  });

  it("uses a base URL when one is set, and refuses a key that names no space", async () => {
    expect(baseUrlOf(KEY, "")).toBe("https://acme-sandbox.sa-east-1.api.niadra.com");
    expect(baseUrlOf(KEY, "http://localhost:8080/")).toBe("http://localhost:8080");
    expect(baseUrlOf("sk-other", "")).toBe("");
    const { ctx, requests } = context("getContext", { ...conversation, failOpen: true }, () => ({}), { apiKey: "sk-other", baseUrl: "" });
    const [json] = await run(ctx);
    expect(requests).toHaveLength(0);
    expect(String(json!.error)).toMatch(/does not name a space/);
  });

  it("describes a credential that authenticates with a bearer token and tests with a read", () => {
    const credential = new NiadraApi();
    expect(credential.authenticate).toEqual({ type: "generic", properties: { headers: { Authorization: "=Bearer {{$credentials.apiKey}}" } } });
    expect(credential.test.request).toMatchObject({ url: "/v1/history/tools", method: "GET" });
    expect(renderSuffix({ path: "holdout", delta: "x" })).toBe("");
  });

  it("is usable as a tool by n8n's AI Agent, with every operation listed", () => {
    const description = new Niadra().description;
    expect(description.usableAsTool).toBe(true);
    const operation = description.properties.find((property) => property.name === "operation")!;
    expect((operation.options as { value: string }[]).map((option) => option.value).sort()).toEqual(
      ["endConversation", "getContext", "handoff", "searchHistory", "trackTurn", "verify"],
    );
  });
});
