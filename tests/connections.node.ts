import { seedIdentityFixture } from "./helpers/identity-seed";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openIdentity } from "../apps/server-identity/service";
import { createAdminHandler } from "../apps/server-admin/http";
import { issueAdminKey } from "../apps/server-admin/auth";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { AuditPage } from "../packages/protocol/audit";
import { WorkspaceConnectionsSchema } from "../packages/protocol/connections";

const password = "TEST-workspace-password-123";
const apiKey = "TEST-synthetic-connector-key-never-real";
test("Workspace connections: vault, isolation, grants, dispatch, live revocation and restart", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-connections-test-"));
  for (const name of ["index.html", "app.js", "app.css"])
    writeFileSync(join(root, name), "TEST");
  let handler: ReturnType<typeof createAdminHandler>;
  const server = createServer((req, res) => {
    void handler(req, res, []);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST connectors",
    listen: { port: address.port },
    dataDirectory: join(root, "workflow"),
    allowedOrigins: [],
    administration: {
      keyFile: join(root, "key"),
      identity: {
        directory: join(root, "identity"),
        baseURL: origin,
        connectionOrigins: ["https://crm.example.test"],
      },
    },
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  });
  const key = issueAdminKey(config.administration!.keyFile);
  let calls = 0;
  let expectedKey = apiKey;
  let failed = false;
  let gate: { started: () => void; wait: Promise<void> } | undefined;
  const transport: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(new URL(String(url)).origin, "https://crm.example.test");
    assert.equal(new URL(String(url)).pathname, "/rest/people");
    assert.equal(
      new URL(String(url)).searchParams.get("filter"),
      'name.firstName[like]:"TEST%"',
    );
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      `Bearer ${expectedKey}`,
    );
    const held = gate;
    if (held) {
      held.started();
      await held.wait;
    }
    init?.signal?.throwIfAborted();
    if (failed) throw Error(`provider-error-${expectedKey}`);
    return Response.json({
      data: {
        people: [
          {
            id: "5a77bcbd-b43d-46ac-bd05-c9f211e61615",
            name: { firstName: "TEST Jana", lastName: "Nováková" },
            emails: { primaryEmail: "jana@example.test" },
          },
          {
            id: "5a77bcbd-b43d-46ac-bd05-c9f211e61616",
            name: { firstName: "Real", lastName: "Person" },
          },
        ],
      },
    });
  };
  let identity = await openIdentity(config, { connectionTransport: transport });
  handler = createAdminHandler(config, () => [], {
    identity,
    assetsDirectory: root,
  });
  const db = new DatabaseSync(join(root, "identity", "identity.sqlite"));
  function client() {
    const cookies = new Map<string, string>();
    return async (path: string, input?: unknown) => {
      const response = await fetch(`${origin}/admin/${path}`, {
        method: input === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(5000),
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!;
        const i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return { status: response.status, data: await response.json() };
    };
  }
  const owner = client(),
    member = client(),
    outsider = client(),
    operator = client();
  try {
    await operator("api/login", { key });
    assert.equal(
      (
        await operator("api/identity/bootstrap", {
          name: "TEST Owner",
          email: "owner@example.test",
          password,
          organizationName: "TEST Alpha",
        })
      ).status,
      200,
    );
    // Setup signed this browser in as the owner: back to the recovery key.
    await operator("api/login", { key });
    await owner("auth/sign-in/email", {
      email: "owner@example.test",
      password,
    });
    const state = (await owner("api/identity")).data;
    const organizationId: string = state.organizations[0].id;
    const identityCommand = (type: string, rest: object) =>
      owner("api/identity/command", { type, organizationId, ...rest });
    await identityCommand("createWorkspace", { name: "TEST Sales" });
    await identityCommand("createWorkspace", { name: "TEST Other" });
    await seedIdentityFixture(identity, {
      type: "createAccount",
      organizationId,
      ...{
        name: "TEST Member",
        email: "member@example.test",
        password,
        role: "member",
      },
    });
    await seedIdentityFixture(identity, {
      type: "createAccount",
      organizationId,
      ...{
        name: "TEST Outsider",
        email: "outsider@example.test",
        password,
        role: "member",
      },
    });
    const detail = (
      await owner(`api/identity/organization?id=${organizationId}`)
    ).data;
    const workspaceId: string = detail.workspaces.find(
      (w: { name: string }) => w.name === "TEST Sales",
    ).id;
    const otherWorkspaceId: string = detail.workspaces.find(
      (w: { name: string }) => w.name === "TEST Other",
    ).id;
    const memberId: string = detail.members.find(
      (m: { email: string }) => m.email === "member@example.test",
    ).id;
    const outsiderUserId: string = detail.members.find(
      (m: { email: string }) => m.email === "outsider@example.test",
    ).userId;
    await member("auth/sign-in/email", {
      email: "member@example.test",
      password,
    });
    await outsider("auth/sign-in/email", {
      email: "outsider@example.test",
      password,
    });
    db.prepare(
      'INSERT INTO organization (id,name,slug,"createdAt") VALUES (?,?,?,?)',
    ).run("test-beta", "TEST Beta", "test-beta", Date.now());
    db.prepare(
      'INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES (?,?,?,?,?)',
    ).run("beta-owner", "test-beta", outsiderUserId, "owner", Date.now());
    const target = { organizationId, workspaceId };
    const path = `api/identity/connections?${new URLSearchParams(target)}`;
    const command = (values: object) =>
      owner("api/identity/connections/command", { ...target, ...values });
    const list = async () =>
      WorkspaceConnectionsSchema.parse((await owner(path)).data);
    const create = {
      type: "create",
      name: "TEST Twenty",
      provider: "twenty-test",
      origin: "https://crm.example.test",
      apiKey,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    let connectionId = "";
    let revision = 1;
    const refresh = async () => {
      const connection = (await list()).connections[0]!;
      connectionId = connection.id;
      revision = connection.revision;
      return connection;
    };
    const invoke = (who = owner, rest: object = {}) =>
      who("api/identity/connections/invoke", {
        ...target,
        connectionId,
        revision,
        toolId: "crm.contacts.list",
        input: {},
        ...rest,
      });
    const configure = async (enabled = true, roles = ["owner", "member"]) => {
      const response = await command({
        type: "configure",
        connectionId,
        revision,
        enabled,
        grants: [
          { toolId: "crm.contacts.list", roles },
          { toolId: "crm.contacts.search", roles: ["owner"] },
        ],
      });
      assert.equal(response.status, 200);
      await refresh();
    };
    await t.test(
      "default deny, write-only credentials, exact origin and no implicit I/O",
      async () => {
        assert.equal((await owner(path)).status, 200);
        assert.equal((await operator(path)).status, 403);
        assert.equal((await member(path)).status, 403);
        assert.equal(
          (await command({ ...create, origin: "https://untrusted.example" }))
            .status,
          403,
        );
        assert.equal(
          (await command({ ...create, origin: "http://127.0.0.1" })).status,
          400,
        );
        assert.equal(
          (await command({ ...create, expiresAt: "2000-01-01T00:00:00Z" }))
            .status,
          400,
        );
        assert.equal((await command(create)).status, 200);
        assert.equal((await command(create)).status, 409);
        const row = await refresh();
        assert.equal(row.enabled, false);
        assert(
          row.tools.every((tool) => !tool.canInvoke && !tool.roles.length),
        );
        assert.equal(JSON.stringify(await list()).includes(apiKey), false);
        assert.equal((await invoke()).status, 403);
        assert.equal(calls, 0);
        for (const filename of readdirSync(join(root, "identity")))
          if (filename.startsWith("identity.sqlite"))
            assert.equal(
              readFileSync(join(root, "identity", filename)).includes(
                Buffer.from(apiKey),
              ),
              false,
            );
        assert.match(
          String(
            db
              .prepare("SELECT secret FROM agent_connection WHERE id=?")
              .get(connectionId)!.secret,
          ),
          /^v1\./,
        );
      },
    );
    await t.test(
      "workspace, organization and per-tool grants govern discovery and dispatch",
      async () => {
        await configure();
        assert.equal((await invoke(member)).status, 403);
        await seedIdentityFixture(identity, {
          type: "setWorkspaceMember",
          organizationId,
          ...{
            memberId,
            workspaceId,
            allowed: true,
          },
        });
        assert.equal((await member(path)).data.connections[0].tools.length, 1);
        assert.equal(
          (await invoke(member)).data.contacts[0].name,
          "TEST Jana Nováková",
        );
        assert.equal(
          (
            await invoke(member, {
              toolId: "crm.contacts.search",
              input: { name: "Jana" },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await invoke(owner, {
              toolId: "crm.contacts.search",
              input: { name: "Jana Novakova" },
            })
          ).data.contacts.length,
          1,
        );
        const previousCalls = calls;
        assert.equal(
          (await invoke(owner, { workspaceId: otherWorkspaceId })).status,
          404,
        );
        assert.equal(
          (await invoke(outsider, { organizationId: "test-beta" })).status,
          404,
        );
        assert.equal((await outsider(path)).status, 403);
        assert.equal(
          (
            await member("api/identity/connections/command", {
              ...target,
              type: "remove",
              connectionId,
              revision,
            })
          ).status,
          403,
        );
        assert.equal(
          (await invoke(owner, { input: { url: "https://evil.example" } }))
            .status,
          400,
        );
        assert.equal(
          (await invoke(owner, { toolId: "crm.delete" })).status,
          400,
        );
        assert.equal(calls, previousCalls);
        const row = (
          await owner(`api/identity/organization?id=${organizationId}`)
        ).data.workspaces.find((w: { id: string }) => w.id === workspaceId);
        assert.equal(row.connectionCount, 1);
        assert.equal(row.toolCount, 2);
      },
    );
    await t.test(
      "audit permissions, metadata redaction and atomic configuration",
      async () => {
        const auditPath = `api/identity/audit?${new URLSearchParams({ organizationId })}`;
        const page = AuditPage.parse((await owner(auditPath)).data);
        assert(page.entries.some((e) => e.action === "connection.created"));
        assert(
          page.entries.some((e) => e.action === "workspace.member_changed"),
        );
        assert(
          page.entries.some(
            (e) => e.action === "tool.invoked" && e.outcome === "succeeded",
          ),
        );
        assert(
          page.entries.some(
            (e) => e.action === "tool.invoked" && e.outcome === "denied",
          ),
        );
        const serialized = JSON.stringify(
          db.prepare("SELECT * FROM agent_audit").all(),
        );
        for (const secret of [
          apiKey,
          password,
          "jana@example.test",
          "TEST Jana",
          "provider-error-",
        ])
          assert(!serialized.includes(secret));
        assert.equal((await member(auditPath)).status, 403);
        assert.equal((await operator(auditPath)).status, 403);
        assert.equal((await outsider(auditPath)).status, 403);
        assert.equal(
          (await owner(`api/identity/audit?organizationId=test-beta`)).status,
          403,
        );
        assert.equal(
          (await outsider(`api/identity/audit?organizationId=test-beta`)).data
            .entries.length,
          0,
        );
        assert.equal(
          (await owner(`${auditPath}&before=1%20OR%201=1`)).status,
          400,
        );
        const before = await refresh();
        const count = db.prepare("SELECT count(*) AS n FROM agent_audit").get()!
          .n;
        db.exec(
          "CREATE TRIGGER audit_failure BEFORE INSERT ON agent_audit WHEN NEW.action='connection.configured' BEGIN SELECT RAISE(ABORT,'TEST failure'); END;",
        );
        try {
          assert.equal(
            (
              await command({
                type: "configure",
                connectionId,
                revision,
                enabled: false,
                grants: [
                  { toolId: "crm.contacts.list", roles: [] },
                  { toolId: "crm.contacts.search", roles: [] },
                ],
              })
            ).status,
            503,
          );
          assert.deepEqual(await refresh(), before);
          assert.equal(
            db.prepare("SELECT count(*) AS n FROM agent_audit").get()!.n,
            count,
          );
        } finally {
          db.exec("DROP TRIGGER audit_failure");
        }
      },
    );
    await t.test(
      "dispatch uses the currently authorized credential after a queued rotation",
      async () => {
        const old = db
          .prepare("SELECT secret,revision FROM agent_connection WHERE id=?")
          .get(connectionId)!;
        expectedKey = `${apiKey}-race`;
        assert.equal(
          (
            await command({
              type: "rotate",
              connectionId,
              revision,
              apiKey: expectedKey,
              expiresAt: create.expiresAt,
            })
          ).status,
          200,
        );
        const next = db
          .prepare("SELECT secret,revision FROM agent_connection WHERE id=?")
          .get(connectionId)!;
        db.prepare(
          "UPDATE agent_connection SET secret=?,revision=? WHERE id=?",
        ).run(old.secret!, old.revision!, connectionId);
        db.exec(
          "CREATE TABLE audit_rotation (id TEXT,secret TEXT,revision INTEGER);",
        );
        db.prepare("INSERT INTO audit_rotation VALUES (?,?,?)").run(
          connectionId,
          next.secret!,
          next.revision!,
        );
        // Simulate a rotation after preparation but before audit's queued dispatch.
        db.exec(
          "CREATE TRIGGER audit_rotate AFTER INSERT ON agent_audit WHEN NEW.action='tool.invoked' BEGIN UPDATE agent_connection SET secret=(SELECT secret FROM audit_rotation),revision=(SELECT revision FROM audit_rotation) WHERE id=(SELECT id FROM audit_rotation); END;",
        );
        try {
          assert.equal(
            (await invoke(owner, { revision: Number(next.revision) })).status,
            200,
          );
        } finally {
          db.exec("DROP TRIGGER audit_rotate; DROP TABLE audit_rotation;");
        }
        await refresh();
      },
    );
    async function inFlight(change: () => Promise<unknown>, who = member) {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      gate = {
        started: entered,
        wait: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      const response = invoke(who);
      await started;
      try {
        // A remote request must not block either reads or revocations in the identity queue.
        assert.equal((await owner(path)).status, 200);
        assert.equal((await invoke(who)).status, 429);
        await change();
      } finally {
        release();
        gate = undefined;
      }
      const result = await response;
      assert.notEqual(result.status, 200);
      assert.equal("contacts" in result.data, false);
      const audit = AuditPage.parse(
        (
          await owner(
            `api/identity/audit?${new URLSearchParams({ organizationId, category: "tools" })}`,
          )
        ).data,
      );
      assert.equal(audit.entries[0]?.outcome, "denied");
    }
    await t.test(
      "revocation during I/O discards results, including revoke-then-restore",
      async () => {
        await inFlight(async () => {
          await configure(false);
        });
        await configure();
        await inFlight(async () => {
          await identityCommand("setWorkspaceMember", {
            memberId,
            workspaceId,
            allowed: false,
          });
          await seedIdentityFixture(identity, {
            type: "setWorkspaceMember",
            organizationId,
            ...{
              memberId,
              workspaceId,
              allowed: true,
            },
          });
        });
        await inFlight(async () => {
          await identityCommand("changeRole", { memberId, role: "admin" });
        });
        await identityCommand("changeRole", { memberId, role: "member" });
        await inFlight(async () => {
          await member("api/logout", {});
        });
        await member("auth/sign-in/email", {
          email: "member@example.test",
          password,
        });
        await inFlight(async () => {
          await configure(true, ["owner"]);
        });
        await configure();
      },
    );
    await t.test(
      "key replacement, optimistic conflicts, expiry, safe failures and restart",
      async () => {
        const oldRevision = revision;
        expectedKey = `${apiKey}-rotated`;
        assert.equal(
          (
            await command({
              type: "rotate",
              connectionId,
              revision,
              apiKey: expectedKey,
              expiresAt: create.expiresAt,
            })
          ).status,
          200,
        );
        await refresh();
        assert.equal(
          (await invoke(owner, { revision: oldRevision })).status,
          409,
        );
        assert.equal(
          (
            await command({
              type: "remove",
              connectionId,
              revision: oldRevision,
            })
          ).status,
          409,
        );
        assert.equal((await invoke()).status, 200);
        failed = true;
        const error = await invoke();
        assert.equal(error.status, 502);
        assert.deepEqual(error.data, { error: "tool_failed" });
        failed = false;
        db.prepare("UPDATE agent_connection SET expires_at=? WHERE id=?").run(
          "2000-01-01T00:00:00Z",
          connectionId,
        );
        assert.equal((await invoke()).status, 403);
        db.prepare("UPDATE agent_connection SET expires_at=? WHERE id=?").run(
          create.expiresAt,
          connectionId,
        );
        // Copying a ciphertext to another record cannot decrypt under that record's AAD.
        await command({ ...create, name: "TEST Vault swap" });
        const second = (await list()).connections.find(
          (c) => c.id !== connectionId,
        )!;
        const ciphertext = db
          .prepare("SELECT secret FROM agent_connection WHERE id=?")
          .get(connectionId)!.secret;
        db.prepare(
          "UPDATE agent_connection SET secret=?,enabled=1,grants=(SELECT grants FROM agent_connection WHERE id=?) WHERE id=?",
        ).run(ciphertext!, connectionId, second.id);
        assert.equal(
          (
            await invoke(owner, {
              connectionId: second.id,
              revision: second.revision,
            })
          ).status,
          502,
        );
        assert.equal(
          (
            await command({
              type: "remove",
              connectionId: second.id,
              revision: second.revision,
            })
          ).status,
          200,
        );
        await identity.close();
        identity = await openIdentity(config, {
          connectionTransport: transport,
        });
        handler = createAdminHandler(config, () => [], {
          identity,
          assetsDirectory: root,
        });
        assert.equal((await invoke()).status, 200);
        // Removing the operator allowlist also revokes previously stored origins.
        await identity.close();
        config.administration!.identity!.connectionOrigins = [];
        identity = await openIdentity(config, {
          connectionTransport: transport,
        });
        handler = createAdminHandler(config, () => [], {
          identity,
          assetsDirectory: root,
        });
        assert.equal((await refresh()).state, "unavailable");
        assert.equal((await invoke()).status, 403);
        assert.equal(
          (await command({ type: "remove", connectionId, revision })).status,
          200,
        );
        assert.equal((await list()).connections.length, 0);
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await identity.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
