import { z } from "zod";

/**
 * One widget type of the overview: what it shows (its data schema, which is
 * also the structured output the AI fill must produce), what the person can
 * set (its config), its size on the grid, the default request ("brief") the
 * AI fill starts from and sample data for the gallery. Adding a widget type
 * is one module here plus one renderer in the web app.
 */
export type HubLocalized = { cs: string; en: string };
export type HubWidgetSize = {
  w: number;
  h: number;
  minW: number;
  minH: number;
};
/** How a widget gets its data: an AI run over the person's read actions, the
 * server's own data (no AI) or data the app already has (no AI). */
export type HubWidgetFill = "ai" | "server" | "client";
export type HubWidgetRefreshDefault = "manual" | "hourly" | "daily" | "on_open";

export type HubWidgetDefinition<
  D extends z.ZodType = z.ZodType,
  C extends z.ZodType = z.ZodType,
> = {
  /** Registry key: lowercase letters, digits and underscores. */
  type: string;
  /** Bumped when the data schema changes incompatibly; older data is dropped. */
  version: number;
  fill: HubWidgetFill;
  name: HubLocalized;
  /** One line for the gallery. */
  description: HubLocalized;
  /** The widget's data. Every size is bounded; links are http(s) only. */
  data: D;
  /** What the person sets; every field has a default in `defaultConfig`. */
  config: C;
  defaultConfig: z.infer<C>;
  size: HubWidgetSize;
  refresh: HubWidgetRefreshDefault;
  /** AI: the natural-language request the sheet starts from. */
  brief?: HubLocalized;
  /** AI: type-specific guidance for the fill agent (English, trusted). */
  guide?: string;
  /** AI: the config in words for the fill agent. */
  describeConfig?: (config: z.infer<C>) => string;
  /** Data shown in the gallery's preview. */
  sample: (language: "en" | "cs") => z.infer<D>;
};

export const defineWidget = <D extends z.ZodType, C extends z.ZodType>(
  definition: HubWidgetDefinition<D, C>,
) => definition;

/** Plain text with a bound; trimmed. */
export const widgetText = (max: number) => z.string().trim().max(max);
/** A non-empty line. */
export const widgetLine = (max: number) => z.string().trim().min(1).max(max);
/** A date ("2026-10-17") or a date-time with an optional offset. */
export const widgetDateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/,
  );
/** Only web links: never javascript:, data: or app schemes. */
export const widgetLink = z
  .string()
  .max(500)
  .regex(/^https?:\/\/[^\s"'<>]+$/i);
/** Where an item came from: a service's name, as the agent saw it. */
export const widgetSource = widgetText(80);
export const widgetCount = (max: number) => z.number().int().min(1).max(max);
