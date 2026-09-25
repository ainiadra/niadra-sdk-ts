// An OpenAI Agents SDK run: the customer's context in the instructions, the history tools, the
// turns recorded through the session and the handoffs through the runner.
//   NIADRA_API_KEY=... OPENAI_API_KEY=...
import { Agent, Runner } from "@openai/agents";
import { Niadra, handles } from "@niadra/sdk";
import { NiadraSession, niadraInstructions, niadraRunHooks, niadraTools } from "@niadra/sdk/openai-agents";

const niadra = new Niadra();
const runner = new Runner();

/** One customer message in; `userId` comes from your session, never from the model. */
export async function reply(userId: string, chatId: string, text: string): Promise<string> {
  const convo = niadra.conversation({ subject: handles.appUserId(userId), channel: "web_chat", conversation_id: chatId });
  const billing = new Agent({ name: "Billing", instructions: niadraInstructions("You handle invoices and credits.", convo), tools: niadraTools(convo) });
  const support = new Agent({
    name: "Support",
    instructions: niadraInstructions("You are Acme's support agent. Hand billing questions to Billing.", convo),
    tools: niadraTools(convo),
    handoffs: [billing],
  });
  const stop = niadraRunHooks(runner, convo);
  try {
    const result = await runner.run(support, text, { session: new NiadraSession(convo) });
    return String(result.finalOutput ?? "");
  } finally {
    stop();
  }
}
