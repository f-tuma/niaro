import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { createKyselyAdapter } from "@better-auth/kysely-adapter";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
// eslint-disable-next-line import/no-unresolved -- Official SDK export-map subpath.
import { auth as sdkAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  createMcpOAuth,
  MCP_OAUTH_REFRESH_PREFIX,
  MCP_OAUTH_TOKEN_PREFIX,
} from "../apps/server-mcp/oauth";
import {
  MCP_ACCESS_SCOPES,
  McpAccessStore,
} from "../apps/server-identity/mcp-access";
import { IdentityError } from "../apps/server-identity/error";

/** Client metadata documents served without the network (development only). */
const APP_ID = "https://agent-app.example.test/oauth/client.json";
const appDocument = {
  client_id: APP_ID,
  client_name: "TEST Agent App",
  client_uri: "https://agent-app.example.test",
  redirect_uris: [
    "http://127.0.0.1/callback",
    "https://agent-app.example.test/callback",
  ],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

async function fixture({
  rateLimit = false,
  development = false,
}: { rateLimit?: boolean; development?: boolean } = {}) {
  const origin = "https://agent.example.test";
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  let enabled = true;
  const grants = new McpAccessStore(db, {
    checkServer: (id) => enabled && id === "server-a",
  });
  const documents = new Map<string, unknown>([[APP_ID, appDocument]]);
  const fetched: string[] = [];
  const oauth = createMcpOAuth({
    db,
    baseURL: origin,
    getServerId: () => "server-a",
    issueGrant: (input) => grants.issue(input),
    revalidateGrant: (id, target) => grants.authenticateGrant(id, target),
    revokeGrant: (input) => grants.revoke(input),
    ...(development
      ? {
          allowInsecureDevelopment: true,
          clientMetadataFetch: (input: RequestInfo | URL) => {
            const url = String(input instanceof Request ? input.url : input);
            fetched.push(url);
            const document = documents.get(url);
            return document === undefined
              ? new Response("missing", { status: 404 })
              : Response.json(document);
          },
        }
      : {}),
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
    scopes = "data.read memory.write",
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
    assert.equal(location.pathname, oauth.consentPage, location.href);
    return {
      oauth_query: location.search.slice(1),
      verifier,
      state: query.get("state")!,
      clientId: query.get("client_id")!,
      redirect: query.get("redirect_uri")!,
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
    const expected = new URL(flow.redirect);
    assert.equal(
      callback.origin + callback.pathname,
      expected.origin + expected.pathname,
    );
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
          client_id: flow.clientId,
          code,
          code_verifier: flow.verifier,
          redirect_uri: flow.redirect,
          resource: oauth.resource,
          ...patch,
        }),
      }),
    );
  /** Refreshes as claude.ai does: form body, public client, same resource. */
  const refresh = (refreshToken: string, clientId = client.clientId) =>
    auth.handler(
      new Request(`${oauth.issuer}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: refreshToken,
          resource: oauth.resource,
        }),
      }),
    );
  async function token(
    workspaceId = "workspace-a",
    cookie = alice.cookie,
    scopes = "data.read memory.write",
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
    refresh,
    token,
    documents,
    fetched,
    disable: () => {
      enabled = false;
    },
  };
}
const target = {
  serverId: "server-a",
  workspaceId: "workspace-a",
  requiredScopes: ["data.read"] as const,
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
    assert.deepEqual(metadata.grant_types_supported, [
      "authorization_code",
      "refresh_token",
    ]);
    assert(metadata.token_endpoint_auth_methods_supported.includes("none"));
    assert(
      metadata.token_endpoint_auth_methods_supported.includes(
        "private_key_jwt",
      ),
    );
    assert.equal(metadata.client_id_metadata_document_supported, true);
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);
    // Refresh is requested from the authorization server only; the MCP
    // resource keeps listing its own permissions.
    assert(metadata.scopes_supported.includes("offline_access"));
    for (const scope of MCP_ACCESS_SCOPES)
      assert(metadata.scopes_supported.includes(scope));
    assert.deepEqual(f.oauth.protectedResourceMetadata().scopes_supported, [
      ...MCP_ACCESS_SCOPES,
    ]);
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
    assert.deepEqual(info.scopes, ["data.read", "memory.write"]);
    assert.equal(info.clientName, "TEST external agent");
    assert.equal(info.clientHost, null, "registered by an administrator");
    assert.equal(info.connectionDays, null, "no refresh was requested");
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
    const flow = await f.start(f.alice.cookie, "data.read");
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
          { oauth_query: `${flow.oauth_query}&scope=memory.write` },
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
            scopes: ["memory.write"],
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
      scope: "data.read",
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
    f.oauth.assertActiveGrant(principalA.grantId, ["data.read"]);
    f.oauth.assertActiveGrant(principalB.grantId, ["data.read"]);
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
      () => f.oauth.assertActiveGrant(principalB.grantId, ["data.read"]),
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

test("durable OAuth authority rechecks client disable, token expiry and scope, outlives browser logout and persists no bearer secrets", async () => {
  const f = await fixture();
  try {
    const view = await f.token("workspace-a", f.alice.cookie, "data.read");
    const principal = await f.oauth.authenticate(
      f.auth,
      `Bearer ${view.data.access_token}`,
      accessTarget,
    );
    f.oauth.assertActiveGrant(principal.grantId, ["data.read"]);
    const wide = await f.token();
    const wideActor = await f.oauth.authenticate(
      f.auth,
      `Bearer ${wide.data.access_token}`,
      accessTarget,
    );
    f.db
      .prepare('UPDATE "oauthAccessToken" SET scopes=? WHERE "referenceId"=?')
      .run(JSON.stringify(["data.read"]), wideActor.grantId);
    const narrowed = await f.oauth.authenticate(
      f.auth,
      `Bearer ${wide.data.access_token}`,
      accessTarget,
    );
    assert.deepEqual(narrowed.scopes, ["data.read"]);
    assert(
      f.grants
        .authenticateGrant(narrowed.grantId, accessTarget)
        .scopes.includes("memory.write"),
    );
    f.oauth.assertActiveGrant(narrowed.grantId, narrowed.scopes);
    await assert.rejects(() =>
      f.oauth.authenticate(f.auth, `Bearer ${view.data.access_token}`, {
        ...accessTarget,
        requiredScopes: ["memory.write"],
      }),
    );
    assert.throws(() =>
      f.oauth.assertActiveGrant(principal.grantId, ["memory.write"]),
    );
    f.db
      .prepare('UPDATE "oauthClient" SET disabled=1 WHERE "clientId"=?')
      .run(f.client.clientId);
    assert.throws(
      () => f.oauth.assertActiveGrant(principal.grantId, ["data.read"]),
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
      () => f.oauth.assertActiveGrant(principal.grantId, ["data.read"]),
      unauthorized,
    );
    const current = await f.token();
    const actor = await f.oauth.authenticate(
      f.auth,
      `Bearer ${current.data.access_token}`,
      accessTarget,
    );
    // Signing out of the browser the consent came from keeps the link.
    const signedOut = await f.request("/sign-out", {}, f.alice.cookie);
    assert.equal(signedOut.status, 200, await signedOut.clone().text());
    f.db.prepare('DELETE FROM session WHERE "userId"=?').run(f.alice.id);
    const binding = f.db
      .prepare(
        "SELECT session_id FROM agent_mcp_oauth_binding WHERE grant_id=?",
      )
      .get(actor.grantId)!;
    assert.equal(binding.session_id, null);
    f.oauth.assertActiveGrant(actor.grantId, ["memory.write"]);
    assert.equal(
      (
        await f.oauth.authenticate(
          f.auth,
          `Bearer ${current.data.access_token}`,
          accessTarget,
        )
      ).grantId,
      actor.grantId,
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

test("issued OAuth expiry is one hour, capped by the 30-day grant and not by the browser session", async () => {
  const f = await fixture();
  try {
    f.db
      .prepare('UPDATE session SET "expiresAt"=? WHERE "userId"=?')
      .run(new Date(Date.now() + 120_000).toISOString(), f.alice.id);
    const hour = await f.token();
    assert(hour.data.expires_in > 3500 && hour.data.expires_in <= 3600);
    const grant = f.db
      .prepare("SELECT expires_at,created_at FROM agent_mcp_access")
      .get()!;
    assert.equal(
      Number(grant.expires_at) - Number(grant.created_at) <=
        30 * 24 * 60 * 60 * 1000,
      true,
    );
    assert(
      Number(grant.expires_at) > Date.now() + 29 * 24 * 60 * 60 * 1000,
      "the grant lasts 30 days from consent",
    );
    f.db.exec("DELETE FROM agent_mcp_access");
    const expiry = Math.floor((Date.now() + 120_000) / 1000) * 1000;
    const flow = await f.start(),
      code = await f.consent(flow);
    f.db.prepare("UPDATE agent_mcp_oauth_binding SET expires_at=?").run(expiry);
    f.db.prepare("UPDATE agent_mcp_access SET expires_at=?").run(expiry);
    const response = await f.exchange(flow, code);
    assert.equal(response.status, 200, await response.clone().text());
    const token = { data: await response.json() };
    assert(token.data.expires_in <= 120);
    assert.equal(token.data.expires_at, expiry / 1000);
    const principal = await f.oauth.authenticate(
      f.auth,
      `Bearer ${token.data.access_token}`,
      accessTarget,
    );
    assert.equal(principal.expiresAt, new Date(expiry).toISOString());
    assert.equal(
      f.db
        .prepare(
          'SELECT "expiresAt" FROM "oauthAccessToken" WHERE "referenceId"=?',
        )
        .get(principal.grantId)!.expiresAt,
      new Date(expiry).toISOString(),
    );
  } finally {
    f.db.close();
  }
});

test("OAuth consent and token endpoints enforce configured rate limits", async () => {
  const f = await fixture({ rateLimit: true });
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
        "data.read memory.write",
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
    const flow = await f.start(f.alice.cookie, "data.read memory.write", {
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

const [VIEW] = MCP_ACCESS_SCOPES;
const viewTarget = {
  serverId: "server-a",
  workspaceId: "workspace-a",
  requiredScopes: [VIEW],
};
/** A link that asked to stay connected, as claude.ai and Claude Code do. */
async function offlineLink(
  f: Awaited<ReturnType<typeof fixture>>,
  cookie: string,
  patch: Record<string, string> = {},
) {
  const flow = await f.start(cookie, `${VIEW} offline_access`, patch);
  const code = await f.consent(flow, "workspace-a", cookie, [VIEW]);
  const response = await f.exchange(flow, code);
  assert.equal(response.status, 200, await response.clone().text());
  const data = await response.json();
  assert(String(data.refresh_token).startsWith(MCP_OAUTH_REFRESH_PREFIX));
  return { flow, data };
}
async function refused(response: Response) {
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).error, "invalid_grant");
}

test("refresh tokens rotate, are stored only as hashes and a reused one ends the whole chain", async () => {
  const f = await fixture();
  try {
    const flow = await f.start(f.alice.cookie, `${VIEW} offline_access`);
    const info = await (
      await f.request(
        "/mcp/oauth/consent-info",
        { oauth_query: flow.oauth_query },
        f.alice.cookie,
      )
    ).json();
    // Staying connected is not a permission to tick: only the lifetime shows.
    assert.deepEqual(info.scopes, [VIEW]);
    assert.equal(info.connectionDays, 30);
    const code = await f.consent(flow, "workspace-a", f.alice.cookie, [VIEW]);
    const first = await (await f.exchange(flow, code)).json();
    assert(first.refresh_token.startsWith(MCP_OAUTH_REFRESH_PREFIX));
    assert(first.expires_in <= 3600);
    const principal = await f.oauth.authenticate(
      f.auth,
      `Bearer ${first.access_token}`,
      viewTarget,
    );
    assert.deepEqual(principal.scopes, [VIEW]);
    const rotated = await f.refresh(first.refresh_token);
    assert.equal(rotated.status, 200, await rotated.clone().text());
    const second = await rotated.json();
    assert(second.refresh_token.startsWith(MCP_OAUTH_REFRESH_PREFIX));
    assert.notEqual(second.refresh_token, first.refresh_token);
    assert.notEqual(second.access_token, first.access_token);
    assert(second.expires_in > 3500 && second.expires_in <= 3600);
    assert.equal(
      (
        await f.oauth.authenticate(
          f.auth,
          `Bearer ${second.access_token}`,
          viewTarget,
        )
      ).grantId,
      principal.grantId,
    );
    const stored = JSON.stringify([
      f.db.prepare('SELECT * FROM "oauthRefreshToken"').all(),
      f.db.prepare('SELECT * FROM "oauthAccessToken"').all(),
    ]);
    for (const secret of [first.refresh_token, second.refresh_token])
      assert(!stored.includes(secret.slice(MCP_OAUTH_REFRESH_PREFIX.length)));
    const live = f.db
      .prepare(
        'SELECT "expiresAt","sessionId" FROM "oauthRefreshToken" WHERE revoked IS NULL',
      )
      .all();
    assert.equal(live.length, 1);
    assert.equal(live[0]!.sessionId, null, "not tied to the browser session");
    const grantEnd = Number(
      f.db.prepare("SELECT expires_at FROM agent_mcp_oauth_binding").get()!
        .expires_at,
    );
    assert(Date.parse(String(live[0]!.expiresAt)) <= grantEnd);
    // A stolen, already used token comes back: the chain ends for everyone.
    await refused(await f.refresh(first.refresh_token));
    await refused(await f.refresh(second.refresh_token));
    await assert.rejects(
      () =>
        f.oauth.authenticate(
          f.auth,
          `Bearer ${second.access_token}`,
          viewTarget,
        ),
      unauthorized,
    );
    assert.throws(
      () => f.oauth.assertActiveGrant(principal.grantId, [VIEW]),
      unauthorized,
    );
  } finally {
    f.db.close();
  }
});

test("every refresh revalidates the grant: browser sign-out keeps it; lost access, member removal, client disable and sign-out everywhere end it", async () => {
  const f = await fixture();
  try {
    // Client disabled by an administrator.
    const disabled = await offlineLink(f, f.alice.cookie);
    f.db
      .prepare('UPDATE "oauthClient" SET disabled=1 WHERE "clientId"=?')
      .run(f.client.clientId);
    await refused(await f.refresh(disabled.data.refresh_token));
    f.db
      .prepare('UPDATE "oauthClient" SET disabled=0 WHERE "clientId"=?')
      .run(f.client.clientId);
    await refused(await f.refresh(disabled.data.refresh_token));
    // Losing workspace access ends the link that refreshed; a link that did
    // not refresh while access was gone keeps working once it is back.
    const lost = await offlineLink(f, f.bob.cookie);
    const kept = await offlineLink(f, f.bob.cookie);
    f.db
      .prepare("DELETE FROM agent_workspace_member WHERE member_id=?")
      .run(`${f.bob.id}-member`);
    await refused(await f.refresh(lost.data.refresh_token));
    f.db
      .prepare("INSERT INTO agent_workspace_member VALUES (?,?)")
      .run("workspace-a", `${f.bob.id}-member`);
    const back = await f.refresh(kept.data.refresh_token);
    assert.equal(back.status, 200, await back.clone().text());
    // Removing the member deletes the grant.
    f.db.prepare("DELETE FROM member WHERE id=?").run(`${f.bob.id}-member`);
    await refused(await f.refresh((await back.json()).refresh_token));
    // Signing out of the browser keeps the link and its refresh.
    const link = await offlineLink(f, f.alice.cookie);
    const signedOut = await f.request("/sign-out", {}, f.alice.cookie);
    assert.equal(signedOut.status, 200, await signedOut.clone().text());
    const afterSignOut = await f.refresh(link.data.refresh_token);
    assert.equal(afterSignOut.status, 200, await afterSignOut.clone().text());
    const next = await afterSignOut.json();
    await f.oauth.authenticate(
      f.auth,
      `Bearer ${next.access_token}`,
      viewTarget,
    );
    // A password change, reset or "sign out everywhere" ends every grant.
    f.grants.revokeAllOwn(f.alice.id);
    await refused(await f.refresh(next.refresh_token));
    await assert.rejects(
      () =>
        f.oauth.authenticate(f.auth, `Bearer ${next.access_token}`, viewTarget),
      unauthorized,
    );
  } finally {
    f.db.close();
  }
});

test("a client named by its metadata document links with the callbacks it declares, on any loopback port", async () => {
  const f = await fixture({ development: true });
  try {
    const local = "http://127.0.0.1:53682/callback";
    const flow = await f.start(f.alice.cookie, `${VIEW} offline_access`, {
      client_id: APP_ID,
      redirect_uri: local,
    });
    assert.deepEqual(f.fetched, [APP_ID]);
    const preview = await f.request(
      "/mcp/oauth/consent-info",
      { oauth_query: flow.oauth_query },
      f.alice.cookie,
    );
    assert.equal(preview.status, 200, await preview.clone().text());
    const info = await preview.json();
    assert.equal(info.clientId, APP_ID);
    assert.equal(info.clientName, "TEST Agent App");
    assert.equal(info.clientHost, "agent-app.example.test");
    assert.equal(info.redirectUri, local);
    assert.equal(info.connectionDays, 30);
    const code = await f.consent(flow, "workspace-a", f.alice.cookie, [VIEW]);
    const response = await f.exchange(flow, code);
    assert.equal(response.status, 200, await response.clone().text());
    const token = await response.json();
    const principal = await f.oauth.authenticate(
      f.auth,
      `Bearer ${token.access_token}`,
      viewTarget,
    );
    assert.equal(
      f.db
        .prepare("SELECT label FROM agent_mcp_access WHERE id=?")
        .get(principal.grantId)!.label,
      "OAuth: TEST Agent App (agent-app.example.test)",
    );
    const refreshed = await f.refresh(token.refresh_token, APP_ID);
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
    // Another free port is the same callback; the document stays cached.
    await f.start(f.alice.cookie, VIEW, {
      client_id: APP_ID,
      redirect_uri: "http://127.0.0.1:40001/callback",
    });
    assert.equal(f.fetched.length, 1);
    const authorize = (clientId: string, redirect: string) =>
      f.auth.handler(
        new Request(
          `${f.oauth.issuer}/oauth2/authorize?${new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirect,
            response_type: "code",
            resource: f.oauth.resource,
            scope: VIEW,
            code_challenge: randomBytes(32).toString("base64url"),
            code_challenge_method: "S256",
          })}`,
          { headers: { Cookie: f.alice.cookie, Accept: "text/html" } },
        ),
      );
    const notConsent = async (response: Response) => {
      const location = response.headers.get("location");
      assert(
        !location ||
          new URL(location, f.oauth.issuer).pathname !== f.oauth.consentPage,
        `${response.status} ${location}`,
      );
    };
    // A callback the document does not declare.
    await notConsent(
      await authorize(APP_ID, "https://evil.example.test/callback"),
    );
    // A document that names another client, a private address, plain HTTP.
    f.documents.set("https://other.example.test/client.json", appDocument);
    f.documents.set("https://127.0.0.1/client.json", {
      ...appDocument,
      client_id: "https://127.0.0.1/client.json",
    });
    for (const clientId of [
      "https://other.example.test/client.json",
      "https://127.0.0.1/client.json",
      "http://agent-app.example.test/oauth/client.json",
    ])
      await notConsent(await authorize(clientId, local));
    assert(!f.fetched.includes("https://127.0.0.1/client.json"));
    assert.equal(
      f.db
        .prepare(
          'SELECT count(*) AS n FROM "oauthClient" WHERE "clientDiscoveryId" IS NOT NULL',
        )
        .get()!.n,
      1,
    );
  } finally {
    f.db.close();
  }
});

test("administrators register loopback callbacks on a production server; any port matches and other plain HTTP is refused", async () => {
  const f = await fixture();
  try {
    const headers = new Headers({
      Cookie: f.alice.cookie,
      Origin: "https://agent.example.test",
    });
    const local = await f.oauth.registerClient(
      f.auth,
      { name: "TEST Claude Code", redirectUris: ["http://localhost/callback"] },
      headers,
    );
    const flow = await f.start(f.alice.cookie, `${VIEW} offline_access`, {
      client_id: local.clientId,
      redirect_uri: "http://localhost:49152/callback",
    });
    const code = await f.consent(flow, "workspace-a", f.alice.cookie, [VIEW]);
    const exchanged = await f.exchange(flow, code);
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    assert((await exchanged.json()).refresh_token);
    for (const redirect of [
      "http://agent-app.example.test/callback",
      "http://192.168.1.10/callback",
      "https://localhost/callback",
      "http://localhost/callback#fragment",
    ])
      await assert.rejects(
        () =>
          f.oauth.registerClient(
            f.auth,
            { name: "TEST refused", redirectUris: [redirect] },
            headers,
          ),
        (error) =>
          error instanceof IdentityError &&
          error.code === "mcp_oauth_redirect_invalid",
        redirect,
      );
    assert.throws(
      () =>
        createMcpOAuth({
          db: f.db,
          baseURL: "https://agent.example.test",
          getServerId: () => "server-a",
          issueGrant: () => {
            throw new Error("unused");
          },
          revalidateGrant: () => {
            throw new Error("unused");
          },
          clientMetadataFetch: () => new Response(null, { status: 404 }),
        }),
      /mcp_oauth_configuration_invalid/,
    );
  } finally {
    f.db.close();
  }
});

test("the official MCP SDK client links through its metadata document, exchanges the code and refreshes", async () => {
  const f = await fixture({ development: true });
  try {
    const sdkId = "https://sdk-client.example.test/oauth/client.json";
    const callback = "http://127.0.0.1:61234/callback";
    f.documents.set(sdkId, {
      ...appDocument,
      client_id: sdkId,
      client_name: "TEST SDK client",
      client_uri: "https://sdk-client.example.test",
      redirect_uris: ["http://127.0.0.1/callback"],
    });
    // Routes the SDK's requests to this server as the HTTP front would.
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
        return Response.json(f.oauth.protectedResourceMetadata());
      if (url.pathname === "/.well-known/oauth-authorization-server/admin/auth")
        return f.auth.handler(
          new Request(
            `${f.oauth.issuer}/.well-known/oauth-authorization-server`,
          ),
        );
      if (url.pathname.startsWith("/admin/auth/oauth2/"))
        return f.auth.handler(new Request(url, init));
      return new Response(null, { status: 404 });
    };
    let information: OAuthClientInformationMixed | undefined;
    let tokens: OAuthTokens | undefined;
    let verifier = "";
    let authorization: URL | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: callback,
      clientMetadataUrl: sdkId,
      clientMetadata: {
        client_name: "TEST SDK client",
        redirect_uris: [callback],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      state: () => "TEST-sdk-state",
      clientInformation: () => information,
      saveClientInformation: (value) => {
        information = value;
      },
      tokens: () => tokens,
      saveTokens: (value) => {
        tokens = value;
      },
      redirectToAuthorization: (url) => {
        authorization = url;
      },
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => verifier,
    };
    const serverUrl = f.oauth.resource;
    assert.equal(
      await sdkAuth(provider, {
        serverUrl,
        scope: `${VIEW} offline_access`,
        fetchFn,
      }),
      "REDIRECT",
    );
    assert.equal(information?.client_id, sdkId, "used CIMD, not registration");
    const started = await f.auth.handler(
      new Request(authorization!, {
        headers: { Cookie: f.alice.cookie, Accept: "text/html" },
      }),
    );
    assert.equal(started.status, 302, await started.clone().text());
    const consentUrl = new URL(
      started.headers.get("location")!,
      f.oauth.issuer,
    );
    assert.equal(consentUrl.pathname, f.oauth.consentPage);
    const code = await f.consent(
      {
        oauth_query: consentUrl.search.slice(1),
        verifier,
        state: "TEST-sdk-state",
        clientId: sdkId,
        redirect: callback,
      },
      "workspace-a",
      f.alice.cookie,
      [VIEW],
    );
    assert.equal(
      await sdkAuth(provider, { serverUrl, authorizationCode: code, fetchFn }),
      "AUTHORIZED",
    );
    const first = tokens!;
    assert(first.refresh_token?.startsWith(MCP_OAUTH_REFRESH_PREFIX));
    await f.oauth.authenticate(
      f.auth,
      `Bearer ${first.access_token}`,
      viewTarget,
    );
    assert.equal(await sdkAuth(provider, { serverUrl, fetchFn }), "AUTHORIZED");
    assert.notEqual(tokens!.refresh_token, first.refresh_token);
    assert.notEqual(tokens!.access_token, first.access_token);
    await f.oauth.authenticate(
      f.auth,
      `Bearer ${tokens!.access_token}`,
      viewTarget,
    );
  } finally {
    f.db.close();
  }
});

test("a metadata client that signs its token requests with its published key (as ChatGPT does) links and refreshes", async () => {
  const f = await fixture({ development: true });
  try {
    const id = "https://chat-app.example.test/oauth/client.json";
    const jwksUri = "https://chat-app.example.test/oauth/jwks.json";
    const callback = "https://chat-app.example.test/oauth/callback";
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    f.documents.set(id, {
      client_id: id,
      client_name: "TEST Chat App",
      client_uri: "https://chat-app.example.test/",
      redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_signing_alg: "RS256",
      jwks_uri: jwksUri,
    });
    f.documents.set(jwksUri, {
      keys: [
        {
          ...(await exportJWK(publicKey)),
          kid: "TEST-key",
          alg: "RS256",
          use: "sig",
        },
      ],
    });
    const assertion = async () => ({
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "TEST-key" })
        .setIssuer(id)
        .setSubject(id)
        .setAudience(`${f.oauth.issuer}/oauth2/token`)
        .setIssuedAt()
        .setExpirationTime("2m")
        .setJti(randomUUID())
        .sign(privateKey),
    });
    const flow = await f.start(f.alice.cookie, `${VIEW} offline_access`, {
      client_id: id,
      redirect_uri: callback,
    });
    const code = await f.consent(flow, "workspace-a", f.alice.cookie, [VIEW]);
    const exchanged = await f.exchange(flow, code, await assertion());
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const token = await exchanged.json();
    await f.oauth.authenticate(
      f.auth,
      `Bearer ${token.access_token}`,
      viewTarget,
    );
    const refresh = async (proof: Record<string, string>) =>
      f.auth.handler(
        new Request(`${f.oauth.issuer}/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: id,
            refresh_token: token.refresh_token,
            resource: f.oauth.resource,
            ...proof,
          }),
        }),
      );
    const unsigned = await refresh({});
    assert([400, 401].includes(unsigned.status), await unsigned.text());
    const signed = await refresh(await assertion());
    assert.equal(signed.status, 200, await signed.clone().text());
  } finally {
    f.db.close();
  }
});
