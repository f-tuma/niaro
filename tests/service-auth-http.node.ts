import { seedIdentityFixture } from "./helpers/identity-seed";
import { createHash, randomBytes } from "node:crypto";
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

import { IntegrationError } from "../apps/server-integrations/transport";

test("HTTP server sign-in providers, personal service sign-in and workspace roles", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-service-auth-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST Authentication",
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
  const serviceRequests: string[] = [];
  let exchanges = 0;
  const failTokenExchange = false;
  const identity = await openIdentity(config, {
    integrationTransport: async (request) => {
      if (
        new URL(request.url).pathname === "/test-role-read" ||
        new URL(request.url).pathname === "/test-role-write"
      ) {
        await request.beforeDispatch?.(() => serviceRequests.push(request.url));
        return { status: 200, headers: {}, text: '{"ok":true}' };
      }
      await request.beforeDispatch?.(() => {});
      const metadata = {
        issuer: "https://crm.example.test",
        authorization_endpoint: "https://crm.example.test/authorize",
        token_endpoint: "https://crm.example.test/oauth/token",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["api", "profile"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      };
      if (request.url.endsWith("/token")) {
        exchanges++;
        if (failTokenExchange)
          throw new IntegrationError("service_oauth_response_invalid", 502);
      }
      const token = [
        "header",
        JSON.stringify({
          type: "APPLICATION_ACCESS",
          sub: "app-not-user",
          userId: "crm-owner",
          workspaceId: "crm-workspace",
          userWorkspaceId: "crm-member",
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        "signature",
      ]
        .map((x) => Buffer.from(x).toString("base64url"))
        .join(".");
      return {
        status: 200,
        headers: {},
        text: JSON.stringify(
          request.url.endsWith("/token")
            ? {
                access_token: token,
                token_type: "Bearer",
                expires_in: 3600,
                scope: "api profile",
              }
            : metadata,
        ),
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
    member = client();
  const password = "TEST-auth-password-123";
  try {
    assert.equal((await operator("api/login", { key })).status, 200);
    assert.equal(
      (
        await operator("api/identity/bootstrap", {
          name: "TEST Owner",
          email: "owner@example.test",
          password,
          organizationName: "TEST Org",
        })
      ).status,
      200,
    );
    // Setup signed this browser in as the owner: back to the recovery key.
    await operator("api/login", { key });
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
    await seedIdentityFixture(identity, {
      type: "createAccount",
      organizationId,
      name: "TEST Member",
      email: "member@example.test",
      password,
      role: "member",
    });
    await member("auth/sign-in/email", {
      email: "member@example.test",
      password,
    });
    const workspaceId = (
      await owner(`api/identity/organization?id=${organizationId}`)
    ).data.workspaces[0].id;
    const target = { organizationId, workspaceId };
    let providerId = "";
    const input = {
      kind: "google",
      name: "TEST Google",
      enabled: true,
      clientId: "TEST-client",
      clientSecret: "TEST-secret",
    };
    await t.test(
      "Only admins configure masked company providers, immutable revisions and unlink-safe deletion",
      async () => {
        for (const caller of [member, operator, client()]) {
          const denied = await caller("api/identity/auth-providers/draft", {
            organizationId,
          });
          assert.ok(denied.status === 401 || denied.status === 403);
        }
        assert.equal(
          (
            await owner("api/identity/auth-providers/draft", {
              organizationId: "other-company",
            })
          ).status,
          403,
        );
        const prepared = await owner("api/identity/auth-providers/draft", {
          organizationId,
        });
        assert.equal(prepared.status, 200);
        assert.equal(prepared.data.organizationId, organizationId);
        assert.match(prepared.data.providerId, /^ap_[a-f0-9]{32}$/);
        assert.equal(
          prepared.data.callbackURL,
          `${origin}/admin/auth/callback/${prepared.data.providerId}`,
        );
        assert.deepEqual(
          (await owner("api/identity/auth-providers/list", { organizationId }))
            .data.providers,
          [],
        );
        assert.deepEqual(
          (await client()("api/identity/auth-providers/choices")).data
            .providers,
          [],
        );
        const save = {
          organizationId,
          providerId: null,
          creationId: prepared.data.providerId,
          revision: 0,
          input,
        };
        assert.equal(
          (await member("api/identity/auth-providers/save", save)).status,
          403,
        );
        assert.equal(
          (await operator("api/identity/auth-providers/save", save)).status,
          403,
        );
        assert.equal(
          (await owner("api/identity/auth-providers/save", save)).status,
          200,
        );
        const list = await member("api/identity/auth-providers/list", {
          organizationId,
        });
        assert.equal(list.status, 200);
        assert.equal(list.data.canManage, false);
        providerId = list.data.providers[0].id;
        assert.equal(providerId, prepared.data.providerId);
        assert.equal(
          list.data.providers[0].callbackURL,
          prepared.data.callbackURL,
        );
        assert.equal(
          (await owner("api/identity/auth-providers/save", save)).status,
          409,
        );
        assert.equal(list.data.providers[0].hasClientSecret, true);
        assert(!JSON.stringify(list.data).includes("TEST-secret"));
        assert.equal(
          (
            await owner("api/identity/auth-providers/save", {
              ...save,
              creationId: undefined,
              providerId,
              revision: 0,
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await owner("api/identity/auth-providers/list", {
              organizationId: "other-company",
            })
          ).status,
          403,
        );
        const choices = await client()("api/identity/auth-providers/choices");
        assert.equal(choices.data.providers[0].id, providerId);
        assert(!JSON.stringify(choices.data).includes("TEST-client"));
      },
    );
    const serviceId = (
      await owner("api/identity/catalog/command", {
        ...target,
        type: "saveService",
        revision: 0,
        settings: {
          name: "TEST CRM",
          url: "https://crm.example.test",
          protocol: "openapi",
          icon: "users",
          auth: { type: "none" },
          enabled: true,
        },
      })
    ).data.id;
    const oauth = (action: string, extra = {}) =>
      owner(`api/identity/catalog/oauth/${action}`, {
        ...target,
        serviceId,
        ...extra,
      });
    const status = await oauth("status");
    assert.equal(status.status, 200);
    assert.equal(status.data.config.settings.requiredFor, "none");
    assert.equal(status.data.connection.status, "disconnected");
    assert.equal(
      (
        await member(`api/identity/catalog/oauth/save`, {
          ...target,
          serviceId,
          revision: 0,
          settings: { requiredFor: "all" },
          client: {},
        })
      ).status,
      403,
      "only administrators configure personal sign-in",
    );
    assert.equal(
      (
        await owner("api/service-connect", {
          action: "inspect",
          attemptId: "A".repeat(43),
        })
      ).status,
      403,
    );
    assert.equal(exchanges, 0);
    const account = await member("api/identity/auth-providers/account", {
      organizationId,
    });
    assert.equal(account.status, 200);
    assert.equal(account.data.providers[0].linked, false);
    assert(!JSON.stringify(account.data).includes("TEST-secret"));
    const linked = await member("api/identity/auth-providers/link", {
      organizationId,
      providerId,
    });
    assert.equal(linked.status, 200);
    assert.equal(
      new URL(linked.data.authorizationUrl).hostname,
      "accounts.google.com",
    );
    assert.equal(
      (
        await member("api/identity/auth-providers/link", {
          organizationId: "other",
          providerId,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await client()("api/identity/auth-providers/link", {
          organizationId,
          providerId,
        })
      ).status,
      401,
    );

    const detail = (
      await owner(`api/identity/organization?id=${organizationId}`)
    ).data;
    const memberId = detail.members.find(
      (m: { email: string }) => m.email === "member@example.test",
    ).id;
    const saveRole = {
      type: "saveWorkspaceRole",
      ...target,
      revision: 0,
      name: "TEST Sales",
      memberIds: [memberId],
    };
    assert.equal((await member("api/identity/command", saveRole)).status, 403);
    assert.equal((await owner("api/identity/command", saveRole)).status, 400);
    assert.equal(
      (
        await seedIdentityFixture(identity, {
          ...target,
          type: "setWorkspaceMember",
          memberId,
          allowed: true,
        })
      ).status,
      200,
    );
    assert.equal((await owner("api/identity/command", saveRole)).status, 200);
    let role = (await owner(`api/identity/organization?id=${organizationId}`))
      .data.workspaces[0].roles[0];
    assert.deepEqual(role.memberIds, [memberId]);
    assert.equal(
      (
        await owner("api/identity/command", {
          ...saveRole,
          id: role.id,
          revision: 0,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await owner("api/identity/command", {
          ...saveRole,
          id: role.id,
          revision: role.revision,
          name: "TEST Sales renamed",
        })
      ).status,
      200,
    );
    await t.test(
      "live workspace role removal invalidates mobile work and blocks service dispatch",
      async () => {
        const inventoryPath = `api/identity/catalog?organizationId=${organizationId}&workspaceId=${workspaceId}`;
        const inventory = async () => (await owner(inventoryPath)).data;
        let service = (await inventory()).services.find(
          (s: { id: string }) => s.id === serviceId,
        );
        const {
          id: _id,
          revision,
          actions: _actions,
          hasCredential: _credential,
          modelId: _model,
          ...settings
        } = service;
        assert.equal(
          (
            await owner("api/identity/catalog/command", {
              ...target,
              type: "saveService",
              id: serviceId,
              revision,
              settings: {
                ...settings,
                access: { roles: [], workspaceRoles: [role.id] },
              },
            })
          ).status,
          200,
        );
        const addAction = async (
          effect: "read" | "write",
          allowed: boolean,
        ) => {
          service = (await inventory()).services.find(
            (s: { id: string }) => s.id === serviceId,
          );
          const result = await owner("api/identity/catalog/command", {
            ...target,
            type: "saveAction",
            serviceId,
            serviceRevision: service.revision,
            revision: 0,
            settings: {
              name: `TEST ${effect}`,
              description: "",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
              binding: {
                type: "http",
                method: effect === "read" ? "GET" : "POST",
                path: `/test-role-${effect}`,
                parameters: [],
                body: false,
              },
              enabled: true,
              effect,
              approval: effect === "read" ? "never" : "always",
              policy: {
                roles: [],
                workspaceRoles: allowed ? [role.id] : [],
                users: [],
              },
            },
          });
          assert.equal(result.status, 200, JSON.stringify(result.data));
          return result.data.id as string;
        };
        const readId = await addAction("read", true),
          writeId = await addAction("write", false);
        const memberInventory = (await member(inventoryPath)).data;
        assert.equal(memberInventory.canManage, false);
        assert.deepEqual(
          memberInventory.services[0].actions.map((a: { id: string }) => a.id),
          [readId],
        );
        assert.deepEqual(memberInventory.providers, []);
        assert.deepEqual(memberInventory.models, []);
        const invoke = async (actionId: string, requestId: string) => {
          const current = (await inventory()).services.find(
            (s: { id: string }) => s.id === serviceId,
          );
          return member("api/identity/catalog/invoke", {
            ...target,
            serviceId,
            serviceRevision: current.revision,
            actionId,
            revision: current.actions.find(
              (a: { id: string }) => a.id === actionId,
            ).revision,
            input: {},
            requestId,
          });
        };
        assert.equal(
          (await invoke(readId, "TEST-read-allowed")).data.status,
          "succeeded",
        );
        assert.equal((await invoke(writeId, "TEST-write-denied")).status, 403);
        assert.equal(serviceRequests.length, 1);
        // Use the same PKCE flow as the phone and retain its already-open runtime.
        const verifier = randomBytes(32).toString("base64url"),
          state = randomBytes(32).toString("base64url");
        const start = await identity.appLogin("start", {
          challenge: createHash("sha256").update(verifier).digest("base64url"),
          state,
        });
        const consent = await member("api/identity/app/consent", {
          ...target,
          id: new URL(
            (start as { authorizationUrl: string }).authorizationUrl,
          ).hash.slice(1),
        });
        assert.equal(consent.status, 200);
        const signed = (await identity.appLogin("exchange", {
          verifier,
          state,
          code: consent.data.code,
        })) as {
          credential: { accessToken: string; scope: { serverId: string } };
        };
        const auth = `Bearer ${signed.credential.accessToken}`,
          serverId = signed.credential.scope.serverId;
        const running = await identity.mobileAccess(
          auth,
          workspaceId,
          serverId,
        );
        assert.equal(
          await running.integrations!.hasTurn("TEST-unstarted"),
          false,
        );
        const currentRole = () =>
          owner(`api/identity/organization?id=${organizationId}`).then((r) =>
            r.data.workspaces[0].roles.find(
              (r: { id: string }) => r.id === role.id,
            ),
          );
        const before = await currentRole();
        assert.equal(
          (
            await owner("api/identity/command", {
              ...saveRole,
              id: role.id,
              revision: before.revision,
              memberIds: [],
            })
          ).status,
          200,
        );
        assert.deepEqual((await member(inventoryPath)).data.services, []);
        assert.equal(
          (await invoke(readId, "TEST-read-after-removal")).status,
          403,
        );
        await assert.rejects(
          running.integrations!.hasTurn("TEST-stale-work"),
          /model_unavailable/,
        );
        // The device stays signed in, but new work uses the current policy.
        const refreshed = await identity.mobileAccess(
          auth,
          workspaceId,
          serverId,
        );
        assert.equal(
          await refreshed.integrations!.hasTurn("TEST-new-work"),
          false,
        );
        assert.equal(serviceRequests.length, 1);
        const removed = await currentRole();
        assert.equal(
          (
            await owner("api/identity/command", {
              ...saveRole,
              id: role.id,
              revision: removed.revision,
            })
          ).status,
          200,
        );
        assert.equal(
          (await invoke(readId, "TEST-read-restored")).data.status,
          "succeeded",
        );
        assert.equal(serviceRequests.length, 2);
        // Leave no service reference so the outer role deletion test can run.
        service = (await inventory()).services.find(
          (s: { id: string }) => s.id === serviceId,
        );
        assert.equal(
          (
            await owner("api/identity/catalog/command", {
              ...target,
              type: "removeService",
              id: serviceId,
              revision: service.revision,
            })
          ).status,
          200,
        );
      },
    );
    assert.equal(
      (
        await owner("api/identity/command", {
          ...target,
          type: "setWorkspaceMember",
          memberId,
          allowed: false,
        })
      ).status,
      200,
    );
    role = (await owner(`api/identity/organization?id=${organizationId}`)).data
      .workspaces[0].roles[0];
    assert.deepEqual(role.memberIds, []);
    assert.equal(
      (
        await owner("api/identity/command", {
          ...target,
          type: "removeWorkspaceRole",
          id: role.id,
          revision: role.revision,
        })
      ).status,
      200,
    );
    await t.test(
      "an MCP service added by address gets its OAuth detected without any click",
      async () => {
        const mcpId = (
          await owner("api/identity/catalog/command", {
            ...target,
            type: "saveService",
            revision: 0,
            settings: {
              name: "TEST MCP",
              url: "https://crm.example.test/mcp",
              protocol: "mcp",
              icon: "plug",
              auth: { type: "none" },
              enabled: true,
            },
          })
        ).data.id as string;
        assert.equal(
          (
            await member("api/identity/catalog/oauth/auto", {
              ...target,
              serviceId: mcpId,
            })
          ).status,
          403,
        );
        // Joins the probe the save started and answers with the outcome.
        const auto = await owner("api/identity/catalog/oauth/auto", {
          ...target,
          serviceId: mcpId,
        });
        assert.equal(auto.status, 200);
        assert.equal(
          auto.data.config.discovery.issuer,
          "https://crm.example.test",
        );
        assert.equal(auto.data.config.settings.requiredFor, "all");
        assert.equal(auto.data.config.settings.source, "service");
        assert.deepEqual(auto.data.config.settings.scopes, ["api", "profile"]);
        // This server registers nobody: the client is still missing.
        assert.equal(auto.data.config.hasClientId, false);
        assert.equal(auto.data.config.lastProbe.outcome, "metadata");
        assert.equal(
          auto.data.config.lastProbe.reason,
          "service_oauth_registration_unsupported",
        );
        assert.equal(auto.data.connection.status, "disconnected");
        const status = await owner("api/identity/catalog/oauth/status", {
          ...target,
          serviceId: mcpId,
        });
        assert.equal(status.data.config.revision, auto.data.config.revision);
        const audit = await owner(
          `api/identity/audit?organizationId=${organizationId}&workspaceId=${workspaceId}`,
        );
        assert(
          JSON.stringify(audit.data).includes('"oauthProbe":"metadata"'),
          "the probe is audited",
        );
        const mcp = (
          await owner(
            `api/identity/catalog?organizationId=${organizationId}&workspaceId=${workspaceId}`,
          )
        ).data.services.find((s: { id: string }) => s.id === mcpId);
        assert.equal(
          (
            await owner("api/identity/catalog/command", {
              ...target,
              type: "removeService",
              id: mcpId,
              revision: mcp.revision,
            })
          ).status,
          200,
        );
      },
    );
    assert.equal(
      (
        await owner("api/identity/auth-providers/delete", {
          organizationId,
          providerId,
          revision: 1,
        })
      ).status,
      200,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    app!.emit("close");
    await identity.close();
    rmSync(root, { recursive: true, force: true });
  }
});
