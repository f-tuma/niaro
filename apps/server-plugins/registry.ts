import { z } from "zod";
import { MemorySettingsSchema } from "../../packages/protocol/memory";
import { PluginId, resolveSettings } from "../../packages/plugin-sdk";
import { PluginResultSchema, TimeZone, type PluginClock } from "./datetime";
import { errorText, pluginCatalog, type LoadedPlugin } from "./catalog";
import { operatorLog } from "../fixture-server/operator-log";

const SettingValue = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
]);
/** Per-plugin setting values, by plugin id; plugin.json declares the keys. */
export const PluginValuesSchema = z
  .record(PluginId, z.record(z.string().max(40), SettingValue))
  .refine((value) => Object.keys(value).length <= 50);
const pluginSettings = (enabled: z.ZodType<string[]>) =>
  z.strictObject({
    enabled: enabled.default(["datetime"]),
    timeZone: TimeZone.default("UTC"),
    memory: MemorySettingsSchema.optional(),
    settings: PluginValuesSchema.optional(),
  });
const ids = z
  .array(PluginId)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length);
/** Settings of plugins the server has; an unknown id is an error. */
export const PluginSettingsSchema = pluginSettings(
  ids.refine((ids) => ids.every((id) => pluginCatalog().plugins.has(id)), {
    message: "Unknown plugin",
  }),
);
export type PluginSettings = z.infer<typeof PluginSettingsSchema>;
/**
 * The profile's `plugins` block. It is read before the operator's plugins
 * load, so it may name any plugin id; one the server does not have is ignored.
 */
export const ProfilePluginSettingsSchema = pluginSettings(ids);
/** Drops ids of plugins the server does not have (deleted, or invalid on this start). */
export function knownPluginSettings(
  settings: z.input<typeof ProfilePluginSettingsSchema> | undefined,
): PluginSettings {
  const parsed = ProfilePluginSettingsSchema.parse(settings ?? {});
  return {
    ...parsed,
    enabled: parsed.enabled.filter((id) => pluginCatalog().plugins.has(id)),
  };
}

export const MAX_PLUGIN_CALLS = 4;
const JsonInput = z.unknown().refine((value) => {
  try {
    return JSON.stringify(value).length <= 16384;
  } catch {
    return false;
  }
});
export const PluginReceiptSchema = z.strictObject({
  ref: z.string().regex(/^result_[1-4]$/),
  name: z.string().regex(/^internal_[a-z0-9_]{1,80}$/),
  version: z.number().int().positive(),
  input: JsonInput,
  result: PluginResultSchema,
});
export type PluginReceipt = z.infer<typeof PluginReceiptSchema>;

/** Name, version, effect and tools of every plugin the server has, for the inventory. */
export function pluginManifests() {
  return [...pluginCatalog().plugins.values()].map(({ manifest }) => ({
    id: manifest.id,
    version: manifest.version,
    effect: manifest.effect,
    tools: manifest.tools.map((tool) => tool.name),
  }));
}

/**
 * The pure plugins enabled for a turn: their model tools and a validated
 * invocation. A tool gets its arguments (checked against its input schema),
 * the turn's pinned clock and this workspace's settings; its result must be
 * flat scalar values, which actions can bind as `$plugin.result_N.<key>`.
 * Context plugins (memory) run through their own runtime.
 */
export function createInternalPlugins(
  settings: z.input<typeof ProfilePluginSettingsSchema> = {
    enabled: ["datetime"],
    timeZone: "UTC",
  },
  options: {
    scope?: { workspaceId: string; userId?: string };
    /** Runtimes kept for replaying older commands know only date & time. */
    legacy?: boolean;
  } = {},
) {
  const config = knownPluginSettings(settings);
  const definitions = config.enabled
    .map((id) => pluginCatalog().plugins.get(id)!)
    .filter(
      (plugin) =>
        plugin.manifest.effect === "pure" &&
        (!options.legacy || plugin.manifest.id === "datetime"),
    );
  const owner = new Map<string, LoadedPlugin>(
    definitions.flatMap((plugin) =>
      [...plugin.tools.keys()].map((name) => [name, plugin] as const),
    ),
  );
  return {
    timeZone: config.timeZone,
    manifests: definitions.map(({ manifest }) => ({
      id: manifest.id,
      version: manifest.version,
      effect: manifest.effect,
      tools: manifest.tools.map((tool) => tool.name),
    })),
    tools: definitions.flatMap((plugin) => plugin.modelTools),
    has: (name: string) => owner.has(name),
    /** The chat progress row: only date & time has one. */
    progress: (name: string) =>
      owner.get(name)?.manifest.id === "datetime"
        ? ("datetime" as const)
        : undefined,
    /** What the model reads when a call fails. */
    failure: (name: string) =>
      owner.get(name)?.manifest.id === "datetime"
        ? "invalid_date_arguments"
        : "invalid_plugin_arguments",
    invoke(
      name: string,
      input: unknown,
      clock: PluginClock,
      index: number,
    ): PluginReceipt {
      const plugin = owner.get(name);
      if (!plugin || index < 1 || index > MAX_PLUGIN_CALLS)
        throw new Error("internal_plugin_denied");
      const tool = plugin.tools.get(name)!;
      const args = tool.input.parse(input);
      const id = plugin.manifest.id;
      const log =
        (level: "info" | "warn" | "error") =>
        (message: string, details: Record<string, unknown> = {}) =>
          operatorLog(
            "plugin_log",
            {
              plugin: id,
              tool: name,
              message: String(message).slice(0, 1000),
              details: JSON.stringify(details).slice(0, 2000),
            },
            level,
          );
      const result = tool.run(args as never, {
        pluginId: id,
        now: clock.referenceNow,
        timeZone: clock.timeZone,
        settings: Object.freeze(
          resolveSettings(plugin.manifest.settings, config.settings?.[id]),
        ),
        ...(options.scope
          ? {
              workspaceId: options.scope.workspaceId,
              ...(options.scope.userId
                ? { personId: options.scope.userId }
                : {}),
            }
          : {}),
        log: { info: log("info"), warn: log("warn"), error: log("error") },
      });
      if (result instanceof Promise) {
        result.catch(() => {});
        throw new Error("internal_plugin_async");
      }
      const parsed = PluginResultSchema.safeParse(result);
      if (
        !parsed.success ||
        (parsed.data.status === "resolved" &&
          Object.keys(parsed.data.values).length > 50)
      ) {
        operatorLog(
          "plugin_result_invalid",
          {
            plugin: id,
            tool: name,
            message: parsed.success
              ? "More than 50 values"
              : errorText(parsed.error),
          },
          "warn",
        );
        throw new Error("internal_plugin_result_invalid");
      }
      return PluginReceiptSchema.parse({
        ref: `result_${index}`,
        name,
        version: plugin.manifest.version,
        input: JSON.parse(JSON.stringify(args)),
        result: parsed.data,
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
