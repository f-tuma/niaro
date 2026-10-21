import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { AuthContext } from "@better-auth/core";
import type { Session, User } from "better-auth/types";
import {
  oauthProvider,
  getOAuthProviderApi,
  getOAuthProviderState,
  type OAuthOptions,
  type Scope as OAuthScope,
} from "@better-auth/oauth-provider";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  dispatchAuthEndpoint,
  sessionMiddleware,
} from "better-auth/api";
import { z } from "zod";
import { IdentityId, IdentityName } from "../../packages/protocol/identity";
import {
  MCP_ACCESS_SCOPES,
  mcpScopesAllow,
  type McpAccessScope,
  type McpAuthenticationTarget,
  type McpGrant,
  type McpPrincipal,
} from "../server-identity/mcp-access";
import { IdentityError } from "../server-identity/error";

export const MCP_OAUTH_TOKEN_PREFIX = "agent_mcp_oauth_";
export const MCP_OAUTH_GRANT_CLAIM = "urn:agent:mcp:grant-id";
const Scope = z.enum(MCP_ACCESS_SCOPES);
const Scopes = z
  .array(Scope)
  .min(1)
  .max(3)
  .refine((values) => new Set(values).size === values.length);
const Query = z.string().min(1).max(16_384);
const ConsentInput = z.strictObject({
  oauth_query: Query,
  accept: z.boolean(),
  workspaceId: IdentityId.optional(),
  scopes: Scopes.optional(),
});
type Auth = {
  // Better Auth's generic adapter context is invariant in AuthOptions. The
  // dispatch boundary below uses its public base context without erasing the
  // caller's strongly typed auth instance.
  $context: Promise<unknown>;
  api: {
    getSession: (input: {
      headers: Headers;
      query: { disableCookieCache: true };
    }) => Promise<{ session: Session; user: User } | null>;
  };
};
type Selection = { grant: McpGrant; sessionId: string };
const invalid = (code = "invalid_request") =>
  new APIError("BAD_REQUEST", { error: code });

export type McpOAuthOptions = {
  db: DatabaseSync;
  baseURL: string;
  resource?: string;
  authPath?: string;
  consentPage?: string;
  loginPage?: string;
  getServerId: () => string | undefined;
  issueGrant: (input: {
    sessionId: string;
    serverId: string;
    workspaceId: string;
    label: string;
    scopes: McpAccessScope[];
    expiresAt: number;
  }) => { grant: McpGrant };
  revalidateGrant: (
    grantId: string,
    target: McpAuthenticationTarget,
  ) => McpPrincipal;
  revokeGrant?: (input: {
    sessionId: string;
    grantId: string;
    serverId: string;
    workspaceId: string;
  }) => unknown;
  accessTokenTtlSeconds?: number;
  allowInsecureDevelopment?: boolean;
};

/** Official OAuth provider plus authenticated, explicitly selected MCP consent.
 * All HTTP/API dispatches and runtime validation must run in the identity queue.
 * No network client discovery or dynamic registration is enabled. */
export function createMcpOAuth(options: McpOAuthOptions) {
  const origin = new URL(options.baseURL).origin;
  const authPath = options.authPath ?? "/admin/auth";
  const resource = options.resource ?? new URL("/mcp", origin).href;
  const issuer = `${origin}${authPath}`;
  const consentPage = options.consentPage ?? "/admin/mcp/consent";
  const accessTtl = options.accessTokenTtlSeconds ?? 3600;
  if (
    (!options.allowInsecureDevelopment &&
      new URL(origin).protocol !== "https:") ||
    !Number.isSafeInteger(accessTtl) ||
    accessTtl < 60 ||
    accessTtl > 86_400 ||
    !authPath.startsWith("/admin/") ||
    !consentPage.startsWith("/admin/")
  )
    throw new Error("mcp_oauth_configuration_invalid");
  const resourceUrl = new URL(resource);
  if (
    resourceUrl.origin !== origin ||
    resourceUrl.search ||
    resourceUrl.hash ||
    resourceUrl.username ||
    resourceUrl.password
  )
    throw new Error("mcp_oauth_resource_invalid");

  options.db.exec(`CREATE TABLE IF NOT EXISTS agent_mcp_oauth_client (
    client_id TEXT PRIMARY KEY, name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL CHECK(json_valid(redirect_uris))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS agent_mcp_oauth_binding (
    grant_id TEXT PRIMARY KEY REFERENCES agent_mcp_access(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES session(id) ON DELETE SET NULL,
    client_id TEXT NOT NULL, expires_at INTEGER NOT NULL
  ) STRICT`);
  const selection = new AsyncLocalStorage<Selection>();
  const clientManagement = new AsyncLocalStorage<boolean>();
  const serverId = () => {
    const id = options.getServerId();
    if (!id) throw invalid("temporarily_unavailable");
    return id;
  };
  const checkGrant = (grantId: string, target: McpAuthenticationTarget) => {
    try {
      return options.revalidateGrant(grantId, target);
    } catch (error) {
      if (error instanceof IdentityError)
        throw new APIError(
          error.status === 403 ? "FORBIDDEN" : "UNAUTHORIZED",
          {
            error:
              error.status === 403 ? "insufficient_scope" : "invalid_token",
            mcpCode: error.code,
          },
        );
      throw error;
    }
  };
  const assertActiveGrant = (
    grantId: string,
    requiredScopes: readonly McpAccessScope[] = [],
  ) => {
    const binding = options.db
      .prepare("SELECT * FROM agent_mcp_oauth_binding WHERE grant_id=?")
      .get(grantId);
    if (!binding) return; // Manual MCP grants have their own lifetime checks.
    const parent = options.db
      .prepare('SELECT "expiresAt" FROM session WHERE id=? AND "userId"=?')
      .get(binding.session_id ?? null, binding.user_id!);
    const client = options.db
      .prepare('SELECT disabled FROM "oauthClient" WHERE "clientId"=?')
      .get(binding.client_id!);
    const resourceRow = options.db
      .prepare(
        'SELECT disabled,"allowedScopes" FROM "oauthResource" WHERE identifier=?',
      )
      .get(resource);
    const now = Date.now();
    if (
      !parent ||
      Date.parse(String(parent.expiresAt)) <= now ||
      !client ||
      client.disabled ||
      !resourceRow ||
      resourceRow.disabled ||
      Number(binding.expires_at) <= now
    )
      throw new IdentityError(401, "mcp_unauthorized");
    const allowed = Scopes.safeParse(
      JSON.parse(String(resourceRow.allowedScopes)),
    );
    if (!allowed.success || !mcpScopesAllow(allowed.data, requiredScopes))
      throw new APIError("FORBIDDEN", {
        error: "insufficient_scope",
        mcpCode: "mcp_insufficient_scope",
      });
    const tokens = options.db
      .prepare(
        `SELECT "expiresAt",scopes,resources FROM "oauthAccessToken"
      WHERE "referenceId"=? AND "userId"=? AND "clientId"=? AND revoked IS NULL`,
      )
      .all(grantId, binding.user_id!, binding.client_id!);
    if (
      !tokens.some((row) => {
        const expires = Date.parse(String(row.expiresAt));
        const scopes = Scopes.safeParse(JSON.parse(String(row.scopes)));
        const resources = z
          .array(z.string())
          .safeParse(JSON.parse(String(row.resources)));
        return (
          expires > now &&
          scopes.success &&
          mcpScopesAllow(scopes.data, requiredScopes) &&
          resources.success &&
          resources.data.length === 1 &&
          resources.data[0] === resource
        );
      })
    )
      throw new IdentityError(401, "mcp_unauthorized");
  };
  const providerOptions: OAuthOptions<OAuthScope[]> = {
    scopes: [...MCP_ACCESS_SCOPES],
    grantTypes: ["authorization_code"],
    loginPage: options.loginPage ?? consentPage,
    consentPage,
    disableJwtPlugin: true,
    storeTokens: "hashed",
    prefix: { opaqueAccessToken: MCP_OAUTH_TOKEN_PREFIX },
    accessTokenExpiresIn: accessTtl,
    codeExpiresIn: 60,
    resources: [
      {
        identifier: resource,
        allowedScopes: [...MCP_ACCESS_SCOPES],
        accessTokenTtl: accessTtl,
      },
    ],
    allowDynamicClientRegistration: false,
    // In provider 1.7.6 this also advertises the supported public-client token
    // method "none". The independent DCR flag above still closes registration.
    allowUnauthenticatedClientRegistration: true,
    enforcePerClientResources: true,
    clientPrivileges: () => clientManagement.getStore() === true,
    resourcePrivileges: () => clientManagement.getStore() === true,
    postLogin: {
      page: consentPage,
      shouldRedirect: () => !selection.getStore(),
      consentReferenceId: ({ user, session, scopes }) => {
        const requiredScopes = Scopes.parse(scopes);
        const chosen = selection.getStore();
        if (
          !chosen ||
          chosen.sessionId !== session.id ||
          chosen.grant.userId !== user.id ||
          requiredScopes.some((scope) => !chosen.grant.scopes.includes(scope))
        )
          throw invalid("consent_required");
        checkGrant(chosen.grant.id, {
          serverId: serverId(),
          workspaceId: chosen.grant.workspaceId,
          requiredScopes,
        });
        return chosen.grant.id;
      },
    },
    customTokenResponseFields: ({ user, verificationValue, scopes }) => {
      const requiredScopes = Scopes.parse(scopes);
      if (!user || !verificationValue?.referenceId)
        throw invalid("invalid_grant");
      const principal = checkGrant(verificationValue.referenceId, {
        serverId: serverId(),
        requiredScopes,
      });
      if (principal.userId !== user.id) throw invalid("invalid_grant");
      return {};
    },
    customAccessTokenClaims: ({ user, referenceId }) => {
      if (!user || !referenceId) throw invalid("invalid_token");
      return { [MCP_OAUTH_GRANT_CLAIM]: referenceId };
    },
  };
  const provider = oauthProvider(providerOptions);
  const contextQuery = async (
    ctx: Parameters<typeof getOAuthProviderApi>[0],
  ) => {
    // The official provider's before hook verifies signed oauth_query before
    // this companion endpoint runs, including expiry and request integrity.
    const state = await getOAuthProviderState();
    if (!state?.query) throw invalid("invalid_signature");
    const query = new URLSearchParams(state.query);
    const clientId = query.get("client_id");
    if (
      !clientId ||
      query.getAll("resource").length !== 1 ||
      query.get("resource") !== resource ||
      query.get("response_type") !== "code" ||
      query.get("code_challenge_method") !== "S256"
    )
      throw invalid();
    const managed = options.db
      .prepare(
        "SELECT name,redirect_uris FROM agent_mcp_oauth_client WHERE client_id=?",
      )
      .get(clientId);
    const client = await getOAuthProviderApi(ctx, providerOptions).getClient(
      clientId,
    );
    if (
      !managed ||
      !client ||
      client.disabled ||
      client.skipConsent ||
      client.tokenEndpointAuthMethod !== "none"
    )
      throw invalid("invalid_client");
    const redirects = z
      .array(z.string())
      .parse(JSON.parse(String(managed.redirect_uris)));
    if (!redirects.includes(query.get("redirect_uri") ?? "")) throw invalid();
    const requestedScopes = Scopes.safeParse(
      (query.get("scope") ?? "").split(" "),
    );
    if (!requestedScopes.success) throw invalid("invalid_scope");
    const prompts = (query.get("prompt") ?? "").split(" ");
    const sessionCreatedAt = ctx.context.session?.session.createdAt;
    const issuedAt = state.signedQueryIssuedAt;
    const sessionCreatedMs = sessionCreatedAt
      ? new Date(sessionCreatedAt).getTime()
      : NaN;
    const maxAgeRaw = query.get("max_age");
    const maxAgeSeconds = maxAgeRaw === null ? undefined : Number(maxAgeRaw);
    if (
      maxAgeSeconds !== undefined &&
      (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0)
    )
      throw invalid();
    // Match the installed provider: max_age=0 always needs a new sign-in.
    // Its official sign-in after hook removes max_age and re-signs the query
    // after proving freshness; the browser must follow that returned URL.
    const staleForMaxAge =
      maxAgeSeconds !== undefined &&
      (maxAgeSeconds === 0 ||
        !Number.isFinite(sessionCreatedMs) ||
        Date.now() - sessionCreatedMs > maxAgeSeconds * 1000);
    const requiresSignIn =
      staleForMaxAge ||
      (prompts.includes("login") &&
        (!Number.isFinite(sessionCreatedMs) ||
          !issuedAt ||
          sessionCreatedMs < new Date(issuedAt).getTime()));
    return {
      query,
      clientId,
      clientName: String(managed.name),
      requestedScopes: requestedScopes.data,
      requiresSignIn,
    };
  };
  const companion = {
    id: "agent-mcp-oauth",
    endpoints: {
      mcpOAuthConsentInfo: createAuthEndpoint(
        "/mcp/oauth/consent-info",
        {
          method: "POST",
          body: z.strictObject({ oauth_query: Query }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const request = await contextQuery(ctx);
          return {
            clientId: request.clientId,
            clientName: request.clientName,
            scopes: request.requestedScopes,
            resource,
            redirectUri: request.query.get("redirect_uri")!,
            userId: ctx.context.session.user.id,
            requiresSignIn: request.requiresSignIn,
          };
        },
      ),
      mcpOAuthConsent: createAuthEndpoint(
        "/mcp/oauth/consent",
        {
          method: "POST",
          body: ConsentInput,
          use: [sessionMiddleware],
        },
        async (ctx) => {
          // Require the real browser origin even when dispatched as an API call.
          if (ctx.headers?.get("origin") !== origin)
            throw invalid("invalid_origin");
          const request = await contextQuery(ctx);
          if (ctx.body.accept && request.requiresSignIn)
            throw new APIError("UNAUTHORIZED", {
              error: "mcp_oauth_reauthentication_required",
              requiresSignIn: true,
            });
          const acceptedScopes = ctx.body.scopes ?? request.requestedScopes;
          if (
            acceptedScopes.some(
              (scope) => !request.requestedScopes.includes(scope),
            )
          )
            throw invalid("invalid_scope");
          const delegate = async () => {
            const result = await dispatchAuthEndpoint(
              provider.endpoints.oauth2Consent,
              {
                ...ctx,
                asResponse: false,
                returnHeaders: false,
                returnStatus: false,
                body: {
                  oauth_query: ctx.body.oauth_query,
                  accept: ctx.body.accept,
                  scope: acceptedScopes.join(" "),
                },
              },
            );
            const redirect = z.object({ url: z.string().min(1) }).parse(result);
            const destination = new URL(redirect.url, origin);
            const registeredRedirect = new URL(
              request.query.get("redirect_uri")!,
            );
            if (
              destination.origin === origin &&
              destination.pathname === consentPage
            )
              throw new APIError("UNAUTHORIZED", {
                error: "mcp_oauth_reauthentication_required",
                requiresSignIn: true,
              });
            if (
              destination.href !== redirect.url ||
              destination.origin !== registeredRedirect.origin ||
              destination.pathname !== registeredRedirect.pathname ||
              destination.username ||
              destination.password ||
              destination.hash
            )
              throw invalid("invalid_redirect");
            return { redirect_uri: destination.href };
          };
          if (!ctx.body.accept) return delegate();
          if (!ctx.body.workspaceId) throw invalid();
          let issued: { grant: McpGrant };
          try {
            issued = options.issueGrant({
              sessionId: ctx.context.session.session.id,
              serverId: serverId(),
              workspaceId: ctx.body.workspaceId,
              label: `OAuth: ${request.clientName}`,
              scopes: acceptedScopes,
              expiresAt: Math.min(
                Date.now() + accessTtl * 1000,
                ctx.context.session.session.expiresAt.getTime(),
              ),
            });
          } catch (error) {
            if (error instanceof IdentityError)
              throw new APIError(
                error.status === 403 ? "FORBIDDEN" : "BAD_REQUEST",
                { error: "access_denied" },
              );
            throw error;
          }
          if (issued.grant.userId !== ctx.context.session.user.id)
            throw invalid("invalid_grant");
          options.db
            .prepare("INSERT INTO agent_mcp_oauth_binding VALUES (?,?,?,?,?)")
            .run(
              issued.grant.id,
              issued.grant.userId,
              ctx.context.session.session.id,
              request.clientId,
              Date.parse(issued.grant.expiresAt),
            );
          try {
            return await selection.run(
              {
                grant: issued.grant,
                sessionId: ctx.context.session.session.id,
              },
              delegate,
            );
          } catch (error) {
            options.revokeGrant?.({
              sessionId: ctx.context.session.session.id,
              grantId: issued.grant.id,
              serverId: issued.grant.serverId,
              workspaceId: issued.grant.workspaceId,
            });
            throw error;
          }
        },
      ),
      mcpOAuthAuthenticate: createAuthEndpoint(
        "/mcp/oauth/authenticate",
        {
          method: "POST",
          metadata: { SERVER_ONLY: true },
          body: z.strictObject({
            token: z.string().min(1).max(512),
            target: z.strictObject({
              serverId: IdentityId,
              workspaceId: IdentityId.optional(),
              requiredScopes: z.array(Scope).max(3).optional(),
            }),
          }),
        },
        async (ctx) => {
          const payload = await getOAuthProviderApi(
            ctx,
            providerOptions,
          ).requireActiveAccessToken(ctx.body.token);
          const audiences = Array.isArray(payload.aud)
            ? payload.aud
            : [payload.aud];
          const grantedScopes = (
            typeof payload.scope === "string" ? payload.scope : ""
          ).split(" ");
          const grantId = payload[MCP_OAUTH_GRANT_CLAIM];
          if (
            payload.iss !== issuer ||
            audiences.length !== 1 ||
            audiences[0] !== resource ||
            typeof grantId !== "string" ||
            typeof payload.sub !== "string" ||
            !payload.exp ||
            payload.exp * 1000 <= Date.now() ||
            payload.token_type !== "Bearer"
          )
            throw invalid("invalid_token");
          if (
            !mcpScopesAllow(grantedScopes, ctx.body.target.requiredScopes ?? [])
          )
            throw new IdentityError(403, "mcp_insufficient_scope");
          const principal = checkGrant(grantId, ctx.body.target);
          try {
            assertActiveGrant(grantId, ctx.body.target.requiredScopes);
          } catch (error) {
            if (error instanceof IdentityError)
              throw new APIError(
                error.status === 403 ? "FORBIDDEN" : "UNAUTHORIZED",
                { error: "invalid_token", mcpCode: error.code },
              );
            throw error;
          }
          if (
            principal.userId !== payload.sub ||
            grantedScopes.some(
              (scope) => !principal.scopes.includes(scope as McpAccessScope),
            )
          )
            throw invalid("invalid_token");
          return {
            ...principal,
            scopes: principal.scopes.filter((scope) =>
              grantedScopes.includes(scope),
            ),
            expiresAt: new Date(
              Math.min(Date.parse(principal.expiresAt), payload.exp * 1000),
            ).toISOString(),
          };
        },
      ),
    },
    rateLimit: [
      {
        pathMatcher: (path: string) => path.startsWith("/mcp/oauth/"),
        window: 60,
        max: 30,
      },
    ],
    hooks: {
      after: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/oauth2/token",
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.context.returned;
            if (
              !body ||
              typeof body !== "object" ||
              !("access_token" in body) ||
              typeof body.access_token !== "string"
            )
              return;
            const token = body.access_token;
            if (!token.startsWith(MCP_OAUTH_TOKEN_PREFIX)) return;
            const api = getOAuthProviderApi(ctx, providerOptions);
            const hash = await api.hashToken(
              token.slice(MCP_OAUTH_TOKEN_PREFIX.length),
              "access_token",
            );
            const row = options.db
              .prepare(
                'SELECT id,"referenceId","expiresAt" FROM "oauthAccessToken" WHERE token=?',
              )
              .get(hash);
            if (!row) throw invalid("invalid_token");
            const binding = options.db
              .prepare(
                "SELECT expires_at FROM agent_mcp_oauth_binding WHERE grant_id=?",
              )
              .get(row.referenceId!);
            if (!binding) throw invalid("invalid_grant");
            const expiry = Math.min(
              Date.parse(String(row.expiresAt)),
              Number(binding.expires_at),
            );
            await ctx.context.adapter.update({
              model: "oauthAccessToken",
              where: [{ field: "id", value: String(row.id) }],
              update: { expiresAt: new Date(expiry) },
            });
            return ctx.json({
              ...body,
              expires_in: Math.max(0, Math.floor((expiry - Date.now()) / 1000)),
              expires_at: Math.floor(expiry / 1000),
            });
          }),
        },
      ],
    },
  };
  return {
    /** Run after auth migrations. Resources created before a scope existed keep
     * their stored list; extend it so OAuth clients can request every scope. */
    upgradeResourceScopes() {
      const row = options.db
        .prepare(
          'SELECT "allowedScopes" FROM "oauthResource" WHERE identifier=?',
        )
        .get(resource);
      if (!row) return;
      const current = Scopes.safeParse(JSON.parse(String(row.allowedScopes)));
      if (
        current.success &&
        MCP_ACCESS_SCOPES.every((scope) => current.data.includes(scope))
      )
        return;
      options.db
        .prepare(
          'UPDATE "oauthResource" SET "allowedScopes"=? WHERE identifier=?',
        )
        .run(JSON.stringify([...MCP_ACCESS_SCOPES]), resource);
    },
    provider,
    companion,
    plugins: [provider, companion] as const,
    resource,
    issuer,
    consentPage,
    assertActiveGrant,
    protectedResourceMetadata: () => ({
      resource,
      authorization_servers: [issuer],
      scopes_supported: [...MCP_ACCESS_SCOPES],
      bearer_methods_supported: ["header"],
    }),
    /** Trusted administration only; caller authorizes the human operator first. */
    registerClient: async (auth: Auth, raw: unknown, headers: Headers) => {
      const input = z
        .strictObject({
          name: IdentityName.max(80),
          redirectUris: z.array(z.url()).min(1).max(5),
        })
        .parse(raw);
      for (const redirect of input.redirectUris) {
        const url = new URL(redirect);
        const development =
          options.allowInsecureDevelopment &&
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if (
          (!development && url.protocol !== "https:") ||
          url.hash ||
          url.username ||
          url.password
        )
          throw new IdentityError(400, "mcp_oauth_redirect_invalid");
      }
      const session = await auth.api.getSession({
        headers,
        query: { disableCookieCache: true },
      });
      if (!session) throw new IdentityError(401, "mcp_unauthorized");
      const context = { ...((await auth.$context) as AuthContext), session };
      // Provider initialization may precede migrations on first boot. Seed this
      // resource via its official administration endpoint after migration.
      if (
        !options.db
          .prepare('SELECT 1 FROM "oauthResource" WHERE identifier=?')
          .get(resource)
      ) {
        await clientManagement.run(true, () =>
          dispatchAuthEndpoint(provider.endpoints.adminCreateOAuthResource, {
            context,
            headers,
            body: {
              identifier: resource,
              allowedScopes: [...MCP_ACCESS_SCOPES],
              accessTokenTtl: accessTtl,
            },
            asResponse: false,
          }),
        );
      }
      const response = await clientManagement.run(true, () =>
        dispatchAuthEndpoint(provider.endpoints.adminCreateOAuthClient, {
          context,
          headers,
          path: provider.endpoints.adminCreateOAuthClient.path,
          request: new Request(`${issuer}/admin/oauth2/create-client`, {
            method: "POST",
            headers,
          }),
          body: {
            client_name: input.name,
            redirect_uris: input.redirectUris,
            token_endpoint_auth_method: "none",
            application_type: "web",
            grant_types: ["authorization_code"],
            response_types: ["code"],
            require_pkce: true,
            skip_consent: false,
            scope: MCP_ACCESS_SCOPES.join(" "),
            resources: [resource],
          },
          asResponse: false,
        }),
      );
      const client = z.object({ client_id: z.string() }).parse(response);
      await clientManagement.run(true, () =>
        dispatchAuthEndpoint(provider.endpoints.adminLinkClientResource, {
          context,
          headers,
          path: provider.endpoints.adminLinkClientResource.path,
          request: new Request(`${issuer}/admin/oauth2/resources`, {
            method: "POST",
            headers,
          }),
          params: { identifier: resource, client_id: client.client_id },
          asResponse: false,
        }),
      );
      options.db
        .prepare("INSERT INTO agent_mcp_oauth_client VALUES (?,?,?)")
        .run(client.client_id, input.name, JSON.stringify(input.redirectUris));
      return {
        clientId: client.client_id,
        name: input.name,
        redirectUris: input.redirectUris,
      };
    },
    /** Resource-server validation only; never fallback to browser/mobile auth. */
    authenticate: async (
      auth: Auth,
      header: string | undefined,
      target: McpAuthenticationTarget,
    ): Promise<McpPrincipal> => {
      const token = /^Bearer (agent_mcp_oauth_[A-Za-z0-9_-]+)$/i.exec(
        header ?? "",
      )?.[1];
      if (!token) throw new IdentityError(401, "mcp_unauthorized");
      try {
        return (await dispatchAuthEndpoint(
          companion.endpoints.mcpOAuthAuthenticate,
          {
            context: (await auth.$context) as AuthContext,
            body: { token, target },
            asResponse: false,
          },
        )) as McpPrincipal;
      } catch (error) {
        if (error instanceof IdentityError) throw error;
        if (error instanceof APIError && error.status === "FORBIDDEN")
          throw new IdentityError(
            403,
            typeof error.body?.mcpCode === "string"
              ? error.body.mcpCode
              : "mcp_insufficient_scope",
          );
        throw new IdentityError(401, "mcp_unauthorized");
      }
    },
  };
}
