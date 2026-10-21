import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { openIdentity } from "../apps/server-identity/service";
import { issueAdminKey } from "../apps/server-admin/auth";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../packages/protocol/identity";
import { InferenceBudgetPolicySchema } from "../packages/protocol/inference-budget";
import { seedIdentityFixture } from "./helpers/identity-seed";

test("budget HTTP uses account, origin and workspace boundaries and persists revisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "niaro-budget-http-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST budget HTTP",
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
  let external = 0;
  const options = {
    integrationTransport: async () => {
      external++;
      throw Error("TEST policy metadata must not dispatch");
    },
  };
  const key = issueAdminKey(config.administration!.keyFile),
    password = "TEST-budget-password-only-2026";
  let identity = await openIdentity(config, options);
  app = createReferenceServer(config, {}, identity);
  function client() {
    const cookies = new Map<string, string>();
    return async (path: string, body?: unknown, requestOrigin = origin) => {
      const res = await fetch(origin + "/admin/" + path, {
        method: body === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Origin: requestOrigin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie()) {
        const pair = c.split(";")[0]!,
          i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return { status: res.status, data: (await res.json()) as unknown };
    };
  }
  const operator = client(),
    owner = client(),
    member = client(),
    anonymous = client();
  try {
    assert.equal((await operator("api/login", { key })).status, 200);
    assert.equal(
      (
        await operator("api/identity/bootstrap", {
          name: "TEST owner",
          email: "owner@example.test",
          password,
          organizationName: "TEST budget org",
        })
      ).status,
      200,
    );
    // Setup signed this browser in as the owner: back to the recovery key.
    await operator("api/login", { key });
    assert.equal(
      (
        await owner("auth/sign-in/email", {
          email: "owner@example.test",
          password,
        })
      ).status,
      200,
    );
    const organizationId = IdentityStateSchema.parse(
      (await owner("api/identity")).data,
    ).organizations[0]!.id;
    assert.equal(
      (
        await owner("api/identity/command", {
          organizationId,
          type: "createWorkspace",
          name: "TEST workspace",
        })
      ).status,
      200,
    );
    await seedIdentityFixture(identity, {
      type: "createAccount",
      organizationId,
      role: "member",
      name: "TEST member",
      email: "member@example.test",
      password,
    });
    const detail = OrganizationDetailSchema.parse(
      (await owner(`api/identity/organization?id=${organizationId}`)).data,
    );
    const workspaceId = detail.workspaces[0]!.id,
      target = { organizationId, workspaceId };
    await seedIdentityFixture(identity, {
      type: "setWorkspaceMember",
      organizationId,
      workspaceId,
      memberId: detail.members.find((m) => m.role === "member")!.id,
      allowed: true,
    });
    assert.equal(
      (
        await member("auth/sign-in/email", {
          email: "member@example.test",
          password,
        })
      ).status,
      200,
    );
    const path = "api/identity/catalog/budget",
      query = path + "?" + new URLSearchParams(target);
    assert.equal((await anonymous(query)).status, 401);
    assert.equal((await operator(query)).status, 403);
    assert.equal((await member(query)).status, 403);
    assert.equal(
      (await owner(query, undefined, "https://other.example.test")).status,
      403,
    );
    const current = InferenceBudgetPolicySchema.parse(
      (await owner(query)).data,
    );
    assert.equal(current.settings.mode, "observe");
    assert.equal(current.revision, 0);
    const payload = {
      ...current,
      settings: { ...current.settings, mode: "enforce" },
    };
    assert.equal((await owner(path, payload)).status, 200);
    assert.equal((await owner(path, payload)).status, 409);
    assert.equal(
      (
        await owner(path, {
          ...payload,
          revision: 1,
          settings: { ...payload.settings, maxTokens: 0 },
        })
      ).status,
      400,
    );
    assert.equal(
      (await owner(path, { ...payload, revision: 1, userId: "TEST-spoof" }))
        .status,
      400,
    );
    assert.equal(
      (
        await owner(
          path +
            "?" +
            new URLSearchParams({
              ...target,
              workspaceId: "11111111-1111-4111-8111-111111111111",
            }),
        )
      ).status,
      404,
    );
    app.emit("close");
    await identity.close();
    identity = await openIdentity(config, options);
    app = createReferenceServer(config, {}, identity);
    const restored = InferenceBudgetPolicySchema.parse(
      (await owner(query)).data,
    );
    assert.equal(restored.revision, 1);
    assert.equal(restored.settings.mode, "enforce");
    assert.equal(external, 0);
  } finally {
    app.emit("close");
    await identity.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});
