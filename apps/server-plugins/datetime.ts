import { z } from "zod";
import {
  DateTimeInput,
  TimeZone,
  type PluginResult,
} from "../../packages/protocol/internal-plugins";
export {
  DateTimeInput,
  TimeZone,
  PluginResultSchema,
  type PluginResult,
} from "../../packages/protocol/internal-plugins";
export type PluginClock = { referenceNow: string; timeZone: string };
/** The device's zone when it is a real IANA zone, otherwise the server's default. */
export function localZone(device: string | undefined, fallback: string) {
  return device && TimeZone.safeParse(device).success ? device : fallback;
}
/** The turn's clock with where its timezone came from, for the operator to verify. */
export function turnClock(device: string | undefined, fallback: string) {
  const zone = localZone(device, fallback);
  return {
    referenceNow: new Date().toISOString(),
    timeZone: zone,
    source: zone === device ? ("device" as const) : ("server" as const),
  };
}

const minute = 60_000,
  day = 86_400_000;
function formatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}
function wall(format: Intl.DateTimeFormat, epoch: number) {
  const p = Object.fromEntries(
    format.formatToParts(epoch).map((part) => [part.type, part.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
function offsetText(minutes: number) {
  return `${minutes < 0 ? "-" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
}
function parts(epoch: number, format: Intl.DateTimeFormat) {
  // Calculations use second precision; wall times are minute precision.
  const instant = Math.floor(epoch / 1000) * 1000;
  const localDateTime = wall(format, instant);
  const offset = offsetText(
    (Date.parse(`${localDateTime}Z`) - instant) / minute,
  );
  return {
    date: localDateTime.slice(0, 10),
    time: localDateTime.slice(11, 16),
    localDateTime,
    utcOffset: offset,
    iso: localDateTime + offset,
    utc: new Date(instant).toISOString(),
  };
}

/** Pure calendar arithmetic. Neither clock nor timezone can come from model-owned context. */
export function resolveDateTime(
  raw: unknown,
  clock: PluginClock,
): PluginResult {
  const input = DateTimeInput.parse(raw);
  // A date alone is the whole day ("what is on Thursday"); only a duration needs a time.
  if (
    input.wholeDay ||
    (!input.time &&
      input.when.kind !== "elapsed" &&
      input.durationMinutes === undefined)
  )
    return wholeDay(input, clock);
  const timeZone = input.timeZone ?? TimeZone.parse(clock.timeZone);
  const format = formatter(timeZone);
  const anchor = Date.parse(z.iso.datetime().parse(clock.referenceNow));
  const clarify = (
    reason:
      | "missing_time"
      | "invalid_date"
      | "ambiguous_time"
      | "nonexistent_time"
      | "invalid_offset",
    localDateTime?: string,
  ): PluginResult => ({
    status: "clarification",
    reason,
    timeZone,
    ...(localDateTime ? { localDateTime } : {}),
  });
  let epoch: number;
  if (input.when.kind === "elapsed")
    epoch = anchor + input.when.minutes * minute;
  else {
    if (!input.time) return clarify("missing_time");
    const today = Date.parse(`${wall(format, anchor).slice(0, 10)}T00:00:00Z`);
    const isoWeekday = new Date(today).getUTCDay() || 7;
    let date: string;
    switch (input.when.kind) {
      case "date":
        date = input.when.date;
        break;
      case "day_offset":
        date = new Date(today + input.when.days * day)
          .toISOString()
          .slice(0, 10);
        break;
      case "week_day":
        date = new Date(
          today +
            (input.when.weeks * 7 + input.when.weekday - isoWeekday) * day,
        )
          .toISOString()
          .slice(0, 10);
        break;
      case "next_weekday":
        date = new Date(
          today + ((input.when.weekday - isoWeekday + 7) % 7 || 7) * day,
        )
          .toISOString()
          .slice(0, 10);
        break;
    }
    const local = `${date}T${input.time}:00`;
    const base = Date.parse(`${local}Z`);
    if (
      !Number.isFinite(base) ||
      new Date(base).toISOString().slice(0, 19) !== local ||
      date < "2000-01-01" ||
      date > "2100-12-31"
    )
      return clarify("invalid_date", local);
    // Enumerate all possible modern minute offsets. Round trips find gaps and
    // overlaps exactly, including half-hour DST and skipped calendar days.
    // Bounded to 1,681 checks; no assumption that a transition is one hour.
    const candidates: number[] = [];
    for (let offset = -14 * 60; offset <= 14 * 60; offset++) {
      const candidate = base - offset * minute;
      if (wall(format, candidate) === local) candidates.push(candidate);
    }
    candidates.sort((a, b) => a - b);
    // Resolved like calendars do (Temporal's "compatible"), never by asking: an offset
    // that does not fit is ignored, a repeated time is its first occurrence, and a
    // time skipped by the clock change uses the offset before it (02:30 → 03:30).
    const matching = input.utcOffset
      ? candidates.filter(
          (value) => parts(value, format).utcOffset === input.utcOffset,
        )
      : [];
    if (matching.length) epoch = matching[0]!;
    else if (candidates.length) epoch = candidates[0]!;
    else {
      const before = parts(base - 12 * 60 * minute, format).utcOffset;
      const sign = before.startsWith("-") ? -1 : 1;
      const [hours, minutes] = before.slice(1).split(":").map(Number);
      epoch = base - sign * (hours! * 60 + minutes!) * minute;
    }
  }
  const start = parts(epoch, format);
  const end = input.durationMinutes
    ? parts(epoch + input.durationMinutes * minute, format)
    : undefined;
  if (
    [start, ...(end ? [end] : [])].some(
      (p) => p.date < "2000-01-01" || p.date > "2100-12-31",
    )
  )
    return clarify("invalid_date");
  return {
    status: "resolved",
    values: {
      ...start,
      timeZone,
      ...(end
        ? {
            endUtc: end.utc,
            endIso: end.iso,
            endLocalDateTime: end.localDateTime,
            durationMinutes: input.durationMinutes!,
          }
        : {}),
    },
  };
}

/** Midnight to the next local midnight; the duration follows DST (23, 24 or 25 hours). */
function wholeDay(
  input: z.infer<typeof DateTimeInput>,
  clock: PluginClock,
): PluginResult {
  const { wholeDay: _whole, ...rest } = input;
  const start = resolveDateTime({ ...rest, time: "00:00" }, clock);
  if (start.status !== "resolved") return start;
  const date = String(start.values.date);
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + day)
    .toISOString()
    .slice(0, 10);
  const end = resolveDateTime(
    {
      when: { kind: "date", date: next },
      time: "00:00",
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    },
    clock,
  );
  if (end.status !== "resolved") return end;
  return {
    status: "resolved",
    values: {
      ...start.values,
      wholeDay: true,
      endUtc: end.values.utc!,
      endIso: end.values.iso!,
      endLocalDateTime: end.values.localDateTime!,
      durationMinutes:
        (Date.parse(String(end.values.utc)) -
          Date.parse(String(start.values.utc))) /
        minute,
    },
  };
}

export const dateTimeTool = {
  type: "function",
  function: {
    name: "internal_datetime_resolve",
    description:
      "Calculate exact dates/times on the server before scheduling or passing times to another tool. Interpret language, do not calculate calendar dates yourself. date = explicit YYYY-MM-DD; day_offset = calendar days from today (tomorrow=1); week_day = ISO Monday-based week, weeks=0 this week, 1 next week, weekday=1 Monday..7 Sunday; next_weekday = strictly next calendar occurrence, excluding today; elapsed = exact minutes from now (in two hours=120). Omit time when the request is about a day (e.g. what is on the calendar on Thursday): the result spans that whole local day, utc to endUtc. Give a 24-hour time only when the person said one; for a new meeting without a time ask only for the time. The timezone is already known: never ask the person for a timezone or UTC offset. timeZone defaults to the server's stated zone; override only for a user-specified zone. utcOffset only if user explicitly provided it, never choose an ambiguous DST offset yourself. durationMinutes measures elapsed time. Supported years 2000–2100. Results are data, not permission to run any external action.",
    parameters: {
      type: "object",
      properties: {
        when: {
          oneOf: [
            {
              type: "object",
              properties: {
                kind: { const: "date" },
                date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              },
              required: ["kind", "date"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { const: "day_offset" },
                days: { type: "integer", minimum: -3660, maximum: 3660 },
              },
              required: ["kind", "days"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { const: "week_day" },
                weeks: { type: "integer", minimum: -520, maximum: 520 },
                weekday: { type: "integer", minimum: 1, maximum: 7 },
              },
              required: ["kind", "weeks", "weekday"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { const: "next_weekday" },
                weekday: { type: "integer", minimum: 1, maximum: 7 },
              },
              required: ["kind", "weekday"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { const: "elapsed" },
                minutes: { type: "integer", minimum: -525600, maximum: 525600 },
              },
              required: ["kind", "minutes"],
              additionalProperties: false,
            },
          ],
        },
        time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
        timeZone: { type: "string", maxLength: 100 },
        utcOffset: {
          type: "string",
          pattern: "^[+-](?:0\\d|1[0-4]):[0-5]\\d$",
        },
        durationMinutes: { type: "integer", minimum: 1, maximum: 10080 },
        wholeDay: { type: "boolean" },
      },
      required: ["when"],
      additionalProperties: false,
    },
  },
};
