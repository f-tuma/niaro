import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadServerConfig,
  ServerConfigSchema,
} from "../apps/reference-server/config";
import { loadServerAdapters } from "../apps/reference-server/runtime";

let directory: string;
const profile = () => ({
  version: 1,
  name: "TEST configurable assistant",
  listen: { host: "127.0.0.1", port: 8794 },
  dataDirectory: "./state",
  allowedOrigins: ["http://localhost:8085"],
  adapters: {
    model: { provider: "fixture" },
    voice: { provider: "disabled" },
    crm: { provider: "disabled" },
    calendar: { provider: "simulated" },
  },
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "server-config-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});
test("profile-relative paths and independent voice/model selection load without touching data, budget or network", () => {
  const file = join(directory, "profile.json");
  mkdirSync(join(directory, "private"));
  const privateFile = join(directory, "private", "model.json");
  writeFileSync(
    privateFile,
    JSON.stringify({
      apiKey: "synthetic-private-model-key",
      model: "openai/gpt-4.1-mini",
      expiresAt: "2030-01-01T00:00:00Z",
      maxRequests: 10,
      timeZone: "Europe/Prague",
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    file,
    JSON.stringify({
      ...profile(),
      adapters: {
        ...profile().adapters,
        model: { provider: "openrouter", configFile: "./private/model.json" },
      },
    }),
  );
  const config = loadServerConfig(file);
  expect(config.dataDirectory).toBe(join(directory, "state"));
  expect(config.adapters.model).toMatchObject({ configFile: privateFile });
  const original = global.fetch;
  const fetch = jest.fn();
  global.fetch = fetch;
  try {
    const adapters = loadServerAdapters(config);
    expect(adapters.model?.timeZone).toBe("Europe/Prague");
    expect(adapters.transcriber).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(directory, "state"))).toBe(false);
    expect(existsSync(join(directory, "private", "budget.sqlite"))).toBe(false);
    chmodSync(privateFile, 0o644);
    expect(() => loadServerAdapters(config)).toThrow(
      "Cannot load model adapter",
    );
  } finally {
    global.fetch = original;
  }
});
test.each([
  { version: 2 },
  { apiKey: "do-not-print-this-secret" },
  { listen: { host: "0.0.0.0", port: 8794 } },
  { listen: { port: 0 } },
  { sessionSeconds: 86400 },
  { allowedOrigins: ["*"] },
  { allowedOrigins: ["https://example.test/path"] },
  { allowedOrigins: ["https://user:password@example.test"] },
  {
    adapters: {
      ...profile().adapters,
      model: { provider: "remote-js", url: "https://example.test/run.js" },
    },
  },
  {
    adapters: {
      ...profile().adapters,
      model: {
        provider: "openrouter",
        configFile: "private.json",
        apiKey: "secret",
      },
    },
  },
  {
    adapters: {
      ...profile().adapters,
      crm: { provider: "twenty-test", configFile: "private.json" },
    },
  },
])("invalid or conflicting operator config is rejected: %j", (fields) => {
  const file = join(directory, "invalid.json");
  writeFileSync(file, JSON.stringify({ ...profile(), ...fields }));
  expect(() => loadServerConfig(file)).toThrow("Invalid server profile");
  expect(existsSync(join(directory, "state"))).toBe(false);
});
test("oversized and malformed files and missing private assets fail with sanitized errors", () => {
  const file = join(directory, "profile.json");
  writeFileSync(file, "do-not-print-private-content");
  expect(() => loadServerConfig(file)).toThrow("Invalid server profile");
  writeFileSync(file, " ".repeat(65537));
  expect(() => loadServerConfig(file)).toThrow("Invalid server profile");
  const config = ServerConfigSchema.parse({
    ...profile(),
    adapters: {
      ...profile().adapters,
      voice: {
        provider: "whisper.cpp",
        assetsDirectory: "/missing/do-not-print-private-path",
      },
    },
  });
  expect(() => loadServerAdapters(config)).toThrow("Cannot load voice adapter");
});

test("identity uses a profile-relative private directory and a canonical local listener origin", () => {
  const value = {
    ...profile(),
    administration: {
      keyFile: "./operator.json",
      identity: { directory: "./identities", baseURL: "http://localhost:8794" },
    },
  };
  const file = join(directory, "profile.json");
  writeFileSync(file, JSON.stringify(value));
  expect(loadServerConfig(file).administration?.identity).toEqual({
    directory: join(directory, "identities"),
    baseURL: "http://localhost:8794",
    accountSessionDays: 30,
    connectionOrigins: [],
    integrationOrigins: [],
    calendarCollections: [],
    mobile: { model: "disabled", voice: "disabled", sessionIdleDays: 30 },
    aiProfiles: { models: [], voices: [] },
    // Custom hosted servers run code on the machine: off unless the operator says so.
    hosting: { allowCustom: false, runtime: "auto" },
    hub: { scheduler: { intervalSeconds: 300, maxPerTick: 10, idleDays: 14 } },
    // Meeting sound is kept 30 days after processing.
    meetings: { audioRetentionDays: 30, glossary: [], chunkSeconds: 300 },
  });
  expect(existsSync(join(directory, "identities"))).toBe(false);
  expect(
    ServerConfigSchema.safeParse({
      ...value,
      administration: {
        ...value.administration,
        identity: {
          ...value.administration.identity,
          hosting: { allowCustom: "yes" },
        },
      },
    }).success,
  ).toBe(false);
  expect(
    ServerConfigSchema.safeParse({
      ...value,
      administration: {
        ...value.administration,
        identity: {
          ...value.administration.identity,
          hosting: { allowCustom: false, runtime: "podman" },
        },
      },
    }).success,
  ).toBe(false);
  for (const baseURL of [
    "http://example.com",
    "http://localhost:9999",
    "http://localhost:8794/path",
    "http://user:password@localhost:8794",
  ]) {
    expect(
      ServerConfigSchema.safeParse({
        ...value,
        administration: {
          ...value.administration,
          identity: { ...value.administration.identity, baseURL },
        },
      }).success,
    ).toBe(false);
  }
  expect(
    ServerConfigSchema.safeParse({
      ...value,
      administration: {
        ...value.administration,
        identity: {
          ...value.administration.identity,
          baseURL: "https://console.example.com",
        },
      },
    }).success,
  ).toBe(true);
  value.administration.identity.directory = "./state";
  writeFileSync(file, JSON.stringify(value));
  expect(() => loadServerConfig(file)).toThrow(
    "Identity and workflow directories must be separate",
  );
});

test("AI catalog IDs are bounded and unique, and private adapter paths resolve without network or budget", () => {
  const raw = {
    ...profile(),
    administration: {
      keyFile: "./key",
      identity: {
        directory: "./identity",
        baseURL: "http://localhost:8794",
        aiProfiles: {
          models: [
            { id: "fast", label: "TEST Fast", configFile: "./fast.json" },
          ],
          voices: [
            {
              id: "local",
              label: "TEST Local",
              adapter: { provider: "whisper.cpp", assetsDirectory: "./voice" },
            },
          ],
        },
      },
    },
  };
  const file = join(directory, "profile.json");
  writeFileSync(file, JSON.stringify(raw));
  const config = loadServerConfig(file);
  expect(
    config.administration!.identity!.aiProfiles.models[0]!.configFile,
  ).toBe(join(directory, "fast.json"));
  expect(
    config.administration!.identity!.aiProfiles.voices[0]!.adapter
      .assetsDirectory,
  ).toBe(join(directory, "voice"));
  for (const id of ["instance", "../../private", "", "invalid model"]) {
    const candidate = structuredClone(raw);
    candidate.administration.identity.aiProfiles.models[0]!.id = id;
    expect(ServerConfigSchema.safeParse(candidate).success).toBe(false);
  }
  const duplicate = structuredClone(raw);
  duplicate.administration.identity.aiProfiles.models.push({
    ...duplicate.administration.identity.aiProfiles.models[0]!,
  });
  expect(ServerConfigSchema.safeParse(duplicate).success).toBe(false);
  config.administration!.identity!.aiProfiles.voices = [];
  writeFileSync(
    join(directory, "fast.json"),
    JSON.stringify({
      apiKey: "TEST-private-catalog-key",
      model: "test/model",
      expiresAt: "2099-01-01T00:00:00Z",
      maxRequests: 5,
      timeZone: "Europe/Prague",
    }),
    { mode: 0o600 },
  );
  const original = global.fetch;
  const network = jest.fn();
  global.fetch = network;
  try {
    const adapters = loadServerAdapters(config);
    expect(adapters.aiProfiles?.models[0]?.adapter.timeZone).toBe(
      "Europe/Prague",
    );
    expect(network).not.toHaveBeenCalled();
    expect(existsSync(join(directory, "budget.sqlite"))).toBe(false);
  } finally {
    global.fetch = original;
  }
});

test("internal plugin configuration accepts shipped tools and named zones only", () => {
  expect(
    ServerConfigSchema.parse({ ...profile(), plugins: {} }).plugins,
  ).toEqual({ enabled: ["datetime"], timeZone: "UTC" });
  expect(
    ServerConfigSchema.parse({
      ...profile(),
      plugins: { enabled: [], timeZone: "Europe/Prague" },
    }).plugins,
  ).toEqual({ enabled: [], timeZone: "Europe/Prague" });
  for (const plugins of [
    { enabled: ["https://example.test/plugin.js"] },
    { enabled: ["datetime", "datetime"] },
    { timeZone: "invalid" },
    { timeZone: "+02:00" },
    { apiKey: "not-accepted" },
  ])
    expect(
      ServerConfigSchema.safeParse({ ...profile(), plugins }).success,
    ).toBe(false);
});

describe("SMTP settings from the environment", () => {
  const keys = [
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  });
  const withIdentity = () => {
    const file = join(directory, "profile.json");
    writeFileSync(
      file,
      JSON.stringify({
        ...profile(),
        administration: {
          keyFile: "./admin-key.json",
          identity: {
            directory: "./identities",
            baseURL: "http://localhost:8794",
            mail: {
              host: "127.0.0.1",
              port: 1025,
              secure: false,
              from: "local@example.test",
            },
          },
        },
      }),
    );
    return file;
  };

  test("an empty SMTP_HOST keeps the profile's mail settings", () => {
    process.env.SMTP_HOST = "";
    expect(
      loadServerConfig(withIdentity()).administration?.identity?.mail,
    ).toMatchObject({ host: "127.0.0.1", port: 1025 });
  });

  test("environment values replace the profile and keep the password out of it", () => {
    Object.assign(process.env, {
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: "465",
      SMTP_USER: "assistant",
      SMTP_PASSWORD: "TEST-smtp-secret",
      SMTP_FROM: "assistant@example.test",
    });
    delete process.env.SMTP_SECURE;
    expect(
      loadServerConfig(withIdentity()).administration?.identity?.mail,
    ).toEqual({
      host: "smtp.example.test",
      port: 465,
      secure: true,
      starttls: false,
      user: "assistant",
      password: "TEST-smtp-secret",
      from: "assistant@example.test",
    });
  });

  test("port 587 uses a required STARTTLS upgrade", () => {
    Object.assign(process.env, {
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: "587",
      SMTP_SECURE: "starttls",
      SMTP_FROM: "assistant@example.test",
    });
    expect(
      loadServerConfig(withIdentity()).administration?.identity?.mail,
    ).toMatchObject({ port: 587, secure: false, starttls: true });
  });

  test("the sender may carry a display name, quoted or not", () => {
    for (const from of [
      "Example Niaro <info@example.test>",
      '"Example Niaro" <info@example.test>',
    ]) {
      Object.assign(process.env, {
        SMTP_HOST: "smtp.example.test",
        SMTP_PORT: "587",
        SMTP_SECURE: "STARTTLS",
        SMTP_FROM: from,
      });
      expect(
        loadServerConfig(withIdentity()).administration?.identity?.mail,
      ).toMatchObject({ starttls: true, from });
    }
    for (const from of [
      "Example Niaro",
      "Example <not-an-address>",
      "a@example.test\r\nBcc: b@example.test",
    ]) {
      process.env.SMTP_FROM = from;
      expect(() => loadServerConfig(withIdentity())).toThrow(/SMTP settings/);
    }
  });

  test("unencrypted SMTP to a remote host is rejected", () => {
    Object.assign(process.env, {
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: "25",
      SMTP_SECURE: "false",
      SMTP_FROM: "assistant@example.test",
    });
    expect(() => loadServerConfig(withIdentity())).toThrow(/SMTP settings/);
  });
});
