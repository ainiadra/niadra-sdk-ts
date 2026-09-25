import { Readable } from "node:stream";
import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand, ListAsyncInvokesCommand } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import { bedrockUsage, wrapBedrock } from "../../src/integrations/bedrock.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, setup, turns } from "./support.js";

const MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const converse = {
  output: { message: { role: "assistant", content: [{ text: "Your replacement ships today." }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 150, outputTokens: 12, totalTokens: 2162, cacheReadInputTokens: 2000, cacheWriteInputTokens: 0 },
  metrics: { latencyMs: 420 },
};

/** The real Bedrock client, answered by a request handler that plays the service and keeps the request bodies. */
function bedrock() {
  const bodies: any[] = [];
  const client = new BedrockRuntimeClient({
    region: "us-east-1",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    maxAttempts: 1,
    requestHandler: {
      handle: async (request: { body?: string }) => {
        bodies.push(JSON.parse(request.body ?? "{}"));
        return {
          response: { statusCode: 200, headers: { "content-type": "application/json" }, body: Readable.from([Buffer.from(JSON.stringify(converse))]) },
        };
      },
    } as never,
  });
  return { client, bodies };
}

describe("Amazon Bedrock: wrapBedrock", () => {
  it("adds the pack as a system block and the suffix to the last user message, and records both turns with the cache usage", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "br-1" });
    const { client, bodies } = bedrock();
    const wrapped = wrapBedrock(client, convo);

    const response = await wrapped.send(
      new ConverseCommand({
        modelId: MODEL,
        system: [{ text: "You are Acme's support agent." }],
        messages: [{ role: "user", content: [{ text: "Where is my replacement?" }] }],
      }),
    );

    expect(response.output?.message?.content?.[0]?.text).toBe("Your replacement ships today.");
    expect(bodies[0].system).toEqual([{ text: "You are Acme's support agent." }, { text: PACK }]);
    expect(bodies[0].messages).toEqual([{ role: "user", content: [{ text: "Where is my replacement?" }, { text: SUFFIX }] }]);
    await niadra.flush();
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Where is my replacement?"],
      ["ai_agent", "Your replacement ships today."],
    ]);
    expect(turns(server)[1]!.item.usage).toEqual({ provider: "bedrock", model: MODEL, prompt_tokens: 2150, cached_tokens: 2000, cache_write_tokens: 0 });
  });

  it("records a streamed answer when the event stream ends", async () => {
    const { server, niadra } = setup();
    const client = new BedrockRuntimeClient({ region: "us-east-1", credentials: { accessKeyId: "a", secretAccessKey: "b" } });
    const sent: unknown[] = [];
    async function* events() {
      yield { messageStart: { role: "assistant" } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Ships " } } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "today." } } };
      yield { messageStop: { stopReason: "end_turn" } };
      yield { metadata: { usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 }, metrics: { latencyMs: 1 } } };
    }
    // The transport of an event stream is binary; the client's own send is replaced one level down.
    client.send = (async (command: unknown) => {
      sent.push(command);
      return { stream: events() };
    }) as never;
    const wrapped = wrapBedrock(client, niadra.conversation({ subject: marina, channel: "web_chat" }));
    const response = await wrapped.send(new ConverseStreamCommand({ modelId: MODEL, messages: [{ role: "user", content: [{ text: "When?" }] }] }));
    let text = "";
    for await (const event of response.stream!) text += event.contentBlockDelta?.delta?.text ?? "";
    expect(text).toBe("Ships today.");
    expect(sent[0]).toBeInstanceOf(ConverseStreamCommand);
    await niadra.flush();
    expect(turns(server).find((turn) => turn.role === "ai_agent")).toMatchObject({ text: "Ships today.", item: { usage: { provider: "bedrock", prompt_tokens: 10 } } });
  });

  it("lets other commands through and leaves the request as it was when Niadra is down", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(503, "unavailable"));
    const { client, bodies } = bedrock();
    const wrapped = wrapBedrock(client, niadra.conversation({ subject: marina, channel: "web_chat" }));
    await wrapped.send(new ConverseCommand({ modelId: MODEL, messages: [{ role: "user", content: [{ text: "hi" }] }] }));
    expect(bodies[0]).toEqual({ messages: [{ role: "user", content: [{ text: "hi" }] }] });
    await wrapped.send(new ListAsyncInvokesCommand({})).catch(() => undefined);
    expect(bodies).toHaveLength(2);
  });

  it("reads Bedrock's usage", () => {
    expect(bedrockUsage({ inputTokens: 5, cacheWriteInputTokens: 100 }, "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0")).toEqual({
      provider: "bedrock", model: "amazon.nova-pro-v1:0", prompt_tokens: 105, cached_tokens: 0, cache_write_tokens: 100,
    });
  });
});
