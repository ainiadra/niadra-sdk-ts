/**
 * The voice read path against a region 150 to 400 ms away (`src/voice.ts`).
 *
 * `Region` is a fake API behind the client's `fetch` that answers every request after a random
 * delay in that range, the round trip from a caller far from the cell plus the server's time. The
 * tests speak like a voice platform does: partial transcripts while the customer talks, then the
 * platform's end-of-turn delay, then the turn.
 */
import { describe, expect, it } from "vitest";
import { Niadra } from "../src/index.js";
import type { ClientOptions, ContextResponse } from "../src/index.js";
import { covers, wordsOf } from "../src/voice.js";
import { verifyTwilio } from "../src/integrations/twilio.js";
import type { TwilioRequest } from "../src/integrations/twilio.js";
import { KEY, contextBody, marina, spyLogger } from "./helpers.js";

const BODY = "<niadra>Marina, prefers WhatsApp; March: the same reason came up before</niadra>";
/**
 * LiveKit's default minimum endpointing delay is 500 ms; the turns here wait a little more than
 * the slowest read (200 ms of settle plus 400 ms) so the read of the last partial has landed.
 */
const END_OF_TURN = 650;
const TURNS = [
  "e o roteador novo que voces iam mandar",
  "quero saber da fatura de agosto",
  "o credito de quarenta reais ja entrou",
  "entao pode cancelar o chamado",
  "obrigado era isso mesmo",
];

interface Arrival {
  at: number;
  path: string;
  body: Record<string, unknown>;
}

/** A fake region: every answer `latency` ms after the request left, a pinned body with a stable ETag, slots that name their words, each delta once. */
class Region {
  latency: [number, number] = [150, 400];
  t0 = Date.now();
  readonly requests: Arrival[] = [];
  learned: string | null = null;
  failTurns = false;
  private seed = 7;

  reads(): Record<string, unknown>[] {
    return this.requests.filter((r) => r.path === "/v1/context").map((r) => r.body);
  }

  private random(): number {
    // A small linear congruential generator: the same delays on every run.
    this.seed = (this.seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return this.seed / 2_147_483_648;
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = (typeof init.body === "string" ? JSON.parse(init.body) : {}) as Record<string, unknown>;
    this.requests.push({ at: Date.now() - this.t0, path: url.pathname, body });
    const [low, high] = this.latency;
    await sleep(low + (high - low) * this.random(), init.signal ?? undefined);
    return this.answer(url.pathname, body);
  };

  private answer(path: string, body: Record<string, unknown>): Response {
    if (path === "/healthz") return reply(200, { status: "ok" });
    if (path === "/v1/context/prefetch") return reply(202, { queued: true });
    if (path === "/v1/batch") return reply(200, { accepted: 1, duplicates: 0, errors: [] });
    if (path !== "/v1/context") return reply(404, { code: "not_found" });
    if (this.failTurns && body.query) return reply(503, { code: "unavailable", status: 503, title: "unavailable" });
    let payload: ContextResponse = contextBody({ text: BODY, etag: "etag-pinned" });
    if (body.known_etag === "etag-pinned") payload = { ...payload, not_modified: true, text: null, path: "not_modified" };
    if (typeof body.query === "string") payload = { ...payload, slots: `[Slots] ${body.query}` };
    if (body.delta && this.learned) {
      payload = { ...payload, delta: this.learned };
      this.learned = null;
    }
    return reply(200, payload);
  }
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });
}

function client(region: Region, options: ClientOptions = {}): Niadra {
  return new Niadra({ apiKey: KEY, fetch: region.fetch, logger: spyLogger(), flushOnExit: false, ...options });
}

async function speak(convo: { prefetch(text: string): boolean }, text: string, gap = 80): Promise<string> {
  let said = "";
  for (const word of text.split(" ")) {
    said = `${said} ${word}`.trim();
    convo.prefetch(said);
    await sleep(gap);
  }
  return said;
}

async function timed<T>(run: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await run();
  return [value, performance.now() - started];
}

function report(label: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))] ?? 0;
  // The numbers the change is measured by.
  console.log(`${label}: n=${sorted.length} p50=${at(0.5).toFixed(1)} ms p95=${at(0.95).toFixed(1)} ms max=${at(1).toFixed(1)} ms`);
}

describe("the voice read path", () => {
  it("compares words the way speech-to-text revises them", () => {
    expect(wordsOf("Quero saber da FATURA, de agosto?")).toEqual(["quero", "saber", "da", "fatura", "de", "agosto"]);
    expect(wordsOf("é o roteador")).toEqual(wordsOf("e o Roteador"));
    const final = wordsOf("quero saber da fatura de agosto");
    expect(covers(wordsOf("quero saber da fatura de agosto"), final, 0.75)).toBe(true);
    expect(covers(wordsOf("quero saber da fatura de"), final, 0.75)).toBe(true);
    expect(covers(wordsOf("quero saber da fatura"), final, 0.75)).toBe(false);
    expect(covers(wordsOf("quero saber do boleto de agosto"), final, 0.75)).toBe(false);
    expect(covers([], [], 0.75) && !covers([], final, 0.75)).toBe(true);
  });

  it("returns turns after the first in a few ms with the right body", { timeout: 30_000 }, async () => {
    const region = new Region();
    const niadra = client(region);
    const convo = niadra.conversation({ subject: marina, channel: "voice", conversation_id: "call-1" });
    convo.begin(); // the call starts: ringing, the inbound webhook, the caller joining
    await sleep(500); // call setup and the greeting
    const [first, readyTime] = await timed(() => convo.ready());
    expect(first.text).toBe(BODY);
    expect(first.response?.slots ?? null).toBeNull();
    const turnTimes: number[] = [];
    for (const turn of TURNS) {
      const said = await speak(convo, turn);
      await sleep(END_OF_TURN);
      convo.customer(said);
      const [context, elapsed] = await timed(() => convo.context());
      turnTimes.push(elapsed);
      expect(context.text).toBe(BODY);
      expect(context.response?.slots).toBe(`[Slots] ${turn}`);
      convo.markInjected(context);
      convo.agent("Certo.");
    }
    report("voice turns (150-400 ms region)", turnTimes);
    report("first read after call setup", [readyTime]);
    expect(readyTime).toBeLessThan(20);
    expect(Math.max(...turnTimes)).toBeLessThan(20);
    const queries = region.reads().map((b) => b.query).filter(Boolean);
    expect(new Set(queries)).toEqual(new Set(TURNS));
    console.log(`reads of partial transcripts: ${queries.length} for ${TURNS.length} turns`);
    await convo.end();
  });

  it("pays the round trip on every turn without it (the path of 0.5.0)", { timeout: 30_000 }, async () => {
    const region = new Region();
    const niadra = client(region, { voice: false, timeouts: { contextVoice: 150 } });
    const convo = niadra.conversation({ subject: marina, channel: "voice", conversation_id: "call-0" });
    const turnTimes: number[] = [];
    let withSlots = 0;
    for (const turn of TURNS) {
      const said = await speak(convo, turn);
      await sleep(END_OF_TURN);
      convo.customer(said);
      const [context, elapsed] = await timed(() => convo.context());
      turnTimes.push(elapsed);
      if (context.response?.slots) withSlots++;
    }
    report("0.5.0 path, same turns (150-400 ms region)", turnTimes);
    console.log(`0.5.0 path: ${withSlots} of ${TURNS.length} turns got their slots`);
    expect(Math.min(...turnTimes)).toBeGreaterThan(100);
  });

  it("starts the first read with the call, overlapping its setup", async () => {
    const region = new Region();
    region.latency = [350, 350];
    const niadra = client(region);
    const convo = niadra.conversation({ subject: marina, channel: "voice", conversation_id: "call-2" });
    region.t0 = Date.now();
    convo.begin();
    await sleep(400); // the platform answers the call meanwhile
    const [context, waited] = await timed(() => convo.ready());
    const firstRead = region.requests.find((r) => r.path === "/v1/context")?.at ?? Infinity;
    report("first read sent after begin()", [firstRead]);
    report("ready() after 400 ms of setup, 350 ms region", [waited]);
    expect(firstRead).toBeLessThan(20);
    expect(context.text).toBe(BODY);
    expect(waited).toBeLessThan(20);
  });

  it("waits for a first read still running within the start budget, not the turn budget", async () => {
    const region = new Region();
    region.latency = [300, 300];
    const convo = client(region).conversation({ subject: marina, channel: "voice", conversation_id: "call-3" });
    const [context, waited] = await timed(() => convo.ready());
    expect(context.text).toBe(BODY);
    expect(waited).toBeGreaterThan(280);
    expect(waited).toBeLessThan(600);
  });

  it("never waits past the turn budget, and the next turn catches up", async () => {
    const region = new Region();
    region.latency = [400, 400];
    const convo = client(region).conversation({ subject: marina, channel: "voice", conversation_id: "call-4" });
    await convo.ready();
    region.learned = "Envio de roteador novo (open item)";
    convo.customer("e o roteador novo que voces iam mandar"); // never prefetched
    const [late, waited] = await timed(() => convo.context());
    report("turn whose read had not landed (400 ms region)", [waited]);
    expect(late.text).toBe(BODY);
    expect(late.response?.slots ?? null).toBeNull();
    expect(waited).toBeLessThan(250);
    await sleep(300); // the read goes on and lands
    convo.customer("e agora");
    const caught = await convo.context();
    expect(caught.text).toBe(BODY);
    expect(caught.response?.delta).toBe("Envio de roteador novo (open item)");
  });

  it("serves the body without slots when the turn reads fail", { timeout: 10_000 }, async () => {
    const region = new Region();
    const convo = client(region).conversation({ subject: marina, channel: "voice", conversation_id: "call-6" });
    await convo.ready();
    region.failTurns = true;
    const said = await speak(convo, "quero saber da fatura de agosto");
    await sleep(END_OF_TURN);
    convo.customer(said);
    const context = await convo.context();
    expect(context.text).toBe(BODY);
    expect(context.response?.slots ?? null).toBeNull();
  });

  it("answers an empty context within the budget when the region does not answer", async () => {
    const region = new Region();
    region.latency = [5_000, 5_000];
    const convo = client(region).conversation({ subject: marina, channel: "voice", conversation_id: "call-7" });
    convo.customer("alo");
    const [context, waited] = await timed(() => convo.context());
    expect(context.text).toBe("");
    expect(context.source).toBe("none");
    expect(context.error).not.toBeNull();
    expect(waited).toBeLessThan(260);
  });

  it("drops what it kept when the call ends, and keeps no answer that lands after", async () => {
    const region = new Region();
    const niadra = client(region);
    const convo = niadra.conversation({ subject: marina, channel: "voice", conversation_id: "call-8" });
    await convo.ready();
    convo.prefetch("quero saber da fatura de agosto");
    await sleep(250); // a read of the partial is on its way
    void convo.end();
    const internals = niadra as unknown as { voice: { size: number }; core: { cache: { size: number } } };
    expect(internals.voice.size).toBe(0);
    expect(internals.core.cache.size).toBe(0);
    await sleep(500); // the read lands after the end
    expect(internals.core.cache.size).toBe(0);
  });

  it("measures the round trip once and reports a budget that cannot hold it", async () => {
    const region = new Region();
    region.latency = [300, 300];
    const logger = spyLogger();
    const niadra = client(region, { logger });
    await niadra.conversation({ subject: marina, channel: "voice", conversation_id: "call-9" }).ready();
    await sleep(700);
    await niadra.conversation({ subject: marina, channel: "voice", conversation_id: "call-10" }).ready();
    expect(niadra.rtt).toBeGreaterThan(280);
    expect(niadra.rtt).toBeLessThan(360);
    expect(region.requests.filter((r) => r.path === "/healthz")).toHaveLength(2);
    const warnings = logger.warn.mock.calls.map(([message]) => message);
    expect(warnings.some((w) => w.includes("longer than timeouts.contextVoice (200 ms)"))).toBe(true);
    expect(warnings.every((w) => !w.includes("+55"))).toBe(true);
  });

  it("starts an incoming Twilio call's first read once the attestation is recorded", async () => {
    const region = new Region();
    region.latency = [50, 50];
    const niadra = client(region);
    const convo = niadra.conversation({ subject: marina, channel: "voice", conversation_id: "CA-1" });
    const ringing: TwilioRequest = {
      channel: "voice",
      subject: marina,
      conversationId: "CA-1",
      proof: null,
      params: { CallSid: "CA-1", CallStatus: "ringing" },
    };
    region.t0 = Date.now();
    await verifyTwilio(convo, ringing);
    expect(region.requests.some((r) => r.path === "/v1/context")).toBe(true);
    await sleep(80);
    const [context, waited] = await timed(() => convo.ready());
    expect(context.text).toBe(BODY);
    expect(waited).toBeLessThan(20);
    const completed = niadra.conversation({ subject: marina, channel: "voice", conversation_id: "CA-2" });
    await verifyTwilio(completed, { ...ringing, conversationId: "CA-2", params: { CallSid: "CA-2", CallStatus: "completed" } });
    expect(region.reads().filter((b) => b.conversation_id === "CA-2")).toHaveLength(0);
  });
});
