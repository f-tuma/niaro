import { z } from "zod";
import {
  defineWidget,
  widgetCount,
  widgetDateTime,
  widgetLine,
  widgetLink,
  widgetSource,
  widgetText,
} from "./define";

export const followupsWidget = defineWidget({
  type: "followups",
  version: 1,
  fill: "ai",
  name: { cs: "Ozvat se", en: "Follow-ups" },
  description: {
    cs: "Komu se ozvat a proč – lidé a obchody, které čekají.",
    en: "Who to follow up with and why: people and deals that wait.",
  },
  data: z.strictObject({
    items: z
      .array(
        z.strictObject({
          who: widgetLine(120),
          /** Why now, in one line. */
          reason: widgetText(300),
          lastContact: widgetDateTime.optional(),
          priority: z.enum(["high", "normal"]).optional(),
          source: widgetSource.optional(),
          link: widgetLink.optional(),
        }),
      )
      .max(12),
  }),
  config: z.strictObject({ count: widgetCount(12) }),
  defaultConfig: { count: 6 },
  size: { w: 4, h: 4, minW: 3, minH: 3 },
  refresh: "daily",
  brief: {
    cs: "Lidé a obchody, kterým bych se měl ozvat, a proč (dlouho bez kontaktu, nevyřízená nabídka…).",
    en: "People and deals I should follow up with, and why (no contact for a while, an open proposal…).",
  },
  guide:
    "who is a person or a deal with its company; reason says in one line why to follow up now; lastContact when the data has it; priority high for what waits on the person.",
  describeConfig: (config) =>
    `At most ${config.count} people or deals, most urgent first.`,
  sample: (language) =>
    language === "cs"
      ? {
          items: [
            {
              who: "Jana Nováková (Acme)",
              reason: "Nabídka bez odpovědi 10 dní",
              priority: "high" as const,
            },
            { who: "Petr Svoboda", reason: "Slíbil podklady do konce týdne" },
          ],
        }
      : {
          items: [
            {
              who: "Jane Smith (Acme)",
              reason: "Proposal without an answer for 10 days",
              priority: "high" as const,
            },
            { who: "Peter Brown", reason: "Promised documents by Friday" },
          ],
        },
});
