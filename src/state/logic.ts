/**
 * The four logical values of a field (`spec/object-type.md`, section 5.4): not observed is never false.
 */
export type Logic = "yes" | "no" | "unobserved" | "known_defect";

/** The two logical values that say nothing about the value. */
export type UnknownLogic = "unobserved" | "known_defect";

/** `yes` and `no` are known; `unobserved` and `known_defect` are unknown. */
export const isKnown = (logic: Logic): logic is "yes" | "no" => logic === "yes" || logic === "no";

/**
 * The unknown that a combination of values carries, if any: a known defect of a source says more than a
 * missing observation (use the other source), so it wins over `unobserved`.
 */
export function unknownOf(...logics: Logic[]): UnknownLogic | null {
  if (logics.includes("known_defect")) return "known_defect";
  if (logics.includes("unobserved")) return "unobserved";
  return null;
}
