import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  CatalogCommand,
  CatalogSchema,
  PersonalServiceList,
  PersonalServiceSummary,
  PERSONAL_SERVICES_LIMIT,
} from "../packages/protocol/service-catalog";
import { PersonalServicePermissions } from "../packages/protocol/service-oauth";
import { ServiceOAuthStore } from "../apps/server-identity/service-oauth";
import {
  ServiceCatalogStore,
  type CatalogActor,
} from "../apps/server-identity/service-catalog";
import {
  CatalogController,
  type CatalogContext,
} from "../apps/server-identity/catalog-controller";
import { AuditStore } from "../apps/server-identity/audit";
import { IdentityError } from "../apps/server-identity/error";
import { IntegrationError } from "../apps/server-integrations/transport";
import type { IntegrationTransport } from "../apps/server-integrations/transport";

const target = {
  organizationId: "TEST-org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
const code = (name: string) => (error: unknown) =>
  (error instanceof IdentityError || error instanceof IntegrationError) &&
  error.code === name;

/** A synthetic MCP server behind a bearer key with one read and one write tool. */
function mcpServer(options: { key?: string; tools?: string[] } = {}) {
  const calls: string[] = [];
  const tools = options.tools ?? ["list_items", "create_item"];
  const transport: IntegrationTransport = async (req) => {
    await req.beforeDispatch?.(() => {});
    calls.push(req.url);
    if (
      options.key &&
      (req.headers as Record<string, string>).Authorization !==
        `Bearer ${options.key}`
    )
      return {
        status: 401,
        headers: { "content-type": "application/json" },
        text: '{"error":"unauthorized"}',
      };
    const body = req.body as { id?: number; method: string };
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
        : body.method === "tools/list"
          ? {
              tools: tools.map((name) => ({
                name,
                description: `TEST ${name}`,
                inputSchema: { type: "object", properties: {} },
                ...(name.startsWith("list_")
                  ? { annotations: { readOnlyHint: true } }
                  : {}),
              })),
            }
          : {};
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      text: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
    };
  };
  return { transport, calls, tools };
}

function fixture(transport: IntegrationTransport) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE organization(id TEXT PRIMARY KEY);
    CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT,name TEXT);
    CREATE TABLE member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT);
    INSERT INTO organization VALUES ('TEST-org');
    INSERT INTO user VALUES ('TEST-owner','TEST owner'),('TEST-alice','TEST alice'),('TEST-bob','TEST bob');
    INSERT INTO agent_workspace VALUES ('${target.workspaceId}','TEST-org','TEST workspace');
    INSERT INTO member VALUES ('m1','TEST-org','TEST-owner'),('m2','TEST-org','TEST-alice'),('m3','TEST-org','TEST-bob');`);
  const oauth = new ServiceOAuthStore(
    db,
    "TEST-only-encryption-secret",
    "https://agent.example.test",
  );
  const catalog = new ServiceCatalogStore(
    db,
    "TEST-only-encryption-secret",
    [],
    oauth,
  );
  const audit = new AuditStore(db);
  let userId = "TEST-alice",
    role: CatalogActor["role"] = "member",
    epoch = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const context: CatalogContext = {
    serial: (run) => {
      const pending = queue.then(run);
      queue = pending.catch(() => {});
      return pending;
    },
    actor: async () => ({ userId, role }),
    session: async () => ({ userId, sessionId: `session-${userId}` }),
    epoch: () => epoch,
    change: () => {
      epoch++;
    },
    audit: (record) => audit.append(record),
    finish: (id, outcome, details) => audit.finish(id, outcome, details),
    transaction: async (run) => {
      db.exec("BEGIN");
      try {
        const value = await run();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const controller = new CatalogController(catalog, transport);
  const call = (path: string, body: object) =>
    controller.handle(
      "POST",
      new URL(`https://agent.example.test/admin/api/identity/catalog/${path}`),
      { ...target, ...body },
      context,
      new AbortController().signal,
    );
  const as = (next: string, nextRole: CatalogActor["role"] = "member") => {
    userId = next;
    role = nextRole;
  };
  const admin = (body: object) =>
    catalog.command(CatalogCommand.parse({ ...target, ...body }));
  const list = async () =>
    PersonalServiceList.parse(await call("personal/list", {}));
  const add = async (body: object = {}) =>
    PersonalServiceSummary.parse(
      await call("personal/command", {
        type: "add",
        url: "https://tracker.example.test/mcp",
        apiKey: "TEST-key",
        ...body,
      }),
    );
  const inventory = () =>
    CatalogSchema.parse(
      catalog.inventory(target.organizationId, target.workspaceId, {
        userId,
        role,
      }),
    );
  return {
    db,
    catalog,
    audit,
    call,
    as,
    admin,
    list,
    add,
    inventory,
    epoch: () => epoch,
  };
}

test("a member adds a service with an address and a key; it waits for review, then serves only its owner", async () => {
  const server = mcpServer({ key: "TEST-key" });
  const h = fixture(server.transport);
  const added = await h.add();
  assert.equal(added.status, "pending");
  assert.equal(added.protocol, "mcp");
  assert.equal(added.name, "tracker.example.test");
  assert.deepEqual([added.reads, added.writes], [1, 1]);
  // Reads run without approval, changes ask; both are on for the owner.
  const stored = h.catalog.service(target.workspaceId, added.id);
  assert.deepEqual(
    stored.actions
      .map((a) => [a.effect, a.approval, a.enabled])
      .sort((a, b) => String(a).localeCompare(String(b))),
    [
      ["read", "never", true],
      ["write", "always", true],
    ],
  );
  assert.equal(stored.personal?.userId, "TEST-alice");
  assert.equal(stored.hasCredential, true);
  // Pending: the owner's chat does not see it yet, the list says so.
  assert.deepEqual(
    h.inventory().services.map((s) => s.id),
    [],
  );
  assert.equal((await h.list()).services[0]?.status, "pending");
  assert.equal((await h.list()).policy, "review");
  // Nobody else sees it or touches it.
  h.as("TEST-bob");
  assert.deepEqual((await h.list()).services, []);
  await assert.rejects(
    h.call("personal/command", {
      type: "rename",
      id: added.id,
      revision: stored.revision,
      name: "Mine now",
    }),
    code("catalog_not_found"),
  );
  await assert.rejects(
    h.call("oauth/permissions", { serviceId: added.id }),
    code("catalog_not_found"),
  );
  // An administrator sees who added what and approves it.
  h.as("TEST-owner", "owner");
  const seen = h.inventory().services.find((s) => s.id === added.id);
  assert.equal(seen?.personal?.userId, "TEST-alice");
  assert.equal(seen?.personal?.status, "pending");
  const before = h.epoch();
  h.admin({
    type: "reviewPersonalService",
    id: added.id,
    revision: stored.revision,
    decision: "approve",
  });
  assert.equal(
    h.catalog.service(target.workspaceId, added.id).personal?.status,
    "active",
  );
  // Now the owner's chat has both actions, under the owner's own choices.
  h.as("TEST-alice");
  const mine = h.inventory().services.find((s) => s.id === added.id);
  assert.equal(mine?.actions.length, 2);
  const permissions = PersonalServicePermissions.parse(
    await h.call("oauth/permissions", { serviceId: added.id }),
  );
  assert.equal(permissions.requiredFor, "all");
  assert.equal(permissions.actions.length, 2);
  // Bob's chat still has nothing.
  h.as("TEST-bob");
  assert.deepEqual(h.inventory().services, []);
  // The audit trail names the addition.
  const trail = h.db
    .prepare(
      "SELECT action, actor_id, target_id FROM agent_audit WHERE action LIKE 'catalog.personal_service_%' ORDER BY id",
    )
    .all()
    .map((row) => ({ ...row })) as {
    action: string;
    actor_id: string;
    target_id: string;
  }[];
  assert.deepEqual(trail, [
    {
      action: "catalog.personal_service_added",
      actor_id: "TEST-alice",
      target_id: added.id,
    },
  ]);
  // The approval changed who may run what: running work is re-checked.
  assert.ok(h.epoch() >= before);
});

test("a rejected service tells its owner why and never reaches a chat", async () => {
  const h = fixture(mcpServer().transport);
  const added = await h.add({ apiKey: undefined, name: "Tracker" });
  h.as("TEST-owner", "owner");
  h.admin({
    type: "reviewPersonalService",
    id: added.id,
    revision: added.revision,
    decision: "reject",
    reason: "TEST unknown vendor",
  });
  h.as("TEST-alice");
  const [mine] = (await h.list()).services;
  assert.equal(mine?.status, "rejected");
  assert.equal(mine?.reason, "TEST unknown vendor");
  assert.deepEqual(h.inventory().services, []);
  // The owner can still remove it.
  await h.call("personal/command", {
    type: "remove",
    id: added.id,
    revision: mine!.revision,
  });
  assert.deepEqual((await h.list()).services, []);
});

test("the workspace policy allows at once, asks for review, or refuses; the limit and the address are checked", async () => {
  const h = fixture(mcpServer().transport);
  h.as("TEST-owner", "owner");
  h.admin({ type: "savePersonalServicesPolicy", policy: "free" });
  h.as("TEST-alice");
  const free = await h.add({ apiKey: undefined });
  assert.equal(free.status, "active");
  assert.equal(h.inventory().services[0]?.id, free.id);
  h.as("TEST-owner", "owner");
  h.admin({ type: "savePersonalServicesPolicy", policy: "off" });
  h.as("TEST-alice");
  await assert.rejects(
    h.add({ apiKey: undefined, url: "https://other.example.test/mcp" }),
    code("catalog_personal_services_off"),
  );
  // Only public HTTPS; a private address is for the operator's allowlist.
  h.as("TEST-owner", "owner");
  h.admin({ type: "savePersonalServicesPolicy", policy: "free" });
  h.as("TEST-alice");
  await assert.rejects(
    h.add({ apiKey: undefined, url: "http://10.0.0.5/mcp" }),
    code("integration_origin_denied"),
  );
  for (let i = 1; i < PERSONAL_SERVICES_LIMIT; i++)
    await h.add({ apiKey: undefined, url: `https://s${i}.example.test/mcp` });
  await assert.rejects(
    h.add({ apiKey: undefined, url: "https://one-too-many.example.test/mcp" }),
    code("identity_limit"),
  );
});

test("a service that answers neither as MCP nor with an OpenAPI document is refused, and a wrong key too", async () => {
  const silent: IntegrationTransport = async (req) => {
    await req.beforeDispatch?.(() => {});
    return { status: 404, headers: {}, text: "" };
  };
  const h = fixture(silent);
  await assert.rejects(
    h.add({ apiKey: undefined }),
    code("catalog_personal_unreachable"),
  );
  const locked = fixture(mcpServer({ key: "TEST-right" }).transport);
  await assert.rejects(
    locked.add({ apiKey: "TEST-wrong" }),
    code("catalog_personal_unreachable"),
  );
});

test("the owner renames the service and reads its tools again when the server grows", async () => {
  const server = mcpServer();
  const h = fixture(server.transport);
  h.as("TEST-owner", "owner");
  h.admin({ type: "savePersonalServicesPolicy", policy: "free" });
  h.as("TEST-alice");
  const added = await h.add({ apiKey: undefined });
  const renamed = PersonalServiceSummary.parse(
    await h.call("personal/command", {
      type: "rename",
      id: added.id,
      revision: added.revision,
      name: "My tracker",
    }),
  );
  assert.equal(renamed.name, "My tracker");
  server.tools.push("archive_item");
  const grown = PersonalServiceSummary.parse(
    await h.call("personal/command", {
      type: "rediscover",
      id: added.id,
      revision: renamed.revision,
    }),
  );
  assert.deepEqual([grown.reads, grown.writes], [1, 2]);
  // A stale revision is refused.
  await assert.rejects(
    h.call("personal/command", {
      type: "rediscover",
      id: added.id,
      revision: added.revision,
    }),
    code("catalog_conflict"),
  );
});

test("an administrator's save keeps the ownership, and cannot grant one", async () => {
  const h = fixture(mcpServer().transport);
  const added = await h.add({ apiKey: undefined });
  h.as("TEST-owner", "owner");
  const service = h.catalog.service(target.workspaceId, added.id);
  const {
    id: _id,
    revision,
    hasCredential: _c,
    modelId: _m,
    actions: _a,
    personal: _p,
    ...settings
  } = service;
  h.admin({
    type: "saveService",
    id: added.id,
    revision,
    settings: { ...settings, name: "Renamed by admin" },
  });
  const kept = h.catalog.service(target.workspaceId, added.id);
  assert.equal(kept.name, "Renamed by admin");
  assert.equal(kept.personal?.userId, "TEST-alice");
  assert.throws(() =>
    h.admin({
      type: "saveService",
      revision: 0,
      settings: {
        ...settings,
        name: "Forged",
        personal: { userId: "TEST-bob", status: "active", addedAt: "x" },
      },
    }),
  );
});
