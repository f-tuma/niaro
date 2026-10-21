import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import {
  ServiceOAuthStore,
  type ServiceOAuthTarget,
} from "../apps/server-identity/service-oauth";
import {
  discoverOAuth,
  discoverTwentyOAuth,
  exchangeOAuthCode,
  exchangeTwentyOAuthCode,
  refreshOAuthToken,
  registerTwentyOAuthClient,
  validateOAuthMetadata,
} from "../apps/server-integrations/service-oauth";
import {
  createTransport,
  type IntegrationTransport,
  type TransportRequest,
} from "../apps/server-integrations/transport";

const target: ServiceOAuthTarget = {
  workspaceId: "workspace",
  serviceId: "twenty",
  serviceUrl: "https://crm.example.test/mcp",
  serviceRevision: 4,
};
const actor = { userId: "alice", sessionId: "alice-session" };
const guard = async (start: () => void) => start();
const discovery = {
  issuer: "https://crm.example.test",
  authorization_endpoint: "https://crm.example.test/authorize",
  token_endpoint: "https://crm.example.test/oauth/token",
  registration_endpoint: "https://crm.example.test/oauth/register",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["api", "profile"],
  token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  authorization_response_iss_parameter_supported: true,
};
function jwt(payload: Record<string, unknown>) {
  return [
    JSON.stringify({ alg: "RS256" }),
    JSON.stringify(payload),
    "synthetic-signature",
  ]
    .map((s) => Buffer.from(s).toString("base64url"))
    .join(".");
}
function tokenResponse(patch: Record<string, unknown> = {}) {
  return {
    access_token: jwt({
      sub: "application-id-not-user",
      type: "APPLICATION_ACCESS",
      userId: "crm-alice",
      userWorkspaceId: "crm-user-workspace",
      workspaceId: "crm-workspace",
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...patch,
    }),
    refresh_token: "synthetic-refresh-secret",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "api profile",
  };
}
function synthetic(response: unknown): {
  transport: IntegrationTransport;
  requests: TransportRequest[];
} {
  const requests: TransportRequest[] = [];
  return {
    requests,
    transport: async (request) => {
      await request.beforeDispatch?.(() => {
        requests.push(request);
      });
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify(response),
      };
    },
  };
}
async function harness() {
  const db = new DatabaseSync(":memory:");
  const store = new ServiceOAuthStore(
    db,
    "synthetic-test-secret",
    "https://agent.example.test",
  );
  store.save(
    target,
    0,
    { requiredFor: "writes", signInHint: "microsoft" },
    {
      clientId: "synthetic-client",
      clientSecret: "synthetic-client-secret",
    },
  );
  const metadata = await discoverTwentyOAuth(
    synthetic(discovery).transport,
    target.serviceUrl,
    { beforeDispatch: guard },
  );
  store.setDiscovery(target, 1, metadata);
  return { db, store, metadata };
}
function claim(store: ServiceOAuthStore, who = actor) {
  const started = store.start(target, who, store.config(target).revision);
  const url = new URL(started.authorizationUrl);
  const state = url.searchParams.get("state")!;
  return {
    started,
    url,
    state,
    value: store.claimFromState(who, {
      state,
      code: "synthetic-code",
      iss: discovery.issuer,
    }),
  };
}
test("Twenty metadata refuses foreign issuer/endpoints, weak PKCE and non-HTTPS", async () => {
  for (const bad of [
    { ...discovery, issuer: "https://elsewhere.example.test" },
    { ...discovery, token_endpoint: "https://elsewhere.example.test/token" },
    {
      ...discovery,
      registration_endpoint: "https://elsewhere.example.test/register",
    },
    {
      ...discovery,
      authorization_endpoint:
        "https://crm.example.test/authorize?injected=true",
    },
    { ...discovery, code_challenge_methods_supported: ["plain"] },
  ])
    await assert.rejects(
      discoverTwentyOAuth(synthetic(bad).transport, target.serviceUrl, {
        beforeDispatch: guard,
      }),
    );
  await assert.rejects(
    discoverTwentyOAuth(
      synthetic(discovery).transport,
      "http://localhost/mcp",
      { beforeDispatch: guard },
    ),
  );
});
test("registration is explicit, guarded, same-origin and credentials remain server-only", async () => {
  const { db, store } = await harness();
  try {
    const snapshot = store.registration(target, 2);
    const network = synthetic({
      client_id: "registered-client",
      client_secret: "registered-secret",
      redirect_uris: [store.redirectUri],
      token_endpoint_auth_method: "client_secret_post",
    });
    const client = await registerTwentyOAuthClient(
      network.transport,
      snapshot,
      { beforeDispatch: guard },
    );
    assert.equal(network.requests.length, 1);
    assert.equal(network.requests[0]!.url, discovery.registration_endpoint);
    assert.equal(
      (network.requests[0]!.body as Record<string, unknown>).client_name,
      "Agent Server",
    );
    const config = store.commitRegistration(snapshot, client, target);
    assert.equal(config.revision, 3);
    assert.equal(config.hasClientId, true);
    assert.equal(JSON.stringify(config).includes("registered-secret"), false);
    assert.equal(
      JSON.stringify(
        db.prepare("SELECT * FROM agent_service_oauth_config").all(),
      ).includes("registered-secret"),
      false,
    );
    assert.throws(() => store.commitRegistration(snapshot, client, target));
  } finally {
    db.close();
  }
});
test("a server that issues no secret registers a public client; PKCE then carries the proof", async () => {
  const { db, store } = await harness();
  try {
    const snapshot = store.registration(target, 2);
    // Twenty answers a public client whatever auth method was asked for.
    const network = synthetic({
      client_id: "public-client",
      redirect_uris: [store.redirectUri],
      token_endpoint_auth_method: "none",
      scope: "api profile",
    });
    const client = await registerTwentyOAuthClient(
      network.transport,
      snapshot,
      { beforeDispatch: guard },
    );
    assert.deepEqual(client, { clientId: "public-client" });
    const config = store.commitRegistration(snapshot, client, target);
    assert.equal(config.hasClientId, true);
    assert.equal(config.hasClientSecret, false);
    // A secret-less answer that claims a secret method is refused.
    await assert.rejects(
      registerTwentyOAuthClient(
        synthetic({
          client_id: "odd-client",
          token_endpoint_auth_method: "client_secret_post",
        }).transport,
        snapshot,
        { beforeDispatch: guard },
      ),
      /service_oauth_response_invalid/,
    );
  } finally {
    db.close();
  }
});
test("personal OAuth binds one-use state, session, issuer, PKCE and the service address", async () => {
  const { db, store } = await harness();
  try {
    const begin = store.start(target, actor, 2),
      url = new URL(begin.authorizationUrl);
    const state = url.searchParams.get("state")!;
    assert.equal(url.pathname, "/authorize");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), store.redirectUri);
    assert.equal(
      url.searchParams.has("domain_hint"),
      false,
      "Microsoft hint does not manufacture upstream proof",
    );
    assert.deepEqual(store.pendingTarget(state, actor), target);
    assert.throws(() =>
      store.pendingTarget(state, { ...actor, sessionId: "other-session" }),
    );
    assert.throws(() => store.claimFromState(actor, { state, code: "code" }));
    assert.throws(() =>
      store.claimFromState(actor, {
        state,
        code: "code",
        iss: "https://wrong.example.test",
      }),
    );
    const exchange = store.claimFromState(actor, {
      state,
      code: "code",
      iss: discovery.issuer,
    });
    assert.equal(exchange.verifier.length, 43);
    assert.throws(() =>
      store.claimFromState(actor, {
        state,
        code: "code",
        iss: discovery.issuer,
      }),
    );
    assert.throws(() =>
      store.assertClaim(
        exchange,
        { ...actor, sessionId: "other-session" },
        target,
      ),
    );
    assert.throws(() =>
      store.assertClaim(exchange, actor, {
        ...target,
        serviceUrl: "https://other.example.test/mcp",
      }),
    );
    // A new service revision alone (description, actions) keeps the consent valid.
    store.assertClaim(exchange, actor, { ...target, serviceRevision: 5 });
    assert.throws(() =>
      store.assertClaim(exchange, { ...actor, userId: "mallory" }, target),
    );
  } finally {
    db.close();
  }
});
test("a probe's note keeps a personal sign-in under way", async () => {
  const { db, store } = await harness();
  try {
    const begin = store.start(target, actor, 2);
    const state = new URL(begin.authorizationUrl).searchParams.get("state")!;
    store.recordProbe(target, 2, { at: Date.now(), outcome: "configured" });
    assert.equal(store.config(target).lastProbe?.outcome, "configured");
    assert.deepEqual(store.pendingTarget(state, actor), target);
    store.claimFromState(actor, { state, code: "code", iss: discovery.issuer });
  } finally {
    db.close();
  }
});
test("token exchange extracts Twenty user identity rather than application sub and blocks fallback", async () => {
  const { db, store } = await harness();
  try {
    assert.deepEqual(store.resolve(target, actor.userId, "read"), {
      kind: "shared",
    });
    assert.throws(
      () => store.resolve(target, actor.userId, "write"),
      /service_oauth_connection_required/,
    );
    const { value } = claim(store);
    const network = synthetic(tokenResponse());
    const tokens = await exchangeTwentyOAuthCode(network.transport, value, {
      beforeDispatch: guard,
    });
    assert.equal(network.requests[0]!.bodyEncoding, "form");
    assert.equal(
      (network.requests[0]!.body as Record<string, string>).code_verifier,
      value.verifier,
    );
    assert.deepEqual(tokens.identity, {
      userId: "crm-alice",
      workspaceId: "crm-workspace",
      userWorkspaceId: "crm-user-workspace",
    });
    const status = store.commitConnection(value, tokens, actor, target);
    assert.equal(status.connection.status, "connected");
    assert.deepEqual(status.connection.identity, tokens.identity);
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes(tokens.accessToken), false);
    assert.equal(serialized.includes("synthetic-refresh-secret"), false);
    assert.equal(
      JSON.stringify(
        db.prepare("SELECT * FROM agent_service_oauth_connection").all(),
      ).includes(tokens.accessToken),
      false,
    );
    const resolved = store.resolve(target, actor.userId, "write");
    assert.equal(resolved.kind, "personal");
    assert.throws(
      () => store.resolve(target, "bob", "write"),
      /service_oauth_connection_required/,
    );
    assert.throws(() => store.commitConnection(value, tokens, actor, target));
    if (resolved.kind === "personal") {
      store.assertPin(target, actor.userId, resolved.pin);
      store.disconnect(target, actor.userId, status.connection.revision);
      assert.throws(() => store.assertPin(target, actor.userId, resolved.pin));
    }
  } finally {
    db.close();
  }
});
test("non-user tokens, wrong issuer and expired tokens cannot satisfy personal authentication", async () => {
  const { db, store } = await harness();
  try {
    const { value } = claim(store);
    for (const invalid of [
      { userId: undefined },
      { userWorkspaceId: undefined },
      { type: "API_KEY" },
      { exp: Math.floor(Date.now() / 1000) - 1 },
      { iss: "https://wrong.example.test" },
    ])
      await assert.rejects(
        exchangeTwentyOAuthCode(
          synthetic(tokenResponse(invalid)).transport,
          value,
          { beforeDispatch: guard },
        ),
      );
    await assert.rejects(
      exchangeTwentyOAuthCode(
        synthetic({ ...tokenResponse(), scope: "profile" }).transport,
        value,
        { beforeDispatch: guard },
      ),
    );
    assert.equal(
      store.status(target, actor.userId).connection.status,
      "disconnected",
    );
  } finally {
    db.close();
  }
});
test("disconnect/config edits/service edits during exchange prevent credential commit", async () => {
  for (const change of [
    "disconnect",
    "config",
    "service",
    "session",
  ] as const) {
    const { db, store } = await harness();
    try {
      const { value } = claim(store);
      const tokens = await exchangeTwentyOAuthCode(
        synthetic(tokenResponse()).transport,
        value,
        { beforeDispatch: guard },
      );
      if (change === "disconnect") store.disconnect(target, actor.userId, 0);
      if (change === "config")
        store.save(target, 2, { requiredFor: "all", signInHint: "service" });
      assert.throws(() =>
        store.commitConnection(
          value,
          tokens,
          change === "session" ? { ...actor, sessionId: "another" } : actor,
          change === "service"
            ? { ...target, serviceUrl: "https://other.example.test/mcp" }
            : target,
        ),
      );
    } finally {
      db.close();
    }
  }
});
test("configuration/URL changes invalidate credentials and expiry requires reconnect", async () => {
  const { db, store } = await harness();
  try {
    const { value } = claim(store);
    const tokens = await exchangeTwentyOAuthCode(
      synthetic(tokenResponse()).transport,
      value,
      { beforeDispatch: guard },
    );
    store.commitConnection(value, tokens, actor, target);
    const pinned = store.resolve(target, actor.userId, "write");
    assert.equal(pinned.kind, "personal");
    assert.throws(() =>
      store.resolve(
        { ...target, serviceUrl: "https://other.example.test/mcp" },
        actor.userId,
        "write",
      ),
    );
    db.prepare(
      "UPDATE agent_service_oauth_connection SET data=json_set(data,'$.expiresAt',?)",
    ).run(Date.now() - 1);
    assert.equal(
      store.status(target, actor.userId).connection.status,
      "expired",
    );
    assert.throws(
      () => store.resolve(target, actor.userId, "write"),
      /service_oauth_reconnect_required/,
    );
    if (pinned.kind === "personal") {
      assert.throws(() => store.assertPin(target, actor.userId, pinned.pin));
      store.assertPin(target, actor.userId, pinned.pin, true);
      assert.equal(
        store.resolve(target, actor.userId, "write", true).kind,
        "personal",
      );
    }
    // Approval mode and sign-in hint do not change what the token stands for.
    store.save(target, 2, { requiredFor: "all", signInHint: "service" });
    assert.equal(
      store.status(target, actor.userId).connection.status,
      "expired",
    );
    if (pinned.kind === "personal")
      store.assertPin(target, actor.userId, pinned.pin, true);
    // Rediscovering identical endpoints keeps the connection too.
    store.setDiscovery(target, 3, store.config(target).discovery!);
    if (pinned.kind === "personal")
      store.assertPin(target, actor.userId, pinned.pin, true);
    // Requested permissions are credential-relevant: everyone reconnects.
    store.save(target, 4, {
      requiredFor: "all",
      signInHint: "service",
      scopes: ["api"],
    });
    assert.equal(
      store.status(target, actor.userId).connection.status,
      "disconnected",
    );
    assert.throws(() => store.resolve(target, actor.userId, "read"));
    assert.throws(() => store.resolve(target, actor.userId, "read", true));
    if (pinned.kind === "personal")
      assert.throws(() =>
        store.assertPin(target, actor.userId, pinned.pin, true),
      );
  } finally {
    db.close();
  }
});
test("form transport encodes OAuth fields without weakening dispatch guard or byte limits", async () => {
  const calls: { body: string; type: string | undefined }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    calls.push({ body, type: req.headers["content-type"] });
    res.setHeader("Content-Type", "application/json");
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const transport = createTransport([origin]);
  try {
    await transport({
      url: origin + "/token",
      method: "POST",
      bodyEncoding: "form",
      body: { code: "a+b&c=d", client_secret: "space secret" },
      beforeDispatch: guard,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.type, "application/x-www-form-urlencoded");
    assert.equal(new URLSearchParams(calls[0]!.body).get("code"), "a+b&c=d");
    await assert.rejects(
      transport({
        url: origin + "/token",
        method: "POST",
        bodyEncoding: "form",
        body: { code: "secret" },
        beforeDispatch: async () => {},
      }),
    );
    await assert.rejects(
      transport({
        url: origin + "/token",
        method: "POST",
        bodyEncoding: "form",
        body: { code: "too long" },
        maxRequestBytes: 2,
      }),
    );
    assert.equal(calls.length, 1);
    await transport({
      url: origin + "/json",
      method: "POST",
      body: { unchanged: true },
      beforeDispatch: guard,
    });
    assert.equal(calls[1]!.type, "application/json");
    assert.deepEqual(JSON.parse(calls[1]!.body), { unchanged: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const tenant = "11111111-2222-3333-4444-555555555555";
const graph: ServiceOAuthTarget = {
  workspaceId: "workspace",
  serviceId: "microsoft-365",
  // A hosted MCP server on loopback: the sign-in method, not the service, is the authority.
  serviceUrl: "http://127.0.0.1:3000/mcp",
  serviceRevision: 2,
};
function microsoftStore(revision = { value: 3 }) {
  const db = new DatabaseSync(":memory:");
  const store = new ServiceOAuthStore(
    db,
    "synthetic-test-secret",
    "https://agent.example.test",
  );
  store.useProviders((workspaceId, providerId) => {
    assert.equal(workspaceId, graph.workspaceId);
    assert.equal(providerId, "entra");
    return {
      kind: "microsoft",
      tenantId: tenant,
      clientId: "entra-client",
      clientSecret: "entra-secret",
      revision: revision.value,
    };
  });
  store.save(graph, 0, {
    requiredFor: "all",
    source: "provider",
    authProviderId: "entra",
    scopes: ["Calendars.ReadWrite", "Mail.Send"],
  });
  return { db, store, revision };
}
function idToken(patch: Record<string, unknown> = {}, nonce?: string) {
  return jwt({
    iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
    aud: "entra-client",
    // Deliberately different: Microsoft links the account by oid, not by sub.
    sub: "pairwise-sub-not-the-account",
    oid: "alice-pairwise-subject",
    tid: tenant,
    preferred_username: "alice@example.test",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...(nonce ? { nonce } : {}),
    ...patch,
  });
}
function graphTokens(nonce?: string, patch: Record<string, unknown> = {}) {
  return {
    access_token: "opaque-graph-access-token",
    refresh_token: "graph-refresh-1",
    id_token: idToken(patch, nonce),
    token_type: "Bearer",
    expires_in: 3600,
    scope: "Calendars.ReadWrite Mail.Send openid profile offline_access",
  };
}
async function connectMicrosoft(store: ServiceOAuthStore) {
  const started = store.start(graph, actor, store.config(graph).revision);
  const url = new URL(started.authorizationUrl);
  const state = url.searchParams.get("state")!;
  const value = store.claimFromState(actor, { state, code: "entra-code" });
  const network = synthetic(graphTokens(url.searchParams.get("nonce")!));
  const tokens = await exchangeOAuthCode(network.transport, value, {
    beforeDispatch: guard,
  });
  return { url, value, tokens, network };
}
test("a sign-in method supplies Microsoft endpoints, client and account-proving scopes", async () => {
  const { db, store } = microsoftStore();
  try {
    const config = store.config(graph);
    assert.equal(config.hasClientId, true);
    assert.equal(
      config.discovery?.tokenEndpoint,
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    );
    assert.equal(JSON.stringify(config).includes("entra-secret"), false);
    assert.throws(() => store.registration(graph, config.revision));
    const { url, value, tokens, network } = await connectMicrosoft(store);
    assert.equal(url.origin, "https://login.microsoftonline.com");
    assert.equal(url.pathname, `/${tenant}/oauth2/v2.0/authorize`);
    assert.deepEqual(url.searchParams.get("scope")!.split(" "), [
      "openid",
      "profile",
      "offline_access",
      "Calendars.ReadWrite",
      "Mail.Send",
    ]);
    assert.equal(url.searchParams.get("nonce")!.length, 43);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const body = network.requests[0]!.body as Record<string, string>;
    assert.equal(body.client_secret, "entra-secret");
    assert.equal(body.code_verifier, value.verifier);
    assert.deepEqual(tokens.identity, {
      subject: "alice-pairwise-subject",
      tenant,
      label: "alice@example.test",
    });
    assert.throws(
      () => store.commitConnection(value, tokens, actor, graph),
      /service_oauth_account_mismatch/,
    );
    assert.throws(
      () => store.commitConnection(value, tokens, actor, graph, "someone-else"),
      /service_oauth_account_mismatch/,
    );
    const status = store.commitConnection(
      value,
      tokens,
      actor,
      graph,
      "alice-pairwise-subject",
    );
    assert.equal(status.connection.status, "connected");
    const resolved = store.resolve(graph, actor.userId, "read");
    assert.equal(resolved.kind, "personal");
    if (resolved.kind === "personal") {
      assert.equal(resolved.accessToken, "opaque-graph-access-token");
      assert.equal(resolved.pin.externalUserId, "alice-pairwise-subject");
      assert.equal(resolved.pin.externalWorkspaceId, tenant);
    }
    assert.equal(
      JSON.stringify(
        db.prepare("SELECT * FROM agent_service_oauth_connection").all(),
      ).includes("graph-refresh-1"),
      false,
    );
  } finally {
    db.close();
  }
});
test("an id_token from another tenant, client, nonce or an expired one is refused", async () => {
  const { db, store } = microsoftStore();
  try {
    const started = store.start(graph, actor, store.config(graph).revision);
    const url = new URL(started.authorizationUrl);
    const value = store.claimFromState(actor, {
      state: url.searchParams.get("state")!,
      code: "entra-code",
    });
    const nonce = url.searchParams.get("nonce")!;
    for (const [patch, useNonce] of [
      [{ iss: "https://login.microsoftonline.com/other/v2.0" }, nonce],
      [{ aud: "another-client" }, nonce],
      [{ exp: Math.floor(Date.now() / 1000) - 5 }, nonce],
      [{}, "replayed-nonce"],
      [{ oid: undefined }, nonce],
    ] as const)
      await assert.rejects(
        exchangeOAuthCode(
          synthetic(graphTokens(useNonce, patch)).transport,
          value,
          { beforeDispatch: guard },
        ),
      );
    const { id_token: _omitted, ...withoutAccount } = graphTokens(nonce);
    await assert.rejects(
      exchangeOAuthCode(synthetic(withoutAccount).transport, value, {
        beforeDispatch: guard,
      }),
    );
  } finally {
    db.close();
  }
});
test("a changed sign-in method invalidates a pending consent", async () => {
  const { db, store, revision } = microsoftStore();
  try {
    const started = store.start(graph, actor, store.config(graph).revision);
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    revision.value++;
    assert.throws(() => store.claimFromState(actor, { state, code: "code" }));
  } finally {
    db.close();
  }
});
test("tokens are refreshed ahead of expiry for the same account only, and never twice", async () => {
  const { db, store } = microsoftStore();
  try {
    const { value, tokens } = await connectMicrosoft(store);
    store.commitConnection(
      value,
      tokens,
      actor,
      graph,
      "alice-pairwise-subject",
    );
    const pin = store.resolve(graph, actor.userId, "write");
    assert.equal(store.refreshSnapshot(graph, actor.userId), undefined);
    db.prepare(
      "UPDATE agent_service_oauth_connection SET data=json_set(data,'$.expiresAt',?)",
    ).run(Date.now() - 1);
    assert.throws(
      () => store.resolve(graph, actor.userId, "write"),
      /service_oauth_reconnect_required/,
    );
    const snapshot = store.refreshSnapshot(graph, actor.userId)!;
    assert.equal(snapshot.refreshToken, "graph-refresh-1");
    const network = synthetic({
      ...graphTokens(undefined),
      access_token: "renewed-graph-token",
      refresh_token: "graph-refresh-2",
    });
    const renewed = await refreshOAuthToken(network.transport, snapshot, {
      beforeDispatch: guard,
    });
    const body = network.requests[0]!.body as Record<string, string>;
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.refresh_token, "graph-refresh-1");
    store.commitRefresh(snapshot, renewed, graph);
    const resolved = store.resolve(graph, actor.userId, "write");
    assert.equal(
      resolved.kind === "personal" && resolved.accessToken,
      "renewed-graph-token",
    );
    // Approvals pinned before the refresh still match the same account and revision.
    if (pin.kind === "personal") store.assertPin(graph, actor.userId, pin.pin);
    assert.throws(() => store.commitRefresh(snapshot, renewed, graph));
    db.prepare(
      "UPDATE agent_service_oauth_connection SET data=json_set(data,'$.expiresAt',?)",
    ).run(Date.now() - 1);
    const next = store.refreshSnapshot(graph, actor.userId)!;
    assert.equal(next.refreshToken, "graph-refresh-2");
    await assert.rejects(
      refreshOAuthToken(
        synthetic(graphTokens(undefined, { oid: "mallory" })).transport,
        next,
        { beforeDispatch: guard },
      ),
    );
    store.dropRefresh(next);
    assert.equal(
      store.status(graph, actor.userId).connection.status,
      "disconnected",
    );
  } finally {
    db.close();
  }
});
test("a protected resource may name a foreign authorization server; nothing else may", async () => {
  const responses: Record<string, unknown> = {
    "https://mcp.example.test/.well-known/oauth-protected-resource": {
      resource: "https://mcp.example.test/mcp",
      authorization_servers: ["https://auth.example.test"],
    },
    "https://auth.example.test/.well-known/oauth-authorization-server": {
      ...discovery,
      issuer: "https://auth.example.test",
      authorization_endpoint: "https://auth.example.test/authorize",
      token_endpoint: "https://auth.example.test/token",
      registration_endpoint: "https://auth.example.test/register",
    },
  };
  const transport: IntegrationTransport = async (request) => {
    await request.beforeDispatch?.(() => {});
    const body = responses[request.url];
    return {
      status: body ? 200 : 404,
      headers: { "content-type": "application/json" },
      text: JSON.stringify(body ?? {}),
    };
  };
  const metadata = await discoverOAuth(
    transport,
    "https://mcp.example.test/mcp",
    { beforeDispatch: guard },
  );
  assert.equal(metadata.issuer, "https://auth.example.test");
  assert.equal(metadata.authority, "protected-resource");
  responses[
    "https://auth.example.test/.well-known/oauth-authorization-server"
  ] = {
    ...(responses[
      "https://auth.example.test/.well-known/oauth-authorization-server"
    ] as object),
    token_endpoint: "https://elsewhere.example.test/token",
  };
  await assert.rejects(
    discoverOAuth(transport, "https://mcp.example.test/mcp", {
      beforeDispatch: guard,
    }),
  );
  assert.throws(() =>
    validateOAuthMetadata("https://mcp.example.test/mcp", {
      ...metadata,
      authority: undefined,
    }),
  );
});
