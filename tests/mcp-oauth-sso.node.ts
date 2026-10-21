import { IdentityService } from "../apps/server-identity/service";
import { McpAccessStore } from "../apps/server-identity/mcp-access";
import { createMcpOAuth } from "../apps/server-mcp/oauth";
import { randomBytes, createHash } from "node:crypto";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { createKyselyAdapter } from "@better-auth/kysely-adapter";
import { getMigrations } from "better-auth/db/migration";
import { organization } from "better-auth/plugins";
import type { OAuthProvider } from "@better-auth/core/oauth2";
import { AuthProviderStore } from "../apps/server-identity/auth-providers";
import { createAuthProviderBridge } from "../apps/server-identity/auth-provider-bridge";

const baseURL = "https://agent.example.test";
const secret = "synthetic-secret-for-provider-tests-at-least-thirty-two-chars";
const input = {
  kind: "google",
  name: "Company Google",
  enabled: true,
  clientId: "synthetic-client",
  clientSecret: "synthetic-client-secret",
} as const;
function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((part) => part.split(";", 1)[0])
    .join("; ");
}
async function harness(
  kind: "google" | "microsoft" | "github" = "google",
  timeoutMs = 1000,
) {
  const db = new DatabaseSync(":memory:");
  const store = new AuthProviderStore(db, secret, baseURL);
  const configInput = {
    ...input,
    kind,
    ...(kind === "microsoft"
      ? { tenantId: "11111111-1111-4111-8111-111111111111" }
      : {}),
  };
  const provider = store.save("company", null, 0, configInput);
  const remote = {
    exchanges: 0,
    infos: 0,
    subject: "provider-alice",
    email: "alice@example.test",
    emailVerified: true,
    wait: false,
    nonce: "",
  };
  const factory = (): OAuthProvider => ({
    id: kind,
    name: kind,
    options: { clientId: input.clientId, clientSecret: input.clientSecret },
    accountSubject: ({ profile }) => String((profile as { sub: string }).sub),
    createAuthorizationURL(data) {
      remote.nonce = data.idTokenNonce ?? "";
      const url = new URL("https://provider.example.test/authorize");
      url.searchParams.set("state", data.state);
      url.searchParams.set("redirect_uri", data.redirectURI);
      return url;
    },
    async validateAuthorizationCode() {
      remote.exchanges++;
      if (remote.wait) await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        accessToken: "synthetic-access-secret",
        refreshToken: "synthetic-refresh-secret",
        idToken: "synthetic-id-secret",
        scopes: ["openid", "profile", "email"],
      };
    },
    idToken: {
      verify: async (token, nonce) =>
        token === "synthetic-id-secret" &&
        nonce === remote.nonce &&
        Boolean(nonce),
    },
    async getUserInfo() {
      remote.infos++;
      return {
        user: {
          email: remote.email,
          emailVerified: remote.emailVerified,
          name: "Alice provider",
        },
        data: { sub: remote.subject },
      };
    },
  });
  const bridge = createAuthProviderBridge(store, { factory, timeoutMs });
  const mcpGrants = new McpAccessStore(db, {
    checkServer: (id) => id === "server-a",
  });
  const mcpOAuth = createMcpOAuth({
    db,
    baseURL,
    getServerId: () => "server-a",
    issueGrant: (i) => mcpGrants.issue(i),
    revalidateGrant: (id, target) => mcpGrants.authenticateGrant(id, target),
    revokeGrant: (i) => mcpGrants.revoke(i),
  });
  const { kysely } = await createKyselyAdapter({ database: db });
  assert.ok(kysely);
  const auth = betterAuth({
    ...bridge.options,
    baseURL,
    basePath: "/admin/auth",
    secret,
    database: { db: kysely, type: "sqlite", transaction: false },
    emailAndPassword: { enabled: true, autoSignIn: false },
    session: { cookieCache: { enabled: false }, disableSessionRefresh: true },
    advanced: {
      ...bridge.options.advanced,
      cookiePrefix: "test_identity",
      useSecureCookies: true,
      defaultCookieAttributes: {
        path: "/admin",
        httpOnly: true,
        sameSite: "strict",
      },
    },
    plugins: [
      organization({ allowUserToCreateOrganization: false }),
      bridge.plugin,
      ...mcpOAuth.plugins,
    ],
    logger: { disabled: true },
  });
  await (await getMigrations(auth.options)).runMigrations();
  db.exec(
    "CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE) STRICT; CREATE TABLE agent_workspace_member(workspace_id TEXT NOT NULL REFERENCES agent_workspace(id),member_id TEXT NOT NULL REFERENCES member(id),PRIMARY KEY(workspace_id,member_id)) STRICT;",
  );
  const user = await auth.api.signUpEmail({
    body: {
      email: "alice@example.test",
      name: "Alice local",
      password: "synthetic-password",
    },
  });
  db.prepare(
    'INSERT INTO organization(id,name,slug,"createdAt") VALUES(?,?,?,?)',
  ).run("company", "Company", "company", new Date().toISOString());
  db.prepare(
    'INSERT INTO organization(id,name,slug,"createdAt") VALUES(?,?,?,?)',
  ).run("other-company", "Other", "other", new Date().toISOString());
  db.prepare(
    'INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES(?,?,?,?,?)',
  ).run(
    "member-alice",
    "company",
    user.user.id,
    "member",
    new Date().toISOString(),
  );
  function request(path: string, body?: unknown, cookies?: string) {
    return auth.handler(
      new Request(`${baseURL}/admin/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: baseURL,
          "content-type": "application/json",
          ...(cookies ? { cookie: cookies } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  const login = await request("/sign-in/email", {
    email: "alice@example.test",
    password: "synthetic-password",
  });
  assert.equal(login.status, 200);
  const cookies = cookie(login);
  const actor = {
    userId: user.user.id,
    sessionId: String(
      db.prepare('SELECT id FROM session WHERE "userId"=?').get(user.user.id)!
        .id,
    ),
  };
  async function start(
    mode: "link" | "sign-in" = "link",
    invitationToken?: string,
  ) {
    const flow = store.begin({
      organizationId: "company",
      providerId: provider.id,
      mode,
      ...(mode === "link" ? { actor } : {}),
      returnPath: invitationToken
        ? `/account/invite#${invitationToken}`
        : "/admin/service-connect#mobile-attempt",
      invitationToken,
    });
    const response = await bridge.runStart(flow, () =>
      request(
        mode === "link" ? "/link-social" : "/sign-in/social",
        { provider: provider.id },
        mode === "link" ? cookies : undefined,
      ),
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as { url: string };
    const url = new URL(body.url);
    return {
      flow,
      response,
      url,
      callback: () =>
        request(
          `/callback/${provider.id}?state=${encodeURIComponent(url.searchParams.get("state")!)}&code=synthetic-code`,
          undefined,
          cookie(response),
        ),
    };
  }
  return {
    db,
    store,
    mcpOAuth,
    mcpGrants,
    provider,
    configInput,
    bridge,
    auth,
    actor,
    remote,
    request,
    start,
    cookies,
  };
}

test("service callback preserves the official canonical MCP SSO resume before browser approval", async () => {
  const f = await harness();
  try {
    const link = await f.start();
    assert.equal((await link.callback()).status, 302);
    const client = await f.mcpOAuth.registerClient(
      f.auth,
      {
        name: "TEST external",
        redirectUris: ["https://external.example.test/callback"],
      },
      new Headers({ Cookie: f.cookies, Origin: baseURL }),
    );
    const verifier = randomBytes(32).toString("base64url");
    const q = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: "https://external.example.test/callback",
      response_type: "code",
      resource: f.mcpOAuth.resource,
      scope: "native.view native.run",
      max_age: "0",
      state: "TESTstate",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    const initial = await f.auth.handler(
      new Request(`${baseURL}/admin/auth/oauth2/authorize?${q}`, {
        headers: { Cookie: f.cookies, Accept: "text/html" },
      }),
    );
    assert.equal(initial.status, 302, await initial.clone().text());
    const path = new URL(initial.headers.get("location")!, baseURL);
    const flow = f.store.begin({
      organizationId: "company",
      providerId: f.provider.id,
      mode: "sign-in",
      returnPath: path.pathname + path.search,
    });
    const started = await f.bridge.runStart(flow, () =>
      f.request("/sign-in/social", {
        provider: f.provider.id,
        oauth_query: path.search.slice(1),
      }),
    );
    assert.equal(started.status, 200, await started.clone().text());
    const providerURL = new URL((await started.json()).url);
    const identity = Object.assign(Object.create(IdentityService.prototype), {
      auth: f.auth,
      baseURL,
      closing: false,
      serial: async (fn: () => unknown) => fn(),
    }) as IdentityService;
    const headers = new Map<string, unknown>();
    const result = { status: 0, body: "" };
    const response = {
      setHeader: (name: string, value: unknown) =>
        headers.set(name.toLowerCase(), value),
      getHeader: (name: string) => headers.get(name.toLowerCase()),
      writeHead: (status: number, values: Record<string, unknown>) => {
        result.status = status;
        for (const [name, value] of Object.entries(values))
          headers.set(name.toLowerCase(), value);
      },
      end: (value: string) => {
        result.body = value;
      },
    };
    const callbackURL = `/admin/auth/callback/${f.provider.id}?state=${encodeURIComponent(providerURL.searchParams.get("state")!)}&code=synthetic-code`;
    const handled = await identity.handle(
      {
        method: "GET",
        url: callbackURL,
        headers: { host: new URL(baseURL).host, cookie: cookie(started) },
        socket: { remoteAddress: "TEST-local" },
      } as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      () => false,
    );
    assert.equal(handled, true);
    assert.equal(result.status, 302, result.body);
    const location = headers.get("location") as string;
    assert(location, "Missing callback Location");
    const destination = new URL(location, baseURL);
    assert.equal(destination.pathname, "/admin/mcp/consent");
    assert.equal(
      destination.searchParams.has("max_age"),
      false,
      "SSO callback must resume at new canonical provider query",
    );
    const authCookies = headers.get("set-cookie") as string[];
    assert(authCookies?.length);
    const freshCookies = authCookies
      .map((value) => value.split(";")[0])
      .join("; ");
    const preview = await f.request(
      "/mcp/oauth/consent-info",
      { oauth_query: destination.search.slice(1) },
      freshCookies,
    );
    assert.equal(preview.status, 200, await preview.clone().text());
    assert.equal((await preview.json()).requiresSignIn, false);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM agent_mcp_access").get()!.n,
      0,
    );
    f.db
      .prepare("INSERT INTO agent_workspace VALUES (?,?)")
      .run("workspace-a", "company");
    f.db
      .prepare("INSERT INTO agent_workspace_member VALUES (?,?)")
      .run("workspace-a", "member-alice");
    const approved = await f.request(
      "/mcp/oauth/consent",
      {
        oauth_query: destination.search.slice(1),
        accept: true,
        workspaceId: "workspace-a",
      },
      freshCookies,
    );
    assert.equal(approved.status, 200, await approved.clone().text());
    const callback = new URL((await approved.json()).redirect_uri);
    assert.equal(callback.origin, "https://external.example.test");
    const token = await f.auth.handler(
      new Request(`${baseURL}/admin/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.clientId,
          redirect_uri: "https://external.example.test/callback",
          resource: f.mcpOAuth.resource,
          code: callback.searchParams.get("code")!,
          code_verifier: verifier,
        }),
      }),
    );
    assert.equal(token.status, 200, await token.clone().text());
    const access = (await token.json()).access_token;
    assert.equal(
      (
        await f.mcpOAuth.authenticate(f.auth, `Bearer ${access}`, {
          serverId: "server-a",
          workspaceId: "workspace-a",
          requiredScopes: ["native.run"],
        })
      ).userId,
      f.actor.userId,
    );
  } finally {
    f.db.close();
  }
});

test("service callback accepts only the own consent URL as a canonical JSON resume", async () => {
  const previousLocation = "/admin/settings?source=sso";
  const resumes = [
    { url: "/admin/mcp/consent?sig=fresh", accepted: true },
    { url: `${baseURL}/admin/mcp/consent?sig=fresh`, accepted: true },
    { url: "https://foreign.example.test/admin/mcp/consent", accepted: false },
    { url: "//foreign.example.test/admin/mcp/consent", accepted: false },
    { url: `${baseURL}/admin/other`, accepted: false },
    {
      url: "https://user:secret@agent.example.test/admin/mcp/consent",
      accepted: false,
    },
    { url: "/admin/mcp/consent#fragment", accepted: false },
  ];
  for (const resume of resumes) {
    const identity = Object.assign(Object.create(IdentityService.prototype), {
      auth: {
        handler: async () =>
          Response.json(
            { redirect: true, url: resume.url },
            { status: 302, headers: { Location: previousLocation } },
          ),
      },
      baseURL,
      closing: false,
      serial: async (fn: () => unknown) => fn(),
    }) as IdentityService;
    const headers = new Map<string, unknown>();
    const response = {
      setHeader: (name: string, value: unknown) =>
        headers.set(name.toLowerCase(), value),
      getHeader: (name: string) => headers.get(name.toLowerCase()),
      writeHead: (status: number, values: Record<string, unknown>) => {
        assert.equal(status, 302);
        for (const [name, value] of Object.entries(values))
          headers.set(name.toLowerCase(), value);
      },
      end: () => undefined,
    };
    assert.equal(
      await identity.handle(
        {
          method: "GET",
          url: `/admin/auth/callback/ap_${"a".repeat(32)}?state=synthetic&code=synthetic`,
          headers: { host: new URL(baseURL).host },
          socket: { remoteAddress: "TEST-local" },
        } as unknown as IncomingMessage,
        response as unknown as ServerResponse,
        () => false,
      ),
      true,
    );
    assert.equal(
      headers.get("location"),
      resume.accepted ? new URL(resume.url, baseURL).href : previousLocation,
      resume.url,
    );
  }
});
