/**
 * The claim contract's reference checker (`spec/claim-contract.md`), pure and without a model: the number and
 * role parser, the category detection, the natures, verdicts and actions, and the text anchor. It passes the
 * same conformance vectors as the server's and the Python SDK's (`spec/vectors/claim-*.v0.json`).
 */

export { check, detected, natureOf, sameValue } from "./check.js";
export type { Action, Anchor, Finding, Nature, Output, Turn, TurnValue, Verdict } from "./check.js";
export { LANGUAGES, Mention, mentions } from "./numbers.js";
export type { Language, MentionClass, Value } from "./numbers.js";
export { WINDOW, rolesOf } from "./roles.js";
export type { Role } from "./roles.js";
export { MIN_ANCHOR_MATCH, distance, normalize, score } from "./anchor.js";
export type { Span } from "./text.js";
