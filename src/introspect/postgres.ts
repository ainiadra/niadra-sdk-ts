/**
 * One PostgreSQL table's catalog (the object type spec, 8.1), read in a read-only transaction with
 * `search_path` set to `pg_catalog` alone, so every name outside it comes schema-qualified whatever the
 * connection's own path. Only the catalog is read, never a row. Node only; needs the `pg` package.
 */

import { DeriveError } from "./derive.js";
import type { Catalog } from "./derive.js";

const TABLE = `
SELECT c.oid::text AS oid, format('%I.%I', n.nspname, c.relname) AS name
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.oid = to_regclass($1) AND c.relkind IN ('r', 'p')`;
const COLUMNS = `
SELECT a.attname::text AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
       CASE WHEN t.typtype = 'e' THEN format('%I.%I', tn.nspname, t.typname) END AS enum
FROM pg_attribute a
JOIN pg_type t ON t.oid = a.atttypid
JOIN pg_namespace tn ON tn.oid = t.typnamespace
WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`;
const CONSTRAINTS = `
SELECT con.contype::text AS kind, pg_get_constraintdef(con.oid) AS definition,
       ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(num, ord)
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num ORDER BY k.ord) AS columns,
       CASE WHEN con.contype = 'f' THEN format('%I.%I', fn.nspname, fc.relname) END AS "references",
       ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(num, ord)
             JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num ORDER BY k.ord)
         AS referenced_columns
FROM pg_constraint con
LEFT JOIN pg_class fc ON fc.oid = con.confrelid
LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
WHERE con.conrelid = $1::oid AND con.contype IN ('p', 'c', 'f')`;
const ENUMS = `
SELECT format('%I.%I', n.nspname, t.typname) AS name,
       array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.oid IN (SELECT a.atttypid FROM pg_attribute a
                WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped)
GROUP BY 1`;
const TRIGGERS = `
SELECT tgname::text AS name, pg_get_triggerdef(oid) AS definition, tgenabled <> 'D' AS enabled
FROM pg_trigger WHERE tgrelid = $1::oid AND NOT tgisinternal`;

type Row = Record<string, unknown>;

interface PgClient {
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
}

/**
 * The catalog of `table` (`schema.name`, or a name in `public`) as the derivation takes it. Rejects with a
 * `DeriveError` (`table_not_found`) for a table the connection cannot see.
 */
export async function readCatalog(dsn: string, table: string): Promise<Catalog> {
  let Client: new (options: { connectionString: string }) => PgClient;
  try {
    const pg = (await import("pg")) as unknown as { default?: { Client: typeof Client }; Client?: typeof Client };
    const found = pg.default?.Client ?? pg.Client;
    if (found === undefined) throw new Error("no Client");
    Client = found;
  } catch {
    throw new Error("reading a PostgreSQL catalog needs the pg package: npm install pg");
  }
  const qualified = table.includes(".") ? table : `public.${table}`;
  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL search_path TO pg_catalog");
    const found = (await client.query(TABLE, [qualified])).rows[0];
    if (found === undefined) throw new DeriveError("table_not_found", `no table ${qualified} this connection can read`);
    const oid = String(found.oid);
    const columns = (await client.query(COLUMNS, [oid])).rows.map((r) => ({
      name: String(r.name),
      type: String(r.type),
      not_null: Boolean(r.not_null),
      ...(typeof r.enum === "string" ? { enum: r.enum } : {}),
    }));
    const constraints = (await client.query(CONSTRAINTS, [oid])).rows;
    const enums = (await client.query(ENUMS, [oid])).rows.map((r) => ({ name: String(r.name), labels: (r.labels as string[]).map(String) }));
    const triggers = (await client.query(TRIGGERS, [oid])).rows.map((r) => ({
      name: String(r.name),
      definition: String(r.definition),
      enabled: Boolean(r.enabled),
    }));
    return {
      catalog: "postgresql",
      table: String(found.name),
      columns,
      primary_key: (constraints.find((r) => r.kind === "p")?.columns as string[] | undefined) ?? [],
      checks: constraints.filter((r) => r.kind === "c").map((r) => String(r.definition)),
      enums,
      foreign_keys: constraints
        .filter((r) => r.kind === "f")
        .map((r) => ({ columns: r.columns as string[], references: String(r.references), referenced_columns: r.referenced_columns as string[] })),
      triggers,
    };
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}
