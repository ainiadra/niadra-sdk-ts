import { describe, expect, it } from "vitest";
import { Niadra, NiadraAPIError, NiadraValidationError, silentLogger } from "../src/index.js";
import { MockServer, makeClient, marina, problem } from "./helpers.js";

const PROFILE = "0192f5a0-0000-7000-8000-000000000001";
const FACT = "0192f5a0-0000-7000-8000-0000000000f1";
const ERASURE = {
  request_id: "er-1",
  status: "pending",
  target_kind: "profile",
  target_id: PROFILE,
  requested_at: "2026-09-25T10:00:00Z",
  erased: {},
  export_run_ids: [],
};

describe("search options", () => {
  it("sends `where` and `limit` as given", async () => {
    const server = new MockServer().on("POST /v1/history/search", { body: { items: [], tokens_used: 0 } });
    const where = { AND: [{ kind: ["episode", "action"] }, { NOT: { vendor: "acme" } }] };
    await makeClient(server).search({ subject: marina, query: "segunda via", filters: { where }, limit: 5 });
    expect(server.calls[0]!.body.filters.where).toEqual(where);
    expect(server.calls[0]!.body.limit).toBe(5);
  });
});

describe("feedbackBatch() and whoami()", () => {
  it("keys every item and returns the per-item errors", async () => {
    const server = new MockServer().on("POST /v1/feedback/batch", {
      status: 207,
      body: { accepted: 1, duplicates: 0, errors: [{ index: 1, code: "invalid_input" }] },
    });
    const { data } = await makeClient(server).feedbackBatch([
      { subject: marina, action: "retract_fact", fact_id: "f-1", idempotency_key: "k1" },
      { subject: marina, action: "correct_fact", fact_id: "f-2", value: "Ana" },
    ]);
    expect(data?.errors[0]?.index).toBe(1);
    const items = server.calls[0]!.body.items;
    expect(items[0].idempotency_key).toBe("k1");
    expect(items[1].idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses an empty batch without a request", async () => {
    const server = new MockServer();
    const { error } = await makeClient(server).feedbackBatch([]);
    expect(error).toBeInstanceOf(NiadraValidationError);
    expect(server.calls).toHaveLength(0);
  });

  it("reads what the key authenticates as", async () => {
    const server = new MockServer().on("GET /v1/sources/me", {
      body: { source_id: "src-1", source_name: "whatsapp-bot", scopes: ["context", "track"], agent_memory: true },
    });
    const { data } = await makeClient(server).whoami();
    expect(data?.source_name).toBe("whatsapp-bot");
    expect(data?.scopes).toEqual(["context", "track"]);
  });
});

describe("admin", () => {
  it("finds a profile, reads its memory and a fact's history", async () => {
    const server = new MockServer()
      .on("POST /v1/profiles/search", { body: { items: [{ profile_id: PROFILE, pseudonym: "p_1" }] } })
      .on(`GET /v1/profiles/${PROFILE}/memory`, { body: { profile_id: PROFILE, facts: [{ id: FACT, value: "Marina" }] } })
      .on(`GET /v1/profiles/${PROFILE}/facts/${FACT}/history`, {
        body: { fact_id: FACT, versions: [], relations: [{ from_fact_id: FACT, to_fact_id: "old", type: "supersedes" }] },
      });
    const niadra = makeClient(server);
    const found = await niadra.admin.findProfiles("+5511987654321");
    expect(server.calls[0]!.body).toEqual({ query: "+5511987654321", limit: 20 });
    const memory = await niadra.admin.memory(found.data!.items[0]!.profile_id);
    expect(memory.data?.facts[0]?.value).toBe("Marina");
    const history = await niadra.admin.factHistory(PROFILE, `fact:${FACT}`);
    expect(history.data?.relations[0]?.type).toBe("supersedes");
  });

  it("corrects, erases and exports with idempotency keys", async () => {
    const server = new MockServer()
      .on("POST /v1/corrections", { status: 202, body: { accepted: 1, duplicates: 0, errors: [] } })
      .on("POST /v1/corrections/batch", { status: 202, body: { accepted: 2, duplicates: 0, errors: [] } })
      .on("POST /v1/forget", { status: 202, body: ERASURE })
      .on("GET /v1/forget/er-1", { body: { ...ERASURE, status: "completed" } })
      .on("POST /v1/export", { status: 201, body: { run_id: "r1", profile_id: PROFILE, sha256: "ab" } });
    const niadra = makeClient(server);

    await niadra.admin.correct(PROFILE, { action: "correct_fact", fact_id: `fact:${FACT}`, value: "Mari" });
    const one = server.callsTo("POST /v1/corrections")[0]!;
    expect(one.body).toEqual({ profile_id: PROFILE, action: "correct_fact", fact_id: FACT, value: "Mari" });
    expect(one.headers["idempotency-key"]).toBeTruthy();

    await niadra.admin.correctBatch(
      [{ profile_id: PROFILE, action: "retract_fact", fact_id: FACT }],
      { idempotency_key: "b1" },
    );
    expect(server.callsTo("POST /v1/corrections/batch")[0]!.headers["idempotency-key"]).toBe("b1");

    const erasure = await niadra.admin.forget({ profile_id: PROFILE }, { idempotency_key: "e1" });
    expect(server.callsTo("POST /v1/forget")[0]!.body).toEqual({ target: "profile", profile_id: PROFILE });
    const status = await niadra.admin.forgetStatus(erasure.data!.request_id);
    expect(status.data?.status).toBe("completed");

    const pkg = await niadra.admin.export({ handle: marina });
    expect(pkg.data?.run_id).toBe("r1");
    expect(server.callsTo("POST /v1/export")[0]!.body).toEqual({ handle: marina });
  });

  it("fails open, refuses an ambiguous target, and throws in strict mode", async () => {
    const denied = new MockServer().on(`GET /v1/profiles/${PROFILE}/memory`, problem(403, "scope_missing"));
    const lenient = makeClient(denied);
    expect((await lenient.admin.memory(PROFILE)).data).toBeNull();
    const twice = await lenient.admin.forget({ profile_id: PROFILE, conversation_id: "c1" });
    expect(twice.error).toBeInstanceOf(NiadraValidationError);
    await expect(makeClient(denied, { strict: true }).admin.memory(PROFILE)).rejects.toBeInstanceOf(NiadraAPIError);
    const off = new Niadra({ logger: silentLogger, apiKey: "" });
    expect((await off.admin.memory(PROFILE)).data).toBeNull();
  });
});

