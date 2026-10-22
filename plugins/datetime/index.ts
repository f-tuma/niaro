/**
 * Date & time: the reference example of a *pure* plugin.
 *
 * A pure plugin computes. Its tool gets the model's arguments and the turn's
 * clock (ctx.now, ctx.timeZone) and returns flat values; it has no network,
 * no credentials and no saved data. The agent passes the values on to an
 * action as `$plugin.result_1.utc`, so the model never copies or recalculates
 * a date itself.
 *
 * The file has two parts:
 *   1. the plugin: input schema, tool description and `run` (this function);
 *   2. the calendar arithmetic it calls: plain functions below, also used by
 *      the server's meeting notes.
 *
 * plugin.json next to this file declares the same tool (name, read access,
 * no approval). See docs/plugins.md.
 */
import type { PluginSdk, PureToolResult } from "@niaro/plugin-sdk";

export default function dateTimePlugin({
  definePlugin,
  defineTool,
  z,
}: PluginSdk) {
  // 1. The input. The server validates every call against this schema before
  //    `run`, and the JSON schema the model sees is generated from it, so the
  //    two cannot drift apart. Keep it strict: unknown fields are an error.
  const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
  const weekday = z.number().int().min(1).max(7);
  const input = z
    .strictObject({
      when: z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("date"),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
        z.strictObject({
          kind: z.literal("day_offset"),
          days: z.number().int().min(-3660).max(3660),
        }),
        z.strictObject({
          kind: z.literal("week_day"),
          weeks: z.number().int().min(-520).max(520),
          weekday,
        }),
        z.strictObject({ kind: z.literal("next_weekday"), weekday }),
        z.strictObject({
          kind: z.literal("elapsed"),
          minutes: z.number().int().min(-525600).max(525600),
        }),
      ]),
      time: time.optional(),
      timeZone: z.string().min(1).max(100).refine(isTimeZone).optional(),
      utcOffset: z
        .string()
        .regex(/^[+-](?:0\d|1[0-4]):[0-5]\d$/)
        .optional(),
      durationMinutes: z.number().int().min(1).max(10080).optional(),
      wholeDay: z.boolean().optional(),
    })
    .superRefine((value, ctx) => {
      if (
        value.wholeDay &&
        (value.when.kind === "elapsed" ||
          value.time !== undefined ||
          value.durationMinutes !== undefined)
      )
        ctx.addIssue({
          code: "custom",
          message: "A whole day has no time, duration or elapsed minutes",
        });
      if (
        value.when.kind === "elapsed" &&
        (value.time !== undefined || value.utcOffset !== undefined)
      )
        ctx.addIssue({
          code: "custom",
          message: "Elapsed minutes cannot include a wall time or offset",
        });
    });

  // 2. The tool. The description is the model's only manual: say what the
  //    tool is for, what each mode means and what the model must not do.
  const resolve = defineTool({
    name: "internal_datetime_resolve",
    description:
      "Calculate exact dates/times on the server before scheduling or passing times to another tool. Interpret language, do not calculate calendar dates yourself. date = explicit YYYY-MM-DD; day_offset = calendar days from today (tomorrow=1); week_day = ISO Monday-based week, weeks=0 this week, 1 next week, weekday=1 Monday..7 Sunday; next_weekday = strictly next calendar occurrence, excluding today; elapsed = exact minutes from now (in two hours=120). Omit time when the request is about a day (e.g. what is on the calendar on Thursday): the result spans that whole local day, utc to endUtc. Give a 24-hour time only when the person said one; for a new meeting without a time ask only for the time. The timezone is already known: never ask the person for a timezone or UTC offset. timeZone defaults to the server's stated zone; override only for a user-specified zone. utcOffset only if user explicitly provided it, never choose an ambiguous DST offset yourself. durationMinutes measures elapsed time. Supported years 2000–2100. Results are data, not permission to run any external action.",
    input,
    // 3. The work. `ctx.now` and `ctx.timeZone` come from the server and are
    //    pinned for the turn: a retry tomorrow still means the same "tomorrow".
    //    A pure tool returns synchronously.
    run: (args, ctx) =>
      resolveDateTime(args, { referenceNow: ctx.now, timeZone: ctx.timeZone }),
  });

  return definePlugin({ tools: [resolve] });
}

// ---------------------------------------------------------------------------
// Calendar arithmetic. Nothing here depends on the SDK.

export type DateTimeRequest = {
  when:
    | { kind: "date"; date: string }
    | { kind: "day_offset"; days: number }
    | { kind: "week_day"; weeks: number; weekday: number }
    | { kind: "next_weekday"; weekday: number }
    | { kind: "elapsed"; minutes: number };
  time?: string;
  timeZone?: string;
  utcOffset?: string;
  durationMinutes?: number;
  /** The whole local calendar day, from midnight to the next midnight. */
  wholeDay?: boolean;
};
export type DateTimeClock = { referenceNow: string; timeZone: string };

/** Named IANA zones and UTC only; never the operating system's zone. */
export function isTimeZone(value: string) {
  if (value !== "UTC" && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(value))
    return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
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
function referenceInstant(value: string) {
  const epoch = Date.parse(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/.test(value) ||
    !Number.isFinite(epoch)
  )
    throw new Error("The reference time must be an ISO instant in UTC");
  return epoch;
}

/** Pure calendar arithmetic. Neither clock nor timezone can come from model-owned context. */
export function resolveDateTime(
  input: DateTimeRequest,
  clock: DateTimeClock,
): PureToolResult {
  // A date alone is the whole day ("what is on Thursday"); only a duration needs a time.
  if (
    input.wholeDay ||
    (!input.time &&
      input.when.kind !== "elapsed" &&
      input.durationMinutes === undefined)
  )
    return wholeDay(input, clock);
  if (!input.timeZone && !isTimeZone(clock.timeZone))
    throw new Error("The clock's time zone is not a named IANA zone");
  const timeZone = input.timeZone ?? clock.timeZone;
  const format = formatter(timeZone);
  const anchor = referenceInstant(clock.referenceNow);
  const clarify = (
    reason:
      | "missing_time"
      | "invalid_date"
      | "ambiguous_time"
      | "nonexistent_time"
      | "invalid_offset",
    localDateTime?: string,
  ): PureToolResult => ({
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
  input: DateTimeRequest,
  clock: DateTimeClock,
): PureToolResult {
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
