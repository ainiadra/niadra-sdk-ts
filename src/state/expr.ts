/**
 * niadra-expr: the language of the type registry's conditions, timers, keys and readings
 * (`spec/object-type.md`, section 5).
 *
 * Small, deterministic and total: literals, names, comparison, `in`, `and`, `or`, `not`, `+`, `-` and a
 * fixed set of functions; no loop, no I/O, and bounded text, tokens and nesting. Every value carries one of
 * the four logical values, so a comparison with a value nobody observed is itself unobserved, never false.
 * The server and both SDKs implement the same language and pass the same vectors
 * (`spec/vectors/niadra-expr.v0.json`).
 *
 * `parse` reads the text, `compileExpression` also resolves its names against a type declaration (the
 * registry's validation), and `evaluate` computes it over an `Environment`, the object's slots at one
 * instant. Time is integer arithmetic, never the machine's time zone: a datetime is milliseconds since the
 * epoch, a date the days since 1970-01-01, and the environment's UTC offset says where a day starts.
 */

import { NiadraError } from "../errors.js";
import { sha256Hex } from "../sha256.js";
import { isKnown, unknownOf } from "./logic.js";
import type { Logic, UnknownLogic } from "./logic.js";

const MAX_LENGTH = 1024;
const MAX_TOKENS = 256;
const MAX_NESTING = 16;
const MAX_NAME = 64;
const MAX_STRING = 256;
const MAX_LIST_LITERAL = 64;
const MAX_LIST = 1000;
const MAX_DURATION_DIGITS = 6;
const MAX_BUSINESS_DAYS = 1000;
const MAX_SHA256_ARGS = 8;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const UNITS = new Map([
  ["ms", 1],
  ["s", SECOND_MS],
  ["min", MINUTE_MS],
  ["h", HOUR_MS],
  ["d", DAY_MS],
]);

/** The three errors of the language (`spec/object-type.md`, section 5.9). */
export type ExprErrorCode = "expr_invalid" | "expr_type" | "expr_limit";

/**
 * `expr_invalid`: the text is not a valid expression, or names what the type does not declare;
 * `expr_type`: a value of the wrong kind, or out of its domain, met during evaluation; `expr_limit`: a bound
 * of the language was exceeded. The message says what, in words; only the code is part of the contract.
 */
export class ExprError extends NiadraError {
  override readonly name = "ExprError";

  constructor(
    readonly code: ExprErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const invalid = (message: string): ExprError => new ExprError("expr_invalid", message);
const typeError = (message: string): ExprError => new ExprError("expr_type", message);
const limit = (message: string): ExprError => new ExprError("expr_limit", message);

// Values

/** The kind of a present value; business days and a quote exist only inside an expression. */
export type Kind =
  | "bool"
  | "number"
  | "string"
  | "duration"
  | "date"
  | "datetime"
  | "list"
  | "business_days"
  | "quote";

/** A named list of holidays and the weekdays that are never business days. */
export interface Calendar {
  /** Days since 1970-01-01, as `parseDate` gives them. */
  readonly holidays?: ReadonlySet<number>;
  /** ISO weekdays (1 is Monday) that are never business days; Saturday and Sunday unless given. */
  readonly weekend?: ReadonlySet<number>;
}

/** A whole count of business days on a calendar, to add to or subtract from a date. */
export interface BusinessDays {
  readonly count: number;
  readonly calendar: Calendar;
}

interface Unknown {
  readonly logic: UnknownLogic;
  readonly kind?: undefined;
}

interface Absent {
  readonly logic: "no";
  readonly kind?: undefined;
  /** The declared name of the absence, when there is one. */
  readonly absent?: string;
}

interface Bool {
  readonly logic: "yes" | "no";
  readonly kind: "bool";
  readonly datum: boolean;
}

interface Present<K extends Kind, D> {
  readonly logic: "yes";
  readonly kind: K;
  readonly datum: D;
}

type DateValue = Present<"date", number>;
type DatetimeValue = Present<"datetime", number>;

/**
 * A value and its logical value. A known value is present (`yes`, or a boolean, `no` when false) or absent
 * (`no` with no kind, and the declared name of the absence when there is one); an unknown one carries
 * nothing.
 *
 * Data: a boolean, a number (an IEEE 754 double), a string, whole milliseconds for a duration, days since
 * 1970-01-01 for a date, milliseconds since the epoch for a datetime, the values of a list, a count on a
 * calendar for business days, and the slots of a quote by field.
 */
export type Value =
  | Unknown
  | Absent
  | Bool
  | Present<"number", number>
  | Present<"string", string>
  | Present<"duration", number>
  | DateValue
  | DatetimeValue
  | Present<"list", readonly Value[]>
  | Present<"business_days", BusinessDays>
  | Present<"quote", Readonly<Record<string, Slot>>>;

/**
 * One field, computed value, time axis or input of an object as a reading sees it: the value, when a
 * source observed it (`at`, milliseconds since the epoch), by whom, its value before the latest change, and
 * the completeness level of a content field.
 */
export interface Slot {
  readonly value: Value;
  readonly at?: number;
  /** `machine`, `human` or `source:<name>`. */
  readonly observer?: string;
  readonly was?: Value;
  readonly completeness?: string;
}

/**
 * What an evaluation reads (`spec/object-type.md`, section 5.11): the current instant, the object's slots
 * (fields, computed values and time axes by name), the declared inputs by dotted path, the absence names,
 * the company's configuration by key, the reader's quotes by source, the calendars by name, and the
 * context names.
 */
export interface Environment {
  /** Milliseconds since the epoch. */
  readonly now: number;
  /** Minutes east of UTC, where a date's day starts; 0 unless given. */
  readonly utcOffsetMin?: number;
  readonly fields?: Readonly<Record<string, Slot>>;
  readonly inputs?: Readonly<Record<string, Slot>>;
  readonly absentNames?: ReadonlySet<string>;
  readonly config?: Readonly<Record<string, Value>>;
  readonly quotes?: Readonly<Record<string, Readonly<Record<string, Slot>>>>;
  readonly calendars?: Readonly<Record<string, Calendar>>;
  /** The lifecycle state; absent unless given. */
  readonly state?: string;
  readonly derivedStatus?: string;
  /** 0 unless given. */
  readonly watchCount?: number;
  /** The read's purpose; `display` unless given. */
  readonly purpose?: string;
  /** The object's best position presented in the conversation. */
  readonly presentedRank?: number;
}

const TRUE: Value = { logic: "yes", kind: "bool", datum: true };
const FALSE: Value = { logic: "no", kind: "bool", datum: false };
const ABSENT: Value = { logic: "no" };
const UNOBSERVED: Value = { logic: "unobserved" };
const WEEKEND: ReadonlySet<number> = new Set([6, 7]);

/** `true` or `false`: `yes` or `no`, of kind `bool`. */
export const boolean = (flag: boolean): Value => (flag ? TRUE : FALSE);

/** A value nobody observed, or one whose source is known to get it wrong. */
export const unknown = (logic: UnknownLogic): Value => (logic === "unobserved" ? UNOBSERVED : { logic });

/** An absence: the source affirmed there is no value, under a declared name when it gives one. */
export const absent = (name?: string): Value => (name === undefined ? ABSENT : { logic: "no", absent: name });

const isAbsent = (value: Value): value is Absent => value.logic === "no" && value.kind === undefined;
const isTime = (value: Value): value is DateValue | DatetimeValue => value.kind === "date" || value.kind === "datetime";

/** A record's own entry: a name such as `constructor` never reads `Object.prototype`. */
const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

// Syntax

interface NameNode {
  readonly node: "name";
  readonly parts: readonly [string, ...string[]];
}

type Comparison = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in";

/** A call, with each function's arguments in their fixed form (`spec/object-type.md`, section 5.7). */
type Call =
  | { readonly node: "call"; readonly fn: "now" }
  | { readonly node: "call"; readonly fn: "age" | "observer" | "changed"; readonly ref: NameNode }
  | { readonly node: "call"; readonly fn: "was" | "count"; readonly arg: Node }
  | { readonly node: "call"; readonly fn: "business_days"; readonly count: Node; readonly calendar: string }
  | { readonly node: "call"; readonly fn: "quote"; readonly source: string }
  | { readonly node: "call"; readonly fn: "presented_in_top"; readonly top: number }
  | { readonly node: "call"; readonly fn: "sha256"; readonly args: readonly Node[] };

type FunctionName = Call["fn"];

/** The syntax tree of an expression (`spec/object-type.md`, section 5.3), as `parse` gives it. */
export type Node =
  | { readonly node: "literal"; readonly value: Value }
  | { readonly node: "logical"; readonly logic: Logic }
  | NameNode
  | { readonly node: "member"; readonly target: Node; readonly name: string }
  | Call
  | { readonly node: "list"; readonly items: readonly Node[] }
  | { readonly node: "not"; readonly operand: Node }
  | { readonly node: "boolean"; readonly op: "and" | "or"; readonly operands: readonly Node[] }
  | { readonly node: "compare"; readonly op: Comparison; readonly left: Node; readonly right: Node }
  | { readonly node: "arith"; readonly op: "+" | "-"; readonly left: Node; readonly right: Node };

const LOGIC_WORDS = new Map<string, Logic>([
  ["yes", "yes"],
  ["no", "no"],
  ["unobserved", "unobserved"],
  ["known_defect", "known_defect"],
]);
const LITERAL_WORDS = new Map<string, Value>([
  ["true", TRUE],
  ["false", FALSE],
  ["none", ABSENT],
]);
const OPERATOR_WORDS = new Set(["and", "or", "not", "in"]);
const KEYWORDS = new Set([...LOGIC_WORDS.keys(), ...LITERAL_WORDS.keys(), ...OPERATOR_WORDS]);
const META = new Map<string, Kind>([
  ["state", "string"],
  ["derived_status", "string"],
  ["watch_count", "number"],
  ["purpose", "string"],
]);

/** Names a type may not give a field, a value, a time axis or an absence (`spec/object-type.md`, section 5.5). */
export const RESERVED: ReadonlySet<string> = new Set([...KEYWORDS, ...META.keys(), "config"]);

const FUNCTIONS: ReadonlySet<string> = new Set<FunctionName>([
  "now",
  "age",
  "observer",
  "changed",
  "was",
  "count",
  "business_days",
  "quote",
  "presented_in_top",
  "sha256",
]);
const COMPARISONS: ReadonlySet<string> = new Set<Comparison>(["==", "!=", "<", "<=", ">", ">=", "in"]);
const isFunction = (word: string): word is FunctionName => FUNCTIONS.has(word);
const isComparison = (text: string): text is Comparison => COMPARISONS.has(text);

const TWO_CHAR = new Set(["==", "!=", "<=", ">="]);
const ONE_CHAR = new Set("<>+-()[],.");
const NAME_START = new Set("abcdefghijklmnopqrstuvwxyz_");
const DIGITS = new Set("0123456789");
const NAME_CHARS = new Set([...NAME_START, ...DIGITS]);
const SPACE = new Set(" \t\r\n");
const LETTER = /^\p{L}$/u;

type Token =
  | { readonly kind: "num" | "dur"; readonly text: string; readonly value: number }
  | { readonly kind: "str"; readonly text: string; readonly value: string }
  | { readonly kind: "name" | "op" | "end"; readonly text: string };

const END: Token = { kind: "end", text: "" };

/** The character at `i`, or `""` past the end. */
const charAt = (chars: readonly string[], i: number): string => chars[i] ?? "";

function tokenize(text: string): Token[] {
  // The bounds count characters (code points), as the spec does, never UTF-16 code units; past twice the
  // bound in code units the text is too long whatever it holds.
  const tooLong = `an expression has at most ${MAX_LENGTH} characters`;
  if (text.length > 2 * MAX_LENGTH) throw limit(tooLong);
  const chars = Array.from(text);
  if (chars.length > MAX_LENGTH) throw limit(tooLong);
  const out: Token[] = [];
  let i = 0;
  while (i < chars.length) {
    const c = charAt(chars, i);
    if (SPACE.has(c)) {
      i += 1;
      continue;
    }
    let token: Token;
    if (DIGITS.has(c)) {
      [token, i] = numberToken(chars, i);
    } else if (c === "'") {
      [token, i] = stringToken(chars, i);
    } else if (NAME_START.has(c)) {
      let j = i;
      while (NAME_CHARS.has(charAt(chars, j))) j += 1;
      if (LETTER.test(charAt(chars, j))) {
        throw invalid(`unexpected character '${charAt(chars, j)}': names are lowercase ASCII`);
      }
      if (j - i > MAX_NAME) throw limit(`a name has at most ${MAX_NAME} characters`);
      token = { kind: "name", text: chars.slice(i, j).join("") };
      i = j;
    } else if (TWO_CHAR.has(c + charAt(chars, i + 1))) {
      token = { kind: "op", text: c + charAt(chars, i + 1) };
      i += 2;
    } else if (ONE_CHAR.has(c)) {
      token = { kind: "op", text: c };
      i += 1;
    } else {
      throw invalid(`unexpected character '${c}'`);
    }
    out.push(token);
    if (out.length > MAX_TOKENS) throw limit(`an expression has at most ${MAX_TOKENS} tokens`);
  }
  if (out.length === 0) throw invalid("the expression is empty");
  out.push(END);
  return out;
}

function numberToken(chars: readonly string[], i: number): [Token, number] {
  const unitChar = (c: string): boolean => NAME_CHARS.has(c) || LETTER.test(c);
  let j = i;
  while (DIGITS.has(charAt(chars, j))) j += 1;
  const whole = chars.slice(i, j).join("");
  let fraction = false;
  if (charAt(chars, j) === ".") {
    let k = j + 1;
    while (DIGITS.has(charAt(chars, k))) k += 1;
    if (k === j + 1) throw invalid(`a number needs digits after the point: '${whole}.'`);
    fraction = true;
    j = k;
  }
  if (unitChar(charAt(chars, j))) {
    let k = j;
    while (unitChar(charAt(chars, k))) k += 1;
    const unit = chars.slice(j, k).join("");
    const scale = UNITS.get(unit);
    if (scale === undefined) throw invalid(`unknown duration unit '${unit}': use ms, s, min, h or d`);
    const text = chars.slice(i, k).join("");
    if (fraction) throw invalid(`a duration is a whole number of units: '${text}'`);
    if (whole.length > MAX_DURATION_DIGITS) throw limit(`a duration has at most ${MAX_DURATION_DIGITS} digits`);
    return [{ kind: "dur", text, value: Number(whole) * scale }, k];
  }
  const text = chars.slice(i, j).join("");
  return [{ kind: "num", text, value: Number(text) }, j];
}

function stringToken(chars: readonly string[], i: number): [Token, number] {
  const out: string[] = [];
  let j = i + 1;
  for (;;) {
    const c = chars[j];
    if (c === undefined || c === "\r" || c === "\n") throw invalid("a string is not closed");
    if (c === "'") break;
    if (c === "\\") {
      const escaped = charAt(chars, j + 1);
      if (escaped !== "'" && escaped !== "\\") throw invalid("a string escapes only a quote and a backslash");
      out.push(escaped);
      j += 2;
      continue;
    }
    out.push(c);
    j += 1;
  }
  if (out.length > MAX_STRING) throw limit(`a string has at most ${MAX_STRING} characters`);
  return [{ kind: "str", text: chars.slice(i, j + 1).join(""), value: out.join("") }, j + 1];
}

class Parser {
  private pos = 0;
  private nesting = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  expression(): Node {
    const node = this.disjunction();
    if (!this.at("end")) throw this.unexpected();
    return node;
  }

  private get token(): Token {
    return this.tokens[this.pos] ?? END;
  }

  private advance(): Token {
    const token = this.token;
    this.pos += 1;
    return token;
  }

  private at(kind: Token["kind"], text?: string): boolean {
    const token = this.token;
    return token.kind === kind && (text === undefined || token.text === text);
  }

  private expect(text: string, context: string): void {
    if (!this.at("op", text)) throw invalid(`expected '${text}' ${context}, found ${this.describe()}`);
    this.advance();
  }

  private unexpected(): ExprError {
    if (this.token.kind === "end") return invalid("the expression ends too early");
    return invalid(`unexpected '${this.token.text}'`);
  }

  private describe(): string {
    return this.token.kind === "end" ? "the end of the expression" : `'${this.token.text}'`;
  }

  private enter(): void {
    this.nesting += 1;
    if (this.nesting > MAX_NESTING) throw limit(`an expression nests at most ${MAX_NESTING} groups`);
  }

  private leave(): void {
    this.nesting -= 1;
  }

  private disjunction(): Node {
    const operands = [this.conjunction()];
    while (this.at("name", "or")) {
      this.advance();
      operands.push(this.conjunction());
    }
    const [first] = operands;
    return operands.length === 1 && first ? first : { node: "boolean", op: "or", operands };
  }

  private conjunction(): Node {
    const operands = [this.negation()];
    while (this.at("name", "and")) {
      this.advance();
      operands.push(this.negation());
    }
    const [first] = operands;
    return operands.length === 1 && first ? first : { node: "boolean", op: "and", operands };
  }

  private negation(): Node {
    if (this.at("name", "not")) {
      this.advance();
      return { node: "not", operand: this.negation() };
    }
    return this.comparison();
  }

  private comparison(): Node {
    const left = this.sum();
    const op = this.comparisonOp();
    if (op === null) return left;
    this.advance();
    const right = this.sum();
    if (this.comparisonOp() !== null) throw invalid("comparisons do not chain: use and");
    return { node: "compare", op, left, right };
  }

  private comparisonOp(): Comparison | null {
    const token = this.token;
    if (token.kind === "op" && isComparison(token.text)) return token.text;
    if (token.kind === "name" && token.text === "in") return "in";
    return null;
  }

  private sum(): Node {
    let node = this.postfix();
    while (this.at("op", "+") || this.at("op", "-")) {
      const op = this.advance().text === "+" ? "+" : "-";
      node = { node: "arith", op, left: node, right: this.postfix() };
    }
    return node;
  }

  private postfix(): Node {
    let [node, grouped] = this.primary();
    while (this.at("op", ".")) {
      this.advance();
      const name = this.memberName();
      if (node.node === "name" && !grouped) {
        node = { node: "name", parts: [...node.parts, name] };
      } else {
        node = { node: "member", target: node, name };
        grouped = false;
      }
    }
    return node;
  }

  private memberName(): string {
    const token = this.token;
    if (token.kind !== "name" || KEYWORDS.has(token.text)) {
      throw invalid(`expected a name after '.', found ${this.describe()}`);
    }
    this.advance();
    return token.text;
  }

  /** The node, and whether it was a group: `.` after a group reads a quote's field, never a dotted name. */
  private primary(): [Node, boolean] {
    const token = this.token;
    switch (token.kind) {
      case "num":
        this.advance();
        return [{ node: "literal", value: { logic: "yes", kind: "number", datum: token.value } }, false];
      case "dur":
        this.advance();
        return [{ node: "literal", value: { logic: "yes", kind: "duration", datum: token.value } }, false];
      case "str":
        this.advance();
        return [{ node: "literal", value: { logic: "yes", kind: "string", datum: token.value } }, false];
      case "name": {
        const word = token.text;
        const literal = LITERAL_WORDS.get(word);
        if (literal !== undefined) {
          this.advance();
          return [{ node: "literal", value: literal }, false];
        }
        const logic = LOGIC_WORDS.get(word);
        if (logic !== undefined) {
          this.advance();
          return [{ node: "logical", logic }, false];
        }
        if (OPERATOR_WORDS.has(word)) throw invalid(`unexpected '${word}'`);
        this.advance();
        if (this.at("op", "(")) return [this.call(word), false];
        return [{ node: "name", parts: [word] }, false];
      }
    }
    if (this.at("op", "(")) {
      this.advance();
      this.enter();
      const node = this.disjunction();
      this.expect(")", "to close the group");
      this.leave();
      return [node, true];
    }
    if (this.at("op", "[")) return [this.listLiteral(), false];
    throw this.unexpected();
  }

  private listLiteral(): Node {
    this.advance();
    this.enter();
    const items: Node[] = [];
    if (!this.at("op", "]")) {
      items.push(this.disjunction());
      while (this.at("op", ",")) {
        this.advance();
        items.push(this.disjunction());
      }
    }
    this.expect("]", "to close the list");
    this.leave();
    if (items.length > MAX_LIST_LITERAL) throw limit(`a list literal has at most ${MAX_LIST_LITERAL} items`);
    return { node: "list", items };
  }

  private call(word: string): Node {
    if (!isFunction(word)) throw invalid(`unknown function '${word}'`);
    this.advance();
    this.enter();
    const call = this.callArguments(word);
    if (this.at("op", ",") && word !== "sha256") {
      throw invalid(`${word}() takes ${word === "business_days" ? "two arguments" : "one argument"}`);
    }
    this.expect(")", `to close ${word}()`);
    this.leave();
    return call;
  }

  private callArguments(fn: FunctionName): Call {
    switch (fn) {
      case "now":
        if (!this.at("op", ")")) throw invalid("now() takes no argument");
        return { node: "call", fn };
      case "age":
      case "observer":
      case "changed":
        return { node: "call", fn, ref: this.reference(fn) };
      case "quote":
        return { node: "call", fn, source: this.bareName(fn, "the name of a quote source") };
      case "presented_in_top":
        return { node: "call", fn, top: this.position() };
      case "business_days": {
        const count = this.disjunction();
        if (!this.at("op", ",")) throw invalid("business_days() takes a count and a calendar");
        this.advance();
        return { node: "call", fn, count, calendar: this.bareName(fn, "the name of a calendar") };
      }
      case "sha256": {
        const args = [this.disjunction()];
        while (this.at("op", ",")) {
          this.advance();
          args.push(this.disjunction());
        }
        if (args.length > MAX_SHA256_ARGS) throw invalid(`sha256() takes at most ${MAX_SHA256_ARGS} arguments`);
        return { node: "call", fn, args };
      }
      case "was":
      case "count":
        return { node: "call", fn, arg: this.disjunction() };
    }
  }

  private reference(fn: string): NameNode {
    const parts: [string, ...string[]] = [
      this.bareName(fn, "the name of a field, a value, a time axis or an input"),
    ];
    while (this.at("op", ".")) {
      this.advance();
      parts.push(this.memberName());
    }
    return { node: "name", parts };
  }

  private bareName(fn: string, what: string): string {
    const token = this.token;
    if (token.kind !== "name" || KEYWORDS.has(token.text)) throw invalid(`${fn}() takes ${what}, found ${this.describe()}`);
    this.advance();
    return token.text;
  }

  private position(): number {
    const token = this.token;
    if (token.kind !== "num" || !Number.isInteger(token.value) || token.value < 1) {
      throw invalid(`presented_in_top() takes a whole position from 1, found ${this.describe()}`);
    }
    this.advance();
    return token.value;
  }
}

/** The syntax tree of an expression, or `ExprError` (`expr_invalid`, `expr_limit`). */
export function parse(text: string): Node {
  const node = new Parser(tokenize(text)).expression();
  placement(node, false);
  return node;
}

const NOT_INSIDE_WAS = new Set(["was", "changed", "age", "observer"]);

/** The arguments of a call that are expressions (the name of a slot, a source or a calendar is not). */
function operands(call: Call): readonly Node[] {
  switch (call.fn) {
    case "was":
    case "count":
      return [call.arg];
    case "business_days":
      return [call.count];
    case "sha256":
      return call.args;
    default:
      return [];
  }
}

/** The rules a grammar alone does not say: where the logical words go, and what `was()` may hold. */
function placement(node: Node, insideWas: boolean): void {
  switch (node.node) {
    case "logical":
      throw invalid("yes, no, unobserved and known_defect only appear in == or != comparisons");
    case "compare": {
      const words = [node.left, node.right].filter((side) => side.node === "logical").length;
      if (words > 0 && node.op !== "==" && node.op !== "!=") {
        throw invalid(`a logical value compares only with == or !=, not ${node.op}`);
      }
      if (words === 2) throw invalid("a comparison needs a value on one side of the logical value");
      for (const side of [node.left, node.right]) if (side.node !== "logical") placement(side, insideWas);
      return;
    }
    case "call":
      if (insideWas && NOT_INSIDE_WAS.has(node.fn)) {
        throw invalid(`was() reads previous values: ${node.fn}() is not allowed inside it`);
      }
      for (const arg of operands(node)) placement(arg, insideWas || node.fn === "was");
      return;
    case "member":
      placement(node.target, insideWas);
      return;
    case "list":
      for (const item of node.items) placement(item, insideWas);
      return;
    case "not":
      placement(node.operand, insideWas);
      return;
    case "boolean":
      for (const operand of node.operands) placement(operand, insideWas);
      return;
    case "arith":
      placement(node.left, insideWas);
      placement(node.right, insideWas);
      return;
    case "literal":
    case "name":
      return;
  }
}

// Evaluation

/**
 * The value of a parsed expression over an environment, or `ExprError` (`expr_type`, `expr_limit`). A
 * business-day count or a quote is a step, never a result.
 */
export function evaluate(node: Node, env: Environment): Value {
  const value = new Evaluator(env).evaluate(node, false);
  if (value.kind === "business_days" || value.kind === "quote") {
    throw typeError(`an expression cannot end in a ${value.kind.replace("_", " ")}`);
  }
  return value;
}

class Evaluator {
  constructor(private readonly env: Environment) {}

  /** `previous`: inside `was()`, where each slot reads its value before its latest change. */
  evaluate(node: Node, previous: boolean): Value {
    switch (node.node) {
      case "literal":
        return node.value;
      case "name":
        return this.name(node, previous);
      case "member":
        return this.member(this.evaluate(node.target, previous), node.name);
      case "call":
        return this.call(node, previous);
      case "list":
        return { logic: "yes", kind: "list", datum: node.items.map((item) => this.evaluate(item, previous)) };
      case "not": {
        const truth = this.truth(this.evaluate(node.operand, previous), "not");
        return isKnown(truth) ? boolean(truth === "no") : unknown(truth);
      }
      case "boolean":
        return this.booleanOp(node.op, node.operands, previous);
      case "compare":
        return this.compare(node.op, node.left, node.right, previous);
      case "arith":
        return arith(node.op, this.evaluate(node.left, previous), this.evaluate(node.right, previous), this.env);
      case "logical":
        throw invalid("yes, no, unobserved and known_defect only appear in == or != comparisons");
    }
  }

  private name(node: NameNode, previous: boolean): Value {
    const { env } = this;
    const { parts } = node;
    const [word] = parts;
    if (parts.length === 1) {
      if (META.has(word)) return this.meta(word);
      const slot = own(env.fields, word);
      if (slot !== undefined) return slotValue(slot, previous);
      if (env.absentNames?.has(word)) return absent(word);
      return UNOBSERVED;
    }
    const slot = own(env.inputs, parts.join("."));
    if (slot !== undefined) return slotValue(slot, previous);
    if (word === "config") return own(env.config, parts.slice(1).join(".")) ?? ABSENT;
    const owner = own(env.fields, word);
    if (owner !== undefined && parts.length === 2 && parts[1] === "completeness") {
      if (previous || owner.completeness === undefined) return ABSENT;
      return { logic: "yes", kind: "string", datum: owner.completeness };
    }
    return UNOBSERVED;
  }

  private meta(word: string): Value {
    const { env } = this;
    if (word === "watch_count") return { logic: "yes", kind: "number", datum: env.watchCount ?? 0 };
    const text = word === "state" ? env.state : word === "derived_status" ? env.derivedStatus : (env.purpose ?? "display");
    return text === undefined ? ABSENT : { logic: "yes", kind: "string", datum: text };
  }

  private slot(ref: NameNode): Slot | undefined {
    const { parts } = ref;
    return parts.length === 1 ? own(this.env.fields, parts[0]) : own(this.env.inputs, parts.join("."));
  }

  private member(target: Value, name: string): Value {
    if (!isKnown(target.logic)) return target;
    if (target.kind !== "quote") throw typeError(`only a quote has fields: '.${name}'`);
    return own(target.datum, name)?.value ?? UNOBSERVED;
  }

  private call(node: Call, previous: boolean): Value {
    const { env } = this;
    switch (node.fn) {
      case "now":
        return { logic: "yes", kind: "datetime", datum: env.now };
      case "age": {
        const at = this.slot(node.ref)?.at;
        return at === undefined ? UNOBSERVED : { logic: "yes", kind: "duration", datum: Math.max(0, env.now - at) };
      }
      case "observer": {
        const observer = this.slot(node.ref)?.observer;
        return observer === undefined ? ABSENT : { logic: "yes", kind: "string", datum: observer };
      }
      case "changed": {
        const slot = this.slot(node.ref);
        return boolean(slot?.was !== undefined && !identical(slot.was, slot.value));
      }
      case "was":
        return this.evaluate(node.arg, true);
      case "count":
        return count(this.evaluate(node.arg, previous));
      case "business_days":
        return this.businessDays(this.evaluate(node.count, previous), node.calendar);
      case "quote": {
        const quote = own(env.quotes, node.source);
        return quote === undefined ? UNOBSERVED : { logic: "yes", kind: "quote", datum: quote };
      }
      case "presented_in_top":
        return boolean(env.presentedRank !== undefined && env.presentedRank <= node.top);
      case "sha256":
        return sha256(node.args.map((arg) => this.evaluate(arg, previous)));
    }
  }

  private businessDays(count: Value, name: string): Value {
    if (!isKnown(count.logic)) return count;
    if (isAbsent(count)) return ABSENT;
    if (count.kind !== "number" || !Number.isInteger(count.datum) || count.datum < 0) {
      throw typeError("business_days() counts a whole number of days from 0");
    }
    if (count.datum > MAX_BUSINESS_DAYS) throw limit(`business_days() counts at most ${MAX_BUSINESS_DAYS} days`);
    const calendar = own(this.env.calendars, name);
    if (calendar === undefined) throw typeError(`unknown calendar '${name}'`);
    if ((calendar.weekend ?? WEEKEND).size >= 7) throw typeError(`calendar '${name}' has no business day`);
    return { logic: "yes", kind: "business_days", datum: { count: count.datum, calendar } };
  }

  private truth(value: Value, op: string): Logic {
    if (!isKnown(value.logic)) return value.logic;
    if (value.kind !== "bool") throw typeError(`${op} takes true or false, not a ${kindName(value)}`);
    return value.logic;
  }

  private booleanOp(op: "and" | "or", operands: readonly Node[], previous: boolean): Value {
    // Left to right, and the first operand that decides stops the evaluation: `false and x` never
    // evaluates `x`, so it never fails on it.
    const decisive = op === "and" ? "no" : "yes";
    const seen: Logic[] = [];
    for (const operand of operands) {
      const truth = this.truth(this.evaluate(operand, previous), op);
      if (truth === decisive) return boolean(truth === "yes");
      seen.push(truth);
    }
    const pending = unknownOf(...seen);
    return pending === null ? boolean(decisive === "no") : unknown(pending);
  }

  private compare(op: Comparison, leftNode: Node, rightNode: Node, previous: boolean): Value {
    const word = leftNode.node === "logical" ? leftNode : rightNode.node === "logical" ? rightNode : null;
    if (word !== null) {
      const same = this.evaluate(word === leftNode ? rightNode : leftNode, previous).logic === word.logic;
      return boolean(op === "==" ? same : !same);
    }
    const left = this.evaluate(leftNode, previous);
    const right = this.evaluate(rightNode, previous);
    const pending = unknownOf(left.logic, right.logic);
    if (pending !== null) return unknown(pending);
    if (op === "==" || op === "!=") {
      const equals = equal(left, right, this.env);
      if (!isKnown(equals)) return unknown(equals);
      return boolean((equals === "yes") === (op === "=="));
    }
    if (op === "in") return contains(right, left, this.env);
    if (isAbsent(left) || isAbsent(right)) return FALSE;
    const sign = order(left, right, this.env);
    return boolean(op === "<" ? sign < 0 : op === "<=" ? sign <= 0 : op === ">" ? sign > 0 : sign >= 0);
  }
}

function slotValue(slot: Slot, previous: boolean): Value {
  if (!previous) return slot.value;
  return slot.was ?? UNOBSERVED;
}

function kindName(value: Value): string {
  return value.kind === undefined ? "absent value" : value.kind.replace("_", " ");
}

function items(value: Present<"list", readonly Value[]>): readonly Value[] {
  if (value.datum.length > MAX_LIST) throw limit(`a list has at most ${MAX_LIST} items`);
  return value.datum;
}

/** The items of two lists of the same length, side by side. */
function zip(a: readonly Value[], b: readonly Value[]): [Value, Value][] {
  return a.flatMap((x, i): [Value, Value][] => {
    const y = b[i];
    return y === undefined ? [] : [[x, y]];
  });
}

function count(value: Value): Value {
  if (!isKnown(value.logic)) return value;
  if (isAbsent(value)) return { logic: "yes", kind: "number", datum: 0 };
  if (value.kind !== "list") throw typeError(`count() takes a list, not a ${kindName(value)}`);
  return { logic: "yes", kind: "number", datum: items(value).length };
}

/** Two values are identical when their logical value, kind, datum and absence name all agree. */
function identical(a: Value, b: Value): boolean {
  if (a.logic !== b.logic || a.kind !== b.kind) return false;
  if (a.kind === undefined || b.kind === undefined) return (isAbsent(a) ? a.absent : undefined) === (isAbsent(b) ? b.absent : undefined);
  if (a.kind === "list" && b.kind === "list") {
    return a.datum.length === b.datum.length && zip(a.datum, b.datum).every(([x, y]) => identical(x, y));
  }
  return a.datum === b.datum;
}

/** A date where an instant is needed: the start of that day at the environment's UTC offset. */
function asMs(value: DateValue | DatetimeValue, env: Environment): number {
  return value.kind === "date" ? value.datum * DAY_MS - (env.utcOffsetMin ?? 0) * MINUTE_MS : value.datum;
}

function instant(ms: number): Value {
  if (ms < MIN_MS || ms > MAX_MS) throw typeError("a time outside the years 1 to 9999");
  return { logic: "yes", kind: "datetime", datum: ms };
}

function arith(op: "+" | "-", left: Value, right: Value, env: Environment): Value {
  const pending = unknownOf(left.logic, right.logic);
  if (pending !== null) return unknown(pending);
  if (isAbsent(left) || isAbsent(right)) return ABSENT;
  if (left.kind === "number" && right.kind === "number") {
    return { logic: "yes", kind: "number", datum: op === "+" ? left.datum + right.datum : left.datum - right.datum };
  }
  if (left.kind === "duration" && right.kind === "duration") {
    return { logic: "yes", kind: "duration", datum: op === "+" ? left.datum + right.datum : left.datum - right.datum };
  }
  if (op === "+" && left.kind === "duration" && isTime(right)) return arith("+", right, left, env);
  if (op === "+" && left.kind === "business_days" && right.kind === "date") return arith("+", right, left, env);
  if (isTime(left) && right.kind === "duration") {
    const start = asMs(left, env);
    return instant(op === "+" ? start + right.datum : start - right.datum);
  }
  if (left.kind === "date" && right.kind === "business_days") {
    const { count: days, calendar } = right.datum;
    return { logic: "yes", kind: "date", datum: shiftBusinessDays(left.datum, days, calendar, op === "+" ? 1 : -1) };
  }
  if (op === "-" && isTime(left) && isTime(right)) {
    return { logic: "yes", kind: "duration", datum: asMs(left, env) - asMs(right, env) };
  }
  throw typeError(`${op} does not apply to a ${kindName(left)} and a ${kindName(right)}`);
}

/** The `count`-th business day after `day` (before it, for a negative step); `day` itself for 0. */
function shiftBusinessDays(day: number, count: number, calendar: Calendar, step: 1 | -1): number {
  const weekend = calendar.weekend ?? WEEKEND;
  let current = day;
  let moved = 0;
  while (moved < count) {
    current += step;
    if (current < MIN_DAY || current > MAX_DAY) throw typeError("a date outside the years 1 to 9999");
    if (!weekend.has(isoWeekday(current)) && !calendar.holidays?.has(current)) moved += 1;
  }
  return current;
}

/** Equality of two known values: absences are equal when their names agree (`none` is any absence). */
function equal(left: Value, right: Value, env: Environment): Logic {
  if (isAbsent(left) && isAbsent(right)) {
    const agree = left.absent === undefined || right.absent === undefined || left.absent === right.absent;
    return agree ? "yes" : "no";
  }
  if (isAbsent(left) || isAbsent(right)) return "no";
  if (left.kind === "list" && right.kind === "list") {
    const a = items(left);
    const b = items(right);
    if (a.length !== b.length) return "no";
    const results = zip(a, b).map(([x, y]) => unknownOf(x.logic, y.logic) ?? equal(x, y, env));
    if (results.includes("no")) return "no";
    return unknownOf(...results) ?? "yes";
  }
  if (left.kind === "bool" && right.kind === "bool") return left.datum === right.datum ? "yes" : "no";
  return order(left, right, env) === 0 ? "yes" : "no";
}

/** The number an ordered value compares by, when its kind has an order. */
function ordinal(value: Value): number | undefined {
  switch (value.kind) {
    case "number":
    case "duration":
    case "date":
    case "datetime":
      return value.datum;
    default:
      return undefined;
  }
}

function order(left: Value, right: Value, env: Environment): number {
  if (left.kind === "string" && right.kind === "string") return compareCodePoints(left.datum, right.datum);
  let a: number | undefined;
  let b: number | undefined;
  if (isTime(left) && isTime(right)) [a, b] = [asMs(left, env), asMs(right, env)];
  else if (left.kind === right.kind) [a, b] = [ordinal(left), ordinal(right)];
  if (a === undefined || b === undefined) {
    throw typeError(`cannot compare a ${kindName(left)} with a ${kindName(right)}`);
  }
  return (a > b ? 1 : 0) - (a < b ? 1 : 0);
}

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * The order of two strings by Unicode code point. `<` on strings compares UTF-16 code units, which puts
 * U+E000 to U+FFFF after every character outside the Basic Multilingual Plane; the spec orders by code point.
 */
function compareCodePoints(a: string, b: string): number {
  const shorter = Math.min(a.length, b.length);
  let i = 0;
  while (i < shorter && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  if (i === shorter) return (a.length > b.length ? 1 : 0) - (a.length < b.length ? 1 : 0);
  // Where they differ in the second half of a surrogate pair, compare the whole characters.
  if (i > 0 && isHighSurrogate(a.charCodeAt(i - 1)) && (isLowSurrogate(a.charCodeAt(i)) || isLowSurrogate(b.charCodeAt(i)))) {
    i -= 1;
  }
  const x = a.codePointAt(i) ?? 0;
  const y = b.codePointAt(i) ?? 0;
  return (x > y ? 1 : 0) - (x < y ? 1 : 0);
}

function contains(container: Value, item: Value, env: Environment): Value {
  if (isAbsent(container) || isAbsent(item)) return FALSE;
  if (container.kind !== "list") throw typeError(`in takes a list on its right, not a ${kindName(container)}`);
  const pending: Logic[] = [];
  for (const element of items(container)) {
    if (!isKnown(element.logic)) {
      pending.push(element.logic);
      continue;
    }
    const found = equal(item, element, env);
    if (found === "yes") return TRUE;
    if (!isKnown(found)) pending.push(found);
  }
  const unresolved = unknownOf(...pending);
  return unresolved === null ? FALSE : unknown(unresolved);
}

function sha256(values: readonly Value[]): Value {
  const pending = unknownOf(...values.map((value) => value.logic));
  if (pending !== null) return unknown(pending);
  if (values.some(isAbsent)) return ABSENT;
  const text = values.map(canonical).join("\u001f");
  return { logic: "yes", kind: "string", datum: `sha256:${sha256Hex(new TextEncoder().encode(text))}` };
}

/** An argument of `sha256()` as its text (`spec/object-type.md`, section 5.7). */
function canonical(value: Value): string {
  switch (value.kind) {
    case "string":
      return value.datum;
    case "bool":
      return value.datum ? "true" : "false";
    case "number":
      if (!Number.isInteger(value.datum) || Math.abs(value.datum) > Number.MAX_SAFE_INTEGER) {
        throw typeError("sha256() takes whole numbers up to 2^53 - 1");
      }
      return String(value.datum);
    case "duration":
      return String(value.datum);
    case "date":
      return formatDate(value.datum);
    case "datetime":
      return formatDatetime(value.datum);
    default:
      throw typeError(`sha256() does not take a ${kindName(value)}`);
  }
}

// Time, in integers: days since 1970-01-01 in the proleptic Gregorian calendar, and milliseconds.

/** Days since 1970-01-01 of a date (H. Hinnant's `days_from_civil`). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** The year, month and day of a count of days since 1970-01-01 (H. Hinnant's `civil_from_days`). */
function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shifted = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shifted + 2) / 5) + 1;
  const month = shifted < 10 ? shifted + 3 : shifted - 9;
  return [yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

/** The ISO weekday of a day since 1970-01-01 (1 is Monday; that day was a Thursday). */
const isoWeekday = (days: number): number => ((((days + 3) % 7) + 7) % 7) + 1;

const MIN_DAY = daysFromCivil(1, 1, 1);
const MAX_DAY = daysFromCivil(9999, 12, 31);
const MIN_MS = MIN_DAY * DAY_MS;
const MAX_MS = (MAX_DAY + 1) * DAY_MS - 1;

const pad = (n: number, width: number): string => String(n).padStart(width, "0");
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

/** A `YYYY-MM-DD` date as days since 1970-01-01; a `RangeError` for anything else. */
export function parseDate(text: string): number {
  const match = DATE.exec(text);
  if (match !== null) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const days = daysFromCivil(year, month, day);
    const [y, m, d] = civilFromDays(days);
    if (year >= 1 && y === year && m === month && d === day) return days;
  }
  throw new RangeError(`not a date (YYYY-MM-DD): ${JSON.stringify(text)}`);
}

/** A day since 1970-01-01 as `YYYY-MM-DD`. */
export function formatDate(days: number): string {
  if (!Number.isInteger(days) || days < MIN_DAY || days > MAX_DAY) {
    throw new RangeError(`not a day of the years 1 to 9999: ${days}`);
  }
  const [year, month, day] = civilFromDays(days);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * An RFC 3339 time with its offset as milliseconds since the epoch; digits below the millisecond are
 * dropped. A `RangeError` for anything else, a time without an offset included.
 */
export function parseDatetime(text: string): number {
  const match = DATETIME.exec(text);
  if (match !== null) {
    const [, date = "", hour, minute, second, fraction = "", sign, offsetHours = "0", offsetMinutes = "0"] = match;
    const [h, m, s] = [Number(hour), Number(minute), Number(second)];
    const [oh, om] = [Number(offsetHours), Number(offsetMinutes)];
    if (h <= 23 && m <= 59 && s <= 59 && oh <= 23 && om <= 59) {
      const millis = Number(fraction.slice(0, 3).padEnd(3, "0"));
      const offset = (sign === "-" ? -1 : 1) * (oh * 60 + om);
      return parseDate(date) * DAY_MS + h * HOUR_MS + m * MINUTE_MS + s * SECOND_MS + millis - offset * MINUTE_MS;
    }
  }
  throw new RangeError(`not an RFC 3339 time with an offset: ${JSON.stringify(text)}`);
}

/** The canonical form of an instant: UTC, with milliseconds (`2026-09-29T12:00:00.000Z`). */
export function formatDatetime(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  const rest = ms - days * DAY_MS;
  const time = `${pad(Math.floor(rest / HOUR_MS), 2)}:${pad(Math.floor(rest / MINUTE_MS) % 60, 2)}:${pad(Math.floor(rest / SECOND_MS) % 60, 2)}`;
  return `${formatDate(days)}T${time}.${pad(rest % SECOND_MS, 3)}Z`;
}

// Resolution against a type declaration

/**
 * What a type declares, as the names of its expressions resolve: its fields with their kind (`null` when
 * the declaration fixes none), the fields with completeness levels, computed values, time axes, absence
 * names, inputs, states, and sources with their kind (`pull`, `quote`...).
 */
export interface Scope {
  readonly fields?: Readonly<Record<string, Kind | null>>;
  readonly completeness?: ReadonlySet<string>;
  readonly values?: ReadonlySet<string>;
  readonly axes?: ReadonlySet<string>;
  readonly absentNames?: ReadonlySet<string>;
  readonly inputs?: ReadonlySet<string>;
  readonly states?: ReadonlySet<string>;
  readonly sources?: Readonly<Record<string, string>>;
}

/** What an entry of a type expects its expression to give: anything, a condition, or a time. */
export type Expect = "any" | "condition" | "time";

/**
 * Parses and resolves an expression of a type declaration (`spec/object-type.md`, section 5.12);
 * `expr_invalid` names what is wrong.
 */
export function compileExpression(text: string, scope: Scope, expect: Expect = "any"): Node {
  const node = parse(text);
  const kind = new Checker(scope).kind(node);
  if (kind === "business_days" || kind === "quote") {
    throw invalid(`an expression cannot end in a ${kind.replace("_", " ")}`);
  }
  if (expect === "condition" && kind !== null && kind !== "bool") {
    throw invalid(`a condition must be true or false, and this gives a ${kind}`);
  }
  if (expect === "time" && kind !== null && kind !== "date" && kind !== "datetime") {
    throw invalid(`a time must be a date or a datetime, and this gives a ${kind}`);
  }
  return node;
}

const ARITH = new Map<string, Kind>([
  ["+ number number", "number"],
  ["- number number", "number"],
  ["+ duration duration", "duration"],
  ["- duration duration", "duration"],
  ["+ datetime duration", "datetime"],
  ["- datetime duration", "datetime"],
  ["+ duration datetime", "datetime"],
  ["+ date duration", "datetime"],
  ["- date duration", "datetime"],
  ["+ duration date", "datetime"],
  ["+ date business_days", "date"],
  ["- date business_days", "date"],
  ["+ business_days date", "date"],
  ["- date date", "duration"],
  ["- datetime datetime", "duration"],
  ["- date datetime", "duration"],
  ["- datetime date", "duration"],
]);
const ORDERED = new Set<Kind>(["number", "string", "duration", "date", "datetime"]);
const REFERENCE_KINDS = { age: "duration", observer: "string", changed: "bool" } as const;

/** The kinds a type declaration fixes; `null` where only the evaluation will know. */
class Checker {
  constructor(private readonly scope: Scope) {}

  kind(node: Node): Kind | null {
    switch (node.node) {
      case "literal":
        return node.value.kind ?? null;
      case "name":
        return this.name(node);
      case "member":
        if (this.kind(node.target) !== "quote") throw invalid(`only quote() has fields: '.${node.name}'`);
        return null;
      case "call":
        return this.call(node);
      case "list":
        for (const item of node.items) this.kind(item);
        return "list";
      case "not":
        this.condition(node.operand, "not");
        return "bool";
      case "boolean":
        for (const operand of node.operands) this.condition(operand, node.op);
        return "bool";
      case "compare":
        return this.compare(node.op, node.left, node.right);
      case "arith":
        return this.arith(node.op, this.kind(node.left), this.kind(node.right));
      case "logical":
        throw invalid("yes, no, unobserved and known_defect only appear in == or != comparisons");
    }
  }

  private name(node: NameNode): Kind | null {
    const { scope } = this;
    const { parts } = node;
    const [word] = parts;
    if (parts.length === 1) {
      const meta = META.get(word);
      if (meta !== undefined) return meta;
      const field = own(scope.fields, word);
      if (field !== undefined) return field;
      if (scope.values?.has(word) || scope.axes?.has(word) || scope.absentNames?.has(word)) return null;
      if (scope.states?.has(word)) throw invalid(`'${word}' is a state: write it as a string, '${word}'`);
      if (own(scope.sources, word) !== undefined) throw invalid(`'${word}' is a source: only quote() takes a source`);
      if (word === "config") throw invalid("config takes a key: config.<key>");
      return null; // a field the type observes without declaring it
    }
    const dotted = parts.join(".");
    if (scope.inputs?.has(dotted) || word === "config") return null;
    if (parts.length === 2 && parts[1] === "completeness" && own(scope.fields, word) !== undefined) {
      if (!scope.completeness?.has(word)) throw invalid(`field '${word}' declares no completeness levels`);
      return "string";
    }
    throw invalid(`unknown name '${dotted}': not an input of the type, config.<key> or <field>.completeness`);
  }

  private reference(fn: string, ref: NameNode): void {
    const { scope } = this;
    const [word] = ref.parts;
    const dotted = ref.parts.join(".");
    const fits =
      ref.parts.length > 1
        ? scope.inputs?.has(dotted) === true
        : !META.has(word) && !scope.absentNames?.has(word) && !scope.states?.has(word) && own(scope.sources, word) === undefined;
    if (!fits) throw invalid(`${fn}() takes a field, a value, a time axis or an input: '${dotted}'`);
  }

  private call(node: Call): Kind | null {
    switch (node.fn) {
      case "age":
      case "observer":
      case "changed":
        this.reference(node.fn, node.ref);
        return REFERENCE_KINDS[node.fn];
      case "quote": {
        const kind = own(this.scope.sources, node.source);
        if (kind === undefined) throw invalid(`quote() names an unknown source '${node.source}'`);
        if (kind !== "quote") throw invalid(`quote() takes a source of kind quote, and '${node.source}' is ${kind}`);
        return "quote";
      }
      case "business_days": {
        const kind = this.kind(node.count);
        if (kind !== null && kind !== "number") throw invalid("business_days() counts a number of days");
        return "business_days";
      }
      case "count": {
        const kind = this.kind(node.arg);
        if (kind !== null && kind !== "list") throw invalid("count() takes a list");
        return "number";
      }
      case "sha256":
        for (const arg of node.args) {
          const kind = this.kind(arg);
          if (kind === "list" || kind === "business_days" || kind === "quote") {
            throw invalid("sha256() takes strings, numbers, booleans, durations and times");
          }
        }
        return "string";
      case "was":
        return this.kind(node.arg);
      case "now":
        return "datetime";
      case "presented_in_top":
        return "bool";
    }
  }

  private condition(node: Node, op: string): void {
    const kind = this.kind(node);
    if (kind !== null && kind !== "bool") throw invalid(`${op} takes conditions, and one side gives a ${kind}`);
  }

  private compare(op: Comparison, leftNode: Node, rightNode: Node): Kind {
    const [left, right] = [leftNode, rightNode].filter((side) => side.node !== "logical").map((side) => this.kind(side));
    if (left && right) {
      if (op === "in") {
        if (right !== "list") throw invalid(`in takes a list on its right, and this is a ${right}`);
      } else if (!comparable(op, left, right)) {
        throw invalid(`${op} compares a ${left} with a ${right}`);
      }
    }
    return "bool";
  }

  private arith(op: "+" | "-", left: Kind | null, right: Kind | null): Kind | null {
    if (left === null || right === null) return null;
    const result = ARITH.get(`${op} ${left} ${right}`);
    if (result === undefined) throw invalid(`${op} does not apply to a ${left} and a ${right}`);
    return result;
  }
}

function comparable(op: Comparison, left: Kind, right: Kind): boolean {
  if (left === right) return ORDERED.has(left) || ((op === "==" || op === "!=") && (left === "bool" || left === "list"));
  return (left === "date" && right === "datetime") || (left === "datetime" && right === "date");
}

/** A duration literal (`30s`, `10min`, `24h`, `7d`) in milliseconds, as the declarations write them. */
export function durationMs(text: string): number {
  const found = tokenize(text);
  const [first] = found;
  if (found.length !== 2 || first?.kind !== "dur") {
    throw invalid(`'${text}' is not a duration: a whole number and ms, s, min, h or d`);
  }
  return first.value;
}
