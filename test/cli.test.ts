// The `niadra` command for Node: `types derive` and `--check` against a real PostgreSQL
// (NIADRA_TEST_POSTGRES_DSN), `contract test` with its exit codes, and the replay and resolver worker commands.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Niadra, silentLogger } from "../src/index.js";
import type { ClaimContractSummary } from "../src/index.js";
import { checkContract } from "../src/cli/contract.js";
import { load, main } from "../src/cli/index.js";
import type { Io } from "../src/cli/index.js";
import { derive } from "../src/introspect/derive.js";
import { readCatalog } from "../src/introspect/postgres.js";
import { Cell } from "./support/cell.js";
import { KEY } from "./helpers.js";

const DSN = process.env.NIADRA_TEST_POSTGRES_DSN;
const CONTRACTS = new URL("../spec/examples/claim-contract/", import.meta.url);
const RETAIL = new URL("retail.json", CONTRACTS).pathname;

function io(cell?: Cell): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let niadra: Niadra | undefined;
  return {
    stdout,
    stderr,
    out: (text) => void stdout.push(text),
    err: (text) => void stderr.push(text),
    client: () => (niadra ??= new Niadra({ apiKey: KEY, fetch: (cell ?? new Cell()).fetch, logger: silentLogger, flushOnExit: false })),
  };
}

const temp = (): string => mkdtempSync(join(tmpdir(), "niadra-cli-"));

describe.skipIf(!DSN)("niadra types derive", () => {
  let schema = "";

  async function sql(statement: string): Promise<void> {
    const pg = await import("pg");
    const client = new pg.default.Client({ connectionString: DSN });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  }

  beforeEach(async () => {
    schema = `derive_${Math.random().toString(16).slice(2, 10)}`;
    await sql(`CREATE SCHEMA ${schema};
      CREATE TYPE ${schema}.channel AS ENUM ('store', 'site', 'app');
      CREATE TABLE ${schema}.customers (id uuid PRIMARY KEY);
      CREATE TABLE ${schema}.orders (
        id uuid PRIMARY KEY,
        customer_id uuid NOT NULL REFERENCES ${schema}.customers(id),
        status text NOT NULL CONSTRAINT orders_status CHECK (status IN ('open', 'paid', 'shipped')),
        channel ${schema}.channel NOT NULL,
        total numeric(12,2) NOT NULL CHECK (total >= 0),
        placed_at timestamptz NOT NULL,
        meta jsonb)`);
  });

  afterEach(async () => {
    await sql(`DROP SCHEMA ${schema} CASCADE`);
  });

  it("writes the proposal and lists the review", async () => {
    const out = join(temp(), "orders.json");
    const streams = io();
    expect(await main(["types", "derive", "--dsn", DSN!, "--table", `${schema}.orders`, "--out", out], streams)).toBe(0);
    const declared = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    expect(declared).toMatchObject({
      type: "orders",
      states: ["open", "paid", "shipped"],
      relations: { customer: { type: "customers", via: "customer_id" } },
      mirror_of: { derived_by: "introspection" },
    });
    expect(streams.stderr.join("\n")).toContain("column meta (jsonb)");
  });

  it("reads the catalog, schema-qualified, as the derivation takes it", async () => {
    const catalog = await readCatalog(DSN!, `${schema}.orders`);
    expect(catalog.table).toBe(`${schema}.orders`);
    expect(catalog.checks).toContain("CHECK ((total >= (0)::numeric))");
    expect(catalog.enums).toEqual([{ name: `${schema}.channel`, labels: ["store", "site", "app"] }]);
    expect(catalog.foreign_keys).toEqual([{ columns: ["customer_id"], references: `${schema}.customers`, referenced_columns: ["id"] }]);
  });

  it("opens drift on a new value in a CHECK, and Niadra hears only the fingerprint and the counts", async () => {
    const dir = temp();
    const declaration = join(dir, "orders.json");
    const table = ["--dsn", DSN!, "--table", `${schema}.orders`];
    expect(await main(["types", "derive", ...table, "--out", declaration], io())).toBe(0);
    const cell = new Cell();
    cell.features.add("state");
    cell.types = [JSON.parse(readFileSync(declaration, "utf8")) as Record<string, unknown>];
    const check = ["types", "derive", "--check", ...table, "--declaration", declaration];
    expect(await main(check, io(cell))).toBe(0);

    await sql(`ALTER TABLE ${schema}.orders DROP CONSTRAINT orders_status;
      ALTER TABLE ${schema}.orders ADD CONSTRAINT orders_status CHECK (status IN ('open', 'paid', 'shipped', 'returned'))`);
    const streams = io(cell);
    expect(await main(check, streams)).toBe(1);
    const report = JSON.parse(streams.stdout.join("\n")) as Record<string, any>;
    expect(report).toMatchObject({ drift: true, issue_id: "di_1", changes: { states_added: 1, fields: ["status"] } });
    expect(streams.stderr).toContain("state added: returned");
    const sent = cell.fingerprints.at(-1) as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual(["type", "fingerprint", "changes"]);
    expect(JSON.stringify(sent)).not.toContain("returned");
  });

  it("lets Niadra decide without a declaration, and says so for a table it cannot see", async () => {
    const cell = new Cell();
    cell.features.add("state");
    cell.types = [(await derive(await readCatalog(DSN!, `${schema}.orders`))).type];
    const check = ["types", "derive", "--check", "--dsn", DSN!, "--table", `${schema}.orders`];
    expect(await main(check, io(cell))).toBe(0);
    await sql(`ALTER TABLE ${schema}.orders ALTER COLUMN meta SET NOT NULL`);
    expect(await main(check, io(cell))).toBe(1);
    const missing = io();
    expect(await main(["types", "derive", "--dsn", DSN!, "--table", "nowhere.orders"], missing)).toBe(2);
    expect(missing.stderr.join("\n")).toContain("table_not_found");
  });
});

describe("niadra contract test", () => {
  it("passes each example contract against its own corpus", async () => {
    for (const sector of ["retail", "legal", "health-plan-sales"]) {
      const streams = io();
      expect(await main(["contract", "test", "--contract", new URL(`${sector}.json`, CONTRACTS).pathname], streams), sector).toBe(0);
      expect(JSON.parse(streams.stdout.join("\n"))).toMatchObject({ triggered: 0 });
    }
  });

  it("fails the CI for a phrase that triggers and for an example that differs", async () => {
    const dir = temp();
    const corpus = join(dir, "corpus.json");
    writeFileSync(corpus, JSON.stringify({ version: "2026-10-01", phrases: ["Está por R$ 150,00 hoje."] }));
    const streams = io();
    expect(await main(["contract", "test", "--contract", RETAIL, "--corpus", corpus], streams)).toBe(1);
    expect(streams.stderr.join("\n")).toContain("triggered:");

    const examples = join(dir, "examples.json");
    const good = {
      examples: [
        {
          id: "sale_price_with_evidence",
          output: { text: "Está por R$ 199,90.", lang: "pt" },
          turn: { values: [{ class: "money", role: "price_sale", value: { amount: "199.9", unit: "BRL" } }] },
          expect: { claims: [{ category: "price", verdict: "matched", action: "none" }] },
        },
        { id: "no_claim", output: { text: "Quer que eu separe por cor ou por tamanho?", lang: "pt" }, expect: { claims: [] } },
      ],
    };
    writeFileSync(examples, JSON.stringify(good));
    expect(await main(["contract", "test", "--contract", RETAIL, "--examples", examples], io())).toBe(0);
    good.examples[1]!.expect.claims = [{ category: "price", verdict: "matched", action: "none" }];
    writeFileSync(examples, JSON.stringify(good));
    const failing = io();
    expect(await main(["contract", "test", "--contract", RETAIL, "--examples", examples], failing)).toBe(1);
    expect(failing.stderr.join("\n")).toContain("example no_claim");
  });

  it("takes the profile's contract with the company's corpus, which the profile never carries", async () => {
    const cell = new Cell();
    cell.features.add("claims");
    cell.claimContract = JSON.parse(readFileSync(RETAIL, "utf8")) as ClaimContractSummary;
    const streams = io(cell);
    expect(await main(["contract", "test", "--corpus", RETAIL], streams)).toBe(0);
    expect(JSON.parse(streams.stdout.join("\n"))).toMatchObject({ contract: "2026-09-29.1" });
    expect(await main(["contract", "test"], io(cell))).toBe(2);
  });

  it("reports what it cannot read as an error, never as a pass", async () => {
    const dir = temp();
    const broken = join(dir, "contract.json");
    writeFileSync(broken, "{not json");
    expect(await main(["contract", "test", "--contract", broken], io())).toBe(2);
    expect(await main(["nothing"], io())).toBe(2);
  });

  it("finds a phrase that triggers in any of the contract's languages", () => {
    const contract = JSON.parse(readFileSync(new URL("health-plan-sales.json", CONTRACTS), "utf8")) as ClaimContractSummary;
    const report = checkContract(contract, ["O plano sai por R$ 499,90 por pessoa."]);
    expect(report.triggered.length).toBeGreaterThan(0);
  });
});

describe("the commands that run the company's code", () => {
  it("load a module's export by path", async () => {
    expect(typeof (await load("node:path:join"))).toBe("function");
    await expect(load("no-colon")).rejects.toThrow("module:export");
  });

  it("serve the refresh requests once with the resolvers a module registers", async () => {
    const cell = new Cell();
    cell.features.add("state");
    cell.requestRefresh("health_quote:op:q-77");
    const dir = temp();
    const module = join(dir, "resolvers.mjs");
    writeFileSync(module, "export function register(resolvers) { resolvers.register('health_quote', async () => ({ price_full: 499.9 })); }\n");
    const streams = io(cell);
    expect(await main(["resolver-worker", "--resolvers", `${module}:register`, "--once"], streams)).toBe(0);
    expect(streams.stdout).toEqual(["pushed 1 objects"]);
    expect(cell.pushes).toHaveLength(1);
  });
});
