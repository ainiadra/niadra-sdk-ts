// The Anthropic SDK with the customer's context: wrap the client once per conversation.
//   NIADRA_API_KEY=... ANTHROPIC_API_KEY=...
import Anthropic from "@anthropic-ai/sdk";
import { Niadra, handles } from "@niadra/sdk";
import { wrapAnthropic } from "@niadra/sdk/anthropic";

const niadra = new Niadra();
const anthropic = new Anthropic();

/** One customer message in; `userId` comes from your session, never from the model. */
export async function reply(userId: string, chatId: string, text: string): Promise<string> {
  const convo = niadra.conversation({ subject: handles.appUserId(userId), channel: "web_chat", conversation_id: chatId });
  const claude = wrapAnthropic(anthropic, convo, { verify: { method: "login", level: "V2" } });
  const message = await claude.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system: "You are Acme's support agent. Be brief.",
    messages: [{ role: "user", content: text }],
  });
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}
