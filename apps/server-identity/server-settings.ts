import type { DatabaseSync } from "node:sqlite";
import {
  SERVER_SETTINGS_ON_RESTART,
  ServerSettingsSchema,
  type ServerSettings,
} from "../../packages/protocol/server-settings";
import { ProfilePluginSettingsSchema } from "../server-plugins/registry";
import type { ServerConfig } from "../reference-server/config";
import { IdentityError } from "./error";

/** The profile's values for the settings administration can change. */
export function serverSettingsDefaults(config: ServerConfig): ServerSettings {
  const identity = config.administration?.identity;
  return ServerSettingsSchema.parse({
    name: config.name,
    timeZone: ProfilePluginSettingsSchema.parse(config.plugins ?? {}).timeZone,
    meetings: identity?.meetings ?? {},
    hubScheduler: identity?.hub.scheduler ?? {},
    integrationOrigins: identity?.integrationOrigins ?? [],
    allowedOrigins: config.allowedOrigins,
  });
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * One row of saved server settings. Only the settings that differ from the
 * profile are kept, so a setting nobody changed follows the profile.
 */
export class ServerSettingsStore {
  private current?: { revision: number; settings: ServerSettings };
  /** What the running server read at startup, for the settings that wait for a restart. */
  readonly startup: ServerSettings;
  constructor(
    private db: DatabaseSync,
    readonly defaults: ServerSettings,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_server_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL, settings TEXT NOT NULL
    ) STRICT;`);
    this.startup = this.read().settings;
  }
  read() {
    if (this.current) return this.current;
    const row = this.db
      .prepare("SELECT revision, settings FROM agent_server_settings")
      .get();
    // A value an older or newer version saved that no longer validates falls
    // back to the profile, one setting at a time.
    const saved = (row ? JSON.parse(String(row.settings)) : {}) as Record<
      string,
      unknown
    >;
    const overrides = Object.fromEntries(
      Object.entries(ServerSettingsSchema.shape).flatMap(([key, schema]) => {
        const value = key in saved ? schema.safeParse(saved[key]) : undefined;
        return value?.success ? [[key, value.data]] : [];
      }),
    );
    this.current = {
      revision: Number(row?.revision ?? 0),
      settings: { ...this.defaults, ...overrides },
    };
    return this.current;
  }
  /** Saved settings that the running server only reads at startup. */
  restartPending() {
    const settings = this.read().settings;
    return SERVER_SETTINGS_ON_RESTART.filter(
      (key) => !same(settings[key], this.startup[key]),
    );
  }
  /** Replaces every setting; returns the previous state. Run inside the identity queue. */
  update(revision: number, raw: ServerSettings) {
    const previous = this.read();
    if (previous.revision !== revision)
      throw new IdentityError(409, "server_settings_conflict");
    const settings = ServerSettingsSchema.parse(raw);
    const overrides = Object.fromEntries(
      Object.entries(settings).filter(
        ([key, value]) =>
          !same(value, this.defaults[key as keyof ServerSettings]),
      ),
    );
    this.db
      .prepare(
        "INSERT INTO agent_server_settings (id, revision, settings) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, settings=excluded.settings",
      )
      .run(revision + 1, JSON.stringify(overrides));
    this.current = { revision: revision + 1, settings };
    return previous;
  }
  /** A rolled back transaction must not leave its value in the cache. */
  forget() {
    this.current = undefined;
  }
}
