import type { z } from "zod";
import type { calendarWidget } from "../../../../../packages/protocol/widgets/calendar";
import { parseWhen } from "./shared";

/*
 * The calendar's arithmetic without the DOM: which days a range shows, the
 * events and tasks resolved to local times, and where each timed entry sits
 * in its day column (minutes from midnight, a lane among overlapping ones).
 */
type Data = z.infer<typeof calendarWidget.data>;
type Config = z.infer<typeof calendarWidget.config>;
export type CalendarRange = Config["range"];
/** What the person looks at; narrower or wider than the fetched range. */
export type CalendarView = "day" | "next3" | "week";
export type CalendarStatus = NonNullable<Data["events"][number]["status"]>;

export type CalendarEntry = {
  id: string;
  kind: "event" | "task";
  title: string;
  /** The data's strings, for the prepared chat request. */
  startText: string;
  endText?: string;
  start: Date;
  end: Date;
  /** An all-day event or a task due on a date. */
  allDay: boolean;
  location?: string;
  description?: string;
  organizer?: string;
  attendees?: string[];
  status?: CalendarStatus;
  join?: string;
  source?: string;
  link?: string;
  done?: boolean;
};
/** A timed entry placed in a day column. */
export type CalendarPlaced = {
  entry: CalendarEntry;
  /** Minutes from the day's midnight, clipped to the day. */
  startMin: number;
  endMin: number;
  lane: number;
  lanes: number;
};
export type CalendarDay = {
  date: Date;
  /** "2026-10-17" */
  key: string;
  today: boolean;
  allDay: CalendarEntry[];
  events: CalendarPlaced[];
  tasks: CalendarPlaced[];
};
export type CalendarLayout = {
  days: CalendarDay[];
  /** The grid's hours: the configured window, widened to hold every entry. */
  from: number;
  to: number;
};

const DAY = 24 * 60;
const pad = (value: number) => String(value).padStart(2, "0");
export const isoDate = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const startOfDay = (date: Date) => {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
};
export const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};
/** Clock minutes of `date` on `day` (0 before it, the whole day after it):
 * the grid labels clock hours, which a daylight-saving day shifts. */
const minutesOf = (date: Date, day: Date) =>
  date < day
    ? 0
    : date >= addDays(day, 1)
      ? DAY
      : date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;

/** The view a range opens on. */
export const viewOfRange = (range: CalendarRange): CalendarView =>
  range === "today" ? "day" : range === "next3" ? "next3" : "week";

/** The days shown: a view over the range, anchored on today. */
export function calendarDays(
  range: CalendarRange,
  view: CalendarView,
  now: Date,
): Date[] {
  const today = startOfDay(now);
  if (view === "day") return [today];
  if (view === "next3")
    return [0, 1, 2].map((offset) => addDays(today, offset));
  if (range === "workweek") {
    const weekday = (today.getDay() + 6) % 7;
    // Monday of this week; from Saturday on, the coming week.
    const monday = addDays(today, weekday >= 5 ? 7 - weekday : -weekday);
    return [0, 1, 2, 3, 4].map((offset) => addDays(monday, offset));
  }
  return [0, 1, 2, 3, 4, 5, 6].map((offset) => addDays(today, offset));
}

/** Events and (when configured) tasks with valid times, sorted by start. */
export function calendarEntries(data: Data, config: Config): CalendarEntry[] {
  const entries: CalendarEntry[] = [];
  data.events.forEach((event, index) => {
    const start = parseWhen(event.start);
    if (!start.valid) return;
    const allDay = event.allDay === true || start.dateOnly;
    const end = event.end ? parseWhen(event.end) : null;
    let endDate =
      end?.valid && end.date.getTime() > start.date.getTime()
        ? end.date
        : new Date(start.date.getTime() + 30 * 60000);
    // iCal style: a date-only end of an all-day event is exclusive.
    if (allDay && end?.valid && end.dateOnly && end.date > start.date)
      endDate = addDays(end.date, -1);
    entries.push({
      id: `e${index}`,
      kind: "event",
      title: event.title,
      startText: event.start,
      endText: event.end,
      start: start.date,
      end: endDate,
      allDay,
      location: event.location,
      description: event.description,
      organizer: event.organizer,
      attendees: event.attendees,
      status: event.status,
      join: event.join,
      source: event.source,
      link: event.link,
    });
  });
  if (config.tasks)
    data.tasks.forEach((task, index) => {
      const due = parseWhen(task.due);
      if (!due.valid) return;
      entries.push({
        id: `t${index}`,
        kind: "task",
        title: task.title,
        startText: task.due,
        start: due.date,
        end: due.date,
        allDay: due.dateOnly,
        description: task.detail,
        source: task.source,
        link: task.link,
        done: task.done,
      });
    });
  return entries.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Overlapping entries share the column: each gets a lane, the cluster its width. */
function assignLanes(placed: CalendarPlaced[]) {
  const sorted = [...placed].sort(
    (a, b) =>
      a.startMin - b.startMin ||
      b.endMin - a.endMin ||
      a.entry.title.localeCompare(b.entry.title),
  );
  let cluster: CalendarPlaced[] = [];
  let laneEnds: number[] = [];
  const close = () => {
    for (const item of cluster) item.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };
  for (const item of sorted) {
    if (cluster.length && item.startMin >= Math.max(...laneEnds)) close();
    let lane = laneEnds.findIndex((end) => end <= item.startMin);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = item.endMin;
    item.lane = lane;
    cluster.push(item);
  }
  close();
  return sorted;
}

const place = (entry: CalendarEntry, day: Date): CalendarPlaced | null => {
  const dayEnd = addDays(day, 1);
  if (entry.end <= day || entry.start >= dayEnd) return null;
  const startMin = Math.max(0, minutesOf(entry.start, day));
  const endMin = Math.min(DAY, minutesOf(entry.end, day));
  return {
    entry,
    startMin,
    endMin: Math.max(endMin, Math.min(DAY, startMin + 15)),
    lane: 0,
    lanes: 1,
  };
};

/** Every shown day with its entries placed; the grid widened to hold them. */
export function layoutDays(
  entries: CalendarEntry[],
  days: Date[],
  window: { from: number; to: number },
  now: Date,
): CalendarLayout {
  const todayKey = isoDate(now);
  let from = Math.max(0, Math.min(23, window.from));
  let to = Math.min(24, Math.max(from + 1, window.to));
  const laid = days.map((date): CalendarDay => {
    const key = isoDate(date);
    const allDay: CalendarEntry[] = [];
    const events: CalendarPlaced[] = [];
    const tasks: CalendarPlaced[] = [];
    for (const entry of entries) {
      if (entry.allDay) {
        if (startOfDay(entry.start) <= date && date <= startOfDay(entry.end))
          allDay.push(entry);
        continue;
      }
      const placed = place(entry, date);
      if (!placed) continue;
      (entry.kind === "task" ? tasks : events).push(placed);
      from = Math.min(from, Math.floor(placed.startMin / 60));
      to = Math.max(to, Math.ceil(placed.endMin / 60));
    }
    return {
      date,
      key,
      today: key === todayKey,
      allDay,
      events: assignLanes(events),
      tasks,
    };
  });
  return { days: laid, from, to };
}

/** Where a minute of the day sits in the grid, as a percentage of its height. */
export const gridPercent = (minute: number, layout: CalendarLayout) =>
  ((minute - layout.from * 60) / ((layout.to - layout.from) * 60)) * 100;

/**
 * The hour the grid opens on: the start of the working hours, or earlier
 * when an entry of a shown day starts before them, so nothing sits above the
 * fold. The grid itself runs the whole day; this is only where it scrolls to.
 */
export function openingHour(layout: CalendarLayout, workStart: number): number {
  const first = Math.min(
    ...layout.days.flatMap((day) =>
      [...day.events, ...day.tasks].map((placed) => placed.startMin),
    ),
  );
  const firstHour = Number.isFinite(first) ? Math.floor(first / 60) : null;
  const start = Math.max(layout.from, Math.min(layout.to - 1, workStart));
  return firstHour === null ? start : Math.min(firstHour, start);
}

export const minutesSinceMidnight = (date: Date) =>
  minutesOf(date, startOfDay(date));
