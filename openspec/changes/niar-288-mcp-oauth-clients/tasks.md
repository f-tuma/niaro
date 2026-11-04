# Tasks

## 1. Client metadata documents

- [x] 1.1 Add `@better-auth/cimd` 1.7.6 (exact) and contribute its discovery to the OAuth provider with the Node transport and the MCP 2026-07-28 profile; tests only may inject a fetch, and only in development.
- [x] 1.2 Consent accepts registered clients and discovered clients (`none` or `private_key_jwt`) with the callbacks of their registration or document; loopback ports are ignored.
- [x] 1.3 Consent info returns the client's host or null for a registered client, and the connection lifetime; the grant label names the host.

## 2. Refresh tokens and lifetime

- [x] 2.1 `offline_access` in the provider scopes, the resource and registered clients (upgraded on start); never in the protected-resource metadata or among the permissions.
- [x] 2.2 Rotated refresh tokens with prefix `agent_mcp_refresh_`, stored as hashes, no reuse interval; reuse ends the chain.
- [x] 2.3 The grant lasts 30 days from consent; access and refresh tokens are capped at it and detached from the browser session.
- [x] 2.4 Every refresh revalidates the grant and the link and answers `invalid_grant` on failure; durable work continues while a live access or refresh token remains.

## 3. Manual registration

- [x] 3.1 Accept HTTP callbacks on `localhost`, `127.0.0.1` and `[::1]` on every server (registered as a native application); refuse other plain HTTP and HTTPS on loopback.

## 4. Consent page

- [x] 4.1 Show where the client comes from (host, or registered manually) and how long the connection lasts; update the callback hints (English and Czech).

## 5. Verification

- [x] 5.1 `tests/mcp-oauth.node.ts`: metadata flags, CIMD authorize with a local document, refused documents and callbacks, loopback any port, refresh rotation and reuse, refresh after access loss, member removal, client disable and sign-out everywhere, browser logout keeps the grant, `private_key_jwt`, the official MCP SDK client flow with CIMD and refresh.
- [x] 5.2 `tests/mcp-oauth-http.node.ts`: public metadata over HTTP; browser logout keeps the OAuth token.
- [x] 5.3 `npm run test:mcp`, typecheck, lint on changed files, `openspec validate --all --strict`.
- [ ] 5.4 On the deployed server: connect claude.ai, Claude Code and ChatGPT by OAuth without a registered client, then refresh after an hour.
