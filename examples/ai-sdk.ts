// A chat route with the Vercel AI SDK (Next.js App Router or any fetch handler): the model gets
// the customer's context through a middleware, and the history tools next to your own.
//   NIADRA_API_KEY=... OPENAI_API_KEY=...
import { openai } from "@ai-sdk/openai";
import {
  type UIMessage,
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  wrapLanguageModel,
} from "ai";
import { Niadra, handles } from "@niadra/sdk";
import { niadraMiddleware, niadraTools } from "@niadra/sdk/ai-sdk";

const niadra = new Niadra();

/** `userId` comes from your session: the customer is never something the model or the browser picks. */
export async function POST(request: Request, userId: string): Promise<Response> {
  const { id, messages } = (await request.json()) as { id: string; messages: UIMessage[] };
  const convo = niadra.conversation({ subject: handles.appUserId(userId), channel: "web_chat", conversation_id: id });

  const tools = niadraTools(convo);
  const result = streamText({
    model: wrapLanguageModel({
      model: openai("gpt-4.1"),
      // The user signed in, which proves V2 in this space's policy.
      middleware: niadraMiddleware(convo, { verify: { method: "login", level: "V2" } }),
    }),
    system: "You are Acme's support agent. Be brief.",
    messages: await convertToModelMessages(messages),
    tools,
    stopWhen: isStepCount(4),
  });
  return createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream, tools }) });
}
