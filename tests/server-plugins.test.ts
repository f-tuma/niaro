import {
  DateTimeInput,
  resolveDateTime,
  TimeZone,
  type PluginClock,
} from "../apps/server-plugins/datetime";
import {
  bindPluginResults,
  createInternalPlugins,
  PluginSettingsSchema,
} from "../apps/server-plugins/registry";

const clock = {
  referenceNow: "2026-09-27T21:30:00.000Z",
  timeZone: "Europe/Prague",
};
const resolve = (
  when: unknown,
  extra: object = {},
  reference: PluginClock = clock,
) => resolveDateTime({ when, time: "14:00", ...extra }, reference);
const values = (result: ReturnType<typeof resolveDateTime>) => {
  if (result.status !== "resolved") throw Error(JSON.stringify(result));
  return result.values;
};

test("next week's Tuesday is computed from the local Monday-based calendar, with exact forwarding fields", () => {
  expect(
    values(
      resolve(
        { kind: "week_day", weeks: 1, weekday: 2 },
        { durationMinutes: 30 },
      ),
    ),
  ).toEqual({
    date: "2026-09-29",
    time: "14:00",
    localDateTime: "2026-09-29T14:00:00",
    utcOffset: "+02:00",
    timeZone: "Europe/Prague",
    utc: "2026-09-29T12:00:00.000Z",
    iso: "2026-09-29T14:00:00+02:00",
    endUtc: "2026-09-29T12:30:00.000Z",
    endIso: "2026-09-29T14:30:00+02:00",
    endLocalDateTime: "2026-09-29T14:30:00",
    durationMinutes: 30,
  });
  // UTC still Sunday; Prague is already Monday. Next week is now October 5–11.
  expect(
    values(
      resolve(
        { kind: "week_day", weeks: 1, weekday: 2 },
        {},
        { ...clock, referenceNow: "2026-09-27T23:30:00.000Z" },
      ),
    ).date,
  ).toBe("2026-10-06");
});

test("next weekday excludes today, while a week-relative weekday can include it", () => {
  expect(values(resolve({ kind: "next_weekday", weekday: 7 })).date).toBe(
    "2026-10-04",
  );
  expect(values(resolve({ kind: "week_day", weeks: 0, weekday: 7 })).date).toBe(
    "2026-09-27",
  );
  expect(values(resolve({ kind: "next_weekday", weekday: 1 })).date).toBe(
    "2026-09-28",
  );
});

test("calendar offsets cross month, leap year and year boundaries without overflow normalization", () => {
  const leap = { ...clock, referenceNow: "2028-02-28T10:00:00.000Z" };
  expect(values(resolve({ kind: "day_offset", days: 1 }, {}, leap)).date).toBe(
    "2028-02-29",
  );
  expect(values(resolve({ kind: "day_offset", days: 2 }, {}, leap)).date).toBe(
    "2028-03-01",
  );
  expect(
    values(
      resolve(
        { kind: "day_offset", days: -1 },
        {},
        { ...clock, referenceNow: "2027-01-01T10:00:00.000Z" },
      ),
    ).date,
  ).toBe("2026-12-31");
  for (const date of [
    "2027-02-29",
    "2026-02-30",
    "2026-13-01",
    "0099-01-01",
    "1999-12-31",
    "2101-01-01",
  ])
    expect(resolve({ kind: "date", date })).toMatchObject({
      status: "clarification",
      reason: "invalid_date",
    });
});

test("Prague clock changes are resolved like a calendar, never by asking about offsets", () => {
  // 02:30 is skipped in spring: the offset before the change applies (03:30 CEST).
  expect(
    values(resolve({ kind: "date", date: "2026-03-29" }, { time: "02:30" })),
  ).toMatchObject({ utc: "2026-03-29T01:30:00.000Z", time: "03:30" });
  // 02:30 happens twice in autumn: its first occurrence.
  expect(
    values(resolve({ kind: "date", date: "2026-10-25" }, { time: "02:30" }))
      .utc,
  ).toBe("2026-10-25T00:30:00.000Z");
  expect(
    values(
      resolve(
        { kind: "date", date: "2026-10-25" },
        { time: "02:30", utcOffset: "+01:00" },
      ),
    ).utc,
  ).toBe("2026-10-25T01:30:00.000Z");
  // An offset that does not fit is ignored rather than questioned.
  expect(
    values(
      resolve(
        { kind: "date", date: "2026-10-25" },
        { time: "02:30", utcOffset: "+03:00" },
      ),
    ).utc,
  ).toBe("2026-10-25T00:30:00.000Z");
});

test("duration and elapsed offsets follow real elapsed time, calendar days retain wall-clock semantics", () => {
  const beforeDST = { ...clock, referenceNow: "2026-03-28T13:00:00.000Z" };
  expect(
    values(resolve({ kind: "day_offset", days: 1 }, {}, beforeDST)).utc,
  ).toBe("2026-03-29T12:00:00.000Z");
  expect(
    values(
      resolveDateTime({ when: { kind: "elapsed", minutes: 1440 } }, beforeDST),
    ).time,
  ).toBe("15:00");
  expect(
    values(
      resolve(
        { kind: "date", date: "2026-03-29" },
        { time: "01:30", durationMinutes: 60 },
      ),
    ),
  ).toMatchObject({
    utc: "2026-03-29T00:30:00.000Z",
    endUtc: "2026-03-29T01:30:00.000Z",
    endIso: "2026-03-29T03:30:00+02:00",
  });
  expect(
    resolve(
      { kind: "date", date: "2100-12-31" },
      { time: "23:59", durationMinutes: 60 },
    ),
  ).toMatchObject({ status: "clarification", reason: "invalid_date" });
});

test("fractional offsets, half-hour DST, a skipped whole date and extreme offsets", () => {
  expect(
    values(
      resolve(
        { kind: "date", date: "2026-09-29" },
        { timeZone: "Asia/Kathmandu" },
      ),
    ),
  ).toMatchObject({ utc: "2026-09-29T08:15:00.000Z", utcOffset: "+05:45" });
  // Half-hour DST repeats 01:45: the first occurrence (+11:00).
  expect(
    values(
      resolve(
        { kind: "date", date: "2026-04-05" },
        { timeZone: "Australia/Lord_Howe", time: "01:45" },
      ),
    ),
  ).toMatchObject({ utc: "2026-04-04T14:45:00.000Z", utcOffset: "+11:00" });
  // Samoa skipped 30 December 2011 entirely: 14:00 lands on 31 December.
  expect(
    values(
      resolve(
        { kind: "date", date: "2011-12-30" },
        { timeZone: "Pacific/Apia" },
      ),
    ),
  ).toMatchObject({ date: "2011-12-31", time: "14:00" });
  expect(
    values(
      resolve(
        { kind: "date", date: "2026-09-29" },
        { timeZone: "Pacific/Kiritimati" },
      ),
    ).utcOffset,
  ).toBe("+14:00");
  expect(
    values(
      resolve({ kind: "date", date: "2026-09-29" }, { timeZone: "Etc/GMT+12" }),
    ).utcOffset,
  ).toBe("-12:00");
});

test("strict arguments cannot override the server clock; a date alone is the whole day", () => {
  const when = { kind: "day_offset", days: 1 };
  expect(values(resolveDateTime({ when }, clock))).toMatchObject({
    wholeDay: true,
    iso: "2026-09-28T00:00:00+02:00",
    endIso: "2026-09-29T00:00:00+02:00",
  });
  // Only a duration needs a start time, and a time is never guessed.
  expect(resolveDateTime({ when, durationMinutes: 30 }, clock)).toMatchObject({
    status: "clarification",
    reason: "missing_time",
  });
  for (const extra of [
    { time: "24:00" },
    { time: "2pm" },
    { timeZone: "invented/zone" },
    { referenceNow: "2026-01-01T00:00:00Z" },
    { when: { ...when, date: "2026-01-01" } },
    { when: { kind: "elapsed", minutes: 10 }, time: "14:00" },
  ])
    expect(
      DateTimeInput.safeParse({ when, time: "14:00", ...extra }).success,
    ).toBe(false);
  for (const zone of ["+02:00", "invalid", "", "../../secret"])
    expect(TimeZone.safeParse(zone).success).toBe(false);
});

test("registry allows only shipped pure plugins and validates configuration", () => {
  const registry = createInternalPlugins({
    enabled: ["datetime"],
    timeZone: "Europe/Prague",
  });
  expect(registry.manifests).toEqual([
    {
      id: "datetime",
      version: 1,
      effect: "pure",
      tools: ["internal_datetime_resolve"],
    },
  ]);
  expect(createInternalPlugins({ enabled: [], timeZone: "UTC" }).tools).toEqual(
    [],
  );
  expect(() =>
    createInternalPlugins({ enabled: [], timeZone: "UTC" }).invoke(
      "internal_datetime_resolve",
      {},
      clock,
      1,
    ),
  ).toThrow();
  expect(() => registry.invoke("remote_code", {}, clock, 1)).toThrow();
  expect(() =>
    registry.invoke("internal_datetime_resolve", {}, clock, 5),
  ).toThrow();
  expect(PluginSettingsSchema.safeParse({ enabled: ["remote"] }).success).toBe(
    false,
  );
});

test("result binding forwards exact server scalars, rejecting interpolation, missing and forged references", () => {
  const receipt = createInternalPlugins().invoke(
    "internal_datetime_resolve",
    { when: { kind: "week_day", weeks: 1, weekday: 2 }, time: "14:00" },
    clock,
    1,
  );
  expect(
    bindPluginResults(
      {
        meeting: [
          { start: "$plugin.result_1.utc", zone: "$plugin.result_1.timeZone" },
        ],
      },
      [receipt],
    ),
  ).toEqual({
    meeting: [{ start: "2026-09-29T12:00:00.000Z", zone: "Europe/Prague" }],
  });
  for (const input of [
    { start: "$plugin.result_2.utc" },
    { start: "$plugin.result_1.endUtc" },
    { start: "date=$plugin.result_1.utc" },
    { "$plugin.result_1.utc": "x" },
    { start: "$plugin.result_1.constructor" },
  ])
    expect(() => bindPluginResults(input, [receipt])).toThrow();
  const missing = createInternalPlugins().invoke(
    "internal_datetime_resolve",
    { when: { kind: "day_offset", days: 1 }, durationMinutes: 30 },
    clock,
    1,
  );
  expect(() =>
    bindPluginResults({ start: "$plugin.result_1.utc" }, [missing]),
  ).toThrow();
});

test("binding preserves the established action-input depth and size limits", () => {
  let nested: Record<string, unknown> = { value: "ordinary data" };
  for (let i = 0; i < 30; i++) nested = { child: nested };
  expect(bindPluginResults(nested, [])).toEqual(nested);
  const wide = { values: Array.from({ length: 6000 }, () => 1) };
  expect(bindPluginResults(wide, [])).toEqual(wide);
  expect(() =>
    bindPluginResults({ values: Array.from({ length: 10000 }, () => 1) }, []),
  ).toThrow();
});

test("a whole day spans local midnight to midnight, following DST, and takes no time", () => {
  const tomorrow = values(
    resolveDateTime(
      { when: { kind: "day_offset", days: 1 }, wholeDay: true },
      clock,
    ),
  );
  expect(tomorrow).toMatchObject({
    date: "2026-09-28",
    time: "00:00",
    iso: "2026-09-28T00:00:00+02:00",
    endIso: "2026-09-29T00:00:00+02:00",
    utc: "2026-09-27T22:00:00.000Z",
    endUtc: "2026-09-28T22:00:00.000Z",
    durationMinutes: 1440,
    wholeDay: true,
  });
  // Prague leaves summer time on 25 October 2026 and enters it on 29 March 2026.
  expect(
    values(
      resolveDateTime(
        { when: { kind: "date", date: "2026-10-25" }, wholeDay: true },
        clock,
      ),
    ).durationMinutes,
  ).toBe(1500);
  expect(
    values(
      resolveDateTime(
        { when: { kind: "date", date: "2026-03-29" }, wholeDay: true },
        clock,
      ),
    ).durationMinutes,
  ).toBe(1380);
  for (const extra of [{ time: "10:00" }, { durationMinutes: 30 }])
    expect(
      DateTimeInput.safeParse({
        when: { kind: "day_offset", days: 1 },
        wholeDay: true,
        ...extra,
      }).success,
    ).toBe(false);
  expect(
    DateTimeInput.safeParse({
      when: { kind: "elapsed", minutes: 10 },
      wholeDay: true,
    }).success,
  ).toBe(false);
});
