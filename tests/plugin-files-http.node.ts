import { seedIdentityFixture } from "./helpers/identity-seed";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { openIdentity } from "../apps/server-identity/service";
import { issueAdminKey } from "../apps/server-admin/auth";
import { loadPlugins } from "../apps/server-plugins/catalog";
import { AUTH_PROFILE, PROFILE, CredentialSchema } from "../packages/protocol";
import {
  PluginFilesResultSchema,
  PluginFilesSchema,
  WorkspacePluginsSchema,
} from "../packages/protocol/workspace-plugins";
import type { IntegrationTransport } from "../apps/server-integrations/transport";
import type { ModelMessage } from "../apps/server-integrations/models";

const password = "TEST-plugin-files-password-2026";
test("plugin files: owners edit plugins in the console, validated, audited and switchable off", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "plugin-files-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST Plugin Files",
    listen: { port: address.port },
    dataDirectory: join(root, "workflow"),
    allowedOrigins: [],
    plugins: { enabled: ["datetime"], timeZone: "Europe/Prague" },
    administration: {
      keyFile: join(root, "key"),
      identity: { directory: join(root, "identity"), baseURL: origin },
    },
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  });
  // An operator plugin that does not load: the server starts and reports it.
  const pluginsDirectory = join(root, "identity", "plugins");
  mkdirSync(join(pluginsDirectory, "broken"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(join(pluginsDirectory, "broken", "plugin.json"), "{");
  writeFileSync(join(pluginsDirectory, "broken", "index.ts"), "");
  const key = issueAdminKey(config.administration!.keyFile);
  const requests: {
    tools?: { function: { name: string } }[];
    messages: ModelMessage[];
  }[] = [];
  // The model calls the operator's word counter when it is offered, then
  // answers with the tool's result.
  const integrationTransport: IntegrationTransport = async (req) => {
    assert(req.url.endsWith("/chat/completions"), "No service calls expected");
    await req.beforeDispatch?.(() => {});
    const body = req.body as (typeof requests)[number];
    requests.push(body);
    const current = body.messages.slice(
      body.messages.findLastIndex((message) => message.role === "user") + 1,
    );
    const result = current.findLast((message) => message.role === "tool");
    const offered = body.tools?.some(
      (tool) => tool.function.name === "internal_word_count_count",
    );
    const message = result
      ? { content: result.content }
      : offered
        ? {
            tool_calls: [
              {
                id: "TEST-call",
                type: "function",
                function: {
                  name: "internal_word_count_count",
                  arguments: JSON.stringify({ text: "one two  three" }),
                },
              },
            ],
          }
        : { content: "No plugin" };
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({ choices: [{ message }] }),
    };
  };
  let identity = await openIdentity(config, { integrationTransport });
  app = createReferenceServer(config, {}, identity);
  t.after(async () => {
    app.emit("close");
    await identity.close();
    await new Promise((r) => server.close(r));
    await loadPlugins();
    rmSync(root, { recursive: true, force: true });
  });
  const restart = async () => {
    app.emit("close");
    await identity.close();
    identity = await openIdentity(config, { integrationTransport });
    app = createReferenceServer(config, {}, identity);
  };
  function client() {
    const cookies = new Map<string, string>();
    return async (path: string, input?: unknown) => {
      const res = await fetch(origin + "/admin/" + path, {
        method: input === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      for (const c of res.headers.getSetCookie()) {
        const pair = c.split(";")[0]!,
          i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return { status: res.status, data: await res.json() };
    };
  }
  const owner = client(),
    admin = client(),
    member = client(),
    operator = client();
  await operator("api/login", { key });
  assert.equal(
    (
      await operator("api/identity/bootstrap", {
        name: "TEST Owner",
        email: "owner@example.test",
        password,
        organizationName: "TEST Plugin Files",
      })
    ).status,
    200,
  );
  await operator("api/login", { key });
  await owner("auth/sign-in/email", { email: "owner@example.test", password });
  const organizationId = (await owner("api/identity")).data.organizations[0].id;
  for (const role of ["admin", "member"])
    await seedIdentityFixture(identity, {
      organizationId,
      type: "createAccount",
      name: `TEST ${role}`,
      email: `${role}@example.test`,
      password,
      role,
    });
  const detail = (await owner(`api/identity/organization?id=${organizationId}`))
    .data;
  const workspaceId = detail.workspaces[0].id;
  const target = { organizationId, workspaceId };
  for (const role of ["admin", "member"])
    await seedIdentityFixture(identity, {
      organizationId,
      type: "setWorkspaceMember",
      workspaceId,
      memberId: detail.members.find((m: { role: string }) => m.role === role)
        .id,
      allowed: true,
    });
  await admin("auth/sign-in/email", { email: "admin@example.test", password });
  await member("auth/sign-in/email", {
    email: "member@example.test",
    password,
  });
  const inventory = async (who = owner) =>
    WorkspacePluginsSchema.parse(
      (await who(`api/identity/plugins?${new URLSearchParams(target)}`)).data,
    );
  const files = (pluginId: string, who = owner) =>
    who(
      `api/identity/plugin-files?${new URLSearchParams({ organizationId, pluginId })}`,
    );
  const change = async (value: object, who = owner) => {
    const response = await who("api/identity/plugin-files", {
      organizationId,
      ...value,
    });
    return {
      status: response.status,
      data:
        response.status === 200
          ? PluginFilesResultSchema.parse(response.data)
          : response.data,
    };
  };
  const builtIn = (name: string) =>
    readFileSync(join(process.cwd(), "plugins", "datetime", name), "utf8");

  await t.test(
    "an invalid operator plugin is reported to managers and skipped",
    async () => {
      const state = await inventory();
      assert.deepEqual(
        state.plugins.map((plugin) => [plugin.id, plugin.source]),
        [
          ["datetime", "built-in"],
          ["memory", "built-in"],
          ["web", "built-in"],
        ],
      );
      assert.equal(state.problems.length, 1);
      assert.equal(state.problems[0]!.directory, "broken");
      assert.match(state.problems[0]!.message, /plugin\.json is not JSON/);
      assert.deepEqual(state.editing, { allowed: true, disabled: false });
      assert.deepEqual((await inventory(admin)).editing, {
        allowed: false,
        disabled: false,
      });
      assert.deepEqual((await inventory(member)).problems, []);
      const broken = PluginFilesSchema.parse((await files("broken")).data);
      assert.equal(broken.source, null);
      assert.match(broken.problem!, /not JSON/);
    },
  );

  await t.test("only the owner opens and changes plugin files", async () => {
    const view = PluginFilesSchema.parse((await files("datetime")).data);
    assert.equal(view.source, "built-in");
    assert.equal(view.readOnly, false);
    assert.equal(view.files["index.ts"], builtIn("index.ts"));
    assert.equal(view.files["plugin.json"], builtIn("plugin.json"));
    for (const who of [admin, member]) {
      assert.equal((await files("datetime", who)).status, 403);
      assert.equal(
        (await change({ pluginId: "datetime", action: "create" }, who)).status,
        403,
      );
    }
    assert.equal((await files("missing")).status, 404);
    assert.equal((await files("../secret")).status, 400);
  });

  await t.test(
    "saving validates and loads first; an override replaces the built-in until reset",
    async () => {
      const broken = await change({
        pluginId: "datetime",
        action: "save",
        files: {
          "plugin.json": builtIn("plugin.json"),
          "index.ts": builtIn("index.ts").replace(
            "return definePlugin({ tools: [resolve] });",
            "return definePlugin({ tools: [] });",
          ),
        },
      });
      assert.equal(broken.data.outcome, "invalid");
      assert.match(broken.data.rejected, /missing in index\.ts/);
      assert.equal(broken.data.current.source, "built-in");
      assert.equal(existsSync(join(pluginsDirectory, "datetime")), false);

      const edited = {
        "plugin.json": builtIn("plugin.json"),
        "index.ts": builtIn("index.ts").replace(
          "Calculate exact dates/times",
          "TEST edited. Calculate exact dates/times",
        ),
      };
      const checked = await change({
        pluginId: "datetime",
        action: "check",
        files: edited,
      });
      assert.equal(checked.data.outcome, "valid");
      assert.equal(existsSync(join(pluginsDirectory, "datetime")), false);
      const saved = await change({
        pluginId: "datetime",
        action: "save",
        files: edited,
      });
      assert.equal(saved.data.outcome, "saved");
      assert.equal(saved.data.current.source, "override");
      assert.equal(saved.data.current.files["index.ts"], edited["index.ts"]);
      assert.equal(
        (await inventory()).plugins.find((p) => p.id === "datetime")!.source,
        "override",
      );
      const reset = await change({ pluginId: "datetime", action: "reset" });
      assert.equal(reset.data.outcome, "reset");
      assert.equal(reset.data.current.source, "built-in");
      assert.equal(
        (await change({ pluginId: "datetime", action: "reset" })).status,
        404,
      );
    },
  );

  await t.test(
    "a new plugin from the template reaches the agent once a workspace enables it",
    async () => {
      const created = await change({
        pluginId: "word-count",
        action: "create",
      });
      assert.equal(created.data.outcome, "created");
      assert.equal(created.data.current.source, "operator");
      assert.equal(
        (await change({ pluginId: "word-count", action: "create" })).status,
        409,
      );
      let state = await inventory();
      const plugin = state.plugins.find((p) => p.id === "word-count")!;
      assert.equal(plugin.available, true);
      assert.deepEqual(plugin.tools, ["internal_word_count_count"]);
      assert.equal(state.settings.enabled.includes("word-count"), false);
      const save = async (settings: object) =>
        owner("api/identity/plugins", {
          ...target,
          revision: (await inventory()).revision,
          settings: {
            enabled: ["datetime", "word-count"],
            timeZone: "Europe/Prague",
            ...settings,
          },
        });
      assert.equal(
        (await save({ settings: { "word-count": { countSpaces: "yes" } } }))
          .status,
        400,
      );
      assert.equal(
        (await save({ settings: { "word-count": { unknown: true } } })).status,
        400,
      );
      assert.equal(
        (await save({ settings: { "word-count": { countSpaces: true } } }))
          .status,
        200,
      );
      state = await inventory();
      assert.deepEqual(state.settings.settings, {
        "word-count": { countSpaces: true },
      });

      // Chat: the model sees the plugin's tool and gets its result.
      const catalog = (value: object) =>
        owner("api/identity/catalog/command", { ...target, ...value });
      const providerId = (
        await catalog({
          type: "saveProvider",
          revision: 0,
          settings: {
            name: "TEST AI",
            url: "https://models.example.test/v1",
            enabled: true,
            dailyRequestLimit: 100,
          },
        })
      ).data.id;
      await catalog({
        type: "importModels",
        providerId,
        providerRevision: 1,
        models: [{ model: "TEST-model", name: "TEST model", tools: true }],
      });
      const modelId = (
        await owner(`api/identity/catalog?${new URLSearchParams(target)}`)
      ).data.models[0].id;
      await catalog({
        type: "saveRouting",
        routing: { revision: 0, modelId, services: [] },
      });
      const grant = (await owner("api/identity/mobile/pairing", target)).data;
      const paired = await fetch(`${origin}/v1/${workspaceId}/auth/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authProfile: AUTH_PROFILE,
          profile: PROFILE,
          code: grant.code,
        }),
      });
      const credential = CredentialSchema.parse(await paired.json());
      const access = await identity.mobileAccess(
        `Bearer ${credential.accessToken}`,
        workspaceId,
        credential.scope.serverId,
      );
      const answer = await access.integrations!.message(
        randomUUID(),
        "TEST count words",
        "en",
        [],
        new AbortController().signal,
      );
      assert.deepEqual(JSON.parse(answer!.reply), {
        status: "resolved",
        values: { words: 3, characters: 14 },
      });
      const offered = requests[0]!.tools!.find(
        (tool) => tool.function.name === "internal_word_count_count",
      );
      assert(offered, "The plugin's tool reaches the model");

      // Deleting the operator plugin takes it out of the workspace.
      const deleted = await change({ pluginId: "word-count", action: "reset" });
      assert.equal(deleted.data.outcome, "deleted");
      assert.equal(deleted.data.current, null);
      assert.equal((await files("word-count")).status, 404);
      state = await inventory();
      assert.equal(
        state.plugins.some((p) => p.id === "word-count"),
        false,
      );
      assert.deepEqual(state.settings.enabled, ["datetime"]);
    },
  );

  await t.test("every change is audited", async () => {
    const entries = (
      await owner(
        `api/identity/audit?${new URLSearchParams({ organizationId })}`,
      )
    ).data.entries.filter(
      (entry: { action: string }) => entry.action === "server.plugin_changed",
    );
    assert.deepEqual(
      entries
        .map(
          (entry: {
            targetId: string;
            outcome: string;
            details: { pluginEvent: string };
          }) => [entry.targetId, entry.details.pluginEvent, entry.outcome],
        )
        .reverse(),
      [
        ["datetime", "refused", "failed"],
        ["datetime", "saved", "succeeded"],
        ["datetime", "reset", "succeeded"],
        ["word-count", "created", "succeeded"],
        ["word-count", "deleted", "succeeded"],
      ],
    );
  });

  await t.test("the operator's switch leaves the files read-only", async () => {
    config.administration!.identity!.pluginEditing = false;
    await restart();
    await owner("auth/sign-in/email", {
      email: "owner@example.test",
      password,
    });
    const view = PluginFilesSchema.parse((await files("datetime")).data);
    assert.equal(view.readOnly, true);
    assert.deepEqual((await inventory()).editing, {
      allowed: true,
      disabled: true,
    });
    const refused = await change({
      pluginId: "datetime",
      action: "save",
      files: view.files,
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.data.error, "plugin_editing_disabled");
    assert.equal(
      (await change({ pluginId: "hello", action: "create" })).status,
      403,
    );
    assert.equal(existsSync(join(pluginsDirectory, "hello")), false);
  });
});
