// Vapi's server URL on Hono. Set the assistant's (or phone number's) server URL to
// https://api.acme.com/vapi with the secret below, and use {{niadra_context}} in the system prompt.
//   NIADRA_API_KEY=... VAPI_SERVER_SECRET=... bun vapi-hono.ts
import { Hono } from "hono";
import { Niadra } from "@niadra/sdk";
import { vapi, vapiTools } from "@niadra/sdk/vapi";

const niadra = new Niadra();
const secret = process.env.VAPI_SERVER_SECRET ?? "";

const handle = vapi({
  niadra,
  secret,
  // A saved assistant; the context arrives in its variables.
  assistant: "YOUR_ASSISTANT_ID",
  // A number to transfer to when the assistant asks for a person.
  transfer: () => ({ destination: { type: "number", number: "+551130000000", message: "Transferring you now." } }),
});

export const app = new Hono();

app.post("/vapi", async (c) => {
  const { status, body } = await handle(await c.req.json(), c.req.raw.headers);
  return c.json(body, status as 200);
});

// The tools to add to the assistant in Vapi, with the SDK's descriptions.
if (process.argv.includes("--print-tools")) {
  console.log(JSON.stringify(vapiTools({ url: "https://api.acme.com/vapi", secret }), null, 2));
}

export default app;
