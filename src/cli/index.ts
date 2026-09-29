/**
 * The `niadra` command for Node, for the company's own infrastructure and CI.
 *
 *     niadra resolver-worker --resolvers ./resolvers.js:register
 *     niadra replay --agent ./agent.js:buildAgent --build ./agent.js:BUILD --scenario sc_1 --runs 5
 *     niadra types derive --dsn postgresql://reader@replica/erp --table public.orders --out order.json
 *     niadra contract test --contract claim-contract.json --examples tests/claims/examples.json
 *     niadra counterfactual --tools ./tools.js:TOOLS --tool search_products --element hard --scenario sc_1
 *
 * The commands that talk to Niadra read the key from `NIADRA_API_KEY` (and `NIADRA_BASE_URL`, when set).
 * `module:export` names an export of a module, a path relative to the working directory or a package: for
 * `--resolvers`, a `Resolvers` or a function that registers the resolvers on the one it gets; for `--agent`, a
 * function that makes a fresh agent; for `--build`, the build's pins; for `--tools`, the company's functions by
 * tool name, and for `--bindings`, their bindings by tool name.
 *
 * `niadra replay` exits with 0 when the verdict is `pass` or `flaky`, 1 for `regression`, and 2 for
 * `pin_mismatch` or `infrastructure_error`. `niadra types derive --check` and `niadra contract test` exit with
 * 0 when everything holds, 1 when it does not, and 2 when they could not run. `niadra counterfactual` prints the
 * report Niadra answered and exits with 0, or 2 when it could not run. The Python SDK's `niadra` command takes
 * the same arguments.
 */

import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Niadra } from "../client.js";
import type { RawBinding } from "../constraints/binding.js";
import { Counterfactual } from "../replay/counterfactual.js";
import type { Element } from "../replay/counterfactual.js";
import { ResolverWorker } from "../resolver-worker.js";
import { Resolvers } from "../resolvers.js";
import { Replayer } from "../replay/runner.js";
import type { ReplayAgent } from "../replay/runner.js";
import type { Mode } from "../replay/playback.js";
import type { TurnPins } from "../types/turns.js";
import { contractTest } from "./contract.js";
import { typesDerive } from "./types.js";

/** Where a command writes, and how it gets its client: the process's by default, a test's own otherwise. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
  client(): Niadra;
}

const EXIT: Record<string, number> = { pass: 0, flaky: 0, regression: 1 };
const USAGE = "usage: niadra <resolver-worker|replay|counterfactual|types derive|contract test> [options]";

/** Runs one command and resolves with its exit code. */
export async function main(argv: readonly string[], io: Io = processIo()): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "resolver-worker":
        return await worker(rest, io);
      case "replay":
        return await replay(rest, io);
      case "counterfactual":
        return await counterfactual(rest, io);
      case "types":
        if (rest[0] === "derive") return await typesDerive(rest.slice(1), io);
        break;
      case "contract":
        if (rest[0] === "test") return await contractTest(rest.slice(1), io);
        break;
      default:
        break;
    }
  } catch (error) {
    io.err(`niadra: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  io.err(USAGE);
  return 2;
}

/** The process's streams and a client from the environment, built once. */
function processIo(): Io {
  let niadra: Niadra | undefined;
  return {
    out: (text) => void process.stdout.write(`${text}\n`),
    err: (text) => void process.stderr.write(`${text}\n`),
    client: () => (niadra ??= new Niadra()),
  };
}

async function worker(argv: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      resolvers: { type: "string" },
      once: { type: "boolean", default: false },
      limit: { type: "string", default: "50" },
      poll: { type: "string", default: "2" },
    },
  });
  if (values.resolvers === undefined) throw new Error("--resolvers module:export is needed");
  const niadra = io.client();
  const found = await load(values.resolvers);
  let resolvers: Resolvers | undefined;
  if (found instanceof Resolvers) resolvers = found;
  else if (typeof found === "function") (found as (resolvers: Resolvers) => void)(niadra.resolvers);
  else throw new Error(`${values.resolvers}: a Resolvers, or a function that registers them`);
  const worker = new ResolverWorker(niadra, {
    limit: Number(values.limit),
    pollMs: Number(values.poll) * 1000,
    ...(resolvers ? { resolvers } : {}),
  });
  if (values.once) {
    io.out(`pushed ${String(await worker.runOnce())} objects`);
    return 0;
  }
  const stop = new AbortController();
  process.once("SIGINT", () => { stop.abort(); });
  process.once("SIGTERM", () => { stop.abort(); });
  await worker.run(stop.signal);
  return 0;
}

async function replay(argv: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      agent: { type: "string" },
      build: { type: "string" },
      scenario: { type: "string", multiple: true },
      runs: { type: "string", default: "5" },
      mode: { type: "string", default: "hermetic_turn" },
      vary: { type: "string", multiple: true, default: [] },
    },
  });
  if (values.agent === undefined || values.build === undefined || !values.scenario?.length) {
    throw new Error("--agent, --build and at least one --scenario are needed");
  }
  if (!["hermetic_turn", "hermetic_conversation", "era_memory"].includes(values.mode)) {
    throw new Error(`--mode ${values.mode}: hermetic_turn, hermetic_conversation or era_memory`);
  }
  const factory = (await load(values.agent)) as () => ReplayAgent;
  const build = (await load(values.build)) as TurnPins;
  const run = await new Replayer(io.client(), factory, { build }).run(values.scenario, {
    runs: Number(values.runs),
    mode: values.mode as Mode,
    vary: values.vary,
  });
  io.out(JSON.stringify({ run_id: run.runId, verdict: run.verdict, scenarios: run.scenarios }, null, 2));
  return EXIT[run.verdict ?? ""] ?? 2;
}

async function counterfactual(argv: readonly string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      tools: { type: "string" },
      tool: { type: "string" },
      element: { type: "string" },
      turn: { type: "string", multiple: true, default: [] },
      scenario: { type: "string", multiple: true, default: [] },
      bindings: { type: "string" },
      safe: { type: "string", multiple: true, default: [] },
      k: { type: "string", default: "10" },
      label: { type: "string" },
    },
  });
  if (values.tools === undefined || values.tool === undefined || values.element === undefined) throw new Error("--tools, --tool and --element are needed");
  if (!["constraints", "hard", "size", "exclude"].includes(values.element)) throw new Error(`--element ${values.element}: constraints, hard, size or exclude`);
  if (values.turn.length === 0 && values.scenario.length === 0) throw new Error("--turn or --scenario is needed");
  const tools = (await load(values.tools)) as Record<string, (args: unknown) => unknown>;
  const bindings = values.bindings === undefined ? undefined : ((await load(values.bindings)) as Record<string, RawBinding>);
  const run = await new Counterfactual(io.client(), tools, { ...(bindings ? { bindings } : {}), safe: values.safe }).run(values.turn, {
    tool: values.tool,
    element: values.element as Element,
    scenarioIds: values.scenario,
    k: Number(values.k),
    ...(values.label !== undefined ? { label: values.label } : {}),
  });
  io.out(JSON.stringify({ ...run.report, untouched: run.untouched, unread: run.unread }, null, 2));
  return 0;
}

/** The export a `module:export` names. */
export async function load(target: string): Promise<unknown> {
  const at = target.lastIndexOf(":");
  const specifier = at > 0 ? target.slice(0, at) : "";
  const name = at > 0 ? target.slice(at + 1) : "";
  if (!specifier || !name) throw new Error(`${JSON.stringify(target)}: expected module:export`);
  const local = specifier.startsWith(".") || specifier.startsWith("/");
  const module = (await import(local ? pathToFileURL(resolvePath(specifier)).href : specifier)) as Record<string, unknown>;
  if (!(name in module)) throw new Error(`${specifier} has no export ${name}`);
  return module[name];
}
