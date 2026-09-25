// The SDK's pack types against the Context Pack schema they implement (spec/context-pack.v0.json):
// the same fields, the same layers, and the specification's example read as a typed answer.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ContextPack, ContextResponse, PackLayer, PackSection, PackStamp } from "../src/index.js";

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(`../spec/${path}`, import.meta.url), "utf8"));

interface Schema {
  $id: string;
  properties: { pack: { anyOf: { $ref?: string }[] } };
  $defs: Record<string, { properties: Record<string, { enum?: string[] }>; required: string[] }>;
}

const schema = read("context-pack.v0.json") as Schema;
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
};
const sectionKeys: Record<keyof PackSection, true> = { name: true, label: true, layer: true, lines: true };
const stampKeys: Record<keyof PackStamp, true> = { etag: true, version: true, as_of: true, manifest_hash: true };
const layers: Record<PackLayer, true> = { account: true, stable: true, volatile: true };

describe("the Context Pack specification", () => {
  it("is the v0 schema, with the pack as data", () => {
    expect(schema.$id).toBe("https://specs.niadra.com/schemas/context-pack.v0.json");
    expect(schema.properties.pack.anyOf[0]).toEqual({ $ref: "#/$defs/ContextPack" });
  });

  it("has exactly the fields of the SDK's pack types", () => {
    expect(Object.keys(packKeys).sort()).toEqual(fields("ContextPack"));
    expect(Object.keys(sectionKeys).sort()).toEqual(fields("PackSection"));
    expect(Object.keys(stampKeys).sort()).toEqual(fields("PackStamp"));
    expect(Object.keys(layers).sort()).toEqual([...schema.$defs.PackSection!.properties.layer!.enum!].sort());
  });

  it("gives an example the SDK reads as a typed answer, the pack holding the text's lines", () => {
    const answer = read("examples/context-pack-as-data.json") as ContextResponse;
    const pack = answer.pack!;
    expect(pack.spec).toBe("context-pack.v0");
    const names = schema.$defs.PackSection!.properties.name!.enum!;
    expect(pack.sections.every((s) => names.includes(s.name))).toBe(true);
    const inner = answer.text!.split("\n").slice(1, -1);
    expect([pack.preamble, ...pack.sections.flatMap((s) => s.lines)]).toEqual(inner);
    expect(pack.stamp.etag).toBe(answer.etag);
  });
});
