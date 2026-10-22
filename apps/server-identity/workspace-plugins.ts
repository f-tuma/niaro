import type { DatabaseSync } from "node:sqlite";
import {
  PluginPreferencesSchema,
  WorkspacePluginsSchema,
  PreviewWorkspacePluginSchema,
  WorkspacePluginPreviewSchema,
  type PluginPreferences,
} from "../../packages/protocol/workspace-plugins";
import { settingValid } from "../../packages/plugin-sdk";
import {
  createInternalPlugins,
  knownPluginSettings,
  PluginSettingsSchema,
  type PluginSettings,
  type ProfilePluginSettingsSchema,
} from "../server-plugins/registry";
import { pluginCatalog } from "../server-plugins/catalog";
import { IdentityError } from "./error";
import type { z } from "zod";

/**
 * Workspace overrides can narrow the operator's allowlist, never widen it.
 * A plugin is available when the profile enables it, or when the operator
 * added it to the data directory (it starts off in every workspace).
 */
export class WorkspacePluginStore {
  private profile: z.input<typeof ProfilePluginSettingsSchema>;
  constructor(
    private db: DatabaseSync,
    defaults?: z.input<typeof ProfilePluginSettingsSchema>,
  ) {
    this.profile = defaults ?? {};
    db.exec(`CREATE TABLE IF NOT EXISTS agent_workspace_plugins (
      workspace_id TEXT PRIMARY KEY REFERENCES agent_workspace(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, settings TEXT
    ) STRICT;`);
  }
  /** The profile's settings for the plugins this server has now. */
  private get defaults(): PluginSettings {
    return knownPluginSettings(this.profile);
  }
  /** The server's time zone changed in administration: workspaces on the server's settings follow. */
  setDefaultTimeZone(timeZone: string) {
    this.profile = { ...this.profile, timeZone };
  }
  private available(id: string) {
    const plugin = pluginCatalog().plugins.get(id);
    return (
      !!plugin &&
      (plugin.source === "operator" || this.defaults.enabled.includes(id))
    );
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
    const defaults = this.defaults;
    const settings = saved ?? defaults;
    const requestedMemory = settings.memory ?? defaults.memory;
    const memory =
      requestedMemory && defaults.memory
        ? {
            retentionDays: Math.min(
              requestedMemory.retentionDays,
              defaults.memory.retentionDays,
            ),
            maxContextChars: Math.min(
              requestedMemory.maxContextChars,
              defaults.memory.maxContextChars,
            ),
            maxItems: Math.min(
              requestedMemory.maxItems,
              defaults.memory.maxItems,
            ),
            allowShared:
              requestedMemory.allowShared && defaults.memory.allowShared,
          }
        : requestedMemory;
    // The profile's values, then the workspace's, of plugins the server has.
    const values = Object.fromEntries(
      [...pluginCatalog().plugins.values()].flatMap(({ manifest }) => {
        if (manifest.id === "memory" || !Object.keys(manifest.settings).length)
          return [];
        const merged = Object.fromEntries(
          Object.entries(manifest.settings).flatMap(([key, field]) => {
            const value =
              saved?.settings?.[manifest.id]?.[key] ??
              defaults.settings?.[manifest.id]?.[key];
            return value !== undefined && settingValid(field, value)
              ? [[key, value]]
              : [];
          }),
        );
        return Object.keys(merged).length ? [[manifest.id, merged]] : [];
      }),
    );
    return {
      revision: Number(row?.revision ?? 0),
      source: saved ? ("workspace" as const) : ("server" as const),
      settings: {
        enabled: settings.enabled.filter((id) => this.available(id)),
        timeZone: settings.timeZone,
        ...(memory ? { memory } : {}),
        ...(Object.keys(values).length ? { settings: values } : {}),
      },
    };
  }
  inventory(
    organizationId: string,
    workspaceId: string,
    canManage: boolean,
    editing = { allowed: false, disabled: false },
  ) {
    const catalog = pluginCatalog();
    const defaults = this.defaults;
    return WorkspacePluginsSchema.parse({
      profile: "agent-workspace-plugins/1",
      organizationId,
      workspaceId,
      canManage,
      ...this.read(workspaceId),
      defaults: {
        enabled: defaults.enabled,
        timeZone: defaults.timeZone,
        ...(defaults.memory ? { memory: defaults.memory } : {}),
        ...(defaults.settings ? { settings: defaults.settings } : {}),
      },
      plugins: [...catalog.plugins.values()].map(({ manifest, source }) => ({
        id: manifest.id,
        version: manifest.version,
        effect: manifest.effect,
        tools: manifest.tools.map((tool) => tool.name),
        available: this.available(manifest.id),
        name: manifest.name,
        description: manifest.description,
        source,
        toolDetails: manifest.tools,
        settingFields: manifest.settings,
      })),
      problems: canManage ? catalog.problems : [],
      editing,
    });
  }
  /** Same pure executor as chat; never changes settings or dispatches an external action. */
  preview(raw: unknown) {
    const command = PreviewWorkspacePluginSchema.parse(raw);
    const current = this.read(command.workspaceId);
    if (command.revision !== current.revision)
      throw new IdentityError(409, "plugins_conflict");
    const registry = createInternalPlugins(current.settings, {
      scope: { workspaceId: command.workspaceId },
    });
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
    const defaults = this.defaults;
    if (settings?.enabled.some((id) => !this.available(id)))
      throw new IdentityError(403, "plugin_unavailable");
    if (
      settings?.memory &&
      defaults.memory &&
      (settings.memory.retentionDays > defaults.memory.retentionDays ||
        settings.memory.maxContextChars > defaults.memory.maxContextChars ||
        settings.memory.maxItems > defaults.memory.maxItems ||
        (settings.memory.allowShared && !defaults.memory.allowShared))
    )
      throw new IdentityError(403, "plugin_unavailable");
    // Every value must be one plugin.json declares, within its bounds.
    for (const [id, values] of Object.entries(settings?.settings ?? {})) {
      const fields = pluginCatalog().plugins.get(id)?.manifest.settings;
      if (
        !fields ||
        id === "memory" ||
        Object.entries(values).some(
          ([key, value]) =>
            !Object.hasOwn(fields, key) || !settingValid(fields[key]!, value),
        )
      )
        throw new IdentityError(400, "plugin_settings_invalid");
    }
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
