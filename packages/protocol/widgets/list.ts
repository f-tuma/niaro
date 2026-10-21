import { z } from "zod";
import {
  defineWidget,
  widgetCount,
  widgetLine,
  widgetLink,
  widgetSource,
  widgetText,
} from "./define";

export const listWidget = defineWidget({
  type: "list",
  version: 1,
  fill: "ai",
  name: { cs: "Seznam", en: "List" },
  description: {
    cs: "Krátký seznam čehokoli z tvých služeb.",
    en: "A short list of anything from your services.",
  },
  data: z.strictObject({
    items: z
      .array(
        z.strictObject({
          title: widgetLine(200),
          detail: widgetText(300).optional(),
          /** A short tag on the right: a date, an amount, a state. */
          meta: widgetText(60).optional(),
          source: widgetSource.optional(),
          link: widgetLink.optional(),
        }),
      )
      .max(20),
  }),
  config: z.strictObject({ count: widgetCount(20) }),
  defaultConfig: { count: 8 },
  size: { w: 4, h: 4, minW: 3, minH: 2 },
  refresh: "daily",
  brief: {
    cs: "Firmy, se kterými jsme tento týden poprvé mluvili.",
    en: "Companies we talked to for the first time this week.",
  },
  guide:
    "One row per thing the request asks for: title names it, detail adds one useful line, meta a short tag (date, amount, state).",
  describeConfig: (config) => `At most ${config.count} rows.`,
  sample: (language) => ({
    items:
      language === "cs"
        ? [
            { title: "Acme s.r.o.", detail: "Poptávka školení", meta: "Po" },
            { title: "Beta a.s.", detail: "Doporučení od Jany", meta: "Út" },
            { title: "Gama spol.", detail: "Webinář", meta: "St" },
          ]
        : [
            { title: "Acme Ltd", detail: "Asked about training", meta: "Mon" },
            { title: "Beta Inc", detail: "Referred by Jane", meta: "Tue" },
            { title: "Gamma Co", detail: "Webinar", meta: "Wed" },
          ],
  }),
});
