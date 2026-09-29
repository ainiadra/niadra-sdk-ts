import { describe, expect, it } from "vitest";
import { Niadra, ResolverWorker, silentLogger } from "../src/index.js";
import type { StateRef } from "../src/index.js";
import { Cell } from "./support/cell.js";
import { KEY, marina } from "./helpers.js";

const QUOTE = "health_quote:op:q-77";

function setup(): { cell: Cell; niadra: Niadra } {
  const cell = new Cell();
  cell.features.add("state");
  return { cell, niadra: new Niadra({ apiKey: KEY, fetch: cell.fetch, logger: silentLogger, flushOnExit: false, turns: { intervalMs: 3_600_000 } }) };
}

const requote = (): { fields: Record<string, unknown>; version: number } => ({ fields: { price_full: 499.9 }, version: 7 });

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("resolvers and verifyClaim", () => {
  it("verifies a fresh value with Niadra", async () => {
    const { cell, niadra } = setup();
    cell.observe(QUOTE, { price_full: 511.06 });
    expect(await niadra.verifyClaim(QUOTE, "price_full", 511.06)).toMatchObject({ claimSafe: true, source: "niadra", status: "fresh" });
  });

  it("reads a stale value again with the resolver, lets the fresh one decide and records the read", async () => {
    const { cell, niadra } = setup();
    cell.observe(QUOTE, { price_full: 511.06 }, "stale");
    niadra.resolvers.register("health_quote", requote);
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-1" });
    const [old, fresh] = await conversation.turn(async () => [
      await conversation.verifyClaim(QUOTE, "price_full", 511.06),
      await conversation.verifyClaim(QUOTE, "price_full", "499.90"),
    ]);
    expect(old).toMatchObject({ claimSafe: false, matches: false, source: "resolver", value: 499.9 });
    expect(fresh).toMatchObject({ claimSafe: true, status: "fresh" });
    await niadra.flush();
    const [record] = [...cell.turns.values()];
    const calls = (record?.calls as { name: string; observations?: { fields: unknown }[] }[]).filter((c) => c.name === "resolve:health_quote");
    expect(calls[0]?.observations?.[0]?.fields).toEqual({ price_full: 499.9 });
  });

  it("never verifies a stale value without a resolver, and with Niadra down lets only the resolver decide", async () => {
    const { cell, niadra } = setup();
    cell.observe(QUOTE, { price_full: 511.06 }, "stale");
    expect(await niadra.verifyClaim(QUOTE, "price_full", 511.06)).toMatchObject({ claimSafe: false, source: "niadra", status: "stale" });
    cell.failNext("/", 503, 1000);
    expect(await niadra.verifyClaim(QUOTE, "price_full", 499.9)).toMatchObject({ claimSafe: false, source: "none", declaredGaps: ["source_unreachable"] });
    niadra.resolvers.register("health_quote", requote);
    expect((await niadra.verifyClaim(QUOTE, "price_full", 499.9)).claimSafe).toBe(true);
  });

  it("opens a failing resolver's circuit, and verifies nothing past the budget", async () => {
    const { cell, niadra } = setup();
    cell.observe(QUOTE, { price_full: 511.06 }, "stale");
    let calls = 0;
    niadra.resolvers.register("health_quote", () => {
      calls++;
      throw new Error("down");
    });
    for (let i = 0; i < 7; i++) expect((await niadra.verifyClaim(QUOTE, "price_full", 511.06)).claimSafe).toBe(false);
    expect(calls).toBe(5);
    expect(niadra.resolvers.available("health_quote")).toBe(false);
    niadra.resolvers.register("health_quote", () => new Promise((resolve) => setTimeout(() => resolve({ price_full: 511.06 }), 300)));
    const started = performance.now();
    expect((await niadra.verifyClaim(QUOTE, "price_full", 511.06, { budgetMs: 50 })).claimSafe).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("serves refresh requests with the resolvers and pushes what they read", async () => {
    const { cell, niadra } = setup();
    cell.observe(QUOTE, { price_full: 511.06 }, "stale");
    cell.requestRefresh(QUOTE);
    cell.requestRefresh("item_variant:store:991");
    niadra.resolvers.register("health_quote", (ref: StateRef) => ({ fields: { price_full: ref.id === "q-77" ? 499.9 : 0 } }), { rate: 100 });
    const worker = new ResolverWorker(niadra);
    expect(await worker.runOnce()).toBe(1);
    expect(cell.pushes[0]).toMatchObject({ fields: { price_full: 499.9 }, provenance: { source: "live" } });
    expect([...cell.refreshes.values()].map((r) => r.ref.type)).toEqual(["item_variant"]);
    expect((await niadra.verifyClaim(QUOTE, "price_full", 499.9)).claimSafe).toBe(true);
  });

  it("puts back content a pointer-mode space keeps, never flagged content, and only the recorded text", async () => {
    const { cell, niadra } = setup();
    const bucket: Record<string, string> = { "p/1": "Petição inicial, fls. 3.", "p/2": "Texto com instrução embutida.", "p/3": "Outro texto." };
    const fetched: string[] = [];
    const marker = async (pointer: string, text: string, scan = "clean") => ({
      claim_safe: false,
      logic: "yes" as const,
      status: "fresh" as const,
      content: { mode: "pointer" as const, pointer, scan: scan as "clean", sha256: await sha256(text) },
    });
    cell.views.set(`${marina.type}:${marina.value}`, {
      objects: [
        {
          ref: { type: "case_file", namespace: "court", id: "123" },
          fields: { summary: await marker("p/1", bucket["p/1"]!), note: await marker("p/2", bucket["p/2"]!, "flagged"), draft: await marker("p/3", "another text") },
        },
      ],
    });
    niadra.content.register((pointer) => {
      fetched.push(pointer);
      return bucket[pointer]!;
    });
    const context = await niadra.context({ subject: marina, conversation_id: "c-2", include: ["state"] });
    const fields = context.state?.objects?.[0]?.fields ?? {};
    expect(fields.summary?.v).toBe(bucket["p/1"]);
    expect(fields.note?.v ?? null).toBeNull();
    expect(fetched).not.toContain("p/2");
    expect(fields.draft?.v ?? null).toBeNull();
  });
});
