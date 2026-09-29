// The conformance vectors of the open specifications, which the server and both SDKs run alike.
//
// `pnpm sync-spec --spec` copies them into spec/vectors (and the claim contract examples, with their
// negative corpus, into spec/examples/claim-contract). `EXPECTED` lists every file the SDK runs, with the
// fields its spec gives a case. Nothing here passes without running:
// - a file not published yet is skipped, titled "pending vectors";
// - a published file whose runner the SDK does not have yet is an expected failure ("pending
//   implementation"), which turns red the day a runner makes it pass and nobody moved it;
// - a file nothing expects, a case field its spec does not define and a malformed envelope fail.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, jsonDigest } from "../src/index.js";

const SPEC = new URL("../spec/", import.meta.url);
const VECTORS = new URL("vectors/", SPEC);
const CASE_ID = /^[a-z0-9_]+(\.[a-z0-9_-]+)+$/;

type Case = Record<string, unknown> & { id: string; expect?: Record<string, unknown> };
interface VectorFile {
  vectors: string;
  version: string;
  spec: string;
  cases: Case[];
}

interface Expected {
  caseFields: string[];
  expectFields: string[];
  run: ((c: Case) => Promise<void>) | null;
  pending?: string;
}

/** A published file whose runner the SDK does not have yet. */
const pending = (caseFields: string, expectFields: string, what: string): Expected => ({
  caseFields: caseFields.split(" "),
  expectFields: expectFields.split(" "),
  run: null,
  pending: what,
});

async function digestCase(c: Case): Promise<void> {
  const expected = c.expect as { canonical: string; sha256: string; size: number };
  expect(canonicalJson(c.value)).toBe(expected.canonical);
  expect(await jsonDigest(c.value)).toEqual({ sha256: expected.sha256, size: expected.size });
}

const EXPECTED: Record<string, Expected> = {
  "turn-record-digest.v0": {
    caseFields: ["id", "note", "value", "expect"],
    expectFields: ["canonical", "sha256", "size"],
    run: digestCase,
  },
  "niadra-expr.v0": pending("id expr input expect", "value", "the niadra-expr evaluator"),
  "claim-parser.v0": pending("id lang text roles evidence expect", "mentions", "the claim contract's number and role parser"),
  "claim-detect.v0": pending("id contract output turn expect", "findings", "the claim contract's detection"),
  "claim-anchor.v0": pending("id quote document expect", "normalized_quote_length distance holds", "the claim contract's text anchor"),
  "constraint-render.v0": pending(
    "id block binding families call mode results expect",
    "applies args suggested injected hard_sent residual post_filter conflicts honored",
    "the constraints block's rendering per tool binding",
  ),
  "exposure-token.v0": pending("id op description exposure_id position token expect", "token exposure_id position", "the exposure token"),
  "contact-token.v0": pending(
    "id op description seed claims keys gateway token destination channel now seen_jti expect",
    "token claims",
    "the contact token's issue and offline check",
  ),
  "suppression-key.v0": pending("id description salt type value expect", "canonical key", "the suppression list's per-source key"),
};
const NEGATIVE_CORPUS = ["retail", "legal", "health-plan-sales"];

const published = (name: string): boolean => existsSync(new URL(`${name}.json`, VECTORS));
const load = (name: string): VectorFile => JSON.parse(readFileSync(new URL(`${name}.json`, VECTORS), "utf8")) as VectorFile;

it("runs every published vector file", () => {
  const files = readdirSync(VECTORS).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5));
  expect(files.filter((name) => !(name in EXPECTED)), "vector files the SDK does not run: add them to EXPECTED").toEqual([]);
});

for (const [name, expected] of Object.entries(EXPECTED)) {
  if (!published(name)) {
    it.skip(`pending vectors: ${name}.json is not published in niadra-spec yet`, () => undefined);
    continue;
  }
  describe(name, () => {
    const data = load(name);

    it("has the envelope and only the fields its spec defines", () => {
      const dot = name.lastIndexOf(".");
      expect(Object.keys(data).sort()).toEqual(["cases", "spec", "vectors", "version"]);
      expect([data.vectors, data.version]).toEqual([name.slice(0, dot), name.slice(dot + 1)]);
      expect(data.spec.startsWith("spec/")).toBe(true);
      const ids = data.cases.map((c) => c.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((id) => !CASE_ID.test(id))).toEqual([]);
      const caseFields = new Set(expected.caseFields);
      const expectFields = new Set([...expected.expectFields, "error"]);
      for (const c of data.cases) {
        expect(Object.keys(c).filter((field) => !caseFields.has(field)), c.id).toEqual([]);
        expect(Object.keys(c.expect ?? {}).filter((field) => !expectFields.has(field)), c.id).toEqual([]);
      }
    });

    for (const c of data.cases) {
      const run = async (): Promise<void> => {
        if (!expected.run) throw new Error(`not implemented: ${expected.pending ?? name}`);
        await expected.run(c);
      };
      if (expected.pending) it.fails(`pending implementation: ${expected.pending}: ${c.id}`, run);
      else it(c.id, run);
    }
  });
}

for (const sector of NEGATIVE_CORPUS) {
  const path = new URL(`examples/claim-contract/${sector}.json`, SPEC);
  if (!existsSync(path)) {
    it.skip(`pending vectors: examples/claim-contract/${sector}.json is not published yet`, () => undefined);
    continue;
  }
  it.fails(`pending implementation: the claim contract's detection, on the ${sector} negative corpus`, () => {
    const example = JSON.parse(readFileSync(path, "utf8")) as { negative_corpus: { phrases: string[] } };
    expect(example.negative_corpus.phrases.length).toBeGreaterThan(0);
    throw new Error("not implemented: the claim contract's detection");
  });
}
