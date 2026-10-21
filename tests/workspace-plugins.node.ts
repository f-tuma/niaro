import { seedIdentityFixture } from "./helpers/identity-seed";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { openIdentity } from "../apps/server-identity/service";
import { issueAdminKey } from "../apps/server-admin/auth";
import { AUTH_PROFILE, PROFILE, CredentialSchema } from "../packages/protocol";
import {
  WorkspacePluginsSchema,
  WorkspacePluginPreviewSchema,
} from "../packages/protocol/workspace-plugins";
import type { IntegrationTransport } from "../apps/server-integrations/transport";
import type { ModelMessage } from "../apps/server-integrations/models";
import { messageCommand } from "../packages/client-core/commands";
import {
  ActivityResponseSchema,
  ACTIVITY_PROFILE,
  LEGACY_ACTIVITY_PROFILE,
} from "../packages/protocol/activity";

const password = "TEST-plugins-password-only-2026";
test("workspace plugins: authenticated configuration controls actual runtime and survives restart", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "workspace-plugins-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST Plugins",
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
  const key = issueAdminKey(config.administration!.keyFile);
  const requests: {
    tools?: { function: { name: string } }[];
    messages: ModelMessage[];
  }[] = [];
  let gate: (() => Promise<void>) | undefined;
  const integrationTransport: IntegrationTransport = async (req) => {
    assert(
      req.url.endsWith("/chat/completions"),
      "No service network calls expected",
    );
    await req.beforeDispatch?.(() => {});
    const body = req.body as (typeof requests)[number];
    requests.push(body);
    await gate?.();
    const currentMessages = body.messages.slice(
      body.messages.findLastIndex((message) => message.role === "user") + 1,
    );
    const result = body.tools?.some(
      (tool) => tool.function.name === "internal_datetime_resolve",
    )
      ? currentMessages.findLast((m) => m.role === "tool")
      : undefined;
    const timeZone = body.messages
      .findLast(
        (message) =>
          message.role === "system" &&
          message.content?.includes("Current time "),
      )
      ?.content?.match(/; timezone ([^ .]+)\./)?.[1];
    assert(
      timeZone,
      "The native model must receive the current authorized timezone",
    );
    const currentResult =
      result &&
      currentMessages.some((message) =>
        message.tool_calls?.some(
          (call) =>
            call.id === result.tool_call_id &&
            call.function.name === "internal_datetime_resolve",
        ),
      ) &&
      JSON.parse(result.content ?? "{}").values?.timeZone === timeZone
        ? result
        : undefined;
    if (currentResult)
      assert.notEqual(
        currentResult.tool_call_id,
        "TEST-provider-call",
        "Native history must use a server-generated call ID",
      );
    const message = currentResult
      ? { content: currentResult.content }
      : body.tools?.some(
            (tool) => tool.function.name === "internal_datetime_resolve",
          )
        ? {
            tool_calls: [
              {
                // Deliberate repetition proves that provider IDs cannot pair an old timezone receipt.
                id: "TEST-provider-call",
                type: "function",
                function: {
                  name: "internal_datetime_resolve",
                  arguments: JSON.stringify({
                    when: { kind: "date", date: "2026-09-29" },
                    time: "14:00",
                  }),
                },
              },
            ],
          }
        : { content: "Plugin disabled" };
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({ choices: [{ message }] }),
    };
  };
  const adapters = {};
  let identity = await openIdentity(config, { integrationTransport });
  app = createReferenceServer(config, adapters, identity);
  const restart = async () => {
    app.emit("close");
    await identity.close();
    identity = await openIdentity(config, { integrationTransport });
    app = createReferenceServer(config, adapters, identity);
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
  try {
    await operator("api/login", { key });
    assert.equal(
      (
        await operator("api/identity/bootstrap", {
          name: "TEST Owner",
          email: "owner@example.test",
          password,
          organizationName: "TEST Plugins",
        })
      ).status,
      200,
    );
    // Setup signed the operator in as the owner: back to the recovery key.
    await operator("api/login", { key });
    await owner("auth/sign-in/email", {
      email: "owner@example.test",
      password,
    });
    const organizationId = (await owner("api/identity")).data.organizations[0]
      .id;
    const command = (value: object) =>
      owner("api/identity/command", { organizationId, ...value });
    for (const name of ["TEST One", "TEST Two"])
      await command({ type: "createWorkspace", name });
    for (const role of ["admin", "member"])
      await seedIdentityFixture(identity, {
        organizationId,
        ...{
          type: "createAccount",
          name: `TEST ${role}`,
          email: `${role}@example.test`,
          password,
          role,
        },
      });
    const detail = (
      await owner(`api/identity/organization?id=${organizationId}`)
    ).data;
    // Setup's own first workspace ("TEST Plugins") is not used here.
    const named = (name: string) =>
      detail.workspaces.find((w: { name: string }) => w.name === name).id;
    const workspaceId = named("TEST One"),
      secondId = named("TEST Two");
    const target = { organizationId, workspaceId };
    await seedIdentityFixture(identity, {
      organizationId,
      ...{
        type: "setWorkspaceMember",
        workspaceId,
        memberId: detail.members.find(
          (m: { role: string }) => m.role === "member",
        ).id,
        allowed: true,
      },
    });
    await admin("auth/sign-in/email", {
      email: "admin@example.test",
      password,
    });
    await member("auth/sign-in/email", {
      email: "member@example.test",
      password,
    });
    const path = `api/identity/plugins?${new URLSearchParams(target)}`;
    const inventory = async () =>
      WorkspacePluginsSchema.parse((await owner(path)).data);
    const save = async (
      settings: { enabled: string[]; timeZone: string } | null,
      who = owner,
    ) =>
      who("api/identity/plugins", {
        ...target,
        revision: (await inventory()).revision,
        settings,
      });
    const previewInput = {
      when: { kind: "date", date: "2026-09-29" },
      time: "14:00",
      durationMinutes: 30,
    };
    const preview = async (input = previewInput, who = owner, overrides = {}) =>
      who("api/identity/plugins/preview", {
        ...target,
        revision: (await inventory()).revision,
        tool: "internal_datetime_resolve",
        input,
        ...overrides,
      });
    await t.test(
      "workspace access, administrator-only writes, strict validation, revision conflict and audit",
      async () => {
        const initial = await inventory();
        assert.equal(initial.revision, 0);
        assert.equal(initial.source, "server");
        assert.equal(initial.canManage, true);
        assert.deepEqual(initial.settings, {
          enabled: ["datetime"],
          timeZone: "Europe/Prague",
        });
        assert.equal((await member(path)).data.canManage, false);
        assert.equal((await operator(path)).status, 403);
        assert.equal((await save(null, member)).status, 403);
        assert.equal(
          (
            await owner(
              `api/identity/plugins?${new URLSearchParams({ ...target, organizationId: "TEST-foreign" })}`,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await member(
              `api/identity/plugins?${new URLSearchParams({ ...target, workspaceId: secondId })}`,
            )
          ).status,
          403,
        );
        for (const settings of [
          { enabled: ["remote"], timeZone: "UTC" },
          { enabled: ["datetime"], timeZone: "Fake/Zone" },
          { enabled: [], timeZone: "+02:00" },
        ])
          assert.equal((await save(settings)).status, 400);
        assert.equal(
          (
            await owner("api/identity/plugins", {
              ...target,
              revision: 0,
              settings: null,
              canManage: true,
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await save(
              { enabled: ["datetime"], timeZone: "Europe/London" },
              admin,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await owner("api/identity/plugins", {
              ...target,
              revision: 0,
              settings: null,
            })
          ).status,
          409,
        );
        assert.equal((await inventory()).revision, 1);
        assert.equal(
          (
            await owner(
              `api/identity/plugins?${new URLSearchParams({ ...target, workspaceId: secondId })}`,
            )
          ).data.settings.timeZone,
          "Europe/Prague",
        );
        const entries = (
          await owner(`api/identity/audit?organizationId=${organizationId}`)
        ).data.entries.filter(
          (e: { action: string }) => e.action === "workspace.plugins_changed",
        );
        assert.equal(entries.length, 1);
        assert.equal(entries[0].details.revision, 1);
        assert.equal(entries[0].workspaceId, workspaceId);
      },
    );
    await t.test(
      "plugin preview shares the executor, respects scope and settings, and has no side effects",
      async () => {
        const before = await inventory();
        const auditBefore = (
          await owner(`api/identity/audit?organizationId=${organizationId}`)
        ).data.entries.length;
        const start = Date.now();
        const response = await preview(previewInput, member);
        assert.equal(response.status, 200);
        const value = WorkspacePluginPreviewSchema.parse(response.data);
        assert.equal(value.timeZone, "Europe/London");
        assert(
          Date.parse(value.referenceNow) >= start &&
            Date.parse(value.referenceNow) <= Date.now(),
        );
        assert.equal(value.result.status, "resolved");
        if (value.result.status === "resolved") {
          assert.equal(value.result.values.utc, "2026-09-29T13:00:00.000Z");
          assert.equal(value.result.values.endUtc, "2026-09-29T13:30:00.000Z");
        }
        const elapsed = await preview(previewInput, owner, {
          input: { when: { kind: "elapsed", minutes: 60 } },
        });
        assert.equal(
          Date.parse(elapsed.data.result.values.utc) -
            Math.floor(Date.parse(elapsed.data.referenceNow) / 1000) * 1000,
          3600000,
        );
        assert.equal((await preview(previewInput, client())).status, 401);
        assert.equal((await preview(previewInput, operator)).status, 403);
        assert.equal(
          (await preview(previewInput, member, { workspaceId: secondId }))
            .status,
          403,
        );
        assert.equal(
          (
            await preview(previewInput, owner, {
              organizationId: "TEST-foreign",
            })
          ).status,
          403,
        );
        assert.equal((await owner("api/identity/plugins/preview")).status, 405);
        assert.equal(
          (await preview(previewInput, owner, { revision: 0 })).status,
          409,
        );
        for (const patch of [
          { tool: "external_action" },
          { referenceNow: "2026-01-01T00:00:00.000Z" },
          { input: { when: { kind: "elapsed", minutes: Infinity } } },
          { input: { ...previewInput, timeZone: "Fake/Zone" } },
        ])
          assert.equal((await preview(previewInput, owner, patch)).status, 400);
        const invalid = await preview({
          ...previewInput,
          when: { kind: "date", date: "2026-02-30" },
        });
        assert.equal(invalid.data.result.reason, "invalid_date");
        const gap = await preview(previewInput, owner, {
          input: {
            ...previewInput,
            when: { kind: "date", date: "2026-03-29" },
            time: "02:30",
            timeZone: "Europe/Prague",
          },
        });
        // Clock changes resolve like a calendar: skipped 02:30 becomes 03:30 CEST.
        assert.equal(gap.data.result.status, "resolved");
        assert.equal(gap.data.result.values.time, "03:30");
        const overlapInput = {
          ...previewInput,
          when: { kind: "date", date: "2026-10-25" },
          time: "02:30",
          timeZone: "Europe/Prague",
        };
        const overlap = await preview(previewInput, owner, {
          input: overlapInput,
        });
        // A repeated 02:30 is its first occurrence; an explicit offset picks the second.
        assert.equal(
          overlap.data.result.values.utc,
          "2026-10-25T00:30:00.000Z",
        );
        const resolved = await preview(previewInput, owner, {
          input: { ...overlapInput, utcOffset: "+01:00" },
        });
        assert.equal(
          resolved.data.result.values.utc,
          "2026-10-25T01:30:00.000Z",
        );
        assert.deepEqual(await inventory(), before);
        assert.equal(
          (await owner(`api/identity/audit?organizationId=${organizationId}`))
            .data.entries.length,
          auditBefore,
        );
        assert.equal(
          requests.length,
          0,
          "Preview must not call providers or services",
        );
        await save({ enabled: [], timeZone: "Europe/London" });
        assert.equal((await preview()).status, 403);
        await save({ enabled: ["datetime"], timeZone: "Europe/London" });
      },
    );
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
    const access = () =>
      identity.mobileAccess(
        `Bearer ${credential.accessToken}`,
        workspaceId,
        credential.scope.serverId,
      );
    const run = async () =>
      (await access()).integrations!.message(
        randomUUID(),
        "TEST calculate date",
        "en",
        [],
        new AbortController().signal,
      );
    await t.test(
      "chat exposes completed plugin use during real inference, negotiates legacy activity, and replays without work",
      async () => {
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>((r) => {
          entered = r;
        });
        const wait = new Promise<void>((r) => {
          release = r;
        });
        gate = async () => {
          const messages = requests.at(-1)?.messages ?? [];
          if (
            messages
              .slice(
                messages.findLastIndex((message) => message.role === "user") +
                  1,
              )
              .some((m) => m.role === "tool")
          ) {
            entered();
            await wait;
          }
        };
        const command = messageCommand(
          "TEST date calculation",
          "en",
          "TEST-plugin-activity",
        );
        const call = async (path: string, body?: unknown) => {
          const response = await fetch(`${origin}/v1/${workspaceId}/${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              Authorization: `Bearer ${credential.accessToken}`,
              "Content-Type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
          });
          assert.equal(response.status, body === undefined ? 200 : 202);
          return response.json();
        };
        const pending = call("commands", command);
        const path = `activity?commandId=${command.commandId}`;
        try {
          await Promise.race([
            started,
            pending.then(() => {
              throw Error("Command finished before progress gate");
            }),
          ]);
          const live = ActivityResponseSchema.parse(
            await call(`${path}&profile=${ACTIVITY_PROFILE}`),
          );
          assert.equal(live.profile, ACTIVITY_PROFILE);
          assert.equal(live.activity?.status, "running");
          assert.deepEqual(live.activity?.steps, [
            { id: "understanding", status: "running" },
            { id: "preparing", status: "pending" },
          ]);
          assert.deepEqual(
            live.activity && "tools" in live.activity
              ? live.activity.tools
              : null,
            [{ id: "datetime", status: "succeeded", calls: 1 }],
          );
          const legacy = ActivityResponseSchema.parse(await call(path));
          assert.equal(legacy.profile, LEGACY_ACTIVITY_PROFILE);
          assert(!("tools" in legacy.activity!));
          assert.equal(legacy.activity?.status, "running");
          assert(
            !JSON.stringify(live.activity).includes("2026-09-29"),
            "Only bounded tool status is exposed, not inputs/results",
          );
        } finally {
          gate = undefined;
          release();
        }
        assert.equal((await pending).status, "accepted");
        assert.equal(
          ActivityResponseSchema.parse(
            await call(`${path}&profile=${ACTIVITY_PROFILE}`),
          ).activity?.status,
          "succeeded",
        );
        const count = requests.length;
        await call("commands", command);
        assert.equal(requests.length, count);
      },
    );
    await t.test(
      "saved timezone and enablement immediately control actual model tools and survive restart",
      async () => {
        // Without a device timezone the workspace's saved one applies.
        const before = requests.length;
        const first = await run();
        assert.equal(
          JSON.parse(first!.reply).values.utc,
          "2026-09-29T13:00:00.000Z",
        );
        assert(
          requests[before]!.messages[0]!.content!.includes("Europe/London"),
        );
        await save({ enabled: [], timeZone: "Asia/Tokyo" });
        assert.equal((await run())!.reply, "Plugin disabled");
        await restart();
        assert.equal((await inventory()).source, "workspace");
        assert.deepEqual((await inventory()).settings, {
          enabled: [],
          timeZone: "Asia/Tokyo",
        });
        assert.equal((await run())!.reply, "Plugin disabled");
        await save(null);
        assert.equal((await inventory()).source, "server");
        const resetBefore = requests.length;
        const reset = await run();
        assert.equal(
          JSON.parse(reset!.reply).values.utc,
          "2026-09-29T12:00:00.000Z",
        );
        assert.equal(JSON.parse(reset!.reply).values.timeZone, "Europe/Prague");
        assert.equal(
          requests.length - resetBefore,
          2,
          "The new turn must execute the native datetime tool before answering",
        );
      },
    );
    await t.test(
      "changing plugin settings invalidates an in-flight inference before using its result",
      async () => {
        let entered!: () => void, release!: () => void;
        const start = new Promise<void>((r) => {
          entered = r;
        });
        const wait = new Promise<void>((r) => {
          release = r;
        });
        gate = async () => {
          entered();
          await wait;
        };
        const pending = run();
        const rejected = assert.rejects(pending, /model_unavailable/);
        try {
          await start;
          await save({ enabled: [], timeZone: "UTC" });
        } finally {
          gate = undefined;
          release();
        }
        await rejected;
        assert.equal((await run())!.reply, "Plugin disabled");
      },
    );
    await t.test(
      "workspace settings cannot re-enable an operator-disabled plugin",
      async () => {
        await save({ enabled: ["datetime"], timeZone: "Europe/London" });
        config.plugins = { enabled: [], timeZone: "UTC" };
        await restart();
        const state = await inventory();
        assert.equal(state.plugins[0]!.available, false);
        assert.deepEqual(state.settings.enabled, []);
        assert.equal((await preview()).status, 403);
        assert.equal(
          (await save({ enabled: ["datetime"], timeZone: "UTC" })).status,
          403,
        );
        assert.equal((await run())!.reply, "Plugin disabled");
        assert.equal((await save(null)).status, 200);
        assert.deepEqual((await inventory()).settings, {
          enabled: [],
          timeZone: "UTC",
        });
      },
    );
  } finally {
    app.emit("close");
    await identity.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
