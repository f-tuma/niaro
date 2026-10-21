import { z } from "zod";
import { MemorySettingsSchema } from "../../packages/protocol/memory";
import {
  DateTimeInput,
  PluginResultSchema,
  TimeZone,
  dateTimeTool,
  resolveDateTime,
  type PluginClock,
} from "./datetime";

export const PluginSettingsSchema = z.strictObject({
  enabled: z
    .array(z.enum(["datetime", "memory"]))
    .max(2)
    .refine((ids) => new Set(ids).size === ids.length)
    .default(["datetime"]),
  timeZone: TimeZone.default("UTC"),
  memory: MemorySettingsSchema.optional(),
});
export type PluginSettings = z.infer<typeof PluginSettingsSchema>;
export const MAX_PLUGIN_CALLS = 4;
export const PluginReceiptSchema = z.strictObject({
  ref: z.string().regex(/^result_[1-4]$/),
  name: z.literal("internal_datetime_resolve"),
  version: z.literal(1),
  input: DateTimeInput,
  result: PluginResultSchema,
});
export type PluginReceipt = z.infer<typeof PluginReceiptSchema>;

/** Stateful context capabilities are advertised here but executed by the scoped identity runtime. */
export const INTERNAL_PLUGIN_MANIFESTS = [
  {
    id: "datetime" as const,
    version: 1,
    effect: "pure" as const,
    tools: [dateTimeTool.function.name],
  },
  {
    id: "memory" as const,
    version: 1,
    effect: "context" as const,
    tools: [
      "memory_search",
      "memory_remember",
      "memory_revise",
      "memory_forget",
    ],
  },
];

/** Shipped, explicitly enabled pure tools only. No dynamic imports, secrets or network capabilities. */
export function createInternalPlugins(
  settings: PluginSettings = { enabled: ["datetime"], timeZone: "UTC" },
) {
  const config = PluginSettingsSchema.parse(settings);
  const definitions = config.enabled.includes("datetime")
    ? [
        {
          id: "datetime",
          version: 1,
          effect: "pure" as const,
          tool: dateTimeTool,
        },
      ]
    : [];
  return {
    timeZone: config.timeZone,
    manifests: definitions.map(({ tool, ...manifest }) => ({
      ...manifest,
      tools: [tool.function.name],
    })),
    tools: definitions.map((d) => d.tool),
    has: (name: string) =>
      definitions.some((d) => d.tool.function.name === name),
    invoke(
      name: string,
      input: unknown,
      clock: PluginClock,
      index: number,
    ): PluginReceipt {
      if (
        !definitions.some((d) => d.tool.function.name === name) ||
        index < 1 ||
        index > MAX_PLUGIN_CALLS
      )
        throw new Error("internal_plugin_denied");
      return PluginReceiptSchema.parse({
        ref: `result_${index}`,
        name,
        version: 1,
        input,
        result: resolveDateTime(input, clock),
      });
    },
  };
}

/** Bind whole-value references to server-calculated scalars before action-schema validation. */
export function bindPluginResults(
  input: Record<string, unknown>,
  receipts: PluginReceipt[],
) {
  let nodes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    // Match the existing external-action argument budget.
    if (++nodes > 10000 || depth > 32)
      throw Error("internal_plugin_binding_invalid");
    if (typeof value === "string" && value.includes("$plugin.")) {
      const match = /^\$plugin\.(result_[1-4])\.([A-Za-z][A-Za-z0-9]*)$/.exec(
        value,
      );
      const result = receipts.find((r) => r.ref === match?.[1])?.result;
      if (
        !match ||
        result?.status !== "resolved" ||
        !Object.hasOwn(result.values, match[2]!)
      )
        throw Error("internal_plugin_binding_invalid");
      return result.values[match[2]!]!;
    }
    if (Array.isArray(value)) return value.map((v) => visit(v, depth + 1));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          if (key.includes("$plugin."))
            throw Error("internal_plugin_binding_invalid");
          return [key, visit(item, depth + 1)];
        }),
      );
    return value;
  };
  return visit(input, 0) as Record<string, unknown>;
}
