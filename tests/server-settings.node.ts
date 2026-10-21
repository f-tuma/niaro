import { seedIdentityFixture } from "./helpers/identity-seed";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { openIdentity } from "../apps/server-identity/service";
import { issueAdminKey } from "../apps/server-admin/auth";
import {
  ServerSettingsFileSchema,
  ServerSettingsViewSchema,
  serverSettingsOfFile,
  type ServerSettings,
} from "../packages/protocol/server-settings";
import { WorkspacePluginsSchema } from "../packages/protocol/workspace-plugins";

const password = "TEST-server-settings-password-2026";
test("server settings: profile defaults, owner and administrator writes, audit, export, import and restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "server-settings-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const profile = (audioRetentionDays: number) =>
    ServerConfigSchema.parse({
      version: 1,
      name: "TEST Settings",
      listen: { port: address.port },
      dataDirectory: join(root, "workflow"),
      allowedOrigins: ["http://localhost:8085"],
      plugins: { enabled: ["datetime"], timeZone: "Europe/Prague" },
      administration: {
        keyFile: join(root, "key"),
        identity: {
          directory: join(root, "identity"),
          baseURL: origin,
          integrationOrigins: ["http://127.0.0.1:9411"],
          meetings: { audioRetentionDays, glossary: ["TEST Niaro"] },
          hub: { scheduler: { intervalSeconds: 0 } },
        },
      },
      adapters: {
        model: { provider: "fixture" },
        voice: { provider: "disabled" },
        crm: { provider: "disabled" },
        calendar: { provider: "simulated" },
      },
    });
  let config = profile(30);
  const key = issueAdminKey(config.administration!.keyFile);
  let identity = await openIdentity(config, { hosting: { autostart: false } });
  app = createReferenceServer(config, {}, identity);
  const restart = async () => {
    app.emit("close");
    await identity.close();
    identity = await openIdentity(config, { hosting: { autostart: false } });
    app = createReferenceServer(config, {}, identity);
  };
  function client() {
    const cookies = new Map<string, string>();
    return async (
      path: string,
      input?: unknown,
      headers: Record<string, string> = {},
    ) => {
      const res = await fetch(origin + "/" + path, {
        method: input === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          ...headers,
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      for (const c of res.headers.getSetCookie()) {
        const pair = c.split(";")[0]!,
          i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return {
        status: res.status,
        headers: res.headers,
        data: await res.json().catch(() => null),
      };
    };
  }
  const owner = client(),
    admin = client(),
    member = client(),
    operator = client();
  try {
    await operator("admin/api/login", { key });
    assert.equal(
      (
        await operator("admin/api/identity/bootstrap", {
          name: "TEST Owner",
          email: "owner@example.test",
          password,
          organizationName: "TEST Settings",
        })
      ).status,
      200,
    );
    await owner("admin/auth/sign-in/email", {
      email: "owner@example.test",
      password,
    });
    const organizationId = (await owner("admin/api/identity")).data
      .organizations[0].id;
    await owner("admin/api/identity/command", {
      organizationId,
      type: "createWorkspace",
      name: "TEST Workspace",
    });
    for (const role of ["admin", "member"]) {
      await seedIdentityFixture(identity, {
        organizationId,
        type: "createAccount",
        name: `TEST ${role}`,
        email: `${role}@example.test`,
        password,
        role,
      });
    }
    await admin("admin/auth/sign-in/email", {
      email: "admin@example.test",
      password,
    });
    await member("admin/auth/sign-in/email", {
      email: "member@example.test",
      password,
    });
    const path = `admin/api/identity/server-settings?organizationId=${organizationId}`;
    const read = async (who = owner) =>
      ServerSettingsViewSchema.parse((await who(path)).data);
    const save = (settings: unknown, revision: number, who = owner) =>
      who("admin/api/identity/server-settings", {
        organizationId,
        revision,
        settings,
      });
    const audit = async () =>
      (
        await owner(
          `admin/api/identity/audit?organizationId=${organizationId}&category=changes`,
        )
      ).data.entries as { action: string; details: object }[];

    // The profile is the default of every setting.
    const initial = await read();
    const defaults: ServerSettings = {
      name: "TEST Settings",
      timeZone: "Europe/Prague",
      meetings: {
        audioRetentionDays: 30,
        glossary: ["TEST Niaro"],
        chunkSeconds: 300,
      },
      hubScheduler: { intervalSeconds: 0, maxPerTick: 10, idleDays: 14 },
      integrationOrigins: ["http://127.0.0.1:9411"],
      allowedOrigins: ["http://localhost:8085"],
    };
    assert.equal(initial.revision, 0);
    assert.deepEqual(initial.settings, defaults);
    assert.deepEqual(initial.defaults, defaults);
    assert.deepEqual(initial.restartPending, []);
    assert.equal((await read(admin)).revision, 0);

    // Owners and administrators only, from an account.
    assert.equal((await member(path)).status, 403);
    assert.equal((await save(defaults, 0, member)).status, 403);
    // The recovery key session has no account in the organization.
    assert.equal((await operator(path)).status, 403);
    assert.equal(
      (await owner(`admin/api/identity/server-settings/export`)).status,
      400,
    );
    assert.equal(
      (await owner("admin/api/identity/server-settings/other")).status,
      404,
    );

    // Validated with the profile's schema; a stale revision conflicts.
    for (const invalid of [
      { ...defaults, timeZone: "Mars/Olympus" },
      { ...defaults, name: "" },
      { ...defaults, meetings: { ...defaults.meetings, chunkSeconds: 60 } },
      { ...defaults, allowedOrigins: ["https://example.test/path"] },
      { ...defaults, dataDirectory: "/etc" },
    ])
      assert.equal((await save(invalid, 0)).status, 400);
    assert.equal((await save(defaults, 5)).status, 409);
    assert.equal((await read()).revision, 0);

    // Saved values apply at once, except the origins.
    const changed: ServerSettings = {
      ...defaults,
      name: "TEST Renamed",
      timeZone: "Asia/Tokyo",
      meetings: { audioRetentionDays: 0, glossary: [], chunkSeconds: 240 },
      hubScheduler: { intervalSeconds: 600, maxPerTick: 5, idleDays: 7 },
      integrationOrigins: ["http://127.0.0.1:9412"],
    };
    const saved = await save(changed, 0, admin);
    assert.equal(saved.status, 200);
    const view = ServerSettingsViewSchema.parse(saved.data);
    assert.equal(view.revision, 1);
    assert.deepEqual(view.settings, changed);
    assert.deepEqual(view.defaults, defaults);
    assert.deepEqual(view.restartPending, ["integrationOrigins"]);
    assert.equal(
      (await owner("admin/api/overview")).data.server.name,
      "TEST Renamed",
    );
    const workspaceId = (
      await owner(`admin/api/identity/organization?id=${organizationId}`)
    ).data.workspaces[0].id;
    assert.equal(
      WorkspacePluginsSchema.parse(
        (
          await owner(
            `admin/api/identity/plugins?organizationId=${organizationId}&workspaceId=${workspaceId}`,
          )
        ).data,
      ).settings.timeZone,
      "Asia/Tokyo",
    );
    assert.deepEqual(identity["hubScheduler"].settings, changed.hubScheduler);
    assert.equal(identity["hubScheduler"].active, true);
    assert.equal(identity["meetingProcessor"]["chunkSeconds"], 240);
    assert.equal(identity["meetingSweep"], undefined);
    assert.deepEqual(
      (await audit()).find(
        (entry) => entry.action === "server.settings_changed",
      )?.details,
      { previousRevision: 0, revision: 1 },
    );

    // Export: the settings only, no paths or secrets.
    assert.equal(
      (await member(path.replace("settings?", "settings/export?"))).status,
      403,
    );
    const exported = await owner(path.replace("settings?", "settings/export?"));
    assert.equal(exported.status, 200);
    const file = ServerSettingsFileSchema.parse(exported.data);
    assert.equal(file.profile, "niaro-server-settings");
    assert.equal(file.version, 1);
    assert.deepEqual(serverSettingsOfFile(file), changed);
    assert.ok(!JSON.stringify(exported.data).includes(root));

    // Import: the same schema, audited separately.
    const importPath = "admin/api/identity/server-settings/import";
    assert.equal(
      (
        await owner(importPath, {
          organizationId,
          revision: 1,
          file: { ...file, version: 2 },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await owner(importPath, {
          organizationId,
          revision: 1,
          file: { ...file, keyFile: "/data/admin-key.json" },
        })
      ).status,
      400,
    );
    assert.equal(
      (await member(importPath, { organizationId, revision: 1, file })).status,
      403,
    );
    const imported = await owner(importPath, {
      organizationId,
      revision: 1,
      file: {
        ...file,
        name: "TEST Imported",
        integrationOrigins: defaults.integrationOrigins,
        meetings: defaults.meetings,
      },
    });
    assert.equal(imported.status, 200);
    const afterImport = ServerSettingsViewSchema.parse(imported.data);
    assert.equal(afterImport.revision, 2);
    assert.equal(afterImport.settings.name, "TEST Imported");
    assert.deepEqual(afterImport.restartPending, []);
    assert.ok(identity["meetingSweep"]);
    assert.deepEqual(
      (await audit()).find(
        (entry) => entry.action === "server.settings_imported",
      )?.details,
      { previousRevision: 1, revision: 2 },
    );

    // After a restart the saved values are read at startup; a setting equal
    // to the profile keeps following the profile.
    await save({ ...afterImport.settings, allowedOrigins: [] }, 2);
    config = profile(45);
    await restart();
    const reopened = await read();
    assert.equal(reopened.settings.name, "TEST Imported");
    assert.equal(reopened.settings.timeZone, "Asia/Tokyo");
    assert.equal(reopened.settings.meetings.audioRetentionDays, 45);
    assert.deepEqual(reopened.settings.allowedOrigins, []);
    assert.deepEqual(reopened.restartPending, []);
    const cors = await fetch(`${origin}/v1/a/snapshot`, {
      headers: { Origin: "http://localhost:8085" },
    });
    assert.equal(cors.status, 403);
    await cors.body?.cancel();
  } finally {
    app!.emit("close");
    await identity.close();
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  }
});
