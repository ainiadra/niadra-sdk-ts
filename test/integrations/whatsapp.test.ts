import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseWhatsApp, readWhatsApp, recordInbound, recordOutbound, whatsAppChallenge } from "../../src/integrations/whatsapp.js";
import { setup, turns } from "./support.js";

const APP_SECRET = "meta-app-secret";

/** A Cloud API delivery in Meta's documented shape: a text, an image with caption, a button reply and a status. */
const delivery = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "102290129340398",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
            contacts: [{ profile: { name: "Marina" }, wa_id: "5511987654321" }],
            messages: [
              { from: "5511987654321", id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=", timestamp: "1758736800", type: "text", text: { body: "My order arrived broken" } },
              { from: "5511987654321", id: "wamid.IMG1", timestamp: "1758736810", type: "image", image: { caption: "the lid", mime_type: "image/jpeg", sha256: "c2hh", id: "1003383421387256" }, context: { from: "15550783881", id: "wamid.PREV" } },
              { from: "5511987654321", id: "wamid.BTN1", timestamp: "1758736820", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "yes", title: "Yes, replace it" } } },
            ],
          },
        },
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
            statuses: [{ id: "wamid.OUT1", status: "delivered", timestamp: "1758736830", recipient_id: "5511987654321" }],
          },
        },
      ],
    },
  ],
};

function signed(body: string, secret = APP_SECRET): Record<string, string> {
  return { "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` };
}

describe("WhatsApp Cloud API", () => {
  it("checks the signature and reads text, media and replies with the customer's wa_id", async () => {
    const body = JSON.stringify(delivery);
    const { status, messages } = await readWhatsApp(body, signed(body), { appSecret: APP_SECRET });
    expect(status).toBe(200);
    expect(messages.map((message) => [message.type, message.text])).toEqual([
      ["text", "My order arrived broken"],
      ["image", "the lid"],
      ["interactive", "Yes, replace it"],
    ]);
    expect(messages[0]).toMatchObject({
      subject: { type: "wa_id", value: "5511987654321" },
      profileName: "Marina",
      phoneNumberId: "106540352242922",
      occurredAt: new Date("2025-09-24T18:00:00Z"),
    });
    expect(messages[1]).toMatchObject({ media: { id: "1003383421387256", mimeType: "image/jpeg" }, replyTo: "wamid.PREV" });
  });

  it("reads nothing from a delivery with a bad or missing signature", async () => {
    const body = JSON.stringify(delivery);
    expect(await readWhatsApp(body, signed(body, "other"), { appSecret: APP_SECRET })).toEqual({ status: 401, body: null, messages: [] });
    expect((await readWhatsApp(body, {}, { appSecret: APP_SECRET })).status).toBe(401);
    expect((await readWhatsApp(`${body}\n`, signed(body), { appSecret: APP_SECRET })).status).toBe(401);
    expect(parseWhatsApp({ entry: "nope" })).toEqual([]);
  });

  it("answers Meta's subscription check only with the right token", () => {
    const query = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "1158201444" });
    expect(whatsAppChallenge(query, "tok")).toEqual({ status: 200, body: "1158201444" });
    expect(whatsAppChallenge(query, "other").status).toBe(403);
    expect(whatsAppChallenge({ "hub.mode": "subscribe", "hub.verify_token": "tok" }, "tok").status).toBe(403);
  });

  it("records the customer's turns with Meta's ids and the agent's turn with the wamid it got back", async () => {
    const { server, niadra } = setup();
    const [text, image] = parseWhatsApp(delivery);
    const convo = niadra.conversation({ subject: text!.subject, channel: "whatsapp", conversation_id: "wa-8812" });
    recordInbound(convo, text!);
    recordInbound(convo, image!, { media_ref: "med_1", media_sha256: "a".repeat(64) });
    recordOutbound(convo, "Sorry about that. A new one ships today.", { messaging_product: "whatsapp", messages: [{ id: "wamid.OUT1" }] });
    await niadra.flush();
    const recorded = turns(server);
    expect(recorded.map((turn) => [turn.role, turn.item.idempotency_key])).toEqual([
      ["customer", "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA="],
      ["customer", "wamid.IMG1"],
      ["ai_agent", "wamid.OUT1"],
    ]);
    expect(recorded[1]!.item.content).toEqual({ type: "image", media_ref: "med_1", media_sha256: "a".repeat(64), text: "the lid" });
    expect(recorded[0]!.item.handles).toEqual([{ type: "wa_id", value: "5511987654321" }]);
  });
});
