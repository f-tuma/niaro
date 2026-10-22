import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ActionDiscoveryResponse,
  CatalogCommand,
} from "../packages/protocol/service-catalog";
import {
  HUB_PROFILE_V3,
  HubDashboardV3Schema,
  type HubDashboardV3,
} from "../packages/protocol/hub";
import {
  MENTIONS_PROFILE,
  MentionDirectorySchema,
} from "../packages/protocol/mentions";
import { hubWidgetDefinition } from "../packages/protocol/widgets";
import { ServiceOAuthStore } from "../apps/server-identity/service-oauth";
import {
  ServiceCatalogStore,
  type CatalogActor,
} from "../apps/server-identity/service-catalog";
import {
  CatalogController,
  type CatalogContext,
} from "../apps/server-identity/catalog-controller";
import { HubStore } from "../apps/server-identity/hub-store";
import { createHub } from "../apps/server-identity/hub";
import {
  hubReadableServices,
  runHubFill,
} from "../apps/server-identity/hub-fill";
import { IdentityError } from "../apps/server-identity/error";
import type { IntegrationTransport } from "../apps/server-integrations/transport";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";

const target = {
  organizationId: "TEST-org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
const code = (value: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === value;

/** A Microsoft 365-like MCP server: Graph reads labelled read-only, one send. */
const tools = [
  { name: "list-mail-messages", readOnlyHint: true },
  { name: "list-calendar-events", readOnlyHint: true },
  { name: "send-mail", readOnlyHint: false },
];
const mcp: IntegrationTransport = async (request) => {
  await request.beforeDispatch?.(() => {});
  const body = request.body as { id?: number; method: string };
  const result =
    body.method === "initialize"
      ? {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "TEST ms-365" },
        }
      : body.method === "tools/list"
        ? {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: `TEST ${tool.name}`,
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: tool.readOnlyHint },
            })),
          }
        : {};
  return {
    status: 200,
    headers: {
      "content-type": "application/json",
      "mcp-session-id": "TEST-session",
    },
    text: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
  };
};

/**
 * The owner's first production path, store-level: a hosted-like MCP service
 * without a shared key, every action discovered and turned on by an
 * administrator, personal sign-in for all actions and a member who connected.
 */
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organization(id TEXT PRIMARY KEY);
    CREATE TABLE user(id TEXT PRIMARY KEY);
    CREATE TABLE member(id TEXT PRIMARY KEY, "organizationId" TEXT REFERENCES organization(id) ON DELETE CASCADE, "userId" TEXT REFERENCES user(id) ON DELETE CASCADE, role TEXT);
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT REFERENCES organization(id) ON DELETE CASCADE);
    CREATE TABLE agent_workspace_member(workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE, member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE, PRIMARY KEY(workspace_id, member_id)) STRICT;
    INSERT INTO organization VALUES ('${target.organizationId}');
    INSERT INTO user VALUES ('TEST-owner'),('TEST-alice');
    INSERT INTO member VALUES ('TEST-m-owner','${target.organizationId}','TEST-owner','owner'),('TEST-m-alice','${target.organizationId}','TEST-alice','member');
    INSERT INTO agent_workspace VALUES ('${target.workspaceId}','${target.organizationId}');
    INSERT INTO agent_workspace_member VALUES ('${target.workspaceId}','TEST-m-owner'),('${target.workspaceId}','TEST-m-alice');`);
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
  let actor: CatalogActor = { userId: "TEST-owner", role: "owner" };
  let queue: Promise<unknown> = Promise.resolve();
  const context: CatalogContext = {
    serial: (run) => {
      const pending = queue.then(run);
      queue = pending.catch(() => {});
      return pending;
    },
    actor: async () => actor,
    session: async () => ({
      userId: actor.userId,
      sessionId: `session-${actor.userId}`,
    }),
    epoch: () => 0,
    change: () => {},
    audit: () => 0,
    finish: () => {},
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
  const controller = new CatalogController(catalog, mcp);
  const command = (body: object) =>
    catalog.command(CatalogCommand.parse({ ...target, ...body }));
  const alice = {
    ...target,
    userId: "TEST-alice",
    role: "member" as const,
  };
  const hub = createHub({
    store: new HubStore(db),
    processes: {
      unattendedEffect: () => "read",
      activeOutputSchema: () => undefined,
      executionInventory: (_actor, scope) => ({
        profile: "agent-process-execution/1",
        scope,
        fingerprint: "f".repeat(64),
        processes: [],
        nextAfter: null,
      }),
    },
    starts: () => undefined,
    journal: () => undefined,
    humanTasks: { open: () => [], openCount: () => 0 },
    // As the server wires it: a widget's sources must be readable now.
    services: (who) =>
      hubReadableServices(catalog, who.organizationId, who.workspaceId, {
        userId: who.userId,
        role: who.role,
      }).map((service) => ({ id: service.id, name: service.name })),
  });
  const scope = {
    connectionId: `account-${target.workspaceId}`,
    serverId: "TEST-server",
    workspaceId: target.workspaceId,
    userId: alice.userId,
  };
  const v3 = (body: Record<string, unknown>) =>
    hub.command(alice, scope, "en", { profile: HUB_PROFILE_V3, ...body })
      .view as HubDashboardV3;
  return {
    db,
    oauth,
    catalog,
    controller,
    context,
    command,
    alice,
    v3,
    as: (next: CatalogActor) => {
      actor = next;
    },
  };
}

test("a fresh MCP service with personal sign-in has nothing the overview may read until its reads are marked", async () => {
  const h = fixture();
  try {
    const { catalog, oauth } = h;
    const ws = target.workspaceId;
    // Administration → Services → Add service, from the hosted server's address.
    const serviceId = h.command({
      type: "saveService",
      revision: 0,
      settings: {
        name: "TEST Microsoft 365",
        url: "https://ms365.example.test/mcp",
        protocol: "mcp",
        icon: "mail",
        auth: { type: "none" },
        enabled: true,
      },
    });
    const discovered = ActionDiscoveryResponse.parse(
      await h.controller.handle(
        "POST",
        new URL(
          "https://agent.example.test/admin/api/identity/catalog/discover",
        ),
        {
          ...target,
          serviceId,
          revision: catalog.service(ws, serviceId).revision,
        },
        h.context,
        new AbortController().signal,
      ),
    );
    assert.equal(discovered.added, 3);
    // Every tool arrives as a change: the server's read-only labels are not trusted.
    const service = () => catalog.service(ws, serviceId);
    assert(service().actions.every((action) => action.effect === "write"));
    h.command({
      type: "updateActions",
      serviceId,
      serviceRevision: service().revision,
      actions: service().actions.map(({ id, revision }) => ({ id, revision })),
      patch: { enabled: true },
    });
    // Personal sign-in for every action; the member connects their account.
    const oauthTarget = catalog.oauthTarget(ws, serviceId);
    oauth.save(
      oauthTarget,
      oauth.config(oauthTarget).revision,
      { requiredFor: "all" },
      { clientId: "TEST-client" },
    );
    oauth.setDiscovery(oauthTarget, oauth.config(oauthTarget).revision, {
      issuer: "https://ms365.example.test",
      authorizationEndpoint: "https://ms365.example.test/authorize",
      tokenEndpoint: "https://ms365.example.test/token",
      registrationEndpoint: null,
      scopes: ["api", "profile"],
      tokenEndpointAuthMethods: ["none"],
      authorizationResponseIssParameterSupported: true,
    });
    const person = { userId: "TEST-alice", sessionId: "session-TEST-alice" };
    const started = oauth.start(
      oauthTarget,
      person,
      oauth.config(oauthTarget).revision,
    );
    const claim = oauth.claimFromState(person, {
      state: new URL(started.authorizationUrl).searchParams.get("state")!,
      code: "TEST-code",
      iss: "https://ms365.example.test",
    });
    oauth.commitConnection(
      claim,
      {
        accessToken: "TEST-access",
        scopes: ["api", "profile"],
        expiresAt: Date.now() + 3600000,
        identity: {
          userId: "TEST-ms-alice",
          workspaceId: "TEST-tenant",
          userWorkspaceId: "TEST-ms-member",
        },
      },
      person,
      oauthTarget,
    );
    assert.equal(
      oauth.status(oauthTarget, "TEST-alice").connection.status,
      "connected",
    );
    const alice = { userId: "TEST-alice", role: "member" as const };
    // The cause of the 409s: no enabled read runs without approval, so the
    // service is not readable for the overview…
    assert.deepEqual(
      hubReadableServices(catalog, target.organizationId, ws, alice),
      [],
    );
    // …choosing it as a widget's source is refused…
    assert.throws(
      () =>
        h.v3({
          type: "add",
          kind: "widget",
          widget: { type: "inbox", sources: [serviceId] },
        }),
      code("hub_source_unavailable"),
    );
    // …and without a source the fill finds nothing to read.
    await assert.rejects(
      runHubFill(
        {
          readable: async () =>
            hubReadableServices(catalog, target.organizationId, ws, alice),
          read: async () => {
            throw Error("TEST no read expected");
          },
          model: () => {
            throw Error("TEST no model expected");
          },
        },
        {
          type: "inbox",
          brief: "TEST important mail",
          config: hubWidgetDefinition("inbox")!.defaultConfig as Record<
            string,
            unknown
          >,
          sources: [],
          recipe: null,
          language: "en",
          now: Date.now(),
          runKey: "TEST-run",
        },
        new AbortController().signal,
      ),
      code("service_unavailable"),
    );
    // The administrator marks the actions the server labels read-only as reads.
    const reads = service().actions.filter((action) =>
      action.name.startsWith("list-"),
    );
    assert.equal(reads.length, 2);
    h.command({
      type: "updateActions",
      serviceId,
      serviceRevision: service().revision,
      actions: reads.map(({ id, revision }) => ({ id, revision })),
      patch: { effect: "read" },
    });
    const readable = hubReadableServices(
      catalog,
      target.organizationId,
      ws,
      alice,
    );
    assert.deepEqual(
      readable.map((value) => ({
        id: value.id,
        actions: value.actions.map((action) => action.name).sort(),
      })),
      [
        {
          id: serviceId,
          actions: ["list-calendar-events", "list-mail-messages"],
        },
      ],
    );
    const view = HubDashboardV3Schema.parse(
      h.v3({
        type: "add",
        kind: "widget",
        widget: { type: "inbox", sources: [serviceId] },
      }),
    );
    const widget = view.items.find((item) => item.kind === "widget");
    assert.deepEqual(widget?.widget?.sources, [
      { id: serviceId, name: "TEST Microsoft 365" },
    ]);
  } finally {
    h.db.close();
  }
});

test("the hub's mention directory lists only services the overview can read", async () => {
  const h = await coordinatorHttpFixture();
  try {
    const member = await h.pair("member");
    // A service the member can mention but the overview cannot read: writes only.
    const writesOnly = await h.catalog({
      type: "saveService",
      revision: 0,
      settings: {
        name: "TEST writes only",
        url: "https://services.example.test/writes",
        protocol: "openapi",
        icon: "plug",
        auth: { type: "none" },
        enabled: true,
      },
    });
    await h.catalog({
      type: "saveAction",
      serviceId: writesOnly,
      serviceRevision: 1,
      revision: 0,
      settings: {
        name: "TEST send",
        description: "",
        inputSchema: { type: "object", properties: {} },
        binding: {
          type: "http",
          method: "POST",
          path: "/send",
          parameters: [],
          body: true,
        },
        effect: "write",
        approval: "always",
        enabled: true,
        policy: { roles: ["owner", "admin", "member"], users: [] },
      },
    });
    const all = await h.mobile(member, "mentions");
    assert.equal(all.status, 200, JSON.stringify(all.data));
    const everything = MentionDirectorySchema.parse(all.data).items;
    assert(everything.some((item) => item.id === writesOnly));
    assert(everything.some((item) => item.id === h.serviceId));
    const hub = await h.mobile(member, "mentions?for=hub");
    assert.equal(hub.status, 200, JSON.stringify(hub.data));
    const readable = MentionDirectorySchema.parse(hub.data);
    assert.equal(readable.profile, MENTIONS_PROFILE);
    assert.deepEqual(
      readable.items.map((item) => [item.kind, item.id]),
      [["service", h.serviceId]],
    );
    for (const path of ["mentions?for=chat", "mentions?for=hub&x=1"])
      assert.equal((await h.mobile(member, path)).status, 400, path);
  } finally {
    await h.close();
  }
});
