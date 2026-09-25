// The three ElevenLabs webhooks on Hono, for any runtime Hono runs on (Node, Bun, Deno, Workers).
//   NIADRA_API_KEY=... NIADRA_ELEVENLABS_SECRET=... ELEVENLABS_WEBHOOK_SECRET=... bun elevenlabs-hono.ts
// In ElevenLabs: the agent's initiation webhook -> POST /elevenlabs/initiation with the header
// x-niadra-secret; the post-call webhook -> POST /elevenlabs/post-call; the server tools from
// `toolConfigs()` -> POST /elevenlabs/tools. The system prompt uses {{niadra_context}}.
import { Hono } from "hono";
import { Niadra } from "@niadra/sdk";
import { elevenLabs } from "@niadra/sdk/elevenlabs";

const niadra = new Niadra();
const handlers = elevenLabs({
  niadra,
  secret: process.env.NIADRA_ELEVENLABS_SECRET ?? "",
  webhookSecret: process.env.ELEVENLABS_WEBHOOK_SECRET ?? "",
});

export const app = new Hono();

app.post("/elevenlabs/initiation", async (c) => {
  const { status, body } = await handlers.initiation(await c.req.json(), c.req.raw.headers);
  return c.json(body, status as 200);
});

app.post("/elevenlabs/tools", async (c) => {
  const { status, body } = await handlers.tool(await c.req.json(), c.req.raw.headers);
  return c.json(body, status as 200);
});

app.post("/elevenlabs/post-call", async (c) => {
  // The raw body: the signature covers the exact bytes ElevenLabs sent.
  const { status, body } = await handlers.postCall(await c.req.text(), c.req.raw.headers);
  return c.json(body, status as 200);
});

// The server tool configurations to create in ElevenLabs (API or dashboard), printed once.
if (process.argv.includes("--print-tools")) {
  console.log(JSON.stringify(handlers.toolConfigs({ url: "https://api.acme.com/elevenlabs/tools", secretId: "YOUR_SECRET_ID" }), null, 2));
}

export default app;
