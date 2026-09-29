// Coordination: ask before acting, so two agents never do the same thing to one customer. The closing
// agent's farewell is an effect with a key: the first check reserves it, the agent sends it and declares
// it done, and every later check of the same key hears it is done. With Niadra down, each purpose decides
// its own way (a farewell waits, a service answer goes).
//   NIADRA_API_KEY=...   (the space's `coordination` feature)
import type { Conversation } from "@niadra/sdk";

/** Sends the farewell of this conversation once, whichever agent tries it first. */
export async function farewellOnce(conversation: Conversation, conversationId: string, send: (text: string) => unknown): Promise<boolean> {
  const key = `farewell:${conversationId}`;
  const decision = await conversation.check("farewell", { purpose: "service", effectKey: key });
  if (decision.decision !== "allow") return false;
  send("Obrigada pelo contato! Qualquer coisa, é só chamar.");
  conversation.declare.effect(key, "done");
  return true;
}
