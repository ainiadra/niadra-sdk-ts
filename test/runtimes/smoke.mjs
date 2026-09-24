// Runs the built package on a runtime other than Node: only web APIs, no Node globals.
// Deno and Bun run this file directly; workerd (Cloudflare Workers) runs it through
// test/runtimes/workerd.mjs. It exports `smoke()`, which throws on the first thing that breaks.
import { Niadra, handles, silentLogger } from "../../dist/index.js";

const KEY = "nia_sk_test_us-east-2_acme-sandbox_k7Qx_s3cr3t";
const CONTEXT = {
  not_modified: false,
  text: "<context>Marina, customer since 2021</context>",
  variables: { name: "Marina" },
  version: "1",
  etag: "etag-1",
  coverage: [],
  verification: { requested: "V1", effective: "V1" },
  withheld: 0,
  live: [],
  live_complete: true,
  timing: { total_ms: 3 },
  path: "t0",
  degraded: false,
};

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function smoke() {
  const calls = [];
  const fetchStub = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    calls.push(`${init.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v1/context") return reply(200, CONTEXT);
    if (url.pathname === "/v1/batch") return reply(200, { accepted: 1, duplicates: 0, errors: [] });
    if (url.pathname === "/v1/media/uploads") return reply(201, { media_ref: "med_1", upload_url: "", expires_at: null });
    return reply(404, { title: "not found", status: 404, code: "not_found" });
  };
  const niadra = new Niadra({ apiKey: KEY, fetch: fetchStub, logger: silentLogger, strict: true, flushOnExit: false });
  const marina = handles.phone("+5511987654321");

  const ctx = await niadra.context({ subject: marina, conversation_id: "wa-1" });
  if (!ctx.text.includes("Marina")) throw new Error(`context text: ${ctx.text}`);

  const convo = niadra.conversation({ subject: marina, conversation_id: "wa-1", channel: "whatsapp" });
  convo.track({ speaker: "customer", content: { text: "oi" } });
  const identified = await niadra.identify({ handles: [marina, handles.email("marina@example.com")] });
  if (!identified.ok) throw new Error(`identify: ${identified.error?.message}`);

  const upload = await niadra.uploadMedia({ data: new Uint8Array([1, 2, 3]), content_type: "image/png" });
  if (!upload.data || upload.data.media_sha256.length !== 64) throw new Error("uploadMedia digest");

  const kit = niadra.tools(marina, { conversation_id: "wa-1" });
  if (!Array.isArray(kit.definitions) || kit.definitions.length === 0) throw new Error("tools definitions");

  await niadra.flush();
  await niadra.shutdown();
  const batches = calls.filter((call) => call === "POST /v1/batch").length;
  if (batches < 1) throw new Error(`no batch sent: ${calls.join(", ")}`);
  return calls.length;
}

const standalone = typeof globalThis.Deno !== "undefined" || typeof globalThis.Bun !== "undefined";
if (standalone) {
  const count = await smoke();
  console.log(`ok ${typeof globalThis.Deno !== "undefined" ? "deno" : "bun"}: ${count} requests`);
}
