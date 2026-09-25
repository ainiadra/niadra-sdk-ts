// Amazon Bedrock's Converse API with the customer's context.
//   NIADRA_API_KEY=... and AWS credentials for the Region where the model is enabled.
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { Niadra, handles } from "@niadra/sdk";
import { wrapBedrock } from "@niadra/sdk/bedrock";

const niadra = new Niadra();
const client = new BedrockRuntimeClient({});

/** One customer message in; `userId` comes from your session, never from the model. */
export async function reply(userId: string, chatId: string, text: string): Promise<string> {
  const convo = niadra.conversation({ subject: handles.appUserId(userId), channel: "web_chat", conversation_id: chatId });
  const bedrock = wrapBedrock(client, convo);
  const response = await bedrock.send(
    new ConverseCommand({
      modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      system: [{ text: "You are Acme's support agent. Be brief." }],
      messages: [{ role: "user", content: [{ text }] }],
    }),
  );
  return response.output?.message?.content?.map((block) => block.text ?? "").join("") ?? "";
}
