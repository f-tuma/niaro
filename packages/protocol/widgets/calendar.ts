import { z } from "zod";
import {
  defineWidget,
  widgetDateTime,
  widgetLine,
  widgetLink,
  widgetSource,
  widgetText,
} from "./define";

const range = z.enum(["today", "next3", "week", "workweek"]);
/** The person's own answer to the invitation. */
const status = z.enum(["accepted", "tentative", "none", "declined"]);
const hour = z.number().int().min(0).max(24);
/** Today's date at a local time, as an ISO date-time without an offset. */
const at = (days: number, hour: number, minute = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, minute, 0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(hour)}:${pad(minute)}:00`;
};
const day = (days: number) => at(days, 0).slice(0, 10);

export const calendarWidget = defineWidget({
  type: "calendar",
  version: 2,
  fill: "ai",
  name: { cs: "Kalendář", en: "Calendar" },
  description: {
    cs: "Dny a hodiny se schůzkami a termíny, na dnes nebo na týden.",
    en: "Days and hours with meetings and deadlines, for today or the week.",
  },
  data: z.strictObject({
    events: z
      .array(
        z.strictObject({
          title: widgetLine(200),
          start: widgetDateTime,
          end: widgetDateTime.optional(),
          allDay: z.boolean().optional(),
          location: widgetText(200).optional(),
          /** The invitation's text as plain text, shortened to what matters. */
          description: widgetText(500).optional(),
          organizer: widgetLine(120).optional(),
          attendees: z.array(widgetLine(120)).max(10).optional(),
          status: status.optional(),
          /** The online meeting (Teams, Meet, Zoom), when the event has one. */
          join: widgetLink.optional(),
          source: widgetSource.optional(),
          link: widgetLink.optional(),
        }),
      )
      .max(60),
    /** Tasks with a due date or time, shown in the days between the events. */
    tasks: z
      .array(
        z.strictObject({
          title: widgetLine(200),
          due: widgetDateTime,
          done: z.boolean().optional(),
          detail: widgetText(300).optional(),
          source: widgetSource.optional(),
          link: widgetLink.optional(),
        }),
      )
      .max(30),
  }),
  config: z.strictObject({
    range,
    /** Tasks with a due time between the events. */
    tasks: z.boolean(),
    /** The hour window the grid opens on; events outside it still show. */
    dayStart: hour,
    dayEnd: hour,
  }),
  defaultConfig: { range: "today", tasks: true, dayStart: 7, dayEnd: 19 },
  size: { w: 6, h: 5, minW: 3, minH: 3 },
  refresh: "hourly",
  brief: {
    cs: "Moje schůzky z kalendáře a úkoly s termínem.",
    en: "My meetings from the calendar and my tasks with a due date.",
  },
  guide:
    "Collect calendar events in the range and, when asked, tasks with a due date or time. Use ISO 8601 date-times with the offset of the person's time zone; an all-day event has allDay true and a date start (and a date end only when it spans days). Sort by start. Keep titles as the source has them. status is the person's own response to the invitation (accepted, tentative, declined; none when they have not answered); organizer is the organizer's name; description is the invitation's text as plain text, shortened to the essentials. Put the online meeting link (Teams, Meet, Zoom) in join and the event's web page in link, each only when the data has one. A task's due is a date or a date-time; detail is one short note.",
  describeConfig: (config) =>
    [
      config.range === "today"
        ? "Range: today."
        : config.range === "next3"
          ? "Range: today and the next two days."
          : config.range === "week"
            ? "Range: the next seven days from today."
            : "Range: Monday to Friday of this week (the coming week on a weekend).",
      config.tasks
        ? "Include tasks with a due date in the range."
        : "Events only; tasks stays empty.",
      `Working hours ${config.dayStart}:00 to ${config.dayEnd}:00; include every event of the day, outside them too.`,
    ].join(" "),
  sample: (language) => ({
    events: [
      {
        title: language === "cs" ? "Porada týmu" : "Team meeting",
        start: at(0, 9),
        end: at(0, 10),
        location: language === "cs" ? "Zasedačka" : "Meeting room",
        organizer: "Jana Nováková",
        attendees: ["Jana Nováková", "Petr Svoboda"],
        status: "accepted" as const,
        join: "https://teams.microsoft.com/l/meetup-join/sample",
      },
      {
        title: language === "cs" ? "Volání s dodavatelem" : "Supplier call",
        start: at(0, 10, 30),
        end: at(0, 11, 30),
        status: "tentative" as const,
      },
      {
        title: language === "cs" ? "Oběd s klientem" : "Lunch with a client",
        start: at(0, 12),
        end: at(0, 13),
        location: language === "cs" ? "Café Savoy" : "Café Savoy",
        status: "accepted" as const,
      },
      {
        title: language === "cs" ? "Prezentace nabídky" : "Proposal review",
        start: at(1, 14),
        end: at(1, 15),
        organizer: "Petr Svoboda",
        status: "none" as const,
      },
      {
        title: language === "cs" ? "Veletrh" : "Trade fair",
        start: day(2),
        allDay: true,
      },
    ],
    tasks: [
      {
        title: language === "cs" ? "Poslat nabídku" : "Send the proposal",
        due: at(0, 16),
      },
    ],
  }),
});
