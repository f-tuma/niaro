import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { createKyselyAdapter } from "@better-auth/kysely-adapter";
import {
  createMcpOAuth,
  MCP_OAUTH_TOKEN_PREFIX,
} from "../apps/server-mcp/oauth";
import { McpAccessStore } from "../apps/server-identity/mcp-access";
import { IdentityError } from "../apps/server-identity/error";

async function fixture(rateLimit = false) {
  const origin = "https://agent.example.test";
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  let enabled = true;
  const grants = new McpAccessStore(db, {
    checkServer: (id) => enabled && id === "server-a",
  });
  const oauth = createMcpOAuth({
    db,
    baseURL: origin,
    getServerId: () => "server-a",
    issueGrant: (input) => grants.issue(input),
    revalidateGrant: (id, target) => grants.authenticateGrant(id, target),
    revokeGrant: (input) => grants.revoke(input),
  });
  const { kysely } = await createKyselyAdapter({ database: db });
  assert(kysely);
  const auth = betterAuth({
    baseURL: origin,
    basePath: "/admin/auth",
    secret: "TEST-mcp-oauth-secret-at-least-thirty-two-characters",
    database: { db: kysely, type: "sqlite", transaction: false },
    emailAndPassword: { enabled: true, autoSignIn: false },
    session: { cookieCache: { enabled: false }, disableSessionRefresh: true },
    advanced: {
      cookiePrefix: "TEST_mcp",
      defaultCookieAttributes: { path: "/admin", sameSite: "strict" },
    },
    plugins: [organization(), ...oauth.plugins],
    logger: { disabled: true },
    rateLimit: { enabled: rateLimit, window: 60, max: 100 },
  });
  await (await getMigrations(auth.options)).runMigrations();
  await auth.$context;
  db.exec(`CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE) STRICT;
    CREATE TABLE agent_workspace_member(workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE,PRIMARY KEY(workspace_id,member_id)) STRICT;`);
  const request = (path: string, body?: unknown, cookie?: string) =>
    auth.handler(
      new Request(`${oauth.issuer}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  async function user(name: string) {
    const account = await request("/sign-up/email", {
      name,
      email: `${name}@example.test`,
      password: "TEST-secret-password-12345",
    });
    assert.equal(account.status, 200, await account.clone().text());
    const signed = await request("/sign-in/email", {
      email: `${name}@example.test`,
      password: "TEST-secret-password-12345",
    });
    assert.equal(signed.status, 200, await signed.clone().text());
    const cookie = signed.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    const data = await signed.json();
    return { id: String(data.user.id), cookie };
  }
  const alice = await user("alice"),
    bob = await user("bob");
  db.prepare(
    'INSERT INTO organization(id,name,slug,"createdAt") VALUES (?,?,?,?)',
  ).run("org-a", "TEST Org", "test-org", new Date().toISOString());
  for (const member of [alice, bob])
    db.prepare(
      'INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES (?,?,?,?,?)',
    ).run(
      `${member.id}-member`,
      "org-a",
      member.id,
      "member",
      new Date().toISOString(),
    );
  db.exec(
    "INSERT INTO agent_workspace VALUES ('workspace-a','org-a'),('workspace-b','org-a')",
  );
  for (const member of [alice, bob])
    db.prepare("INSERT INTO agent_workspace_member VALUES (?,?)").run(
      "workspace-a",
      `${member.id}-member`,
    );
  db.prepare("INSERT INTO agent_workspace_member VALUES (?,?)").run(
    "workspace-b",
    `${alice.id}-member`,
  );
  const redirect = "https://client.example.test/callback";
  const cookieSession = await request("/get-session", undefined, alice.cookie);
  assert.equal(cookieSession.status, 200);
  assert(
    (await cookieSession.json())?.session?.id,
    "TEST sign in cookie missing session",
  );
  const client = await oauth
    .registerClient(
      auth,
      {
        name: "TEST external agent",
        redirectUris: [redirect],
      },
      new Headers({ Cookie: alice.cookie, Origin: origin }),
    )
    .catch((error: { body?: unknown; status?: string }) => {
      throw new Error(
        `TEST registerClient failed: ${JSON.stringify({ status: error.status, body: error.body })}`,
      );
    });
  async function start(
    cookie = alice.cookie,
    scopes = "native.view native.run",
    patch: Record<string, string> = {},
  ) {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirect,
      response_type: "code",
      resource: oauth.resource,
      scope: scopes,
      state: randomBytes(16).toString("base64url"),
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      ...patch,
    });
    const response = await auth.handler(
      new Request(`${oauth.issuer}/oauth2/authorize?${query}`, {
        headers: { Cookie: cookie, Accept: "text/html" },
      }),
    );
    assert.equal(response.status, 302, await response.clone().text());
    const location = new URL(response.headers.get("location")!, origin);
    assert.equal(location.pathname, oauth.consentPage);
    return {
      oauth_query: location.search.slice(1),
      verifier,
      state: query.get("state")!,
    };
  }
  async function consent(
    flow: Awaited<ReturnType<typeof start>>,
    workspaceId = "workspace-a",
    cookie = alice.cookie,
    scopes?: string[],
  ) {
    const response = await request(
      "/mcp/oauth/consent",
      {
        oauth_query: flow.oauth_query,
        accept: true,
        workspaceId,
        ...(scopes ? { scopes } : {}),
      },
      cookie,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    const callback = new URL(data.redirect_uri);
    assert.equal(callback.origin + callback.pathname, redirect);
    assert.equal(callback.searchParams.get("iss"), oauth.issuer);
    assert.equal(callback.searchParams.get("state"), flow.state);
    assert(callback.searchParams.get("code"), JSON.stringify(data));
    return callback.searchParams.get("code")!;
  }
  const exchange = (
    flow: Awaited<ReturnType<typeof start>>,
    code: string,
    patch: Record<string, string> = {},
  ) =>
    auth.handler(
      new Request(`${oauth.issuer}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.clientId,
          code,
          code_verifier: flow.verifier,
          redirect_uri: redirect,
          resource: oauth.resource,
          ...patch,
        }),
      }),
    );
  async function token(
    workspaceId = "workspace-a",
    cookie = alice.cookie,
    scopes = "native.view native.run",
  ) {
    const flow = await start(cookie, scopes),
      code = await consent(flow, workspaceId, cookie);
    const response = await exchange(flow, code);
    assert.equal(response.status, 200, await response.clone().text());
    return { flow, code, data: await response.json() };
  }
  return {
    db,
    grants,
    oauth,
    auth,
    alice,
    bob,
    client,
    redirect,
    request,
    start,
    consent,
    exchange,
    token,
    disable: () => {
      enabled = false;
    },
  };
}
const target = {
  serverId: "server-a",
  workspaceId: "workspace-a",
  requiredScopes: ["native.view"] as const,
};
const accessTarget = { ...target, requiredScopes: [...target.requiredScopes] };
function unauthorized(error: unknown) {
  return error instanceof IdentityError && error.status === 401;
}

test("official provider discovery, PKCE linking and opaque tokens resolve the explicitly consented local user/workspace", async () => {
  const f = await fixture();
  try {
    const metadataResponse = await f.auth.handler(
      new Request(`${f.oauth.issuer}/.well-known/oauth-authorization-server`),
    );
    assert.equal(
      metadataResponse.status,
      200,
      await metadataResponse.clone().text(),
    );
    const metadata = await metadataResponse.json();
    assert.equal(metadata.issuer, f.oauth.issuer);
    assert(metadata.code_challenge_methods_supported.includes("S256"));
    assert.deepEqual(metadata.grant_types_supported, ["authorization_code"]);
    assert(metadata.token_endpoint_auth_methods_supported.includes("none"));
    assert(!metadata.registration_endpoint);
    const existingClients = f.db
      .prepare('SELECT count(*) AS n FROM "oauthClient"')
      .get()!.n;
    for (const cookie of [undefined, f.alice.cookie]) {
      const registration = await f.request(
        "/oauth2/register",
        {
          client_name: "TEST disallowed dynamic client",
          redirect_uris: ["https://unregistered.example.test/callback"],
          grant_types: ["authorization_code"],
          token_endpoint_auth_method: "none",
        },
        cookie,
      );
      assert.equal(registration.status, 403, await registration.clone().text());
      assert.equal((await registration.json()).error, "access_denied");
    }
    assert.equal(
      f.db.prepare('SELECT count(*) AS n FROM "oauthClient"').get()!.n,
      existingClients,
      "Metadata public-client support must not open dynamic registration",
    );
    assert.deepEqual(
      f.oauth.protectedResourceMetadata().authorization_servers,
      [f.oauth.issuer],
    );
    const flow = await f.start();
    const preview = await f.request(
      "/mcp/oauth/consent-info",
      { oauth_query: flow.oauth_query },
      f.alice.cookie,
    );
    assert.equal(preview.status, 200, await preview.clone().text());
    const info = await preview.json();
    assert.equal(info.userId, f.alice.id);
    assert.deepEqual(info.scopes, ["native.view", "native.run"]);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM agent_mcp_access").get()!.n,
      0,
    );
    const code = await f.consent(flow),
      response = await f.exchange(flow, code);
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    assert(data.access_token.startsWith(MCP_OAUTH_TOKEN_PREFIX));
    assert.equal(data.token_type, "Bearer");
    assert.equal(data.refresh_token, undefined);
    const principal = await f.oauth.authenticate(
      f.auth,
      `Bearer ${data.access_token}`,
      accessTarget,
    );
    assert.equal(principal.userId, f.alice.id);
    assert.equal(principal.memberId, `${f.alice.id}-member`);
    assert.equal(principal.workspaceId, "workspace-a");
    const rows = JSON.stringify(
      f.db.prepare('SELECT * FROM "oauthAccessToken"').all(),
    );
    assert(!rows.includes(data.access_token));
    assert(
      !rows.includes(data.access_token.slice(MCP_OAUTH_TOKEN_PREFIX.length)),
    );
    assert(!JSON.stringify(principal).includes(data.access_token));
    await assert.rejects(() =>
      f.oauth.authenticate(f.auth, `Bearer ${data.access_token}`, {
        ...accessTarget,
        workspaceId: "workspace-b",
      }),
    );
    await assert.rejects(() =>
      f.oauth.authenticate(f.auth, `Bearer ${data.access_token}`, {
        ...accessTarget,
        serverId: "server-b",
      }),
    );
    assert.equal((await f.exchange(flow, code)).status, 400);
  } finally {
    f.db.close();
  }
});

test("signed consent requires authenticated browser origin, explicit accessible workspace and a subset of scopes; direct provider consent cannot bypass selection", async () => {
  const f = await fixture();
  try {
    const flow = await f.start(f.alice.cookie, "native.view");
    assert.equal(
      (
        await f.request("/mcp/oauth/consent-info", {
          oauth_query: flow.oauth_query,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await f.request(
          "/mcp/oauth/consent-info",
          { oauth_query: `${flow.oauth_query}&scope=native.run` },
          f.alice.cookie,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(
          "/mcp/oauth/consent",
          { oauth_query: flow.oauth_query, accept: true },
          f.alice.cookie,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(
          "/mcp/oauth/consent",
          {
            oauth_query: flow.oauth_query,
            accept: true,
            workspaceId: "workspace-a",
            scopes: ["native.run"],
          },
          f.alice.cookie,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(
          "/oauth2/consent",
          { oauth_query: flow.oauth_query, accept: true },
          f.alice.cookie,
        )
      ).status,
      400,
    );
    const foreign = await f.auth.handler(
      new Request(`${f.oauth.issuer}/mcp/oauth/consent`, {
        method: "POST",
        headers: {
          Origin: "https://evil.example.test",
          Cookie: f.alice.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          oauth_query: flow.oauth_query,
          accept: true,
          workspaceId: "workspace-a",
        }),
      }),
    );
    assert.equal(foreign.status, 403);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM agent_mcp_access").get()!.n,
      0,
    );
    const denied = await f.request(
      "/mcp/oauth/consent",
      { oauth_query: flow.oauth_query, accept: false },
      f.alice.cookie,
    );
    assert.equal(denied.status, 200);
    const denialCallback = new URL((await denied.json()).redirect_uri);
    assert.equal(denialCallback.searchParams.get("error"), "access_denied");
    assert.equal(denialCallback.searchParams.get("iss"), f.oauth.issuer);
    const bobFlow = await f.start(f.bob.cookie);
    const unavailable = await f.request(
      "/mcp/oauth/consent",
      {
        oauth_query: bobFlow.oauth_query,
        accept: true,
        workspaceId: "workspace-b",
      },
      f.bob.cookie,
    );
    assert.equal(unavailable.status, 403);
  } finally {
    f.db.close();
  }
});

test("the provider rejects wrong verifier/client/redirect/resource, code reuse and machine grants", async () => {
  const f = await fixture();
  try {
    const patches: Record<string, string>[] = [
      { code_verifier: randomBytes(32).toString("base64url") },
      { client_id: "unknown-client" },
      { redirect_uri: "https://evil.example.test/callback" },
      { resource: "https://other.example.test/mcp" },
    ];
    for (const patch of patches) {
      const flow = await f.start(),
        code = await f.consent(flow);
      const response = await f.exchange(flow, code, patch);
      assert(
        [400, 401].includes(response.status),
        await response.clone().text(),
      );
      assert.equal(
        f.db.prepare('SELECT count(*) AS n FROM "oauthAccessToken"').get()!.n,
        0,
      );
    }
    const machine = await f.auth.handler(
      new Request(`${f.oauth.issuer}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: f.client.clientId,
          resource: f.oauth.resource,
        }),
      }),
    );
    assert.equal(machine.status, 400);
    assert.equal((await machine.json()).error, "unsupported_grant_type");
    const flow = await f.start(),
      code = await f.consent(flow);
    const concurrent = await Promise.all([
      f.exchange(flow, code),
      f.exchange(flow, code),
    ]);
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 400]);
    assert.equal(
      f.db.prepare('SELECT count(*) AS n FROM "oauthAccessToken"').get()!.n,
      1,
    );
    const badRedirectQuery = new URLSearchParams({
      client_id: f.client.clientId,
      redirect_uri: "https://evil.example.test/callback",
      response_type: "code",
      resource: f.oauth.resource,
      scope: "native.view",
      code_challenge: randomBytes(32).toString("base64url"),
      code_challenge_method: "S256",
    });
    const invalidRedirect = await f.auth.handler(
      new Request(`${f.oauth.issuer}/oauth2/authorize?${badRedirectQuery}`, {
        headers: { Cookie: f.alice.cookie, Accept: "text/html" },
      }),
    );
    assert.equal(invalidRedirect.status, 302);
    const errorLocation = new URL(invalidRedirect.headers.get("location")!);
    assert.equal(errorLocation.origin, new URL(f.oauth.issuer).origin);
    assert.equal(errorLocation.pathname, "/admin/auth/error");
    assert.equal(errorLocation.searchParams.get("error"), "invalid_redirect");
  } finally {
    f.db.close();
  }
});

test("OAuth token/local grant revocation and original membership removal invalidate runtime authority; separate consent flows preserve workspace binding", async () => {
  const f = await fixture();
  try {
    const a = await f.start(),
      b = await f.start();
    const codeB = await f.consent(b, "workspace-b"),
      codeA = await f.consent(a, "workspace-a");
    const tokenA = await (await f.exchange(a, codeA)).json(),
      tokenB = await (await f.exchange(b, codeB)).json();
    const principalA = await f.oauth.authenticate(
      f.auth,
      `Bearer ${tokenA.access_token}`,
      accessTarget,
    );
    const principalB = await f.oauth.authenticate(
      f.auth,
      `Bearer ${tokenB.access_token}`,
      { ...accessTarget, workspaceId: "workspace-b" },
    );
    assert.notEqual(principalA.grantId, principalB.grantId);
    f.oauth.assertActiveGrant(principalA.grantId, ["native.view"]);
    f.oauth.assertActiveGrant(principalB.grantId, ["native.view"]);
    const revoked = await f.auth.handler(
      new Request(`${f.oauth.issuer}/oauth2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: f.client.clientId,
          token: tokenB.access_token,
          token_type_hint: "access_token",
        }),
      }),
    );
    assert.equal(revoked.status, 200, await revoked.clone().text());
    assert.throws(
      () => f.oauth.assertActiveGrant(principalB.grantId, ["native.view"]),
      unauthorized,
    );
    await assert.rejects(
      () =>
        f.oauth.authenticate(f.auth, `Bearer ${tokenB.access_token}`, {
          ...accessTarget,
          workspaceId: "workspace-b",
        }),
      unauthorized,
    );
    const session = f.db
      .prepare('SELECT id FROM session WHERE "userId"=?')
      .get(f.alice.id)!;
    f.grants.revoke({
      sessionId: String(session.id),
      grantId: principalA.grantId,
      serverId: "server-a",
      workspaceId: "workspace-a",
    });
    await assert.rejects(
      () =>
        f.oauth.authenticate(
          f.auth,
          `Bearer ${tokenA.access_token}`,
          accessTarget,
        ),
      unauthorized,
    );
    const live = await f.token();
    f.db.prepare("DELETE FROM member WHERE id=?").run(`${f.alice.id}-member`);
    f.db
      .prepare(
        'INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES (?,?,?,?,?)',
      )
      .run(
        "alice-rejoined",
        "org-a",
        f.alice.id,
        "member",
        new Date().toISOString(),
      );
    f.db
      .prepare("INSERT INTO agent_workspace_member VALUES (?,?)")
      .run("workspace-a", "alice-rejoined");
    await assert.rejects(
      () =>
        f.oauth.authenticate(
          f.auth,
          `Bearer ${live.data.access_token}`,
          accessTarget,
        ),
      unauthorized,
    );
    await assert.rejects(
      () =>
        f.oauth.authenticate(
          f.auth,
          `Bearer ${principalA.grantId}`,
          accessTarget,
        ),
      unauthorized,
    );
    f.disable();
    await assert.rejects(() =>
      f.oauth.authenticate(
        f.auth,
        `Bearer ${live.data.access_token}`,
        accessTarget,
      ),
    );
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    f.db.close();
  }
});

test("durable OAuth authority rechecks browser logout, client disable, token expiry and scope without persisting bearer secrets", async () => {
  const f = await fixture();
  try {
    const view = await f.token("workspace-a", f.alice.cookie, "native.view");
    const principal = await f.oauth.authenticate(
      f.auth,
      `Bearer ${view.data.access_token}`,
      accessTarget,
    );
    f.oauth.assertActiveGrant(principal.grantId, ["native.view"]);
    const wide = await f.token();
    const wideActor = await f.oauth.authenticate(
      f.auth,
      `Bearer ${wide.data.access_token}`,
      accessTarget,
    );
    f.db
      .prepare('UPDATE "oauthAccessToken" SET scopes=? WHERE "referenceId"=?')
      .run(JSON.stringify(["native.view"]), wideActor.grantId);
    const narrowed = await f.oauth.authenticate(
      f.auth,
      `Bearer ${wide.data.access_token}`,
      accessTarget,
    );
    assert.deepEqual(narrowed.scopes, ["native.view"]);
    assert(
      f.grants
        .authenticateGrant(narrowed.grantId, accessTarget)
        .scopes.includes("native.run"),
    );
    f.oauth.assertActiveGrant(narrowed.grantId, narrowed.scopes);
    await assert.rejects(() =>
      f.oauth.authenticate(f.auth, `Bearer ${view.data.access_token}`, {
        ...accessTarget,
        requiredScopes: ["native.run"],
      }),
    );
    assert.throws(() =>
      f.oauth.assertActiveGrant(principal.grantId, ["native.run"]),
    );
    f.db
      .prepare('UPDATE "oauthClient" SET disabled=1 WHERE "clientId"=?')
      .run(f.client.clientId);
    assert.throws(
      () => f.oauth.assertActiveGrant(principal.grantId, ["native.view"]),
      unauthorized,
    );
    await assert.rejects(
      () =>
        f.oauth.authenticate(
          f.auth,
          `Bearer ${view.data.access_token}`,
          accessTarget,
        ),
      unauthorized,
    );
    f.db
      .prepare('UPDATE "oauthClient" SET disabled=0 WHERE "clientId"=?')
      .run(f.client.clientId);
    f.db
      .prepare(
        'UPDATE "oauthAccessToken" SET "expiresAt"=? WHERE "referenceId"=?',
      )
      .run(new Date(Date.now() - 1_000).toISOString(), principal.grantId);
    assert.throws(
      () => f.oauth.assertActiveGrant(principal.grantId, ["native.view"]),
      unauthorized,
    );
    const current = await f.token();
    const actor = await f.oauth.authenticate(
      f.auth,
      `Bearer ${current.data.access_token}`,
      accessTarget,
    );
    f.db.prepare('DELETE FROM session WHERE "userId"=?').run(f.alice.id);
    const binding = f.db
      .prepare(
        "SELECT session_id FROM agent_mcp_oauth_binding WHERE grant_id=?",
      )
      .get(actor.grantId)!;
    assert.equal(binding.session_id, null);
    assert.throws(
      () => f.oauth.assertActiveGrant(actor.grantId, ["native.run"]),
      unauthorized,
    );
    await assert.rejects(
      () =>
        f.oauth.authenticate(
          f.auth,
          `Bearer ${current.data.access_token}`,
          accessTarget,
        ),
      unauthorized,
    );
    assert(
      !JSON.stringify(
        f.db.prepare("SELECT * FROM agent_mcp_oauth_binding").all(),
      ).includes(current.data.access_token),
    );
  } finally {
    f.db.close();
  }
});

test("issued OAuth expiry is capped by the browser session and local grant", async () => {
  const f = await fixture();
  try {
    const expiry = Math.floor((Date.now() + 120_000) / 1000) * 1000;
    f.db
      .prepare('UPDATE session SET "expiresAt"=? WHERE "userId"=?')
      .run(new Date(expiry).toISOString(), f.alice.id);
    const token = await f.token();
    assert(token.data.expires_in <= 120);
    assert.equal(token.data.expires_at, expiry / 1000);
    const principal = await f.oauth.authenticate(
      f.auth,
      `Bearer ${token.data.access_token}`,
      accessTarget,
    );
    assert.equal(principal.expiresAt, new Date(expiry).toISOString());
    assert.equal(
      f.db.prepare('SELECT "expiresAt" FROM "oauthAccessToken"').get()!
        .expiresAt,
      new Date(expiry).toISOString(),
    );
  } finally {
    f.db.close();
  }
});

test("OAuth consent and token endpoints enforce configured rate limits", async () => {
  const f = await fixture(true);
  try {
    const flow = await f.start();
    for (let attempt = 0; attempt < 30; attempt++) {
      const preview = await f.request(
        "/mcp/oauth/consent-info",
        { oauth_query: flow.oauth_query },
        f.alice.cookie,
      );
      assert.equal(preview.status, 200, await preview.clone().text());
    }
    assert.equal(
      (
        await f.request(
          "/mcp/oauth/consent-info",
          { oauth_query: flow.oauth_query },
          f.alice.cookie,
        )
      ).status,
      429,
    );
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await f.exchange(flow, "TEST-invalid-code");
      assert.equal(response.status, 400, await response.clone().text());
    }
    assert.equal((await f.exchange(flow, "TEST-invalid-code")).status, 429);
  } finally {
    f.db.close();
  }
});

test("stale max_age and login prompts require canonical fresh sign-in before any MCP grant", async () => {
  const f = await fixture();
  try {
    const constraints: Record<string, string>[] = [
      { max_age: "0" },
      { max_age: "60" },
      { prompt: "login" },
    ];
    for (const patch of constraints) {
      f.db
        .prepare('UPDATE session SET "createdAt"=? WHERE "userId"=?')
        .run(new Date(Date.now() - 300_000).toISOString(), f.alice.id);
      const flow = await f.start(
        f.alice.cookie,
        "native.view native.run",
        patch,
      );
      const preview = await f.request(
        "/mcp/oauth/consent-info",
        { oauth_query: flow.oauth_query },
        f.alice.cookie,
      );
      assert.equal(preview.status, 200, await preview.clone().text());
      assert.equal((await preview.json()).requiresSignIn, true);
      const rejected = await f.request(
        "/mcp/oauth/consent",
        {
          oauth_query: flow.oauth_query,
          accept: true,
          workspaceId: "workspace-a",
        },
        f.alice.cookie,
      );
      assert.equal(rejected.status, 401, await rejected.clone().text());
      assert.equal((await rejected.json()).requiresSignIn, true);
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM agent_mcp_access").get()!.n,
        0,
      );
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM agent_mcp_oauth_binding").get()!
          .n,
        0,
      );
    }
  } finally {
    f.db.close();
  }
});

test("official sign-in with the signed query resumes and normalizes max_age=0 before explicit approval and token exchange", async () => {
  const f = await fixture();
  try {
    f.db
      .prepare('UPDATE session SET "createdAt"=? WHERE "userId"=?')
      .run(new Date(Date.now() - 300_000).toISOString(), f.alice.id);
    const flow = await f.start(f.alice.cookie, "native.view native.run", {
      max_age: "0",
      prompt: "login consent",
    });
    const signed = await f.request(
      "/sign-in/email",
      {
        email: "alice@example.test",
        password: "TEST-secret-password-12345",
        oauth_query: flow.oauth_query,
      },
      f.alice.cookie,
    );
    assert.equal(signed.status, 200, await signed.clone().text());
    const response = await signed.json();
    assert.equal(response.redirect, true, JSON.stringify(response));
    assert.equal(typeof response.url, "string");
    const destination = new URL(response.url, new URL(f.oauth.issuer).origin);
    assert.equal(destination.origin, new URL(f.oauth.issuer).origin);
    assert.equal(destination.pathname, f.oauth.consentPage);
    assert.equal(destination.searchParams.has("max_age"), false);
    assert(
      !destination.searchParams.get("prompt")?.split(" ").includes("login"),
    );
    assert(destination.searchParams.has("sig"));
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM agent_mcp_access").get()!.n,
      0,
    );
    const cookie = signed.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert(cookie);
    const resumed = { ...flow, oauth_query: destination.search.slice(1) };
    const preview = await f.request(
      "/mcp/oauth/consent-info",
      { oauth_query: resumed.oauth_query },
      cookie,
    );
    assert.equal(preview.status, 200, await preview.clone().text());
    assert.equal((await preview.json()).requiresSignIn, false);
    const code = await f.consent(resumed, "workspace-a", cookie);
    const token = await f.exchange(resumed, code);
    assert.equal(token.status, 200, await token.clone().text());
    const data = await token.json();
    assert.equal(
      (
        await f.oauth.authenticate(
          f.auth,
          `Bearer ${data.access_token}`,
          accessTarget,
        )
      ).userId,
      f.alice.id,
    );
  } finally {
    f.db.close();
  }
});
