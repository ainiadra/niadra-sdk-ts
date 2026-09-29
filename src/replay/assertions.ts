/**
 * The structural assertions of a replay (the replay spec, section 5), evaluated on the replayed turn's record
 * and the text it emitted. A kind or an argument this runner cannot evaluate, or one whose evidence the turn
 * did not produce, is `not_checked`, which never fails.
 */

export type Outcome = "pass" | "fail" | "not_checked";
type Judged = [Outcome, string | null];
type Args = Record<string, unknown>;
type Json = Record<string, unknown>;

const STANDING = new Set(["matched", "quoted_found", "anchored"]);
const DENIALS: Record<string, readonly string[]> = {
  pt: ["não temos", "não encontrei", "não há", "indisponível", "esgotado", "não está disponível"],
  en: ["we don't have", "couldn't find", "not available", "out of stock", "unavailable", "no results"],
  es: ["no tenemos", "no encontré", "no hay", "no disponible", "agotado"],
};
const PROMISES: Record<string, readonly string[]> = {
  pt: ["vou enviar", "vou verificar", "te retorno", "vou providenciar", "vou encaminhar"],
  en: ["i will send", "i'll send", "i will check", "i'll check", "we will get back"],
  es: ["le enviaré", "voy a verificar", "le aviso", "voy a enviar"],
};

/** What an assertion reads: the replayed record, the text the turn emitted, what it declared done and handed off. */
export class Replayed {
  readonly text: string;
  readonly handoff: boolean;

  constructor(
    readonly record: Json,
    text: string,
    readonly values: (key: unknown) => unknown,
    readonly done: ReadonlyMap<string, number>,
    handoff: boolean,
    readonly lang: string,
  ) {
    this.text = text.toLowerCase();
    this.handoff = handoff || Boolean((record.output as Json | undefined)?.handoff_id);
  }

  get tools(): Json[] {
    return ((this.record.calls ?? []) as Json[]).filter((c) => c.kind === "tool");
  }

  says(phrases: readonly string[]): boolean {
    return phrases.some((p) => this.text.includes(p.toLowerCase()));
  }
}

const passes = (ok: boolean, detail: string): Judged => (ok ? ["pass", null] : ["fail", detail]);

function showed(call: Json, turn: Replayed): boolean {
  if (Array.isArray(call.observations) && call.observations.length > 0) return true;
  const result = turn.values(call.result_model);
  if (Array.isArray(result)) return result.length > 0;
  if (typeof result === "object" && result !== null) return Object.values(result).some((v) => Array.isArray(v) && v.length > 0);
  return false;
}

/** A value of an assertion's arguments as text. */
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

const KINDS: Record<string, (args: Args, turn: Replayed) => Judged> = {
  tool_called(args, turn) {
    const tool = text(args.tool);
    const least = Number(args.min ?? 1);
    if (args.tool === undefined) throw new TypeError("tool");
    const calls = turn.tools.filter((c) => c.name === tool && c.status === "ok").length;
    return passes(calls >= least, `${calls} ok calls of ${tool}, ${least} wanted`);
  },
  tool_not_called(args, turn) {
    if (args.tool === undefined) throw new TypeError("tool");
    return passes(!turn.tools.some((c) => c.name === args.tool), `${text(args.tool)} was called`);
  },
  hard_respected(_args, turn) {
    const applied = turn.tools.map((c) => c.applied as Json | undefined).filter((a): a is Json => Boolean(a));
    if (applied.length === 0) return ["not_checked", null];
    return passes(applied.every((a) => (a.violations ?? 0) === 0), "a call violated a hard constraint");
  },
  no_denial_with_results(args, turn) {
    const phrases = DENIALS[text(args.lang ?? turn.lang)];
    if (phrases === undefined) throw new TypeError("lang");
    const anyShown = turn.tools.some((c) => showed(c, turn));
    return passes(!anyShown || !turn.says(phrases), "a denial while a tool showed results");
  },
  claims_traced(_args, turn) {
    const claims = (turn.record.claims ?? []) as Json[];
    if (claims.length === 0) return ["not_checked", null];
    const untraced = claims.filter((c) => !c.evidence).length;
    return passes(untraced === 0, `${untraced} claims without evidence`);
  },
  claims_match_state(_args, turn) {
    const claims = (turn.record.claims ?? []) as Json[];
    if (claims.length === 0) return ["not_checked", null];
    const off = [...new Set(claims.map((c) => String(c.verdict)).filter((v) => !STANDING.has(v)))].sort();
    return passes(off.length === 0, `verdicts ${off.join(", ")}`);
  },
  no_promise_without_action(args, turn) {
    const phrases = PROMISES[text(args.lang ?? turn.lang)];
    if (phrases === undefined) throw new TypeError("lang");
    const acted = ((turn.record.effects ?? []) as unknown[]).length > 0 || turn.done.size > 0 || turn.handoff;
    return passes(!turn.says(phrases) || acted, "a promise with no effect or handoff");
  },
  expected_in_topk(args, turn) {
    if (args.ref === undefined || args.k === undefined) throw new TypeError("ref, k");
    const k = Number(args.k);
    const shown = ((turn.record.interactions ?? []) as Json[]).filter((i) => i.kind === "presented" && (args.list_id === undefined || i.list_id === args.list_id));
    if (shown.length === 0) return ["not_checked", null];
    const found = shown.some((i) => ((i.items ?? []) as Json[]).some((item) => item.ref === args.ref && Number(item.pos ?? k + 1) <= k));
    return passes(found, `not in the top ${k}`);
  },
  handoff_when(args, turn) {
    const expected = args.expected === undefined ? true : Boolean(args.expected);
    return passes(turn.handoff === expected, turn.handoff ? "handoff" : "no handoff");
  },
  effect_once(args, turn) {
    const done = new Map(turn.done);
    for (const effect of (turn.record.effects ?? []) as Json[]) if (effect.state === "done" && !done.has(String(effect.key))) done.set(String(effect.key), 1);
    if (args.key !== undefined) {
      const times = done.get(text(args.key)) ?? 0;
      return passes(times === 1, `${times} times done`);
    }
    return passes([...done.values()].every((n) => n <= 1), "an effect done twice");
  },
  budget(args, turn) {
    const calls = (turn.record.calls ?? []) as Json[];
    const models = calls.filter((c) => c.kind === "model");
    const tokens = models.reduce((sum, c) => sum + Number((c.tokens as Json | undefined)?.in ?? 0) + Number((c.tokens as Json | undefined)?.out ?? 0), 0);
    const counts: Record<string, number | null> = {
      max_tool_calls: turn.tools.length,
      max_model_calls: models.length,
      max_tokens: tokens,
      max_cost_usd: ((turn.record.cost as Json | undefined)?.usd as number | undefined) ?? null,
      max_latency_ms: (turn.record.latency_ms as number | undefined) ?? null,
    };
    const limits = Object.entries(args).filter(([k]) => k in counts);
    if (limits.length === 0) return ["not_checked", "no limit given"];
    if (limits.some(([k]) => counts[k] === null)) return ["not_checked", null];
    const over = limits.filter(([k, v]) => (counts[k] ?? 0) > Number(v)).map(([k]) => k);
    return passes(over.length === 0, `over ${over.join(", ")}`);
  },
  lexicon(args, turn) {
    const include = (args.must_include ?? []) as string[];
    const exclude = (args.must_not_include ?? []) as string[];
    if (include.length === 0 && exclude.length === 0) return ["not_checked", "no phrase given"];
    const missing = include.filter((p) => !turn.text.includes(p.toLowerCase()));
    const present = exclude.filter((p) => turn.text.includes(p.toLowerCase()));
    return passes(missing.length === 0 && present.length === 0, `${missing.length} missing, ${present.length} forbidden`);
  },
  tools_offered_match() {
    return ["not_checked", "the tools offered to the model are not in the record"];
  },
};

/** An assertion's outcome, with a short detail when it fails (never personal data). */
export function evaluate(assertion: Json, turn: Replayed): Judged {
  const check = KINDS[String(assertion.kind)];
  if (check === undefined) return ["not_checked", "kind unknown to this runner"];
  try {
    return check((assertion.args ?? {}) as Args, turn);
  } catch {
    return ["not_checked", "arguments this runner cannot read"];
  }
}
