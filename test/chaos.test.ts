// With Niadra down, the agent goes on: the chaos test of the SDK in the agent's process.
//
// A conversation runs one good turn, then Niadra goes down in one of four ways while three more turns run, 1.5 s
// apart, then it comes back. The SDK talks to Niadra through test/support/chaos-proxy.mjs, a process of its own:
//
// - `killed`: the proxy process gets SIGKILL, so the SDK's connections are reset and new ones refused;
// - `blackhole`: requests are taken and never answered;
// - `503`: every request is answered 503;
// - `slow`: every request reaches Niadra, and its answer comes back after every deadline, 5 s writes included.
//
// For each, during the outage:
//
// - a turn (a read, then two checks before outbound contacts) ends within the SDK's documented budgets, 300 ms
//   for a chat read and 200 ms for each check;
// - the read serves the last good pack (`fallback`) with its age, never an empty one;
// - the customer's opt-out of marketing and of service, recorded before the conversation, holds: both checks
//   deny with `suppressed`, and nothing goes out;
//
// and once Niadra is back, every turn record, event and declaration made during the outage arrives, each
// stored once. The proxy's log is the witness: what reached Niadra and what Niadra took.
//
// Without a cell, Niadra is the stand-in of test/support/cell.ts served over HTTP by this process. With
// NIADRA_CHAOS_API, NIADRA_CHAOS_KEY and NIADRA_CHAOS_SUBJECT set, it is that cell, where the subject must have
// memory already. NIADRA_CHAOS_REPORT names a file that gets one JSON line of measures per run.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUTS, Niadra, canonicalDestination, silentLogger, suppressionKey } from "../src/index.js";
import type { CheckResult, ContextResult, Handle } from "../src/index.js";
import { CHECK_BUDGET_MS } from "../src/coordination/client.js";
import { Cell } from "./support/cell.js";

const MODES = ["killed", "blackhole", "503", "slow"] as const;
type Mode = (typeof MODES)[number];
const OUTAGE_TURNS = 3;
/** How late a `slow` answer comes: past every budget, the 5 s of a background write included. */
const SLOW_S = 6;
/** The customer's pause between turns: an outage of seconds, past the retries of a single request. */
const TURN_GAP_MS = 1_500;
const OPTED_OUT = ["marketing", "service"] as const;
const READ_BUDGET_MS = DEFAULT_TIMEOUTS.context;
const TURN_BUDGET_MS = READ_BUDGET_MS + OPTED_OUT.length * CHECK_BUDGET_MS;
/** Scheduling on a loaded test machine, per call. */
const SLACK_MS = 50;
const DRAIN_TIMEOUT_MS = 90_000;
const PROXY = fileURLToPath(new URL("./support/chaos-proxy.mjs", import.meta.url));

interface Entry {
  t: number;
  path: string;
  forwarded?: boolean;
  status?: number;
  key?: string | null;
  turns?: string[];
  items?: string[];
  heartbeats?: number;
  accepted?: number;
  duplicates?: number;
}

/** The proxy's log: what reached Niadra, and what Niadra took. */
class Ledger {
  constructor(readonly entries: Entry[]) {}

  static read(log: string, since = 0): Ledger {
    if (!existsSync(log)) return new Ledger([]);
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
    return new Ledger(lines.map((line) => JSON.parse(line) as Entry).filter((e) => e.t >= since));
  }

  taken(path: string): Entry[] {
    return this.entries.filter((e) => e.path === path && e.forwarded === true && (e.status ?? 0) >= 200 && (e.status ?? 0) < 300);
  }

  turnIds(): Set<string> {
    return new Set(this.taken("/v1/turns").flatMap((e) => e.turns ?? []));
  }

  turnsAccepted(): number {
    return this.taken("/v1/turns").reduce((sum, e) => sum + (e.accepted ?? 0), 0);
  }

  eventKeys(): Set<string> {
    return new Set(this.taken("/v1/batch").flatMap((e) => e.items ?? []));
  }

  /** Events Niadra stored: accepted items, less the heartbeats among them. */
  eventsAccepted(): number {
    return this.taken("/v1/batch").reduce((sum, e) => sum + (e.accepted ?? 0) - (e.heartbeats ?? 0), 0);
  }

  declarationKeys(): Set<string> {
    return new Set(this.taken("/v1/coordination/declare").map((e) => e.key ?? ""));
  }

  /** Writes Niadra saw again and did not store twice (a resend after an answer the SDK never got). */
  duplicates(): number {
    return [...this.taken("/v1/turns"), ...this.taken("/v1/batch")].reduce((sum, e) => sum + (e.duplicates ?? 0), 0);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** test/support/chaos-proxy.mjs as a child process, in front of `upstream`. */
class Proxy {
  private child: ChildProcess | null = null;

  private constructor(
    readonly upstream: string,
    readonly log: string,
    readonly port: number,
    readonly control: number,
  ) {}

  static async create(upstream: string, log: string): Promise<Proxy> {
    return new Proxy(upstream, log, await freePort(), await freePort());
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const args = ["--port", String(this.port), "--control", String(this.control), "--upstream", this.upstream, "--log", this.log];
    this.child = spawn(process.execPath, [PROXY, ...args], { stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if ((await listening(this.port)) && (await listening(this.control))) return;
      await sleep(20);
    }
    throw new Error("the chaos proxy did not start");
  }

  /** SIGKILL: open connections are reset and new ones refused. */
  async kill(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }

  async mode(mode: string, delayS = 0): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${this.control}/mode`, { method: "POST", body: JSON.stringify({ mode, delay: delayS }) });
    expect(response.status).toBe(204);
  }
}

interface Side {
  url: string;
  key: string;
  subject: Handle;
  close(): Promise<void>;
}

/** The stand-in cell over HTTP, with the turns and coordination features on and the opt-outs recorded. */
async function standIn(): Promise<Side> {
  const cell = new Cell();
  cell.features.add("coordination");
  const subject: Handle = { type: "phone_e164", value: "+5511900007002" };
  for (const purpose of OPTED_OUT) await cell.suppress(subject, purpose);
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const headers = Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, String(value)]));
      const init: RequestInit = { method: req.method ?? "GET", headers };
      if (body.length > 0) init.body = new Uint8Array(body);
      void cell.fetch(`http://cell${req.url ?? "/"}`, init).then(async (answer) => {
        const bytes = Buffer.from(await answer.arrayBuffer());
        res.writeHead(answer.status, { ...Object.fromEntries(answer.headers.entries()), "content-length": bytes.length });
        res.end(bytes);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    key: "nia_sk_test_sa-east-1_acme-sandbox_k7Qx_s3cr3t_with_underscores",
    subject,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A running cell: the opt-outs are declared by the same source before the conversation, and read back. */
async function cell(api: string, key: string, value: string): Promise<Side> {
  const subject: Handle = { type: "phone_e164", value };
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  for (const purpose of OPTED_OUT) {
    const body = { kind: "suppression.added", agent: "chaos-setup", subject, detail: { purpose, reason: "opt_out" } };
    const declared = await fetch(`${api}/v1/coordination/declare`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": `chaos-${crypto.randomUUID()}` },
      body: JSON.stringify(body),
    });
    expect(declared.ok).toBe(true);
  }
  const { salt } = (await (await fetch(`${api}/v1/suppressions/salt`, { headers })).json()) as { salt: string };
  const mine = await suppressionKey(salt, canonicalDestination(subject.type, subject.value));
  const deadline = Date.now() + 60_000;
  for (;;) {
    const page = (await (await fetch(`${api}/v1/suppressions?limit=200`, { headers })).json()) as { items: { key: string; purpose: string; removed?: boolean }[] };
    if (OPTED_OUT.every((p) => page.items.some((e) => e.key === mine && e.purpose === p && e.removed !== true))) break;
    if (Date.now() > deadline) throw new Error("the opt-out did not reach the suppression list");
    await sleep(500);
  }
  return { url: api.replace(/\/$/, ""), key, subject, close: async () => undefined };
}

interface Turn {
  ms: number;
  readMs: number;
  checkMs: number[];
  context: ContextResult;
  decisions: Record<string, CheckResult>;
  turnId: string;
}

type Conversation = ReturnType<Niadra["conversation"]>;

async function runTurn(conversation: Conversation, n: number): Promise<Turn> {
  const started = performance.now();
  conversation.customer(`Turno ${n}: e a troca do pedido 4471?`);
  return conversation.turn(async (frame) => {
    const read = performance.now();
    const context = await conversation.context();
    const readMs = performance.now() - read;
    const decisions: Record<string, CheckResult> = {};
    const checkMs: number[] = [];
    for (const purpose of OPTED_OUT) {
      const at = performance.now();
      decisions[purpose] = await conversation.check("follow_up", { purpose, channel: "whatsapp" });
      checkMs.push(performance.now() - at);
    }
    conversation.agent(`Resposta ${n}: a troca do 4471 segue aberta.`);
    return { ms: performance.now() - started, readMs, checkMs, context, decisions, turnId: frame.turnId };
  });
}

async function waitDrained(log: string, since: number, turnIds: Set<string>, events: number, declarations: number): Promise<{ drainS: number; ledger: Ledger }> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  for (;;) {
    const ledger = Ledger.read(log);
    const ids = ledger.turnIds();
    if ([...turnIds].every((id) => ids.has(id)) && ledger.eventKeys().size >= events && ledger.declarationKeys().size >= declarations) {
      const after = Ledger.read(log, since).entries.filter((e) => e.forwarded === true && (e.status ?? 0) >= 200 && (e.status ?? 0) < 300);
      const last = Math.max(since, ...after.map((e) => e.t));
      return { drainS: last - since, ledger };
    }
    if (Date.now() > deadline) {
      throw new Error(`not drained: turns ${ids.size}/${turnIds.size}, events ${ledger.eventKeys().size}/${events}, declarations ${ledger.declarationKeys().size}`);
    }
    await sleep(50);
  }
}

describe("with Niadra down, the agent goes on", () => {
  let side: Side;
  let proxy: Proxy;

  beforeEach(async () => {
    const { NIADRA_CHAOS_API: api, NIADRA_CHAOS_KEY: key, NIADRA_CHAOS_SUBJECT: subject } = process.env;
    side = api && key && subject ? await cell(api, key, subject) : await standIn();
    proxy = await Proxy.create(side.url, join(mkdtempSync(join(tmpdir(), "niadra-chaos-")), "requests.jsonl"));
    await proxy.start();
  });

  afterEach(async () => {
    await proxy.kill();
    await side.close();
  });

  it.each(MODES)("%s", { timeout: 180_000 }, async (mode: Mode) => {
    // Every read goes to the network, so every outage turn takes the failing path; with the default cache a
    // conversation's turns inside 10 minutes are served from memory at once.
    const niadra = new Niadra({
      apiKey: side.key,
      baseURL: proxy.url,
      logger: silentLogger,
      flushOnExit: false,
      cache: { ttlMs: 0, staleWhileRevalidateMs: 0 },
    });
    const conversation = niadra.conversation({ subject: side.subject, channel: "whatsapp", conversation_id: `chaos-${mode}-${crypto.randomUUID().slice(0, 8)}` });
    const receipt = { purpose: "transactional", channel: "whatsapp", effectKey: `receipt:${crypto.randomUUID().slice(0, 12)}` };

    const first = await runTurn(conversation, 0);
    const good = first.context;
    expect(good.source).toBe("network");
    expect(good.text).not.toBe("");
    expect(good.ageMs).toBe(0);
    for (const decision of Object.values(first.decisions)) expect(decision.reasons).toEqual(["suppressed"]);
    const reserved = await conversation.check("receipt", receipt);
    expect(reserved.decision).toBe("allow");
    expect(reserved.effect?.state).toBe("none");
    const copy = (niadra as unknown as { suppressions: { held: boolean } }).suppressions;
    for (const deadline = Date.now() + 10_000; !copy.held; await sleep(20)) {
      if (Date.now() > deadline) throw new Error("the checks never read the suppression list");
    }
    await niadra.flush();

    if (mode === "killed") await proxy.kill();
    else await proxy.mode(mode, mode === "slow" ? SLOW_S : 0);
    // The receipt left before the outage; its declaration is made now and waits in the outbox.
    conversation.declare.effect(receipt.effectKey, "done");
    const outage: Turn[] = [];
    const contacts: string[] = [];
    for (let n = 1; n <= OUTAGE_TURNS; n++) {
      await sleep(TURN_GAP_MS);
      const turn = await runTurn(conversation, n);
      outage.push(turn);
      for (const [purpose, decision] of Object.entries(turn.decisions)) if (decision.decision === "allow") contacts.push(purpose);
    }
    for (const purpose of OPTED_OUT) expect(await niadra.mayContact(side.subject, purpose, { channel: "whatsapp" })).toBe(false);

    for (const turn of outage) {
      expect(turn.readMs).toBeLessThanOrEqual(READ_BUDGET_MS + SLACK_MS);
      for (const ms of turn.checkMs) expect(ms).toBeLessThanOrEqual(CHECK_BUDGET_MS + SLACK_MS);
      expect(turn.ms).toBeLessThanOrEqual(TURN_BUDGET_MS + 3 * SLACK_MS);
      expect(turn.context.text).toBe(good.text);
      expect(turn.context.source).toBe("fallback");
      expect(turn.context.ageMs).toBeGreaterThan(0);
      for (const decision of Object.values(turn.decisions)) {
        expect(decision.decision).toBe("deny");
        expect(decision.reasons).toEqual(["suppressed"]);
      }
    }
    expect(contacts).toEqual([]);
    const ages = outage.map((t) => t.context.ageMs ?? 0);
    expect(ages).toEqual([...ages].sort((a, b) => a - b));

    const restored = Date.now() / 1000;
    if (mode === "killed") await proxy.start();
    else await proxy.mode("up");
    const turnIds = new Set([first.turnId, ...outage.map((t) => t.turnId)]);
    const events = 2 * (1 + OUTAGE_TURNS);
    const { drainS, ledger } = await waitDrained(proxy.log, restored, turnIds, events, 1);
    const after = await conversation.check("receipt", receipt);
    expect(after.effect?.state).toBe("done");
    await niadra.shutdown();

    // Each write stored once: Niadra's own counts over every request that reached it.
    expect(ledger.turnIds()).toEqual(turnIds);
    expect(ledger.turnsAccepted()).toBe(turnIds.size);
    expect(ledger.eventKeys().size).toBe(events);
    expect(ledger.eventsAccepted()).toBe(events);
    expect(ledger.declarationKeys().size).toBe(1);

    const measures = {
      sdk: "typescript",
      mode,
      turn_ms: outage.map((t) => Math.round(t.ms * 10) / 10),
      read_ms: outage.map((t) => Math.round(t.readMs * 10) / 10),
      age_ms: ages.map((a) => Math.round(a)),
      drain_s: Math.round(drainS * 100) / 100,
      resent_duplicates: ledger.duplicates(),
    };
    const report = process.env.NIADRA_CHAOS_REPORT;
    if (report) appendFileSync(report, `${JSON.stringify(measures)}\n`);
  });
});
