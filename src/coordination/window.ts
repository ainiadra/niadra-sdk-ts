/**
 * A contact window (`spec/suppression-list.md`, 6.4): the local hours a suppression holds in, as when a customer
 * says "don't call before 9 am" (from 00:00 to 09:00 on the voice channel). Outside them the contact may go.
 *
 * - `from` is inclusive and `to` exclusive: at exactly 09:00 the window from 00:00 to 09:00 is over;
 * - a window whose `to` is not after its `from` crosses midnight and belongs to the day it starts on: a Friday
 *   window from 22:00 to 06:00 still holds at 01:00 on Saturday;
 * - `days` are ISO weekdays (1 is Monday) the window starts on, or null for every day;
 * - local time follows the zone's rules, by the runtime's IANA time zone data (`Intl`), daylight saving included.
 *
 * The spec's vectors (`spec/vectors/contact-window.v0.json`) check this module.
 */

/** Not a window: a bad clock time, a start equal to its end, a zone that is not an IANA name (or that the runtime
 * does not know), or a day that is not an ISO weekday. */
export class NiadraWindowError extends Error {
  readonly code = "invalid_window";
  constructor(message: string) {
    super(message);
    this.name = "NiadraWindowError";
  }
}

export interface WindowLike {
  from: string;
  to: string;
  tz: string;
  days?: number[] | null;
}

const CLOCK = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const ZONE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/;
const DAY_MS = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

/** When the window `at` falls in ends, or null when `at` is outside it. */
export function windowUntil(window: WindowLike, at: Date): Date | null {
  const start = minutes(window.from);
  const end = minutes(window.to);
  const days = window.days ?? [];
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw new NiadraWindowError("days are ISO weekdays, 1 (Monday) to 7 (Sunday)");
  }
  if (start === end) throw new NiadraWindowError("a window starts before it ends");
  if (!ZONE.test(window.tz)) throw new NiadraWindowError(`${window.tz} is not an IANA time zone`);
  const local = parts(at, window.tz);
  const now = local.hour * 60 + local.minute;
  const today = Date.UTC(local.year, local.month - 1, local.day);
  const crosses = end <= start;
  let first: number | null;
  if (!crosses) first = start <= now && now < end ? today : null;
  else if (now >= start) first = today;
  else first = now < end ? today - DAY_MS : null;
  if (first === null) return null;
  const weekday = ((new Date(first).getUTCDay() + 6) % 7) + 1;
  if (days.length > 0 && !days.includes(weekday)) return null;
  const last = new Date(crosses ? first + DAY_MS : first);
  return instant(last.getUTCFullYear(), last.getUTCMonth() + 1, last.getUTCDate(), end, window.tz);
}

function minutes(text: string): number {
  const found = CLOCK.exec(text);
  if (found === null) throw new NiadraWindowError(`${text} is not a time as HH:MM`);
  return Number(found[1]) * 60 + Number(found[2]);
}

function format(tz: string): Intl.DateTimeFormat {
  let found = formats.get(tz);
  if (found === undefined) {
    try {
      found = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw new NiadraWindowError(`${tz} is not a time zone this runtime knows`);
    }
    formats.set(tz, found);
  }
  return found;
}

interface Local {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function parts(at: Date, tz: string): Local {
  const out: Record<string, number> = {};
  for (const p of format(tz).formatToParts(at)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? 0,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** The zone's offset from UTC at `at`, in milliseconds. */
function offset(at: number, tz: string): number {
  const p = parts(new Date(at), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/** The instant a local wall time names in the zone. */
function instant(year: number, month: number, day: number, minuteOfDay: number, tz: string): Date {
  const wall = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let guess = wall - offset(wall, tz);
  guess = wall - offset(guess, tz);
  return new Date(guess);
}
