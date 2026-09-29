// The tool bindings the SDK profile serves: a tool without a binding in code measures the constraints block
// through the one the space binds for its name, a binding in code wins, and the served capability hides a
// denied field unless the code says otherwise.
import { describe, expect, it } from "vitest";
import { Niadra, silentLogger } from "../src/index.js";
import type { ConstraintsBlock, TurnFrame } from "../src/index.js";
import { ProfileCache } from "../src/profile.js";
import { Cell } from "./support/cell.js";
import { KEY, marina } from "./helpers.js";

const SEARCH = {
  tool: "search_products",
  args: [{ attr: "item_variant.color", param: "color", negation: { param: "not_color" } }],
  results: [{ path: "cards[*]", type: "item_variant", namespace: "store", id: "variant_id", fields: { color: "color" } }],
  capabilities: { overfetch: false, mask_output: true },
};
const ITEM = {
  type: "item_variant",
  ownership: "shared",
  mirror_of: { system: "erp" },
  fields: { color: { type: "text" }, cost_price: { type: "money" } },
  field_access: { cost_price: "deny" },
};
const BLOCK = { version: "cv_0123456789abcdef", hard: [{ id: "h1", attr: "item_variant.color", op: "not_in", values: ["red"], source: "stated", scope: "session", origin: { kind: "stated" } }] } as unknown as ConstraintsBlock;
const CARDS = [{ variant_id: "1", color: "blue", cost_price: 40 }, { variant_id: "2", color: "green", cost_price: 50 }];
const cards = (_q?: { not_color?: string[] }): { cards: Record<string, unknown>[] } => ({ cards: CARDS.map((c) => ({ ...c })) });

function setup(): { cell: Cell; niadra: Niadra } {
  const cell = new Cell();
  cell.features.add("signals");
  cell.features.add("state");
  cell.types = [ITEM];
  cell.toolBindings = [SEARCH];
  cell.constraints.set(`${marina.type}:${marina.value}`, BLOCK);
  return { cell, niadra: new Niadra({ apiKey: KEY, fetch: cell.fetch, logger: silentLogger, flushOnExit: false, turns: { intervalMs: 3_600_000 } }) };
}

async function applied(cell: Cell, niadra: Niadra, search: (q: { not_color?: string[] }) => unknown): Promise<Record<string, unknown>> {
  await niadra.profile();
  const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-1", agent_id: "stylist" });
  const turnId = await conversation.turn({}, async (frame: TurnFrame) => {
    await conversation.context({ include: ["constraints"] });
    search({ not_color: ["red"] });
    conversation.agent("Separei duas opções.");
    return frame.turnId;
  });
  await niadra.flush();
  return (cell.turns.get(turnId)?.calls[0]?.applied ?? {}) as Record<string, unknown>;
}

describe("the tool bindings the profile serves", () => {
  it("measure a tool that has no binding in code", async () => {
    const { cell, niadra } = setup();
    const result = await applied(cell, niadra, niadra.tool("search_products", cards));
    expect(result).toMatchObject({ hard_sent: ["h1"], results_checked: 2, violations: 0 });
  });

  it("give way to a binding in code", async () => {
    const { cell, niadra } = setup();
    const own = { ...SEARCH, args: [{ attr: "item_variant.color", param: "colour", negation: { param: "not_colour" } }] };
    const result = await applied(cell, niadra, niadra.tool("search_products", cards, { binding: own }));
    expect(result.hard_sent).toEqual([]);
  });

  it("hide a denied field by the served capability, unless the code says otherwise", async () => {
    const { niadra } = setup();
    await niadra.profile();
    expect(niadra.tool("search_products", cards)()).toEqual({ cards: [{ variant_id: "1", color: "blue" }, { variant_id: "2", color: "green" }] });
    expect(niadra.tool("search_products", cards, { maskOutput: false })()).toEqual({ cards: CARDS });
  });

  it("are kept by tool name in the profile cache", async () => {
    const cache = new ProfileCache();
    await cache.refresh(async () => ({ features: ["signals"], tool_bindings: [SEARCH], valid_for_s: 300 }) as never);
    expect(cache.toolBinding("search_products")?.capabilities?.mask_output).toBe(true);
    expect(cache.toolBinding("book_visit")).toBeNull();
  });
});
