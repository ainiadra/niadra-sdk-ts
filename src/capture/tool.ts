/**
 * `tool()`: records each call of a function tool in the turn it runs in, whatever the framework.
 *
 * ```ts
 * const quote = niadra.tool("quote", async (plan: string) => pricing.quote(plan), {
 *   provenance: (r) => [{ ref: `health_quote:op:${r.id}`, fields: r.prices }],
 * });
 * ```
 *
 * Inside a turn, a call records its arguments when it starts (the single argument, or the list of them),
 * its result or its failure when it ends, its latency, and the call it was made in. `provenance` turns a
 * result into the objects it showed, each `{ref, fields, provenance}`: without provenance an observation is
 * for display only. `ui` gives the form of the result the interface got, when it differs from the one the
 * model saw. Outside a turn, the tool runs untouched and nothing is recorded. The recording never fails the
 * tool: a provenance function that throws marks the turn incomplete, and the tool's own result and errors
 * pass through unchanged. An async generator is recorded piece by piece, and its result is the list of
 * pieces once it is consumed.
 *
 * When the space binds the tool (its `tool-bindings` document, which the SDK profile serves this source by the
 * tool's name), a call in a turn that read the constraints block records what it did with the block: the hard
 * constraints its arguments sent, and over the objects its result shows, how many were checked, broke one, or
 * lacked the field. Nothing is changed. A binding lives in the space's configuration, never in code.
 *
 * With `maskOutput: true`, the fields the key may not read never reach the model (`capture/mask.ts`); the record
 * keeps what the model saw. Left unset, the binding's `capabilities.mask_output` decides.
 *
 * In a replay (`replay/`) the call answers from the record when its arguments match a recorded call of the
 * tool; otherwise it runs only when `dryRun: true` says running it again is safe, and answers `undefined` (a
 * divergence) when not.
 */

import { parseBinding, relaxed, resultItems } from "../constraints/binding.js";
import type { RawBinding } from "../constraints/binding.js";
import { honored, render } from "../constraints/render.js";
import type { CallCapture, Observation, TurnFrame } from "./frame.js";
import { currentTurn } from "./frame.js";
import { protect } from "./mask.js";
import type { Access, OnUnknown } from "./mask.js";

export interface ToolOptions<A extends unknown[], R> {
  /** The objects a result showed, each `{ref, fields, provenance}`. */
  provenance?: (result: Awaited<R>) => Observation | readonly Observation[] | null | undefined;
  /** The form of the result the interface got, when it differs from the model's. */
  ui?: (result: Awaited<R>) => unknown;
  /** What the record keeps as the arguments; by default the single argument, or the list of them. */
  args?: (...args: A) => unknown;
  /** A replay may run the tool for real when the record has no answer for it. */
  dryRun?: boolean;
  /** The provider's id of the call, when the framework passes it to the tool. */
  callId?: (...args: A) => string | null | undefined;
  /** The turn to record in when the async context does not carry one (a framework that runs tools elsewhere). */
  frame?: () => TurnFrame | null | undefined;
  /** The bindings the SDK profile serves, by tool name; by default the client's (`niadra.tool`) or the turn's. */
  served?: (tool: string) => RawBinding | null;
  /** Keeps the fields this key may not read from the model; left unset, the binding's capability decides. */
  maskOutput?: boolean;
  /** With no profile ever read: `pass` (the default) lets the result through, `block` withholds it. */
  onUnknown?: OnUnknown;
  /** The fields each type hides; by default the SDK profile of the client (`niadra.tool`) or of the turn. */
  access?: Access;
}

/** What `tool()` knows of the function it wraps, for the runners that call it again. */
export interface RecordedTool {
  name: string;
  dryRun: boolean;
  provenance: ((result: never) => Observation | readonly Observation[] | null | undefined) | null;
}

const RECORDED = Symbol.for("niadra.tool");

/** The `tool()` of `fn`, if it is one. */
export function recordedTool(fn: unknown): RecordedTool | null {
  return typeof fn === "function" ? ((fn as unknown as Record<symbol, RecordedTool | undefined>)[RECORDED] ?? null) : null;
}

const isAsyncFunction = (fn: unknown): boolean => Object.prototype.toString.call(fn) === "[object AsyncFunction]";

function isAsyncIterator(value: unknown): value is AsyncGenerator {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { next?: unknown }).next === "function" &&
    Symbol.asyncIterator in value
  );
}

function found(frame: (() => TurnFrame | null | undefined) | undefined): TurnFrame | undefined {
  try {
    return frame?.() ?? undefined;
  } catch {
    return undefined;
  }
}

function thenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/** Records the calls of `fn` as the tool `name`. See the module. */
export function tool<A extends unknown[], R>(
  name: string,
  fn: (...args: A) => R,
  options: ToolOptions<A, R> = {},
): (...args: A) => R {
  const isAsync = isAsyncFunction(fn);

  /** The binding the SDK profile serves for the tool's name. */
  function bindingOf(frame: TurnFrame | undefined): RawBinding | null {
    return (options.served ?? frame?.profile.bindings)?.(name) ?? null;
  }

  /** Whether the output is masked: `maskOutput` when the code says it, else the binding's capability. */
  function masks(frame: TurnFrame | undefined): boolean {
    return options.maskOutput ?? bindingOf(frame)?.capabilities?.mask_output ?? false;
  }

  /** The result as the model may get it. */
  function shield(result: unknown, frame: TurnFrame | undefined): unknown {
    if (!masks(frame)) return result;
    const access = options.access ?? frame?.profile.fieldAccess ?? ((): null => null);
    return protect(result, access(), typesOf(result), options.onUnknown ?? "pass");
  }

  function typesOf(result: unknown): string[] | null {
    if (!options.provenance) return null;
    try {
      const found = options.provenance(result as Awaited<R>);
      const items = found == null ? [] : Array.isArray(found) ? (found as Observation[]) : [found as Observation];
      return items.map((o) => o.ref.split(":")[0] ?? "");
    } catch {
      return null;
    }
  }

  function end(call: CallCapture, result: unknown, model: unknown = result): void {
    const observations = observed(call, result);
    let shown: unknown;
    if (options.ui) {
      try {
        shown = options.ui(result as Awaited<R>);
      } catch {
        call.frame.incomplete();
      }
    }
    call.result(model, { ui: shown, observations });
  }

  function observed(call: CallCapture, result: unknown): Observation[] {
    if (!options.provenance) return [];
    try {
      const found = options.provenance(result as Awaited<R>);
      if (found == null) return [];
      const items = Array.isArray(found) ? (found as Observation[]) : [found as Observation];
      return items.filter((o) => typeof o.ref === "string" && typeof o.fields === "object");
    } catch {
      call.frame.incomplete();
      return [];
    }
  }

  async function* pieces(call: CallCapture, source: AsyncGenerator): AsyncGenerator {
    const kept: unknown[] = [];
    try {
      for await (const piece of source) {
        const shown = shield(piece, call.frame);
        kept.push(shown);
        yield shown;
      }
    } catch (error) {
      call.failed(error);
      throw error;
    }
    end(call, kept);
  }

  const wrapped = function (this: unknown, ...args: A): R {
    const frame = currentTurn() ?? found(options.frame);
    if (frame === undefined || frame.closed) {
      if (!masks(frame)) return fn.apply(this, args);
      const out = fn.apply(this, args);
      if (isAsyncIterator(out)) return maskedPieces(out, frame) as R;
      return (thenable(out) ? Promise.resolve(out).then((v) => shield(v, frame)) : shield(out, frame)) as R;
    }
    let recorded: unknown;
    let callId: string | null | undefined;
    try {
      recorded = options.args ? options.args(...args) : args.length === 1 ? args[0] : args;
      callId = options.callId?.(...args);
    } catch {
      recorded = args;
    }
    const call = frame.adopt(name, recorded) ?? frame.toolCall(name, recorded, typeof callId === "string" && callId ? { callId } : {});
    const binding = bindingOf(frame);
    if (binding !== null && frame.constraints !== null) call.measure = measure(frame, binding, recorded);
    if (frame.playback !== null) call.played = frame.playback.answer(name, recorded, options.dryRun ?? false);
    if (call.played !== null && !call.played.live) {
      const value = call.played.value;
      end(call, value);
      return (isAsync ? Promise.resolve(value) : value) as R;
    }
    let result: R;
    try {
      result = call.run(() => fn.apply(this, args));
    } catch (error) {
      call.failed(error);
      throw error;
    }
    if (isAsyncIterator(result)) return pieces(call, result) as R;
    if (thenable(result)) {
      return Promise.resolve(result).then(
        (value) => {
          const shown = shield(value, frame);
          end(call, value, shown);
          return shown;
        },
        (error: unknown) => {
          call.failed(error);
          throw error;
        },
      ) as R;
    }
    const shown = shield(result, frame);
    end(call, result, shown);
    return shown as R;
  };

  async function* maskedPieces(source: AsyncGenerator, frame: TurnFrame | undefined): AsyncGenerator {
    for await (const piece of source) yield shield(piece, frame);
  }

  Object.defineProperty(wrapped, "name", { value: fn.name || name });
  const marker: RecordedTool = {
    name,
    dryRun: options.dryRun ?? false,
    provenance: (options.provenance ?? null),
  };
  Object.defineProperty(wrapped, RECORDED, { value: marker });
  return wrapped;
}

/** How the call's result honored the block its arguments were rendered against; `null` when it does not apply. */
function measure(frame: TurnFrame, raw: RawBinding, args: unknown): ((result: unknown) => Record<string, unknown> | null) | null {
  const block = frame.constraints;
  if (block === null) return null;
  const given = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const rendering = render(block, parseBinding(raw, frame.profile.families?.() ?? {}), { args: given });
  if (!rendering.applies) return null;
  return (result) => {
    const seen = honored(block, rendering.hardSent, resultItems(raw, result));
    return {
      constraints: block.version,
      hard_sent: [...rendering.hardSent],
      results_checked: seen.resultsChecked,
      violations: seen.violations,
      unverifiable: seen.unverifiable,
      ...(relaxed(raw, result) ? { relaxed: "declared" } : {}),
    };
  };
}
