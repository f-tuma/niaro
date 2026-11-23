import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  McpAccessStore,
  type McpAuthenticationTarget,
} from "../apps/server-identity/mcp-access";
import { IdentityError } from "../apps/server-identity/error";
import { McpPolicyStore } from "../apps/server-identity/mcp-policy";
import type { AuditRecord } from "../packages/protocol/audit";

function fixture() {
  const db = new DatabaseSync(":memory:");
  let now = Date.parse("2026-10-14T12:00:00Z");
  const enabled = new Set(["server-a", "server-b"]);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE user(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE session(id TEXT PRIMARY KEY,"userId" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,"expiresAt" TEXT NOT NULL) STRICT;
    CREATE TABLE organization(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE member(id TEXT PRIMARY KEY,"userId" TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,"organizationId" TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,role TEXT NOT NULL,UNIQUE("userId","organizationId")) STRICT;
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE) STRICT;
    CREATE TABLE agent_workspace_member(workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE,PRIMARY KEY(workspace_id,member_id)) STRICT;
    INSERT INTO user VALUES ('alice'),('bob'),('admin'),('owner'),('outsider');
    INSERT INTO organization VALUES ('org-a'),('org-b');
    INSERT INTO member VALUES ('alice-member','alice','org-a','member'),('bob-member','bob','org-a','member'),('admin-member','admin','org-a','admin'),('owner-member','owner','org-a','owner'),('outsider-member','outsider','org-b','owner');
    INSERT INTO agent_workspace VALUES ('workspace-a','org-a'),('workspace-b','org-a'),('workspace-c','org-b');
    INSERT INTO agent_workspace_member VALUES ('workspace-a','alice-member'),('workspace-b','alice-member'),('workspace-a','bob-member');`);
  for (const user of ["alice", "bob", "admin", "owner", "outsider"])
    db.prepare("INSERT INTO session VALUES (?,?,?)").run(
      `${user}-session`,
      user,
      new Date(now + 60_000).toISOString(),
    );
  const audits: AuditRecord[] = [];
  const policies = new McpPolicyStore(
    db,
    (record) => audits.push(record),
    () => now,
  );
  // The existing cases predate NIAR-237: members' grants are active there.
  policies.save("workspace-a", "free", 0);
  policies.save("workspace-b", "free", 0);
  const create = (maxActiveGrants = 50) =>
    new McpAccessStore(db, {
      checkServer: (serverId) => enabled.has(serverId),
      policy: (workspaceId) => policies.policy(workspaceId),
      now: () => now,
      maxActiveGrants,
    });
  const store = create();
  const management = {
    sessionId: "alice-session",
    serverId: "server-a",
    workspaceId: "workspace-a",
  };
  const issue = (overrides: Record<string, unknown> = {}) =>
    store.issue({
      ...management,
      label: "TEST own client",
      scopes: ["data.read", "memory.write"],
      expiresAt: now + 3_600_000,
      ...overrides,
    });
  return {
    db,
    store,
    issue,
    create,
    management,
    enabled,
    policies,
    audits,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const target = { serverId: "server-a", workspaceId: "workspace-a" };
function denied(fn: () => unknown, status: number, code: string) {
  assert.throws(
    fn,
    (error: unknown) =>
      error instanceof IdentityError &&
      error.status === status &&
      error.code === code,
  );
}

test("MCP secret is returned once, only its digest persists; principal and discovery come from the grant", () => {
  const f = fixture();
  try {
    const first = f.issue();
    assert.match(first.accessToken, /^agent_mcp_[A-Za-z0-9_-]{43}$/);
    const principal = f.store.authenticate(`Bearer ${first.accessToken}`, {
      serverId: "server-a",
      requiredScopes: ["data.read", "memory.write"],
    });
    assert.deepEqual(principal, {
      grantId: first.grant.id,
      userId: "alice",
      memberId: "alice-member",
      organizationId: "org-a",
      workspaceId: "workspace-a",
      serverId: "server-a",
      role: "member",
      scopes: ["data.read", "memory.write"],
      expiresAt: first.grant.expiresAt,
      label: first.grant.label,
    });
    const persisted = f.db.prepare("SELECT * FROM agent_mcp_access").get()!;
    assert.match(String(persisted.token_digest), /^[a-f0-9]{64}$/);
    assert.equal(
      persisted.token_digest,
      createHash("sha256")
        .update(`agent-mcp-access/1\0${first.accessToken}`)
        .digest("hex"),
    );
    const grants = f.store.list(f.management);
    assert.equal(grants.length, 1);
    assert.equal(grants[0]!.lastUsedAt, new Date(f.now()).toISOString());
    for (const value of [persisted, grants, principal]) {
      const json = JSON.stringify(value);
      assert(!json.includes(first.accessToken));
      assert(!json.includes(first.accessToken.slice("agent_mcp_".length)));
    }
    assert(!JSON.stringify(grants).includes(String(persisted.token_digest)));
    assert(!JSON.stringify(principal).includes(String(persisted.token_digest)));
    // Reopening the store is idempotent and uses the existing user and membership.
    assert.deepEqual(
      f.create().authenticate(`Bearer ${first.accessToken}`, target),
      principal,
    );
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM user").get()!.n, 5);
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    f.db.close();
  }
});

test("issuance requires an unexpired identity session and live workspace access; browser logout does not revoke an issued grant", () => {
  const f = fixture();
  try {
    denied(() => f.issue({ sessionId: "missing" }), 401, "mcp_unauthorized");
    denied(
      () => f.issue({ sessionId: "alice-session", userId: "bob" }),
      400,
      "mcp_access_invalid",
    );
    denied(
      () => f.issue({ workspaceId: "workspace-c" }),
      403,
      "mcp_scope_mismatch",
    );
    denied(
      () => f.issue({ serverId: "unknown-server" }),
      403,
      "mcp_server_unavailable",
    );
    denied(() => f.issue({ expiresAt: f.now() }), 400, "mcp_access_invalid");
    denied(
      () => f.issue({ expiresAt: f.now() + 31 * 24 * 60 * 60_000 }),
      400,
      "mcp_access_invalid",
    );
    const first = f.issue();
    f.advance(60_000);
    denied(() => f.issue(), 401, "mcp_unauthorized");
    assert.equal(
      f.store.authenticate(`Bearer ${first.accessToken}`, target).userId,
      "alice",
    );
    f.db.prepare("DELETE FROM session WHERE id=?").run("alice-session");
    assert.equal(
      f.store.authenticateGrant(first.grant.id, target).userId,
      "alice",
    );
  } finally {
    f.db.close();
  }
});

test("explicit admin issuance binds to the target user's current identity, and requires same-organization administrative authority", () => {
  const f = fixture();
  try {
    const input = {
      ...target,
      userId: "alice",
      administratorSessionId: "admin-session",
      label: "TEST admin grant",
      scopes: ["data.read"],
      expiresAt: f.now() + 60_000,
    };
    const grant = f.store.issueForUser(input);
    assert.equal(grant.grant.issuedByUserId, "admin");
    assert.equal(
      f.store.authenticate(`Bearer ${grant.accessToken}`, target).userId,
      "alice",
    );
    denied(
      () =>
        f.store.issueForUser({
          ...input,
          administratorSessionId: "alice-session",
        }),
      403,
      "mcp_scope_mismatch",
    );
    denied(
      () =>
        f.store.issueForUser({
          ...input,
          administratorSessionId: "outsider-session",
        }),
      403,
      "mcp_scope_mismatch",
    );
    denied(
      () => f.store.issueForUser({ ...input, userId: "outsider" }),
      403,
      "mcp_scope_mismatch",
    );
    denied(
      () => f.store.issueForUser({ ...input, userId: undefined }),
      400,
      "mcp_access_invalid",
    );
    denied(
      () =>
        f.store.issueForUser({ ...input, administratorSessionId: "missing" }),
      401,
      "mcp_unauthorized",
    );
    const owner = f.store.issueForUser({
      ...input,
      administratorSessionId: "owner-session",
    });
    assert.equal(owner.grant.userId, "alice");
    assert.deepEqual(
      f.store.list({ ...f.management, sessionId: "admin-session" }),
      [],
    );
  } finally {
    f.db.close();
  }
});

test("MCP never authenticates mobile, admin, session, refresh or grant-ID credentials, and denies cross-server, workspace and scope requests", () => {
  const f = fixture();
  try {
    const grant = f.issue({ scopes: ["data.read"] });
    const header = `Bearer ${grant.accessToken}`;
    for (const invalid of [
      undefined,
      "",
      "Bearer alice-session",
      `Bearer ${grant.grant.id}`,
      `Bearer ${randomBytes(32).toString("base64url")}`,
      `Bearer agent_mcp_${randomBytes(32).toString("base64url")}`,
      grant.accessToken,
      `${header} extra`,
      `Basic ${grant.accessToken}`,
      `Bearer ${grant.accessToken.slice(0, -1)}`,
    ])
      denied(
        () => f.store.authenticate(invalid, target),
        401,
        "mcp_unauthorized",
      );
    denied(
      () => f.store.authenticate(header, { ...target, serverId: "server-b" }),
      403,
      "mcp_scope_mismatch",
    );
    denied(
      () =>
        f.store.authenticate(header, { ...target, workspaceId: "workspace-b" }),
      403,
      "mcp_scope_mismatch",
    );
    denied(
      () =>
        f.store.authenticate(header, {
          ...target,
          requiredScopes: ["memory.write"],
        }),
      403,
      "mcp_insufficient_scope",
    );
    denied(
      () => f.issue({ scopes: ["native.approve"] }),
      400,
      "mcp_access_invalid",
    );
    denied(() => f.issue({ scopes: [] }), 400, "mcp_access_invalid");
    denied(
      () => f.issue({ scopes: ["data.read", "data.read"] }),
      400,
      "mcp_access_invalid",
    );
    denied(
      () =>
        f.store.authenticate(header, {
          ...target,
          userId: "bob",
        } as McpAuthenticationTarget),
      400,
      "mcp_access_invalid",
    );
    denied(
      () =>
        f.store.authenticateGrant(grant.grant.id, {
          ...target,
          requiredScopes: ["memory.write"],
        }),
      403,
      "mcp_insufficient_scope",
    );
    denied(
      () =>
        f.store.authenticateGrant(grant.grant.id, {
          ...target,
          serverId: "server-b",
        }),
      403,
      "mcp_scope_mismatch",
    );
    assert.equal(
      f.store.authenticate(header, {
        ...target,
        requiredScopes: ["data.read"],
      }).userId,
      "alice",
    );
    try {
      f.store.authenticate(`${header} extra`, target);
    } catch (error) {
      assert(!String(error).includes(grant.accessToken));
      assert(!JSON.stringify(error).includes(grant.accessToken));
    }
  } finally {
    f.db.close();
  }
});

test("expiry, scoped owner revocation, and active-grant limits are enforced by both token and internal continuation authentication", () => {
  const f = fixture();
  try {
    const limited = f.create(1);
    const first = limited.issue({
      ...f.management,
      label: "TEST limit",
      scopes: ["data.read"],
      expiresAt: f.now() + 1_000,
    });
    denied(
      () =>
        limited.issue({
          ...f.management,
          label: "TEST excess",
          scopes: ["data.read"],
          expiresAt: f.now() + 1_000,
        }),
      429,
      "mcp_access_limit",
    );
    assert.deepEqual(
      f.store.revoke({
        ...f.management,
        sessionId: "bob-session",
        grantId: first.grant.id,
      }),
      { revoked: false },
    );
    assert.deepEqual(
      f.store.revoke({
        ...f.management,
        serverId: "server-b",
        grantId: first.grant.id,
      }),
      { revoked: false },
    );
    assert.deepEqual(
      f.store.revoke({
        ...f.management,
        workspaceId: "workspace-b",
        grantId: first.grant.id,
      }),
      { revoked: false },
    );
    assert.equal(
      f.store.authenticateGrant(first.grant.id, target).userId,
      "alice",
    );
    f.advance(1_000);
    denied(
      () => f.store.authenticate(`Bearer ${first.accessToken}`, target),
      401,
      "mcp_unauthorized",
    );
    denied(
      () => f.store.authenticateGrant(first.grant.id, target),
      401,
      "mcp_unauthorized",
    );
    const next = limited.issue({
      ...f.management,
      label: "TEST replacement",
      scopes: ["memory.write"],
      expiresAt: f.now() + 1_000,
    });
    f.enabled.delete("server-a");
    assert.deepEqual(
      f.store.revoke({ ...f.management, grantId: next.grant.id }),
      { revoked: true },
    );
    const revokedAt = f.db
      .prepare("SELECT revoked_at FROM agent_mcp_access WHERE id=?")
      .get(next.grant.id)!.revoked_at;
    f.advance(1);
    assert.deepEqual(
      f.store.revoke({ ...f.management, grantId: next.grant.id }),
      { revoked: true },
    );
    assert.equal(
      f.db
        .prepare("SELECT revoked_at FROM agent_mcp_access WHERE id=?")
        .get(next.grant.id)!.revoked_at,
      revokedAt,
    );
    f.enabled.add("server-a");
    denied(
      () => f.store.authenticate(`Bearer ${next.accessToken}`, target),
      401,
      "mcp_unauthorized",
    );
    denied(
      () => f.store.authenticateGrant(next.grant.id, target),
      401,
      "mcp_unauthorized",
    );
    assert.equal(
      f.store.list(f.management).find((g) => g.id === next.grant.id)!.revokedAt,
      new Date(Number(revokedAt)).toISOString(),
    );
  } finally {
    f.db.close();
  }
});

test("server disable, workspace exclusion, role downgrade and original-member deletion are rechecked during each use", () => {
  const f = fixture();
  try {
    const grant = f.issue();
    const header = `Bearer ${grant.accessToken}`;
    const bothDenied = (code: string) => {
      denied(() => f.store.authenticate(header, target), 403, code);
      denied(
        () => f.store.authenticateGrant(grant.grant.id, target),
        403,
        code,
      );
    };
    f.enabled.delete("server-a");
    bothDenied("mcp_server_unavailable");
    f.enabled.add("server-a");
    f.db
      .prepare("DELETE FROM agent_workspace_member WHERE member_id=?")
      .run("alice-member");
    bothDenied("mcp_scope_mismatch");
    f.db
      .prepare("UPDATE member SET role='admin' WHERE id=?")
      .run("alice-member");
    assert.equal(f.store.authenticate(header, target).role, "admin");
    f.db
      .prepare("UPDATE member SET role='member' WHERE id=?")
      .run("alice-member");
    bothDenied("mcp_scope_mismatch");
    f.db
      .prepare("INSERT INTO agent_workspace_member VALUES (?,?)")
      .run("workspace-a", "alice-member");
    assert.equal(f.store.authenticate(header, target).role, "member");
    f.db.prepare("DELETE FROM member WHERE id=?").run("alice-member");
    f.db
      .prepare("INSERT INTO member VALUES (?,?,?,?)")
      .run("alice-rejoined", "alice", "org-a", "member");
    f.db
      .prepare("INSERT INTO agent_workspace_member VALUES (?,?)")
      .run("workspace-a", "alice-rejoined");
    denied(() => f.store.authenticate(header, target), 401, "mcp_unauthorized");
    denied(
      () => f.store.authenticateGrant(grant.grant.id, target),
      401,
      "mcp_unauthorized",
    );
    assert.equal(f.issue().grant.memberId, "alice-rejoined");
  } finally {
    f.db.close();
  }
});

test("management history is bounded while current active grants stay visible", () => {
  const f = fixture();
  try {
    const live = f.issue();
    for (let index = 0; index < 205; index++) {
      const retired = f.issue({ label: `TEST retired ${index}` });
      f.store.revoke({ ...f.management, grantId: retired.grant.id });
    }
    const list = f.store.list(f.management);
    assert.equal(list.length, 200);
    assert.equal(list[0]!.id, live.grant.id);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM agent_mcp_access").get()!.n,
      206,
    );
  } finally {
    f.db.close();
  }
});

test("the person's own grants are listed across workspaces and end together, OAuth tokens included", () => {
  const f = fixture();
  try {
    const a = f.issue();
    const b = f.issue({ workspaceId: "workspace-b", label: "TEST second" });
    const bob = f.store.issue({
      sessionId: "bob-session",
      serverId: "server-a",
      workspaceId: "workspace-a",
      label: "TEST bob",
      scopes: ["data.read"],
      expiresAt: f.now() + 3_600_000,
    });
    // The OAuth provider's token tables, as far as revocation needs them.
    f.db
      .exec(`CREATE TABLE "oauthAccessToken"(id TEXT PRIMARY KEY,"userId" TEXT,"referenceId" TEXT,revoked TEXT);
      CREATE TABLE "oauthRefreshToken"(id TEXT PRIMARY KEY,"userId" TEXT,"referenceId" TEXT,revoked TEXT);`);
    f.db
      .prepare('INSERT INTO "oauthAccessToken" VALUES (?,?,?,NULL)')
      .run("t-a", "alice", a.grant.id);
    f.db
      .prepare('INSERT INTO "oauthAccessToken" VALUES (?,?,?,NULL)')
      .run("t-b", "alice", b.grant.id);
    f.db
      .prepare('INSERT INTO "oauthAccessToken" VALUES (?,?,?,NULL)')
      .run("t-bob", "bob", bob.grant.id);
    f.db.exec(`ALTER TABLE agent_workspace ADD COLUMN name TEXT;
      UPDATE agent_workspace SET name='TEST '||id;`);
    const own = f.store.listOwn("alice");
    assert.deepEqual(
      own
        .map((value) => `${value.grant.label} / ${value.workspaceName}`)
        .sort(),
      ["TEST own client / TEST workspace-a", "TEST second / TEST workspace-b"],
    );
    // Someone else's grant cannot be revoked as one's own.
    assert.equal(f.store.revokeOwn("alice", bob.grant.id), false);
    assert.equal(f.store.revokeOwn("alice", a.grant.id), true);
    const revoked = (id: string) =>
      f.db.prepare('SELECT revoked FROM "oauthAccessToken" WHERE id=?').get(id)!
        .revoked !== null;
    assert.equal(revoked("t-a"), true);
    assert.equal(revoked("t-b"), false);
    denied(
      () => f.store.authenticate(`Bearer ${a.accessToken}`, target),
      401,
      "mcp_unauthorized",
    );
    assert.equal(f.store.revokeAllOwn("alice"), 1);
    assert.equal(revoked("t-b"), true);
    assert.equal(revoked("t-bob"), false);
    assert.deepEqual(f.store.listOwn("alice"), []);
    denied(
      () =>
        f.store.authenticate(`Bearer ${b.accessToken}`, {
          serverId: "server-a",
          workspaceId: "workspace-b",
        }),
      401,
      "mcp_unauthorized",
    );
    assert.equal(
      f.store.authenticate(`Bearer ${bob.accessToken}`, target).userId,
      "bob",
    );
  } finally {
    f.db.close();
  }
});

test("members' external AI apps policy defaults to review and saves only from the current revision", () => {
  const f = fixture();
  try {
    assert.deepEqual(f.policies.read("workspace-c"), {
      policy: "review",
      revision: 0,
    });
    assert.deepEqual(f.policies.save("workspace-c", "off", 0), {
      previous: "review",
      policy: "off",
      revision: 1,
    });
    denied(
      () => f.policies.save("workspace-c", "free", 0),
      409,
      "mcp_policy_conflict",
    );
    assert.equal(f.policies.policy("workspace-c"), "off");
  } finally {
    f.db.close();
  }
});

test("a member's grant follows the policy; owners and administrators are never held; pending counts toward the limit", () => {
  const f = fixture();
  try {
    f.policies.save("workspace-a", "off", 1);
    denied(() => f.issue(), 403, "mcp_external_apps_off");
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM agent_mcp_access").get()!.n,
      0,
    );
    const owner = f.store.issue({
      ...f.management,
      sessionId: "owner-session",
      label: "TEST owner",
      scopes: ["data.read"],
      expiresAt: f.now() + 3_600_000,
    });
    assert.equal(owner.grant.status, "active");
    f.policies.save("workspace-a", "review", 2);
    const pending = f.issue();
    assert.equal(pending.grant.status, "pending");
    assert.match(pending.accessToken, /^agent_mcp_/);
    denied(
      () => f.store.authenticate(`Bearer ${pending.accessToken}`, target),
      403,
      "mcp_access_pending",
    );
    // Work admitted earlier is refused before dispatch as well.
    denied(
      () => f.store.authenticateGrant(pending.grant.id, target),
      403,
      "mcp_access_pending",
    );
    const admin = f.store.issue({
      ...f.management,
      sessionId: "admin-session",
      label: "TEST admin",
      scopes: ["data.read"],
      expiresAt: f.now() + 3_600_000,
    });
    assert.equal(admin.grant.status, "active");
    f.policies.save("workspace-a", "free", 3);
    const free = f.issue();
    assert.equal(free.grant.status, "active");
    assert.equal(
      f.store.authenticate(`Bearer ${free.accessToken}`, target).userId,
      "alice",
    );
    // free → review keeps what is active.
    f.policies.save("workspace-a", "review", 4);
    assert.equal(
      f.store.authenticate(`Bearer ${free.accessToken}`, target).userId,
      "alice",
    );
    // One pending and one active grant already fill a limit of two.
    const limited = f.create(2);
    denied(
      () =>
        limited.issue({
          ...f.management,
          label: "TEST over",
          scopes: ["data.read"],
          expiresAt: f.now() + 3_600_000,
        }),
      429,
      "mcp_access_limit",
    );
  } finally {
    f.db.close();
  }
});

test("grants stored before the policy existed stay active", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE organization(id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE member(id TEXT PRIMARY KEY,"userId" TEXT NOT NULL,"organizationId" TEXT NOT NULL,role TEXT NOT NULL) STRICT;
      CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,name TEXT) STRICT;
      CREATE TABLE agent_workspace_member(workspace_id TEXT NOT NULL,member_id TEXT NOT NULL) STRICT;
      INSERT INTO user VALUES ('alice'); INSERT INTO organization VALUES ('org-a');
      INSERT INTO member VALUES ('alice-member','alice','org-a','member');
      INSERT INTO agent_workspace VALUES ('workspace-a','org-a','TEST workspace');
      INSERT INTO agent_workspace_member VALUES ('workspace-a','alice-member');
      CREATE TABLE agent_mcp_access (id TEXT PRIMARY KEY, token_digest TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL, member_id TEXT NOT NULL, organization_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL, server_id TEXT NOT NULL, label TEXT NOT NULL,
        scopes_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        revoked_at INTEGER, last_used_at INTEGER, issued_by_user_id TEXT) STRICT;`);
    const token = `agent_mcp_${randomBytes(32).toString("base64url")}`;
    db.prepare(
      "INSERT INTO agent_mcp_access VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)",
    ).run(
      "legacy",
      createHash("sha256").update(`agent-mcp-access/1\0${token}`).digest("hex"),
      "alice",
      "alice-member",
      "org-a",
      "workspace-a",
      "server-a",
      "TEST legacy",
      '["data.read"]',
      Date.now(),
      Date.now() + 3_600_000,
      "alice",
    );
    const store = new McpAccessStore(db, {
      checkServer: () => true,
      policy: () => "review",
    });
    const principal = store.authenticate(`Bearer ${token}`, target);
    assert.equal(principal.grantId, "legacy");
    assert.equal(store.listOwn("alice")[0]!.grant.status, "active");
  } finally {
    db.close();
  }
});

test("administrators decide a pending grant once, revoke members' grants, and tightening ends them with their OAuth tokens", () => {
  const f = fixture();
  try {
    f.policies.save("workspace-a", "review", 1);
    const first = f.issue();
    const second = f.issue({ label: "TEST second" });
    denied(
      () =>
        f.store.review({
          workspaceId: "workspace-a",
          grantId: first.grant.id,
          revision: 1,
          decision: "approve",
          reviewerId: "admin",
        }),
      409,
      "mcp_review_conflict",
    );
    denied(
      () =>
        f.store.review({
          workspaceId: "workspace-b",
          grantId: first.grant.id,
          revision: 0,
          decision: "approve",
          reviewerId: "admin",
        }),
      404,
      "identity_not_found",
    );
    const approved = f.store.review({
      workspaceId: "workspace-a",
      grantId: first.grant.id,
      revision: 0,
      decision: "approve",
      reviewerId: "admin",
    });
    assert.equal(approved.status, "active");
    assert.equal(
      f.store.authenticate(`Bearer ${first.accessToken}`, target).grantId,
      first.grant.id,
    );
    // A second decision from the earlier revision does not overturn the first.
    denied(
      () =>
        f.store.review({
          workspaceId: "workspace-a",
          grantId: first.grant.id,
          revision: 0,
          decision: "reject",
          reviewerId: "owner",
        }),
      409,
      "mcp_review_conflict",
    );
    f.store.review({
      workspaceId: "workspace-a",
      grantId: second.grant.id,
      revision: 0,
      decision: "reject",
      reason: "Use the shared assistant",
      reviewerId: "admin",
    });
    denied(
      () => f.store.authenticate(`Bearer ${second.accessToken}`, target),
      403,
      "mcp_access_rejected",
    );
    f.db.exec(`ALTER TABLE agent_workspace ADD COLUMN name TEXT;`);
    const own = f.store.listOwn("alice").map(({ grant }) => grant);
    assert.deepEqual(
      own
        .map((grant) => [grant.label, grant.status, grant.reviewReason])
        .sort(),
      [
        ["TEST own client", "active", null],
        ["TEST second", "rejected", "Use the shared assistant"],
      ],
    );
    // The owner's own grant is not a member grant to revoke.
    const owner = f.store.issue({
      ...f.management,
      sessionId: "owner-session",
      label: "TEST owner",
      scopes: ["data.read"],
      expiresAt: f.now() + 3_600_000,
    });
    denied(
      () => f.store.revokeByAdministrator("workspace-a", owner.grant.id),
      404,
      "identity_not_found",
    );
    assert.deepEqual(
      f.store.revokeByAdministrator("workspace-a", second.grant.id),
      { revoked: true },
    );
    assert.deepEqual(
      f.store.revokeByAdministrator("workspace-a", second.grant.id),
      { revoked: false },
    );
    const bob = f.store.issue({
      ...f.management,
      sessionId: "bob-session",
      label: "TEST bob",
      scopes: ["data.read"],
      expiresAt: f.now() + 3_600_000,
    });
    f.db
      .exec(`CREATE TABLE "oauthAccessToken"(id TEXT PRIMARY KEY,"userId" TEXT,"referenceId" TEXT,revoked TEXT);
      CREATE TABLE "oauthRefreshToken"(id TEXT PRIMARY KEY,"userId" TEXT,"referenceId" TEXT,revoked TEXT);`);
    f.db
      .prepare('INSERT INTO "oauthAccessToken" VALUES (?,?,?,NULL)')
      .run("t-first", "alice", first.grant.id);
    // Alice's active grant and Bob's pending one; the owner's stays.
    assert.equal(f.store.revokeMembers("workspace-a"), 2);
    assert.notEqual(
      f.db
        .prepare('SELECT revoked FROM "oauthAccessToken" WHERE id=?')
        .get("t-first")!.revoked,
      null,
    );
    for (const token of [first.accessToken, bob.accessToken])
      denied(
        () => f.store.authenticate(`Bearer ${token}`, target),
        401,
        "mcp_unauthorized",
      );
    assert.equal(
      f.store.authenticate(`Bearer ${owner.accessToken}`, target).userId,
      "owner",
    );
  } finally {
    f.db.close();
  }
});
