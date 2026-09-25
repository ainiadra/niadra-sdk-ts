// Runs the webhook adapters of the build (ElevenLabs, Vapi, Retell, WhatsApp, Twilio) on a runtime other
// than Node: they only use web APIs, Web Crypto for the signatures. Deno and Bun run this file
// directly; workerd runs it through test/runtimes/workerd.mjs. It exports `webhooks()`.
import { validSignature } from "../../dist/elevenlabs.js";
import { validTwilioSignature, parseTwilio } from "../../dist/twilio.js";
import { validWhatsAppSignature, parseWhatsApp } from "../../dist/whatsapp.js";
import { vapi } from "../../dist/vapi.js";
import { retell, validRetellSignature } from "../../dist/retell.js";
import { Niadra, silentLogger } from "../../dist/index.js";

const BODY = '{"object":"whatsapp_business_account","entry":[]}';

export async function webhooks() {
  if (!(await validWhatsAppSignature(BODY, "sha256=d3e4f9da0ce6c71ab3dba55929b8eeeee2455349e534924ead19f98d143e904f", "app-secret"))) {
    throw new Error("whatsapp signature");
  }
  if (parseWhatsApp(JSON.parse(BODY)).length !== 0) throw new Error("whatsapp parse");
  const signature = "t=1758736800,v0=eb6b3e52f109e98c2f943487a41ff9f423b9f625a82de39872468abdcf37d62f";
  if (!(await validSignature(BODY, signature, "wsec", 1758736800 * 1000))) throw new Error("elevenlabs signature");
  const params = { CallSid: "CA1", From: "+5511987654321", StirVerstat: "TN-Validation-Passed-A" };
  if (!(await validTwilioSignature("https://api.acme.com/twilio/voice", params, "A8xudRcvIv+pFEwk/mgVzWhDutw=", "token"))) {
    throw new Error("twilio signature");
  }
  if (parseTwilio(params)?.proof?.level !== "V2") throw new Error("twilio parse");
  const niadra = new Niadra({ logger: silentLogger, flushOnExit: false });
  const handle = vapi({ niadra, secret: "s" });
  const refused = await handle({ message: { type: "status-update", call: { id: "c" } } }, { "x-vapi-secret": "no" });
  if (refused.status !== 401) throw new Error("vapi secret");
  const retellSignature = "v=1758736800000,d=b9c9275a0930ffffda4410ea1428000fd93a8bb69db0246145db971d64a052b3";
  if (!(await validRetellSignature(BODY, retellSignature, "key_retell", 1758736800000))) throw new Error("retell signature");
  const unsigned = await retell({ niadra, apiKey: "key_retell" }).webhook(BODY, { "x-retell-signature": retellSignature });
  if (unsigned.status !== 401) throw new Error("retell stale signature");
  return 7;
}

const standalone = typeof globalThis.Deno !== "undefined" || typeof globalThis.Bun !== "undefined";
if (standalone) {
  const count = await webhooks();
  console.log(`ok ${typeof globalThis.Deno !== "undefined" ? "deno" : "bun"}: ${count} webhook checks`);
}
