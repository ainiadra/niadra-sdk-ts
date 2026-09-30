// The tool counterfactual: does an element of the constraints block change what a tool returns? For each
// recorded call of the tool, the runner runs the recorded arguments twice (the tool's own noise) and once
// without the element (here the hard constraints), all at the same moment and only when the tool is safe
// to run again (`dryRun: true`, or its binding's `dry_run_param`). Niadra gets positions and overlaps
// only, never the items. From the company's CI:
//   npx niadra counterfactual --tools ./examples/tool-counterfactual.js:TOOLS --tool search_products \
//     --element hard --turn <turn id> --label "$GIT_SHA"
//   NIADRA_API_KEY=...   (the `turns`, `signals` and `measurement` features, a key with the `replay` scope)
// The space binds the tool in its `tool-bindings` document, which the SDK profile serves: how its arguments
// carry a constraint and how its result shows the items, for example
//   { "tool": "search_products",
//     "args": [{ "attr": "item_variant.color", "param": "color", "negation": { "param": "not_color" } }],
//     "results": [{ "path": "cards[*]", "type": "item_variant", "namespace": "store", "id": "variant_id",
//                   "fields": { "color": "color" } }] }
import { Counterfactual, tool } from "@niadra/sdk";
import type { Niadra } from "@niadra/sdk";

const CATALOG = (
  [
    ["red", 120],
    ["blue", 90],
    ["red", 80],
    ["black", 150],
    ["blue", 60],
  ] as const
).map(([color, price], n) => ({ variant_id: String(n), color, price }));

/** A read-only search, cheapest first: safe to run again. */
export const searchProducts = tool(
  "search_products",
  (q: { not_color?: string[] | null; color?: string | null }) => {
    const refused = new Set(q.not_color ?? []);
    return { cards: CATALOG.filter((c) => !refused.has(c.color) && (q.color == null || c.color === q.color)).sort((a, b) => a.price - b.price) };
  },
  { dryRun: true },
);

export const TOOLS = { search_products: searchProducts };

/** Runs the counterfactual of the hard constraints over these turns and returns the report. */
export async function measure(niadra: Niadra, turnIds: string[], label?: string): Promise<Record<string, unknown>> {
  const run = await new Counterfactual(niadra, TOOLS).run(turnIds, { tool: "search_products", element: "hard", ...(label ? { label } : {}) });
  return { cases: run.cases.length, untouched: run.untouched, ...run.report };
}
