/**
 * Decimals for the amounts the parser reads: `R$ 511,06` is 51106 hundredths, never a float, so every SDK
 * writes and compares the same `"511.06"`. Arithmetic and the written form keep 28 significant digits, as
 * the default context of Python's `decimal` does.
 */

import { digitValue } from "./text.js";

/** `digits / 10 ** scale`; a negative scale multiplies. */
export interface Decimal {
  readonly digits: bigint;
  readonly scale: number;
}

const DECIMAL = /^([+-]?)(\p{Nd}*)(?:\.(\p{Nd}*))?$/u;

function bigint(digits: string): bigint {
  let value = 0n;
  for (const ch of digits) value = value * 10n + BigInt(digitValue(ch));
  return value;
}

/** A decimal written with digits of any script, an optional sign and an optional `.` fraction. */
export function decimal(text: string): Decimal {
  const m = DECIMAL.exec(text);
  const whole = m?.[2] ?? "";
  const frac = m?.[3] ?? "";
  if (!m || whole + frac === "") throw new TypeError(`not a decimal: ${JSON.stringify(text)}`);
  const digits = bigint(whole + frac);
  return { digits: m[1] === "-" ? -digits : digits, scale: Array.from(frac).length };
}

export function fromInteger(value: bigint): Decimal {
  return { digits: value, scale: 0 };
}

const PRECISION = 28;

/** `value` to `PRECISION` significant digits, half to even. */
function rounded(value: Decimal): Decimal {
  const negative = value.digits < 0n;
  let digits = negative ? -value.digits : value.digits;
  const extra = digits.toString().length - PRECISION;
  if (extra <= 0) return value;
  const unit = 10n ** BigInt(extra);
  const rest = digits % unit;
  digits /= unit;
  if (2n * rest > unit || (2n * rest === unit && digits % 2n === 1n)) digits += 1n;
  return { digits: negative ? -digits : digits, scale: value.scale - extra };
}

export function times(value: Decimal, factor: bigint): Decimal {
  return rounded({ digits: value.digits * factor, scale: value.scale });
}

function aligned(a: Decimal, b: Decimal): [bigint, bigint] {
  const scale = Math.max(a.scale, b.scale);
  return [a.digits * 10n ** BigInt(scale - a.scale), b.digits * 10n ** BigInt(scale - b.scale)];
}

/** Negative, zero or positive as `a` is less than, equal to or greater than `b`. */
export function compare(a: Decimal, b: Decimal): number {
  const [x, y] = aligned(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function isIntegral(value: Decimal): boolean {
  return value.scale <= 0 || value.digits % 10n ** BigInt(value.scale) === 0n;
}

/** The decimal as the vectors write it: plain digits, no exponent, no trailing zeros (`"511.06"`, `"1500"`). */
export function decimalText(value: Decimal): string {
  const { digits: signed, scale } = rounded(value);
  const negative = signed < 0n;
  const magnitude = negative ? -signed : signed;
  if (scale <= 0) return `${negative ? "-" : ""}${magnitude * 10n ** BigInt(-scale)}`;
  const digits = magnitude.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, "");
  const text = frac ? `${whole}.${frac}` : whole;
  return negative && text !== "0" ? `-${text}` : text;
}
