// The concept examples (`examples/`) run as the documentation shows them, against the test cell: the claim
// guard, coordination, object state, the working state, a masked tool output, the tool counterfactual, and
// the CI workflow's commands.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Niadra, silentLogger, uuidv7 } from "../src/index.js";
import type { ClaimContractSummary, ConstraintsBlock } from "../src/index.js";
import { MASKED, WITHHELD } from "../src/capture/mask.js";
import { main } from "../src/cli/index.js";
import type { Io } from "../src/cli/index.js";
import { guardedReply } from "../examples/claim-guard.js";
import { farewellOnce } from "../examples/coordination.js";
import { QUOTE, priceLine, requote } from "../examples/object-state.js";
import { rememberAddress, rememberOffer } from "../examples/working-state.js";
import { proposalTool } from "../examples/masked-tool.js";
import { measure, searchProducts } from "../examples/tool-counterfactual.js";
import { Cell } from "./support/cell.js";
import { KEY, marina } from "./helpers.js";

type Json = Record<string, any>;

function setup(...features: string[]): { cell: Cell; niadra: Niadra } {
  const cell = new Cell();
  for (const feature of features) cell.features.add(feature);
  return { cell, niadra: new Niadra({ apiKey: KEY, fetch: cell.fetch, logger: silentLogger, flushOnExit: false, turns: { intervalMs: 3_600_000 } }) };
}

describe("the concept examples", () => {
  it("claim-guard flags a wrong price and holds back the prompt", async () => {
    const { cell, niadra } = setup();
    const retail = JSON.parse(readFileSync(new URL("../spec/examples/claim-contract/retail.json", import.meta.url), "utf8")) as Json;
    niadra.claimContract({ ...retail, internal_text: { shingle_hashes_ref: "prompts@v16", n: 8, redact: "(instrução interna)" } } as unknown as ClaimContractSummary);
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-1", agent_id: "store" });
    expect(await guardedReply(niadra, conversation, "O vestido sai por R$ 199,90 hoje. Quer levar?")).toBe("O vestido sai por R$ 199,90 hoje. Quer levar?");
    const leak = "Claro! Never offer a discount above ten percent without the manager's approval. Posso ajudar?";
    expect(await guardedReply(niadra, conversation, leak)).toBe("Claro! (instrução interna). Posso ajudar?");
    await niadra.flush();
    const records = [...cell.turns.values()] as Json[];
    expect(records.flatMap((r) => (r.claims as Json[]).map((c) => [c.verdict, c.action]))).toEqual([
      ["mismatch", "warn"],
      ["internal_text_found", "block"],
    ]);
    expect(JSON.stringify(records)).not.toContain("discount");
  });

  it("coordination sends the farewell once", async () => {
    const { niadra } = setup("coordination");
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-2", agent_id: "closing" });
    const sent: string[] = [];
    expect(await conversation.turn(() => farewellOnce(conversation, "c-2", (text) => sent.push(text)))).toBe(true);
    await niadra.flush();
    expect(await conversation.turn(() => farewellOnce(conversation, "c-2", (text) => sent.push(text)))).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("object-state reads a stale price again before it is said", async () => {
    const { cell, niadra } = setup("state");
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-3", agent_id: "sales" });
    await conversation.turn(async () => {
      cell.observe(QUOTE, { price_full: 511.06 });
      expect(await priceLine(conversation, 511.06)).toBe("O plano sai por R$ 511.06.");
      cell.observe(QUOTE, { price_full: 511.06 }, "stale");
      expect(await priceLine(conversation, 511.06)).toBe("Vou confirmar o valor atualizado e já te digo.");
      niadra.resolvers.register("health_quote", requote);
      expect(await priceLine(conversation, 511.06)).toBe("O plano sai por R$ 499.90.");
    });
  });

  it("working-state keeps each sub-agent's field", async () => {
    const { niadra } = setup("agent_state");
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-4", agent_id: "sales" });
    await rememberOffer(conversation, "accepted");
    expect(await rememberAddress(conversation, "Campinas")).toEqual({ offer: { status: "accepted" }, delivery: { city: "Campinas" } });
  });

  it("masked-tool gives the model the proposal as the key may read it", async () => {
    const { cell, niadra } = setup("state");
    cell.types = [
      {
        type: "proposal",
        ownership: "subject",
        mirror_of: { system: "crm" },
        fields: { price_full: { type: "money" }, health_declaration: { type: "text" } },
        field_access: { health_declaration: "mask" },
      },
    ];
    const getProposal = proposalTool(niadra);
    expect(getProposal("p-19")).toBe(WITHHELD); // no profile read yet
    await niadra.profile();
    expect(getProposal("p-19")).toEqual({ proposal_id: "p-19", price_full: 812.4, health_declaration: MASKED });
  });

  it("tool-counterfactual measures the hard constraints", async () => {
    const { cell, niadra } = setup("signals", "measurement");
    cell.constraints.set(`${marina.type}:${marina.value}`, {
      version: "cv_0123456789abcdef",
      hard: [{ id: "h1", attr: "item_variant.color", op: "not_in", values: ["red"], source: "stated", scope: "session", origin: { kind: "stated" } }],
    } as unknown as ConstraintsBlock);
    const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-5", agent_id: "stylist" });
    conversation.customer("Um vestido, mas não vermelho.");
    const turnId = await conversation.turn({ build: Niadra.build({ prompts: { stylist: "v1" }, model: "model-a" }) }, async (frame) => {
      await conversation.context({ include: ["constraints"] });
      const { cards } = searchProducts({ not_color: ["red"] });
      frame.interact({ kind: "presented", exposure_id: uuidv7(), list_id: "l1", list_kind: "search_products", delivered_at: new Date().toISOString(), visible_k: 3, items: cards.map((c, i) => ({ pos: i + 1, ref: `item_variant:store:${c.variant_id}` })) });
      conversation.agent("Separei opções que não são vermelhas.");
      return frame.turnId;
    });
    await niadra.flush();
    expect(await measure(niadra, [turnId], "abc123")).toMatchObject({ cases: 1, untouched: 0, completed: 1 });
  });

  it("the CI workflow runs commands the CLI takes", async () => {
    const lines = readFileSync(new URL("../examples/ci/niadra-checks.yml", import.meta.url), "utf8").split("\n");
    const commands = lines.filter((line) => line.trim().startsWith("run: npx niadra ")).map((line) => line.split("run: npx niadra ")[1] ?? "");
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      const errors: string[] = [];
      const io: Io = { out: () => undefined, err: (text) => errors.push(text), client: () => { throw new Error("no client in this test"); } };
      await main(command.split(" "), io);
      // The arguments parsed: what stops it is the missing connection string or corpus file, never an option.
      expect(errors.join("\n")).not.toMatch(/Unknown option|Unexpected argument|usage:/);
    }
  });
});
