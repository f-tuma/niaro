import { z } from "zod";
import {
  defineWidget,
  widgetLine,
  widgetLink,
  widgetSource,
  widgetText,
} from "./define";

export const briefingWidget = defineWidget({
  type: "briefing",
  version: 1,
  fill: "ai",
  name: { cs: "Shrnutí", en: "Briefing" },
  description: {
    cs: "Krátké shrnutí od asistenta s tím hlavním.",
    en: "A short summary from the assistant with the highlights.",
  },
  data: z.strictObject({
    /** A few sentences of Markdown. */
    summary: widgetText(1500),
    highlights: z
      .array(
        z.strictObject({
          text: widgetLine(300),
          source: widgetSource.optional(),
          link: widgetLink.optional(),
        }),
      )
      .max(8),
  }),
  config: z.strictObject({ length: z.enum(["short", "normal"]) }),
  defaultConfig: { length: "short" },
  size: { w: 6, h: 3, minW: 3, minH: 2 },
  refresh: "daily",
  brief: {
    cs: "Krátké shrnutí mého dne: co mě čeká, co hoří a na co nezapomenout.",
    en: "A short summary of my day: what's ahead, what's urgent and what not to forget.",
  },
  guide:
    "summary is plain prose in the person's language, based only on the collected data; highlights are the few things worth acting on, each with the service it came from.",
  describeConfig: (config) =>
    config.length === "short"
      ? "Two or three sentences and at most four highlights."
      : "One short paragraph and at most eight highlights.",
  sample: (language) =>
    language === "cs"
      ? {
          summary: "Dvě schůzky a jedna nabídka k odeslání.",
          highlights: [
            { text: "Potvrdit cenu Janě", source: "E-mail" },
            { text: "Oběd s klientem ve 12", source: "Kalendář" },
          ],
        }
      : {
          summary: "Two meetings and one proposal to send today.",
          highlights: [
            { text: "Confirm Jane's price", source: "Email" },
            { text: "Client lunch at 12:00", source: "Calendar" },
          ],
        },
});
