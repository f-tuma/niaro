# ADR 014 — Personal service sign-in

Date: 2026-09-29. Status: accepted; implemented for Twenty-style service OAuth and for Microsoft and Google sign-in methods.

Commit 8ef4022 retired personal service connections: every call used the administrator's shared credential. Calendars, mailboxes and many company tools cannot work that way. The upstream service must see the person, and one shared mailbox credential would read everyone's mail. This ADR brings personal connections back as a generic mechanism rather than a per-service adapter.

## Decision

- **Any service can require personal sign-in.** The requirement is _never_, _for changes_ or _for every action_. When a person has no valid connection, the request answers with a sign-in card, never with the shared key.
- **Two sources for OAuth endpoints and client:**
  - _Service_: the service publishes OAuth metadata. The authorization server is either on the service origin or named by its RFC 9728 protected-resource metadata. It has a registered or manually entered client. Twenty uses this source.
  - _Sign-in method_: an organization's Microsoft or Google sign-in method supplies fixed endpoints and its client. The service may then be a loopback MCP server, for example a hosted Microsoft 365 MCP server. It never receives OAuth client credentials, only the person's access token per request.
- **Account binding.** Microsoft and Google connections request `openid`. The id_token must come directly from the token endpoint. Its issuer, tenant, audience, expiry and nonce must match, and its account id must equal the account the person linked to that sign-in method (`oid` for Microsoft, which is what sign-in stores; `sub` for Google). A consent link forwarded to someone else can therefore never attach another person's mailbox. Twenty keeps its application-token user claims.
- **The browser proves the person.** The phone starts an attempt. The system browser signs in to the server as the same user before the provider redirect. The finished page returns to the app through `agentclient://service-connected`; the app also polls.
- **Refresh.** Tokens are refreshed before dispatch within five minutes of expiry. A refresh keeps the connection revision, so approvals pinned to the account stay valid. It must return the same account, and a generation counter prevents a stale refresh from overwriting a newer grant. An explicit `invalid_grant` disconnects the account. An outage does not.
- **Resuming the request.** After a card's own attempt connects, the app sends the original request once. A replayed or historical card never resends by itself.

## Consequences

Tokens stay sealed with AES-GCM per workspace, service and user, and are never returned by an API. Changing the service URL, the OAuth configuration or the sign-in method invalidates connections and pending consents. A service without OpenID Connect or Twenty-style user claims cannot be connected personally yet, because its tokens do not prove which account granted access. GitHub sign-in methods are refused as a source for this reason.

Hosted MCP servers (definitions with pinned lockfiles, supervised loopback processes) build on this mechanism without changing it; see [hosted MCP servers](../hosted-servers.md).
