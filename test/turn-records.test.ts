import { describe, expect, it } from "vitest";
import { Niadra, TurnFrame, currentTurn, silentLogger, tool } from "../src/index.js";
import type { ClientOptions } from "../src/index.js";
import { TurnQueue } from "../src/capture/queue.js";
import { Cell } from "./support/cell.js";
import { KEY, marina } from "./helpers.js";

type Json = Record<string, any>;

function client(cell: Cell, options: ClientOptions = {}): Niadra {
  return new Niadra({ apiKey: KEY, fetch: cell.fetch, logger: silentLogger, flushOnExit: false, turns: { intervalMs: 3_600_000 }, ...options });
}

const records = (cell: Cell): Json[] => [...cell.turns.values()];

const quote = tool("quote", (plan: string) => ({ plan, price_full: 511.06 }));
const stock = tool("stock", async (sku: string) => ({ sku, qty: 3 }), {
  provenance: (r) => [{ ref: `item_variant:store:${r.sku}`, fields: { qty: r.qty } }],
});

describe("turn records", () => {
  it("record a turn's read, its tools and what the agent said", async () => {
    const cell = new Cell();
    const niadra = client(cell);
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-1", agent_id: "store" });
    await conversation.turn({ build: Niadra.build({ prompts: { core: "v16" }, model: "gpt-x" }) }, async () => {
      await conversation.context();
      quote("ouro");
      await stock("PX");
      conversation.agent("Sai por R$ 511,06.");
    });
    await niadra.flush();
    const [record] = records(cell);
    expect(record?.conversation_id).toBe("c-1");
    expect(record?.agent).toEqual({ name: "store" });
    expect(record?.build.pins).toEqual({ prompts: { core: "v16" }, model: "gpt-x", niadra: { compiler: "compiler-1", pack_hash: "etag-1" } });
    expect(record?.reads).toEqual([{ surface: "pack", etag: "etag-1", blob: expect.any(String) }]);
    expect(record?.blobs[record.reads[0].blob]?.content.etag).toBe("etag-1"); // the pack it served
    const [first, second] = record?.calls as Json[];
    expect([first?.name, first?.status, second?.name]).toEqual(["quote", "ok", "stock"]);
    expect(record?.blobs[first?.args].content).toBe("ouro");
    expect(record?.blobs[first?.result_model].content).toEqual({ plan: "ouro", price_full: 511.06 });
    expect(first?.args_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second?.observations).toEqual([{ ref: "item_variant:store:PX", fields: { qty: 3 } }]);
    expect((record?.output as Json).event_keys).toHaveLength(1);
  });

  it("copy on the spot: a later change to the agent's objects never reaches the record", async () => {
    const cell = new Cell();
    const niadra = client(cell);
    const cart = { items: ["a"] };
    const add = tool("add", (c: typeof cart) => c);
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-2" });
    await conversation.turn(() => {
      add(cart);
      cart.items.push("b");
    });
    await niadra.flush();
    const [record] = records(cell);
    const [call] = record?.calls as Json[];
    expect(record?.blobs[call?.args].content).toEqual({ items: ["a"] });
  });

  it("parallel sub-agents never mix their turns", async () => {
    const cell = new Cell();
    const niadra = client(cell);
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-3" });
    const sub = (name: string, sku: string) =>
      conversation.turn({ agent: name }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await stock(sku);
        return currentTurn()?.turnId;
      });
    const outer = await conversation.turn(async (frame) => {
      const [left, right] = await Promise.all([sub("left", "a1"), sub("right", "b2")]);
      return { outer: frame.turnId, left, right };
    });
    await niadra.flush();
    const byId = new Map(records(cell).map((r) => [r.turn_id, r]));
    for (const [id, sku, name] of [[outer.left, "a1", "left"], [outer.right, "b2", "right"]] as const) {
      const record = byId.get(id!)!;
      expect(record.agent).toEqual({ name, parent_turn_id: outer.outer });
      expect((record.calls as Json[]).map((c) => record.blobs[c.args].content)).toEqual([sku]);
    }
  });

  it("a call inside a tool names it as its parent, and a failing tool flags the turn", async () => {
    const cell = new Cell();
    const niadra = client(cell);
    const inner = tool("inner", () => 1);
    const outer = tool("outer", () => inner());
    const broken = tool("broken", () => {
      throw new Error("the tool failed");
    });
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-4" });
    await conversation.turn(() => {
      outer();
      expect(() => broken()).toThrow("the tool failed");
    });
    await niadra.flush();
    const [record] = records(cell);
    const calls = record?.calls as Json[];
    expect(calls.map((c) => [c.name, c.parent_call_id ?? null, c.status])).toEqual([
      ["outer", null, "ok"],
      ["inner", "k1", "ok"],
      ["broken", null, "error"],
    ]);
    expect(record?.flags).toContain("error");
  });

  it("outside a turn a tool runs untouched", () => {
    expect(quote("prata")).toEqual({ plan: "prata", price_full: 511.06 });
  });

  it("pointer mode keeps the values in the company's store, and a store that fails sends digests only", async () => {
    const cell = new Cell();
    const niadra = client(cell);
    const bucket = new Map<string, string>();
    niadra.turns.store((key, data) => {
      bucket.set(key, data);
      return `s3://acme-turns/${key}`;
    });
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-5" });
    await conversation.turn(() => quote("ouro"));
    await niadra.flush();
    const [record] = records(cell);
    expect(record?.content_mode).toBe("pointer");
    for (const blob of Object.values(record?.blobs as Json)) {
      expect(blob.content).toBeUndefined();
      expect(bucket.get(String(blob.pointer).replace("s3://acme-turns/", ""))).toBeDefined();
    }
    niadra.turns.store(() => {
      throw new Error("denied");
    });
    await conversation.turn(() => quote("prata"));
    await niadra.flush();
    const second = records(cell)[1];
    expect([second?.content_mode, second?.completeness]).toEqual(["hash_only", "partial"]);
  });

  it("a space without turn records turns recording off, and an outage keeps the turns for later", async () => {
    const cell = new Cell();
    const niadra = client(cell);
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-6" });
    cell.failNext("/v1/turns", 503, 1);
    await conversation.turn(() => quote("ouro"));
    await niadra.flush();
    expect(records(cell)).toHaveLength(0);
    expect(niadra.turns.pending).toBe(1);
    await niadra.flush();
    expect(records(cell)).toHaveLength(1);
    cell.features.clear();
    cell.failNext("/v1/turns", 404, 1);
    await conversation.turn(() => quote("prata"));
    await niadra.flush();
    expect(niadra.turns.recording).toBe(false);
  });

  it("a full queue drops values before frames, and past its count the oldest turns", () => {
    const queue = new TurnQueue(4000, 3, 1000, 50, silentLogger);
    const frames = [0, 1, 2].map(() => {
      const frame = new TurnFrame({ submit: () => undefined }, { agent: "a", conversationId: "c" });
      frame.blob("x".repeat(1200));
      frame.close();
      return frame;
    });
    frames[0]?.flag("error");
    for (const frame of frames) queue.put(frame);
    expect(queue.valuesDropped).toBe(1);
    expect(frames[0]?.blobs.size).toBe(1); // the flagged turn keeps its values longest
    expect(frames[1]?.completeness).toBe("partial");
    expect(queue.turnsDropped).toBe(0);
    const extra = new TurnFrame({ submit: () => undefined }, { agent: "a", conversationId: "c" });
    queue.put(extra);
    expect(queue.turnsDropped).toBe(1);
    expect(queue.length).toBe(3);
  });

  it("a turn without a pin the space requires is kept, with one warning", async () => {
    const cell = new Cell();
    const warnings: string[] = [];
    const logger = { debug: () => undefined, warn: (message: string) => warnings.push(message), error: () => undefined };
    const niadra = client(cell, { logger });
    niadra.turns.requiredPins = () => ["prompts", "model"];
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-9" });
    for (let i = 0; i < 2; i++) await conversation.turn({ build: Niadra.build({ model: "model-a" }) }, () => quote("ouro"));
    await conversation.turn({ build: Niadra.build({ prompts: { core: "v1" }, model: "model-a" }) }, () => quote("ouro"));
    await niadra.flush();
    expect(records(cell)).toHaveLength(3);
    expect(warnings.filter((w) => w.includes("cannot be replayed"))).toEqual([
      expect.stringContaining("turns without the prompts pin are kept but cannot be replayed"),
    ]);
  });

  it("closing a turn never waits for the sender", async () => {
    const cell = new Cell();
    const niadra = client(cell, { fetch: () => new Promise<Response>(() => undefined) });
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-7" });
    const started = performance.now();
    for (let i = 0; i < 20; i++) await conversation.turn(() => quote("ouro"));
    expect(performance.now() - started).toBeLessThan(200);
    expect(niadra.turns.pending).toBe(20);
  });

  it.each([25, 150])("a recorded tool call costs under 2 ms at the 95th percentile for a %i KB result", async (kilobytes) => {
    const cell = new Cell();
    const niadra = client(cell);
    const payload = { items: Array.from({ length: kilobytes * 10 }, (_, i) => ({ sku: `sku-${i}`, name: "x".repeat(80) })) };
    const search = tool("search", () => payload);
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-8" });
    // The best of three rounds: the budget is the capture's cost, not the machine's other work.
    const rounds: number[] = [];
    for (let round = 0; round < 3; round++) {
      const times: number[] = [];
      await conversation.turn(() => {
        for (let i = 0; i < 200; i++) {
          const started = performance.now();
          search();
          times.push(performance.now() - started);
        }
      });
      times.sort((a, b) => a - b);
      rounds.push(times[Math.floor(times.length * 0.95)]!);
    }
    expect(Math.min(...rounds)).toBeLessThan(2);
  });
});
