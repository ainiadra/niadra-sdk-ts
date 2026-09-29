// A stateful stand-in for a cell, for the tests of the agent features: turn records, the SDK profile, the
// suppression list, coordination with contact tokens, the working state, verify, refresh requests and pushes,
// and replay with its verdict. It answers what the server answers, as far as the SDK reads it.

import { suppressionKey, canonicalDestination } from "../../src/index.js";
import type { ClaimContractSummary, ConstraintsBlock, Handle, StateView } from "../../src/index.js";
import { scenarioVerdict, worst } from "./stats.js";
import type { Execution } from "./stats.js";

export const SPACE = "0192f5a0-0000-7000-8000-00000000a0e1";
export const KID = "ck_test_space_1";
const SEED = new Uint8Array(32).fill(7);
const SALT = "bW9jay1zdXBwcmVzc2lvbi1zYWx0LTMyYnl0ZXMtbG9uZw";
const PINS = ["prompts", "corpus_digest", "model", "assembler", "tool_schemas"];

type Json = Record<string, any>;

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function signer(): Promise<{ sign(text: string): Promise<string>; x: string }> {
  const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...SEED]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return {
    x: String(jwk.x),
    sign: async (text) => b64(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(text)))),
  };
}

export class Cell {
  features = new Set(["turns"]);
  claimContract: ClaimContractSummary | null = null;
  recording: Json | null = null;
  readonly turns = new Map<string, Json>();
  readonly events: Json[] = [];
  readonly declarations: Json[] = [];
  readonly effects = new Map<string, Json>();
  readonly claims: Json[] = [];
  readonly budgets = new Map<string, number>();
  readonly spent = new Map<string, number>();
  readonly gateways = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly suppressions: Json[] = [];
  readonly agentStates = new Map<string, { body: Json; version: number }>();
  readonly objects = new Map<string, Json>();
  readonly refreshes = new Map<string, Json>();
  readonly pushes: Json[] = [];
  readonly scenarios = new Map<string, Json>();
  readonly runs: Json[] = [];
  readonly constraints = new Map<string, ConstraintsBlock>();
  readonly views = new Map<string, StateView>();
  requiredPins = ["model"];
  private failures: { prefix: string; status: number; times: number }[] = [];

  failNext(prefix: string, status: number, times = 1): void {
    this.failures.push({ prefix, status, times });
  }

  clearFailures(): void {
    this.failures = [];
  }

  suppress(handle: Handle, purpose: string): Promise<void> {
    return suppressionKey(SALT, canonicalDestination(handle.type, handle.value)).then((key) => {
      this.suppressions.push({ id: `s${this.suppressions.length + 1}`, key, purpose, since: "2026-01-01T00:00:00Z" });
    });
  }

  observe(ref: string, fields: Json, status = "fresh"): void {
    const held = this.objects.get(ref) ?? {};
    for (const [name, value] of Object.entries(fields)) held[name] = { value, status, version: held[name]?.version ?? 0 };
    this.objects.set(ref, held);
  }

  requestRefresh(ref: string): void {
    const [type, namespace, id] = ref.split(":");
    const requestId = `rr_${this.refreshes.size + 1}`;
    this.refreshes.set(requestId, { request_id: requestId, ref: { type, namespace, id }, reason: "claim_pending", priority: "normal", budget_units: 1, lease_until: null });
  }

  createScenario(turnIds: string[], assertions?: Json[]): Json {
    const scenarioId = `sc_${this.scenarios.size + 1}`;
    const suggested = assertions ?? turnIds.flatMap((turnId, i) => {
      const record = this.turns.get(turnId)!;
      const tools = (record.calls ?? []).filter((c: Json) => c.kind === "tool");
      const names = [...new Set(tools.filter((c: Json) => c.status === "ok").map((c: Json) => c.name))].sort();
      return names.map((name) => ({ id: `t${i + 1}.tool_called.${String(name)}`, kind: "tool_called", args: { tool: name }, turn_id: turnId, suggested: true }));
    });
    const scenario = { scenario_id: scenarioId, name: "scenario", origin: "manual", turn_ids: turnIds, assertions: suggested, status: "active", version: 1, created_at: new Date().toISOString() };
    this.scenarios.set(scenarioId, scenario);
    return scenario;
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init.method ?? "GET";
    const path = url.pathname;
    const failure = this.failures.find((f) => f.times > 0 && path.startsWith(f.prefix));
    if (failure) {
      failure.times--;
      return problem(failure.status, "unavailable");
    }
    const headers = new Headers(init.headers);
    let body: Json = {};
    if (init.body instanceof Uint8Array) {
      const raw = new Uint8Array(init.body);
      const bytes = headers.get("content-encoding") === "gzip" ? await gunzip(raw) : raw;
      body = JSON.parse(new TextDecoder().decode(bytes)) as Json;
    } else if (typeof init.body === "string") body = JSON.parse(init.body) as Json;
    try {
      return await this.route(method, path, url.searchParams, body);
    } catch (error) {
      if (error instanceof Answer) return error.response;
      throw error;
    }
  };

  private need(feature: string): void {
    if (!this.features.has(feature)) throw new Answer(problem(404, "not_found"));
  }

  private async route(method: string, path: string, query: URLSearchParams, body: Json): Promise<Response> {
    const key = `${method} ${path}`;
    if (key === "GET /.well-known/niadra-contact-keys.json") {
      this.need("coordination");
      const { x } = await signer();
      return json(200, query.get("space") === SPACE ? { keys: [{ kid: KID, kty: "OKP", crv: "Ed25519", x, space: SPACE, status: "active" }] } : { keys: [] });
    }
    if (key === "POST /v1/turns") {
      this.need("turns");
      let accepted = 0;
      let duplicates = 0;
      for (const record of body.turns as Json[]) {
        if (this.turns.has(record.turn_id)) duplicates++;
        else {
          this.turns.set(record.turn_id, record);
          accepted++;
        }
      }
      return json(200, { accepted, duplicates, errors: [] });
    }
    if (key === "GET /v1/sdk/profile") {
      if (this.features.size === 0) return problem(404, "not_found");
      return json(200, { features: [...this.features].sort(), claim_contract: this.claimContract, recording: this.recording, valid_for_s: 300 });
    }
    if (key === "GET /v1/suppressions/salt") {
      this.need("coordination");
      return json(200, { salt: SALT, salt_id: "salt-1", valid_from: "2026-01-01T00:00:00Z" });
    }
    if (key === "GET /v1/suppressions") {
      this.need("coordination");
      return json(200, { items: this.suppressions, salt_id: "salt-1", next_cursor: null });
    }
    if (key === "POST /v1/batch") {
      for (const item of body.items as Json[]) this.events.push(item);
      return json(200, { accepted: (body.items as Json[]).length, duplicates: 0, errors: [] });
    }
    if (key === "POST /v1/context") return this.context(body);
    if (path.startsWith("/v1/coordination/")) return this.coordination(method, path, body);
    if (path.startsWith("/v1/agent-state")) return this.agentState(path, body);
    if (key === "POST /v1/state/verify" || key === "GET /v1/state/refresh-requests" || key === "POST /v1/objects/push") return this.state(key, body);
    if (path.startsWith("/v1/scenarios") || path.startsWith("/v1/replay/") || path.startsWith("/v1/scenario-runs")) return this.replay(method, path, query, body);
    return problem(404, "not_found");
  }

  private context(body: Json): Response {
    const include: string[] = body.include ?? [];
    for (const name of include) {
      const feature = name === "constraints" ? "signals" : name === "state" ? "state" : null;
      if (feature === null) return problem(501, "not_built");
      if (!this.features.has(feature)) return problem(404, "not_found");
    }
    const subject = body.subject ? `${body.subject.type}:${body.subject.value}` : "";
    const response: Json = {
      not_modified: false,
      text: "<niadra>Marina · customer since 2021</niadra>",
      variables: {},
      version: "compiler-1",
      etag: "etag-1",
      coverage: [],
      verification: { requested: "V0", effective: "V0" },
      withheld: 0,
      live: [],
      live_complete: true,
      timing: { total_ms: 3 },
      path: "t0",
      degraded: false,
    };
    if (include.includes("constraints")) response.constraints = this.constraints.get(subject) ?? { version: `cv_${"0".repeat(16)}` };
    if (include.includes("state")) response.state = this.views.get(subject) ?? {};
    return json(200, response);
  }

  private async coordination(method: string, path: string, body: Json): Promise<Response> {
    this.need("coordination");
    if (path === "/v1/coordination/check") return json(200, await this.check(body));
    if (path === "/v1/coordination/declare") {
      this.declarations.push(body);
      if (body.kind === "effect") this.effects.set(body.detail.effect_key, { state: body.detail.state, attempt: body.detail.attempt ?? 1 });
      return json(200, { accepted: true });
    }
    if (path === "/v1/coordination/claims" && method === "POST") {
      const target = body.object ? `object:${body.object.type}:${body.object.namespace}:${body.object.id}:${body.task ?? ""}` : `subject:${body.subject?.type}:${body.subject?.value}`;
      const held = this.claims.find((c) => c.target === target && c.holder !== body.holder && Date.parse(c.valid_until) > Date.now());
      if (held) return problem(409, body.kind === "task_lock" ? "task_locked" : "lease_held");
      const claim = { claim_id: `cl_${this.claims.length + 1}`, epoch: 1, holder: body.holder, kind: body.kind, level: body.level ?? "agent_active", valid_until: new Date(Date.now() + body.lease_s * 1000).toISOString(), target };
      this.claims.push(claim);
      const { target: _target, ...view } = claim;
      return json(201, view);
    }
    return problem(404, "not_found");
  }

  private async check(body: Json): Promise<Json> {
    const result: Json = { decision: "allow", decision_id: crypto.randomUUID(), reasons: [], valid_for_s: 60 };
    if (body.direction === "inbound") return result;
    if (body.effect_key) {
      const held = this.effects.get(body.effect_key);
      if (held?.state === "done") return { ...result, decision: "deny", reasons: ["effect_done"], effect: { state: "done", attempt: held.attempt } };
      if (held?.state === "reserved") return { ...result, decision: "deny", reasons: ["effect_in_flight"], effect: { state: "in_flight", attempt: held.attempt } };
      const attempt = Number(held?.attempt ?? 0) + 1;
      this.effects.set(body.effect_key, { state: "reserved", attempt });
      result.effect = { state: "none", attempt };
    }
    const subject = body.subject ? `${body.subject.type}:${body.subject.value}` : null;
    if (subject !== null) {
      const key = await suppressionKey(SALT, canonicalDestination(body.subject.type, body.subject.value));
      if (this.suppressions.some((s) => s.key === key && s.purpose === body.purpose)) return { ...result, decision: "deny", reasons: ["suppressed"] };
      const limit = this.budgets.get(body.purpose);
      const spentKey = `${body.purpose}|${subject}`;
      if (limit !== undefined && (this.spent.get(spentKey) ?? 0) >= limit) return { ...result, decision: "deny", reasons: ["budget_exhausted"] };
      if (limit !== undefined) this.spent.set(spentKey, (this.spent.get(spentKey) ?? 0) + 1);
      const gatewayKey = this.gateways.get(body.gateway_id);
      if (["marketing", "retention", "collection"].includes(body.purpose) && gatewayKey) {
        const hmac = await crypto.subtle.importKey("raw", gatewayKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const destination = canonicalDestination(body.subject.type, body.subject.value);
        const rcpt = b64(new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(destination))));
        const now = Math.floor(Date.now() / 1000);
        const claims = { kid: KID, space: SPACE, jti: crypto.randomUUID(), purpose: body.purpose, channel: body.channel, rcpt, gateway: body.gateway_id, iat: now, exp: now + 120 };
        const payload = b64(new TextEncoder().encode(JSON.stringify(claims)));
        result.contact_token = `nct1.${payload}.${await (await signer()).sign(`nct1.${payload}`)}`;
      }
    }
    return result;
  }

  private agentState(path: string, body: Json): Response {
    this.need("agent_state");
    const id = JSON.stringify([body.scope.kind, body.scope.id, body.agent]);
    const held = this.agentStates.get(id) ?? { body: {}, version: 0 };
    if (path === "/v1/agent-state/read") return json(200, { body: held.body, version: held.version });
    if ((body.mode === "cas" || body.if_version !== undefined) && (body.if_version ?? 0) !== held.version) return problem(412, "agent_state_conflict");
    const next: Json = body.mode === "cas" ? { ...body.body } : { ...held.body };
    if (body.mode !== "cas") {
      for (const [name, value] of Object.entries(body.body as Json)) {
        if (typeof value === "object" && value !== null && (value as Json).$delete === true) Reflect.deleteProperty(next, name);
        else next[name] = value;
      }
    }
    if (JSON.stringify(next).length > 16 * 1024) return json(200, { stored: false, version: held.version, reason: "over_cap" });
    this.agentStates.set(id, { body: next, version: held.version + 1 });
    return json(200, { stored: true, version: held.version + 1 });
  }

  private state(key: string, body: Json): Response {
    this.need("state");
    if (key === "POST /v1/state/verify") {
      const verdicts = (body.checks as Json[]).map((check) => {
        const ref = `${check.ref.type}:${check.ref.namespace}:${check.ref.id}`;
        const held = this.objects.get(ref)?.[check.field];
        const matches = held ? Number(held.value) === Number(check.value) || held.value === check.value : null;
        const status = held?.status ?? "expired";
        return { ref: check.ref, field: check.field, status, matches, claim_safe: status === "fresh" && matches === true, declared_gaps: held ? [] : ["unobserved"] };
      });
      return json(200, { verdicts });
    }
    if (key === "GET /v1/state/refresh-requests") {
      const items = [...this.refreshes.values()].filter((r) => r.lease_until === null).map((r) => {
        r.lease_until = new Date(Date.now() + 60_000).toISOString();
        return r;
      });
      return json(200, { items });
    }
    for (const item of body.objects as Json[]) {
      const ref = `${item.ref.type}:${item.ref.namespace}:${item.ref.id}`;
      this.observe(ref, item.fields);
      this.pushes.push(item);
      for (const [id, request] of this.refreshes) if (`${request.ref.type}:${request.ref.namespace}:${request.ref.id}` === ref) this.refreshes.delete(id);
    }
    return json(200, { applied: (body.objects as Json[]).length, stale_version: 0, out_of_set: 0 });
  }

  private replay(method: string, path: string, query: URLSearchParams, body: Json): Response {
    this.need("turns");
    if (method === "GET" && path === "/v1/scenarios") {
      const ids = (query.get("ids") ?? "").split(",").filter(Boolean);
      return json(200, { items: ids.length ? ids.map((id) => this.scenarios.get(id)).filter(Boolean) : [...this.scenarios.values()] });
    }
    if (method === "POST" && path === "/v1/replay/cases") {
      const scenario = this.scenarios.get(body.scenario_id);
      const record = this.turns.get(body.turn_id);
      if (!scenario || !record) return problem(404, "not_found");
      const pins = this.pinDifferences(record.build?.pins ?? {}, body.build?.pins ?? {}, body.vary ?? []);
      if (pins.length) return problem(422, "pin_mismatch", { pins });
      const customer = this.events.filter((e) => e.conversation_id === record.conversation_id && e.speaker?.role === "customer").at(-1);
      return json(200, {
        case_id: `case_${Math.random().toString(16).slice(2, 10)}`,
        turn_id: body.turn_id,
        scenario_id: body.scenario_id,
        mode: body.mode ?? "hermetic_turn",
        record,
        required_pins: this.requiredPins,
        input: { kind: record.kind ?? "message", ...(customer ? { text: customer.content?.text } : {}) },
        history: [],
        assertions: (scenario.assertions as Json[]).filter((a) => a.turn_id === undefined || a.turn_id === body.turn_id),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      });
    }
    if (method === "POST" && path === "/v1/scenario-runs") {
      for (const id of body.scenario_ids as string[]) {
        for (const turnId of (this.scenarios.get(id)?.turn_ids ?? []) as string[]) {
          const pins = this.pinDifferences(this.turns.get(turnId)?.build?.pins ?? {}, body.build?.pins ?? {}, body.vary ?? []);
          if (pins.length) return problem(422, "pin_mismatch", { pins });
        }
      }
      const scenarios = (body.scenario_ids as string[]).map((id): Json => {
        const executions = (body.results as Json[])
          .filter((r) => r.scenario_id === id)
          .map((r) => ({ status: r.status, paraphrase: Boolean(r.paraphrase), outcomes: Object.fromEntries((r.assertions as Json[]).map((a) => [a.id, a.outcome])) })) as Execution[];
        return { scenario_id: id, ...scenarioVerdict(executions, this.baseline(id)) };
      });
      const run = { run_id: `run_${this.runs.length + 1}`, status: "done", verdict: worst(scenarios.map((s) => String(s.verdict))), summary: { scenarios } };
      this.runs.push(run);
      return json(201, run);
    }
    return problem(404, "not_found");
  }

  private baseline(scenarioId: string): Record<string, [number, number]> | null {
    for (const run of [...this.runs].reverse()) {
      const scenario = (run.summary.scenarios as Json[]).find((s) => s.scenario_id === scenarioId && ["pass", "flaky"].includes(s.verdict));
      if (scenario) return Object.fromEntries((scenario.assertions as Json[]).map((a) => [a.id, [a.passed, a.failed]]));
    }
    return null;
  }

  private pinDifferences(recorded: Json, running: Json, vary: string[]): Json[] {
    return PINS.filter((name) => !vary.includes(name))
      .filter((name) => this.requiredPins.includes(name) || (recorded[name] != null && running[name] != null))
      .filter((name) => JSON.stringify(recorded[name] ?? null) !== JSON.stringify(running[name] ?? null))
      .map((name) => ({ name, recorded: recorded[name] ?? null, running: running[name] ?? null }));
  }
}

class Answer extends Error {
  constructor(readonly response: Response) {
    super("answer");
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function problem(status: number, code: string, extra: Json = {}): Response {
  return new Response(JSON.stringify({ type: "about:blank", title: code, status, code, ...extra }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
