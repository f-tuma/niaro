import { MailSettings } from "../server-identity/invitations";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { ConnectionOrigin } from "../../packages/protocol/connections";
import {
  AllowedOrigins,
  HubSchedulerServerSettings,
  IntegrationOrigins,
  MeetingServerSettings,
  ServerName,
  ServerOrigin,
} from "../../packages/protocol/server-settings";
import { AIProfileId } from "../../packages/protocol/workspace-ai";
import { CalendarCollectionUrl } from "../../packages/protocol/workspace-calendar";
import { ProfilePluginSettingsSchema } from "../server-plugins/registry";

const path = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((v) => !v.includes("\0"));
const catalogId = AIProfileId.refine((value) => value !== "instance");
const profileName = z.string().trim().min(1).max(100);
const aiProfiles = z
  .strictObject({
    models: z
      .array(
        z.strictObject({ id: catalogId, label: profileName, configFile: path }),
      )
      .max(12)
      .default([]),
    voices: z
      .array(
        z.strictObject({
          id: catalogId,
          label: profileName,
          adapter: z.discriminatedUnion("provider", [
            z.strictObject({
              provider: z.literal("whisper.cpp"),
              assetsDirectory: path,
            }),
            z.strictObject({
              provider: z.literal("openrouter"),
              assetsDirectory: path,
              configFile: path,
            }),
          ]),
        }),
      )
      .max(12)
      .default([]),
  })
  .superRefine((value, ctx) => {
    for (const key of ["models", "voices"] as const)
      if (new Set(value[key].map((p) => p.id)).size !== value[key].length)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "AI profile IDs must be unique",
        });
  });
export const HOSTED_RUNTIMES = ["auto", "docker", "process"] as const;
export const ServerConfigSchema = z
  .strictObject({
    version: z.literal(1),
    name: ServerName,
    listen: z.strictObject({
      host: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
      port: z.number().int().min(1024).max(65535),
    }),
    dataDirectory: path,
    allowedOrigins: AllowedOrigins,
    sessionSeconds: z.number().int().min(30).max(3600).default(1800),
    plugins: ProfilePluginSettingsSchema.optional(),
    administration: z
      .strictObject({
        keyFile: path,
        identity: z
          .strictObject({
            directory: path,
            baseURL: ServerOrigin,
            voiceAssetsDirectory: path.optional(),
            /** Hosted MCP servers run code on this machine. allowCustom (default on) lets
             * organization owners and admins add their own definitions, not only the
             * built-in ones; only the operator can turn it off, never the console.
             * runtime: auto uses Docker when it answers, otherwise runs npm servers as
             * confined Node processes of this server (NIARO_HOSTED_RUNTIME overrides it). */
            hosting: z
              .strictObject({
                allowCustom: z.boolean().default(true),
                runtime: z.enum(HOSTED_RUNTIMES).default("auto"),
              })
              .default({ allowCustom: true, runtime: "auto" }),
            /** Owners may open, change and create plugins in Administration →
             * Plugins. Saving a plugin runs its code in the server process;
             * false (or NIARO_PLUGIN_EDITING=0) leaves the files read-only.
             * Unset means on. */
            pluginEditing: z.boolean().optional(),
            mail: MailSettings.optional(),
            /** How long a browser stays signed in to an account without being
             * used; every day of use extends it. */
            accountSessionDays: z.number().int().min(1).max(90).default(30),
            connectionOrigins: z.array(ConnectionOrigin).max(20).default([]),
            integrationOrigins: IntegrationOrigins.default([]),
            calendarCollections: z
              .array(CalendarCollectionUrl)
              .max(20)
              .default([]),
            aiProfiles: aiProfiles.default({ models: [], voices: [] }),
            mobile: z
              .strictObject({
                model: z.enum(["disabled", "instance"]).default("disabled"),
                voice: z.enum(["disabled", "instance"]).default("disabled"),
                sessionIdleDays: z.number().int().min(1).max(90).default(30),
              })
              .default({
                model: "disabled",
                voice: "disabled",
                sessionIdleDays: 30,
              }),
            /** Meeting recordings: sound retention and transcription hints. */
            meetings: MeetingServerSettings.default({
              audioRetentionDays: 30,
              glossary: [],
              chunkSeconds: 300,
              diarization: { enabled: false, url: "http://diarizer:8000" },
            }),
            /** The overview's background refresh of hourly and daily AI widgets. */
            hub: z
              .strictObject({
                scheduler: HubSchedulerServerSettings.default({
                  intervalSeconds: 300,
                  maxPerTick: 10,
                  idleDays: 14,
                }),
              })
              .default({
                scheduler: {
                  intervalSeconds: 300,
                  maxPerTick: 10,
                  idleDays: 14,
                },
              }),
          })
          .optional(),
        sessionSeconds: z.number().int().min(60).max(3600).default(1800),
      })
      .optional(),
    adapters: z.strictObject({
      model: z.discriminatedUnion("provider", [
        z.strictObject({ provider: z.literal("fixture") }),
        z.strictObject({ provider: z.literal("openrouter"), configFile: path }),
      ]),
      voice: z.discriminatedUnion("provider", [
        z.strictObject({ provider: z.literal("disabled") }),
        z.strictObject({
          provider: z.literal("whisper.cpp"),
          assetsDirectory: path,
        }),
        z.strictObject({
          provider: z.literal("openrouter"),
          assetsDirectory: path,
          configFile: path,
        }),
      ]),
      crm: z.discriminatedUnion("provider", [
        z.strictObject({ provider: z.literal("disabled") }),
        z.strictObject({
          provider: z.literal("twenty-test"),
          configFile: path,
        }),
      ]),
      calendar: z.discriminatedUnion("provider", [
        z.strictObject({ provider: z.literal("simulated") }),
        z.strictObject({ provider: z.literal("caldav"), configFile: path }),
      ]),
    }),
  })
  .superRefine((config, ctx) => {
    if (config.administration?.identity) {
      const url = new URL(config.administration.identity.baseURL);
      if (
        url.protocol !== "https:" &&
        (url.protocol !== "http:" ||
          !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
          Number(url.port) !== config.listen.port)
      )
        ctx.addIssue({
          code: "custom",
          path: ["administration", "identity", "baseURL"],
          message:
            "Identity origin must use HTTPS, or HTTP loopback matching the listener port",
        });
    }
    if (
      config.adapters.crm.provider !== "disabled" &&
      config.adapters.model.provider === "fixture"
    )
      ctx.addIssue({
        code: "custom",
        path: ["adapters", "crm"],
        message: "CRM requires a model interpreter",
      });
  });
/** A profile only accepts loopback; NIARO_LISTEN_HOST may widen it for a container. */
export const LISTEN_HOSTS = ["127.0.0.1", "::1", "0.0.0.0", "::"] as const;
export type ServerConfig = Omit<
  z.infer<typeof ServerConfigSchema>,
  "listen"
> & {
  listen: { host: (typeof LISTEN_HOSTS)[number]; port: number };
};
export class ServerConfigError extends Error {}

/**
 * Deployment overrides for a container, where one image serves many origins.
 * NIARO_PUBLIC_URL replaces administration.identity.baseURL before validation,
 * so it passes the same HTTPS / loopback rule as the profile. NIARO_LISTEN_HOST
 * lets the process bind every interface inside a container network; the
 * published port must stay on loopback or behind the HTTPS proxy.
 */
function applyDeploymentEnvironment(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
) {
  const publicUrl = env.NIARO_PUBLIC_URL?.trim();
  if (!publicUrl) return;
  const identity =
    raw && typeof raw === "object" && "administration" in raw
      ? (raw.administration as { identity?: unknown } | undefined)?.identity
      : undefined;
  if (!identity || typeof identity !== "object")
    throw new ServerConfigError(
      "NIARO_PUBLIC_URL needs administration.identity in the server profile.",
    );
  (identity as { baseURL?: string }).baseURL = publicUrl;
}
function listenHost(env: NodeJS.ProcessEnv = process.env) {
  const host = env.NIARO_LISTEN_HOST?.trim();
  if (!host) return undefined;
  if (!(LISTEN_HOSTS as readonly string[]).includes(host))
    throw new ServerConfigError(
      `NIARO_LISTEN_HOST must be one of ${LISTEN_HOSTS.join(", ")}.`,
    );
  return host as ServerConfig["listen"]["host"];
}
/** NIARO_HOSTED_RUNTIME: a container image without Docker can force `process`. */
/** NIARO_PLUGIN_EDITING=0 turns plugin editing in the console off, 1 on. */
function pluginEditing(env: NodeJS.ProcessEnv = process.env) {
  const value = env.NIARO_PLUGIN_EDITING?.trim();
  if (!value) return undefined;
  if (value !== "0" && value !== "1")
    throw new ServerConfigError("NIARO_PLUGIN_EDITING must be 0 or 1.");
  return value === "1";
}
function hostedRuntime(env: NodeJS.ProcessEnv = process.env) {
  const runtime = env.NIARO_HOSTED_RUNTIME?.trim();
  if (!runtime) return undefined;
  if (!(HOSTED_RUNTIMES as readonly string[]).includes(runtime))
    throw new ServerConfigError(
      `NIARO_HOSTED_RUNTIME must be one of ${HOSTED_RUNTIMES.join(", ")}.`,
    );
  return runtime as (typeof HOSTED_RUNTIMES)[number];
}

/**
 * SMTP_HOST, SMTP_PORT, SMTP_SECURE (true | starttls | false), SMTP_USER,
 * SMTP_PASSWORD and SMTP_FROM
 * override the profile's invitation mail settings, so the password can stay
 * out of the JSON profile. Values pass the same validation as the profile.
 */
function applyMailEnvironment(
  config: ServerConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!env.SMTP_HOST?.trim()) return;
  if (!config.administration?.identity)
    throw new ServerConfigError(
      "SMTP settings need administration.identity in the server profile.",
    );
  // SMTP_SECURE: true = implicit TLS (465), starttls = upgrade (587),
  // false = plain, which validation allows only for a loopback host.
  const mode = (env.SMTP_SECURE ?? "true").trim().toLowerCase();
  const settings = MailSettings.safeParse({
    host: env.SMTP_HOST.trim(),
    port: Number(env.SMTP_PORT ?? (mode === "starttls" ? 587 : 465)),
    secure: mode === "true",
    starttls: mode === "starttls",
    from: env.SMTP_FROM?.trim(),
    ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
    ...(env.SMTP_PASSWORD ? { password: env.SMTP_PASSWORD } : {}),
  });
  if (!settings.success)
    throw new ServerConfigError(
      "Invalid SMTP settings in the environment. Check SMTP_HOST, SMTP_PORT, SMTP_SECURE and SMTP_FROM.",
    );
  config.administration.identity.mail = settings.data;
}

/** The container's port when no profile names one. */
export const AUTOMATIC_PORT = 8793;
/**
 * The profile a container builds for itself when none is given: everything
 * under NIARO_DATA (default /data), the public origin from NIARO_PUBLIC_URL
 * (required), NIARO_NAME, NIARO_TIME_ZONE (or TZ) and NIARO_PORT, and the
 * same adapters as the example profiles. It passes the same validation as a
 * profile file, and the same environment overrides apply afterwards.
 */
export function automaticServerProfile(
  env: NodeJS.ProcessEnv = process.env,
  voiceDirectory = "/app/voice",
) {
  const value = (name: string) => env[name]?.trim() || undefined;
  if (!value("NIARO_PUBLIC_URL"))
    throw new ServerConfigError(
      "No server profile: set NIARO_PUBLIC_URL to the public https:// origin, or pass a profile file.",
    );
  const port = value("NIARO_PORT") ?? String(AUTOMATIC_PORT);
  if (!/^\d{1,5}$/.test(port))
    throw new ServerConfigError("NIARO_PORT must be a port number.");
  const data = resolve(value("NIARO_DATA") ?? "/data");
  return {
    version: 1,
    name: value("NIARO_NAME") ?? "Niaro",
    listen: { host: "127.0.0.1", port: Number(port) },
    dataDirectory: resolve(data, "workflow"),
    allowedOrigins: [],
    plugins: {
      enabled: ["datetime", "memory"],
      timeZone: value("NIARO_TIME_ZONE") ?? value("TZ") ?? "Europe/Prague",
    },
    administration: {
      keyFile: resolve(data, "admin-key.json"),
      identity: {
        directory: resolve(data, "identity"),
        // Replaced by NIARO_PUBLIC_URL below, like in a profile file.
        baseURL: "https://localhost",
        ...(existsSync(voiceDirectory)
          ? { voiceAssetsDirectory: voiceDirectory }
          : {}),
      },
    },
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  };
}

/**
 * Operator-owned local JSON only. Paths resolve relative to the profile, never
 * the launch directory. Without a file the automatic profile is used.
 */
export function loadServerConfig(file?: string): ServerConfig {
  let config: ServerConfig;
  let raw: unknown;
  if (file)
    try {
      const stats = statSync(file);
      if (!stats.isFile() || stats.size > 65536) throw Error();
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new ServerConfigError(
        "Invalid server profile. Check its version, fields, paths and adapter dependencies.",
      );
    }
  else raw = automaticServerProfile();
  applyDeploymentEnvironment(raw);
  try {
    config = ServerConfigSchema.parse(raw);
  } catch {
    throw new ServerConfigError(
      !file
        ? "Invalid automatic profile. Check NIARO_PUBLIC_URL (one HTTPS origin), NIARO_NAME, NIARO_TIME_ZONE (or TZ) and NIARO_PORT."
        : process.env.NIARO_PUBLIC_URL?.trim()
          ? "Invalid server profile or NIARO_PUBLIC_URL. The public URL must be one HTTPS origin, or http://localhost:<listen port>."
          : "Invalid server profile. Check its version, fields, paths and adapter dependencies.",
    );
  }
  config.listen.host = listenHost() ?? config.listen.host;
  const runtime = hostedRuntime();
  if (runtime && config.administration?.identity)
    config.administration.identity.hosting.runtime = runtime;
  const editing = pluginEditing();
  if (editing !== undefined && config.administration?.identity)
    config.administration.identity.pluginEditing = editing;
  applyMailEnvironment(config);
  const base = file ? dirname(resolve(file)) : "/";
  config.dataDirectory = resolve(base, config.dataDirectory);
  if (config.administration)
    config.administration.keyFile = resolve(
      base,
      config.administration.keyFile,
    );
  if (config.administration?.identity) {
    config.administration.identity.directory = resolve(
      base,
      config.administration.identity.directory,
    );
    if (config.administration.identity.voiceAssetsDirectory)
      config.administration.identity.voiceAssetsDirectory = resolve(
        base,
        config.administration.identity.voiceAssetsDirectory,
      );
    if (config.administration.identity.directory === config.dataDirectory)
      throw new ServerConfigError(
        "Identity and workflow directories must be separate.",
      );
  }
  for (const adapter of Object.values(config.adapters)) {
    if ("configFile" in adapter)
      adapter.configFile = resolve(base, adapter.configFile);
    if ("assetsDirectory" in adapter)
      adapter.assetsDirectory = resolve(base, adapter.assetsDirectory);
  }
  for (const entry of config.administration?.identity?.aiProfiles.models ?? [])
    entry.configFile = resolve(base, entry.configFile);
  for (const entry of config.administration?.identity?.aiProfiles.voices ??
    []) {
    entry.adapter.assetsDirectory = resolve(
      base,
      entry.adapter.assetsDirectory,
    );
    if ("configFile" in entry.adapter)
      entry.adapter.configFile = resolve(base, entry.adapter.configFile);
  }
  return config;
}
