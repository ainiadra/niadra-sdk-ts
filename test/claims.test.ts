// The claim checker reads offsets in code points and patterns as Python's `re` reads them, so a text with
// an emoji, a digit of another script or a letter of another alphabet finds what the server's reference
// checker finds. The conformance vectors run in vectors.test.ts; these cases are the ones they do not hold.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claims } from "../src/index.js";
import type { ClaimCategory } from "../src/index.js";

const read = (text: string, lang: claims.Language = "pt") =>
  claims.mentions(text, lang).map((m) => [m.cls, m.start, m.end, m.value()]);

const health = JSON.parse(readFileSync(new URL("../spec/examples/claim-contract/health-plan-sales.json", import.meta.url), "utf8")) as {
  categories: ClaimCategory[];
};

describe("the claim parser", () => {
  it("counts offsets in code points, past an emoji", () => {
    const text = "😀 R$ 511,06 por mês.";
    expect(read(text)).toEqual([["money", 2, 11, { amount: "511.06", unit: "BRL" }]]);
    expect(Array.from(text).slice(2, 11).join("")).toBe("R$ 511,06");
  });

  it("finds a claim after an emoji where the code points put it", () => {
    const text = "🙂 O plano sai por R$ 511,06 sem desconto.";
    const value: claims.TurnValue = { cls: "money", role: "price_full", value: { amount: "511.06", unit: "BRL" } };
    const [finding] = claims.check(health.categories, { text, lang: "pt", context: "chat", immutable: false }, { values: [value] });
    expect(finding).toMatchObject({ category: "price", start: 18, end: 27, verdict: "matched", evidence: value });
  });

  it("reads the digits of any script as decimal digits", () => {
    expect(read("São R$ ١٢ e 𑁧𑁨 reais.")).toEqual([
      ["money", 4, 9, { amount: "12", unit: "BRL" }],
      ["money", 12, 20, { amount: "12", unit: "BRL" }],
    ]);
  });

  it("takes a letter of any alphabet as part of a word", () => {
    expect(read("λ5 reais")).toEqual([]);
    expect(read("Tome 50 µg")).toEqual([["dosage", 5, 10, { amount: "50", unit: "mcg" }]]);
  });

  it("folds a character that becomes two into one mark, so offsets hold", () => {
    expect(read("ﬁ 5 dias")).toEqual([["duration", 2, 8, { amount: "5", unit: "day" }]]);
  });

  it("reads a currency before a line break that ends the text before the number", () => {
    expect(read("£\n\n25")).toEqual([["money", 0, 5, { amount: "25", unit: "GBP" }]]);
  });

  it("keeps 28 significant digits of an amount", () => {
    expect(read("R$ 484659281446694816434960573726,64")).toEqual([
      ["money", 0, 36, { amount: "484659281446694816434960573700", unit: "BRL" }],
    ]);
  });
});

/** The same distance by the plain dynamic program: a passage may start and end anywhere in the text. */
function byTable(pattern: string, text: string): number {
  let previous = Array.from({ length: pattern.length + 1 }, (_, i) => i);
  let best = pattern.length;
  for (const ch of text) {
    const current = [0];
    for (let i = 1; i <= pattern.length; i++) {
      current.push(Math.min(previous[i]! + 1, current[i - 1]! + 1, previous[i - 1]! + (pattern[i - 1] === ch ? 0 : 1)));
    }
    best = Math.min(best, current[pattern.length]!);
    previous = current;
  }
  return best;
}

describe("the text anchor", () => {
  it("computes the bit-parallel distance as the dynamic program does", () => {
    let seed = 7;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const text = (min: number, max: number): string =>
      Array.from({ length: min + random(max - min + 1) }, () => "abc "[random(4)]).join("");
    for (let i = 0; i < 500; i++) {
      const [pattern, document] = [text(1, 80), text(0, 120)];
      expect(claims.distance(pattern, document), `${pattern} | ${document}`).toBe(byTable(pattern, document));
    }
  });

  it("holds a quote whatever its case, accents and punctuation", () => {
    expect(claims.score("CAUSAR DANO A OUTREM", "Aquele que... causar dano a outrem, ainda que")).toBe(1);
    expect(claims.score("", "anything")).toBe(0);
  });
});
