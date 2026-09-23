import { describe, expect, it } from "vitest";
import { uuidv7 } from "../src/index.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  it("has the version and variant bits of RFC 9562", () => {
    for (let i = 0; i < 100; i++) expect(uuidv7()).toMatch(UUID_V7);
  });

  it("encodes the timestamp in the first 48 bits", () => {
    const at = Date.UTC(2026, 8, 22, 17, 7, 0);
    const id = uuidv7(at + 10_000);
    const ms = parseInt(id.replace(/-/g, "").slice(0, 12), 16);
    expect(ms).toBeGreaterThanOrEqual(at);
  });

  it("stays sortable within the same millisecond", () => {
    const at = Date.now() + 60_000;
    const ids = Array.from({ length: 500 }, () => uuidv7(at));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never goes backwards when the clock does", () => {
    const later = uuidv7(Date.now() + 120_000);
    const earlier = uuidv7(Date.now());
    expect(earlier > later).toBe(true);
  });
});
