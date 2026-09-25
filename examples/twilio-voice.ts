// A Twilio Programmable Voice webhook on Hono: the carrier's attestation proves the caller, the
// context is read before the first answer, and each recognized sentence is recorded.
//   NIADRA_API_KEY=... TWILIO_AUTH_TOKEN=... PUBLIC_URL=https://api.acme.com bun twilio-voice.ts
import { Hono } from "hono";
import { Niadra } from "@niadra/sdk";
import { readTwilio, recordTwilioInbound, verifyTwilio } from "@niadra/sdk/twilio";

const niadra = new Niadra();
const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
const publicUrl = process.env.PUBLIC_URL ?? "";

/** Your agent: any model call that takes the context and what the caller said. */
function answer(context: string, said: string | undefined): Promise<string> {
  return Promise.resolve(said ? `You said ${said}.` : context ? "Welcome back to Acme. How can I help?" : "Acme, how can I help?");
}

function escape(text: string): string {
  return text.replace(/[<>&"']/g, (char) => `&#${String(char.charCodeAt(0))};`);
}

export const app = new Hono();

app.post("/twilio/voice", async (c) => {
  const { status, request } = await readTwilio(`${publicUrl}/twilio/voice`, await c.req.text(), c.req.raw.headers, { authToken });
  if (!request) return c.body(null, status as 403);
  // The attestation is recorded once, on the call's first webhook; later ones open at the proven level.
  const first = request.params.CallStatus === "ringing";
  const convo = niadra.conversation({
    subject: request.subject,
    channel: "voice",
    conversation_id: request.conversationId ?? "",
    verification: first ? "V0" : (request.proof?.level ?? "V0"),
  });
  if (first) await verifyTwilio(convo, request);
  recordTwilioInbound(convo, request);
  const ctx = await convo.context();
  convo.markInjected(ctx);
  const reply = await answer(ctx.text, request.text);
  convo.agent(reply);
  const twiml = `<Response><Gather input="speech" action="/twilio/voice"><Say>${escape(reply)}</Say></Gather></Response>`;
  return c.body(twiml, 200, { "content-type": "text/xml" });
});

export default app;
