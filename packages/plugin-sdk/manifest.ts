import { z } from "zod";

/**
 * `plugin.json`: what a plugin is and what it may do, readable without running
 * its code. The server validates it before it imports the entry module, and the
 * administration shows it as the plugin's card and technical details.
 * See docs/plugins.md for every field.
 */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
export const PluginId = z.string().regex(PLUGIN_ID_PATTERN);
export const LocalizedText = z.strictObject({
  en: z.string().trim().min(1).max(400),
  cs: z.string().trim().min(1).max(400),
});

const SettingKey = z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/);
/** One workspace setting. Values are scalars; the console renders a field per type. */
export const SettingFieldSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("boolean"),
    label: LocalizedText,
    default: z.boolean(),
  }),
  z
    .strictObject({
      type: z.literal("integer"),
      label: LocalizedText,
      default: z.number().int(),
      min: z.number().int(),
      max: z.number().int(),
    })
    .refine((f) => f.min <= f.default && f.default <= f.max, {
      message: "min ≤ default ≤ max",
    }),
  z
    .strictObject({
      type: z.literal("string"),
      label: LocalizedText,
      default: z.string().max(500),
      maxLength: z.number().int().min(1).max(500).default(200),
      /** A fixed choice: the value must be one of these. */
      options: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
    })
    .refine(
      (f) =>
        f.default.length <= f.maxLength &&
        (!f.options || f.options.includes(f.default)),
      { message: "The default must fit maxLength and options" },
    ),
]);
export type SettingField = z.infer<typeof SettingFieldSchema>;

export const ToolManifestSchema = z.strictObject({
  /** What the model calls. Pure tools: internal_<plugin id>_<verb>. */
  name: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  title: LocalizedText,
  /** read: computes or looks up. write: changes saved data. */
  access: z.enum(["read", "write"]),
  /** explicit_command: runs only when the person's latest message asks for it. */
  approval: z.enum(["none", "explicit_command"]),
});
export type ToolManifest = z.infer<typeof ToolManifestSchema>;

/** Host capabilities a plugin may ask for. Only memory exists today. */
export const PluginCapability = z.enum(["memory"]);

export const PluginManifestSchema = z
  .strictObject({
    id: PluginId,
    /** Whole number; raise it when the tools' behaviour changes. */
    version: z.number().int().positive().max(1_000_000),
    name: LocalizedText,
    description: LocalizedText,
    /**
     * pure: tools compute a result from their input and the turn's clock.
     * context: tools work with the person's saved context through a host
     * capability (memory).
     */
    effect: z.enum(["pure", "context"]),
    capabilities: z.array(PluginCapability).max(1).default([]),
    tools: z.array(ToolManifestSchema).min(1).max(10),
    settings: z
      .record(SettingKey, SettingFieldSchema)
      .refine((value) => Object.keys(value).length <= 20, {
        message: "At most 20 settings",
      })
      .default({}),
  })
  .superRefine((manifest, ctx) => {
    const issue = (message: string, path: PropertyKey[] = []) =>
      ctx.addIssue({ code: "custom", message, path });
    const names = manifest.tools.map((tool) => tool.name);
    if (new Set(names).size !== names.length)
      issue("Tool names must be unique", ["tools"]);
    manifest.tools.forEach((tool, index) => {
      if ((tool.access === "write") !== (tool.approval === "explicit_command"))
        issue(
          "A write tool needs approval explicit_command; a read tool needs none",
          ["tools", index, "approval"],
        );
    });
    const memory = manifest.capabilities.includes("memory");
    if (memory && manifest.id !== "memory")
      issue("The memory capability belongs to the memory plugin", [
        "capabilities",
      ]);
    if ((manifest.effect === "context") !== memory)
      issue("effect context goes with the memory capability, pure without", [
        "effect",
      ]);
    const prefix =
      manifest.effect === "pure"
        ? `internal_${manifest.id.replaceAll("-", "_")}_`
        : "memory_";
    manifest.tools.forEach((tool, index) => {
      if (!tool.name.startsWith(prefix) || tool.name.length <= prefix.length)
        issue(`Tool names of this plugin start with ${prefix}`, [
          "tools",
          index,
          "name",
        ]);
      if (manifest.effect === "pure" && tool.access !== "read")
        issue("Pure tools only read", ["tools", index, "access"]);
    });
  });
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** A readable, single-line reason for an invalid manifest. */
export function manifestProblem(error: z.ZodError) {
  const first = error.issues[0];
  if (!first) return "plugin.json is invalid";
  const path = first.path.map(String).join(".");
  return `plugin.json${path ? ` → ${path}` : ""}: ${first.message}`;
}

/** The setting values of a plugin: declared defaults, then each layer's valid values. */
export function resolveSettings(
  fields: Record<string, SettingField>,
  ...layers: (Record<string, unknown> | undefined)[]
) {
  const values: Record<string, string | number | boolean> = {};
  for (const [key, field] of Object.entries(fields)) {
    values[key] = field.default;
    for (const layer of layers) {
      const value = layer?.[key];
      if (value !== undefined && settingValid(field, value))
        values[key] = value as string | number | boolean;
    }
  }
  return values;
}
export function settingValid(field: SettingField, value: unknown) {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        Number.isInteger(value) &&
        (value as number) >= field.min &&
        (value as number) <= field.max
      );
    case "string":
      return (
        typeof value === "string" &&
        value.length <= field.maxLength &&
        (!field.options || field.options.includes(value))
      );
  }
}
