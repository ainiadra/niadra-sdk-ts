import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The webhook examples run as they are, over Hono, with no Niadra key: the client is then
// disabled and every handler must still answer the platform (fail-open).
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NIADRA_API_KEY", "");
  vi.stubEnv("NIADRA_ELEVENLABS_SECRET", "el-secret");
  vi.stubEnv("ELEVENLABS_WEBHOOK_SECRET", "el-webhook");
  vi.stubEnv("VAPI_SERVER_SECRET", "vapi-secret");
  vi.stubEnv("META_APP_SECRET", "meta-secret");
  vi.stubEnv("META_VERIFY_TOKEN", "verify-me");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio-token");
  vi.stubEnv("PUBLIC_URL", "https://api.acme.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("examples", () => {
  it("elevenlabs-hono answers the initiation webhook, and refuses a request without the secret", async () => {
    const { app } = await import("../../examples/elevenlabs-hono.js");
    const ok = await app.request("/elevenlabs/initiation", post({ caller_id: "+5511987654321", conversation_id: "c1" }, { "x-niadra-secret": "el-secret" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ type: "conversation_initiation_client_data", dynamic_variables: { niadra_context: "", niadra_turn: "" } });
    expect((await app.request("/elevenlabs/initiation", post({ conversation_id: "c1" }))).status).toBe(401);
    const event = JSON.stringify({ type: "post_call_audio", data: {} });
    const at = Math.floor(Date.now() / 1000);
    const signature = `t=${at},v0=${createHmac("sha256", "el-webhook").update(`${at}.${event}`).digest("hex")}`;
    expect(await (await app.request("/elevenlabs/post-call", post(event, { "elevenlabs-signature": signature }))).json()).toEqual({ ignored: true });
  });

  it("vapi-hono answers assistant-request with the saved assistant", async () => {
    const { app } = await import("../../examples/vapi-hono.js");
    const response = await app.request("/vapi", post({ message: { type: "assistant-request", call: { id: "call_1", customer: { number: "+5511987654321" } } } }, { "x-vapi-secret": "vapi-secret" }));
    expect(await response.json()).toMatchObject({ assistantId: "YOUR_ASSISTANT_ID" });
  });

  it("whatsapp-cloud answers Meta's subscription check and refuses an unsigned delivery", async () => {
    const { app } = await import("../../examples/whatsapp-cloud.js");
    const check = await app.request("/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42");
    expect(await check.text()).toBe("42");
    expect((await app.request("/whatsapp", post({ entry: [] }))).status).toBe(401);
  });

  it("twilio-voice answers a signed call with TwiML and refuses an unsigned one", async () => {
    const { app } = await import("../../examples/twilio-voice.js");
    const params = { CallSid: "CA1", CallStatus: "ringing", From: "+5511987654321", To: "+551140028922", Direction: "inbound" };
    const url = "https://api.acme.com/twilio/voice";
    const data = url + Object.keys(params).sort().map((key) => key + params[key as keyof typeof params]).join("");
    const signature = createHmac("sha1", "twilio-token").update(data).digest("base64");
    const form = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() };
    const ok = await app.request("/twilio/voice", { ...form, headers: { ...form.headers, "x-twilio-signature": signature } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toMatch(/^<Response><Gather input="speech"/);
    expect((await app.request("/twilio/voice", form)).status).toBe(403);
  });
});
