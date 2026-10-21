import { z } from "zod";
import type { HubLocalized, HubWidgetDefinition } from "./define";
import { approvalsWidget } from "./approvals";
import { briefingWidget } from "./briefing";
import { calendarWidget } from "./calendar";
import { chartWidget } from "./chart";
import { followupsWidget } from "./followups";
import { inboxWidget } from "./inbox";
import { kpiWidget } from "./kpi";
import { listWidget } from "./list";
import { meetingsWidget } from "./meetings";
import { tableWidget } from "./table";

export type {
  HubLocalized,
  HubWidgetDefinition,
  HubWidgetFill,
  HubWidgetSize,
} from "./define";

/**
 * The overview's widget types, in the order the gallery offers them. A type
 * is one module in this folder (schema, config, size, brief, sample) and one
 * renderer in the web app; the server, the agent tools and the gallery read
 * everything else from here.
 */
export const HUB_WIDGET_TYPES = [
  calendarWidget,
  inboxWidget,
  briefingWidget,
  kpiWidget,
  chartWidget,
  followupsWidget,
  listWidget,
  tableWidget,
  approvalsWidget,
  meetingsWidget,
] as const satisfies readonly HubWidgetDefinition[];
export type HubWidgetTypeName = (typeof HUB_WIDGET_TYPES)[number]["type"];
export const HubWidgetTypeNameSchema = z.enum(
  HUB_WIDGET_TYPES.map((definition) => definition.type) as [
    HubWidgetTypeName,
    ...HubWidgetTypeName[],
  ],
);
const byType = new Map<string, HubWidgetDefinition>(
  HUB_WIDGET_TYPES.map((definition) => [definition.type, definition]),
);
/** The type's definition, or undefined for a type this build doesn't know. */
export function hubWidgetDefinition(
  type: string,
): HubWidgetDefinition | undefined {
  return byType.get(type);
}

/** The person's settings for a type: unknown keys dropped, missing ones defaulted. */
export function hubWidgetConfig(
  type: string,
  raw: unknown,
): Record<string, unknown> | null {
  const definition = byType.get(type);
  if (!definition) return null;
  const base = definition.defaultConfig as Record<string, unknown>;
  const given =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).filter(([key]) => key in base))
      : {};
  const parsed = definition.config.safeParse({ ...base, ...given });
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}
/** The type's data, checked against its schema; null when it doesn't fit. */
export function hubWidgetData(type: string, raw: unknown): unknown {
  const definition = byType.get(type);
  if (!definition) return null;
  const parsed = definition.data.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
/** The data schema as JSON Schema, for the fill agent's instructions. */
export function hubWidgetJsonSchema(type: string) {
  const definition = byType.get(type);
  return definition
    ? (z.toJSONSchema(definition.data, { unrepresentable: "any" }) as Record<
        string,
        unknown
      >)
    : null;
}

/** Ready-made requests in the gallery: a type, its brief and config. */
export type HubWidgetPreset = {
  id: string;
  type: HubWidgetTypeName;
  name: HubLocalized;
  description: HubLocalized;
  brief: HubLocalized;
  config: Record<string, unknown>;
};
export const HUB_WIDGET_PRESETS: readonly HubWidgetPreset[] = [
  {
    id: "pipeline",
    type: "chart",
    name: { cs: "Obchodní pipeline", en: "Sales pipeline" },
    description: {
      cs: "Otevřené obchody podle fáze.",
      en: "Open deals by stage.",
    },
    brief: {
      cs: "Otevřené obchody v CRM podle fáze: počet obchodů v každé fázi, v pořadí fází.",
      en: "Open deals in the CRM by stage: the number of deals in each stage, in stage order.",
    },
    config: { kind: "bar" },
  },
  {
    id: "week",
    type: "calendar",
    name: { cs: "Můj týden", en: "My week" },
    description: {
      cs: "Schůzky a termíny na sedm dní dopředu.",
      en: "Meetings and deadlines for the next seven days.",
    },
    brief: {
      cs: "Moje schůzky a úkoly s termínem na celý týden.",
      en: "My meetings and tasks with a due date for the whole week.",
    },
    config: { range: "week", tasks: true, dayStart: 7, dayEnd: 19 },
  },
];
