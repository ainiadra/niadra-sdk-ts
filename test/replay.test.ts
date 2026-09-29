import { describe, expect, it } from "vitest";
import { Niadra, Replayer, silentLogger, tool } from "../src/index.js";
import type { ReplayInput } from "../src/index.js";
import { Cell } from "./support/cell.js";
import { KEY, marina } from "./helpers.js";

const calls: string[] = [];
const quote = tool("quote", (plan: string) => {
  calls.push(plan);
  return { plan, price_full: 511.06 };
});
const stock = tool(
  "stock",
  (sku: string) => {
    calls.push(sku);
    return { sku, qty: 2 };
  },
  { dryRun: true },
);
const quoting = (): string => `O plano ouro sai por R$ ${quote("ouro").price_full.toFixed(2)} no valor cheio.`;
const guessing = (): string => "O plano ouro sai por uns R$ 500.";

function setup(): { cell: Cell; niadra: Niadra } {
  const cell = new Cell();
  return { cell, niadra: new Niadra({ apiKey: KEY, fetch: cell.fetch, logger: silentLogger, flushOnExit: false, turns: { intervalMs: 3_600_000 } }) };
}

async function recorded(niadra: Niadra): Promise<string> {
  const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-1", agent_id: "sales" });
  conversation.customer("Quanto sai o plano ouro?");
  const turnId = await conversation.turn({ build: Niadra.build({ prompts: { core: "v16" }, model: "model-a" }) }, (frame) => {
    conversation.agent(quoting());
    return frame.turnId;
  });
  await niadra.flush();
  calls.length = 0;
  return turnId;
}

describe("replay inside the company's boundary", () => {
  it("passes five times with the tools answered from the record", async () => {
    const { cell, niadra } = setup();
    const scenario = cell.createScenario([await recorded(niadra)]);
    const seen: ReplayInput[] = [];
    const build = Niadra.build({ prompts: { core: "v17" }, model: "model-a" });
    const run = await new Replayer(niadra, () => (input) => {
      seen.push(input);
      return quoting();
    }, { build }).run([scenario.scenario_id], { runs: 5, vary: ["prompts"] });
    expect([run.status, run.verdict]).toEqual(["done", "pass"]);
    expect(run.scenarios[0]?.completed).toBe(5);
    expect(calls).toEqual([]);
    expect(seen[0]?.text).toBe("Quanto sai o plano ouro?");
    expect(seen.map((s) => s.run)).toEqual([0, 1, 2, 3, 4]);
  });

  it("regresses when the agent stops calling the tool", async () => {
    const { cell, niadra } = setup();
    const scenario = cell.createScenario([await recorded(niadra)]);
    const build = Niadra.build({ prompts: { core: "v17" }, model: "model-a" });
    expect((await new Replayer(niadra, () => quoting, { build }).run([scenario.scenario_id], { vary: ["prompts"] })).verdict).toBe("pass");
    const run = await new Replayer(niadra, () => guessing, { build }).run([scenario.scenario_id], { vary: ["prompts"] });
    expect(run.verdict).toBe("regression");
    const [assertion] = run.scenarios[0]?.assertions as Record<string, unknown>[];
    expect([assertion?.failed, assertion?.baseline_passed, assertion?.p_value]).toEqual([5, 5, 0.003968]);
  });

  it("stops at a pin that does not match", async () => {
    const { cell, niadra } = setup();
    const scenario = cell.createScenario([await recorded(niadra)]);
    const build = Niadra.build({ prompts: { core: "v17" }, model: "model-b" });
    const run = await new Replayer(niadra, () => quoting, { build }).run([scenario.scenario_id], { vary: ["prompts"] });
    expect([run.status, run.verdict, run.scenarios[0]?.pin_mismatches]).toEqual(["refused", "pin_mismatch", 5]);
  });

  it("lets nothing the replayed agent sends, declares or writes reach Niadra", async () => {
    const { cell, niadra } = setup();
    cell.features.add("coordination");
    cell.features.add("agent_state");
    const scenario = cell.createScenario([await recorded(niadra)], [{ id: "once", kind: "effect_once", args: { key: "farewell:c-1" } }]);
    const events = cell.events.length;
    const agent = async (): Promise<void> => {
      const conversation = niadra.conversation({ subject: marina, channel: "whatsapp", conversation_id: "c-1", agent_id: "sales" });
      expect((await conversation.context()).error?.message).toBe("replay");
      const decision = await conversation.check("farewell", { purpose: "service", effectKey: "farewell:c-1" });
      await conversation.agentState.put({ step: "farewell" });
      if (decision.decision === "allow") {
        conversation.agent("Até logo!");
        conversation.declare.effect("farewell:c-1", "done");
      }
    };
    const run = await new Replayer(niadra, () => agent, { build: Niadra.build({ prompts: { core: "v16" }, model: "model-a" }) }).run([scenario.scenario_id], { runs: 2 });
    expect(run.verdict).toBe("pass");
    await niadra.flush();
    expect([cell.events.length, cell.declarations.length, cell.agentStates.size]).toEqual([events, 0, 0]);
  });

  it("runs a call the record does not hold only when it is safe, and counts an agent that throws apart", async () => {
    const { cell, niadra } = setup();
    const turnId = await recorded(niadra);
    const safe = cell.createScenario([turnId], [{ id: "stock", kind: "tool_called", args: { tool: "stock" } }]);
    const build = Niadra.build({ prompts: { core: "v16" }, model: "model-a" });
    const run = await new Replayer(niadra, () => () => {
      quote("prata");
      return String(stock("sku-9").qty);
    }, { build }).run([safe.scenario_id], { runs: 1 });
    expect([calls, run.verdict]).toEqual([["sku-9"], "pass"]);
    const broken = cell.createScenario([turnId]);
    const failed = await new Replayer(niadra, () => () => {
      throw new TypeError("boom");
    }, { build }).run([broken.scenario_id], { runs: 3 });
    expect([failed.verdict, failed.scenarios[0]?.infrastructure_errors]).toEqual(["infrastructure_error", 3]);
  });
});
