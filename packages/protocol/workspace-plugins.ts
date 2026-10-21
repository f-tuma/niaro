import { z } from "zod";
import { WorkspaceTarget } from "./connections";
import { MemorySettingsSchema } from "./memory";
import {
  DateTimeInput,
  PluginResultSchema,
  TimeZone,
} from "./internal-plugins";

export const InternalPluginId = z.enum(["datetime", "memory"]);
export const PluginPreferencesSchema = z.strictObject({
  enabled: z
    .array(InternalPluginId)
    .max(2)
    .refine((ids) => new Set(ids).size === ids.length),
  timeZone: z.string().trim().min(1).max(100),
  memory: MemorySettingsSchema.optional(),
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
      }),
    )
    .max(20),
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
