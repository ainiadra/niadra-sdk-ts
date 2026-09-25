import twilio from "twilio";
import { describe, expect, it } from "vitest";
import { parseTwilio, readTwilio, recordTwilioInbound, validTwilioSignature, verifyTwilio } from "../../src/integrations/twilio.js";
import { marina, sequence, setup, turns } from "./support.js";

const AUTH_TOKEN = "12345678901234567890123456789012";
const URL_ = "https://api.acme.com/twilio/voice?tenant=acme";

/** An inbound voice webhook, as Twilio posts it (form-encoded), with the carrier's attestation. */
const voice = {
  AccountSid: "AC1",
  ApiVersion: "2010-04-01",
  CallSid: "CA9e2f",
  CallStatus: "ringing",
  Called: "+551140028922",
  Caller: "+5511987654321",
  Direction: "inbound",
  From: "+5511987654321",
  To: "+551140028922",
  StirVerstat: "TN-Validation-Passed-A",
};
const gather = { ...voice, CallStatus: "in-progress", SpeechResult: "I want to talk about my bill", Confidence: "0.87" };
const whatsapp = {
  AccountSid: "AC1",
  MessageSid: "SM77",
  SmsMessageSid: "SM77",
  From: "whatsapp:+5511987654321",
  To: "whatsapp:+14155238886",
  WaId: "5511987654321",
  ProfileName: "Marina",
  Body: "Is my replacement shipping?",
  NumMedia: "0",
};

function form(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

describe("Twilio", () => {
  it("computes the same signature as the Twilio SDK", async () => {
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, URL_, voice);
    expect(twilio.validateRequest(AUTH_TOKEN, signature, URL_, voice)).toBe(true);
    expect(await validTwilioSignature(URL_, voice, signature, AUTH_TOKEN)).toBe(true);
    expect(await validTwilioSignature(URL_, new URLSearchParams(voice), signature, AUTH_TOKEN)).toBe(true);
    expect(await validTwilioSignature(`${URL_}&x=1`, voice, signature, AUTH_TOKEN)).toBe(false);
    expect(await validTwilioSignature(URL_, { ...voice, From: "+5511000000000" }, signature, AUTH_TOKEN)).toBe(false);
  });

  it("reads a voice call: the caller, the call id and the carrier's attestation", async () => {
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, URL_, voice);
    const { status, request } = await readTwilio(URL_, form(voice), { "X-Twilio-Signature": signature }, { authToken: AUTH_TOKEN });
    expect(status).toBe(200);
    expect(request).toMatchObject({ channel: "voice", subject: marina, conversationId: "CA9e2f", proof: { method: "network_attestation", level: "V2" } });
    expect((await readTwilio(URL_, form(voice), { "X-Twilio-Signature": "bad" }, { authToken: AUTH_TOKEN })).status).toBe(403);
  });

  it("verifies before the first read and records the recognized speech with its confidence", async () => {
    const { server, niadra } = setup();
    const request = parseTwilio(gather)!;
    const convo = niadra.conversation({ subject: request.subject, channel: request.channel, conversation_id: request.conversationId! });
    await verifyTwilio(convo, request);
    recordTwilioInbound(convo, request);
    await convo.context();
    await niadra.flush();
    expect(sequence(server).slice(0, 2)).toEqual(["batch:verify", "POST /v1/context"]);
    expect(server.callsTo("POST /v1/context")[0]!.body).toMatchObject({ verification: "V2", view: "voice" });
    expect(turns(server)[0]!.item.content).toEqual({ type: "audio", transcript: "I want to talk about my bill", stt_confidence: 0.87 });
  });

  it("reads WhatsApp by WaId, SMS and outbound calls by the customer's side, and Conversations by author", () => {
    expect(parseTwilio(whatsapp)).toMatchObject({ channel: "whatsapp", subject: { type: "wa_id", value: "5511987654321" }, messageId: "SM77", text: "Is my replacement shipping?", proof: null });
    expect(parseTwilio({ MessageSid: "SM1", From: "+5511987654321", To: "+15550001111", Body: "hi" })).toMatchObject({ channel: "sms", subject: marina });
    expect(parseTwilio({ CallSid: "CA2", Direction: "outbound-api", From: "+15550001111", To: "+5511987654321" })).toMatchObject({ channel: "voice", subject: marina });
    expect(parseTwilio({ ConversationSid: "CH1", MessageSid: "IM1", Author: "whatsapp:+5511987654321", Body: "ok" })).toMatchObject({ channel: "conversations", subject: marina, conversationId: "CH1" });
    expect(parseTwilio({ ConversationSid: "CH1", Author: "user-42", Body: "ok" })?.subject).toEqual({ type: "app_user_id", value: "user-42" });
    expect(parseTwilio({ From: "anonymous" })).toBeNull();
  });

  it("records a WhatsApp message keyed by its MessageSid", async () => {
    const { server, niadra } = setup();
    const request = parseTwilio(whatsapp)!;
    recordTwilioInbound(niadra.conversation({ subject: request.subject, channel: "whatsapp" }), request);
    await niadra.flush();
    expect(turns(server)[0]!.item).toMatchObject({ idempotency_key: "SM77", content: { type: "text", text: "Is my replacement shipping?" } });
  });
});
