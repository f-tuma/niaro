import type { DatabaseSync } from "node:sqlite";
import {
  PluginPreferencesSchema,
  WorkspacePluginsSchema,
  PreviewWorkspacePluginSchema,
  WorkspacePluginPreviewSchema,
  type PluginPreferences,
} from "../../packages/protocol/workspace-plugins";
import {
  createInternalPlugins,
  INTERNAL_PLUGIN_MANIFESTS,
  PluginSettingsSchema,
  type PluginSettings,
} from "../server-plugins/registry";
import { IdentityError } from "./error";

/** Workspace overrides can narrow the operator's shipped-tool allowlist, never widen it. */
export class WorkspacePluginStore {
  private defaults: PluginSettings;
  constructor(
    private db: DatabaseSync,
    defaults?: PluginSettings,
  ) {
    this.defaults = PluginSettingsSchema.parse(defaults ?? {});
    db.exec(`CREATE TABLE IF NOT EXISTS agent_workspace_plugins (
      workspace_id TEXT PRIMARY KEY REFERENCES agent_workspace(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, settings TEXT
    ) STRICT;`);
  }
  /** The server's time zone changed in administration: workspaces on the server's settings follow. */
  setDefaultTimeZone(timeZone: string) {
    this.defaults = PluginSettingsSchema.parse({ ...this.defaults, timeZone });
  }
  read(workspaceId: string) {
    const row = this.db
      .prepare(
        "SELECT revision, settings FROM agent_workspace_plugins WHERE workspace_id=?",
      )
      .get(workspaceId);
    const saved =
      row?.settings == null
        ? null
        : PluginPreferencesSchema.parse(JSON.parse(String(row.settings)));
    const settings = saved ?? this.defaults;
    const requestedMemory = settings.memory ?? this.defaults.memory;
    const memory =
      requestedMemory && this.defaults.memory
        ? {
            retentionDays: Math.min(
              requestedMemory.retentionDays,
              this.defaults.memory.retentionDays,
            ),
            maxContextChars: Math.min(
              requestedMemory.maxContextChars,
              this.defaults.memory.maxContextChars,
            ),
            maxItems: Math.min(
              requestedMemory.maxItems,
              this.defaults.memory.maxItems,
            ),
            allowShared:
              requestedMemory.allowShared && this.defaults.memory.allowShared,
          }
        : requestedMemory;
    return {
      revision: Number(row?.revision ?? 0),
      source: saved ? ("workspace" as const) : ("server" as const),
      settings: {
        ...settings,
        ...(memory ? { memory } : {}),
        enabled: settings.enabled.filter((id) =>
          this.defaults.enabled.includes(id),
        ),
      },
    };
  }
  inventory(organizationId: string, workspaceId: string, canManage: boolean) {
    return WorkspacePluginsSchema.parse({
      profile: "agent-workspace-plugins/1",
      organizationId,
      workspaceId,
      canManage,
      ...this.read(workspaceId),
      defaults: this.defaults,
      plugins: INTERNAL_PLUGIN_MANIFESTS.map((manifest) => ({
        ...manifest,
        available: this.defaults.enabled.includes(manifest.id),
      })),
    });
  }
  /** Same pure executor as chat; never changes settings or dispatches an external action. */
  preview(raw: unknown) {
    const command = PreviewWorkspacePluginSchema.parse(raw);
    const current = this.read(command.workspaceId);
    if (command.revision !== current.revision)
      throw new IdentityError(409, "plugins_conflict");
    const registry = createInternalPlugins(current.settings);
    if (!registry.has(command.tool))
      throw new IdentityError(403, "plugin_unavailable");
    const clock = {
      referenceNow: new Date().toISOString(),
      timeZone: registry.timeZone,
    };
    const receipt = registry.invoke(command.tool, command.input, clock, 1);
    return WorkspacePluginPreviewSchema.parse({
      organizationId: command.organizationId,
      workspaceId: command.workspaceId,
      revision: current.revision,
      tool: command.tool,
      ...clock,
      result: receipt.result,
    });
  }
  update(workspaceId: string, revision: number, raw: PluginPreferences | null) {
    const previous = this.read(workspaceId);
    if (previous.revision !== revision)
      throw new IdentityError(409, "plugins_conflict");
    const settings = raw === null ? null : PluginSettingsSchema.parse(raw);
    if (settings?.enabled.some((id) => !this.defaults.enabled.includes(id)))
      throw new IdentityError(403, "plugin_unavailable");
    if (
      settings?.memory &&
      this.defaults.memory &&
      (settings.memory.retentionDays > this.defaults.memory.retentionDays ||
        settings.memory.maxContextChars >
          this.defaults.memory.maxContextChars ||
        settings.memory.maxItems > this.defaults.memory.maxItems ||
        (settings.memory.allowShared && !this.defaults.memory.allowShared))
    )
      throw new IdentityError(403, "plugin_unavailable");
    this.db
      .prepare(
        "INSERT INTO agent_workspace_plugins VALUES (?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision, settings=excluded.settings",
      )
      .run(
        workspaceId,
        revision + 1,
        settings === null ? null : JSON.stringify(settings),
      );
    return previous;
  }
}
