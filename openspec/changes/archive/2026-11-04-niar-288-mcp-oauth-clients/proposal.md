# Proposal

Tracker: **NIAR-288**

## Why

Checked on production on 2026-11-04: the authorization-server metadata at `/.well-known/oauth-authorization-server/admin/auth` has no registration endpoint and no `client_id_metadata_document_supported`, offers only the `authorization_code` grant, access lasts one hour without a refresh token, and the OAuth grant ends when the person signs out of the browser that approved it. Manual registration refuses `http://localhost` callbacks outside development.

As a result claude.ai needs a manually registered client and asks the person to link again every hour, Claude Code (callback `http://localhost:PORT/callback`) cannot use OAuth against production, and ChatGPT, which uses neither static tokens nor manual registration, cannot connect at all.

What the clients do (researched 2026-11-04): the MCP authorization spec of 2026-07-28 makes client ID metadata documents (CIMD) the recommended way and dynamic registration optional. claude.ai uses CIMD when the metadata says `client_id_metadata_document_supported: true` and lists `none` among the token endpoint methods, asks for `offline_access` when the server lists it, refreshes on 401 and shortly before expiry, and expects `invalid_grant` for a dead refresh token. Claude Code declares `http://localhost/callback` and `http://127.0.0.1/callback` and listens on a free port. ChatGPT's document `https://chatgpt.com/oauth/client.json` uses `private_key_jwt` with a key set on its own origin. The MCP server should not list `offline_access` in its protected-resource metadata.

## What Changes

- **Client metadata documents.** The official `@better-auth/cimd` plugin (1.7.6, matching the pinned Better Auth) is added to the OAuth provider. A client whose `client_id` is an HTTPS URL is resolved from that document: public host only, DNS resolved once and pinned, no redirects, at most 5 KB, within fetch budgets, and it must name itself, its client name and callbacks (MCP 2026-07-28 profile). Such a client may use `none` or `private_key_jwt`. Documents are reused for at most 6 hours. Dynamic registration stays closed; administrator-registered clients keep working.
- **Consent shows who asks.** The consent page shows the client's verified name and where it comes from: the host of its `client_id` URL, or "registered manually on this server". It also says how long the connection lasts.
- **Refresh tokens.** `offline_access` is listed in the authorization-server metadata only. A client that asks for it gets a refresh token (prefix `agent_mcp_refresh_`, stored as a hash) that is replaced on every use; using an old one again ends the chain with `invalid_grant`. The person never ticks `offline_access`; it follows the client's request. Access tokens stay at one hour.
- **The grant, not the browser, sets the lifetime.** An OAuth grant lasts at most 30 days from consent, like a manual grant, and no token outlives it. It is no longer bound to the browser session: a single browser logout keeps it. It still ends on a password change or reset, signing out everywhere, revocation on the account page, member removal or lost workspace access, and client disable. Every refresh revalidates the grant like an MCP request, and admitted work continues while the grant holds a live access or refresh token.
- **Loopback callbacks everywhere.** Manual registration accepts `http://localhost`, `http://127.0.0.1` and `http://[::1]` callbacks on every server; the port is ignored when matching. Other plain HTTP stays refused.

## Non-goals

- Dynamic client registration (deprecated by the MCP spec; CIMD replaces it).
- The MCP tools and the permission names themselves (NIAR-289 renames the scopes; this change uses whatever `MCP_ACCESS_SCOPES` lists).
- An allowlist of client domains. Any HTTPS client may present a document; the person sees its domain and decides.

## Risk

- A metadata document is fetched inside the identity queue when it is not cached (on authorization, token exchange, refresh or MCP request after the cache expires). A slow host can hold the queue for at most the plugin's 5 s fetch timeout; the plugin's budgets limit how often this happens.
- When a client's document host is unreachable after the cache expires, that client's requests fail until it is reachable again (the plugin does not serve a stale document).
- A reused refresh token ends every refresh chain of that client for the person (the provider's family is per client and person), so a person who linked the same client to two workspaces links both again.
