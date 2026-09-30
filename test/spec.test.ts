// The SDK's pack types against the Context Pack schema they implement (spec/context-pack.v1.json):
// the same fields, the same layers, and the specification's examples read as typed answers, the
// earlier version's too.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderSuffix } from "../src/index.js";
import type {
  BudgetBlock,
  BudgetCut,
  BudgetPack,
  BudgetUse,
  ConstraintsBlock,
  ContextPack,
  ContextResponse,
  CoordinationBlock,
  PackGuard,
  PackLayer,
  PackSection,
  PackSlot,
  PackSlotDerived,
  PackStamp,
  SlotChannelRank,
  SlotWhy,
  StateView,
} from "../src/index.js";

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(`../spec/${path}`, import.meta.url), "utf8"));

interface Property {
  enum?: string[];
  const?: string;
  anyOf?: { enum?: string[] }[];
}

interface Schema {
  $id: string;
  properties: Record<string, { anyOf?: { $ref?: string }[] }>;
  $defs: Record<string, { properties: Record<string, Property>; required: string[] }>;
}

const schema = read("context-pack.v1.json") as Schema;
const fields = (name: string): string[] => Object.keys(schema.$defs[name]!.properties).sort();

// Each record must name every key of its type and nothing else, or the typecheck fails.
const packKeys: Record<keyof ContextPack, true> = {
  spec: true,
  view: true,
  verification: true,
  withheld: true,
  as_of: true,
  preamble: true,
  sections: true,
  variables: true,
  stamp: true,
  slots: true,
};
const sectionKeys: Record<keyof PackSection, true> = { name: true, label: true, layer: true, lines: true };
const stampKeys: Record<keyof PackStamp, true> = { etag: true, version: true, as_of: true, manifest_hash: true };
const slotKeys: Record<keyof PackSlot, true> = { section: true, id: true, derived: true, channels: true, text: true, why: true };
const guardKeys: Record<keyof PackGuard, true> = { id: true, value_type: true, value: true };
const layers: Record<PackLayer, true> = { account: true, stable: true, volatile: true };
const derived: Record<PackSlotDerived, true> = { count: true, no_record: true, withheld: true };
const slotWhyKeys: Record<keyof SlotWhy, true> = {
  item_id: true,
  score: true,
  channels: true,
  weights_version: true,
  excerpt: true,
  rule: true,
  basis: true,
};
const slotChannelRankKeys: Record<keyof SlotChannelRank, true> = {
  channel: true,
  position: true,
  weight: true,
  contribution: true,
};

describe("the Context Pack specification", () => {
  it("is the v1 schema, with the pack as data and the turn's slots", () => {
    expect(schema.$id).toBe("https://specs.niadra.com/schemas/context-pack.v1.json");
    expect(schema.properties.pack!.anyOf![0]).toEqual({ $ref: "#/$defs/ContextPack" });
    expect(schema.$defs.ContextPack!.properties.spec!.const).toBe("context-pack.v1");
    expect(Object.keys(schema.properties)).toContain("slots");
  });

  it("has exactly the fields of the SDK's pack types", () => {
    expect(Object.keys(packKeys).sort()).toEqual(fields("ContextPack"));
    expect(Object.keys(sectionKeys).sort()).toEqual(fields("PackSection"));
    expect(Object.keys(stampKeys).sort()).toEqual(fields("PackStamp"));
    expect(Object.keys(slotKeys).sort()).toEqual(fields("PackSlot"));
    expect(Object.keys(layers).sort()).toEqual([...schema.$defs.PackSection!.properties.layer!.enum!].sort());
    expect(Object.keys(derived).sort()).toEqual([...schema.$defs.PackSlot!.properties.derived!.anyOf![0]!.enum!].sort());
    expect(Object.keys(slotWhyKeys).sort()).toEqual(fields("SlotWhy"));
    expect(Object.keys(slotChannelRankKeys).sort()).toEqual(fields("SlotChannelRank"));
    expect(Object.keys(guardKeys).sort()).toEqual(fields("PackGuard"));
    expect(Object.keys(schema.properties)).toContain("guards");
  });

  it("types each guard line beside the slots, named by the short id of its value", () => {
    const answer = read("examples/context-pack/turn-as-data.json") as ContextResponse;
    const lines = answer.pack!.slots.filter((slot) => slot.section === "guard");
    expect(lines.map((slot) => slot.id)).toEqual(answer.guards!.map((guard) => guard.id));
    expect(lines[0]!.text).toContain(answer.guards![0]!.value);
  });

  it("gives an example the SDK reads as a typed answer, the slots between the live turns and the delta", () => {
    const answer = read("examples/context-pack/turn-as-data.json") as ContextResponse;
    const pack = answer.pack!;
    expect(pack.spec).toBe("context-pack.v1");
    const names = schema.$defs.PackSection!.properties.name!.enum!;
    expect(pack.sections.every((s) => names.includes(s.name))).toBe(true);
    // A section's lines carry no label; the text puts the section's label back before each one.
    const inner = answer.text!.split("\n").slice(1, -1);
    expect([pack.preamble, ...pack.sections.flatMap((s) => s.lines.map((line) => `[${s.label}] ${line}`))]).toEqual(inner);
    expect(pack.slots.map((slot) => slot.text)).toEqual(answer.slots!.split("\n").slice(1, -1));
    expect(pack.stamp.etag).toBe(answer.etag);
    const suffix = renderSuffix(answer);
    expect(suffix.startsWith("<live_turns")).toBe(true);
    // The producer's example carries no delta, so the slots close the block where a delta would follow.
    expect(answer.delta).toBeNull();
    expect(suffix.endsWith(answer.slots!)).toBe(true);
  });
});

// The answer with the blocks a read adds by `include`.
const responseKeys: Record<keyof ContextResponse, true> = {
  not_modified: true,
  text: true,
  variables: true,
  version: true,
  etag: true,
  manifest_hash: true,
  as_of: true,
  lag_seconds: true,
  coverage: true,
  verification: true,
  withheld: true,
  live: true,
  live_complete: true,
  delta: true,
  slots: true,
  guards: true,
  cache: true,
  timing: true,
  path: true,
  degraded: true,
  pack: true,
  constraints: true,
  state: true,
  coordination: true,
  budget: true,
};
const blockKeys: Record<string, Record<string, true>> = {
  ConstraintsBlock: {
    already_presented: true,
    ask: true,
    attributes: true,
    conflicts: true,
    exclude: true,
    hard: true,
    precedence: true,
    relaxation_order: true,
    rendered: true,
    rules: true,
    soft: true,
    subject: true,
    text: true,
    version: true,
  } satisfies Record<keyof ConstraintsBlock, true>,
  StateView: {
    changes_since_seen: true,
    degraded: true,
    interests: true,
    objects: true,
    text: true,
  } satisfies Record<keyof StateView, true>,
  CoordinationBlock: {
    owner: true,
    suppressions: true,
    contact_budget: true,
    commitments_active: true,
  } satisfies Record<keyof CoordinationBlock, true>,
  BudgetBlock: {
    pack: true,
    conversation: true,
    case: true,
    other_agents_turns: true,
    cut: true,
    counted: true,
  } satisfies Record<keyof BudgetBlock, true>,
  BudgetPack: { total: true, sections: true } satisfies Record<keyof BudgetPack, true>,
  BudgetUse: {
    turns: true,
    model_calls: true,
    tool_calls: true,
    tokens_in: true,
    tokens_cached: true,
    tokens_out: true,
    cost_usd: true,
  } satisfies Record<keyof BudgetUse, true>,
  BudgetCut: {
    units: true,
    applied: true,
    window_days: true,
    min_deliveries: true,
  } satisfies Record<keyof BudgetCut, true>,
};

describe("the Context Pack answer", () => {
  it("has exactly the fields of the SDK's answer and of each block", () => {
    expect(Object.keys(responseKeys).sort()).toEqual(Object.keys(schema.properties).sort());
    for (const [name, keys] of Object.entries(blockKeys)) {
      expect(Object.keys(keys).sort(), name).toEqual(Object.keys(schema.$defs[name]!.properties).sort());
    }
  });
});
