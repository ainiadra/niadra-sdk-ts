// Field access at the tool's output: a field the key may not read never reaches the model, by the SDK profile's
// `field_access`, the last one read when Niadra is down, and fail closed only when asked.
import { describe, expect, it } from "vitest";
import { Niadra, silentLogger } from "../src/index.js";
import { MASKED, WITHHELD } from "../src/capture/mask.js";
import { Cell } from "./support/cell.js";
import { KEY, marina } from "./helpers.js";

const ITEM = {
  type: "item_variant",
  ownership: "shared",
  mirror_of: { system: "erp" },
  fields: { price_sale: { type: "money" }, cost_price: { type: "money" }, margin: { type: "percent" } },
  field_access: { cost_price: "deny", margin: "mask" },
};
const cards = (): { cards: Record<string, unknown>[] } => ({ cards: [{ variant_id: "991", price_sale: 199.9, cost_price: 80, margin: 0.6 }] });
const shown = (r: { cards: Record<string, unknown>[] }): { ref: string; fields: Record<string, unknown> }[] =>
  r.cards.map((c) => ({ ref: `item_variant:store:${String(c.variant_id)}`, fields: { price_sale: c.price_sale } }));

function setup(): { cell: Cell; niadra: Niadra } {
  const cell = new Cell();
  cell.features.add("state");
  cell.types = [ITEM];
  return { cell, niadra: new Niadra({ apiKey: KEY, fetch: cell.fetch, logger: silentLogger, flushOnExit: false, turns: { intervalMs: 3_600_000 } }) };
}

describe("a masked tool output", () => {
  it("never gives the model a denied or masked value, in a turn or outside one", async () => {
    const { cell, niadra } = setup();
    const search = niadra.tool("search", cards, { provenance: shown, maskOutput: true });
    await niadra.profile();
    const expected = { cards: [{ variant_id: "991", price_sale: 199.9, margin: MASKED }] };
    expect(search()).toEqual(expected);
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-1" });
    const turnId = await conversation.turn({}, (frame) => {
      expect(search()).toEqual(expected);
      return frame.turnId;
    });
    await niadra.flush();
    const record = cell.turns.get(turnId);
    expect(record?.blobs[record.calls[0]?.result_model]?.content).toEqual(expected);
  });

  it("passes with no profile ever read, unless it fails closed", () => {
    const { niadra } = setup();
    expect(niadra.tool("search", cards, { provenance: shown, maskOutput: true })().cards[0]?.cost_price).toBe(80);
    expect(niadra.tool("strict", cards, { provenance: shown, maskOutput: true, onUnknown: "block" })()).toBe(WITHHELD);
  });

  it("keeps the last profile when Niadra is down, and hides every type's fields without provenance", async () => {
    const { cell, niadra } = setup();
    await niadra.profile();
    cell.failNext("/v1/sdk/profile", 503, 10);
    await niadra.profile();
    expect(niadra.tool("lookup", () => '{"cost_price": 80, "name": "Vestido"}', { maskOutput: true })()).toBe('{"name":"Vestido"}');
  });
});
