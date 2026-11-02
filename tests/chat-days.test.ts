import {
  dayLabel,
  groupChatsByDay,
  messageDays,
  startOfDay,
} from "../packages/client-core/chat-days";

// Days are local calendar days; jest.config.js runs in Europe/Prague, which has
// both daylight-saving changes.

const labels = {
  today: "Today",
  yesterday: "Yesterday",
  lastWeek: "Previous 7 days",
};
const chat = (id: string, local: string) => ({
  id,
  updatedAt: new Date(local).toISOString(),
});
const groups = (
  rows: ReturnType<typeof chat>[],
  now: string,
  language: "en" | "cs" = "en",
) =>
  groupChatsByDay(rows, language, labels, new Date(now)).map((group) => [
    group.label,
    group.conversations.map((row) => row.id),
  ]);

test("the time zone of these tests has daylight saving", () => {
  // 25 October 2026 is 25 hours long in Prague.
  expect(
    startOfDay(new Date("2026-10-26T12:00:00")) -
      startOfDay(new Date("2026-10-25T12:00:00")),
  ).toBe(25 * 3_600_000);
});

test("a chat from the long autumn night is still yesterday", () => {
  // 24.5 real hours before midnight, but the day before.
  expect(
    groups(
      [chat("a", "2026-10-26T08:00:00"), chat("b", "2026-10-25T00:30:00")],
      "2026-10-26T10:00:00",
    ),
  ).toEqual([
    ["Today", ["a"]],
    ["Yesterday", ["b"]],
  ]);
});

test("the short spring night does not move a chat into the previous week", () => {
  expect(
    groups(
      [
        chat("yesterday", "2026-03-29T23:30:00"),
        chat("week", "2026-03-23T00:30:00"),
        chat("march", "2026-03-22T23:30:00"),
      ],
      "2026-03-30T09:00:00",
    ),
  ).toEqual([
    ["Yesterday", ["yesterday"]],
    ["Previous 7 days", ["week"]],
    ["March", ["march"]],
  ]);
});

test("Czech months start with a capital and name the year when it differs", () => {
  expect(
    groups(
      [
        chat("september", "2026-09-10T12:00:00"),
        chat("august", "2026-08-01T12:00:00"),
        chat("old", "2025-11-10T12:00:00"),
      ],
      "2026-11-02T10:00:00",
      "cs",
    ),
  ).toEqual([
    ["Září", ["september"]],
    ["Srpen", ["august"]],
    ["Listopad 2025", ["old"]],
  ]);
});

test("a chat's dividers follow calendar days across a daylight-saving change", () => {
  const now = new Date("2026-10-26T10:00:00");
  const days = messageDays(
    [
      { createdAt: new Date("2026-10-24T23:00:00").toISOString() },
      { createdAt: new Date("2026-10-24T23:50:00").toISOString() },
      { createdAt: new Date("2026-10-25T23:30:00").toISOString() },
      {},
      { createdAt: new Date("2026-10-26T09:00:00").toISOString() },
    ],
    now,
  );
  expect(days).toEqual([
    startOfDay(new Date("2026-10-24T12:00:00")),
    undefined,
    startOfDay(new Date("2026-10-25T12:00:00")),
    undefined,
    startOfDay(now),
  ]);
  expect(dayLabel(days[2]!, "en", labels, now)).toBe("Yesterday");
  expect(dayLabel(days[4]!, "en", labels, now)).toBe("Today");
});

test("messages of today alone start no divider", () => {
  const now = new Date("2026-11-02T15:00:00");
  expect(
    messageDays(
      [{ createdAt: new Date("2026-11-02T09:00:00").toISOString() }],
      now,
    ),
  ).toEqual([undefined]);
});

test("an older divider names the weekday and the day in Czech", () => {
  const now = new Date("2026-11-02T10:00:00");
  const label = dayLabel(
    startOfDay(new Date("2026-10-27T12:00:00")),
    "cs",
    labels,
    now,
  );
  expect(label).toMatch(/úterý/);
  expect(label).toMatch(/27\. října/);
  expect(
    dayLabel(startOfDay(new Date("2025-12-24T12:00:00")), "en", labels, now),
  ).toMatch(/2025/);
});
