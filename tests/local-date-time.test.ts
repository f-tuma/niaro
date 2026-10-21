import { execFileSync } from "node:child_process";
import {
  localDateTime,
  localDateTimeToIso,
} from "../packages/ui/local-date-time";

test("local fields round-trip an instant and preserve an unchanged offset/seconds", () => {
  for (const original of [
    "2026-01-01T00:15:00.000Z",
    "2026-09-27T12:00:00.000Z",
    "2026-10-25T01:30:27.000Z",
  ]) {
    const draft = localDateTime(original);
    expect(localDateTimeToIso(draft.date, draft.time, original)).toBe(original);
  }
  expect(localDateTimeToIso("2026-09-27", "15:30")).toBe(
    new Date(2026, 8, 27, 15, 30).toISOString(),
  );
});
test.each([
  ["2026-02-30", "12:00"],
  ["2026-09-27", "24:00"],
  ["2026-09-27", "12:60"],
  ["", "12:00"],
  ["2026-09-27", ""],
  ["2026-2-1", "12:00"],
])("invalid local input %s %s cannot become an instant", (date, time) => {
  expect(localDateTimeToIso(date, time)).toBeNull();
});

test.each([
  [
    "Europe/Prague",
    "2026-09-27T12:00:00.000Z",
    "2026-03-29",
    "2026-10-25T01:30:00.000Z",
  ],
  [
    "America/New_York",
    "2026-09-27T18:00:00.000Z",
    "2026-03-08",
    "2026-11-01T06:30:00.000Z",
  ],
  [
    "Asia/Kathmandu",
    "2026-09-27T08:15:00.000Z",
    null,
    "2026-10-25T01:30:00.000Z",
  ],
])(
  "device zone %s is respected, gaps rejected and an unchanged fold preserved",
  (zone, expected, gap, original) => {
    // Node processes model different device zones without mutating the Jest worker's timezone.
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
    import { localDateTime, localDateTimeToIso } from './packages/ui/local-date-time.ts';
    const original = ${JSON.stringify(original)};
    const draft = localDateTime(original);
    console.log(JSON.stringify({
      selected: localDateTimeToIso('2026-09-27', '14:00'),
      gap: ${gap ? `localDateTimeToIso('${gap}', '02:30')` : "null"},
      preserved: localDateTimeToIso(draft.date, draft.time, original),
    }));
  `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, TZ: zone },
        encoding: "utf8",
      },
    );
    expect(JSON.parse(output)).toEqual({
      selected: expected,
      gap: null,
      preserved: original,
    });
  },
);
