import { seedIdentityFixture } from "./helpers/identity-seed";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { openIdentity } from "../apps/server-identity/service";
import { InstanceStore } from "../apps/server-identity/instance";
import { issueAdminKey } from "../apps/server-admin/auth";
import { IdentityStateSchema } from "../packages/protocol/identity";

const password = "TEST-instance-owner-password-2026";

/** A server with administration; `client()` keeps its own cookies. */
async function start() {
  const root = mkdtempSync(join(tmpdir(), "instance-owner-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST Instance",
    listen: { port: address.port },
    allowedOrigins: [],
    dataDirectory: join(root, "workflow"),
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
  const identity = await openIdentity(config, {
    hosting: { autostart: false },
  });
  app = createReferenceServer(config, {}, identity);
  const client = () => {
    const cookies = new Map<string, string>();
    return async (path: string, input?: unknown) => {
      const res = await fetch(`${origin}/admin/${path}`, {
        method: input === undefined ? "GET" : "POST",
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
      return {
        status: res.status,
        data: await res.json().catch(() => null),
      };
    };
  };
  const instanceRow = () => ({
    ...identity["db"]
      .prepare("SELECT organization_id, source FROM agent_instance")
      .get(),
  });
  return {
    key,
    identity,
    client,
    instanceRow,
    close: async () => {
      app.emit("close");
      await identity.close();
      await new Promise((r) => server.close(r));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const owner = {
  name: "TEST Owner",
  email: "owner@example.test",
  password,
  organizationName: "TEST Instance",
};

test("owner setup from an account records the instance organization; ownership follows the role", async () => {
  const server = await start();
  try {
    const first = server.client();
    assert.equal((await first("api/identity/bootstrap", owner)).status, 200);
    const state = IdentityStateSchema.parse((await first("api/identity")).data);
    const organizationId = state.organizations[0]!.id;
    assert.deepEqual(server.instanceRow(), {
      organization_id: organizationId,
      source: "setup",
    });
    assert.deepEqual(state.instance, { owner: true, organizationId });
    // Account is a console page: a reload of its address serves the console.
    assert.equal((await first("account")).status, 200);

    // An administrator of the instance organization is not an instance owner.
    await seedIdentityFixture(server.identity, {
      organizationId,
      type: "createAccount",
      name: "TEST Admin",
      email: "admin@example.test",
      password,
      role: "admin",
    });
    const admin = server.client();
    await admin("auth/sign-in/email", {
      email: "admin@example.test",
      password,
    });
    assert.deepEqual(
      IdentityStateSchema.parse((await admin("api/identity")).data).instance,
      { owner: false },
    );
    const settings = `api/identity/server-settings?organizationId=${organizationId}`;
    assert.equal((await admin(settings)).status, 403);

    // Promoted to owner, the next request is allowed without signing in again.
    const memberId = (
      await first(`api/identity/organization?id=${organizationId}`)
    ).data.members.find((m: { role: string }) => m.role === "admin").id;
    assert.equal(
      (
        await first("api/identity/command", {
          type: "changeRole",
          organizationId,
          memberId,
          role: "owner",
        })
      ).status,
      200,
    );
    assert.equal((await admin(settings)).status, 200);
    assert.deepEqual(
      IdentityStateSchema.parse((await admin("api/identity")).data).instance,
      { owner: true, organizationId },
    );

    // The owner of another organization learns neither ownership nor its id.
    const otherId = randomUUID();
    server.identity["db"]
      .prepare(
        'INSERT INTO organization(id,name,slug,"createdAt") VALUES(?,?,?,?)',
      )
      .run(otherId, "TEST Other", "test-other", new Date(0).toISOString());
    await seedIdentityFixture(server.identity, {
      organizationId: otherId,
      type: "createAccount",
      name: "TEST Other",
      email: "other@example.test",
      password,
      role: "admin",
    });
    // The fixture seeds administrators; the other organization gets an owner.
    server.identity["db"]
      .prepare(`UPDATE member SET role='owner' WHERE "organizationId"=?`)
      .run(otherId);
    const other = server.client();
    await other("auth/sign-in/email", {
      email: "other@example.test",
      password,
    });
    assert.deepEqual(
      IdentityStateSchema.parse((await other("api/identity")).data).instance,
      { owner: false },
    );
    // An older organization never replaces the recorded one.
    assert.deepEqual(server.instanceRow(), {
      organization_id: organizationId,
      source: "setup",
    });
  } finally {
    await server.close();
  }
});

test("owner setup from the recovery console records the instance organization", async () => {
  const server = await start();
  try {
    const operator = server.client();
    await operator("api/login", { key: server.key });
    assert.deepEqual(
      IdentityStateSchema.parse((await operator("api/identity")).data).instance,
      { owner: false },
    );
    assert.equal((await operator("api/identity/bootstrap", owner)).status, 200);
    const organizationId = server.identity["db"]
      .prepare("SELECT id FROM organization")
      .get()!.id;
    assert.deepEqual(server.instanceRow(), {
      organization_id: organizationId,
      source: "setup",
    });
    // A recovery session is never an instance owner.
    await operator("api/login", { key: server.key });
    assert.deepEqual(
      IdentityStateSchema.parse((await operator("api/identity")).data).instance,
      { owner: false },
    );
  } finally {
    await server.close();
  }
});

test("a server without a record adopts its earliest organization once", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE organization (id TEXT PRIMARY KEY, "createdAt" ANY);
    CREATE TABLE member ("userId" TEXT, "organizationId" TEXT, role TEXT);`);
  const add = db.prepare("INSERT INTO organization VALUES (?, ?)");
  // Better Auth may store the time as text or as epoch milliseconds.
  add.run("may", "2025-05-01T00:00:00.000Z");
  add.run("march", Date.parse("2025-03-01T00:00:00.000Z"));
  assert.equal(new InstanceStore(db).organizationId(), "march");
  db.prepare("INSERT INTO member VALUES (?, ?, ?)").run("u1", "march", "owner");
  db.prepare("INSERT INTO member VALUES (?, ?, ?)").run("u2", "may", "owner");
  // After a restart and with an even older organization, nothing changes.
  add.run("january", "2025-01-01T00:00:00.000Z");
  const restarted = new InstanceStore(db);
  restarted.backfill();
  assert.equal(restarted.organizationId(), "march");
  assert.equal(restarted.isOwner("u1"), true);
  assert.equal(restarted.isOwner("u2"), false);
  assert.equal(
    db.prepare("SELECT source FROM agent_instance").get()!.source,
    "backfill",
  );
  db.close();
});
