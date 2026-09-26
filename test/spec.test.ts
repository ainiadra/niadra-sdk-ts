// The SDK's pack types against the Context Pack schema they implement (spec/context-pack.v1.json):
// the same fields, the same layers, and the specification's examples read as typed answers, the
// earlier version's too.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderSuffix } from "../src/index.js";
import type {
  ContextPack,
  ContextResponse,
  PackLayer,
  PackSection,
  PackSlot,
  PackSlotDerived,
  PackStamp,
  SlotChannelRank,
  SlotWhy,
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
const slotKeys: Record<keyof PackSlot, true> = { section: true, derived: true, channels: true, text: true, why: true };
const layers: Record<PackLayer, true> = { account: true, stable: true, volatile: true };
const derived: Record<PackSlotDerived, true> = { count: true, no_record: true, withheld: true };
const slotWhyKeys: Record<keyof SlotWhy, true> = {
  item_id: true,
  score: true,
  channels: true,
  weights_version: true,
  via: true,
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
  });

  it("gives an example the SDK reads as a typed answer, the slots between the live turns and the delta", () => {
    const answer = read("examples/context-pack-v1-turn-as-data.json") as ContextResponse;
    const pack = answer.pack!;
    expect(pack.spec).toBe("context-pack.v1");
    const names = schema.$defs.PackSection!.properties.name!.enum!;
    expect(pack.sections.every((s) => names.includes(s.name))).toBe(true);
    const inner = answer.text!.split("\n").slice(1, -1);
    expect([pack.preamble, ...pack.sections.flatMap((s) => s.lines)]).toEqual(inner);
    expect(pack.slots.map((slot) => slot.text)).toEqual(answer.slots!.split("\n").slice(2, -1));
    expect(pack.stamp.etag).toBe(answer.etag);
    const suffix = renderSuffix(answer);
    expect(suffix.startsWith("<live_turns")).toBe(true);
    expect(suffix.endsWith(`${answer.slots!}\n\n${answer.delta!}`)).toBe(true);
  });

  it("still reads the earlier version's example", () => {
    const answer = read("examples/context-pack-as-data.json") as ContextResponse;
    expect(answer.pack!.spec).toBe("context-pack.v0");
    expect(answer.slots).toBeUndefined();
    expect(renderSuffix(answer)).not.toContain("<turn");
  });
});
