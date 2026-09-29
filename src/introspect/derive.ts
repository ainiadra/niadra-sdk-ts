/**
 * A type derived from the company's own PostgreSQL schema (the object type spec, section 8), inside the
 * company's boundary: the catalog is read, never a row, and neither the catalog nor the proposal leaves.
 *
 * `derive()` turns one table's catalog into a proposed type, with the fingerprint of what it read and the
 * review a person must do before the proposal goes up as a configuration change: triggers are code, and a
 * CHECK that is not a list of values is not read. `changes()` is the drift report `niadra types derive
 * --check` sends with the fingerprint: counts, and the names the declaration already holds, never the schema.
 * It passes the spec's vectors (`spec/vectors/type-derive.v0.json`), as the Python SDK does.
 */

import { canonicalJson, jsonDigest } from "../digest.js";

type Json = Record<string, unknown>;

/** A column as the catalog read lists it. */
export interface CatalogColumn {
  name: string;
  type: string;
  not_null: boolean;
  enum?: string;
}

/** One table's catalog: its columns, keys, checks, enumerations and triggers, never a row. */
export interface Catalog {
  catalog: string;
  table: string;
  columns: CatalogColumn[];
  primary_key: string[];
  checks: string[];
  enums: { name: string; labels: string[] }[];
  foreign_keys: { columns: string[]; references: string; referenced_columns: string[] }[];
  triggers: { name: string; definition: string; enabled: boolean }[];
}

export interface DeriveOptions {
  /** The type's name; the table's by default. */
  type?: string;
  /** The system the type mirrors; `postgresql` by default. */
  system?: string;
  /** `subject` (the default) or `shared`: an agent's working state is never derived. */
  ownership?: string;
}

/** A proposed type (it validates against `object-type.v0`), its catalog's fingerprint, and the review. */
export interface Derived {
  type: Json;
  fingerprint: string;
  review: Json[];
}

/** The counts `--check` sends with the fingerprint, and the declared fields they touch. */
export interface Changes {
  fields_added: number;
  fields_removed: number;
  fields_retyped: number;
  states_added: number;
  states_removed: number;
  relations_added: number;
  relations_removed: number;
  key_changed: boolean;
  fields: string[];
}

/** A catalog or an option the derivation refuses, named by `code`. */
export class DeriveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeriveError";
  }
}

// niadra-expr's keywords and context names (the object type spec, 5.5): no field takes them.
const RESERVED = new Set([
  ...["and", "or", "not", "in", "true", "false", "none", "yes", "no", "unobserved", "known_defect"],
  ...["state", "derived_status", "watch_count", "purpose", "config"],
]);
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const NUMBER = /^-?[0-9]+(?:\.[0-9]+)?$/;
const NUMERIC = new Set(["smallint", "integer", "bigint", "numeric", "real", "double precision"]);
const IDENTIFIER = /^(?:[a-z_][a-z0-9_$]*|"(?:[^"]|"")+")$/;
const STRINGS = new Set(["text", "character varying", "character", "citext", "uuid"]);
const MAX_FIELDS = 200;
const MAX_RELATIONS = 20;
const MAX_KEY = 8;
const MAX_STATES = 50;

const byUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The catalog in the order the fingerprint hashes (section 8.2), every order by UTF-16 code units. */
export function normalize(catalog: Catalog): Catalog {
  if (catalog.catalog !== "postgresql") throw new DeriveError("unknown_catalog", "only a PostgreSQL catalog is read");
  if (typeof catalog.table !== "string" || splitTop(catalog.table, ".").length !== 2) {
    throw new DeriveError("invalid_catalog", "the table is named <schema>.<name>");
  }
  const columns = catalog.columns.map((c) => ({
    name: c.name,
    type: c.type,
    not_null: c.not_null,
    ...(c.enum ? { enum: c.enum } : {}),
  }));
  if (columns.length === 0) throw new DeriveError("no_columns", "the table has no columns");
  const foreignKeys = catalog.foreign_keys.map((f) => ({
    columns: [...f.columns],
    references: f.references,
    referenced_columns: [...f.referenced_columns],
  }));
  return {
    catalog: "postgresql",
    table: catalog.table,
    columns: columns.sort((a, b) => byUnits(a.name, b.name)),
    primary_key: [...catalog.primary_key],
    checks: catalog.checks.map(String).sort(byUnits),
    enums: catalog.enums.map((e) => ({ name: e.name, labels: [...e.labels] })).sort((a, b) => byUnits(a.name, b.name)),
    foreign_keys: foreignKeys.sort((a, b) => byUnits(canonicalJson(a), canonicalJson(b))),
    triggers: catalog.triggers
      .map((t) => ({ name: t.name, definition: t.definition, enabled: t.enabled }))
      .sort((a, b) => byUnits(a.name, b.name)),
  };
}

/** `sha256:<hex>` over the canonical JSON of the normalized catalog (section 8.3). */
export async function fingerprint(catalog: Catalog): Promise<string> {
  return (await jsonDigest(normalize(catalog))).sha256;
}

/**
 * A catalog name as a name of the type (section 8.5): A to Z lowercased, every other code point outside
 * `[a-z0-9_]` one `_`, `c_` before a name that does not start with a letter, cut at `limit`, and `_` after a
 * reserved word.
 */
export function toName(raw: string, limit = 64): string {
  let out = "";
  for (const ch of raw) {
    if (ch >= "A" && ch <= "Z") out += ch.toLowerCase();
    else if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_") out += ch;
    else out += "_";
  }
  if (!/^[a-z]/.test(out)) out = `c_${out}`;
  out = out.slice(0, limit);
  return RESERVED.has(out) ? `${out}_` : out;
}

/** The proposed type of one table (section 8.4). */
export async function derive(catalog: Catalog, options: DeriveOptions = {}): Promise<Derived> {
  const normalized = normalize(catalog);
  const ownership = options.ownership ?? "subject";
  if (ownership !== "subject" && ownership !== "shared") {
    throw new DeriveError("ownership_not_derivable", "a derived type is a subject's or a shared one");
  }
  const name = options.type ?? toName(lastName(normalized.table), 40);
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) throw new DeriveError("invalid_name", `${JSON.stringify(name)} is not a type name`);
  const system = options.system ?? "postgresql";
  if (!/^[a-z][a-z0-9_.:-]{0,63}$/.test(system)) throw new DeriveError("invalid_name", `${JSON.stringify(system)} is not a system name`);

  const review: Json[] = [];
  const columns = normalized.columns;
  const names = fieldNames(columns.map((c) => c.name));
  const lists = new Map<string, unknown[]>();
  const unread: string[] = [];
  for (const definition of normalized.checks) {
    const found = listCheck(definition);
    if (found !== null && names.has(found[0])) {
      if (!lists.has(found[0])) lists.set(found[0], found[1]);
    } else unread.push(definition);
  }
  const singleFks = new Set(normalized.foreign_keys.filter((f) => f.columns.length === 1).map((f) => f.columns[0]));
  const labels = new Map(normalized.enums.map((e) => [e.name, e.labels]));

  const fields: Record<string, Json> = {};
  let count = 0;
  for (const column of columns) {
    const kind = fieldType(column, singleFks, lists);
    if (kind === null || count >= MAX_FIELDS) {
      review.push({ kind: "column", column: column.name, type: column.type });
      continue;
    }
    fields[names.get(column.name) ?? column.name] = { type: kind };
    count++;
  }
  for (const definition of unread) review.push({ kind: "check", definition });

  const digest = (await jsonDigest(normalized)).sha256;
  const declared: Json = {
    type: name,
    version: "1",
    ownership,
    mirror_of: { system, derived_by: "introspection", fingerprint: digest, drift: "alert" },
  };
  const key = normalized.primary_key;
  if (key.length > 0 && key.length <= MAX_KEY && key.every((c) => Object.hasOwn(fields, names.get(c) ?? ""))) {
    declared.key = { natural: key.map((c) => names.get(c) ?? c) };
  }
  declared.fields = fields;

  const status = ["status", "state"].find((c) => Object.hasOwn(fields, names.get(c) ?? ""));
  if (status !== undefined) {
    const column = columns.find((c) => c.name === status);
    const values = column?.enum ? labels.get(column.enum) : lists.get(status);
    if (values !== undefined) {
      if (values.length > 0 && values.length <= MAX_STATES && values.every((v) => typeof v === "string" && NAME.test(v))) {
        declared.states = [...new Set(values as string[])];
      } else review.push({ kind: "states", column: status });
    }
  }

  const relations: Record<string, Json> = {};
  const taken = new Set<string>();
  for (const fk of normalized.foreign_keys) {
    const [only] = fk.columns;
    const field = fk.columns.length === 1 && only !== undefined ? names.get(only) : undefined;
    if (field === undefined || !Object.hasOwn(fields, field) || Object.keys(relations).length >= MAX_RELATIONS) {
      review.push({ kind: "foreign_key", columns: fk.columns, references: fk.references });
      continue;
    }
    const role = unused(roleOf(field), taken, 64);
    taken.add(role);
    relations[role] = { type: toName(lastName(fk.references), 40), via: field };
  }
  if (Object.keys(relations).length > 0) declared.relations = relations;
  for (const trigger of normalized.triggers) review.push({ kind: "trigger", name: trigger.name, enabled: trigger.enabled });
  return { type: declared, fingerprint: digest, review };
}

/**
 * What differs between the declaration and the type the live catalog derives (section 8.8): counts, and the
 * declared fields the difference touches. Never a new name, a value or a definition.
 */
export function changes(declared: Json, live: Json): Changes {
  const before = (declared.fields ?? {}) as Record<string, Json>;
  const after = (live.fields ?? {}) as Record<string, Json>;
  const removed = Object.keys(before).filter((n) => !Object.hasOwn(after, n));
  const retyped = Object.keys(before).filter((n) => Object.hasOwn(after, n) && before[n]?.type !== after[n]?.type);
  const statesBefore = new Set((declared.states ?? []) as string[]);
  const statesAfter = new Set((live.states ?? []) as string[]);
  const relationsBefore = new Set(Object.keys((declared.relations ?? {})));
  const relationsAfter = new Set(Object.keys((live.relations ?? {})));
  const touched = new Set([...removed, ...retyped]);
  const sameStates = statesBefore.size === statesAfter.size && [...statesBefore].every((s) => statesAfter.has(s));
  if (!sameStates) {
    const holder = ["status", "state_"].find((f) => Object.hasOwn(before, f));
    if (holder !== undefined) touched.add(holder);
  }
  const naturalOf = (t: Json): string[] => (((t.key ?? {}) as Json).natural ?? []) as string[];
  const keyBefore = naturalOf(declared);
  const keyAfter = naturalOf(live);
  return {
    fields_added: Object.keys(after).filter((n) => !Object.hasOwn(before, n)).length,
    fields_removed: removed.length,
    fields_retyped: retyped.length,
    states_added: [...statesAfter].filter((s) => !statesBefore.has(s)).length,
    states_removed: [...statesBefore].filter((s) => !statesAfter.has(s)).length,
    relations_added: [...relationsAfter].filter((r) => !relationsBefore.has(r)).length,
    relations_removed: [...relationsBefore].filter((r) => !relationsAfter.has(r)).length,
    key_changed: keyBefore.length !== keyAfter.length || keyBefore.some((c, i) => c !== keyAfter[i]),
    fields: [...touched].sort(byUnits).slice(0, 50),
  };
}

/**
 * The column and the values of a CHECK that holds a column to a list, as `pg_get_constraintdef` writes it
 * (section 8.6): `CHECK ((status = ANY (ARRAY['open'::text, 'paid'::text])))`, the same with a cast of the
 * column and of the array, or `CHECK ((status = 'open'::text))`. Anything else is null.
 */
export function listCheck(definition: string): [string, unknown[]] | null {
  let text = definition.trim();
  if (!text.startsWith("CHECK ")) return null;
  text = text.slice("CHECK ".length);
  if (text.endsWith(" NOT VALID")) text = text.slice(0, -" NOT VALID".length);
  const parts = splitTop(unwrap(text), " = ");
  if (parts.length !== 2) return null;
  const [left = "", right = ""] = parts;
  const column = columnOf(left);
  if (column === null) return null;
  let values: unknown[] | null;
  if (right.startsWith("ANY (") && right.endsWith(")")) values = arrayOf(right.slice("ANY (".length, -1));
  else {
    const single = literal(right);
    values = single === undefined ? null : [single];
  }
  return values === null ? null : [column, values];
}

function lastName(qualified: string): string {
  const parts = splitTop(qualified, ".");
  return unquote(parts.at(-1) ?? "");
}

function fieldNames(columns: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const column of columns) {
    const name = unused(toName(column), taken, 64);
    taken.add(name);
    out.set(column, name);
  }
  return out;
}

function unused(name: string, taken: Set<string>, limit: number): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = `_${String(n)}`;
    const candidate = name.slice(0, limit - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

function roleOf(field: string): string {
  const role = field.endsWith("_id") ? field.slice(0, -3) : field;
  return NAME.test(role) && !RESERVED.has(role) ? role : field;
}

function fieldType(column: CatalogColumn, fks: Set<string | undefined>, lists: Map<string, unknown[]>): string | null {
  if (fks.has(column.name)) return "ref";
  if (column.enum || lists.has(column.name)) return "enum";
  if (column.type.endsWith("[]")) return "list";
  const base = (column.type.split("(", 1)[0] ?? "").trim();
  if (STRINGS.has(base)) return "string";
  if (NUMERIC.has(base)) return "number";
  if (base === "money") return "money";
  if (base === "boolean") return "bool";
  if (base === "date") return "date";
  if (base.startsWith("timestamp")) return "datetime";
  if (base === "interval") return "duration";
  return null;
}

/** The depth of parentheses and brackets at each character, outside literals and quoted names (-1 inside them). */
function depths(text: string): number[] {
  const out: number[] = [];
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote) {
      out.push(-1);
      if (ch === quote) {
        if (text[i + 1] === quote) {
          out.push(-1);
          i++;
          continue;
        }
        quote = "";
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out.push(-1);
    } else if (ch === "(" || ch === "[") {
      out.push(depth);
      depth++;
    } else if (ch === ")" || ch === "]") {
      depth--;
      out.push(depth);
    } else out.push(depth);
  }
  return out;
}

function unwrap(raw: string): string {
  let text = raw.trim();
  while (text.startsWith("(") && text.endsWith(")")) {
    if (depths(text).slice(1, -1).includes(0)) return text;
    text = text.slice(1, -1).trim();
  }
  return text;
}

function splitTop(text: string, separator: string): string[] {
  const d = depths(text);
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i <= text.length - separator.length) {
    if (d[i] === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i).trim());
      i += separator.length;
      start = i;
      continue;
    }
    i++;
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function uncast(raw: string): [string, string | null] {
  let text = unwrap(raw);
  let cast: string | null = null;
  for (;;) {
    const parts = splitTop(text, "::");
    if (parts.length < 2) return [text, cast];
    cast = parts.at(-1) ?? "";
    text = unwrap(parts.slice(0, -1).join("::"));
  }
}

function columnOf(text: string): string | null {
  const [bare] = uncast(text);
  return IDENTIFIER.test(bare) ? unquote(bare) : null;
}

function unquote(name: string): string {
  return name.length >= 2 && name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name;
}

function arrayOf(text: string): unknown[] | null {
  const [bare] = uncast(text);
  if (!(bare.startsWith("ARRAY[") && bare.endsWith("]"))) return null;
  const inner = bare.slice("ARRAY[".length, -1);
  if (!inner.trim()) return null;
  const values: unknown[] = [];
  for (const item of splitTop(inner, ",")) {
    const value = literal(item);
    if (value === undefined) return null;
    values.push(value);
  }
  return values;
}

/** A constant of a list: a string literal, or a number (PostgreSQL writes a negative one as a cast string). */
function literal(text: string): string | number | undefined {
  const [bare, cast] = uncast(text);
  const base = (cast ?? "").split("(", 1)[0]?.trim() ?? "";
  if (bare.length >= 2 && bare.startsWith("'") && bare.endsWith("'")) {
    const inner = bare.slice(1, -1);
    if (inner.replaceAll("''", "").includes("'")) return undefined;
    const value = inner.replaceAll("''", "'");
    return NUMERIC.has(base) && NUMBER.test(value) ? Number(value) : value;
  }
  return NUMBER.test(bare) ? Number(bare) : undefined;
}
