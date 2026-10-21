import { z } from "zod";
import {
  defineWidget,
  widgetCount,
  widgetDateTime,
  widgetLine,
  widgetText,
} from "./define";

/** Recent recorded meetings with their summary and open items; from the
 * server's meeting records, no AI. */
export const meetingsWidget = defineWidget({
  type: "meetings",
  // 2: each meeting's next open item (`next`).
  version: 2,
  fill: "server",
  name: { cs: "Schůzky", en: "Meetings" },
  description: {
    cs: "Poslední nahrané schůzky se shrnutím a úkoly.",
    en: "Recent recorded meetings with their summary and tasks.",
  },
  data: z.strictObject({
    meetings: z
      .array(
        z.strictObject({
          id: z.string().uuid(),
          title: widgetLine(160),
          recordedAt: widgetDateTime,
          status: z.enum(["ready", "processing", "failed"]),
          summary: widgetText(400).optional(),
          /** The meeting's items still open in Tasks. */
          tasks: z.number().int().min(0).max(80),
          /** The first open item: what to do next. */
          next: widgetLine(160).optional(),
        }),
      )
      .max(8),
  }),
  config: z.strictObject({ count: widgetCount(8) }),
  defaultConfig: { count: 4 },
  size: { w: 4, h: 4, minW: 3, minH: 3 },
  refresh: "on_open",
  sample: (language) => ({
    meetings: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        title: language === "cs" ? "Porada obchodu" : "Sales sync",
        recordedAt: new Date(Date.now() - 86_400_000).toISOString(),
        status: "ready" as const,
        summary:
          language === "cs"
            ? "Domluvili jsme ceník a termín dodání."
            : "Agreed on the price list and delivery date.",
        tasks: 2,
        next:
          language === "cs"
            ? "Poslat upravený ceník"
            : "Send the updated price list",
      },
    ],
  }),
});
