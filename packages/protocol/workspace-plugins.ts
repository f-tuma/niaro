import { z } from "zod";
import { WorkspaceTarget } from "./connections";
import { MemorySettingsSchema } from "./memory";
import {
  DateTimeInput,
  PluginResultSchema,
  TimeZone,
} from "./internal-plugins";
import {
  LocalizedText,
  PluginId,
  SettingFieldSchema,
  ToolManifestSchema,
} from "../plugin-sdk/manifest";

/** Built-in (plugins/), the operator's replacement of one, or the operator's own. */
export const PluginSourceSchema = z.enum(["built-in", "override", "operator"]);
export const InternalPluginId = PluginId;
const SettingValue = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
]);
export const PluginPreferencesSchema = z.strictObject({
  enabled: z
    .array(InternalPluginId)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length),
  timeZone: z.string().trim().min(1).max(100),
  memory: MemorySettingsSchema.optional(),
  /** Settings of plugins other than memory, by plugin id (keys from plugin.json). */
  settings: z
    .record(InternalPluginId, z.record(z.string().max(40), SettingValue))
    .optional(),
});
export type PluginPreferences = z.infer<typeof PluginPreferencesSchema>;
export const UpdateWorkspacePluginsSchema = WorkspaceTarget.extend({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  settings: PluginPreferencesSchema.nullable(),
});
export const WorkspacePluginsSchema = WorkspaceTarget.extend({
  profile: z.literal("agent-workspace-plugins/1"),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  canManage: z.boolean(),
  source: z.enum(["server", "workspace"]),
  defaults: PluginPreferencesSchema,
  settings: PluginPreferencesSchema,
  plugins: z
    .array(
      z.strictObject({
        id: InternalPluginId,
        version: z.number().int().positive(),
        effect: z.enum(["pure", "context"]),
        tools: z.array(z.string().min(1).max(128)).max(20),
        available: z.boolean(),
        name: LocalizedText,
        description: LocalizedText,
        source: PluginSourceSchema,
        toolDetails: z.array(ToolManifestSchema).max(20),
        settingFields: z.record(z.string().max(40), SettingFieldSchema),
      }),
    )
    .max(60),
  /** Plugins in the data directory that did not load. Managers only. */
  problems: z
    .array(
      z.strictObject({
        directory: z.string().max(200),
        id: InternalPluginId.nullable(),
        message: z.string().max(1000),
      }),
    )
    .max(60),
  /** Whether this person may open and change plugin files (server owners). */
  editing: z.strictObject({
    allowed: z.boolean(),
    /** NIARO_PLUGIN_EDITING=0 or pluginEditing: false in the profile. */
    disabled: z.boolean(),
  }),
});
export type WorkspacePlugins = z.infer<typeof WorkspacePluginsSchema>;

export const PreviewWorkspacePluginSchema = WorkspaceTarget.extend({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  tool: z.literal("internal_datetime_resolve"),
  input: DateTimeInput,
});
export const WorkspacePluginPreviewSchema = WorkspaceTarget.extend({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  tool: z.literal("internal_datetime_resolve"),
  referenceNow: z.iso.datetime(),
  timeZone: TimeZone,
  result: PluginResultSchema,
});
export type WorkspacePluginPreview = z.infer<
  typeof WorkspacePluginPreviewSchema
>;

/**
 * Plugin files in Administration → Plugins: plugin.json and index.ts of one
 * plugin. Owners only; saving runs the code on the server. See docs/plugins.md.
 */
export const PLUGIN_FILES_PROFILE = "agent-plugin-files/1" as const;
const FileText = z.string().max(256 * 1024);
export const PluginFilesContentSchema = z.strictObject({
  "plugin.json": FileText,
  "index.ts": FileText,
});
export type PluginFilesContent = z.infer<typeof PluginFilesContentSchema>;
export const PluginFilesQuerySchema = z.strictObject({
  organizationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  pluginId: InternalPluginId,
});
export const PluginFilesSchema = z.strictObject({
  profile: z.literal(PLUGIN_FILES_PROFILE),
  organizationId: z.string(),
  pluginId: InternalPluginId,
  /** null: the directory exists but did not load. */
  source: PluginSourceSchema.nullable(),
  /** A built-in exists with this id, so the override can be reset to it. */
  builtIn: z.boolean(),
  /** Editing is switched off: the files are read-only. */
  readOnly: z.boolean(),
  /** Where the files are on the server. */
  directory: z.string().max(1000),
  files: PluginFilesContentSchema,
  /** Why the saved files did not load, if they did not. */
  problem: z.string().max(1000).nullable(),
});
export type PluginFiles = z.infer<typeof PluginFilesSchema>;
export const ChangePluginFilesSchema = z.discriminatedUnion("action", [
  /** Validate and load without saving. */
  PluginFilesQuerySchema.extend({
    action: z.literal("check"),
    files: PluginFilesContentSchema,
  }),
  /** Validate, load, save to the data directory and put in force. */
  PluginFilesQuerySchema.extend({
    action: z.literal("save"),
    files: PluginFilesContentSchema,
  }),
  /** Remove the data directory's copy: the built-in again, or no plugin. */
  PluginFilesQuerySchema.extend({ action: z.literal("reset") }),
  /** A new operator plugin from the template. */
  PluginFilesQuerySchema.extend({ action: z.literal("create") }),
]);
export type ChangePluginFiles = z.infer<typeof ChangePluginFilesSchema>;
/** What a change did, and the plugin's files as they are now (null: deleted). */
export const PluginFilesResultSchema = z.strictObject({
  profile: z.literal(PLUGIN_FILES_PROFILE),
  outcome: z.enum(["valid", "saved", "invalid", "reset", "deleted", "created"]),
  /** Why the submitted files were refused (check/save). */
  rejected: z.string().max(1000).nullable(),
  current: PluginFilesSchema.nullable(),
});
export type PluginFilesResult = z.infer<typeof PluginFilesResultSchema>;
