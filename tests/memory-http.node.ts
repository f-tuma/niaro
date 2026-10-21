import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { issueAdminKey } from "../apps/server-admin/auth";
import { openIdentity } from "../apps/server-identity/service";
import { AuditPage } from "../packages/protocol/audit";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../packages/protocol/identity";
import {
  MemoryViewSchema,
  type MemoryItem,
  type MemoryView,
} from "../packages/protocol/memory";
import { WorkspacePluginsSchema } from "../packages/protocol/workspace-plugins";
import { seedIdentityFixture } from "./helpers/identity-seed";

type Result = { status: number; data: unknown };
type Client = (path: string, input?: unknown) => Promise<Result>;
const password = "TEST-memory-console-password-only-2026";

test("memory HTTP: authenticated settings, isolated records, corrections and erasure", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "memory-http-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const memorySettings = {
    retentionDays: 365,
    maxContextChars: 8000,
    maxItems: 10,
    allowShared: true,
  };
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST Memory",
    listen: { port: address.port },
    dataDirectory: join(root, "workflow"),
    allowedOrigins: [],
    plugins: {
      enabled: ["datetime", "memory"],
      timeZone: "Europe/Prague",
      memory: memorySettings,
    },
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
  const integrationTransport = async () => {
    throw new Error(
      "This memory HTTP test must never dispatch a model or external service",
    );
  };
  let identity = await openIdentity(config, { integrationTransport });
  app = createReferenceServer(config, {}, identity);
  function client(): Client {
    const cookies = new Map<string, string>();
    return async (path, input) => {
      const response = await fetch(origin + "/admin/" + path, {
        method: input === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...cookies]
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!,
          split = pair.indexOf("=");
        cookies.set(pair.slice(0, split), pair.slice(split + 1));
      }
      return {
        status: response.status,
        data: (await response.json()) as unknown,
      };
    };
  }
  const owner = client(),
    admin = client(),
    member = client(),
    operator = client(),
    anonymous = client();
  const restart = async () => {
    app.emit("close");
    await identity.close();
    identity = await openIdentity(config, { integrationTransport });
    app = createReferenceServer(config, {}, identity);
  };
  try {
    assert.equal((await operator("api/login", { key })).status, 200);
    assert.equal(
      (
        await operator("api/identity/bootstrap", {
          name: "TEST Memory Owner",
          email: "owner-memory@example.test",
          password,
          organizationName: "TEST Memory tenant",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await owner("auth/sign-in/email", {
          email: "owner-memory@example.test",
          password,
        })
      ).status,
      200,
    );
    const state = IdentityStateSchema.parse((await owner("api/identity")).data);
    const organizationId = state.organizations[0]!.id;
    for (const name of ["TEST Memory One", "TEST Memory Two"])
      assert.equal(
        (
          await owner("api/identity/command", {
            type: "createWorkspace",
            organizationId,
            name,
          })
        ).status,
        200,
      );
    for (const role of ["admin", "member"] as const)
      await seedIdentityFixture(identity, {
        type: "createAccount",
        organizationId,
        name: `TEST Memory ${role}`,
        email: `${role}-memory@example.test`,
        password,
        role,
      });
    const detail = OrganizationDetailSchema.parse(
      (await owner(`api/identity/organization?id=${organizationId}`)).data,
    );
    const workspaceId = detail.workspaces[0]!.id,
      secondId = detail.workspaces[1]!.id;
    await seedIdentityFixture(identity, {
      type: "setWorkspaceMember",
      organizationId,
      workspaceId,
      memberId: detail.members.find((entry) => entry.role === "member")!.id,
      allowed: true,
    });
    assert.equal(
      (
        await admin("auth/sign-in/email", {
          email: "admin-memory@example.test",
          password,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await member("auth/sign-in/email", {
          email: "member-memory@example.test",
          password,
        })
      ).status,
      200,
    );
    const target = { organizationId, workspaceId };
    const path = (changes = {}) =>
      `api/identity/memory?${new URLSearchParams({ ...target, ...changes })}`;
    const read = async (
      who: Client = owner,
      changes = {},
    ): Promise<MemoryView> => {
      const result = await who(path(changes));
      assert.equal(result.status, 200, JSON.stringify(result.data));
      return MemoryViewSchema.parse(result.data);
    };
    const mutate = (command: object, who: Client = owner, changes = {}) =>
      who("api/identity/memory", {
        ...target,
        requestId: randomUUID(),
        ...command,
        ...changes,
      });
    const remember = async (
      content: string,
      who: Client = owner,
      scope: "private" | "workspace" = "private",
    ) => {
      const result = await mutate(
        { type: "remember", content, kind: "fact", scope },
        who,
      );
      assert.equal(result.status, 200, JSON.stringify(result.data));
      const view = MemoryViewSchema.parse(result.data);
      const item = view.items.find((entry) => entry.content === content);
      assert(item);
      return item;
    };
    const pluginsPath = `api/identity/plugins?${new URLSearchParams(target)}`;
    const plugins = async () =>
      WorkspacePluginsSchema.parse((await owner(pluginsPath)).data);
    const savePlugins = async (settings: unknown) =>
      owner("api/identity/plugins", {
        ...target,
        revision: (await plugins()).revision,
        settings,
      });
    const audit = async () =>
      AuditPage.parse(
        (await owner(`api/identity/audit?organizationId=${organizationId}`))
          .data,
      ).entries.filter((entry) => entry.action.startsWith("memory."));
    let ownerItem: MemoryItem, memberItem: MemoryItem;

    await t.test(
      "membership is required and payloads cannot override user, source, trust or authenticated scope",
      async () => {
        const initial = await read();
        assert.equal(initial.enabled, true);
        assert.equal(initial.canManageShared, true);
        assert.equal(initial.optOut, false);
        assert.equal((await read(member)).canManageShared, false);
        assert.equal((await operator(path())).status, 403);
        assert.equal((await anonymous(path())).status, 401);
        assert.equal(
          (await owner(path({ organizationId: "TEST-foreign-org" }))).status,
          403,
        );
        assert.equal(
          (await owner(path({ workspaceId: "TEST-foreign-workspace" }))).status,
          404,
        );
        assert.equal(
          (await member(path({ workspaceId: secondId }))).status,
          403,
        );
        for (const extra of [
          { userId: state.user!.id },
          { source: { type: "user_note" } },
          { trust: "verified_result" },
          { status: "active" },
          { canManageShared: true },
        ])
          assert.equal(
            (
              await mutate(
                {
                  type: "remember",
                  content: "TEST unauthorized metadata",
                  kind: "note",
                  ...extra,
                },
                member,
              )
            ).status,
            400,
          );
        assert.equal(
          (
            await mutate(
              { type: "remember", content: "TEST foreign", kind: "note" },
              member,
              { workspaceId: secondId },
            )
          ).status,
          403,
        );
        assert.deepEqual((await read()).items, []);
      },
    );

    await t.test(
      "each member can save only their own private memory and other workspaces stay isolated",
      async () => {
        ownerItem = await remember("TEST owner-only synthetic secret");
        memberItem = await remember(
          "TEST member-only synthetic secret",
          member,
        );
        assert.equal(ownerItem.source?.type, "user_note");
        assert.equal(ownerItem.trust, "user_assertion");
        assert.equal(ownerItem.status, "active");
        assert.deepEqual(
          (await read()).items.map((entry) => entry.id),
          [ownerItem.id],
        );
        assert.deepEqual(
          (await read(member)).items.map((entry) => entry.id),
          [memberItem.id],
        );
        assert.deepEqual((await read(admin)).items, []);
        assert.deepEqual(
          (await read(owner, { workspaceId: secondId })).items,
          [],
        );
        assert.equal(
          (
            await mutate(
              { type: "forget", id: ownerItem.id, revision: 1 },
              member,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await mutate(
              { type: "forget", id: ownerItem.id, revision: 1 },
              owner,
              { workspaceId: secondId },
            )
          ).status,
          404,
        );
      },
    );

    await t.test(
      "shared records are readable by members and writable only by privileged workspace managers",
      async () => {
        const shared = await remember(
          "TEST shared workspace fact",
          owner,
          "workspace",
        );
        const adminShared = await remember(
          "TEST administrator shared workspace fact",
          admin,
          "workspace",
        );
        const memberView = await read(member);
        assert(memberView.items.some((entry) => entry.id === shared.id));
        assert(memberView.items.some((entry) => entry.id === adminShared.id));
        assert.equal(
          (
            await mutate(
              {
                type: "remember",
                content: "TEST forbidden shared",
                kind: "fact",
                scope: "workspace",
              },
              member,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await mutate(
              {
                type: "revise",
                id: shared.id,
                revision: 1,
                content: "TEST forbidden correction",
              },
              member,
            )
          ).status,
          403,
        );
        assert.equal(
          (await mutate({ type: "forget", id: shared.id, revision: 1 }, member))
            .status,
          403,
        );
        assert.equal(
          (await mutate({ type: "forget", id: shared.id, revision: 1 }, admin))
            .status,
          200,
        );
        assert.equal(
          (await mutate({ type: "forget", id: adminShared.id, revision: 1 }))
            .status,
          200,
        );
        assert.equal(
          (await read(member)).items.some(
            (entry) => entry.scope === "workspace",
          ),
          false,
        );
      },
    );

    await t.test(
      "optimistic corrections supersede the original; stale updates and receipt reuse are rejected",
      async () => {
        const requestId = randomUUID();
        const command = {
          type: "remember",
          content: "TEST sensitive preference before correction",
          kind: "preference",
          scope: "private",
        };
        const saved = MemoryViewSchema.parse(
          (await mutate(command, owner, { requestId })).data,
        );
        const original = saved.items.find(
          (entry) => entry.content === command.content,
        )!;
        assert(original);
        const replay = MemoryViewSchema.parse(
          (await mutate(command, owner, { requestId })).data,
        );
        assert.equal(replay.version, saved.version);
        assert.equal(
          replay.items.filter((entry) => entry.id === original.id).length,
          1,
        );
        assert.equal(
          (
            await mutate(
              { ...command, content: "TEST changed same receipt" },
              owner,
              { requestId },
            )
          ).status,
          409,
        );
        const revision = {
          type: "revise",
          id: original.id,
          revision: 1,
          content: "TEST sensitive preference after correction",
        };
        const revised = MemoryViewSchema.parse((await mutate(revision)).data);
        const next = revised.items.find(
          (entry) => entry.content === revision.content,
        )!;
        assert(next);
        assert.equal(next.supersedesId, original.id);
        assert.equal(
          revised.items.find((entry) => entry.id === original.id)?.status,
          "superseded",
        );
        assert.equal((await mutate(revision)).status, 409);
        assert.equal(
          (await mutate({ type: "forget", id: next.id, revision: 2 })).status,
          409,
        );
        const forgetRequestId = randomUUID();
        const forgotten = MemoryViewSchema.parse(
          (
            await mutate({ type: "forget", id: next.id, revision: 1 }, owner, {
              requestId: forgetRequestId,
            })
          ).data,
        );
        assert.equal(
          forgotten.items.some(
            (entry) => entry.id === original.id || entry.id === next.id,
          ),
          false,
        );
        const entries = await audit();
        const again = MemoryViewSchema.parse(
          (
            await mutate({ type: "forget", id: next.id, revision: 1 }, owner, {
              requestId: forgetRequestId,
            })
          ).data,
        );
        assert.equal(again.version, forgotten.version);
        assert.equal((await audit()).length, entries.length);
        const replayForgotten = MemoryViewSchema.parse(
          (await mutate(command, owner, { requestId })).data,
        );
        assert.equal(replayForgotten.version, forgotten.version);
        assert.equal(
          replayForgotten.items.some((entry) => entry.id === original.id),
          false,
        );
        assert.equal(
          JSON.stringify(await audit()).includes("sensitive preference"),
          false,
        );
        assert(
          entries.every((entry) => Object.keys(entry.details).length === 0),
        );
      },
    );

    await t.test(
      "personal opt-out persists across restart, blocks writes and keeps inspect/forget available",
      async () => {
        const disabled = MemoryViewSchema.parse(
          (await mutate({ type: "preference", optOut: true }, member)).data,
        );
        assert.equal(disabled.optOut, true);
        assert(disabled.items.some((entry) => entry.id === memberItem.id));
        assert.equal((await read()).optOut, false);
        const denied = await mutate(
          { type: "remember", content: "TEST opted-out note", kind: "note" },
          member,
        );
        assert.equal(denied.status, 403);
        assert.deepEqual(denied.data, { error: "memory_opted_out" });
        await restart();
        assert.equal((await read(member)).optOut, true);
        assert.equal(
          (
            await mutate(
              { type: "forget", id: memberItem.id, revision: 1 },
              member,
            )
          ).status,
          200,
        );
        assert.deepEqual((await read(member)).items, []);
        assert.equal(
          MemoryViewSchema.parse(
            (await mutate({ type: "preference", optOut: false }, member)).data,
          ).optOut,
          false,
        );
      },
    );

    await t.test(
      "disabled plugin blocks remember/revise and still permits viewing and forgetting existing notes",
      async () => {
        assert.equal(
          (
            await savePlugins({
              enabled: ["datetime"],
              timeZone: "Europe/Prague",
              memory: memorySettings,
            })
          ).status,
          200,
        );
        const disabled = await read();
        assert.equal(disabled.enabled, false);
        assert(disabled.items.some((entry) => entry.id === ownerItem.id));
        assert.equal(
          (
            await mutate({
              type: "remember",
              content: "TEST plugin disabled",
              kind: "note",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await mutate({
              type: "revise",
              id: ownerItem.id,
              revision: 1,
              content: "TEST plugin disabled correction",
            })
          ).status,
          403,
        );
        assert.equal(
          (await mutate({ type: "forget", id: ownerItem.id, revision: 1 }))
            .status,
          200,
        );
        assert.equal(
          (await read()).items.some((entry) => entry.id === ownerItem.id),
          false,
        );
        assert.equal((await savePlugins(null)).status, 200);
        assert.equal((await read()).enabled, true);
      },
    );

    await t.test(
      "saved workspace settings are narrowed when the operator lowers explicit memory limits after restart",
      async () => {
        const workspaceLimits = {
          retentionDays: 180,
          maxContextChars: 6000,
          maxItems: 8,
          allowShared: true,
        };
        assert.equal(
          (
            await savePlugins({
              enabled: ["datetime", "memory"],
              timeZone: "Europe/Prague",
              memory: workspaceLimits,
            })
          ).status,
          200,
        );
        const lower = {
          retentionDays: 30,
          maxContextChars: 1000,
          maxItems: 2,
          allowShared: false,
        };
        config.plugins = {
          enabled: ["datetime", "memory"],
          timeZone: "Europe/Prague",
          memory: lower,
        };
        await restart();
        assert.deepEqual((await plugins()).settings.memory, lower);
        assert.equal((await read()).enabled, true);
        assert.equal(
          (
            await mutate({
              type: "remember",
              content: "TEST shared denied by lower operator cap",
              kind: "fact",
              scope: "workspace",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await savePlugins({
              enabled: ["memory"],
              timeZone: "Europe/Prague",
              memory: workspaceLimits,
            })
          ).status,
          403,
        );
        const note = await remember("TEST new note uses current retention cap");
        assert.equal(
          Date.parse(note.expiresAt!) - Date.parse(note.createdAt),
          30 * 86_400_000,
        );
      },
    );
  } finally {
    app.emit("close");
    await identity.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
