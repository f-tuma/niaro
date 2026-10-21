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
          summary:
            "Dnes máš dvě schůzky a jednu nabídku k odeslání. Jana čeká na potvrzení ceny.",
          highlights: [
            { text: "Potvrdit cenu Janě do pátku", source: "E-mail" },
            { text: "Ve 12:00 oběd s klientem", source: "Kalendář" },
          ],
        }
      : {
          summary:
            "Two meetings today and one proposal to send. Jane waits for a price confirmation.",
          highlights: [
            { text: "Confirm the price to Jane by Friday", source: "Email" },
            { text: "Lunch with a client at 12:00", source: "Calendar" },
          ],
        },
});
