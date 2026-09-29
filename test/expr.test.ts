// niadra-expr beyond its vectors: what a type declaration refuses and why (the server's resolution cases),
// the synchronous SHA-256 against known digests, calendar arithmetic over the whole range of years, bounds
// counted in characters, strings ordered by code point, and names that never read a JavaScript prototype.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NiadraError, expr } from "../src/index.js";
import { sha256Hex } from "../src/sha256.js";

const NOW = expr.parseDatetime("2026-09-29T12:00:00Z");
const DAY_MS = 86_400_000;

const run = (text: string, env: Omit<expr.Environment, "now"> = {}): expr.Value =>
  expr.evaluate(expr.parse(text), { now: NOW, ...env });

const code = (action: () => unknown): string | undefined => {
  try {
    action();
    return undefined;
  } catch (error) {
    if (error instanceof expr.ExprError) return error.code;
    throw error;
  }
};

describe("sha256Hex", () => {
  const text = (value: string) => sha256Hex(new TextEncoder().encode(value));

  it("gives the known digests", () => {
    expect(text("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(text("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(text("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(
      text(
        "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      ),
    ).toBe("cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
    expect(text("a".repeat(1_000_000))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  it("agrees with node:crypto at every length across the block boundaries", () => {
    for (let length = 0; length <= 300; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 131 + length * 7) & 0xff);
      expect(sha256Hex(bytes), `length ${length}`).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });
});

describe("time", () => {
  it("reads and writes every day of the years 1 to 9999 as the UTC calendar does", () => {
    const first = expr.parseDate("0001-01-01");
    const last = expr.parseDate("9999-12-31");
    expect([first, last]).toEqual([Date.parse("0001-01-01T00:00:00Z") / DAY_MS, Date.parse("9999-12-31T00:00:00Z") / DAY_MS]);
    for (let day = first; day <= last; day += 97) {
      const iso = new Date(day * DAY_MS).toISOString().slice(0, 10);
      expect(expr.formatDate(day)).toBe(iso);
      expect(expr.parseDate(iso)).toBe(day);
    }
    expect(expr.formatDate(last)).toBe("9999-12-31");
  });

  it("refuses what is not a day", () => {
    expect(expr.parseDate("2024-02-29")).toBe(19782);
    for (const text of ["2026-02-29", "2024-02-30", "0000-01-01", "2026-13-01", "2026-00-10", "2026-1-01", "10000-01-01", ""]) {
      expect(() => expr.parseDate(text), text).toThrow(RangeError);
    }
  });

  it("reads a time with its offset and drops digits below the millisecond toward the past", () => {
    expect(expr.parseDatetime("2026-09-29T09:00:00-03:00")).toBe(Date.parse("2026-09-29T12:00:00Z"));
    expect(expr.parseDatetime("2026-09-29T17:30:00.5+05:30")).toBe(Date.parse("2026-09-29T12:00:00.500Z"));
    expect(expr.parseDatetime("1969-12-31T23:59:59.9999Z")).toBe(-1);
    expect(expr.formatDatetime(-1)).toBe("1969-12-31T23:59:59.999Z");
    for (const text of ["2026-09-29T12:00:00", "2026-09-29T24:00:00Z", "2026-09-29T12:00:00+24:00", "2026-09-29"]) {
      expect(() => expr.parseDatetime(text), text).toThrow(RangeError);
    }
  });

  it("reads a duration as the declarations write it", () => {
    expect(["250ms", "30s", "10min", "24h", "7d"].map(expr.durationMs)).toEqual([250, 30_000, 600_000, 86_400_000, 604_800_000]);
    for (const text of ["1.5h", "30", "30s 1s", "10m", ""]) expect(code(() => expr.durationMs(text)), text).toBe("expr_invalid");
    expect(code(() => expr.durationMs("1000000s"))).toBe("expr_limit");
  });
});

describe("evaluate", () => {
  it("throws an ExprError, which is a NiadraError, with the code of the spec", () => {
    expect(() => expr.parse("1 +")).toThrow(NiadraError);
    expect(code(() => run("1 + 'a'"))).toBe("expr_type");
  });

  it("orders strings by code point, never by UTF-16 code unit", () => {
    const truths = [
      "'\uFB01' < '\u{1F600}'",
      "'\u{1F600}' < '\u{1F601}'",
      "'\uD83D' < '\u{1F600}'",
      "'\uD800a' < '\uD800b'",
      "'\u{1F600}' > '\uD83D\uFB01'",
      "'a\u{10000}' > 'a\uFFFF'",
    ];
    for (const text of truths) expect(run(text), text).toEqual(expr.boolean(true));
  });

  it("counts the bounds in characters, as the spec does", () => {
    const smile = "\u{1F600}";
    expect(run(`'${smile.repeat(256)}'`)).toEqual({ logic: "yes", kind: "string", datum: smile.repeat(256) });
    expect(code(() => run(`'${smile.repeat(257)}'`))).toBe("expr_limit");
    const atBound = `'${smile.repeat(256)}'`.padEnd(1024 + 256, " ");
    expect(Array.from(atBound)).toHaveLength(1024);
    expect(code(() => run(atBound))).toBeUndefined();
    expect(code(() => run(`${atBound} `))).toBe("expr_limit");
  });

  it("never reads a name from a JavaScript prototype", () => {
    const quotes = { checkout: {} };
    expect(run("constructor")).toEqual(expr.unknown("unobserved"));
    expect(run("__proto__ == unobserved")).toEqual(expr.boolean(true));
    expect(run("config.constructor")).toEqual(expr.absent());
    expect(run("count(constructor)")).toEqual(expr.unknown("unobserved"));
    expect(run("quote(checkout).constructor", { quotes })).toEqual(expr.unknown("unobserved"));
    expect(run("quote(constructor)")).toEqual(expr.unknown("unobserved"));
    expect(code(() => run("today + business_days(1, constructor)", { fields: { today: { value: { logic: "yes", kind: "date", datum: 0 } } } }))).toBe(
      "expr_type",
    );
    expect(code(() => run("10constructor"))).toBe("expr_invalid");
  });

  it("keeps a date's day at the environment's offset, whatever the machine's time zone", () => {
    const fields = { due: { value: { logic: "yes", kind: "date", datum: expr.parseDate("2026-10-15") } } } as const;
    expect(run("due - 48h", { fields, utcOffsetMin: -180 })).toEqual({
      logic: "yes",
      kind: "datetime",
      datum: Date.parse("2026-10-13T03:00:00Z"),
    });
  });
});

describe("compileExpression", () => {
  const SCOPE: expr.Scope = {
    fields: { available: "bool", price: "number", content: "string", tags: "list" },
    completeness: new Set(["content"]),
    values: new Set(["due_date"]),
    axes: new Set(["published_on"]),
    absentNames: new Set(["sem_prazo"]),
    inputs: new Set(["lead.city"]),
    states: new Set(["open", "sem_prazo"]),
    sources: { live: "pull", checkout: "quote" },
  };

  it.each<[string, expr.Expect]>([
    ["available == yes and age(available) <= 5s", "condition"],
    ["due_date != sem_prazo and state == 'open'", "condition"],
    ["quote(checkout).price < price", "condition"],
    ["changed(lead.city) or age(lead.city) > 1d", "condition"],
    ["content.completeness == 'full'", "condition"],
    ["undeclared_field == 'x'", "condition"],
    ["due_date - 48h", "time"],
    ["published_on + business_days(15, court)", "time"],
    ["launch_at", "time"],
    ["due_date - now()", "any"],
    ["sha256(content, published_on)", "any"],
    ["count(tags) > 2 and 'vip' in tags", "condition"],
    ["config.discount_source == 'table'", "condition"],
  ])("accepts %s", (text, expect_) => {
    expect(() => expr.compileExpression(text, SCOPE, expect_)).not.toThrow();
  });

  it.each<[string, expr.Expect, string]>([
    ["age(available)", "condition", "a condition must be true or false, and this gives a duration"],
    ["'noon'", "time", "a time must be a date or a datetime, and this gives a string"],
    ["state == open", "condition", "'open' is a state: write it as a string, 'open'"],
    ["live == yes", "condition", "'live' is a source: only quote() takes a source"],
    ["config == 'x'", "condition", "config takes a key: config.<key>"],
    ["lead.state == 'pe'", "condition", "unknown name 'lead.state'"],
    ["price.completeness == 'full'", "condition", "field 'price' declares no completeness levels"],
    ["age(state) > 1s", "condition", "age() takes a field, a value, a time axis or an input: 'state'"],
    ["changed(lead.state)", "condition", "changed() takes a field, a value, a time axis or an input"],
    ["quote(nothing).price > 1", "condition", "quote() names an unknown source 'nothing'"],
    ["quote(live).price > 1", "condition", "quote() takes a source of kind quote, and 'live' is pull"],
    ["price.x == 1", "condition", "unknown name 'price.x'"],
    ["(price).x == 1", "condition", "only quote() has fields: '.x'"],
    ["count(price) > 1", "condition", "count() takes a list"],
    ["sha256(tags)", "any", "sha256() takes strings, numbers, booleans, durations and times"],
    ["not age(available)", "condition", "not takes conditions, and one side gives a duration"],
    ["price and available", "condition", "and takes conditions, and one side gives a number"],
    ["'a' in content", "condition", "in takes a list on its right, and this is a string"],
    ["age(available) > 5", "condition", "> compares a duration with a number"],
    ["now() + now()", "any", "+ does not apply to a datetime and a datetime"],
    ["business_days('3', court)", "any", "business_days() counts a number of days"],
    ["business_days(3, court)", "any", "an expression cannot end in a business days"],
    ["quote(checkout)", "any", "an expression cannot end in a quote"],
  ])("refuses %s with the reason", (text, expect_, detail) => {
    let caught: unknown;
    try {
      expr.compileExpression(text, SCOPE, expect_);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(expr.ExprError);
    expect((caught as expr.ExprError).code).toBe("expr_invalid");
    expect((caught as expr.ExprError).message).toContain(detail);
  });

  it("reserves the language's words and the context names", () => {
    expect([...expr.RESERVED].sort()).toEqual(
      [
        "and",
        "config",
        "derived_status",
        "false",
        "in",
        "known_defect",
        "no",
        "none",
        "not",
        "or",
        "purpose",
        "state",
        "true",
        "unobserved",
        "watch_count",
        "yes",
      ].sort(),
    );
  });
});
