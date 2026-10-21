import { z } from "zod";
import { defineWidget, widgetLine, widgetText } from "./define";

const point = z.strictObject({
  label: widgetLine(60),
  value: z.number().finite(),
});

export const chartWidget = defineWidget({
  type: "chart",
  version: 1,
  fill: "ai",
  name: { cs: "Graf", en: "Chart" },
  description: {
    cs: "Sloupce, čára, plocha nebo koláč z tvých dat.",
    en: "Bars, a line, an area or a pie from your data.",
  },
  data: z.strictObject({
    /** One series; empty when `series` carries the data. */
    points: z.array(point).max(24),
    /** Several named series over the same labels; not for a pie. */
    series: z
      .array(
        z.strictObject({
          name: widgetLine(40),
          points: z.array(point).max(24),
        }),
      )
      .max(4)
      .optional(),
    /** What the values are ("Count", "EUR"). */
    valueLabel: widgetText(40).optional(),
    note: widgetText(200).optional(),
  }),
  config: z.strictObject({
    kind: z.enum(["bar", "line", "area", "pie"]),
    /** Bars or areas of several series on top of each other. */
    stacked: z.boolean(),
  }),
  defaultConfig: { kind: "bar", stacked: false },
  size: { w: 6, h: 4, minW: 3, minH: 3 },
  refresh: "daily",
  brief: {
    cs: "Otevřené obchody v CRM podle fáze (počet).",
    en: "Open deals in the CRM by stage (count).",
  },
  guide:
    "Return one series in points: each point is a category (or a period, oldest first) with its number. When the request compares several things (this year vs last year, deals per stage per owner), put them in series instead, at most 4, each with its name and the same labels in the same order, and leave points empty; a pie only reads points. Aggregate the data yourself (count, sum) as the request says. Keep at most 24 points per series; fold the smallest into one 'Other' point when there are more.",
  describeConfig: (config) =>
    config.kind === "pie"
      ? "Shown as a pie: a few categories of one whole (points only)."
      : (config.kind === "bar"
          ? "Shown as bars: categories or periods."
          : "Shown over time: periods oldest first.") +
        (config.stacked && config.kind !== "line"
          ? " Several series stack on top of each other."
          : ""),
  sample: (language) => ({
    points:
      language === "cs"
        ? [
            { label: "Nový", value: 8 },
            { label: "Kvalifikace", value: 5 },
            { label: "Nabídka", value: 4 },
            { label: "Vyjednávání", value: 2 },
          ]
        : [
            { label: "New", value: 8 },
            { label: "Qualified", value: 5 },
            { label: "Proposal", value: 4 },
            { label: "Negotiation", value: 2 },
          ],
    valueLabel: language === "cs" ? "Počet" : "Count",
  }),
});
