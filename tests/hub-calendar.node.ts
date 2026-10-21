import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarWidget } from "../packages/protocol/widgets/calendar";
import {
  hubWidgetConfig,
  hubWidgetJsonSchema,
} from "../packages/protocol/widgets";

/*
 * The calendar widget's second schema: a day grid's events with the person's
 * response, an organizer, a meeting link and a text, bounded for the fill
 * agent's structured output.
 */
const event = { title: "TEST", start: "2026-10-17T09:00:00+02:00" };
const parse = (events: unknown[], tasks: unknown[] = []) =>
  calendarWidget.data.safeParse({ events, tasks });

test("calendar/2: both samples fit, with a response, an organizer, a meeting link and an all-day event", () => {
  assert.equal(calendarWidget.version, 2);
  for (const language of ["cs", "en"] as const) {
    const sample = calendarWidget.data.parse(calendarWidget.sample(language));
    assert.ok(sample.events.some((item) => item.allDay));
    assert.ok(sample.events.some((item) => item.status === "tentative"));
    assert.ok(sample.events.some((item) => item.join && item.organizer));
    assert.equal(sample.tasks.length, 1);
  }
  const full = parse([
    {
      ...event,
      end: "2026-10-17T09:30:00+02:00",
      description: "Agenda:\n- prices\n- dates",
      organizer: "Jana",
      attendees: ["Jana", "Petr"],
      status: "accepted",
      join: "https://teams.microsoft.com/l/meetup-join/x",
      link: "https://calendar.example/e/1",
    },
  ]);
  assert.ok(full.success);
  assert.ok(
    parse([], [{ title: "TEST", due: "2026-10-17", detail: "one line" }])
      .success,
  );
});

test("calendar/2 refuses app links, unknown responses, extra keys and too many items", () => {
  for (const join of ["javascript:alert(1)", "data:text/html,x", "msteams:x"])
    assert.equal(parse([{ ...event, join }]).success, false, join);
  assert.equal(parse([{ ...event, status: "maybe" }]).success, false);
  assert.equal(parse([{ ...event, color: "red" }]).success, false);
  assert.equal(
    parse([{ ...event, attendees: Array.from({ length: 11 }, () => "A") }])
      .success,
    false,
  );
  assert.equal(
    parse([{ ...event, description: "x".repeat(501) }]).success,
    false,
  );
  assert.ok(parse(Array.from({ length: 60 }, () => event)).success);
  assert.equal(parse(Array.from({ length: 61 }, () => event)).success, false);
  assert.equal(
    parse(
      [],
      Array.from({ length: 31 }, () => ({ title: "T", due: "2026-10-17" })),
    ).success,
    false,
  );
});

test("calendar/2 config: a range with a workweek and an hour window, defaulted and bounded", () => {
  assert.deepEqual(calendarWidget.defaultConfig, {
    range: "today",
    tasks: true,
    dayStart: 7,
    dayEnd: 19,
  });
  assert.deepEqual(hubWidgetConfig("calendar", { range: "workweek" }), {
    range: "workweek",
    tasks: true,
    dayStart: 7,
    dayEnd: 19,
  });
  // The first schema's cap is dropped, not refused.
  assert.deepEqual(hubWidgetConfig("calendar", { count: 12, dayStart: 8 }), {
    range: "today",
    tasks: true,
    dayStart: 8,
    dayEnd: 19,
  });
  assert.equal(hubWidgetConfig("calendar", { dayEnd: 25 }), null);
  assert.equal(hubWidgetConfig("calendar", { dayStart: 7.5 }), null);
  const words = calendarWidget.describeConfig!({
    range: "workweek",
    tasks: false,
    dayStart: 8,
    dayEnd: 18,
  });
  assert.match(words, /Monday to Friday/);
  assert.match(words, /tasks stays empty/);
  assert.match(words, /8:00 to 18:00/);
});

test("calendar/2 as JSON Schema: every list and string is bounded", () => {
  const schema = hubWidgetJsonSchema("calendar")!;
  assert.equal(schema.type, "object");
  const unbounded: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    const value = node as Record<string, unknown>;
    if (value.type === "array" && typeof value.maxItems !== "number")
      unbounded.push(path);
    if (
      value.type === "string" &&
      !value.maxLength &&
      !value.pattern &&
      !value.enum
    )
      unbounded.push(path);
    for (const [key, child] of Object.entries(value))
      walk(child, `${path}.${key}`);
  };
  walk(schema, "calendar");
  assert.deepEqual(unbounded, []);
  const events = (schema.properties as Record<string, any>).events;
  assert.equal(events.maxItems, 60);
  assert.deepEqual(events.items.properties.status.enum, [
    "accepted",
    "tentative",
    "none",
    "declined",
  ]);
  assert.equal(events.items.properties.join.maxLength, 500);
});
