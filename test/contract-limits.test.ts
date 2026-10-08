import { describe, expect, it } from "vitest";
import { AGENT_MEMORY_TOOL_DEFINITIONS, MAX_NOTE_BODY, MAX_NOTE_TITLE } from "../src/index.js";
import { blockResult, checkNote, emptyBlock } from "../src/agent-memory.js";

// The client takes what the server takes: a note within the API's limits is sent whole, and what a
// block leaves out is read, never dropped.
describe("contract limits", () => {
  it("send a note up to the API's limits whole and refuse one past them", () => {
    expect(MAX_NOTE_TITLE).toBe(300);
    expect(MAX_NOTE_BODY).toBe(20_000);
    expect(() => checkNote({ kind: "procedure", title: "t".repeat(300), body: "b".repeat(20_000) })).not.toThrow();
    expect(() => checkNote({ kind: "procedure", title: "t", body: "b".repeat(20_001) })).toThrow();
    expect(() => checkNote({ kind: "procedure", title: "t".repeat(301), body: "b" })).toThrow();
  });

  it("read how many notes a block left out", () => {
    const result = blockResult({ text: "x", notes: ["n1"], etag: "e", tokens: 3, enabled: true, left_out: 4 }, "network");
    expect(result.left_out).toBe(4);
    expect(emptyBlock(null).left_out).toBe(0);
  });

  it("offer the model the API's note limits in the remember tool", () => {
    const remember = AGENT_MEMORY_TOOL_DEFINITIONS.find((d) => d.function.name === "remember");
    const properties = (remember?.function.parameters as { properties: Record<string, { maxLength?: number }> }).properties;
    expect(properties.title?.maxLength).toBe(300);
    expect(properties.body?.maxLength).toBe(20_000);
  });
});
