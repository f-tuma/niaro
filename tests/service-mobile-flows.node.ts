import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ServiceOAuthStore } from "../apps/server-identity/service-oauth";
import { ServiceMobileFlows } from "../apps/server-identity/service-mobile-flows";
import { ServiceCatalogStore } from "../apps/server-identity/service-catalog";
import { MobileSessionStore } from "../apps/server-identity/mobile";
const ws = "11111111-1111-4111-8111-111111111111";
function harness() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, "userId" TEXT, "expiresAt" TEXT);
    CREATE TABLE member(id TEXT PRIMARY KEY, "organizationId" TEXT, "userId" TEXT, role TEXT);
    CREATE TABLE user(id TEXT PRIMARY KEY); CREATE TABLE organization(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'); INSERT INTO organization VALUES ('org');
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT);
    CREATE TABLE agent_workspace_member(workspace_id TEXT, member_id TEXT);
    INSERT INTO agent_workspace VALUES ('${ws}','org');
    INSERT INTO member VALUES ('member-alice','org','alice','owner');`);
  db.prepare("INSERT INTO session VALUES (?,?,?)").run(
    "session-alice",
    "alice",
    new Date(Date.now() + 3600000).toISOString(),
  );
  const oauth = new ServiceOAuthStore(
    db,
    "TEST-secret",
    "https://agent.example.test",
  );
  const catalog = new ServiceCatalogStore(db, "TEST-secret", [], oauth);
  // Only the catalog lookup is stubbed: real PKCE state, credentials and mobile grants are used.
  const target = {
    workspaceId: ws,
    serviceId: "service",
    serviceUrl: "https://crm.example.test/mcp",
    serviceRevision: 1,
  };
  catalog.oauthTarget = () => ({ ...target });
  const mobile = new MobileSessionStore(
    db,
    "https://agent.example.test",
    3600000,
  );
  const paired = mobile.issue(
    {
      session_id: "session-alice",
      member_id: "member-alice",
      organization_id: "org",
      workspace_id: ws,
      user_id: "alice",
      server_id: "server",
    },
    new Date(Date.now() + 3600000),
  );
  const credential = mobile.pair(paired.code, ws, "server");
  const account = mobile.authenticate(
    `Bearer ${credential.accessToken}`,
    ws,
    "server",
  );
  const actor = {
    userId: "alice",
    sessionId: `mobile:${account.credentialId}`,
  };
  oauth.save(target, 0, { requiredFor: "all" }, { clientId: "TEST-client" });
  oauth.setDiscovery(target, 1, {
    issuer: "https://crm.example.test",
    authorizationEndpoint: "https://crm.example.test/authorize",
    tokenEndpoint: "https://crm.example.test/oauth/token",
    registrationEndpoint: null,
    scopes: ["api", "profile"],
    tokenEndpointAuthMethods: ["none"],
    authorizationResponseIssParameterSupported: true,
  });
  const flows = new ServiceMobileFlows(db, catalog, mobile);
  return { db, oauth, catalog, mobile, target, actor, credential, flows };
}
test("Chat service connection is a standalone handoff bound to mobile and browser user", () => {
  const h = harness();
  try {
    const started = h.flows.start(h.target, h.actor);
    assert.equal(
      started.authorizationUrl,
      `https://agent.example.test/admin/service-connect#${started.attemptId}`,
    );
    assert.equal(
      h.flows.validate(started.attemptId, "server", "alice").flow.actor.userId,
      "alice",
    );
    assert.throws(() => h.flows.validate(started.attemptId, "server", "bob"));
    assert.throws(() =>
      h.flows.read(started.attemptId, { ...h.actor, sessionId: "other" }),
    );
    h.mobile.revoke(`Bearer ${h.credential.accessToken}`);
    assert.throws(() => h.flows.validate(started.attemptId, "server", "alice"));
  } finally {
    h.db.close();
  }
});
test("An old chat card cancels only its own pending attempt and cannot undo a newer connection", () => {
  const h = harness();
  try {
    const old = h.flows.start(h.target, h.actor),
      current = h.flows.start(h.target, h.actor);
    h.flows.cancel(old.attemptId, h.actor);
    assert.throws(() => h.flows.validate(old.attemptId, "server", "alice"));
    h.flows.validate(current.attemptId, "server", "alice");
    const claim = h.oauth.claimFromState(h.actor, {
      state: current.attemptId,
      code: "TEST-code",
      iss: "https://crm.example.test",
    });
    const result = h.oauth.commitConnection(
      claim,
      {
        accessToken: "TEST-access",
        scopes: ["api", "profile"],
        expiresAt: Date.now() + 3600000,
        identity: {
          userId: "crm-alice",
          workspaceId: "crm-workspace",
          userWorkspaceId: "crm-member",
        },
      },
      h.actor,
      h.target,
    );
    h.flows.finish(current.attemptId, result.connection.revision);
    assert.equal(h.flows.cancel(old.attemptId, h.actor).status, "cancelled");
    assert.equal(
      h.flows.cancel(current.attemptId, h.actor).status,
      "connected",
    );
    assert.equal(
      h.oauth.status(h.target, "alice").connection.status,
      "connected",
    );
    assert.throws(() => h.flows.validate(current.attemptId, "server", "alice"));
  } finally {
    h.db.close();
  }
});
test("editing a service's description or actions keeps a pending chat connection", () => {
  const h = harness();
  try {
    const started = h.flows.start(h.target, h.actor);
    h.target.serviceRevision += 3;
    h.flows.validate(started.attemptId, "server", "alice");
  } finally {
    h.db.close();
  }
});
test("Configuration changes and removed membership invalidate a pending chat connection", () => {
  for (const change of ["config", "membership", "service"] as const) {
    const h = harness();
    try {
      const started = h.flows.start(h.target, h.actor);
      if (change === "config")
        h.oauth.save(h.target, 2, { requiredFor: "writes" });
      if (change === "membership") h.db.prepare("DELETE FROM member").run();
      if (change === "service")
        h.target.serviceUrl = "https://elsewhere.example.test/mcp";
      assert.throws(() =>
        h.flows.validate(started.attemptId, "server", "alice"),
      );
    } finally {
      h.db.close();
    }
  }
});
