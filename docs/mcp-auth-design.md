# Incoming MCP credentials and OAuth

Verified against primary documentation on 2026-10-14. Both the dedicated grant store and the OAuth authorization-server bridge are implemented.

## Implemented grant boundary

`apps/server-identity/mcp-access.ts` exports `McpAccessStore`. Its constructor idempotently creates `agent_mcp_access` in the existing identity database, following the other identity stores' schema extension pattern. There is no new account system or server registry.

Call every method inside the identity service queue. Supply `checkServer(serverId): boolean` from current runtime configuration, including shutdown/disabled state. The store resolves the user, organization, original member record and workspace from existing identity tables.

| Method              | Input                                                                    | Result                                               |
| ------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| `issue`             | `sessionId`, `serverId`, `workspaceId`, `label`, `scopes`, `expiresAt`   | `{ grant, accessToken }`                             |
| `issueForUser`      | `administratorSessionId`, explicit `userId`, same issue fields           | `{ grant, accessToken }`                             |
| `list`              | `sessionId`, `serverId`, `workspaceId`                                   | Own grant metadata, including expired/revoked grants |
| `revoke`            | Same management fields plus `grantId`                                    | `{ revoked: boolean }`; idempotent                   |
| `authenticate`      | HTTP Authorization header, `{ serverId, workspaceId?, requiredScopes? }` | Resolved `McpPrincipal`                              |
| `authenticateGrant` | Trusted internal grant ID, same target                                   | Freshly revalidated `McpPrincipal`                   |

Issuance requires a live browser identity session. `issue` derives the user from that session; extra input such as `userId` is rejected. `issueForUser` additionally requires a current owner/admin membership in the target workspace's organization and verifies the target user's workspace access. Keep administrative issuance internal until a specific administration flow exposes it. Console operator keys, mobile credentials and MCP tokens cannot issue grants through these methods.

The issued secret has 256 random bits and an `agent_mcp_` prefix. Only its domain-separated SHA-256 digest persists. The response to issuance is the sole place the secret appears; list and authentication responses contain neither token nor digest. Send it as `Authorization: Bearer <accessToken>` on every MCP HTTP request. Do not place secrets in endpoint URLs, query parameters, logs or workflow/job records.

The two supported scopes are `native.view` and `native.run`. Run permission includes reading the task's result; neither scope permits action approval. Grant input expiry is an epoch millisecond value; response expiry is ISO 8601. Defaults cap lifetime at 30 days and active grants at 50 per user/server. There are no refresh tokens. A new token must be issued after expiry.

The grant remains independent of the issuing browser session after creation, but not of the person's account security: a password reset, a password change and "sign out everywhere" (`AccountSecurity`) revoke every grant of the person, manual and OAuth (`revokeAllOwn`, which also marks their OAuth access and refresh tokens revoked). The person's account page lists their active grants across workspaces (`listOwnActive`) and revokes one (`revokeOwn`). Each use checks expiry, revocation, exact server/workspace binding, current server availability, original member identity, current organization role, and workspace membership. Removing an organization member cascades deletion of their grants; rejoining with another member ID cannot recover old access. Removing workspace membership denies member access. Owners/admins retain the existing role-based workspace access, and role downgrades take effect immediately. The current repository does not define an additional user/member disabled flag.

`authenticateGrant` is for trusted runtime continuation only. HTTP authentication must always call `authenticate`; a grant ID is not a bearer credential. Durable jobs store the grant ID and resolved server/user/workspace scope, then call `authenticateGrant` before each authorized read/commit and after awaits. The runtime still applies the existing per-service policies and approval gates; `native.run` never authorizes an approval operation.

Revocation derives the owning user from a live session and is scoped to that user's grant, server and workspace. It stays available after server disable or loss of workspace access. The SQL update preserves the original revocation timestamp on retries. Other users cannot revoke or enumerate a grant by knowing its ID. Grant listing returns at most 200 metadata rows, placing active grants first so historical revocations cannot hide current access.

## Client compatibility today

An authenticated ChatGPT MCP integration expects OAuth 2.1, protected-resource/authorization-server metadata, authorization code with PKCE S256, a supported client identity/registration mechanism, and audience binding through `resource`. Its ordinary linking flow does not accept a pasted personal bearer token. The manual grants above therefore support clients that can configure Authorization headers; they do not complete ChatGPT OAuth onboarding. [OpenAI authentication documentation](https://developers.openai.com/plugins/build/auth)

Claude's current custom connector setup supports OAuth and fixed request headers, including bearer tokens. Its documentation covers both organization and Pro/Max setups. On Team/Enterprise, a shared request-header credential gives everyone using that connector the same credential's access. A personal grant should consequently not be installed as a shared organizational connector credential. Remote connectors originate from Anthropic's cloud and need a publicly reachable endpoint. [Claude custom connector documentation](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

The Claude Messages API MCP connector also accepts an `authorization_token`; application code owns OAuth acquisition and refresh when OAuth is required. This API mechanism does not establish end-user OAuth onboarding in the Claude UI. [Claude API MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)

## Implemented OAuth provider bridge

`apps/server-mcp/oauth.ts` uses `@better-auth/oauth-provider@1.7.6` with the existing `better-auth@1.7.6` instance and SQLite adapter. The provider owns authorization-code validation, S256 PKCE, signed browser queries, token generation/storage, metadata and RFC 7009 revocation. It is configured for opaque access tokens, authorization-code grants and the two native scopes. The API uses the official provider's endpoint dispatcher and token validator. [Better Auth provider](https://better-auth.com/docs/plugins/oauth-provider)

The MCP HTTP authorization contract requires resource discovery, access tokens for the intended resource and appropriate authentication/permission errors. The bridge publishes metadata only for its configured resource and issuer, validates exact audience, and rejects unrelated credentials. [MCP authorization specification, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

### Factory and routing

Create one `createMcpOAuth` instance with `{ db, baseURL, getServerId, issueGrant, revalidateGrant, revokeGrant? }`. Add both returned `plugins` to the existing Better Auth configuration before migrations, and keep that factory instance across auth-provider rebuilds. `issueGrant` calls the existing MCP store's session-bound issuer; `revalidateGrant` calls its raw `authenticateGrant` method. All HTTP dispatches, client management and runtime checks stay in the identity queue.

Default issuer is `https://host/admin/auth`, resource is `https://host/mcp`, and browser login/consent page is `/admin/mcp/consent`. Override the resource to match the actual public endpoint before enabling discovery. Production requires HTTPS; the explicit development option supports local tests.

| Route/API                                               | Purpose                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/admin/auth/oauth2/authorize`                          | Official provider authorization entry point; GET accepts standard OAuth parameters                                       |
| `/admin/auth/oauth2/token`                              | Official provider token exchange; POST form URL-encoded fields                                                           |
| `/admin/auth/oauth2/revoke`                             | Official provider token revocation; POST form URL-encoded fields                                                         |
| `/admin/auth/.well-known/oauth-authorization-server`    | Provider metadata; also route its RFC 8414 root discovery URL to the same handler                                        |
| `/admin/auth/mcp/oauth/consent-info`                    | Authenticated POST `{ oauth_query }`; returns verified client, user, resource and scopes for display                     |
| `/admin/auth/mcp/oauth/consent`                         | Authenticated same-origin POST `{ oauth_query, accept, workspaceId?, scopes? }`; accepts or denies the displayed request |
| `registerClient(auth, { name, redirectUris }, headers)` | Trusted management API; caller checks administrative role, provider checks a live browser identity session               |
| `authenticate(auth, authorizationHeader, target)`       | Server-only official token verification followed by local grant/binding checks                                           |
| `assertActiveGrant(grantId, requiredScopes?)`           | Synchronous continuation check; call alongside the ordinary local grant check for every durable dispatch                 |

Serve `protectedResourceMetadata()` at the public discovery endpoint and advertise that URL in 401 challenges. OAuth metadata/token endpoints must be reachable without console operator authentication. The provider's server-only authenticate/client-management endpoints must stay hidden from HTTP. Never route resource credentials into browser/mobile authentication as a fallback.

For an existing session, consent UI sends the complete signed query from the redirect URL as `oauth_query`. For login, preserve that same signed query in the login request body so the provider can resume authorization after sign-in. Display the verified client, current user, workspace selection and requested native permissions; submit acceptance only after explicit user action. The provider verifies the signature/expiry before the companion endpoint reads the query. Acceptance requires the real browser origin, a current session, an accessible workspace and a subset of the original scopes. The UI must redirect to the returned `redirect_uri` after acceptance or denial.

### Authority and lifecycle

Each accepted request allocates a local grant and uses its ID as `postLogin.consentReferenceId`. Request-scoped storage carries the selected grant through the provider's consent/code steps, so concurrent flows selecting different workspaces cannot overwrite one another. Direct `/oauth2/consent` or `/oauth2/continue` calls cannot provide this trusted selection context. The browser user comes from the existing authenticated session; neither OAuth parameters nor LLM arguments supply a trusted user ID.

`agent_mcp_oauth_binding` records the grant's user, original browser session and OAuth client. The original member binding remains in the existing MCP grant. A server-only verifier validates the provider token, exact issuer/resource, expiry/scopes and local principal. OAuth access tokens have the distinct `agent_mcp_oauth_` prefix and only hashes are stored.

OAuth authorization is tied to the original browser session. A binding retains a null-session sentinel after session deletion, so the provider's own session foreign-key behavior cannot silently convert an OAuth grant into independent authority. An official after-token hook uses the provider adapter to cap its stored expiry and returned `expires_in`/`expires_at` to the local grant/browser expiry. Manual tokens remain independent of browser logout.

Durable jobs persist only the local grant ID and principal scope. Before each dispatch/commit, run both the MCP store's `authenticateGrant` and OAuth `assertActiveGrant`. The latter reads current session/client/resource state and requires a matching live, unrevoked provider token with the necessary scopes. It returns immediately for manual grants, whose lifetime is governed by the MCP store. Provider token revocation, browser logout, client disable, token expiry, local grant revocation or original-member removal all remove usable runtime authority.

### Current interoperability limits

Clients are explicitly registered public clients with `token_endpoint_auth_method: none`, required PKCE and exact pinned callbacks. Copy callbacks from the actual ChatGPT/Claude connection settings, register them through the management API, and configure the returned client ID in that client's supplied-client mode. Dynamic registration and CIMD are disabled; this implementation performs no client metadata network fetch or SSRF-prone discovery. Refresh tokens and machine grants are disabled. OAuth connections must be linked again after expiry or browser logout.

The provider and grant bridge pass local protocol tests. Real server HTTP tests cover discovery, consent, fresh login, token exchange, native task execution and logout revocation. The actual admin App also passed desktop/mobile browser flows, including preservation of signed state through router normalization and rejection of an external login redirect. Successful linking from real ChatGPT/Claude accounts remains a release gate.

## Verification

`node --import tsx tests/mcp-access.node.ts` runs the seven grant-store tests. They cover self/admin issuance, browser logout independence, hash-only persistence, server/workspace/user isolation, disallowed approval scopes, rejecting foreign credentials and grant IDs, expiry, idempotent revocation, capacity limits, bounded management history, dynamic role/access changes and remove/rejoin behavior. HTTP transport and real external client onboarding require their separate integration tests.

`node --import tsx tests/mcp-oauth.node.ts` exercises the actual installed provider and SQLite migrations through HTTP Request/Response handlers: discovery, consent preview/accept/deny, signed-query rejection, scope escalation, PKCE and binding failures, parallel single-use code redemption, token/local revocation, concurrent workspace selection, original-member remove/rejoin, browser logout, client disable, durable checks, expiry caps and endpoint rate limits.

`node --import tsx tests/mcp-oauth-sso.node.ts` exercises the real identity callback wrapper with the native SSO bridge and OAuth provider: fresh canonical consent resume, explicit human selection, PKCE exchange and callback URL guards. First-boot/reopen configuration persistence is covered by `tests/identity-restore-preflight.node.ts`; migrations finish before Better Auth is constructed so official resource seeding cannot be deferred into a later restore.
