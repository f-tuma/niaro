# Design

## D1 CIMD through the provider extension

`createCimdClientDiscovery` is contributed through the provider's `extensions` option rather than as a separate plugin, so the discovery belongs to the one provider instance and the companion endpoints that call `getClient` see it too. The provider then advertises `client_id_metadata_document_supported` and the `none` method itself, so the old `allowUnauthenticatedClientRegistration` workaround is gone. `clientRegistrationDefaultResources` links a discovered client to the MCP resource, which `enforcePerClientResources` requires.

Production always uses the plugin's Node transport (resolve once, every answer public, pinned connection, no redirects). Tests pass `clientMetadataFetch`, which is refused unless `allowInsecureDevelopment` is set. The plugin's URL check (HTTPS, public host, no fragment or dot segments) runs before any fetch, also in tests.

## D2 Consent checks both kinds of client

The companion consent endpoints accept a client that is either in `agent_mcp_oauth_client` (registered here, method `none`, no discovery) or owned by the CIMD discovery (method `none` or `private_key_jwt`). Callbacks come from the registration or the document; the companion repeats the provider's match with the loopback port ignored. Consent info returns `clientHost` (null for a registered client) and `connectionDays` (30 when `offline_access` was requested).

## D3 Refresh revalidation in a before hook

The provider's `customTokenResponseFields` does not receive the grant on a refresh, so a `before` hook on `/oauth2/token` looks up the refresh token by hash and, unless the provider will refuse it anyway (unknown or already used), checks the link (binding, client, resource, grant end) and the grant through `revalidateGrant`. A failure revokes what is left of that link and answers `invalid_grant`.

## D4 Tokens leave the browser session

The `after` hook on `/oauth2/token` caps access and refresh token expiry at the grant's end and clears their `sessionId`, so neither the provider's session checks nor its sign-out hook end them. `assertActiveGrant` no longer reads the session; it accepts a live access token or a live refresh token for the grant.

## D5 Scopes

`offline_access` is added to the provider scopes, the resource's allowed scopes (so the refresh token keeps it across rotation) and administrator-registered clients. `upgradeResourceScopes` brings stored resources and clients up to the current list on start. MCP permissions are always read through one helper that strips `offline_access`, so it never reaches grants, principals or the consent checkboxes.
