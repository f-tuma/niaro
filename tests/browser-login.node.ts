import { seedIdentityFixture } from "./helpers/identity-seed";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openIdentity } from "../apps/server-identity/service";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { issueAdminKey } from "../apps/server-admin/auth";
import { ServerConfigSchema } from "../apps/reference-server/config";
import {
  BROWSER_LOGIN_PROFILE,
  BrowserLoginChallenge,
  BrowserLoginPoll,
} from "../packages/protocol/browser-login";

test("Browser login: consent, scope, one-use redemption and cancellation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-browser-login-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST Browser login",
    listen: { port: address.port },
    dataDirectory: join(root, "workflow"),
    allowedOrigins: ["http://localhost:8085"],
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
  const identity = await openIdentity(config);
  app = createReferenceServer(config, {}, identity);
  const db = new DatabaseSync(join(root, "identity", "identity.sqlite"));
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const password = "TEST-browser-login-password";
  function client() {
    const cookies = new Map<string, string>();
    return async (path: string, input?: unknown) => {
      const res = await fetch(`${origin}/admin/${path}`, {
        method: input === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      for (const cookie of res.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!;
        const i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return { status: res.status, data: await res.json() };
    };
  }
  const operator = client(),
    owner = client(),
    member = client(),
    another = client();
  const rootCall = async (action: string, deviceCode?: string) => {
    const res = await fetch(`${origin}/v1/auth/browser/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:8085",
      },
      body: JSON.stringify({
        profile: BROWSER_LOGIN_PROFILE,
        ...(deviceCode ? { deviceCode } : {}),
      }),
    });
    return { status: res.status, data: await res.json() };
  };
  const begin = async (persistent = false) => {
    const result = await rootCall(
      persistent ? "start?session=agent-device-session%2F1" : "start",
    );
    assert.equal(result.status, 200);
    return BrowserLoginChallenge.parse(result.data);
  };
  const session = async (token: string, workspace: string) =>
    fetch(`${origin}/v1/${workspace}/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
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
    // Setup signed the operator's browser in as the owner: back to the key.
    assert.equal((await operator("api/login", { key })).status, 200);
    assert.equal(
      (
        await owner("auth/sign-in/email", {
          email: "owner@example.test",
          password,
        })
      ).status,
      200,
    );
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
    const detail = (
      await owner(`api/identity/organization?id=${organizationId}`)
    ).data;
    const workspaceId = detail.workspaces[0].id;
    const memberRow = detail.members.find(
      (m: { email: string }) => m.email === "member@example.test",
    );
    const target = { organizationId, workspaceId };
    await member("auth/sign-in/email", {
      email: "member@example.test",
      password,
    });
    await another("auth/sign-in/email", {
      email: "owner@example.test",
      password,
    });
    const inspect = (code: string, who = owner) =>
      who("api/identity/device/inspect", { userCode: code });
    const consent = (code: string, approve = true, who = owner) =>
      who("api/identity/device/consent", {
        ...(approve ? target : {}),
        userCode: code,
        approve,
      });
    const allowMember = (allowed: boolean) =>
      allowed
        ? seedIdentityFixture(identity, {
            type: "setWorkspaceMember",
            ...target,
            memberId: memberRow.id,
            allowed: true,
          })
        : owner("api/identity/command", {
            type: "setWorkspaceMember",
            ...target,
            memberId: memberRow.id,
            allowed,
          });
    await t.test(
      "cross-site navigation only, no iframe or mutation bypass",
      async () => {
        const navigate = (path: string, headers: Record<string, string>) =>
          new Promise<number>((resolve, reject) => {
            const req = httpRequest(`${origin}${path}`, { headers }, (res) => {
              res.resume();
              resolve(res.statusCode!);
            });
            req.on("error", reject);
            req.end();
          });
        const headers = {
          "Sec-Fetch-Site": "cross-site",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
        };
        assert.equal(await navigate("/admin/device", headers), 200);
        assert.equal(
          await navigate("/admin/settings?error=access_denied", headers),
          200,
        );
        assert.equal(
          await navigate("/admin/settings", {
            ...headers,
            "Sec-Fetch-Dest": "iframe",
          }),
          403,
        );
        // Any known page of the console opens from a link elsewhere (a deep
        // link in mail or chat); an unknown path and an iframe still do not.
        assert.equal(await navigate("/admin/accounts", headers), 200);
        assert.equal(await navigate("/admin/services", headers), 200);
        assert.equal(await navigate("/admin/nothing-here", headers), 403);
        assert.equal(
          await navigate("/admin/services", {
            ...headers,
            "Sec-Fetch-Dest": "iframe",
          }),
          403,
        );
        // The provider returns here after consent; only as a top-level document.
        assert.equal(
          await navigate("/admin/service-connect?code=x&state=y", headers),
          200,
        );
        assert.equal(
          await navigate("/admin/service-connect", {
            ...headers,
            "Sec-Fetch-Dest": "iframe",
          }),
          403,
        );
        assert.equal(await navigate("/admin/hosted", headers), 200);
        assert.equal(
          await navigate("/admin/hosted", { "Sec-Fetch-Site": "none" }),
          200,
        );
        assert.equal(
          await navigate("/admin/device", {
            ...headers,
            "Sec-Fetch-Dest": "iframe",
          }),
          403,
        );
        assert.equal(
          (
            await fetch(`${origin}/admin/api/identity/device/consent`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: "https://attacker.example",
              },
              body: "{}",
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "approval is explicit, scoped, session-bound and single-use",
      async () => {
        const c = await begin();
        assert.equal(c.verificationUri, `${origin}/admin/device#${c.userCode}`);
        assert.equal(
          (await rootCall("poll", c.deviceCode)).data.status,
          "pending",
        );
        assert.equal((await rootCall("poll", c.deviceCode)).status, 429);
        assert.equal((await inspect(c.userCode, operator)).status, 403);
        assert.equal((await consent(c.userCode)).status, 409);
        assert.equal((await inspect(c.userCode)).status, 200);
        assert.equal((await inspect(c.userCode, another)).status, 403);
        assert.equal((await consent(c.userCode, true, another)).status, 409);
        assert.equal((await consent(c.userCode)).status, 200);
        assert.equal((await consent(c.userCode)).status, 409);
        db.prepare("UPDATE agent_browser_login SET last_poll=0").run();
        const approved = BrowserLoginPoll.parse(
          (await rootCall("poll", c.deviceCode)).data,
        );
        assert.equal(approved.status, "approved");
        if (approved.status !== "approved") return;
        assert.equal(approved.address, `${origin}/v1/${workspaceId}`);
        assert.equal(
          (await session(approved.credential.accessToken, workspaceId)).status,
          200,
        );
        assert.equal((await rootCall("poll", c.deviceCode)).status, 410);
        const raw = JSON.stringify(
          db.prepare("SELECT * FROM agent_browser_login").all(),
        );
        assert(!raw.includes(c.deviceCode));
        assert(!raw.includes(c.userCode));
        assert(!raw.includes(approved.credential.accessToken));
        assert.equal((await rootCall("cancel", c.deviceCode)).status, 200);
        assert.equal(
          (await session(approved.credential.accessToken, workspaceId)).status,
          401,
        );
      },
    );
    await t.test(
      "workspace membership required, revoke before redeem cannot be restored",
      async () => {
        const c = await begin();
        assert.equal((await inspect(c.userCode, member)).status, 200);
        assert.equal((await consent(c.userCode, true, member)).status, 403);
        await allowMember(true);
        assert.equal((await consent(c.userCode, true, member)).status, 200);
        await allowMember(false);
        await allowMember(true);
        assert.equal((await rootCall("poll", c.deviceCode)).status, 410);
        const own = await begin();
        await inspect(own.userCode, member);
        await consent(own.userCode, true, member);
        await member("api/identity/mobile/revoke", target);
        assert.equal((await rootCall("poll", own.deviceCode)).status, 410);
      },
    );
    await t.test(
      "denial, expiry, incorrect secret and parent logout fail closed",
      async () => {
        const c = await begin();
        await inspect(c.userCode);
        await consent(c.userCode, false);
        assert.equal((await rootCall("poll", c.deviceCode)).status, 403);
        assert.equal((await rootCall("poll", "X".repeat(43))).status, 410);
        const expired = await begin();
        db.prepare(
          "UPDATE agent_browser_login SET expires_at=0 WHERE digest=?",
        ).run(hash(expired.deviceCode));
        assert.equal((await inspect(expired.userCode)).status, 410);
        const logout = await begin();
        await inspect(logout.userCode, member);
        await consent(logout.userCode, true, member);
        await member("auth/sign-out", {});
        assert.equal((await rootCall("poll", logout.deviceCode)).status, 410);
      },
    );
    await t.test(
      "switch account releases only an unapproved claim; denial needs no workspace",
      async () => {
        const c = await begin();
        await inspect(c.userCode, another);
        assert.equal(
          (await owner("api/identity/device/release", { userCode: c.userCode }))
            .status,
          409,
        );
        assert.equal(
          (
            await another("api/identity/device/release", {
              userCode: c.userCode,
            })
          ).status,
          200,
        );
        // Retry after a lost release response or failed logout is harmless.
        assert.equal(
          (
            await another("api/identity/device/release", {
              userCode: c.userCode,
            })
          ).status,
          200,
        );
        await another("auth/sign-out", {});
        await another("auth/sign-in/email", {
          email: "member@example.test",
          password,
        });
        await allowMember(false);
        assert.equal((await inspect(c.userCode, another)).status, 200);
        assert.equal((await consent(c.userCode, false, another)).status, 200);
        assert.equal((await rootCall("poll", c.deviceCode)).status, 403);
      },
    );
    await t.test(
      "persistent devices survive console logout, rotate, recheck membership and revoke with expired access",
      async () => {
        await allowMember(true);
        await member("auth/sign-in/email", {
          email: "member@example.test",
          password,
        });
        const c = await begin(true);
        assert.equal((await inspect(c.userCode, member)).data.persistent, true);
        assert.equal((await consent(c.userCode, true, member)).status, 200);
        const approved = BrowserLoginPoll.parse(
          (await rootCall("poll", c.deviceCode)).data,
        );
        assert.equal(approved.status, "approved");
        if (approved.status !== "approved") throw Error("not approved");
        const initial = approved.credential;
        assert(initial.refresh);
        const runtime = await identity.mobileAccess(
          `Bearer ${initial.accessToken}`,
          workspaceId,
          initial.scope.serverId,
        );
        await member("auth/sign-out", {});
        assert.equal(
          (await session(initial.accessToken, workspaceId)).status,
          200,
        );
        const renew = (
          refreshToken: string,
          requestId = "test-rotation-request-1",
          method = "POST",
        ) =>
          fetch(`${origin}/v1/${workspaceId}/auth/refresh`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              profile: "agent-device-session/1",
              refreshToken,
              ...(method === "POST" ? { requestId } : {}),
            }),
          });
        db.prepare("UPDATE agent_mobile_device SET access_expires_at=0").run();
        assert.equal(
          (await session(initial.accessToken, workspaceId)).status,
          401,
        );
        const result = await renew(initial.refresh.token);
        assert.equal(result.status, 200);
        const rotated = await result.json();
        assert.notEqual(rotated.accessToken, initial.accessToken);
        assert.equal(
          (await session(rotated.accessToken, workspaceId)).status,
          200,
        );
        assert.deepEqual(
          await (await renew(initial.refresh.token)).json(),
          rotated,
        );
        assert.equal(
          (await renew(initial.refresh.token, "different-rotation-id")).status,
          401,
        );
        // In-flight work retains its device identity, even after access rotation and expiry.
        await runtime.run(() => {});
        const rows = JSON.stringify(
          db.prepare("SELECT * FROM agent_mobile_device").all(),
        );
        assert(!rows.includes(rotated.accessToken));
        assert(!rows.includes(rotated.refresh.token));
        assert(!rows.includes(initial.refresh.token));
        await allowMember(false);
        await allowMember(true);
        assert.equal((await renew(rotated.refresh.token)).status, 401);
        await assert.rejects(runtime.run(() => {}));
        // A new personal grant is explicitly revoked using refresh, without a valid bearer.
        await member("auth/sign-in/email", {
          email: "member@example.test",
          password,
        });
        const next = await begin(true);
        await inspect(next.userCode, member);
        await consent(next.userCode, true, member);
        const connected = BrowserLoginPoll.parse(
          (await rootCall("poll", next.deviceCode)).data,
        );
        if (connected.status !== "approved" || !connected.credential.refresh)
          throw Error("not approved");
        db.prepare("UPDATE agent_mobile_device SET access_expires_at=0").run();
        assert.equal(
          (await renew(connected.credential.refresh.token, "unused", "DELETE"))
            .status,
          204,
        );
        assert.equal(
          (await renew(connected.credential.refresh.token)).status,
          401,
        );
      },
    );
    await t.test("parent expiry after approval is rechecked", async () => {
      const c = await begin();
      await inspect(c.userCode);
      await consent(c.userCode);
      const row = db
        .prepare("SELECT grant_json FROM agent_browser_login WHERE digest=?")
        .get(hash(c.deviceCode));
      const grant = JSON.parse(String(row!.grant_json));
      db.prepare("UPDATE session SET expiresAt=? WHERE id=?").run(
        new Date(0).toISOString(),
        grant.session_id,
      );
      assert.equal((await rootCall("poll", c.deviceCode)).status, 401);
    });
    await t.test(
      "unknown polling secrets and cancel requests have a separate bounded budget",
      async () => {
        let limited = false;
        for (let i = 0; i < 121; i++) {
          const result = await rootCall(
            i % 2 ? "poll" : "cancel",
            "R".repeat(43),
          );
          if (result.status === 429) {
            limited = true;
            break;
          }
        }
        assert.equal(limited, true);
      },
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    app.emit("close");
    await identity.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
