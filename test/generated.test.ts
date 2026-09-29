// The route types and methods generated from the server's OpenAPI document (spec/openapi/cell.json), and
// the turn records of the specification's examples read through them.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CUT, ROOT, cut, generate, publicText, splitNames } from "../scripts/sync-spec.js";
import type { Document } from "../scripts/sync-spec.js";
import { Api, Niadra, NiadraAPIError, NiadraConfigError, NiadraNotAvailableError, silentLogger } from "../src/index.js";
import type { TurnCall, TurnRecord, TurnsRequest } from "../src/index.js";
import { MockServer, batchOk, makeClient, problem } from "./helpers.js";

const document = JSON.parse(readFileSync(CUT, "utf8")) as Document;
const examples = readdirSync(join(ROOT, "spec", "examples", "turn-record")).sort();
const schemaKeys = (name: string): string[] => Object.keys(document.components.schemas[name]?.properties ?? {}).sort();

// Each record names every field of its type and nothing else, or the typecheck fails.
const recordKeys: Record<keyof TurnRecord, true> = {
  agent: true,
  blobs: true,
  build: true,
  calls: true,
  claims: true,
  completeness: true,
  content_mode: true,
  conversation_id: true,
  coordination: true,
  cost: true,
  effects: true,
  ended_at: true,
  fidelity: true,
  flags: true,
  interactions: true,
  kind: true,
  latency_ms: true,
  output: true,
  reads: true,
  spec: true,
  started_at: true,
  task_id: true,
  turn_id: true,
};

const record = (fields: Partial<TurnRecord> = {}): TurnRecord => ({
  turn_id: "t-1",
  conversation_id: "c-8812",
  agent: { name: "closing" },
  started_at: "2026-09-29T14:02:11Z",
  content_mode: "hash_only",
  ...fields,
});

describe("the generated routes", () => {
  it("are what the cut document gives", () => {
    for (const [path, text] of generate(document)) {
      expect(readFileSync(join(ROOT, path), "utf8"), `${path} is stale: run pnpm sync-spec`).toBe(text);
    }
  });

  it("have one method per operation of the document", () => {
    const operations = Object.values(document.paths).flatMap((methods) => Object.keys(methods));
    const methods = Object.getOwnPropertyNames(Api.prototype).filter((name) => name !== "constructor");
    expect(operations).toHaveLength(60);
    expect(methods).toHaveLength(60);
  });

  it("type the turn record with exactly the fields of its schema", () => {
    expect(Object.keys(recordKeys).sort()).toEqual(schemaKeys("TurnRecord"));
  });

  it.each(examples)("read the specification's example %s as a turn record", (name) => {
    const example = JSON.parse(readFileSync(join(ROOT, "spec", "examples", "turn-record", name), "utf8")) as TurnRecord;
    expect(Object.keys(example).every((key) => key in recordKeys)).toBe(true);
    expect(example.spec ?? "turn-record.v0").toBe("turn-record.v0");
  });
});

describe("a route of niadra.api", () => {
  it("rejects with NiadraNotAvailableError while the server has not built it, even fail-open", async () => {
    const server = new MockServer().on("POST /v1/turns", problem(501, "not_implemented"));
    const turns: TurnsRequest = { turns: [record()] };
    const failure: unknown = await makeClient(server).api.recordTurns(turns).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NiadraNotAvailableError);
    expect(failure).toBeInstanceOf(NiadraAPIError);
    expect((failure as Error).message).toContain("not available on this server yet");
    expect(server.calls).toHaveLength(1);
  });

  it("rejects with a 404 for a feature the space did not turn on", async () => {
    const server = new MockServer();
    const failure: unknown = await makeClient(server).api.sdkProfile().catch((error: unknown) => error);
    expect((failure as NiadraAPIError).status).toBe(404);
  });

  it("sends the body as given, by its wire names", async () => {
    const server = new MockServer().on("POST /v1/turns", batchOk(1));
    const call: TurnCall = { call_id: "m1", kind: "model", tokens: { in: 2953, out: 138 } };
    const answer = await makeClient(server).api.recordTurns({ turns: [record({ calls: [call] })] });
    expect(answer.accepted).toBe(1);
    expect(server.calls[0]!.body.turns[0].calls).toEqual([call]);
  });

  it("keys an idempotent route and retries it, and never retries one without a key", async () => {
    const promoted = { promoted: 1, already_kept: 0, not_found: 0 };
    const server = new MockServer()
      .on("POST /v1/turns/promote", problem(503, "unavailable"), { body: promoted })
      .on("POST /v1/state/read", problem(503, "unavailable"));
    const client = makeClient(server, { queue: { retryDelayMs: 1, maxRetryDelayMs: 1 } });
    expect(await client.api.promoteTurns({ turn_ids: ["t-1"], reason: "complaint" })).toEqual(promoted);
    const [first, second] = server.callsTo("POST /v1/turns/promote");
    expect(first!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(second!.headers["idempotency-key"]).toBe(first!.headers["idempotency-key"]);
    await expect(client.api.stateRead({ refs: [{ type: "invoice", namespace: "erp", id: "1" }] })).rejects.toThrow();
    expect(server.callsTo("POST /v1/state/read")).toHaveLength(1);
  });

  it("escapes path parameters and sends the query", async () => {
    const server = new MockServer()
      .on("GET /v1/profiles/p_1%2Fx/inferences", { body: { items: [] } })
      .on("GET /v1/measure/attribution", { body: { since: "2026-09-01", until: "2026-09-28", rows: [] } })
      .on("DELETE /v1/profiles/p_1/inferences/k%3A1", { status: 204 });
    const client = makeClient(server);
    await client.api.listInferences("p_1/x", { cursor: "c2" });
    expect(Object.fromEntries(server.calls[0]!.url.searchParams)).toEqual({ cursor: "c2", limit: "50" });
    await client.api.attribution({ since: "2026-09-01", until: "2026-09-28" });
    expect(server.calls[1]!.url.searchParams.get("since")).toBe("2026-09-01");
    await client.api.deleteInference("p_1", "k:1");
    expect(server.calls[2]!.method).toBe("DELETE");
  });

  it("resolves null for a success without a body, where the route allows one", async () => {
    const effect = { effect_id: "e1", attempt: 1, reserved_at: "2026-09-29T10:00:00Z", state: "reserved" };
    const server = new MockServer().on("POST /v1/coordination/effects", { status: 201, body: effect }, { status: 200 });
    const client = makeClient(server);
    const body = { effect_key: "farewell:c-1", kind: "notice" as const };
    expect(await client.api.reserveEffect(body)).toEqual(effect);
    expect(await client.api.reserveEffect(body)).toBeNull();
  });

  it("rejects when the client has no key", async () => {
    const client = new Niadra({ apiKey: "", logger: silentLogger, flushOnExit: false });
    await expect(client.api.sdkProfile()).rejects.toBeInstanceOf(NiadraConfigError);
  });

});

describe("the generator", () => {
  it.each([
    "One entry of the record (front A9).",
    "Kept by (A7) for now.",
    "Shipped with the core wave.",
    "Planned for the wave after next.",
    "Built in phase 7.",
    "Merged by the integrator.",
    "As study 42 says.",
    "Veja o estudo.",
  ])("stops on a server description naming internal planning: %s", (text) => {
    expect(() => publicText(text, "Schema.field")).toThrow(/internal planning/);
  });

  it("names the halves of a model the server documents twice", () => {
    expect([...splitNames(["Page", "Result-Input"])]).toEqual([["Result-Input", "Result"]]);
    expect([...splitNames(["Result-Input", "Result-Output"])]).toEqual([
      ["Result-Input", "Result"],
      ["Result-Output", "ResultOutput"],
    ]);
    expect(() => splitNames(["Result", "Result-Input"])).toThrow(/taken/);
  });

  it("publishes a body the server declares inline as its named schema", () => {
    const body = { $id: "u", title: "ThingRequest", type: "object", properties: { n: { type: "string" } } };
    const operation = {
      tags: ["turns"],
      operationId: "record_things_v1_things_post",
      requestBody: { content: { "application/json": { schema: body } } },
      responses: { "200": {} },
    };
    const result = cut({
      openapi: "3.1.0",
      info: {},
      paths: { "/v1/things": { post: operation } },
      components: { schemas: {} },
    });
    expect(result.paths["/v1/things"]?.post?.requestBody?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/ThingRequest",
    });
    const { $id: _id, ...named } = body;
    expect(result.components.schemas.ThingRequest).toEqual(named);
    expect(operation.requestBody.content["application/json"].schema).toBe(body);
  });
});
