// Runs @niadra/sdk/cloudflare-agents from the build the way an Agent (a Durable Object) uses it:
// the helper bound to the instance, the context in the messages, a tool call and the writes handed
// to ctx.waitUntil. test/runtimes/workerd.mjs bundles this file and runs it inside workerd.
import { Niadra, handles, silentLogger } from "../../dist/index.js";
import { niadraAgent } from "../../dist/cloudflare-agents.js";

const KEY = "nia_sk_test_us-east-2_acme-sandbox_k7Qx_s3cr3t";
const CONTEXT = {
  not_modified: false,
  text: "<context>Marina, customer since 2021</context>",
  variables: {},
  version: "1",
  etag: "etag-1",
  coverage: [],
  verification: { requested: "V0", effective: "V0" },
  withheld: 0,
  live: [],
  live_complete: true,
  timing: { total_ms: 3 },
  path: "t0",
  degraded: false,
};

function reply(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

export async function agents() {
  const calls = [];
  const fetchStub = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    calls.push(`${init.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v1/context") return reply(CONTEXT);
    if (url.pathname === "/v1/history/search") return reply({ items: [], withheld: 0, tokens_used: 1 });
    return reply({ accepted: 1, duplicates: 0, errors: [] });
  };
  const niadra = new Niadra({ apiKey: KEY, fetch: fetchStub, logger: silentLogger, strict: true, flushOnExit: false });
  const waited = [];
  const agent = { name: "chat-42", ctx: { waitUntil: (promise) => waited.push(promise) } };
  const memory = niadraAgent(agent, { niadra, subject: handles.appUserId("user-42") });
  if (niadraAgent(agent, { niadra }) !== memory) throw new Error("one helper per instance");

  const messages = await memory.prepare([{ role: "system", content: "You are Acme's support agent." }, { role: "user", content: "hi" }]);
  if (messages[1]?.content !== CONTEXT.text) throw new Error(`prepare: ${JSON.stringify(messages)}`);
  const tools = memory.tools();
  const search = tools.search_customer_history;
  if (!search || typeof search.execute !== "function") throw new Error("tools");
  await search.execute({ query: "refund" }, { toolCallId: "c1", messages: [] });
  memory.record("Hello Marina.");
  await Promise.all(waited);
  if (!calls.includes("POST /v1/batch") || !calls.includes("POST /v1/history/search")) throw new Error(`calls: ${calls.join(", ")}`);
  return 4;
}
