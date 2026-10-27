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
  /** The sign-in callback carries only state and code, no workspace. */
  const finish = (state: string | null, code = "TEST-code") =>
    controller.handle(
      "POST",
      new URL(
        "https://agent.example.test/admin/api/identity/catalog/oauth/finish",
      ),
      { state, code },
      context,
      new AbortController().signal,
    );
  const keep = () =>
    controller.keepConnectionsFresh(
      { serial: context.serial, transaction: context.transaction },
      new AbortController().signal,
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
    keep,
    finish,
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

/**
 * A Notion-like MCP server: no key, OAuth with dynamic client registration,
 * opaque tokens without an account in them, rotating refresh tokens.
 */
function oauthServer() {
  const origin = "https://notes.example.test";
  const counts = { register: 0, code: 0, refresh: 0 };
  let access = "TEST-access-1",
    refresh = "TEST-refresh-1";
  const transport: IntegrationTransport = async (req) => {
    await req.beforeDispatch?.(() => {});
    const url = new URL(req.url);
    const json = (status: number, body: unknown) => ({
      status,
      headers: { "content-type": "application/json" },
      text: JSON.stringify(body),
    });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/register") {
      counts.register++;
      assert.equal(
        "scope" in (req.body as Record<string, unknown>),
        false,
        "no scope is requested",
      );
      return json(201, {
        client_id: "TEST-notes-client",
        token_endpoint_auth_method: "none",
      });
    }
    if (url.pathname === "/token") {
      const body = req.body as Record<string, string>;
      if (body.grant_type === "authorization_code") counts.code++;
      else {
        counts.refresh++;
        // A reused refresh token is refused, as rotating servers do.
        if (body.refresh_token !== refresh)
          return json(400, { error: "invalid_grant" });
        access = `TEST-access-${counts.refresh + 1}`;
        refresh = `TEST-refresh-${counts.refresh + 1}`;
      }
      return json(200, {
        access_token: access,
        refresh_token: refresh,
        token_type: "bearer",
        expires_in: 3600,
      });
    }
    if (url.pathname === "/mcp") {
      if (
        (req.headers as Record<string, string>).Authorization !==
        `Bearer ${access}`
      )
        return json(401, { error: "unauthorized" });
      const body = req.body as { id?: number; method: string };
      return json(200, {
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
            : body.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "search_pages",
                      inputSchema: { type: "object", properties: {} },
                      annotations: { readOnlyHint: true },
                    },
                    {
                      name: "create_page",
                      inputSchema: { type: "object", properties: {} },
                    },
                  ],
                }
              : {},
      });
    }
    return json(404, {});
  };
  return { transport, counts, origin };
}

test("a service that signs in with the person's account is added without a key, signed in to by its owner alone, then read", async () => {
  const server = oauthServer();
  const h = fixture(server.transport);
  h.as("TEST-owner", "owner");
  h.admin({ type: "savePersonalServicesPolicy", policy: "free" });
  h.as("TEST-alice");
  const added = await h.add({ apiKey: undefined, url: `${server.origin}/mcp` });
  assert.equal(added.signIn, "needed");
  assert.deepEqual([added.reads, added.writes], [0, 0]);
  assert.equal(server.counts.register, 1);
  // Bob may not start a sign-in on Alice's service.
  h.as("TEST-bob");
  await assert.rejects(
    h.call("oauth/start", {
      serviceId: added.id,
      revision: added.signInRevision,
    }),
    code("catalog_not_found"),
  );
  // Alice signs in.
  h.as("TEST-alice");
  const started = (await h.call("oauth/start", {
    serviceId: added.id,
    revision: added.signInRevision,
  })) as { authorizationUrl: string };
  const authorize = new URL(started.authorizationUrl);
  assert.equal(authorize.searchParams.has("scope"), false);
  await h.finish(authorize.searchParams.get("state"));
  let [mine] = (await h.list()).services;
  assert.equal(mine?.signIn, "connected");
  // Its tools are read with Alice's own token.
  mine = PersonalServiceSummary.parse(
    await h.call("personal/command", {
      type: "rediscover",
      id: added.id,
      revision: mine!.revision,
    }),
  );
  assert.deepEqual([mine.reads, mine.writes], [1, 1]);
  assert.equal(h.inventory().services[0]?.actions.length, 2);
});

test("a lapsed sign-in stays connected and is renewed once, also in the background, even when two calls need it at the same time", async () => {
  const server = oauthServer();
  const h = fixture(server.transport);
  h.as("TEST-owner", "owner");
  h.admin({ type: "savePersonalServicesPolicy", policy: "free" });
  h.as("TEST-alice");
  const added = await h.add({ apiKey: undefined, url: `${server.origin}/mcp` });
  const started = (await h.call("oauth/start", {
    serviceId: added.id,
    revision: added.signInRevision,
  })) as { authorizationUrl: string };
  await h.finish(new URL(started.authorizationUrl).searchParams.get("state"));
  const lapse = () =>
    h.db
      .prepare(
        "UPDATE agent_service_oauth_connection SET data=json_set(data,'$.expiresAt',?)",
      )
      .run(Date.now() - 1000);
  lapse();
  // The person is not asked to sign in again.
  assert.equal((await h.list()).services[0]?.signIn, "connected");
  // Two reads at once: one refresh, the second waits for it. A second
  // refresh with the rotated token would have revoked the grant.
  const revision = (await h.list()).services[0]!.revision;
  const both = await Promise.allSettled([
    h.call("personal/command", { type: "rediscover", id: added.id, revision }),
    h.call("personal/command", { type: "rediscover", id: added.id, revision }),
  ]);
  assert.equal(server.counts.refresh, 1);
  assert.ok(both.some((r) => r.status === "fulfilled"));
  assert.equal((await h.list()).services[0]?.signIn, "connected");
  // In the background: a lapsing token is renewed, at most once per interval.
  lapse();
  const keeper = await h.keep();
  assert.deepEqual(keeper, { renewed: 1, failed: 0 });
  assert.equal(server.counts.refresh, 2);
  lapse();
  assert.deepEqual(await h.keep(), { renewed: 0, failed: 0 });
  assert.equal(server.counts.refresh, 2);
});
