/**
 * Field access at the tool's output (`tool(..., { maskOutput: true })`): a field the calling key may not read
 * never reaches the model.
 *
 * The SDK profile says, for each type, the fields this key may not read (`field_access`: `mask` or `deny`).
 * After the tool returns, the result the model gets loses every `deny` field and has every `mask` field's value
 * replaced with `[masked]`, wherever the field appears in it, for the types of the objects the result showed (its
 * `provenance`; every declared type when the tool has none).
 *
 * When Niadra does not answer, the last profile read keeps applying. With no profile ever read, the result
 * passes as it is, unless the tool says `onUnknown: "block"`: then the model gets only a marker that the result
 * was withheld, for a company that needs the check to fail closed.
 */

export const MASKED = "[masked]";
export const WITHHELD = "[withheld: the fields this agent may read are not known yet]";

/** The fields each type hides from this key, by type: `null` while no profile was ever read. */
export type Access = () => Readonly<Record<string, Readonly<Record<string, string>>>> | null;
export type OnUnknown = "pass" | "block";

/** `result` as the model may get it. */
export function protect(result: unknown, access: ReturnType<Access>, types: readonly string[] | null, onUnknown: OnUnknown): unknown {
  if (access === null) return onUnknown === "block" ? WITHHELD : result;
  const rules = new Map<string, string>();
  for (const name of types ?? Object.keys(access)) {
    for (const [field, effect] of Object.entries(access[name] ?? {})) rules.set(field, effect === "deny" || rules.get(field) === "deny" ? "deny" : effect);
  }
  if (rules.size === 0) return result;
  if (typeof result === "string" && /^\s*[[{]/.test(result)) {
    try {
      return JSON.stringify(walk(JSON.parse(result) as unknown, rules));
    } catch {
      return result;
    }
  }
  return walk(result, rules);
}

function walk(value: unknown, rules: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => walk(v, rules));
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const effect = rules.get(key);
    if (effect === "deny") continue;
    out[key] = effect === "mask" ? MASKED : walk(v, rules);
  }
  return out;
}
