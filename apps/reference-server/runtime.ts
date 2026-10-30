import { loadStorageConfiguration } from "../server-storage/config";
import type { StorageConfiguration } from "../server-storage/types";
import type { IdentityService } from "../server-identity/service";
import type { AIProfiles } from "../server-identity/workspace-ai";
import {
  createFixtureServer,
  type FixtureServerOptions,
} from "../fixture-server/http";
import { createAdminHandler } from "../server-admin/http";
import type { AdminService } from "../../packages/protocol/admin";
import { configuredModel, OpenRouterModel } from "../fixture-server/openrouter";
import {
  loadTwentyConfig,
  TwentyTestDirectory,
} from "../fixture-server/twenty";
import { loadCalendarConfig } from "../fixture-server/calendar";
import { LocalWhisper } from "../fixture-server/voice";
import { configuredGeminiTranscriber } from "../fixture-server/voice-openrouter";
import { ServerConfigError, type ServerConfig } from "./config";

/** Server-only extension point. A custom bootstrap can supply trusted implementations of these interfaces. */
export type ServerAdapters = Pick<
  FixtureServerOptions,
  "model" | "transcriber" | "crm" | "calendar"
> & { aiProfiles?: AIProfiles };

/** Loading validates local dependencies but makes no network request, consumes no budget and starts no worker. */
export function loadServerAdapters(config: ServerConfig): ServerAdapters {
  const adapters = config.adapters;
  const result: ServerAdapters = {};
  const load = <T>(name: string, factory: () => T): T => {
    try {
      return factory();
    } catch {
      throw new ServerConfigError(
        `Cannot load ${name} adapter. Check its private configuration and local dependencies.`,
      );
    }
  };
  if (adapters.model.provider === "openrouter") {
    const file = adapters.model.configFile;
    result.model = load("model", () => configuredModel(file));
  }
  if (adapters.crm.provider === "twenty-test") {
    const file = adapters.crm.configFile;
    result.crm = load(
      "CRM",
      () => new TwentyTestDirectory(loadTwentyConfig(file)),
    );
  }
  if (adapters.calendar.provider === "caldav") {
    const file = adapters.calendar.configFile;
    result.calendar = load("calendar", () => loadCalendarConfig(file));
  }
  if (adapters.voice.provider === "whisper.cpp") {
    const directory = adapters.voice.assetsDirectory;
    result.transcriber = load("voice", () => new LocalWhisper(directory));
  } else if (adapters.voice.provider === "openrouter") {
    const { configFile, assetsDirectory } = adapters.voice;
    result.transcriber = load("voice", () =>
      configuredGeminiTranscriber(configFile, assetsDirectory),
    );
  }
  const catalog = config.administration?.identity?.aiProfiles;
  result.aiProfiles = {
    models: (catalog?.models ?? []).map((p) => ({
      id: p.id,
      label: p.label,
      provider: "openrouter",
      adapter: load("workspace model", () => configuredModel(p.configFile)),
    })),
    voices: (catalog?.voices ?? []).map((p) => ({
      id: p.id,
      label: p.label,
      provider: p.adapter.provider,
      adapter: load("workspace voice", () =>
        p.adapter.provider === "whisper.cpp"
          ? new LocalWhisper(p.adapter.assetsDirectory)
          : configuredGeminiTranscriber(
              p.adapter.configFile,
              p.adapter.assetsDirectory,
            ),
      ),
    })),
  };
  return result;
}

/** Explicit metadata allowlist; credentials and file paths never enter this DTO. */
function publicInfo(adapter?: object): { model?: string; expiresAt?: string } {
  if (
    !adapter ||
    !("adminInfo" in adapter) ||
    !adapter.adminInfo ||
    typeof adapter.adminInfo !== "object"
  )
    return {};
  const info = adapter.adminInfo;
  return {
    ...("model" in info && typeof info.model === "string"
      ? { model: info.model }
      : {}),
    ...("expiresAt" in info && typeof info.expiresAt === "string"
      ? { expiresAt: info.expiresAt }
      : {}),
  };
}
export function inspectServerServices(
  adapters: ServerAdapters,
): AdminService[] {
  return [
    {
      id: "model",
      provider: adapters.model
        ? adapters.model instanceof OpenRouterModel
          ? "openrouter"
          : "custom"
        : "fixture",
      state: adapters.model ? "configured" : "demo",
      ...publicInfo(adapters.model),
    },
    {
      id: "voice",
      provider:
        adapters.transcriber?.engine ??
        (adapters.transcriber ? "custom" : "disabled"),
      state: !adapters.transcriber
        ? "disabled"
        : adapters.transcriber.available && !adapters.transcriber.available()
          ? "unavailable"
          : "configured",
      ...publicInfo(adapters.transcriber),
    },
    {
      id: "crm",
      provider: adapters.crm
        ? adapters.crm instanceof TwentyTestDirectory
          ? "twenty-test"
          : "custom"
        : "disabled",
      state: adapters.crm ? "configured" : "disabled",
      ...publicInfo(adapters.crm),
    },
    {
      id: "calendar",
      provider: adapters.calendar ? "caldav" : "simulated",
      state: adapters.calendar ? "configured" : "demo",
      ...(adapters.calendar
        ? { calendarLabel: adapters.calendar.target.label }
        : {}),
    },
  ];
}

export function createReferenceServer(
  config: ServerConfig,
  adapters = loadServerAdapters(config),
  identity?: IdentityService,
  /** Tests pass isolated console assets; production serves dist-admin. */
  options: {
    adminAssetsDirectory?: string;
    objectStorage?: StorageConfiguration;
  } = {},
) {
  if (!!config.administration?.identity !== !!identity)
    throw new ServerConfigError(
      "Identity must be initialized before creating this server.",
    );
  if (identity) {
    const sharing = config.administration!.identity!.mobile;
    const catalog = adapters.aiProfiles ?? { models: [], voices: [] };
    identity.attachAI({
      models: [
        ...(sharing.model === "instance" && adapters.model
          ? [
              {
                id: "instance",
                label: "Instance model",
                provider:
                  adapters.model instanceof OpenRouterModel
                    ? "openrouter"
                    : "custom",
                adapter: adapters.model,
              },
            ]
          : []),
        ...catalog.models,
      ],
      voices: [
        ...(sharing.voice === "instance" && adapters.transcriber
          ? [
              {
                id: "instance",
                label: "Instance voice",
                provider: adapters.transcriber.engine ?? "custom",
                adapter: adapters.transcriber,
              },
            ]
          : []),
        ...catalog.voices,
      ],
    });
  }
  const management = config.administration
    ? createAdminHandler(config, () => inspectServerServices(adapters), {
        identity,
        ...(options.adminAssetsDirectory
          ? { assetsDirectory: options.adminAssetsDirectory }
          : {}),
      })
    : undefined;
  // The web app is served from the server's own public origin and talks to
  // the same app API as the mobile clients.
  const publicOrigin = config.administration?.identity?.baseURL
    ? new URL(config.administration.identity.baseURL).origin
    : null;
  // Saved in administration, else the profile's; read once, at startup.
  const allowed =
    identity?.serverSettings()?.allowedOrigins ?? config.allowedOrigins;
  const origins =
    publicOrigin && !allowed.includes(publicOrigin)
      ? [...allowed, publicOrigin]
      : allowed;
  return createFixtureServer(config.dataDirectory, origins, {
    ...adapters,
    objectStorage: options.objectStorage ?? loadStorageConfiguration(),
    management,
    identity,
    sessionTtlMs: config.sessionSeconds * 1000,
    serverName: identity
      ? () => identity.serverSettings()?.name ?? config.name
      : config.name,
  });
}
