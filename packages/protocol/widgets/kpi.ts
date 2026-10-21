import { z } from "zod";
import { defineWidget, widgetDateTime, widgetLine, widgetText } from "./define";

export const kpiWidget = defineWidget({
  type: "kpi",
  version: 1,
  fill: "ai",
  name: { cs: "Ukazatel", en: "KPI" },
  description: {
    cs: "Jedno číslo, jeho změna a krátký vývoj.",
    en: "One number, its change and a short trend.",
  },
  data: z.strictObject({
    value: z.number().finite().nullable(),
    label: widgetLine(80),
    unit: widgetText(16).optional(),
    /** The change against the comparison period, in the value's unit. */
    delta: z.number().finite().optional(),
    /** What the change compares with ("since last week"). */
    deltaLabel: widgetText(60).optional(),
    /** A short history, oldest first, ending with the value. */
    points: z.array(z.number().finite()).max(30).optional(),
    /** The goal the value is measured against, in the value's unit. */
    target: z.number().finite().optional(),
    /** When the value was true ("2026-10-17"), when the data says. */
    asOf: widgetDateTime.optional(),
    note: widgetText(200).optional(),
  }),
  config: z.strictObject({
    unit: widgetText(16),
    /** Higher is better (green when it grows) or lower is better. */
    goal: z.enum(["up", "down"]),
  }),
  defaultConfig: { unit: "", goal: "up" },
  size: { w: 3, h: 2, minW: 2, minH: 2 },
  refresh: "daily",
  brief: {
    cs: "Počet otevřených obchodů v CRM a změna oproti minulému týdnu.",
    en: "The number of open deals in the CRM and the change since last week.",
  },
  guide:
    "Compute exactly one number from the data. label names it in a few words. When the data allows a comparison, delta is the change and deltaLabel says against what; points is a short history ending with the value; target is the goal when the request or the data names one; asOf is the date the value is from. If the number cannot be computed from the data, value is null and note says why.",
  describeConfig: (config) =>
    (config.unit ? `Unit: ${config.unit}. ` : "") +
    (config.goal === "up" ? "Higher is better." : "Lower is better."),
  sample: (language) => ({
    value: 42,
    label: language === "cs" ? "Otevřené obchody" : "Open deals",
    delta: 5,
    deltaLabel: language === "cs" ? "oproti minulému týdnu" : "since last week",
    points: [30, 33, 35, 34, 37, 40, 42],
    target: 50,
  }),
});
