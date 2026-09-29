import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Niadra, silentLogger, tool } from "../src/index.js";
import type { ClaimContractSummary, Handle } from "../src/index.js";
import { Cell } from "./support/cell.js";
import { KEY, marina } from "./helpers.js";

type Json = Record<string, any>;
const contract = (name: string): ClaimContractSummary & { negative_corpus: { phrases: string[] } } =>
  JSON.parse(readFileSync(new URL(`../spec/examples/claim-contract/${name}.json`, import.meta.url), "utf8"));
const RETAIL = contract("retail");
const OTHER: Handle = { type: "phone_e164", value: "+5511998765432" };

function store(): Cell {
  const cell = new Cell();
  for (const feature of ["signals", "coordination"]) cell.features.add(feature);
  cell.claimContract = RETAIL;
  cell.constraints.set(`${marina.type}:${marina.value}`, {
    version: "cv_0123456789abcdef",
    hard: [{ id: "h1", attr: "shoe.size", op: "eq", values: ["42"], source: "stated", scope: "persistent", origin: { kind: "stated" } }],
  } as never);
  return cell;
}

function client(cell: Cell): Niadra {
  return new Niadra({ apiKey: KEY, fetch: cell.fetch, logger: silentLogger, flushOnExit: false, turns: { intervalMs: 3_600_000 }, cache: { ttlMs: 0 } });
}

const searchProducts = tool("search_products", (sku: string) => ({ sku, price_sale: 199.9, price_list: 299.9 }), {
  provenance: (r) => [{ ref: `product:store:${r.sku}`, fields: { price_sale: r.price_sale, price_list: r.price_list } }],
});

/** The example agent: one turn, with its read and its tool, and a follow-up only for who did not opt out. */
async function answer(niadra: Niadra, conversationId: string, reply: string): Promise<{ context: Json; claims: Json[] }> {
  const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: conversationId, agent_id: "store" });
  conversation.customer("Quanto está o PX?");
  return conversation.turn({ build: Niadra.build({ prompts: { store: "v3" }, model: "gpt-x" }) }, async () => {
    const context = await conversation.context({ include: ["constraints"] });
    searchProducts("PX-4471");
    const claims = await conversation.claims.check(reply);
    conversation.agent(reply);
    return { context, claims };
  });
}

describe("the warm cache", () => {
  it("reads the profile once and keeps it", async () => {
    const cell = store();
    const niadra = client(cell);
    const profile = await niadra.profile();
    expect(profile?.features).toEqual(["coordination", "signals", "turns"]);
    cell.failNext("/v1/sdk/profile", 503, 10);
    expect(await niadra.profile()).toBe(profile);
  });

  it("does not ask a space without a profile again for a while", async () => {
    const cell = new Cell();
    cell.features.clear();
    const niadra = client(cell);
    expect(await niadra.profile()).toBeNull();
    cell.features.add("turns");
    expect(await niadra.profile()).toBeNull();
    expect(niadra.turns.recording).toBe(false);
  });

  it("records the constraints block a read served, and leaves a block the space does not serve out", async () => {
    const cell = store();
    const niadra = client(cell);
    await answer(niadra, "c-1", "Sai por R$ 199,90.");
    await niadra.flush();
    const [record] = [...cell.turns.values()];
    expect(record?.reads).toContainEqual({ surface: "constraints", version: "cv_0123456789abcdef" });
    cell.features.delete("signals");
    const context = await niadra.context({ subject: marina, conversation_id: "c-2", include: ["constraints"] });
    expect(context.text).not.toBe("");
    expect(context.constraints ?? null).toBeNull();
  });

  it("counts a turn's claims against its tools", async () => {
    const cell = store();
    const niadra = client(cell);
    const { claims } = await answer(niadra, "c-3", "Sai por R$ 199,90, antes R$ 299,90.");
    expect(claims.map((c) => [c.role, c.verdict, c.action])).toEqual([
      ["price_sale", "matched", "none"],
      ["price_list", "matched", "none"],
    ]);
    expect(claims[0]?.evidence).toEqual({ call_id: "k1", field: "price_sale", ref: "product:store:PX-4471" });
  });

  it("keeps the example agent working with Niadra down, checks claims locally and holds the opt-out", async () => {
    const cell = store();
    await cell.suppress(marina, "marketing");
    const niadra = client(cell);
    await answer(niadra, "c-4", "Sai por R$ 199,90.");
    expect(await niadra.mayContact(marina, { purpose: "marketing" }.purpose)).toBe(false);
    await niadra.flush();
    cell.failNext("/", 503, 10_000);
    const { context, claims } = await answer(niadra, "c-4", "Fica por R$ 149,90.");
    expect(context.source).toBe("fallback");
    expect(context.constraints?.hard?.[0]?.values).toEqual(["42"]);
    expect(claims.map((c) => [c.verdict, c.action])).toEqual([["mismatch", "count"]]);
    expect(await niadra.mayContact(marina, "marketing")).toBe(false);
    expect(await niadra.mayContact(OTHER, "marketing")).toBe(true);
    expect(niadra.turns.pending).toBeGreaterThanOrEqual(1);
    cell.clearFailures();
    await niadra.flush();
    await niadra.flush();
    expect(cell.turns.size).toBe(2);
  });

  it("with no copy and Niadra down, each purpose fails its own way", async () => {
    const cell = store();
    cell.failNext("/", 503, 10_000);
    const niadra = client(cell);
    expect(await niadra.mayContact(OTHER, "marketing")).toBe(false);
    expect(await niadra.mayContact(OTHER, "service")).toBe(true);
    expect(await niadra.mayContact(OTHER, "marketing", { failOpen: true })).toBe(true);
  });

  it("count mode never changes an output", async () => {
    const words = ["Sai", "por", "de", "antes", "frete", "R$", "199,90", "299,90", "12x", "10%", "dia", "20/10", "3", "o"];
    let seed = 7;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let example = 0; example < 60; example++) {
      const pieces = Array.from({ length: 1 + random(20) }, () =>
        random(4) === 0 ? RETAIL.negative_corpus.phrases[random(RETAIL.negative_corpus.phrases.length)] : words[random(words.length)],
      );
      const text = pieces.join(" ");
      const immutable = random(2) === 0;
      const cell = new Cell();
      cell.claimContract = RETAIL;
      const niadra = client(cell);
      const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: `c-p${example}` });
      const claims = await conversation.turn(async () => {
        const found = await conversation.claims.check(text, { context: immutable ? "order_confirmation" : "chat", immutable });
        conversation.agent(text);
        return found;
      });
      await niadra.flush();
      const sent = cell.events.filter((e) => e.speaker?.role === "ai_agent").map((e) => e.content.text);
      expect(sent).toEqual([text]);
      expect(claims.every((c) => c.action === "none" || c.action === "count")).toBe(true);
      expect(claims.every((c) => c.span[0] >= 0 && c.span[0] < c.span[1] && c.span[1] <= Array.from(text).length)).toBe(true);
    }
  });
});
