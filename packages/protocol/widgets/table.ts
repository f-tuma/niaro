import { z } from "zod";
import {
  defineWidget,
  widgetCount,
  widgetLine,
  widgetLink,
  widgetText,
} from "./define";

const cell = z.union([widgetText(200), z.number().finite(), z.null()]);

export const tableWidget = defineWidget({
  type: "table",
  version: 1,
  fill: "ai",
  name: { cs: "Tabulka", en: "Table" },
  description: {
    cs: "Řádky a sloupce, které si popíšeš.",
    en: "Rows and the columns you describe.",
  },
  data: z
    .strictObject({
      columns: z.array(widgetLine(60)).min(1).max(6),
      rows: z.array(z.array(cell).max(6)).max(20),
      /** One web link per row, in row order; null for a row without one. */
      rowLinks: z.array(widgetLink.nullable()).max(20).optional(),
    })
    .refine(
      (data) => data.rows.every((row) => row.length <= data.columns.length),
      {
        message: "row_wider_than_columns",
      },
    ),
  config: z.strictObject({ count: widgetCount(20) }),
  defaultConfig: { count: 10 },
  size: { w: 6, h: 4, minW: 4, minH: 3 },
  refresh: "daily",
  brief: {
    cs: "Největší otevřené obchody: název, firma, fáze a hodnota.",
    en: "The largest open deals: name, company, stage and value.",
  },
  guide:
    "columns are short headers (at most 6); each row has one cell per column in the same order: text, a number (no units or thousands separators) or null. Numbers stay numbers so the person can sort them. rowLinks, when the data has web links, holds one link per row in row order (null where a row has none).",
  describeConfig: (config) => `At most ${config.count} rows.`,
  sample: (language) => ({
    columns:
      language === "cs"
        ? ["Obchod", "Fáze", "Hodnota"]
        : ["Deal", "Stage", "Value"],
    rows: [
      ["ERP", language === "cs" ? "Nabídka" : "Proposal", 480000],
      ["Web", language === "cs" ? "Jednání" : "Talks", 220000],
    ],
    rowLinks: ["https://crm.example/deals/1", null],
  }),
});
