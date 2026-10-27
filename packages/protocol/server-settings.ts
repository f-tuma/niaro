import { z } from "zod";
import { IdentityId } from "./identity";
import { TimeZone } from "./internal-plugins";
import { ServiceUrl } from "./service-catalog";

/**
 * Server settings an administrator changes at runtime. The server profile
 * (or the automatic profile) supplies the defaults; saved values live in the
 * identity database. The profile schema uses the same field schemas, so a
 * value the console accepts is one the profile accepts and the other way.
 */
export const SERVER_SETTINGS_PROFILE = "agent-server-settings/1" as const;
/** The `profile` of an exported settings file. */
export const SERVER_SETTINGS_FILE = "niaro-server-settings" as const;

export const ServerName = z.string().trim().min(1).max(100);
/** One exact HTTP(S) origin, no path. */
export const ServerOrigin = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
});
/** A service origin the integration transport may reach on a private address. */
export const IntegrationOrigin = ServiceUrl.refine((value) => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
});
/** Meeting recordings: sound retention and transcription hints. */
export const MeetingServerSettings = z.strictObject({
  /** Days the sound of a processed meeting is kept; 0 keeps it forever. */
  audioRetentionDays: z.number().int().min(0).max(3650).default(30),
  /** Names and terms the transcriber should spell right in every meeting. */
  glossary: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
  /** Seconds of audio per timestamped transcription request. */
  chunkSeconds: z.number().int().min(120).max(600).default(300),
  /**
   * Speaker diarization: who spoke when, from the recording itself, by the
   * optional diarizer service (docker compose profile "diarization"). Off
   * until an administrator turns it on.
   */
  diarization: z
    .strictObject({
      enabled: z.boolean().default(false),
      /** The diarizer's address; the compose service is "diarizer". */
      url: z
        .url()
        .refine((value) => /^https?:\/\//.test(value), "Use an HTTP(S) URL")
        .default("http://diarizer:8000"),
    })
    .default({ enabled: false, url: "http://diarizer:8000" }),
});
/** The overview's background refresh of hourly and daily AI widgets. */
export const HubSchedulerServerSettings = z.strictObject({
  /** Seconds between passes; 0 turns the scheduler off. */
  intervalSeconds: z.number().int().min(0).max(86400).default(300),
  /** Fills started per pass, across everyone. */
  maxPerTick: z.number().int().min(1).max(200).default(10),
  /** People who have not opened the overview for this long are left alone. */
  idleDays: z.number().int().min(1).max(365).default(14),
});
export const IntegrationOrigins = z.array(IntegrationOrigin).max(50);
export const AllowedOrigins = z.array(ServerOrigin).max(20);

export const ServerSettingsSchema = z.strictObject({
  name: ServerName,
  /** The default time zone of workspaces that keep the server's plugin settings. */
  timeZone: TimeZone,
  meetings: MeetingServerSettings,
  hubScheduler: HubSchedulerServerSettings,
  integrationOrigins: IntegrationOrigins,
  /** Web clients on other origins than the public URL. */
  allowedOrigins: AllowedOrigins,
});
export type ServerSettings = z.infer<typeof ServerSettingsSchema>;
/** Read once at startup: a change waits for the next start. */
export const SERVER_SETTINGS_ON_RESTART = [
  "integrationOrigins",
  "allowedOrigins",
] as const;
export const ServerSettingsRestartField = z.enum(SERVER_SETTINGS_ON_RESTART);

/** An exported file: no secrets and no paths, only these settings. */
export const ServerSettingsFileSchema = ServerSettingsSchema.extend({
  profile: z.literal(SERVER_SETTINGS_FILE),
  version: z.literal(1),
});
export type ServerSettingsFile = z.infer<typeof ServerSettingsFileSchema>;

export const ServerSettingsViewSchema = z.strictObject({
  profile: z.literal(SERVER_SETTINGS_PROFILE),
  organizationId: IdentityId,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  settings: ServerSettingsSchema,
  /** The profile's values, used for every setting that was never saved. */
  defaults: ServerSettingsSchema,
  /** Saved settings the running server picks up at the next start. */
  restartPending: z.array(ServerSettingsRestartField).max(2),
});
export type ServerSettingsView = z.infer<typeof ServerSettingsViewSchema>;
export const UpdateServerSettingsSchema = z.strictObject({
  organizationId: IdentityId,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  settings: ServerSettingsSchema,
});
export const ImportServerSettingsSchema = z.strictObject({
  organizationId: IdentityId,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  file: ServerSettingsFileSchema,
});

export function serverSettingsFile(
  settings: ServerSettings,
): ServerSettingsFile {
  return ServerSettingsFileSchema.parse({
    profile: SERVER_SETTINGS_FILE,
    version: 1,
    ...settings,
  });
}
/** The settings in a file, without its `profile` and `version`. */
export function serverSettingsOfFile(file: ServerSettingsFile): ServerSettings {
  return ServerSettingsSchema.parse(
    Object.fromEntries(
      Object.entries(file).filter(
        ([key]) => key !== "profile" && key !== "version",
      ),
    ),
  );
}
