/**
 * The tool counterfactual (`spec/counterfactual.md`): does one element of the constraints block change what a
 * tool returns, beyond the tool's own noise? Run in the company's CI, inside its boundary.
 *
 * ```ts
 * const run = await new Counterfactual(niadra, { search_products: searchProducts }).run(turnIds, {
 *   tool: "search_products",
 *   element: "hard",
 * });
 * console.log(run.report.effect, run.report.limits);
 * ```
 *
 * For each recorded call of the tool whose arguments or post filter carried the element (the call recorded the
 * block it `applied`, and the block is in the record), the runner renders the call again without the element and
 * calls the tool three times at the same moment: the recorded arguments twice (the base, whose two lists measure
 * the tool's own noise) and the variant once. A tool marked safe to run again (`tool(..., { dryRun: true })`, or
 * `safe`) runs as it is; any other runs as its dry run (the binding's `capabilities.dry_run_param`), and one
 * with no dry run is never called (`no_dry_run`). It compares the lists after the post filter (exclusions, when
 * the binding overfetches) with `overlapAtK`, finds where the items the person engaged with went, and sends
 * only positions and overlaps to `POST /v1/measure/counterfactual-runs`, which answers with the report.
 *
 * The records come through the replay case route, so only turns that can be replayed are read. The element is
 * `constraints` (the whole block), `hard`, `size` (its attributes) or `exclude`. The binding is the one the space's
 * `tool-bindings` document gives the tool for this source, from the SDK profile; a result's objects are read with
 * the binding's `results`, or else with the tool's `provenance`. It behaves as the Python SDK's `Counterfactual`.
 */

import { SDK } from "../capture/record.js";
import { recordedTool } from "../capture/tool.js";
import type { RecordedTool } from "../capture/tool.js";
import type { Niadra } from "../client.js";
import { parseBinding, resultItems } from "../constraints/binding.js";
import type { RawBinding } from "../constraints/binding.js";
import { render } from "../constraints/render.js";
import { NiadraError } from "../errors.js";
import type { ConstraintsBlock } from "../types/signals.js";
import { BlobError, materialized } from "./playback.js";
import { strictRead } from "./runner.js";

const MAX_K = 100;
const MAX_CASES = 5000;
const PINS = ["prompts", "corpus_digest", "model", "assembler", "tool_schemas"];

export type Element = "constraints" | "hard" | "size" | "exclude";
type Json = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolFunction = (args: any) => unknown;

/**
 * Depth-weighted average overlap of `a` and `b` down to `min(k, the longer list's length)`, with
 * `w(d) = 1 / log2(d + 1)`. An item repeated within a list counts once, at its first position. Two equal
 * lists overlap 1, and so do two empty lists; a list against an empty one overlaps 0.
 */
export function overlapAtK(a: readonly string[], b: readonly string[], k: number): number {
  if (!Number.isInteger(k) || k < 1 || k > MAX_K) throw new RangeError(`k must be 1 to ${String(MAX_K)}`);
  const first = [...new Set(a)];
  const second = [...new Set(b)];
  const depth = Math.min(k, Math.max(first.length, second.length));
  if (depth === 0) return 1;
  let weighted = 0;
  let total = 0;
  for (let d = 1; d <= depth; d++) {
    const top = new Set(first.slice(0, d));
    const shared = second.slice(0, d).filter((item) => top.has(item)).length;
    const weight = 1 / Math.log2(d + 1);
    weighted += (weight * shared) / d;
    total += weight;
  }
  return weighted / total;
}

/** What the run sent and what Niadra answered, with the calls the element did not touch and the turns unread. */
export interface CounterfactualRun {
  report: Json;
  cases: Json[];
  untouched: number;
  unread: number;
}

export interface CounterfactualOptions {
  /** Reads values kept by pointer; by default the client's content resolver. */
  read?: (pointer: string) => Promise<string>;
  /** Tools that may run again as they are. */
  safe?: readonly string[];
}

export interface CounterfactualRunOptions {
  tool: string;
  element: Element;
  scenarioIds?: readonly string[];
  k?: number;
  label?: string;
}

/**
 * The tool counterfactual. `tools` maps each tool's name to the company's function, called with the recorded
 * arguments (one object).
 */
export class Counterfactual {
  constructor(
    private readonly niadra: Niadra,
    private readonly tools: Readonly<Record<string, ToolFunction>>,
    private readonly options: CounterfactualOptions = {},
  ) {}

  /** Runs every recorded call of the tool the element touched; rejects when no call carried it. */
  async run(turnIds: readonly string[], options: CounterfactualRunOptions): Promise<CounterfactualRun> {
    const { tool, element } = options;
    const k = options.k ?? 10;
    const fn = this.tools[tool];
    if (fn === undefined) throw new NiadraError(`no function for the tool ${tool}: pass it in tools`);
    if (!Number.isInteger(k) || k < 1 || k > MAX_K) throw new RangeError(`k must be 1 to ${String(MAX_K)}`);
    const raw = await this.served(tool);
    if (raw === null) throw new NiadraError(`the space binds no tool ${tool} for this key's source: see its tool-bindings`);
    const ids = [...turnIds];
    if ((options.scenarioIds ?? []).length > 0) {
      const found = await this.niadra.callRoute<{ items?: Json[] }>({ method: "GET", path: "/v1/scenarios", query: { ids: (options.scenarioIds ?? []).join(","), limit: 50 } });
      for (const scenario of found.items ?? []) for (const id of scenario.turn_ids as string[]) if (!ids.includes(id)) ids.push(id);
    }
    const run: CounterfactualRun = { report: {}, cases: [], untouched: 0, unread: 0 };
    for (const turnId of ids) {
      let record: Json;
      try {
        const body = { turn_id: turnId, mode: "hermetic_turn", build: { pins: {}, sdk: SDK }, vary: PINS };
        record = (await this.niadra.callRoute<{ record: Json }>({ method: "POST", path: "/v1/replay/cases", body })).record;
      } catch (error) {
        if (!(error instanceof NiadraError)) throw error;
        run.unread++;
        continue;
      }
      for (const call of calls(record, tool)) {
        const found = await this.case(record, call, fn, raw, element, k);
        if (found === null) run.untouched++;
        else run.cases.push(found);
      }
    }
    if (run.cases.length === 0) throw new NiadraError("no recorded call of the tool carried the element: nothing to report");
    const report: Json = { tool, element, k, cases: run.cases.slice(0, MAX_CASES), ...(options.label !== undefined ? { label: options.label } : {}) };
    run.report = await this.niadra.callRoute<Json>({ method: "POST", path: "/v1/measure/counterfactual-runs", body: report });
    return run;
  }

  private async case(record: Json, call: Json, fn: ToolFunction, raw: RawBinding, element: Element, k: number): Promise<Json | null> {
    const base = { turn_id: record.turn_id, call_id: call.call_id };
    const tool = String(call.name);
    const wrapped = recordedTool(fn);
    let block: ConstraintsBlock;
    let args: Json;
    try {
      block = (await this.value(record, blockBlob(record, call))) as ConstraintsBlock;
      args = { ...((await this.value(record, call.args as string | undefined)) as Json) };
    } catch {
      return { ...base, status: "infrastructure_error", dry_run: false };
    }
    const binding = parseBinding(raw, await this.families());
    const asked = [...new Set((block.attributes ?? []).map((a) => a.name.split(".")[0] ?? ""))];
    const full = render(block, binding, { args: {}, asked });
    const without = render(withoutElement(block, element), binding, { args: {}, asked });
    const moved = [...new Set([...Object.keys(full.suggested), ...Object.keys(without.suggested)])].filter(
      (p) => JSON.stringify(full.suggested[p]) !== JSON.stringify(without.suggested[p]),
    );
    const carried = moved.some((p) => p in full.suggested && p in args && same(args[p], full.suggested[p]));
    const filters = [full.postFilter.includes("exclude"), without.postFilter.includes("exclude")] as const;
    if (!carried && !(filters[0] !== filters[1] && (block.exclude ?? []).length > 0)) return null;
    let variant: Json = Object.fromEntries(Object.entries(args).filter(([p]) => !moved.includes(p)));
    for (const p of moved) if (p in without.suggested) variant[p] = without.suggested[p];
    let dryRun = false;
    if (!(wrapped?.dryRun || (this.options.safe ?? []).includes(tool))) {
      const param = raw.capabilities?.dry_run_param;
      if (!param) return { ...base, status: "no_dry_run", dry_run: false };
      args = { ...args, [param]: true };
      variant = { ...variant, [param]: true };
      dryRun = true;
    }
    let results: unknown[];
    try {
      results = [await fn(args), await fn(args), await fn(variant)];
    } catch {
      return { ...base, status: "tool_error", dry_run: dryRun };
    }
    let lists: string[][];
    try {
      lists = results.map((r) => refs(raw, wrapped, r));
    } catch {
      return { ...base, status: "infrastructure_error", dry_run: dryRun };
    }
    const excluded = new Set(block.exclude ?? []);
    const [first = [], second = [], third = []] = lists;
    const baseOne = filters[0] ? first.filter((r) => !excluded.has(r)) : first;
    const baseTwo = filters[0] ? second.filter((r) => !excluded.has(r)) : second;
    const varied = filters[1] ? third.filter((r) => !excluded.has(r)) : third;
    const shown = presented(record, call);
    const depth = Math.min(Number(shown?.visible_k ?? k), MAX_K);
    return {
      ...base,
      status: "completed",
      dry_run: dryRun,
      k: depth,
      overlap: round(overlapAtK(baseOne, varied, depth)),
      noise: round(overlapAtK(baseOne, baseTwo, depth)),
      base_count: baseOne.length,
      variant_count: varied.length,
      engaged: engaged(record, shown).map((ref) => positions(ref, baseOne, varied)).slice(0, 50),
    };
  }

  private async value(record: Json, key: string | null | undefined): Promise<unknown> {
    const blob = key ? (record.blobs as Record<string, Json> | undefined)?.[key] : undefined;
    if (blob === undefined) throw new BlobError("the record does not hold the value");
    const read = this.options.read ?? (this.niadra.content.registered ? strictRead(this.niadra) : null);
    return materialized(blob, read);
  }

  private async served(tool: string): Promise<RawBinding | null> {
    const profile = await this.niadra.profile();
    return profile?.tool_bindings?.find((b) => b.tool === tool) ?? null;
  }

  private async families(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const t of (await this.niadra.profile())?.types ?? []) {
      for (const [name, spec] of Object.entries((t.fields ?? {}) as Record<string, { attribute?: { family?: string } | null }>)) {
        if (spec.attribute?.family) out[`${String(t.type)}.${name}`] = spec.attribute.family;
      }
    }
    return out;
  }
}

/** The recorded calls of `tool` that answered and measured a constraints block. */
function calls(record: Json, tool: string): Json[] {
  return ((record.calls ?? []) as Json[]).filter((c) => c.kind === "tool" && c.name === tool && (c.status ?? "ok") === "ok" && Boolean(c.applied));
}

function blockBlob(record: Json, call: Json): string | undefined {
  const version = (call.applied as Json).constraints;
  const read = ((record.reads ?? []) as Json[]).find((r) => r.surface === "constraints" && r.version === version);
  return read?.blob as string | undefined;
}

/** The block the variant renders from: the same block without the element. */
function withoutElement(block: ConstraintsBlock, element: Element): ConstraintsBlock {
  if (element === "constraints") return { ...block, hard: [], attributes: [], exclude: [], conflicts: [] };
  if (element === "hard") return { ...block, hard: [], conflicts: [] };
  if (element === "size") return { ...block, attributes: [] };
  return { ...block, exclude: [] };
}

/** The call's argument is what the block rendered: a list in any order, and one value alone or in a list, are the same. */
function same(given: unknown, suggested: unknown): boolean {
  const norm = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).map((x) => JSON.stringify(x)).sort();
  return JSON.stringify(norm(given)) === JSON.stringify(norm(suggested));
}

function refs(raw: RawBinding, wrapped: RecordedTool | null, result: unknown): string[] {
  if ((raw.results ?? []).length > 0) return resultItems(raw, result).filter((i) => "ref" in i).map((i) => i.ref as string);
  if (wrapped?.provenance) {
    const found = (wrapped.provenance as (r: unknown) => unknown)(result);
    const items = found == null ? [] : Array.isArray(found) ? (found as Json[]) : [found as Json];
    return items.map((o) => o.ref as string);
  }
  throw new BlobError("the tool's result has no objects to compare: give its binding results or provenance");
}

/** The list the person was shown from the call's result, or else the one named after the tool. */
function presented(record: Json, call: Json): Json | undefined {
  const shown = new Set(((call.observations ?? []) as Json[]).map((o) => o.ref));
  const lists = ((record.interactions ?? []) as Json[]).filter((i) => i.kind === "presented");
  const overlap = (p: Json): number => ((p.items ?? []) as Json[]).filter((i) => shown.has(i.ref)).length;
  const best = lists.reduce<Json | undefined>((a, p) => (a === undefined || overlap(p) > overlap(a) ? p : a), undefined);
  if (best !== undefined && overlap(best) > 0) return best;
  return lists.find((p) => p.list_kind === call.name);
}

function engaged(record: Json, shown: Json | undefined): string[] {
  if (shown === undefined) return [];
  return ((record.interactions ?? []) as Json[])
    .filter((i) => i.kind === "engaged" && String(i.exposure_id) === String(shown.exposure_id) && typeof i.ref === "string")
    .map((i) => i.ref as string);
}

/** The item's 1-based position in each list, over the whole list; absent where the list lacks it. */
function positions(ref: string, base: readonly string[], variant: readonly string[]): Json {
  return { ...(base.includes(ref) ? { base: base.indexOf(ref) + 1 } : {}), ...(variant.includes(ref) ? { variant: variant.indexOf(ref) + 1 } : {}) };
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
