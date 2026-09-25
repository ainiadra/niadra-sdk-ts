// A Mastra agent with the customer's context in every model call and the history tools.
//   NIADRA_API_KEY=... OPENAI_API_KEY=...
import { openai } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { Niadra, handles } from "@niadra/sdk";
import { niadraProcessor, niadraTools } from "@niadra/sdk/mastra";

const niadra = new Niadra();
const niadraContext = niadraProcessor();

export const support = new Agent({
  id: "support",
  name: "Acme support",
  model: openai("gpt-4.1"),
  instructions: "You are Acme's support agent. Be brief.",
  tools: ({ requestContext }) => niadraTools(requestContext.get("niadra")),
  inputProcessors: [niadraContext],
  outputProcessors: [niadraContext],
});

/** One customer message in; `userId` comes from your session, never from the model. */
export async function reply(userId: string, chatId: string, text: string): Promise<string> {
  const convo = niadra.conversation({ subject: handles.appUserId(userId), channel: "web_chat", conversation_id: chatId });
  const result = await support.generate(text, { requestContext: new RequestContext([["niadra", convo]]), maxSteps: 4 });
  return result.text;
}
