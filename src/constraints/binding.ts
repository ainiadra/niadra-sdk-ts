/**
 * A tool's binding (`tool-bindings`, as the object type registry writes it): which argument carries which field,
 * how to read the objects out of a result, and what the tool can do.
 *
 * ```ts
 * const SEARCH = {
 *   tool: "search_products",
 *   args: [{ attr: "item_variant.color", param: "color", negation: { param: "not_color" } }],
 *   results: [{ path: "ui.cards[*]", type: "item_variant", namespace: "store", id: "variant_id", fields: { color: "color" } }],
 *   capabilities: { overfetch: false, relax_flag: "$.meta.relaxed", dry_run_param: "dry_run" },
 * };
 * ```
 *
 * `parseBinding()` gives the renderer its `Binding`; `resultItems()` reads a result's objects keyed `type.field`,
 * with their `ref` (`type:namespace:id`), which is what the SDK measures the hard constraints sent against and
 * what the tool counterfactual compares. The Python SDK reads bindings the same way.
 */

import type { Binding } from "./render.js";

export interface RawBinding {
  tool: string;
  args?: readonly { attr: string; param: string; transform?: "lower" | "upper" | null; negation?: { param?: string } | null; ops?: readonly string[] }[];
  results?: readonly { path?: string; type?: string; namespace?: string; id?: string; fields?: Readonly<Record<string, string>> }[];
  capabilities?: { overfetch?: boolean; relax_flag?: string; dry_run_param?: string; mask_output?: boolean };
  overfetch?: boolean;
}

type Json = Record<string, unknown>;

/** The binding the renderer takes. `families` maps a field (`type.field`) to its attribute family. */
export function parseBinding(raw: RawBinding, families: Readonly<Record<string, string>> = {}): Binding {
  return {
    tool: raw.tool,
    args: (raw.args ?? []).map((a) => ({
      attr: a.attr,
      param: a.param,
      transform: a.transform ?? null,
      negation: a.negation?.param ?? null,
      ops: [...(a.ops ?? [])],
      family: families[a.attr] ?? null,
    })),
    overfetch: raw.overfetch ?? raw.capabilities?.overfetch ?? false,
  };
}

/** The objects a result shows, in order: each `{ref, "<type>.<field>": value}`. */
export function resultItems(raw: RawBinding, result: unknown): Json[] {
  const out: Json[] = [];
  for (const spec of raw.results ?? []) {
    for (const found of readPath(result, spec.path ?? "$")) {
      if (typeof found !== "object" || found === null || Array.isArray(found)) continue;
      const entry = found as Json;
      const item: Json = {};
      for (const [field, key] of Object.entries(spec.fields ?? {})) if (key in entry) item[`${String(spec.type)}.${field}`] = entry[key];
      const ident = entry[spec.id ?? "id"];
      if (typeof ident === "string" || typeof ident === "number") item.ref = `${String(spec.type)}:${spec.namespace ?? "default"}:${String(ident)}`;
      out.push(item);
    }
  }
  return out;
}

/** Whether the result says the tool relaxed what it was asked (the binding's `relax_flag`). */
export function relaxed(raw: RawBinding, result: unknown): boolean {
  const path = raw.capabilities?.relax_flag;
  return typeof path === "string" && readPath(result, path).some((v) => v === true);
}

/** What a small path reads out of a JSON value: `$` the value, `a.b` a key, `a[*]` each item of a list. */
export function readPath(value: unknown, path: string): unknown[] {
  let found: unknown[] = [value];
  const trimmed = path.replace(/^\$/, "").replace(/^\.+|\.+$/g, "");
  if (!trimmed) return found;
  for (const part of trimmed.split(".")) {
    const many = part.endsWith("[*]");
    const key = many ? part.slice(0, -3) : part;
    const step: unknown[] = [];
    for (const current of found) {
      const got = key ? (typeof current === "object" && current !== null ? (current as Json)[key] : undefined) : current;
      if (many) {
        if (Array.isArray(got)) step.push(...(got as unknown[]));
      } else if (got !== undefined && got !== null) step.push(got);
    }
    found = step;
  }
  return found;
}
