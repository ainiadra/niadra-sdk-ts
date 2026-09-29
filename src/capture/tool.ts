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
 * In a replay (`replay/`) the call answers from the record when its arguments match a recorded call of the
 * tool; otherwise it runs only when `dryRun: true` says running it again is safe, and answers `undefined` (a
 * divergence) when not.
 */

import type { CallCapture, Observation, TurnFrame } from "./frame.js";
import { currentTurn } from "./frame.js";

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

  function end(call: CallCapture, result: unknown): void {
    const observations = observed(call, result);
    let shown: unknown;
    if (options.ui) {
      try {
        shown = options.ui(result as Awaited<R>);
      } catch {
        call.frame.incomplete();
      }
    }
    call.result(result, { ui: shown, observations });
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
        kept.push(piece);
        yield piece;
      }
    } catch (error) {
      call.failed(error);
      throw error;
    }
    end(call, kept);
  }

  const wrapped = function (this: unknown, ...args: A): R {
    const frame = currentTurn() ?? found(options.frame);
    if (frame === undefined || frame.closed) return fn.apply(this, args);
    let recorded: unknown;
    let callId: string | null | undefined;
    try {
      recorded = options.args ? options.args(...args) : args.length === 1 ? args[0] : args;
      callId = options.callId?.(...args);
    } catch {
      recorded = args;
    }
    const call = frame.adopt(name, recorded) ?? frame.toolCall(name, recorded, typeof callId === "string" && callId ? { callId } : {});
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
          end(call, value);
          return value;
        },
        (error: unknown) => {
          call.failed(error);
          throw error;
        },
      ) as R;
    }
    end(call, result);
    return result;
  };
  Object.defineProperty(wrapped, "name", { value: fn.name || name });
  return wrapped;
}
