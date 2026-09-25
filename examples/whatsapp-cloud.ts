// A WhatsApp Cloud API webhook on Hono: reads Meta's delivery, gives the agent the customer's
// context, sends the answer through the Graph API and records both turns.
//   NIADRA_API_KEY=... META_APP_SECRET=... META_VERIFY_TOKEN=... META_ACCESS_TOKEN=... bun whatsapp-cloud.ts
import { Hono } from "hono";
import { Niadra } from "@niadra/sdk";
import { readWhatsApp, recordInbound, recordOutbound, whatsAppChallenge } from "@niadra/sdk/whatsapp";

const niadra = new Niadra();
const env = (name: string): string => process.env[name] ?? "";

/** Your agent: any model call that takes the instructions, the context and the customer's text. */
function answer(system: string, suffix: string, text: string): Promise<string> {
  return Promise.resolve(`(${String(system.length + suffix.length)} characters of context) You said: ${text}`);
}

export const app = new Hono();

app.get("/whatsapp", (c) => {
  const { status, body } = whatsAppChallenge(new URL(c.req.url).searchParams, env("META_VERIFY_TOKEN"));
  return c.text(body, status as 200);
});

app.post("/whatsapp", async (c) => {
  const { status, messages } = await readWhatsApp(await c.req.text(), c.req.raw.headers, { appSecret: env("META_APP_SECRET") });
  for (const inbound of messages) {
    const convo = niadra.conversation({ subject: inbound.subject, channel: "whatsapp", conversation_id: `wa:${inbound.waId}` });
    recordInbound(convo, inbound);
    const ctx = await convo.context();
    convo.markInjected(ctx);
    const reply = await answer(`You are Acme's WhatsApp agent.\n\n${ctx.text}`, ctx.suffix, inbound.text);
    const sent = await fetch(`https://graph.facebook.com/v23.0/${inbound.phoneNumberId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${env("META_ACCESS_TOKEN")}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: inbound.waId, type: "text", text: { body: reply } }),
    });
    recordOutbound(convo, reply, await sent.json());
  }
  return c.body(null, status as 200);
});

export default app;
