import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ServiceOAuthStore } from "../apps/server-identity/service-oauth";
import { ServiceCatalogStore } from "../apps/server-identity/service-catalog";
import {
  CatalogController,
  type CatalogContext,
} from "../apps/server-identity/catalog-controller";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import type { ServiceOAuthStatus } from "../packages/protocol/service-oauth";
import type { AuditRecord } from "../packages/protocol/audit";
import type { TransportRequest } from "../apps/server-integrations/transport";

const target = {
  organizationId: "org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
const metadata = {
  issuer: "https://crm.example.test",
  authorization_endpoint: "https://crm.example.test/authorize",
  token_endpoint: "https://crm.example.test/oauth/token",
  registration_endpoint: "https://crm.example.test/oauth/register",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["api", "profile"],
  token_endpoint_auth_methods_supported: ["client_secret_post"],
  authorization_response_iss_parameter_supported: true,
};
function harness(
  options: {
    /** The authorization server metadata an origin answers with. */
    metadataFor?: (url: URL) => unknown;
    /** The registration endpoint's answer. */
    registration?: unknown;
  } = {},
) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT); INSERT INTO agent_workspace VALUES ('${target.workspaceId}', 'org'); CREATE TABLE member(id TEXT PRIMARY KEY, "organizationId" TEXT, "userId" TEXT); INSERT INTO member VALUES ('alice-member','org','alice'),('bob-member','org','bob');`,
  );
  const oauth = new ServiceOAuthStore(
    db,
    "synthetic-secret",
    "https://agent.example.test",
  );
  const store = new ServiceCatalogStore(db, "synthetic-secret", [], oauth);
  let userId = "alice",
    sessionId = "session-alice",
    role: "owner" | "member" = "owner",
    epoch = 0;
  let pending: Promise<unknown> = Promise.resolve();
  const requests: TransportRequest[] = [];
  const audits: AuditRecord[] = [];
  let beforeNetwork: (() => void) | undefined,
    afterNetwork: (() => void) | undefined;
  const context: CatalogContext = {
    serial: (fn) => {
      const next = pending.then(fn);
      pending = next.catch(() => {});
      return next;
    },
    actor: async (input) => {
      assert.deepEqual(input.organizationId, target.organizationId);
      assert.equal(input.workspaceId, target.workspaceId);
      return { userId, role };
    },
    session: async () => ({ userId, sessionId }),
    epoch: () => epoch,
    change: () => {
      epoch++;
    },
    audit: (record) => audits.push(record),
    finish: () => {},
    transaction: async (fn) => {
      db.exec("BEGIN");
      try {
        const result = await fn();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const jwt = () =>
    [
      "header",
      JSON.stringify({
        type: "APPLICATION_ACCESS",
        sub: "application",
        userId: `crm-${userId}`,
        workspaceId: "crm-workspace",
        userWorkspaceId: `crm-membership-${userId}`,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      "signature",
    ]
      .map((part) => Buffer.from(part).toString("base64url"))
      .join(".");
  const controller = new CatalogController(store, async (request) => {
    beforeNetwork?.();
    await request.beforeDispatch?.(() => requests.push(request));
    const result = request.url.endsWith("oauth-authorization-server")
      ? (options.metadataFor?.(new URL(request.url)) ?? metadata)
      : request.url.endsWith("/register")
        ? (options.registration ?? {
            client_id: "test-client",
            client_secret: "test-client-secret",
          })
        : request.url.endsWith("/token")
          ? {
              access_token: jwt(),
              token_type: "Bearer",
              expires_in: 3600,
              scope: "api profile",
            }
          : request.url.endsWith("/decisions")
            ? {
                answers: {
                  route: {
                    type: "choice",
                    choice: "twenty",
                    confidence: 0.95,
                    probabilities: { twenty: 0.95, manual: 0.05 },
                  },
                },
              }
            : { ok: true };
    afterNetwork?.();
    return { status: 200, headers: {}, text: JSON.stringify(result) };
  });
  const command = (body: object) =>
    store.command(CatalogCommand.parse({ ...target, ...body }));
  const serviceId = command({
    type: "saveService",
    revision: 0,
    settings: {
      name: "TEST CRM",
      url: metadata.issuer,
      protocol: "openapi",
      icon: "users",
      auth: { type: "header", header: "X-Shared-Key" },
      enabled: true,
    },
    apiKey: "synthetic-shared-key",
  });
  const add = (
    effect: "read" | "write",
    approval: "always" | "never" = "never",
  ) =>
    command({
      type: "saveAction",
      serviceId,
      serviceRevision: store.service(target.workspaceId, serviceId).revision,
      revision: 0,
      settings: {
        name: `TEST ${effect}`,
        description: "",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        binding: {
          type: "http",
          method: effect === "read" ? "GET" : "POST",
          path: "/contacts",
          parameters: [],
          body: false,
        },
        effect,
        approval,
        enabled: true,
        policy: { roles: ["owner", "member"], users: [] },
      },
    });
  const writeId = add("write"),
    readId = add("read"),
    approvedId = add("write", "always");
  const snapshot = () => store.oauthTarget(target.workspaceId, serviceId);
  const call = (action: string, body: Record<string, unknown> = {}) =>
    controller.handle(
      "POST",
      new URL(
        `https://agent.example.test/admin/api/identity/catalog/oauth/${action}`,
      ),
      {
        ...target,
        serviceId,
        revision: oauth.config(snapshot()).revision,
        ...body,
      },
      context,
      new AbortController().signal,
    );
  const status = () =>
    controller.handle(
      "POST",
      new URL(
        "https://agent.example.test/admin/api/identity/catalog/oauth/status",
      ),
      { ...target, serviceId },
      context,
      new AbortController().signal,
    );
  const finish = (state: string, patch: object = {}) =>
    controller.handle(
      "POST",
      new URL(
        "https://agent.example.test/admin/api/identity/catalog/oauth/finish",
      ),
      { state, code: "synthetic-code", iss: metadata.issuer, ...patch },
      context,
      new AbortController().signal,
    );
  const configure = async (requiredFor = "all") => {
    await call("save", {
      settings: { requiredFor, signInHint: "microsoft" },
      client: {},
    });
    await call("discover");
    await call("register");
  };
  const start = async () => {
    const result = (await call("start")) as { authorizationUrl: string };
    return new URL(result.authorizationUrl).searchParams.get("state")!;
  };
  const connect = async () => finish(await start());
  /** The current person stops confirming one of their own writes. */
  const dontAsk = async (id = writeId) => {
    const url = (path: string) =>
      new URL(
        `https://agent.example.test/admin/api/identity/catalog/oauth/${path}`,
      );
    const signal = new AbortController().signal;
    const current = (await controller.handle(
      "POST",
      url("permissions"),
      { ...target, serviceId },
      context,
      signal,
    )) as { revision: number };
    return controller.handle(
      "POST",
      url("permissions/save"),
      {
        ...target,
        serviceId,
        revision: current.revision,
        actions: [{ actionId: id, enabled: true, approval: "never" }],
      },
      context,
      signal,
    );
  };
  const invoke = (id = writeId, requestId = "op", approve = false) =>
    controller.invoke(
      {
        ...target,
        serviceId,
        serviceRevision: snapshot().serviceRevision,
        actionId: id,
        revision: store
          .service(target.workspaceId, serviceId)
          .actions.find((a) => a.id === id)!.revision,
        requestId,
        input: {},
        approve,
      },
      context,
      new AbortController().signal,
    );
  return {
    db,
    command,
    store,
    oauth,
    controller,
    context,
    requests,
    audits,
    call,
    status,
    finish,
    configure,
    start,
    connect,
    dontAsk,
    invoke,
    snapshot,
    readId,
    writeId,
    approvedId,
    switchUser: (user: string, nextRole: "owner" | "member" = "member") => {
      userId = user;
      sessionId = `session-${user}`;
      role = nextRole;
    },
    switchSession: () => {
      sessionId += "-new";
    },
    before: (fn?: () => void) => {
      beforeNetwork = fn;
    },
    after: (fn?: () => void) => {
      afterNetwork = fn;
    },
  };
}
test("personal authentication blocks shared fallback, uses the real upstream identity, and isolates users", async () => {
  const h = harness();
  try {
    await h.configure();
    await assert.rejects(h.invoke(), /service_oauth_connection_required/);
    await h.connect();
    // Personal writes ask first until the person chooses otherwise.
    assert.equal(
      (await h.invoke(h.writeId, "asks")).status,
      "awaiting_approval",
    );
    await h.dontAsk();
    const result = await h.invoke();
    assert.equal(result.status, "succeeded");
    assert.equal(result.executionPin?.externalUserId, "crm-alice");
    const outgoing = h.requests.at(-1)!;
    assert.ok(outgoing.headers?.Authorization?.startsWith("Bearer "));
    assert.equal(outgoing.headers?.["X-Shared-Key"], undefined);
    assert.ok(!JSON.stringify(await h.status()).includes("test-client-secret"));
    h.switchUser("bob");
    await assert.rejects(
      h.invoke(h.writeId, "bob-op"),
      /service_oauth_connection_required/,
    );
    await assert.rejects(
      h.call("save", {
        settings: { requiredFor: "none", signInHint: "service" },
        client: {},
      }),
      /identity_forbidden/,
    );
    await h.connect();
    assert.equal(
      (await h.invoke(h.writeId, "bob-op")).executionPin?.externalUserId,
      "crm-bob",
    );
  } finally {
    h.db.close();
  }
});
test("writes-only policy keeps reads shared, and credential changes invalidate personal access", async () => {
  const h = harness();
  try {
    await h.configure("writes");
    assert.equal((await h.invoke(h.readId, "read-op")).status, "succeeded");
    assert.equal(
      h.requests.at(-1)?.headers?.["X-Shared-Key"],
      "synthetic-shared-key",
    );
    await h.connect();
    // Approval mode and hint text keep everyone's connection.
    await h.call("save", {
      settings: { requiredFor: "all", signInHint: "microsoft" },
      client: {},
    });
    const personal = await h.invoke(h.readId, "personal-read");
    assert.equal(personal.status, "succeeded");
    assert.equal(personal.executionPin?.externalUserId, "crm-alice");
    // Requested permissions change what the token stands for.
    await h.call("save", {
      settings: {
        requiredFor: "all",
        signInHint: "microsoft",
        scopes: ["api"],
      },
      client: {},
    });
    await assert.rejects(
      h.invoke(h.readId, "new-read"),
      /service_oauth_connection_required/,
    );
  } finally {
    h.db.close();
  }
});
test("callback is bound to user, session, issuer and one-use state", async () => {
  const h = harness();
  try {
    await h.configure();
    const state = await h.start();
    h.switchUser("bob");
    await assert.rejects(h.finish(state), /service_oauth_state_invalid/);
    h.switchUser("alice", "owner");
    await assert.rejects(
      h.finish(state, { iss: "https://evil.example.test" }),
      /service_oauth_state_invalid/,
    );
    await h.finish(state);
    await assert.rejects(h.finish(state), /service_oauth_state_invalid/);
    const next = await h.start();
    h.switchSession();
    await assert.rejects(h.finish(next), /service_oauth_state_invalid/);
  } finally {
    h.db.close();
  }
});
test("changed session during token exchange does not save a connection", async () => {
  const h = harness();
  try {
    await h.configure();
    const state = await h.start();
    h.after(() => h.switchSession());
    await assert.rejects(h.finish(state), /service_oauth_state_invalid/);
    assert.equal(
      h.oauth.status(h.snapshot(), "alice").connection.status,
      "disconnected",
    );
  } finally {
    h.db.close();
  }
});
test("service/config change during discovery rejects stale metadata", async () => {
  const h = harness();
  try {
    h.after(() =>
      h.oauth.save(h.snapshot(), 0, {
        requiredFor: "all",
        signInHint: "service",
      }),
    );
    await assert.rejects(h.call("discover"), /service_oauth_conflict/);
    assert.equal(h.oauth.config(h.snapshot()).discovery, null);
  } finally {
    h.db.close();
  }
});
test("approval cannot switch the personal account and sources cannot cross reconnects", async () => {
  const h = harness();
  try {
    await h.configure();
    await h.connect();
    assert.equal(
      (await h.invoke(h.approvedId, "approval")).status,
      "awaiting_approval",
    );
    await h.invoke(h.readId, "source");
    await h.connect();
    await assert.rejects(
      h.invoke(h.approvedId, "approval", true),
      /service_oauth_conflict/,
    );
    assert.throws(
      () =>
        h.store.contactSource(
          "source",
          target.organizationId,
          target.workspaceId,
          { userId: "alice", role: "owner" },
        ),
      /service_oauth_conflict/,
    );
    assert.equal(
      h.requests.filter(
        (r) => r.url.endsWith("/contacts") && r.method === "POST",
      ).length,
      0,
    );
  } finally {
    h.db.close();
  }
});
test("disconnect before dispatch blocks it; expiry after a known response preserves success", async () => {
  const h = harness();
  const now = Date.now;
  try {
    await h.configure();
    await h.connect();
    await h.dontAsk();
    h.before(() =>
      h.oauth.disconnect(
        h.snapshot(),
        "alice",
        h.oauth.status(h.snapshot(), "alice").connection.revision,
      ),
    );
    assert.equal((await h.invoke()).status, "failed");
    assert.equal(
      h.requests.some((r) => r.url.endsWith("/contacts")),
      false,
    );
    h.before();
    await h.connect();
    const expires = h.oauth.status(h.snapshot(), "alice").connection.expiresAt!;
    h.after(() => {
      Date.now = () => expires + 1;
    });
    assert.equal((await h.invoke(h.writeId, "known")).status, "succeeded");
  } finally {
    Date.now = now;
    h.db.close();
  }
});
test("OAuth management requires an account session even with catalog permissions", async () => {
  const h = harness();
  try {
    delete h.context.session;
    await assert.rejects(h.status(), /identity_account_required/);
  } finally {
    h.db.close();
  }
});
test("Jev advises using public metadata only and never changes authentication policy", async () => {
  const h = harness();
  try {
    await h.configure("none");
    const provider = h.command({
      type: "saveProvider",
      revision: 0,
      settings: {
        name: "TEST Jev",
        url: "https://openrouter.ai/api/v1",
        enabled: true,
        dailyRequestLimit: 20,
      },
      apiKey: "synthetic-model-key",
    });
    const modelId = h.command({
      type: "saveModel",
      revision: 0,
      settings: {
        providerId: provider,
        model: "typesafe/jev-1.13",
        name: "TEST Jev",
        enabled: true,
        kind: "decision",
        tools: false,
      },
    });
    const chatModel = h.command({
      type: "saveModel",
      revision: 0,
      settings: {
        providerId: provider,
        model: "test/chat",
        name: "TEST chat",
        enabled: true,
        kind: "chat",
        tools: true,
      },
    });
    h.command({
      type: "saveRouting",
      routing: {
        revision: 0,
        modelId: chatModel,
        decision: { enabled: true, modelId, minConfidence: 0.8 },
        services: [],
      },
    });
    const before = h.oauth.config(h.snapshot());
    assert.deepEqual(await h.call("suggest"), {
      adapter: "twenty",
      confidence: 0.95,
    });
    assert.deepEqual(h.oauth.config(h.snapshot()), before);
    const request = h.requests.at(-1)!;
    assert.equal(request.url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(request.headers?.Authorization, "Bearer synthetic-model-key");
    assert.ok(!JSON.stringify(request.body).includes("test-client-secret"));
    assert.ok(!JSON.stringify(request.body).includes("synthetic-shared-key"));
    h.switchUser("bob");
    await assert.rejects(h.call("suggest"), /identity_forbidden/);
  } finally {
    h.db.close();
  }
});
test("disabling OAuth remains possible after changing the service to trusted HTTP", () => {
  const h = harness();
  try {
    const target = h.snapshot();
    h.oauth.save(target, 0, { requiredFor: "all", signInHint: "service" });
    const local = { ...target, serviceUrl: "http://localhost:1234" };
    h.oauth.save(local, 1, { requiredFor: "none", signInHint: "service" });
    assert.equal(h.oauth.config(local).settings.requiredFor, "none");
    assert.throws(
      () =>
        h.oauth.save(local, 2, { requiredFor: "all", signInHint: "service" }),
      /service_oauth_https_required/,
    );
  } finally {
    h.db.close();
  }
});

test("old personal approvals and contact sources never switch silently to a shared identity", async () => {
  const h = harness();
  try {
    assert.equal(
      (await h.invoke(h.approvedId, "approval")).status,
      "awaiting_approval",
    );
    await h.invoke(h.readId, "source");
    for (const id of ["approval", "source"]) {
      const row = h.db
        .prepare("SELECT data FROM agent_service_invocation WHERE id=?")
        .get(id)!;
      const value = JSON.parse(String(row.data));
      value.executionPin = {
        kind: "personal",
        connectionRevision: 1,
        userId: "alice",
      };
      h.db
        .prepare("UPDATE agent_service_invocation SET data=? WHERE id=?")
        .run(JSON.stringify(value), id);
    }
    await assert.rejects(
      h.invoke(h.approvedId, "approval", true),
      /service_oauth_conflict/,
    );
    assert.throws(
      () =>
        h.store.contactSource(
          "source",
          target.organizationId,
          target.workspaceId,
          { userId: "alice", role: "owner" },
        ),
      /service_oauth_conflict/,
    );
    assert.equal(
      h.requests.filter((request) => request.method === "POST").length,
      0,
    );
  } finally {
    h.db.close();
  }
});
test("members list the services that ask for their own account, with their own sign-in state", async () => {
  const h = harness();
  const list = async () =>
    (await h.controller.handle(
      "POST",
      new URL(
        "https://agent.example.test/admin/api/identity/catalog/oauth/list",
      ),
      target,
      h.context,
      new AbortController().signal,
    )) as {
      services: {
        serviceId: string;
        name: string;
        status: string;
        ready: boolean;
        requiredFor: string;
        configRevision: number;
        connectionRevision: number;
      }[];
    };
  try {
    // Shared-key services need no personal sign-in.
    assert.deepEqual((await list()).services, []);
    await h.configure("writes");
    const before = (await list()).services;
    assert.equal(before.length, 1);
    assert.equal(before[0]!.name, "TEST CRM");
    assert.equal(before[0]!.status, "disconnected");
    assert.equal(before[0]!.ready, true);
    assert.equal(before[0]!.requiredFor, "writes");
    assert.equal(
      before[0]!.configRevision,
      h.oauth.config(h.snapshot()).revision,
    );
    await h.connect();
    const connected = await list();
    assert.equal(connected.services[0]!.status, "connected");
    assert.ok(!JSON.stringify(connected).includes("test-client"));
    // A member sees the same service with their own, separate state.
    h.switchUser("bob");
    const bob = (await list()).services;
    assert.equal(bob.length, 1);
    assert.equal(bob[0]!.status, "disconnected");
    // Disconnecting uses the listed connection revision.
    h.switchUser("alice", "owner");
    await h.controller.handle(
      "POST",
      new URL(
        "https://agent.example.test/admin/api/identity/catalog/oauth/disconnect",
      ),
      {
        ...target,
        serviceId: (await list()).services[0]!.serviceId,
        connectionRevision: (await list()).services[0]!.connectionRevision,
      },
      h.context,
      new AbortController().signal,
    );
    assert.equal((await list()).services[0]!.status, "disconnected");
  } finally {
    h.db.close();
  }
});
test("personal choices apply at dispatch, and 'don't ask next time' follows a confirmed approval", async () => {
  const h = harness();
  const signal = new AbortController().signal;
  const personal = (path: string, body: object) =>
    h.controller.handle(
      "POST",
      new URL(
        `https://agent.example.test/admin/api/identity/catalog/oauth/${path}`,
      ),
      { ...target, ...body },
      h.context,
      signal,
    );
  try {
    await h.configure();
    await h.connect();
    const pending = await h.invoke(h.writeId, "pending");
    assert.equal(pending.status, "awaiting_approval");
    assert.deepEqual(await personal("approval", { operationId: "pending" }), {
      available: true,
    });
    // Someone else cannot see or change Alice's operation.
    h.switchUser("bob");
    assert.deepEqual(await personal("approval", { operationId: "pending" }), {
      available: false,
    });
    await assert.rejects(
      personal("approval/remember", { operationId: "pending" }),
      /personal_policy_unavailable/,
    );
    h.switchUser("alice", "owner");
    // Approve first, then stop asking: the next change runs at once.
    assert.equal(
      (await h.invoke(h.writeId, "pending", true)).status,
      "succeeded",
    );
    assert.deepEqual(
      await personal("approval/remember", { operationId: "pending" }),
      { ok: true },
    );
    assert.deepEqual(await personal("approval", { operationId: "pending" }), {
      available: false,
    });
    assert.equal((await h.invoke(h.writeId, "direct")).status, "succeeded");

    // A pending approval rechecks the person's switch when it is approved.
    const permissions = (await personal("permissions", {
      serviceId: h.snapshot().serviceId,
    })) as { revision: number };
    await personal("permissions/save", {
      serviceId: h.snapshot().serviceId,
      revision: permissions.revision,
      actions: [{ actionId: h.approvedId, enabled: true, approval: "always" }],
    });
    assert.equal(
      (await h.invoke(h.approvedId, "later")).status,
      "awaiting_approval",
    );
    const current = (await personal("permissions", {
      serviceId: h.snapshot().serviceId,
    })) as { revision: number };
    await personal("permissions/save", {
      serviceId: h.snapshot().serviceId,
      revision: current.revision,
      actions: [{ actionId: h.approvedId, enabled: false, approval: "always" }],
    });
    const dispatched = h.requests.length;
    await assert.rejects(
      h.invoke(h.approvedId, "later", true),
      /catalog_action_denied/,
    );
    await assert.rejects(
      h.invoke(h.approvedId, "fresh"),
      /catalog_action_denied/,
    );
    assert.equal(h.requests.length, dispatched);
  } finally {
    h.db.close();
  }
});
test("a shared service offers no personal approval choice", async () => {
  const h = harness();
  try {
    await h.configure("none");
    const operation = await h.invoke(h.approvedId, "shared");
    assert.equal(operation.status, "awaiting_approval");
    const result = await h.controller.handle(
      "POST",
      new URL(
        "https://agent.example.test/admin/api/identity/catalog/oauth/approval",
      ),
      { ...target, operationId: "shared" },
      h.context,
      new AbortController().signal,
    );
    assert.deepEqual(result, { available: false });
  } finally {
    h.db.close();
  }
});

/** Adds an MCP service by address through the console command, as an administrator does. */
async function addMcp(h: ReturnType<typeof harness>, url: string, id?: string) {
  const result = (await h.controller.handle(
    "POST",
    new URL("https://agent.example.test/admin/api/identity/catalog/command"),
    {
      ...target,
      type: "saveService",
      ...(id ? { id } : {}),
      revision: id ? h.store.service(target.workspaceId, id).revision : 0,
      settings: {
        name: "TEST MCP",
        url,
        protocol: "mcp",
        icon: "plug",
        auth: { type: "none" },
        enabled: true,
      },
    },
    h.context,
    new AbortController().signal,
  )) as { id: string };
  return result.id;
}
const oauthCall = (
  h: ReturnType<typeof harness>,
  action: string,
  serviceId: string,
) =>
  h.controller.handle(
    "POST",
    new URL(
      `https://agent.example.test/admin/api/identity/catalog/oauth/${action}`,
    ),
    { ...target, serviceId },
    h.context,
    new AbortController().signal,
  ) as Promise<ServiceOAuthStatus>;
const wellKnown = (h: ReturnType<typeof harness>) =>
  h.requests.filter((r) => r.url.includes("/.well-known/")).length;
const registrations = (h: ReturnType<typeof harness>) =>
  h.requests.filter((r) => r.url.endsWith("/register")).length;

test("adding an MCP service by address detects its OAuth and registers a public client on its own", async () => {
  const h = harness({
    metadataFor: () => ({
      ...metadata,
      token_endpoint_auth_methods_supported: ["none"],
    }),
    registration: {
      client_id: "public-client",
      token_endpoint_auth_method: "none",
    },
  });
  try {
    const serviceId = await addMcp(h, "https://crm.example.test/mcp");
    // The save itself started the probe; the console only waits for it.
    let status = await oauthCall(h, "status", serviceId);
    for (let i = 0; i < 50 && !status.config.lastProbe; i++) {
      await new Promise((r) => setTimeout(r, 10));
      status = await oauthCall(h, "status", serviceId);
    }
    assert.equal(status.config.lastProbe?.outcome, "configured");
    assert.equal(status.config.discovery?.issuer, metadata.issuer);
    assert.deepEqual(status.config.settings, {
      requiredFor: "all",
      source: "service",
      signInHint: "service",
      scopes: ["api", "profile"],
    });
    assert.equal(status.config.hasClientId, true);
    assert.equal(status.config.hasClientSecret, false, "PKCE-only client");
    // The gate was never set: everyone in the organization may connect,
    // owners and administrators included.
    assert.deepEqual(h.store.service(target.workspaceId, serviceId).access, {
      roles: ["owner", "admin", "member"],
      workspaceRoles: [],
    });
    assert.equal(registrations(h), 1);
    assert.equal(
      h.requests.find((r) => r.url.endsWith("/register"))?.url,
      "https://crm.example.test/oauth/register",
      "registered where the administrator pointed",
    );
    const probes = h.audits.filter((a) => a.details.oauthProbe);
    assert.equal(probes.length, 1);
    assert.deepEqual(
      {
        action: probes[0]!.action,
        targetId: probes[0]!.targetId,
        actorId: probes[0]!.actorId,
        outcome: probes[0]!.details.oauthProbe,
      },
      {
        action: "catalog.service_changed",
        targetId: serviceId,
        actorId: "alice",
        outcome: "configured",
      },
    );
    // Running it again changes nothing and asks the network nothing.
    const seen = h.requests.length;
    const again = await oauthCall(h, "auto", serviceId);
    assert.equal(again.config.revision, status.config.revision);
    assert.equal(h.requests.length, seen);
    assert.equal(h.audits.filter((a) => a.details.oauthProbe).length, 1);
    // The person can start signing in right away.
    const started = (await h.controller.handle(
      "POST",
      new URL(
        "https://agent.example.test/admin/api/identity/catalog/oauth/start",
      ),
      { ...target, serviceId, revision: again.config.revision },
      h.context,
      new AbortController().signal,
    )) as { authorizationUrl: string };
    assert.equal(
      new URL(started.authorizationUrl).searchParams.get("client_id"),
      "public-client",
    );
    // Members may not run it.
    h.switchUser("bob");
    await assert.rejects(oauthCall(h, "auto", serviceId), /identity_forbidden/);
  } finally {
    h.db.close();
  }
});
test("metadata without a registration endpoint configures sign-in and says the client is missing", async () => {
  const h = harness({
    metadataFor: () => ({ ...metadata, registration_endpoint: undefined }),
  });
  try {
    const serviceId = await addMcp(h, "https://crm.example.test/mcp");
    const status = await oauthCall(h, "auto", serviceId);
    assert.equal(status.config.discovery?.registrationEndpoint, null);
    assert.equal(status.config.settings.requiredFor, "all");
    assert.equal(status.config.settings.source, "service");
    assert.equal(status.config.hasClientId, false);
    assert.deepEqual(
      { ...status.config.lastProbe, at: 0 },
      {
        at: 0,
        outcome: "metadata",
        reason: "service_oauth_registration_unsupported",
      },
    );
    assert.equal(registrations(h), 0);
    assert.equal(h.audits.filter((a) => a.details.oauthProbe).length, 1);
    // Entering a client by hand finishes it; a re-run keeps that client.
    await h.controller.handle(
      "POST",
      new URL(
        "https://agent.example.test/admin/api/identity/catalog/oauth/save",
      ),
      {
        ...target,
        serviceId,
        revision: status.config.revision,
        settings: status.config.settings,
        client: { clientId: "manual-client", clientSecret: "manual-secret" },
      },
      h.context,
      new AbortController().signal,
    );
    const seen = h.requests.length;
    const again = await oauthCall(h, "auto", serviceId);
    assert.equal(again.config.hasClientId, true);
    assert.equal(again.config.hasClientSecret, true);
    assert.equal(h.requests.length, seen);
  } finally {
    h.db.close();
  }
});
test("no OAuth metadata leaves the service as added and notes why", async () => {
  const h = harness({ metadataFor: () => ({ error: "not_found" }) });
  try {
    const serviceId = await addMcp(h, "https://plain.example.test/mcp");
    const status = await oauthCall(h, "auto", serviceId);
    assert.equal(status.config.discovery, null);
    assert.equal(status.config.hasClientId, false);
    assert.deepEqual(status.config.settings, {
      requiredFor: "none",
      signInHint: "service",
    });
    assert.deepEqual(
      { ...status.config.lastProbe, at: 0 },
      { at: 0, outcome: "none", reason: "service_oauth_response_invalid" },
    );
    assert.equal(registrations(h), 0);
    assert.equal(h.audits.filter((a) => a.details.oauthProbe).length, 1);
    // Every call is shared: no personal sign-in was switched on.
    assert.equal(h.oauth.requiredFor(target.workspaceId, serviceId), "none");
    // An OpenAPI service is left alone entirely.
    const seen = wellKnown(h);
    const openapiId = (await h.controller.handle(
      "POST",
      new URL("https://agent.example.test/admin/api/identity/catalog/command"),
      {
        ...target,
        type: "saveService",
        revision: 0,
        settings: {
          name: "TEST API",
          url: "https://crm.example.test/api",
          protocol: "openapi",
          icon: "plug",
          auth: { type: "none" },
          enabled: true,
        },
      },
      h.context,
      new AbortController().signal,
    )) as { id: string };
    const openapi = await oauthCall(h, "auto", openapiId.id);
    assert.equal(openapi.config.lastProbe, null);
    assert.equal(wellKnown(h), seen);
  } finally {
    h.db.close();
  }
});
test("an existing client and an administrator's settings survive the probe; a new address is probed again", async () => {
  const h = harness({
    metadataFor: (url) => ({
      ...metadata,
      issuer: url.origin,
      authorization_endpoint: `${url.origin}/authorize`,
      token_endpoint: `${url.origin}/oauth/token`,
      registration_endpoint: `${url.origin}/oauth/register`,
    }),
  });
  try {
    // Created without the console: nothing probed yet.
    const serviceId = h.command({
      type: "saveService",
      revision: 0,
      settings: {
        name: "TEST MCP",
        url: "https://crm.example.test/mcp",
        protocol: "mcp",
        icon: "plug",
        auth: { type: "none" },
        enabled: true,
      },
    });
    await h.controller.handle(
      "POST",
      new URL(
        "https://agent.example.test/admin/api/identity/catalog/oauth/save",
      ),
      {
        ...target,
        serviceId,
        revision: 0,
        settings: { requiredFor: "writes", scopes: ["api"] },
        client: { clientId: "own-client", clientSecret: "own-secret" },
      },
      h.context,
      new AbortController().signal,
    );
    const status = await oauthCall(h, "auto", serviceId);
    assert.equal(status.config.discovery?.issuer, "https://crm.example.test");
    assert.deepEqual(status.config.settings, {
      requiredFor: "writes",
      scopes: ["api"],
    });
    assert.equal(status.config.hasClientId, true);
    assert.equal(status.config.hasClientSecret, true);
    assert.equal(registrations(h), 0, "an existing client is never replaced");
    assert.equal(status.config.lastProbe?.outcome, "configured");
    // A new address: the old origin's metadata and client are gone, the
    // settings stay, and the new origin is asked again.
    await addMcp(h, "https://crm2.example.test/mcp", serviceId);
    const moved = await oauthCall(h, "auto", serviceId);
    assert.equal(moved.config.discovery?.issuer, "https://crm2.example.test");
    assert.deepEqual(moved.config.settings, {
      requiredFor: "writes",
      scopes: ["api"],
    });
    assert.equal(moved.config.hasClientId, true);
    assert.equal(moved.config.hasClientSecret, true);
    assert.equal(registrations(h), 1);
    assert.equal(
      h.requests.find((r) => r.url.endsWith("/register"))?.url,
      "https://crm2.example.test/oauth/register",
    );
    assert.equal(moved.config.lastProbe?.outcome, "configured");
    assert.equal(h.audits.filter((a) => a.details.oauthProbe).length, 2);
  } finally {
    h.db.close();
  }
});
test("a connection gate an administrator set is left as it is", async () => {
  const h = harness();
  try {
    const result = (await h.controller.handle(
      "POST",
      new URL("https://agent.example.test/admin/api/identity/catalog/command"),
      {
        ...target,
        type: "saveService",
        revision: 0,
        settings: {
          name: "TEST MCP",
          url: "https://crm.example.test/mcp",
          protocol: "mcp",
          icon: "plug",
          auth: { type: "none" },
          enabled: true,
          access: { roles: ["member"], workspaceRoles: [] },
        },
      },
      h.context,
      new AbortController().signal,
    )) as { id: string };
    const status = await oauthCall(h, "auto", result.id);
    assert.equal(status.config.settings.requiredFor, "all");
    assert.equal(status.config.lastProbe?.outcome, "configured");
    assert.deepEqual(h.store.service(target.workspaceId, result.id).access, {
      roles: ["member"],
      workspaceRoles: [],
    });
  } finally {
    h.db.close();
  }
});
