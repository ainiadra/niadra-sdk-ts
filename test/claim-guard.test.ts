import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Guard, Niadra, TurnFrame, guardStream, guardText, silentLogger } from "../src/index.js";
import type { ClaimContractSummary } from "../src/index.js";
import { Cell } from "./support/cell.js";
import { KEY, marina } from "./helpers.js";

const contract = (name: string): ClaimContractSummary => JSON.parse(readFileSync(new URL(`../spec/examples/claim-contract/${name}.json`, import.meta.url), "utf8"));
const HEALTH = contract("health-plan-sales");
const RETAIL = contract("retail");
const QUOTE = "health_quote:op:q-77";
const CAVEAT = "Não consigo cotar plano empresarial por aqui; já te passo para quem cota.";

function frame(agent = "sales"): TurnFrame {
  const turn = new TurnFrame(null, { agent, conversationId: "c-1" });
  turn.observeState([{ ref: QUOTE, field: "price_full", value: 511.06, claimSafe: false, role: "price_full" }]);
  turn.toolCall("quote", { plan: "ouro" }).result({ id: "q-77" }, { observations: [{ ref: QUOTE, fields: { price_full: 499.9 } }] });
  return turn;
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const piece of stream) out.push(piece);
  return out;
}

describe("the claim guard", () => {
  it("rewrites a stale copy of one field to its fresh value", () => {
    const turn = frame();
    const guarded = guardText(HEALTH, turn, "O plano ouro sai por R$ 511,06 no valor cheio. Fechamos?");
    expect(guarded.text).toBe("O plano ouro sai por R$ 499,90 no valor cheio. Fechamos?");
    expect(guarded.claims.map((c) => [c.verdict, c.action, c.role])).toEqual([["stale", "rewrite", "price_full"]]);
    expect(turn.flags.has("guard_acted")).toBe(true);
    expect(turn.claims).toEqual(guarded.claims);
  });

  it("marks a rewrite that is not unequivocal as a warning", () => {
    const text = "Sai por R$ 511,06 no valor cheio, R$ 1.022,12 para dois.";
    const guarded = guardText(HEALTH, frame(), text);
    expect(guarded.text).toBe(text);
    expect(guarded.claims[0]?.action).toBe("warn");
  });

  it("gives a blocked claim's sentence to the caveat, once", () => {
    const text = "Para PME fica R$ 1.200,00 por vida. No MEI sai R$ 900,00. Posso ajudar em algo mais?";
    const guarded = guardText(HEALTH, new TurnFrame(null, { agent: "sales", conversationId: "c-1" }), text);
    expect(guarded.text).toBe(`${CAVEAT} Posso ajudar em algo mais?`);
    expect(new Set(guarded.claims.map((c) => `${c.category}:${c.action}`))).toEqual(new Set(["business_plan_price:block", "price:block"]));
  });

  it("never changes an immutable output, and sends a block in it to a person", () => {
    const text = "Proposta: plano ouro, R$ 511,06 no valor cheio; PME a R$ 1.200,00 por vida.";
    const guarded = guardText(HEALTH, frame(), text, { context: "proposal" });
    expect(guarded.text).toBe(text);
    expect(guarded.review).toBe(true);
    expect(guarded.claims.some((c) => c.action === "rewrite")).toBe(false);
  });

  it("rewrites a stream while it flows, and lets what could start no claim go at once", async () => {
    const turn = new TurnFrame(null, { agent: "store", conversationId: "c-1" });
    turn.observeState([{ ref: "product:store:PX", field: "price_sale", value: 199.9, claimSafe: false, role: "price_sale" }]);
    turn.toolCall("check_price", { sku: "PX" }).result({}, { observations: [{ ref: "product:store:PX", fields: { price_sale: 149.9 } }] });
    const guard = new Guard(RETAIL, turn, { holdMs: 60_000, messageMs: 60_000 });
    const pieces = await collect(guardStream(guard, ["O vestido sai por R$ 1", "99,90 hoje", ". Qu", "er levar?"]));
    expect(pieces.join("")).toBe("O vestido sai por R$ 149,90 hoje. Quer levar?");
    expect(pieces[0]).toBe("O vestido sai por ");
    expect(guard.result?.claims[0]?.action).toBe("rewrite");
  });

  it("lets a hold past its budget go as it is, and marks its claims", () => {
    let now = 0;
    const turn = frame();
    const guard = new Guard(HEALTH, turn, { now: () => now });
    expect(guard.feed("O plano ouro sai por R$ 511,06 no valor ")).toBe("");
    now = 200;
    const released = guard.feed("cheio. Fechamos?");
    const tail = guard.finish();
    expect(released + tail).toBe("O plano ouro sai por R$ 511,06 no valor cheio. Fechamos?");
    expect(guard.result?.claims.map((c) => [c.verdict, c.action])).toEqual([["stale", "warn"]]);
    expect(turn.flags.has("guard_budget_exceeded") && turn.flags.has("guard_acted")).toBe(true);
  });

  it("lets a hold that runs out go without waiting for the next chunk", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* stream(): AsyncGenerator<string> {
      yield "Sai por R$ 511,06 no valor ";
      await gate;
      yield "cheio.";
    }
    const guard = new Guard(HEALTH, frame(), { holdMs: 20 });
    const seen: string[] = [];
    for await (const piece of guardStream(guard, stream())) {
      seen.push(piece);
      release();
    }
    expect(seen[0]).toBe("Sai por R$ 511,06 no valor ");
    expect(seen.join("")).toBe("Sai por R$ 511,06 no valor cheio.");
  });

  it("records the act it took once, through the conversation", async () => {
    const cell = new Cell();
    cell.claimContract = HEALTH;
    const niadra = new Niadra({ apiKey: KEY, fetch: cell.fetch, logger: silentLogger, flushOnExit: false, turns: { intervalMs: 3_600_000 } });
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-9", agent_id: "sales" });
    const reply = await conversation.turn(async () => {
      const text = (await collect(conversation.claims.guard(["Para PME fica R$ 1.200,00 ", "por vida. Algo mais?"]))).join("");
      conversation.agent(text);
      return text;
    });
    await niadra.flush();
    const [record] = [...cell.turns.values()];
    expect(reply).toBe(`${CAVEAT} Algo mais?`);
    expect((record?.claims as { action: string }[]).map((c) => c.action).sort()).toEqual(["block", "block"]);
    expect(record?.flags).toContain("guard_acted");
  });

  it("ends a mutable stream as the whole text would, and never alters an immutable one", async () => {
    const pieces = ["Sai por ", "R$ 511,06", " no valor cheio", ". ", "PME ", "R$ 1.200,00", " por vida", "carência de 30 dias", "\n", "Já enviei a proposta", "? "];
    let seed = 11;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let example = 0; example < 150; example++) {
      const text = Array.from({ length: 1 + random(12) }, () => pieces[random(pieces.length)]).join("");
      const chars = Array.from(text);
      const cuts = [...new Set(Array.from({ length: random(6) }, () => 1 + random(Math.max(1, chars.length - 1))))].sort((a, b) => a - b);
      const chunks = [0, ...cuts].map((start, i) => chars.slice(start, [...cuts, chars.length][i]).join("")).filter(Boolean);
      const whole = guardText(HEALTH, frame(), text).text;
      const streamed = (await collect(guardStream(new Guard(HEALTH, frame(), { holdMs: 60_000, messageMs: 60_000 }), chunks))).join("");
      expect(streamed).toBe(whole);
      const immutable = (await collect(guardStream(new Guard(HEALTH, frame(), { context: "proposal", holdMs: 60_000, messageMs: 60_000 }), chunks))).join("");
      expect(immutable).toBe(text);
    }
  });
});
