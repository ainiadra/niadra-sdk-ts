// The Google Gen AI SDK with the customer's context.
//   NIADRA_API_KEY=... GEMINI_API_KEY=...
import { GoogleGenAI } from "@google/genai";
import { Niadra, handles } from "@niadra/sdk";
import { wrapGoogleGenAI } from "@niadra/sdk/google-genai";

const niadra = new Niadra();
const genai = new GoogleGenAI({});

/** One customer message in; `userId` comes from your session, never from the model. */
export async function reply(userId: string, chatId: string, text: string): Promise<string> {
  const convo = niadra.conversation({ subject: handles.appUserId(userId), channel: "web_chat", conversation_id: chatId });
  const ai = wrapGoogleGenAI(genai, convo);
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: text,
    config: { systemInstruction: "You are Acme's support agent. Be brief." },
  });
  return response.text ?? "";
}
