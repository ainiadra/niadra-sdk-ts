import { GoogleGenAI } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { googleUsage, wrapGoogleGenAI } from "../../src/integrations/google-genai.js";
import { problem } from "../helpers.js";
import { PACK, SUFFIX, marina, setup, turns } from "./support.js";

const answer = {
  candidates: [{ content: { role: "model", parts: [{ text: "Your replacement " }, { text: "ships today." }] }, finishReason: "STOP", index: 0 }],
  usageMetadata: { promptTokenCount: 2200, cachedContentTokenCount: 2048, candidatesTokenCount: 8, totalTokenCount: 2208 },
  modelVersion: "gemini-2.5-flash-001",
};

/** The real Gen AI SDK over a fetch that answers like the API and keeps the request bodies. */
function genai(reply: (url: string) => Response) {
  const bodies: any[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : input instanceof Request ? await input.text() : "{}"));
    return reply(url);
  });
  return { client: new GoogleGenAI({ apiKey: "test" }), bodies };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google Gen AI: wrapGoogleGenAI", () => {
  it("adds the pack after the system instruction and the suffix to the last user content, and records both turns", async () => {
    const { server, niadra } = setup();
    const convo = niadra.conversation({ subject: marina, channel: "web_chat", conversation_id: "gg-1" });
    const { client, bodies } = genai(() => Response.json(answer));
    const ai = wrapGoogleGenAI(client, convo);

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        { role: "user", parts: [{ text: "hi" }] },
        { role: "model", parts: [{ text: "Hello!" }] },
        { role: "user", parts: [{ text: "Where is my replacement?" }] },
      ],
      config: { systemInstruction: "You are Acme's support agent." },
    });

    expect(response.text).toBe("Your replacement ships today.");
    expect(bodies[0].systemInstruction.parts.map((part: any) => part.text).join("")).toBe(`You are Acme's support agent.\n\n${PACK}`);
    expect(bodies[0].contents.at(-1)).toEqual({ role: "user", parts: [{ text: "Where is my replacement?" }, { text: SUFFIX }] });
    await niadra.flush();
    expect(turns(server).map((turn) => [turn.role, turn.text])).toEqual([
      ["customer", "Where is my replacement?"],
      ["ai_agent", "Your replacement ships today."],
    ]);
    expect(turns(server)[1]!.item.usage).toEqual({ provider: "google", model: "gemini-2.5-flash-001", prompt_tokens: 2200, cached_tokens: 2048, cache_write_tokens: 0 });
  });

  it("takes a plain string as the contents and records a streamed answer", async () => {
    const { server, niadra } = setup();
    const chunks = [
      { candidates: [{ content: { role: "model", parts: [{ text: "Ships " }] }, index: 0 }] },
      { ...answer, candidates: [{ content: { role: "model", parts: [{ text: "today." }] }, finishReason: "STOP", index: 0 }] },
    ];
    const { client, bodies } = genai(() =>
      new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
    );
    const ai = wrapGoogleGenAI(client, niadra.conversation({ subject: marina, channel: "web_chat" }));
    let text = "";
    for await (const chunk of await ai.models.generateContentStream({ model: "gemini-2.5-flash", contents: "When?" })) text += chunk.text ?? "";
    expect(text).toBe("Ships today.");
    expect(bodies[0].contents).toEqual([{ role: "user", parts: [{ text: "When?" }, { text: SUFFIX }] }]);
    expect(bodies[0].systemInstruction.parts[0].text).toBe(PACK);
    await niadra.flush();
    expect(turns(server).find((turn) => turn.role === "ai_agent")?.item.usage).toMatchObject({ cached_tokens: 2048 });
  });

  it("leaves the request as it was when Niadra is down", async () => {
    const { server, niadra } = setup();
    server.on("POST /v1/context", problem(503, "unavailable"));
    const { client, bodies } = genai(() => Response.json(answer));
    const ai = wrapGoogleGenAI(client, niadra.conversation({ subject: marina, channel: "web_chat" }));
    await ai.models.generateContent({ model: "gemini-2.5-flash", contents: "hi", config: { systemInstruction: "S" } });
    expect(bodies[0].systemInstruction.parts[0].text).toBe("S");
    expect(bodies[0].contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("reads usageMetadata", () => {
    expect(googleUsage({ usageMetadata: { promptTokenCount: 10 } }, "models/gemini-2.5-pro")).toEqual({
      provider: "google", model: "gemini-2.5-pro", prompt_tokens: 10, cached_tokens: 0, cache_write_tokens: 0,
    });
    expect(googleUsage({}, "gemini")).toBeNull();
  });
});
