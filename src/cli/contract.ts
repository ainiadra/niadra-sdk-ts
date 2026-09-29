/**
 * `niadra contract test`: the space's claim contract against the company's negative corpus and example
 * turns, for the company's CI (the claim contract spec, section 10).
 *
 * The contract is the company's own copy (`--contract`, the document it submits as configuration, with its
 * negative corpus), or the one the space serves in its SDK profile, with the corpus from `--corpus`: the
 * profile never carries the corpus's phrases. A phrase of the corpus fails the test when, in any of the
 * contract's languages and for any of its agents, a category finds a claim in it.
 *
 * An examples file holds `{"examples": [...]}`, each example `{id, output, turn, expect}`: `output` is
 * `{text, lang, context, immutable, agent}`, `turn` what the turn held (`values`, `tools`, `documents`,
 * `anchors`, `sections`, as in the claim detection vectors), and `expect` is `{claims: [...]}`, where each
 * expected claim names its `category` and, when given, its `verdict` and `action`, in the order the output
 * says them. An empty list expects no claim.
 *
 * Exits with 0 when everything holds, 1 when a phrase triggers or an example differs, and 2 when it could not
 * run.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { check, detected } from "../claims/check.js";
import type { Anchor, Output, Turn, TurnValue } from "../claims/check.js";
import type { Language, MentionClass, Value } from "../claims/numbers.js";
import type { ClaimContractSummary } from "../types/state.js";
import type { Io } from "./index.js";

type Json = Record<string, unknown>;

/** What the test found: the phrases that triggered and the examples that differ. */
interface ContractReport {
  contract: string;
  corpus: string | null;
  phrases: number;
  examples: number;
  triggered: { phrase: string; lang: string; agent: string | null; categories: string[] }[];
  failed: { id: string; expected: Json[]; found: Json[] }[];
}

export async function contractTest(argv: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      contract: { type: "string" },
      corpus: { type: "string" },
      examples: { type: "string", multiple: true, default: [] },
    },
    allowPositionals: true,
  });
  let contract: ClaimContractSummary;
  let corpus: Json;
  let examples: Json[];
  try {
    let document: Json = {};
    if (values.contract !== undefined) {
      document = read(values.contract) as Json;
      contract = document as unknown as ClaimContractSummary;
    } else {
      const profile = await io.client().callRoute<Json | null>({ method: "GET", path: "/v1/sdk/profile" });
      const served = profile?.claim_contract as ClaimContractSummary | null | undefined;
      if (!served) return fail(io, "the space serves no claim contract: pass --contract");
      contract = served;
    }
    // A corpus file is a contract document, or the corpus alone: {version, phrases}.
    const source = (values.corpus !== undefined ? read(values.corpus) : document) as Json;
    corpus = (source.negative_corpus ?? source) as Json;
    if (!Array.isArray(corpus.phrases) || corpus.phrases.length === 0) {
      return fail(io, "no negative corpus to test: --contract with one, or --corpus");
    }
    examples = values.examples.flatMap((path) => examplesOf(read(path)));
    if (!Array.isArray(contract.categories) || !Array.isArray(contract.languages)) throw new TypeError("not a claim contract");
  } catch (error) {
    return fail(io, `could not read the contract, the corpus or the examples (${error instanceof Error ? error.name : typeof error})`);
  }
  const version = typeof corpus.version === "string" ? corpus.version : null;
  if (contract.negative_corpus_version && version && version !== contract.negative_corpus_version) {
    io.err(`niadra: the contract names corpus ${contract.negative_corpus_version}, the file is ${version}`);
  }
  const report = checkContract(contract, corpus.phrases as string[], examples, version);
  for (const t of report.triggered) io.err(`triggered: ${JSON.stringify(t.phrase)} (${t.lang}, ${t.categories.join(", ")})`);
  for (const f of report.failed) io.err(`example ${f.id}: expected ${JSON.stringify(f.expected)}, found ${JSON.stringify(f.found)}`);
  io.out(
    JSON.stringify(
      {
        contract: report.contract,
        corpus: report.corpus,
        phrases: report.phrases,
        triggered: report.triggered.length,
        examples: report.examples,
        failed: report.failed.length,
      },
      null,
      2,
    ),
  );
  return report.triggered.length === 0 && report.failed.length === 0 ? 0 : 1;
}

/** Runs the corpus and the examples against `contract`. */
export function checkContract(
  contract: ClaimContractSummary,
  phrases: readonly string[],
  examples: readonly Json[] = [],
  corpus: string | null = null,
): ContractReport {
  const categories = contract.categories ?? [];
  const agents = [null, ...new Set(categories.flatMap((c) => c.agents ?? []))];
  const report: ContractReport = { contract: contract.version, corpus, phrases: phrases.length, examples: 0, triggered: [], failed: [] };
  for (const phrase of phrases) {
    for (const lang of contract.languages) {
      for (const agent of agents) {
        const found = detected(categories, { text: phrase, lang: lang, context: "chat", immutable: false, agent });
        if (found.length > 0) report.triggered.push({ phrase, lang, agent, categories: found });
      }
    }
  }
  for (const example of examples) {
    report.examples++;
    const expected = ((example.expect as Json).claims ?? []) as Json[];
    const found = check(categories, output(example.output as Json), turn((example.turn ?? {}) as Json)).map((f) => ({
      category: f.category,
      verdict: f.verdict,
      action: f.action,
    }));
    const same =
      found.length === expected.length &&
      found.every((got, i) => Object.entries(expected[i] ?? {}).every(([key, value]) => (got as Json)[key] === value));
    if (!same) report.failed.push({ id: String(example.id), expected, found });
  }
  return report;
}

function examplesOf(document: unknown): Json[] {
  const items = Array.isArray(document) ? document : (document as Json | null)?.examples;
  const shaped =
    Array.isArray(items) &&
    items.every((i: unknown) => {
      const e = i as Json | null;
      return e !== null && typeof e === "object" && "id" in e && "output" in e && typeof e.expect === "object" && e.expect !== null && "claims" in e.expect;
    });
  if (!shaped) throw new TypeError("an examples file holds {examples: [{id, output, turn, expect}]}");
  return items as Json[];
}

function output(item: Json): Output {
  return {
    text: String(item.text),
    lang: item.lang as Language,
    context: typeof item.context === "string" ? item.context : "chat",
    immutable: Boolean(item.immutable),
    agent: typeof item.agent === "string" ? item.agent : null,
  };
}

function turn(item: Json): Turn {
  const values = ((item.values ?? []) as Json[]).map(
    (v): TurnValue => ({
      cls: v.class as MentionClass,
      value: v.value as Value,
      role: (v.role as string | undefined) ?? null,
      fresh: v.fresh !== false,
      objectType: (v.object_type as string | undefined) ?? null,
      name: (v.name as string | undefined) ?? null,
      callId: (v.call_id as string | undefined) ?? null,
      ref: (v.ref as string | undefined) ?? null,
      declaredGaps: (v.declared_gaps as string[] | undefined) ?? [],
    }),
  );
  const anchors = ((item.anchors ?? []) as Json[]).map(
    (a): Anchor => {
      const [start = 0, end = 0] = a.span as number[];
      return { start, end, quote: String(a.quote), document: String(a.document) };
    },
  );
  return {
    values,
    tools: (item.tools ?? []) as string[],
    documents: (item.documents ?? {}) as Record<string, string>,
    anchors,
    sections: (item.sections ?? {}) as Record<string, [number, number][]>,
  };
}

function read(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(io: Io, message: string): number {
  io.err(`niadra: ${message}`);
  return 2;
}
