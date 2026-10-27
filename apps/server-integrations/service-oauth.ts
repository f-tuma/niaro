import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  OAuthMetadata,
  OidcOAuthIdentity,
  TwentyOAuthIdentity,
  type OAuthMetadata as Metadata,
  type ServiceOAuthIdentity as Identity,
} from "../../packages/protocol/service-oauth";
import {
  IntegrationError,
  jsonResponse,
  type DispatchGuard,
  type IntegrationTransport,
  type TransportRequest,
} from "./transport";

export type OAuthNetworkOptions = {
  signal?: AbortSignal;
  beforeDispatch: DispatchGuard;
};
export type OAuthClient = { clientId: string; clientSecret?: string };
/** twenty: Twenty application tokens carry the user. oidc: a verified id_token does. */
export type OAuthProfile = "twenty" | "oidc";
export type OAuthRegistration = {
  serviceUrl: string;
  metadata: Metadata;
  redirectUri: string;
};
export type OAuthExchange = OAuthRegistration &
  OAuthClient & {
    code: string;
    verifier: string;
    profile?: OAuthProfile;
    nonce?: string;
  };
export type OAuthRefresh = OAuthRegistration &
  OAuthClient & {
    refreshToken: string;
    scopes: readonly string[];
    profile: OAuthProfile;
    identity: Identity;
  };
/** Only results returned directly by the trusted token endpoint may use this type. */
export type OAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  identity: Identity;
  scopes: string[];
};
export type TwentyOAuthClient = OAuthClient;
export type TwentyOAuthRegistration = OAuthRegistration;
export type TwentyOAuthExchange = OAuthExchange;
export type TwentyOAuthTokens = OAuthTokens;
export type ProviderOAuthSource = {
  kind: "google" | "microsoft" | "github";
  tenantId?: string | null;
};
const failure = () =>
  new IntegrationError("service_oauth_response_invalid", 502);

export function oauthOrigin(serviceUrl: string) {
  const url = new URL(serviceUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[\\\s]/.test(serviceUrl)
  )
    throw new IntegrationError("service_oauth_https_required");
  return url.origin;
}
export const twentyOrigin = oauthOrigin;

/** Every credential destination shares the issuer origin. A foreign issuer needs an authority:
 * the service's protected-resource metadata or an organization sign-in method. */
export function validateOAuthMetadata(serviceUrl: string, raw: unknown) {
  const parsed = OAuthMetadata.safeParse(raw);
  if (!parsed.success) throw failure();
  const value = parsed.data;
  const issuer = oauthOrigin(value.issuer);
  // A sign-in method's issuer never sends credentials to the service, which may be
  // a loopback MCP server; any other authority starts from an HTTPS service origin.
  if (
    (value.authority !== "provider" && !oauthOrigin(serviceUrl)) ||
    (!value.authority &&
      value.issuer.replace(/\/$/, "") !== oauthOrigin(serviceUrl)) ||
    [
      value.authorizationEndpoint,
      value.tokenEndpoint,
      value.registrationEndpoint,
    ]
      .filter((url): url is string => url !== null)
      .some((url) => oauthOrigin(url) !== issuer) ||
    !value.tokenEndpointAuthMethods.length
  )
    throw failure();
  return value;
}
export const validateTwentyMetadata = validateOAuthMetadata;

/** Fixed, public endpoints of an organization sign-in method. No discovery or redirects. */
export function providerOAuthMetadata(source: ProviderOAuthSource): Metadata {
  if (source.kind === "microsoft") {
    const tenant = source.tenantId ?? "";
    if (!/^[A-Za-z0-9.-]{1,100}$/.test(tenant))
      throw new IntegrationError("auth_provider_unavailable", 409);
    const base = `https://login.microsoftonline.com/${tenant}`;
    return {
      issuer: `${base}/v2.0`,
      authorizationEndpoint: `${base}/oauth2/v2.0/authorize`,
      tokenEndpoint: `${base}/oauth2/v2.0/token`,
      registrationEndpoint: null,
      scopes: [],
      tokenEndpointAuthMethods: ["client_secret_post"],
      authorizationResponseIssParameterSupported: false,
      authority: "provider",
    };
  }
  if (source.kind === "google")
    return {
      issuer: "https://accounts.google.com",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      registrationEndpoint: null,
      scopes: [],
      tokenEndpointAuthMethods: ["client_secret_post"],
      authorizationResponseIssParameterSupported: false,
      authority: "provider",
    };
  // GitHub is OAuth without OpenID Connect: no verifiable account in the token response.
  throw new IntegrationError("service_oauth_provider_unsupported", 409);
}
async function requestJSON(
  transport: IntegrationTransport,
  request: TransportRequest,
  options: OAuthNetworkOptions,
) {
  const response = await transport({
    ...request,
    ...options,
    timeoutMs: 15000,
    maxResponseBytes: 65536,
    maxRequestBytes: 32768,
  });
  if (Buffer.byteLength(response.text) > 65536) throw failure();
  // RFC 6749 5.2: a refused grant is final, unlike an outage that may be retried.
  if (
    (response.status === 400 || response.status === 401) &&
    /"error"\s*:\s*"invalid_grant"/.test(response.text)
  )
    throw new IntegrationError("service_oauth_grant_revoked", 401);
  return jsonResponse(response);
}
const AuthorizationServer = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  response_types_supported: z.array(z.string()).max(30),
  // RFC 8414 defaults for what a server may leave out (many MCP servers do).
  grant_types_supported: z
    .array(z.string())
    .max(30)
    .default(["authorization_code", "implicit"]),
  code_challenge_methods_supported: z.array(z.string()).max(10),
  scopes_supported: z.array(z.string().max(100)).max(50).default([]),
  token_endpoint_auth_methods_supported: z
    .array(z.string())
    .max(10)
    .default(["client_secret_basic"]),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});
async function authorizationServer(
  transport: IntegrationTransport,
  url: string,
  options: OAuthNetworkOptions,
) {
  const parsed = AuthorizationServer.safeParse(
    await requestJSON(transport, { url }, options),
  );
  if (!parsed.success) throw failure();
  return parsed.data;
}
/** RFC 9728: the MCP resource names its authorization server. Absent or invalid means none. */
async function protectedResourceIssuer(
  transport: IntegrationTransport,
  serviceUrl: string,
  options: OAuthNetworkOptions,
) {
  const origin = oauthOrigin(serviceUrl);
  try {
    const raw = await requestJSON(
      transport,
      { url: origin + "/.well-known/oauth-protected-resource" },
      options,
    );
    const value = z
      .object({
        resource: z.string(),
        authorization_servers: z.array(z.string()).min(1).max(5),
      })
      .safeParse(raw);
    if (!value.success) return undefined;
    const resource = new URL(value.data.resource);
    if (resource.origin !== origin) return undefined;
    const issuer = value.data.authorization_servers[0]!.replace(/\/$/, "");
    oauthOrigin(issuer);
    return issuer === origin ? undefined : issuer;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return undefined;
  }
}
export async function discoverOAuth(
  transport: IntegrationTransport,
  serviceUrl: string,
  options: OAuthNetworkOptions,
): Promise<Metadata> {
  const origin = oauthOrigin(serviceUrl);
  const foreign = await protectedResourceIssuer(transport, serviceUrl, options);
  const base = foreign ?? origin;
  const d = await authorizationServer(
    transport,
    `${new URL(base).origin}/.well-known/oauth-authorization-server${new URL(base).pathname.replace(/\/$/, "")}`,
    options,
  );
  if (
    !d.response_types_supported.includes("code") ||
    !d.grant_types_supported.includes("authorization_code") ||
    !d.code_challenge_methods_supported.includes("S256") ||
    (foreign && d.issuer.replace(/\/$/, "") !== foreign)
  )
    throw failure();
  return validateOAuthMetadata(serviceUrl, {
    issuer: d.issuer,
    authorizationEndpoint: d.authorization_endpoint,
    tokenEndpoint: d.token_endpoint,
    registrationEndpoint: d.registration_endpoint ?? null,
    scopes: d.scopes_supported,
    tokenEndpointAuthMethods: d.token_endpoint_auth_methods_supported.filter(
      (m) => m === "none" || m === "client_secret_post",
    ),
    authorizationResponseIssParameterSupported:
      d.authorization_response_iss_parameter_supported ?? false,
    ...(foreign ? { authority: "protected-resource" } : {}),
  });
}
export const discoverTwentyOAuth = discoverOAuth;
export async function registerOAuthClient(
  transport: IntegrationTransport,
  request: OAuthRegistration & { scopes?: readonly string[] },
  options: OAuthNetworkOptions,
): Promise<OAuthClient> {
  const metadata = validateOAuthMetadata(request.serviceUrl, request.metadata);
  const methods = metadata.tokenEndpointAuthMethods;
  if (
    !metadata.registrationEndpoint ||
    metadata.authority === "provider" ||
    !methods.length
  )
    throw new IntegrationError("service_oauth_registration_unsupported");
  // A confidential client when the server issues secrets, else a public one
  // (PKCE carries the proof, as the MCP authorization flow expects).
  const wanted = methods.includes("client_secret_post")
    ? "client_secret_post"
    : "none";
  const raw = await requestJSON(
    transport,
    {
      url: metadata.registrationEndpoint,
      method: "POST",
      body: {
        client_name: "Agent Server",
        redirect_uris: [request.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: wanted,
        // No scope parameter when none is requested (most MCP servers).
        ...((request.scopes ?? ["api", "profile"]).length
          ? { scope: (request.scopes ?? ["api", "profile"]).join(" ") }
          : {}),
      },
    },
    options,
  );
  const parsed = z
    .object({
      client_id: z
        .string()
        .min(1)
        .max(512)
        .regex(/^[^\r\n]+$/),
      client_secret: z
        .string()
        .min(1)
        .max(8192)
        .regex(/^[^\r\n]+$/)
        .optional(),
      redirect_uris: z.array(z.string()).max(10).optional(),
      token_endpoint_auth_method: z
        .enum(["client_secret_post", "none"])
        .optional(),
    })
    .safeParse(raw);
  if (
    !parsed.success ||
    (parsed.data.redirect_uris &&
      !parsed.data.redirect_uris.includes(request.redirectUri))
  )
    throw failure();
  // The server decides what it issued: a secret makes a confidential client;
  // none (Twenty answers so whatever was asked) makes a public one, which the
  // token endpoint must accept.
  const granted =
    parsed.data.token_endpoint_auth_method ??
    (parsed.data.client_secret ? "client_secret_post" : "none");
  if (granted === "client_secret_post" && !parsed.data.client_secret)
    throw failure();
  if (granted === "none" && !methods.includes("none")) throw failure();
  return {
    clientId: parsed.data.client_id,
    ...(granted === "client_secret_post"
      ? { clientSecret: parsed.data.client_secret }
      : {}),
  };
}
export const registerTwentyOAuthClient = registerOAuthClient;

const secretToken = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[^\r\n]+$/);
const TokenResponse = z.object({
  access_token: secretToken,
  refresh_token: secretToken.optional(),
  id_token: z.string().max(16384).optional(),
  token_type: z.string().refine((v) => v.toLowerCase() === "bearer"),
  /** Omitted by servers whose tokens do not lapse on a schedule. */
  expires_in: z.coerce
    .number()
    .int()
    .positive()
    .max(31 * 86400)
    .optional(),
  scope: z.string().max(4096).optional(),
});
function jwtPayload(token: string): unknown {
  const pieces = token.split(".");
  if (pieces.length !== 3 || pieces.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
    throw failure();
  try {
    return JSON.parse(Buffer.from(pieces[1]!, "base64url").toString("utf8"));
  } catch {
    throw failure();
  }
}
/** A Twenty token: a JWT naming its type or account. Anything else is opaque. */
function twentyToken(token: string) {
  try {
    const payload = jwtPayload(token);
    return (
      !!payload &&
      typeof payload === "object" &&
      ("type" in payload || "userId" in payload || "workspaceId" in payload)
    );
  } catch {
    return false;
  }
}
const sameIssuer = (a: string, b: string) =>
  a.replace(/\/$/, "") === b.replace(/\/$/, "");
/** Claims are read from a response received directly from the token endpoint over TLS
 * (OpenID Connect Core 3.1.3.7), never from a browser, a pasted token or a redirect. */
function tokenIdentity(
  value: z.infer<typeof TokenResponse>,
  request: { metadata: Metadata; clientId: string; nonce?: string },
  profile: OAuthProfile,
  previous?: Identity,
): { identity: Identity; exp?: number } {
  if (profile === "twenty" && !twentyToken(value.access_token)) {
    // Most MCP servers with OAuth (Notion, Linear, ...) issue tokens that say
    // nothing about the account. The connection then is the account: it
    // gets its own subject, and every refresh keeps it.
    if (previous) {
      if ("subject" in previous) return { identity: previous };
      throw failure();
    }
    return {
      identity: OidcOAuthIdentity.parse({
        subject: `connection:${randomUUID()}`,
      }),
    };
  }
  if (profile === "twenty") {
    // Twenty application-token `sub` identifies the application, never the user.
    const claims = TwentyOAuthIdentity.extend({
      type: z.literal("APPLICATION_ACCESS"),
      exp: z.number().int().positive(),
      iss: z.string().optional(),
    })
      .passthrough()
      .safeParse(jwtPayload(value.access_token));
    if (
      !claims.success ||
      (claims.data.iss && !sameIssuer(claims.data.iss, request.metadata.issuer))
    )
      throw failure();
    const identity = TwentyOAuthIdentity.parse({
      userId: claims.data.userId,
      workspaceId: claims.data.workspaceId,
      userWorkspaceId: claims.data.userWorkspaceId,
    });
    if (previous && JSON.stringify(previous) !== JSON.stringify(identity))
      throw failure();
    return { identity, exp: claims.data.exp };
  }
  if (!value.id_token) {
    // A refresh may omit the id_token; the account is then the one already connected.
    if (previous && "subject" in previous) return { identity: previous };
    throw failure();
  }
  const claims = z
    .object({
      iss: z.string(),
      sub: z.string().min(1).max(255),
      aud: z.union([z.string(), z.array(z.string()).max(10)]),
      exp: z.number().int().positive(),
      nonce: z.string().optional(),
      tid: z.string().max(255).optional(),
      oid: z.string().min(1).max(255).optional(),
      preferred_username: z.string().max(255).optional(),
      email: z.string().max(255).optional(),
    })
    .passthrough()
    .safeParse(jwtPayload(value.id_token));
  if (!claims.success) throw failure();
  const c = claims.data;
  const audience = Array.isArray(c.aud) ? c.aud : [c.aud];
  // Microsoft's multi-tenant metadata names {tenantid}; the token names the real tenant.
  const issuer = request.metadata.issuer.replace(
    "{tenantid}",
    c.tid ?? "{tenantid}",
  );
  if (
    !sameIssuer(c.iss, issuer) ||
    !audience.includes(request.clientId) ||
    c.exp * 1000 <= Date.now() ||
    (request.nonce !== undefined && c.nonce !== request.nonce)
  )
    throw failure();
  const label = c.preferred_username ?? c.email;
  // Microsoft's `sub` differs per application; `oid` is the account itself and is what
  // the sign-in method links (Better Auth's Entra ID account id). Google links `sub`.
  const microsoft = /^https:\/\/login\.microsoftonline\.com\//.test(
    request.metadata.issuer,
  );
  if (microsoft && !c.oid) throw failure();
  const identity = OidcOAuthIdentity.parse({
    subject: microsoft ? c.oid : c.sub,
    ...(c.tid ? { tenant: c.tid } : {}),
    ...(label ? { label } : {}),
  });
  if (
    previous &&
    (!("subject" in previous) ||
      previous.subject !== identity.subject ||
      previous.tenant !== identity.tenant)
  )
    throw failure();
  return { identity };
}
async function tokenRequest(
  transport: IntegrationTransport,
  request: OAuthRegistration & OAuthClient & { nonce?: string },
  grant: Record<string, string>,
  profile: OAuthProfile,
  requested: readonly string[] | undefined,
  options: OAuthNetworkOptions,
  previous?: Identity,
): Promise<OAuthTokens> {
  const metadata = validateOAuthMetadata(request.serviceUrl, request.metadata);
  const authMethod = request.clientSecret ? "client_secret_post" : "none";
  if (!metadata.tokenEndpointAuthMethods.includes(authMethod)) throw failure();
  const raw = await requestJSON(
    transport,
    {
      url: metadata.tokenEndpoint,
      method: "POST",
      bodyEncoding: "form",
      body: {
        ...grant,
        client_id: request.clientId,
        ...(request.clientSecret
          ? { client_secret: request.clientSecret }
          : {}),
      },
    },
    options,
  );
  const response = TokenResponse.safeParse(raw);
  if (!response.success) throw failure();
  const value = response.data;
  // RFC 6749 5.1: an omitted scope means the requested scope was granted unchanged.
  const scopes =
    value.scope === undefined
      ? [...(requested ?? [])]
      : value.scope.split(/\s+/).filter(Boolean);
  if (
    profile === "twenty" &&
    twentyToken(value.access_token) &&
    !scopes.includes("api")
  )
    throw failure();
  const { identity, exp } = tokenIdentity(
    value,
    { ...request, metadata },
    profile,
    previous,
  );
  // A token without a stated lifetime is used until the service refuses it
  // or for 30 days, whichever comes first.
  const expiresAt = Math.min(
    Date.now() + (value.expires_in ?? 30 * 86400) * 1000,
    exp ? exp * 1000 : Infinity,
  );
  if (expiresAt <= Date.now() + 30000)
    throw new IntegrationError("service_oauth_token_expired", 401);
  return {
    accessToken: value.access_token,
    ...(value.refresh_token ? { refreshToken: value.refresh_token } : {}),
    expiresAt,
    scopes,
    identity,
  };
}
export async function exchangeOAuthCode(
  transport: IntegrationTransport,
  request: OAuthExchange,
  options: OAuthNetworkOptions,
): Promise<OAuthTokens> {
  return tokenRequest(
    transport,
    request,
    {
      grant_type: "authorization_code",
      code: request.code,
      code_verifier: request.verifier,
      redirect_uri: request.redirectUri,
    },
    request.profile ?? "twenty",
    undefined,
    options,
  );
}
export const exchangeTwentyOAuthCode = exchangeOAuthCode;
/** A refreshed token must belong to the same account; rotation replaces the refresh token. */
export async function refreshOAuthToken(
  transport: IntegrationTransport,
  request: OAuthRefresh,
  options: OAuthNetworkOptions,
): Promise<OAuthTokens> {
  const tokens = await tokenRequest(
    transport,
    request,
    {
      grant_type: "refresh_token",
      refresh_token: request.refreshToken,
      ...(request.scopes.length ? { scope: request.scopes.join(" ") } : {}),
    },
    request.profile,
    request.scopes,
    options,
    request.identity,
  );
  return {
    ...tokens,
    refreshToken: tokens.refreshToken ?? request.refreshToken,
  };
}
