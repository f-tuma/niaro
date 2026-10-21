import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIdentity } from "../apps/server-identity/service";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { issueAdminKey } from "../apps/server-admin/auth";
import { ServerConfigSchema } from "../apps/reference-server/config";
import type { TransportRequest } from "../apps/server-integrations/transport";

const tenant = "11111111-2222-4333-8444-555555555555";
const tokenEndpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
const jwt = (payload: Record<string, unknown>) =>
  [{ alg: "RS256" }, payload, "signature"]
    .map((part) =>
      Buffer.from(
        typeof part === "string" ? part : JSON.stringify(part),
      ).toString("base64url"),
    )
    .join(".");

test("a phone connects a Microsoft account once through the browser and calls the service as that person", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-service-connect-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST Service connect",
    listen: { port: address.port },
    dataDirectory: join(root, "workflow"),
    allowedOrigins: [],
    administration: {
      keyFile: join(root, "key"),
      identity: { directory: join(root, "identity"), baseURL: origin },
    },
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  });
  const key = issueAdminKey(config.administration!.keyFile);
  // The synthetic Entra token endpoint answers as whichever account consented.
  let consentingAccount = "owner-entra-subject";
  let nonce = "";
  let issued = 0;
  let refuseRefresh = false;
  const tokenRequests: Record<string, string>[] = [];
  const serviceCalls: TransportRequest[] = [];
  const identity = await openIdentity(config, {
    integrationTransport: async (request) => {
      await request.beforeDispatch?.(() => {});
      if (request.url === tokenEndpoint) {
        const body = request.body as Record<string, string>;
        tokenRequests.push(body);
        if (body.grant_type === "refresh_token" && refuseRefresh)
          return {
            status: 400,
            headers: { "content-type": "application/json" },
            text: '{"error":"invalid_grant"}',
          };
        issued++;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({
            access_token: `graph-access-${issued}`,
            refresh_token: `graph-refresh-${issued}`,
            token_type: "Bearer",
            expires_in: 3600,
            scope: "openid profile offline_access Calendars.Read",
            id_token: jwt({
              iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
              aud: "TEST-entra-client",
              // Microsoft identifies the account by oid; sub differs per app.
              sub: `pairwise-${consentingAccount}`,
              oid: consentingAccount,
              tid: tenant,
              exp: Math.floor(Date.now() / 1000) + 3600,
              ...(body.grant_type === "authorization_code" ? { nonce } : {}),
            }),
          }),
        };
      }
      serviceCalls.push(request);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: '{"value":[]}',
      };
    },
  });
  app = createReferenceServer(config, {}, identity);
  function client() {
    const cookies = new Map<string, string>();
    return async (path: string, payload?: unknown) => {
      const res = await fetch(`${origin}/admin/${path}`, {
        method: payload === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      for (const cookie of res.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!,
          i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return { status: res.status, data: await res.json() };
    };
  }
  const operator = client(),
    owner = client(),
    stranger = client();
  const password = "TEST-connect-password-123";
  try {
    assert.equal((await operator("api/login", { key })).status, 200);
    await operator("api/identity/bootstrap", {
      name: "TEST Owner",
      email: "owner@example.test",
      password,
      organizationName: "TEST Org",
    });
    await owner("auth/sign-in/email", {
      email: "owner@example.test",
      password,
    });
    const organizationId = (await owner("api/identity")).data.organizations[0]
      .id;
    await owner("api/identity/command", {
      type: "createWorkspace",
      organizationId,
      name: "TEST Workspace",
    });
    const workspaceId = (
      await owner(`api/identity/organization?id=${organizationId}`)
    ).data.workspaces[0].id;
    const target = { organizationId, workspaceId };

    const draft = await owner("api/identity/auth-providers/draft", {
      organizationId,
    });
    const providerId = draft.data.providerId as string;
    assert.equal(
      (
        await owner("api/identity/auth-providers/save", {
          organizationId,
          providerId: null,
          creationId: providerId,
          revision: 0,
          input: {
            kind: "microsoft",
            name: "TEST Microsoft",
            enabled: true,
            clientId: "TEST-entra-client",
            clientSecret: "TEST-entra-secret",
            tenantId: tenant,
          },
        })
      ).status,
      200,
    );
    // The owner linked this Microsoft account when signing in (seeded, not a real IdP).
    const db = identity["db"];
    const ownerId = String(
      db.prepare("SELECT id FROM user WHERE email=?").get("owner@example.test")!
        .id,
    );
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES (?,?,?,?,?,?)',
    ).run(randomUUID(), "owner-entra-subject", providerId, ownerId, now, now);

    const serviceId = (
      await owner("api/identity/catalog/command", {
        ...target,
        type: "saveService",
        revision: 0,
        settings: {
          name: "TEST Calendar",
          url: "https://graph.example.test",
          protocol: "openapi",
          icon: "calendar",
          auth: { type: "none" },
          enabled: true,
        },
      })
    ).data.id as string;
    const inventory = async () =>
      (
        await owner(
          `api/identity/catalog?organizationId=${organizationId}&workspaceId=${workspaceId}`,
        )
      ).data.services.find((s: { id: string }) => s.id === serviceId);
    const actionId = (
      await owner("api/identity/catalog/command", {
        ...target,
        type: "saveAction",
        serviceId,
        serviceRevision: (await inventory()).revision,
        revision: 0,
        settings: {
          name: "TEST events",
          description: "",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          binding: {
            type: "http",
            method: "GET",
            path: "/me/events",
            parameters: [],
            body: false,
          },
          enabled: true,
          effect: "read",
          approval: "never",
          policy: { roles: ["owner"], users: [] },
        },
      })
    ).data.id as string;
    const oauth = (action: string, extra = {}) =>
      owner(`api/identity/catalog/oauth/${action}`, {
        ...target,
        serviceId,
        ...extra,
      });
    const saved = await oauth("save", {
      revision: 0,
      settings: {
        requiredFor: "all",
        source: "provider",
        authProviderId: providerId,
        scopes: ["Calendars.Read"],
      },
      client: {},
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(
      (await oauth("discover", { revision: 1 })).status,
      409,
      "a sign-in method needs no discovery",
    );
    const status = (await oauth("status")).data;
    assert.equal(status.config.hasClientId, true);
    assert(!JSON.stringify(status).includes("TEST-entra-secret"));

    let requestNumber = 0;
    const invoke = async () => {
      const service = await inventory();
      return owner("api/identity/catalog/invoke", {
        ...target,
        serviceId,
        serviceRevision: service.revision,
        actionId,
        revision: service.actions.find((a: { id: string }) => a.id === actionId)
          .revision,
        input: {},
        requestId: `TEST-events-${++requestNumber}`,
      });
    };
    const before = await invoke();
    assert.equal(before.status, 403);
    assert.equal(before.data.error, "service_oauth_connection_required");
    assert.equal(serviceCalls.length, 0, "never falls back to a shared key");

    // The phone signs in the same way as the app and starts the connection.
    const verifier = randomBytes(32).toString("base64url"),
      state = randomBytes(32).toString("base64url");
    const start = (await identity.appLogin("start", {
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      state,
    })) as { authorizationUrl: string };
    const consent = await owner("api/identity/app/consent", {
      ...target,
      id: new URL(start.authorizationUrl).hash.slice(1),
    });
    const signed = (await identity.appLogin("exchange", {
      verifier,
      state,
      code: consent.data.code,
    })) as { credential: { accessToken: string; scope: { serverId: string } } };
    const phone = `Bearer ${signed.credential.accessToken}`,
      serverId = signed.credential.scope.serverId;
    const mobile = (
      action: "start" | "status" | "cancel",
      attemptId?: string,
    ) =>
      identity.mobileServiceConnection(phone, workspaceId, serverId, action, {
        serviceId,
        ...(attemptId ? { attemptId } : {}),
      });
    const connect = async () => {
      const begun = (await mobile("start")) as {
        attemptId: string;
        authorizationUrl: string;
      };
      assert.equal(
        begun.authorizationUrl,
        `${origin}/admin/service-connect#${begun.attemptId}`,
      );
      const inspect = { action: "inspect", attemptId: begun.attemptId };
      assert.equal(
        (await stranger("api/service-connect", inspect)).status,
        401,
      );
      const details = await owner("api/service-connect", inspect);
      assert.equal(details.status, 200);
      assert.equal(details.data.service, "TEST Calendar");
      assert.equal(details.data.provider.linked, true);
      const authorized = await owner("api/service-connect", {
        action: "authorize",
        attemptId: begun.attemptId,
      });
      assert.equal(authorized.status, 200);
      const consentUrl = new URL(authorized.data.authorizationUrl);
      assert.equal(consentUrl.origin, "https://login.microsoftonline.com");
      assert.equal(consentUrl.searchParams.get("state"), begun.attemptId);
      assert.equal(
        consentUrl.searchParams.get("redirect_uri"),
        `${origin}/admin/service-connect`,
      );
      nonce = consentUrl.searchParams.get("nonce")!;
      return {
        begun,
        finish: () =>
          owner("api/service-connect", {
            state: begun.attemptId,
            code: "TEST-entra-code",
          }),
      };
    };

    // Another person's Microsoft account behind a forwarded consent link is refused.
    consentingAccount = "someone-else";
    const forwarded = await connect();
    const refused = await forwarded.finish();
    assert.equal(refused.status, 403);
    assert.equal(refused.data.error, "service_oauth_account_mismatch");
    assert.equal(
      (
        (await mobile("status", forwarded.begun.attemptId)) as {
          status: string;
        }
      ).status,
      "disconnected",
    );

    consentingAccount = "owner-entra-subject";
    const attempt = await connect();
    const finished = await attempt.finish();
    assert.equal(finished.status, 200, JSON.stringify(finished.data));
    assert.deepEqual(finished.data, { ok: true, app: true });
    assert.equal(
      (await attempt.finish()).status,
      403,
      "a consent code is redeemed once",
    );
    assert.deepEqual(await mobile("status", attempt.begun.attemptId), {
      serviceId,
      status: "connected",
      ready: true,
      flow: "connected",
    });
    const exchange = tokenRequests.at(-1)!;
    assert.equal(exchange.grant_type, "authorization_code");
    assert.equal(exchange.client_secret, "TEST-entra-secret");

    const after = await invoke();
    assert.equal(after.status, 200, JSON.stringify(after.data));
    assert.equal(after.data.status, "succeeded");
    assert.equal(
      serviceCalls.at(-1)!.headers?.Authorization,
      `Bearer graph-access-${issued}`,
    );

    // An expiring token is renewed before the call, with the same account.
    const expire = () =>
      db
        .prepare(
          "UPDATE agent_service_oauth_connection SET data=json_set(data,'$.expiresAt',?)",
        )
        .run(Date.now() - 1);
    expire();
    const renewedFrom = issued;
    assert.equal((await invoke()).data.status, "succeeded");
    assert.equal(tokenRequests.at(-1)!.grant_type, "refresh_token");
    assert.equal(
      tokenRequests.at(-1)!.refresh_token,
      `graph-refresh-${renewedFrom}`,
    );
    assert.equal(
      serviceCalls.at(-1)!.headers?.Authorization,
      `Bearer graph-access-${issued}`,
    );
    assert.notEqual(issued, renewedFrom);

    // A revoked grant ends the connection; the next request asks to sign in again.
    expire();
    refuseRefresh = true;
    const calls = serviceCalls.length;
    const revoked = await invoke();
    assert.equal(revoked.status, 403);
    assert.equal(revoked.data.error, "service_oauth_connection_required");
    assert.equal(serviceCalls.length, calls);
    assert.equal(
      ((await mobile("status")) as { status: string }).status,
      "disconnected",
    );
    assert(
      !JSON.stringify(
        db.prepare("SELECT * FROM agent_service_oauth_connection").all(),
      ).includes("graph-"),
      "tokens are stored sealed",
    );
  } finally {
    await identity.close?.();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
