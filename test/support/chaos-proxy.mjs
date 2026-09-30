// An HTTP proxy in front of Niadra that fails on command, for the chaos test (test/chaos.test.ts):
//
//   node test/support/chaos-proxy.mjs --port 8801 --control 8802 --upstream http://127.0.0.1:8800 --log log.jsonl
//
// It runs as its own process, so the test can kill it with SIGKILL: the connections the SDK holds are reset and
// new ones refused, as when Niadra's process dies. `POST /mode` on the control port sets the other failures:
//
// - `up`: every request goes to the upstream and back;
// - `blackhole`: a request is read and never answered, until the mode changes and the connection is dropped;
// - `503`: every request is answered 503 with `Retry-After: 1`, and nothing reaches the upstream;
// - `slow`: every request reaches the upstream at once, and its answer is held `delay` seconds.
//
// Each request is logged as a JSON line: whether it reached the upstream, its status, its idempotency key, and
// for the writes, the turn ids and event keys it carried with the upstream's `accepted` and `duplicates`
// counts. The log is what the test counts deliveries and duplicates by, from outside the SDK. Plain
// JavaScript, so every Node the SDK supports runs it as it is.

import { Buffer } from "node:buffer";
import { appendFileSync } from "node:fs";
import { createServer, request as forward } from "node:http";
import { setTimeout } from "node:timers";
import { gunzipSync } from "node:zlib";

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "host", "proxy-connection"]);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, i, all) => (i % 2 === 0 ? [...pairs, [value.replace(/^--/, ""), all[i + 1]]] : pairs), []),
);
const upstream = new URL(args.upstream);
let mode = "up";
let delay = 0;
const held = new Set();

const log = (entry) => appendFileSync(args.log, `${JSON.stringify(entry)}\n`);

function carried(path, headers, body) {
  if ((path !== "/v1/turns" && path !== "/v1/batch") || body.length === 0) return {};
  let data;
  try {
    data = JSON.parse((headers["content-encoding"] === "gzip" ? gunzipSync(body) : body).toString("utf8"));
  } catch {
    return {};
  }
  if (path === "/v1/turns") return { turns: (data.turns ?? []).map((t) => t.turn_id) };
  const items = data.items ?? [];
  return {
    items: items.filter((i) => (i.type ?? "event") !== "heartbeat").map((i) => i.idempotency_key),
    heartbeats: items.filter((i) => i.type === "heartbeat").length,
  };
}

function counts(body) {
  try {
    const data = JSON.parse(body.toString("utf8"));
    if (data === null || typeof data !== "object") return {};
    return Object.fromEntries(["accepted", "duplicates"].filter((k) => k in data).map((k) => [k, data[k]]));
  } catch {
    return {};
  }
}

function read(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

const proxy = createServer(async (req, res) => {
  const body = await read(req);
  const path = new URL(req.url, "http://proxy").pathname;
  const entry = {
    t: Date.now() / 1000,
    mode,
    method: req.method,
    path,
    key: req.headers["idempotency-key"] ?? null,
    ...carried(path, req.headers, body),
  };
  if (mode === "blackhole") {
    log({ ...entry, forwarded: false });
    held.add(req.socket);
    return;
  }
  if (mode === "503") {
    log({ ...entry, forwarded: false, status: 503 });
    res.writeHead(503, { "content-type": "application/problem+json", "retry-after": "1" });
    res.end('{"title":"unavailable","status":503,"code":"unavailable"}');
    return;
  }
  const slow = mode === "slow" ? delay : 0;
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP.has(name)));
  const out = forward({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers }, async (answer) => {
    const answerBody = await read(answer);
    log({ ...entry, forwarded: true, status: answer.statusCode, ...counts(answerBody) });
    const answerHeaders = Object.fromEntries(Object.entries(answer.headers).filter(([name]) => !HOP.has(name)));
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(answer.statusCode ?? 502, { ...answerHeaders, "content-length": answerBody.length });
      res.end(answerBody);
    }, slow * 1000);
  });
  out.on("error", () => res.destroy());
  out.end(body);
});
proxy.keepAliveTimeout = 60_000;
proxy.on("clientError", (_error, socket) => socket.destroy());

const control = createServer(async (req, res) => {
  if (req.method === "POST") {
    const body = JSON.parse((await read(req)).toString("utf8") || "{}");
    mode = body.mode;
    delay = Number(body.delay ?? 0);
    if (mode !== "blackhole") {
      for (const socket of held) socket.destroy();
      held.clear();
    }
    res.writeHead(204).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ mode }));
});

proxy.listen(Number(args.port), "127.0.0.1");
control.listen(Number(args.control), "127.0.0.1");
