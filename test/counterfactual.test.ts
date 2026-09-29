// The tool counterfactual in the company's CI: recorded calls of a tool run again with and without one
// element of the constraints block, and only positions and overlaps reach Niadra. With it, what a bound tool
// call records of the block, and a replay starting from the working state the turn read.
import { describe, expect, it } from "vitest";
import { Counterfactual, Niadra, NiadraError, Replayer, silentLogger, tool, uuidv7 } from "../src/index.js";
import type { ConstraintsBlock, TurnFrame } from "../src/index.js";
import { Cell } from "./support/cell.js";
import { KEY, marina } from "./helpers.js";

const CATALOG = [["red", 120], ["blue", 90], ["red", 80], ["black", 150], ["blue", 60], ["green", 70], ["red", 40]].map(([color, price], n) => ({ variant_id: String(n), color: color as string, price: price as number }));
const SEARCH = {
  tool: "search_products",
  args: [{ attr: "item_variant.color", param: "color", negation: { param: "not_color" } }],
  results: [{ path: "cards[*]", type: "item_variant", namespace: "store", id: "variant_id", fields: { color: "color" } }],
  capabilities: { overfetch: false, dry_run_param: "dry_run" },
};
const BLOCK = { version: "cv_0123456789abcdef", hard: [{ id: "h1", attr: "item_variant.color", op: "not_in", values: ["red"], source: "stated", scope: "session", origin: { kind: "stated" } }] } as unknown as ConstraintsBlock;
const ran: Record<string, unknown>[] = [];

interface Query { not_color?: string | string[] | null; color?: string | null; dry_run?: boolean }
const search = (q: Query): { cards: typeof CATALOG } => {
  ran.push({ ...q });
  const refused = new Set(typeof q.not_color === "string" ? [q.not_color] : (q.not_color ?? []));
  return { cards: CATALOG.filter((c) => !refused.has(c.color) && (q.color == null || c.color === q.color)).sort((a, b) => a.price - b.price) };
};
const searchProducts = tool("search_products", search, { binding: SEARCH, dryRun: true });

function setup(): { cell: Cell; niadra: Niadra } {
  const cell = new Cell();
  cell.features.add("signals");
  cell.features.add("measurement");
  cell.constraints.set(`${marina.type}:${marina.value}`, BLOCK);
  return { cell, niadra: new Niadra({ apiKey: KEY, fetch: cell.fetch, logger: silentLogger, flushOnExit: false, turns: { intervalMs: 3_600_000 } }) };
}

async function recorded(niadra: Niadra, call: () => { cards: typeof CATALOG }, engaged?: string): Promise<string> {
  const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: `c-${uuidv7()}`, agent_id: "stylist" });
  conversation.customer("Quero um vestido, mas não vermelho.");
  const turnId = await conversation.turn({ build: Niadra.build({ prompts: { core: "v16" }, model: "model-a" }) }, async (frame: TurnFrame) => {
    await conversation.context({ include: ["constraints"] });
    const found = call();
    const exposure = uuidv7();
    frame.interact({ kind: "presented", exposure_id: exposure, list_id: "l1", list_kind: "search_products", delivered_at: new Date().toISOString(), visible_k: 3, items: found.cards.map((c, i) => ({ pos: i + 1, ref: `item_variant:store:${c.variant_id}` })) });
    if (engaged) frame.interact({ kind: "engaged", exposure_id: exposure, ref: engaged, how: "click" });
    conversation.agent("Separei três opções que não são vermelhas.");
    return frame.turnId;
  });
  await niadra.flush();
  return turnId;
}

describe("the tool counterfactual", () => {
  it("moves the list beyond the tool's noise, and sends positions and overlaps only", async () => {
    const { cell, niadra } = setup();
    const turn = await recorded(niadra, () => searchProducts({ not_color: ["red"] }), "item_variant:store:5");
    expect(cell.turns.get(turn)?.calls[0]?.applied).toEqual({ constraints: "cv_0123456789abcdef", hard_sent: ["h1"], results_checked: 4, violations: 0, unverifiable: 0 });
    ran.length = 0;
    const run = await new Counterfactual(niadra, { search_products: searchProducts }).run([turn], { tool: "search_products", element: "hard", label: "abc123" });
    expect(ran).toEqual([{ not_color: ["red"] }, { not_color: ["red"] }, {}]);
    const [c] = run.cases;
    expect(c).toMatchObject({ status: "completed", dry_run: false, k: 3, noise: 1, base_count: 4, variant_count: 7, engaged: [{ base: 2, variant: 3 }] });
    expect(c?.overlap).toBeLessThan(1);
    expect(run.report.limits).toEqual(expect.arrayContaining(["not_quality", "trivial_for_hard", "few_cases"]));
    const sent = JSON.stringify(cell.counterfactuals);
    expect(sent).not.toContain("red");
    expect(sent).not.toContain("store:5");
  });

  it("counts what the element did not touch, runs a tool that is not safe dry, or not at all", async () => {
    const { niadra } = setup();
    const touched = await recorded(niadra, () => searchProducts({ not_color: ["red"] }));
    const untouched = await recorded(niadra, () => searchProducts({ color: "blue" }));
    const run = await new Counterfactual(niadra, { search_products: searchProducts }).run([touched, untouched], { tool: "search_products", element: "hard" });
    expect([run.cases.length, run.untouched]).toEqual([1, 1]);
    ran.length = 0;
    const dry = await new Counterfactual(niadra, { search_products: search }, { bindings: { search_products: SEARCH } }).run([touched], { tool: "search_products", element: "hard" });
    expect(dry.cases[0]?.dry_run).toBe(true);
    expect(ran.every((q) => q.dry_run === true)).toBe(true);
    const never = await new Counterfactual(niadra, { search_products: search }, { bindings: { search_products: { ...SEARCH, capabilities: {} } } }).run([touched], { tool: "search_products", element: "hard" });
    expect(never.cases).toEqual([{ turn_id: touched, call_id: "k1", status: "no_dry_run", dry_run: false }]);
    await expect(new Counterfactual(niadra, { search_products: searchProducts }).run([touched], { tool: "search_products", element: "size" })).rejects.toBeInstanceOf(NiadraError);
  });
});

describe("a replay", () => {
  it("starts from the working state the turn read, and keeps what it writes", async () => {
    const cell = new Cell();
    cell.features.add("agent_state");
    const niadra = new Niadra({ apiKey: KEY, fetch: cell.fetch, logger: silentLogger, flushOnExit: false, turns: { intervalMs: 3_600_000 } });
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-7", agent_id: "sales" });
    await conversation.agentState.put({ offer: { status: "shown" }, cart: ["sku-1"] });
    conversation.customer("Pode fechar?");
    const build = Niadra.build({ prompts: { core: "v16" }, model: "model-a" });
    const turnId = await conversation.turn({ build }, async (frame: TurnFrame) => {
      const state = await conversation.agentState.get();
      await conversation.agentState.put({ offer: { status: "accepted" } }, { ifVersion: state.version });
      conversation.agent("Fechado.");
      return frame.turnId;
    });
    await niadra.flush();
    const scenario = cell.createScenario([turnId], []);
    const seen: unknown[] = [];
    await new Replayer(niadra, () => async () => {
      const replayed = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-7", agent_id: "sales" });
      const read = await replayed.agentState.get();
      seen.push([read.body, read.version]);
      seen.push((await replayed.agentState.put({ offer: { status: "accepted" } }, { ifVersion: read.version })).stored);
      return "Fechado.";
    }, { build }).run([scenario.scenario_id], { runs: 2 });
    expect(seen[0]).toEqual([{ offer: { status: "shown" }, cart: ["sku-1"] }, 1]);
    expect(seen[1]).toBe(true);
    expect(seen[2]).toEqual(seen[0]);
    expect(cell.agentStates.get(JSON.stringify(["conversation", "c-7", "sales"]))?.version).toBe(2);
  });
});

describe("the counterfactual command", () => {
  it("prints the report, and says so when nothing was touched", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { main } = await import("../src/cli/index.js");
    const { cell, niadra } = setup();
    const turn = await recorded(niadra, () => searchProducts({ not_color: ["red"] }));
    const dir = mkdtempSync(join(tmpdir(), "niadra-cf-"));
    const module = join(dir, "tools.mjs");
    writeFileSync(module, `const cards = ${JSON.stringify(CATALOG)};
export const TOOLS = { search_products: (q) => ({ cards: cards.filter((c) => !(q.not_color ?? []).includes(c.color)) }) };
export const BINDINGS = { search_products: ${JSON.stringify(SEARCH)} };\n`);
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t), client: () => niadra };
    const argv = ["counterfactual", "--tools", `${module}:TOOLS`, "--bindings", `${module}:BINDINGS`, "--tool", "search_products", "--safe", "search_products", "--turn", turn];
    expect(await main([...argv, "--element", "hard", "--label", "abc"], io)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ label: "abc", completed: 1, untouched: 0 });
    expect(await main([...argv, "--element", "size"], io)).toBe(2);
    expect(cell.counterfactuals).toHaveLength(1);
  });
});
