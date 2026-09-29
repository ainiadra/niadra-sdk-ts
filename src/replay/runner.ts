/**
 * Replay inside the company's boundary (`spec/replay.md`): Niadra keeps the scenarios and decides the verdict;
 * the company's CI runs the agent again on recorded turns.
 *
 * ```ts
 * const run = await new Replayer(niadra, buildAgent, { build: Niadra.build({ prompts: { core: "v17" }, model: MODEL }) })
 *   .run(["sc_quote_after_price_change"], { runs: 5, vary: ["prompts"] });
 * if (run.verdict === "regression") process.exit(1);
 * ```
 *
 * For each turn of each scenario the runner asks for the case (`POST /v1/replay/cases`) with the build it runs,
 * checks the pins itself, fetches every recorded value it needs (by pointer through `niadra.content`, or
 * `read`) and checks its digest. It then runs the agent N times: `buildAgent()` makes a fresh agent, called
 * with a `ReplayInput`. Inside the run, tools wrapped with `niadra.tool()` answer from the record when their
 * arguments match a recorded call; nothing the agent sends, declares or checks leaves for Niadra, and a read
 * returns the pack of the time. The assertions are evaluated on the replayed record, which stays here, and the
 * results go to `POST /v1/scenario-runs`, which answers with the statistical verdict.
 */

import type { Niadra } from "../client.js";
import { NiadraAPIError, NiadraError } from "../errors.js";
import { checkTurn } from "../capture/claims.js";
import { TurnFrame } from "../capture/frame.js";
import { SDK, buildRecord } from "../capture/record.js";
import { uuidv7 } from "../ids.js";
import type { ContextResponse } from "../types/context.js";
import type { TurnPins } from "../types/turns.js";
import { Replayed, evaluate } from "./assertions.js";
import { BlobError, playback } from "./playback.js";
import type { Mode } from "./playback.js";

const PINS = ["prompts", "corpus_digest", "model", "assembler", "tool_schemas"] as const;
const POLL_MS = 30_000;

type Json = Record<string, unknown>;

/** What a replayed agent receives: the turn's input (masked), the conversation before it, the pack of the time. */
export interface ReplayInput {
  turnId: string;
  kind: string;
  text: string | null;
  history: Json[];
  context: ContextResponse | null;
  record: Json;
  /** The execution's number, from 1. */
  run: number;
  paraphrase: boolean;
}

/** Answers one input: the text the agent emitted (or nothing), or a promise of it. */
export type ReplayAgent = (input: ReplayInput) => unknown;

/**
 * A run as Niadra judged it: `verdict` is the worst of its scenarios' (`pass`, `flaky`, `infrastructure_error`,
 * `pin_mismatch`, `regression`), and `scenarios` holds each one's verdict with the statistics of each
 * assertion. A report Niadra refused for a pin that does not match is `refused`, with no `runId`.
 */
export interface ReplayRun {
  runId: string;
  status: string;
  verdict: string | null;
  scenarios: Json[];
}

export interface RunOptions {
  runs?: number;
  mode?: Mode;
  vary?: string[];
  /** A paraphrase of the input for run `n`: intermittent results must hold with other words too. */
  paraphrase?: (text: string, run: number) => string;
}

/** The pins that differ (the replay spec, 4.2): every pin outside `vary` the recording requires, or both builds carry. */
export function pinDifferences(recorded: Json, running: Json, required: readonly string[], vary: readonly string[]): Json[] {
  const out: Json[] = [];
  for (const name of PINS) {
    if (vary.includes(name)) continue;
    const mine = recorded[name] ?? null;
    const theirs = running[name] ?? null;
    const compared = required.includes(name) || (mine !== null && theirs !== null);
    if (compared && JSON.stringify(mine) !== JSON.stringify(theirs)) out.push({ name, recorded: mine, running: theirs });
  }
  return out;
}

function asText(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function result(scenarioId: string, turnId: string, caseId: string | null, run: number, status: string, extra: Json = {}): Json {
  const out: Json = { scenario_id: scenarioId, turn_id: turnId, run, status, paraphrase: false, assertions: [], divergent_calls: 0, ...extra };
  if (caseId !== null) out.case_id = caseId;
  if (typeof out.error === "string") out.error = out.error.slice(0, 200);
  return out;
}

const runOf = (data: Json): ReplayRun => ({
  runId: String(data.run_id),
  status: String(data.status),
  verdict: (data.verdict as string | undefined) ?? null,
  scenarios: (((data.summary as Json | undefined)?.scenarios ?? []) as Json[]),
});

/** Runs scenarios: see the module. `read(pointer)` reads values kept by pointer, by default the client's content resolver. */
export class Replayer {
  private readonly build: Json;

  constructor(
    private readonly niadra: Niadra,
    private readonly agentFactory: () => ReplayAgent,
    private readonly options: { build?: TurnPins; read?: (pointer: string) => Promise<string> } = {},
  ) {
    this.build = { pins: { ...(options.build ?? {}) }, sdk: SDK };
  }

  /** Runs each turn of the scenarios `runs` times and resolves with the run and its verdict. */
  async run(scenarioIds: readonly string[], options: RunOptions = {}): Promise<ReplayRun> {
    const runs = options.runs ?? 5;
    const mode = options.mode ?? "hermetic_turn";
    const vary = options.vary ?? [];
    await this.niadra.profile();
    const found = await this.niadra.callRoute<{ items?: Json[] }>({ method: "GET", path: "/v1/scenarios", query: { ids: scenarioIds.join(","), limit: 50 } });
    const scenarios = new Map((found.items ?? []).map((s) => [String(s.scenario_id), s]));
    const results: Json[] = [];
    for (const id of scenarioIds) {
      const scenario = scenarios.get(id);
      if (scenario === undefined) throw new NiadraError(`scenario ${id} was not found`);
      results.push(...(await this.scenario(scenario, runs, mode, vary, options.paraphrase)));
    }
    const body = { scenario_ids: [...scenarioIds], build: this.build, mode, runs, vary, results };
    let answer: Json;
    try {
      answer = await this.niadra.callRoute<Json>({ method: "POST", path: "/v1/scenario-runs", body, idempotencyKey: uuidv7() });
    } catch (error) {
      if (error instanceof NiadraAPIError && error.code === "pin_mismatch") return refused(scenarioIds, results);
      throw error;
    }
    let run = runOf(answer);
    const deadline = Date.now() + POLL_MS;
    while (run.status !== "done" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      run = runOf(await this.niadra.callRoute<Json>({ method: "GET", path: `/v1/scenario-runs/${encodeURIComponent(run.runId)}` }));
    }
    return run;
  }

  private async scenario(scenario: Json, runs: number, mode: Mode, vary: string[], paraphrase: RunOptions["paraphrase"]): Promise<Json[]> {
    const id = String(scenario.scenario_id);
    const cases: [string, Json | null, string, string | null][] = [];
    for (const turnId of (scenario.turn_ids ?? []) as string[]) cases.push(await this.caseOf(id, turnId, mode, vary));
    const out: Json[] = [];
    const stopped = new Set<number>();
    for (const [turnId, found, status, error] of cases) {
      for (let run = 1; run <= runs; run++) {
        // Runs are numbered from 1 (the replay spec, 7).
        if (stopped.has(run)) continue;
        if (found === null) {
          out.push(result(id, turnId, null, run, status, error === null ? {} : { error }));
          continue;
        }
        const done = await this.execute(id, found, run, mode, paraphrase);
        out.push(done);
        // A conversation replays until its first strong divergence.
        if (mode === "hermetic_conversation" && Number(done.divergent_calls) > 0) stopped.add(run);
      }
    }
    return out;
  }

  private async caseOf(scenarioId: string, turnId: string, mode: Mode, vary: string[]): Promise<[string, Json | null, string, string | null]> {
    const body: Json = { turn_id: turnId, scenario_id: scenarioId, mode, build: this.build };
    if (vary.length > 0) body.vary = vary;
    let found: Json;
    try {
      found = await this.niadra.callRoute<Json>({ method: "POST", path: "/v1/replay/cases", body });
    } catch (error) {
      if (error instanceof NiadraAPIError) return [turnId, null, error.code === "pin_mismatch" ? "pin_mismatch" : "infrastructure_error", error.code];
      return [turnId, null, "infrastructure_error", error instanceof Error ? error.name : "error"];
    }
    const recorded = (((found.record as Json | undefined)?.build as Json | undefined)?.pins ?? {}) as Json;
    if (pinDifferences(recorded, this.build.pins as Json, (found.required_pins ?? []) as string[], vary).length > 0) return [turnId, null, "pin_mismatch", "pin_mismatch"];
    return [turnId, found, "completed", null];
  }

  private async execute(scenarioId: string, found: Json, run: number, mode: Mode, paraphrase: RunOptions["paraphrase"]): Promise<Json> {
    const record = found.record as Json;
    const turnId = String(record.turn_id);
    const caseId = String(found.case_id);
    const read = this.options.read ?? (this.niadra.content.registered ? strictRead(this.niadra) : null);
    let played;
    try {
      played = await playback(record, read, (found.mode as Mode | undefined) ?? mode);
    } catch (error) {
      if (!(error instanceof BlobError)) throw error;
      return result(scenarioId, turnId, caseId, run, "infrastructure_error", { error: error.message });
    }
    const entry = (found.input ?? {}) as Json;
    let text = typeof entry.text === "string" ? entry.text : null;
    let rephrased = false;
    if (paraphrase && text !== null) {
      text = paraphrase(text, run);
      rephrased = true;
    }
    const frame = new TurnFrame(null, {
      agent: asText((record.agent as Json | undefined)?.name, "agent"),
      kind: (record.kind as "message" | undefined) ?? "message",
      conversationId: (record.conversation_id as string | undefined) ?? null,
      taskId: (record.task_id as string | undefined) ?? null,
      pins: this.build.pins as TurnPins,
    });
    frame.playback = played;
    frame.flag("synthetic");
    const input: ReplayInput = {
      turnId,
      kind: asText(entry.kind ?? record.kind, "message"),
      text,
      history: (found.history ?? []) as Json[],
      context: played.context,
      record,
      run,
      paraphrase: rephrased,
    };
    const started = performance.now();
    try {
      const out = await frame.run(() => this.agentFactory()(input));
      if (typeof out === "string" && out) played.say(frame, out);
    } catch (error) {
      return result(scenarioId, turnId, caseId, run, "infrastructure_error", { error: error instanceof Error ? error.name : "error" });
    } finally {
      frame.close();
    }
    const latency = Math.round(performance.now() - started);
    const contract = await this.niadra.currentContract();
    const replayed = await buildRecord(frame, "stored", { claims: contract ? (f) => checkTurn(f, contract) : null });
    const turn = new Replayed(replayed, played.said.join("\n"), (key) => frame.valueOf(key), played.done, played.handoff, contract?.languages[0] ?? "pt");
    const assertions = ((found.assertions ?? []) as Json[]).map((assertion) => {
      const [outcome, detail] = evaluate(assertion, turn);
      return { id: assertion.id, kind: assertion.kind, outcome, ...(outcome === "fail" && detail ? { detail } : {}) };
    });
    return result(scenarioId, turnId, caseId, run, "completed", { paraphrase: rephrased, assertions, divergent_calls: played.divergent, latency_ms: latency });
  }
}

/** Niadra refused the report for a pin that does not match: nothing was recorded, and the verdict is the runner's own. */
function refused(scenarioIds: readonly string[], results: readonly Json[]): ReplayRun {
  const scenarios = scenarioIds.map((id) => {
    const mine = results.filter((r) => r.scenario_id === id);
    return {
      scenario_id: id,
      verdict: "pin_mismatch",
      completed: mine.filter((r) => r.status === "completed").length,
      infrastructure_errors: mine.filter((r) => r.status === "infrastructure_error").length,
      pin_mismatches: mine.filter((r) => r.status === "pin_mismatch").length,
    };
  });
  return { runId: "", status: "refused", verdict: "pin_mismatch", scenarios };
}

export function strictRead(niadra: Niadra): (pointer: string) => Promise<string> {
  return async (pointer) => {
    const found = await niadra.content.read(pointer);
    if (found === null) throw new BlobError("the content resolver could not read a value");
    return found;
  };
}
