import { seedIdentityFixture } from "./helpers/identity-seed";
import { test } from "node:test";
import assert from "node:assert/strict";
import { request, createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openIdentity } from "../apps/server-identity/service";
import { createAdminHandler } from "../apps/server-admin/http";
import { issueAdminKey } from "../apps/server-admin/auth";
import { ServerConfigSchema } from "../apps/reference-server/config";

const password = "TEST-local-account-password-42";
test("Better Auth HTTP: bootstrap, isolation, live roles, workspace grants, revocation and restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-identity-test-"));
  for (const name of ["index.html", "app.js", "app.css"])
    writeFileSync(join(root, name), "TEST");
  let handler: ReturnType<typeof createAdminHandler>;
  const server = createServer((req, res) => {
    void handler(req, res, []);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST identity",
    listen: { port: address.port },
    dataDirectory: join(root, "workflows"),
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
  let identity = await openIdentity(config);
  handler = createAdminHandler(config, () => [], {
    identity,
    assetsDirectory: root,
  });
  function client() {
    const cookies = new Map<string, string>();
    return async (
      path: string,
      input?: unknown,
      extra?: Record<string, string>,
      method = input === undefined ? "GET" : "POST",
    ) => {
      const response = await fetch(`${origin}/admin/${path}`, {
        method,
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          ...extra,
        },
        body: input ? JSON.stringify(input) : undefined,
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(";");
        const i = pair!.indexOf("=");
        cookies.set(pair!.slice(0, i), pair!.slice(i + 1));
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /SameSite=Strict/i);
      }
      const data = await response.json();
      return { status: response.status, data };
    };
  }
  const operator = client(),
    owner = client(),
    member = client(),
    anonymous = client();
  try {
    const canonical = await fetch(
      `http://localhost:${address.port}/admin/accounts`,
      { redirect: "manual" },
    );
    assert.equal(canonical.status, 302);
    assert.equal(canonical.headers.get("location"), `${origin}/admin/accounts`);
    // An unfinished anonymous upload cannot monopolize the shared identity queue.
    const slow = request(`${origin}/admin/auth/sign-in/email`, {
      method: "POST",
      headers: {
        Origin: origin,
        "X-Agent-Admin": "1",
        "Content-Type": "application/json",
        "Content-Length": "1000",
      },
    });
    slow.on("error", () => undefined);
    slow.write("{");
    await new Promise<void>((resolve) =>
      slow.once("socket", (socket) => socket.once("connect", resolve)),
    );
    try {
      const available = await fetch(`${origin}/admin/api/identity`, {
        signal: AbortSignal.timeout(1000),
      });
      assert.equal(available.status, 401);
    } finally {
      slow.destroy();
    }
    assert.equal((await anonymous("api/identity")).status, 401);
    // A fresh server tells signed-out visitors that owner setup is open.
    assert.deepEqual((await anonymous("api/auth-methods")).data, {
      identity: true,
      setup: true,
    });
    // Open setup still needs the console's own same-origin request.
    for (const extra of [
      { Origin: "https://attacker.example" },
      { "X-Agent-Admin": "0" },
    ] as Record<string, string>[])
      assert.equal(
        (
          await anonymous(
            "api/identity/bootstrap",
            {
              name: "TEST Owner",
              email: "owner@example.test",
              password,
              organizationName: "TEST Alpha",
            },
            extra,
          )
        ).status,
        403,
      );
    assert.equal(
      (
        await anonymous("auth/sign-up/email", {
          name: "TEST",
          email: "bad@example.test",
          password,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await anonymous("auth/organization/create", {
          name: "TEST",
          slug: "test",
        })
      ).status,
      404,
    );
    assert.equal((await operator("api/login", { key })).status, 200);
    assert.equal((await operator("api/identity")).data.needsSetup, true);
    const setup = {
      name: "TEST Owner",
      email: "owner@example.test",
      password,
      organizationName: "TEST Alpha",
    };
    const failureDb = new DatabaseSync(
      join(config.administration!.identity!.directory, "identity.sqlite"),
    );
    failureDb.exec(
      "CREATE TRIGGER test_fail_org BEFORE INSERT ON organization BEGIN SELECT RAISE(ABORT, 'TEST failure'); END;",
    );
    assert.equal((await operator("api/identity/bootstrap", setup)).status, 503);
    assert.equal(
      failureDb.prepare('SELECT count(*) AS count FROM "user"').get()!.count,
      0,
    );
    failureDb.exec("DROP TRIGGER test_fail_org");
    failureDb.close();
    // Without the recovery key, the first of two visitors becomes the owner
    // and lands signed in, with the organization and a first workspace.
    const visitors = [client(), client()];
    const bootstraps = await Promise.all(
      visitors.map((visitor) => visitor("api/identity/bootstrap", setup)),
    );
    assert.deepEqual(bootstraps.map((r) => r.status).sort(), [200, 409]);
    const first = visitors[bootstraps.findIndex((r) => r.status === 200)]!;
    const firstState = (await first("api/identity")).data;
    assert.equal(firstState.needsSetup, false);
    assert.equal(firstState.user.email, setup.email);
    assert.deepEqual(
      firstState.organizations.map((o: { name: string; role: string }) => [
        o.name,
        o.role,
      ]),
      [["TEST Alpha", "owner"]],
    );
    assert.deepEqual(
      (
        await first(
          `api/identity/organization?id=${firstState.organizations[0].id}`,
        )
      ).data.workspaces.map((w: { name: string }) => w.name),
      ["TEST Alpha"],
    );
    assert.equal(
      (await first("api/overview")).data.authentication.current,
      "better-auth",
    );
    // Once an account exists setup is closed, for the recovery key too.
    assert.equal(
      (await anonymous("api/identity/bootstrap", setup)).status,
      409,
    );
    assert.equal((await operator("api/identity/bootstrap", setup)).status, 409);
    assert.deepEqual((await anonymous("api/auth-methods")).data, {
      identity: true,
      setup: false,
    });
    // Setup attempts are rate limited per client address.
    const attempts: number[] = [];
    for (let i = 0; i < 12; i++)
      attempts.push((await anonymous("api/identity/bootstrap", setup)).status);
    assert.equal(attempts.at(-1), 429);
    assert.deepEqual([...new Set(attempts)], [409, 429]);
    assert.equal(
      (await owner("auth/sign-in/email", { email: setup.email, password }))
        .status,
      200,
    );
    const initial = await owner("api/identity");
    const orgId = initial.data.organizations[0].id;
    const detailPath = `api/identity/organization?id=${orgId}`;
    const command = (type: string, rest: object = {}) => ({
      type,
      organizationId: orgId,
      ...rest,
    });
    let detail = (await owner(detailPath)).data;
    const ownerMember = detail.members[0].id;
    assert.equal((await operator(detailPath)).status, 403);
    const overview = (await owner("api/overview")).data;
    assert.equal(overview.authentication.current, "better-auth");
    assert.deepEqual(overview.services, []);
    assert.deepEqual(overview.tools, []);
    assert.equal(
      (
        await owner(
          "api/identity/command",
          command("changeRole", { memberId: ownerMember, role: "member" }),
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await seedIdentityFixture(
          identity,
          command("createAccount", {
            name: "TEST Member",
            email: "member@example.test",
            password,
            role: "member",
          }),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await owner(
          "api/identity/command",
          command("createAccount", {
            name: "TEST Member",
            email: "member@example.test",
            password,
            role: "admin",
          }),
        )
      ).status,
      410,
    );
    assert.equal(
      (
        await member("auth/sign-in/email", {
          email: "member@example.test",
          password,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await owner(
          "api/identity/command",
          command("createWorkspace", { name: "TEST Sales" }),
        )
      ).status,
      200,
    );
    detail = (await owner(detailPath)).data;
    const memberId = detail.members.find(
      (m: { email: string }) => m.email === "member@example.test",
    ).id;
    const workspaceId = detail.workspaces[0].id;
    assert.deepEqual((await member(detailPath)).data.workspaces, []);
    // A member still learns who they are, for the personal pages only.
    const memberOverview = await member("api/overview");
    assert.equal(memberOverview.status, 200);
    assert.equal(memberOverview.data.authentication.console, false);
    assert.equal((await member("api/catalog")).status, 403);
    assert.equal(
      (
        await member(
          "api/identity/command",
          command("createWorkspace", { name: "TEST denied" }),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await seedIdentityFixture(
          identity,
          command("setWorkspaceMember", {
            memberId,
            workspaceId,
            allowed: true,
          }),
        )
      ).status,
      200,
    );
    assert.equal((await member(detailPath)).data.workspaces.length, 1);
    assert.equal(
      (
        await owner(
          "api/identity/command",
          command("setWorkspaceMember", {
            memberId,
            workspaceId,
            allowed: false,
          }),
        )
      ).status,
      200,
    );
    assert.equal((await member(detailPath)).data.workspaces.length, 0);
    // Independent tenant seeded through local test DB, never a public bypass endpoint.
    const database = new DatabaseSync(
      join(config.administration!.identity!.directory, "identity.sqlite"),
    );
    database
      .prepare(
        'INSERT INTO organization (id,name,slug,"createdAt") VALUES (?,?,?,?)',
      )
      .run("test-beta", "TEST Beta", "test-beta", Date.now());
    const foreignUser = detail.members.find(
      (m: { id: string }) => m.id === memberId,
    ).userId;
    database
      .prepare(
        'INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES (?,?,?,?,?)',
      )
      .run("test-beta-owner", "test-beta", foreignUser, "owner", Date.now());
    assert.equal(
      (await owner("api/identity/organization?id=test-beta")).status,
      403,
    );
    assert.equal(
      (await member("api/identity/organization?id=test-beta")).status,
      200,
    );
    assert.equal(
      (
        await member("api/identity/command", {
          type: "setWorkspaceMember",
          organizationId: "test-beta",
          workspaceId,
          memberId: "test-beta-owner",
          allowed: false,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await owner(
          "api/identity/command",
          command("changeRole", { memberId: "test-beta-owner", role: "admin" }),
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await owner(
          "api/identity/command",
          command("changeRole", { memberId, role: "admin" }),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await member(
          "api/identity/command",
          command("createWorkspace", { name: "TEST delegated" }),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await owner(
          "api/identity/command",
          command("changeRole", { memberId, role: "member" }),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await member(
          "api/identity/command",
          command("createWorkspace", { name: "TEST denied after demotion" }),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await owner(
          "api/identity/command",
          command("removeMember", { memberId }),
        )
      ).status,
      200,
    );
    assert.equal((await member(detailPath)).status, 403);
    assert.equal(
      (await member("api/identity/organization?id=test-beta")).status,
      200,
    );
    // Signed cookie survives restart, but deleting its server session invalidates it immediately.
    await identity.close();
    identity = await openIdentity(config);
    handler = createAdminHandler(config, () => [], {
      identity,
      assetsDirectory: root,
    });
    assert.equal((await owner(detailPath)).status, 200);
    database
      .prepare('DELETE FROM session WHERE "userId"=?')
      .run(initial.data.user.id);
    assert.equal((await owner(detailPath)).status, 401);
    assert.equal((await owner("api/overview")).status, 401);
    database.close();
    assert.equal(
      (await member("auth/sign-out", undefined, undefined, "POST")).status,
      200,
    );
    assert.equal((await member("api/identity")).status, 401);
    assert.equal(
      (
        await member("auth/sign-in/email", {
          email: "member@example.test",
          password,
        })
      ).status,
      200,
    );
    assert.equal((await member("api/logout", {})).status, 200);
    assert.equal((await member("api/identity")).status, 401);
    assert.equal(
      (
        await anonymous(
          "auth/sign-in/email",
          { email: setup.email, password },
          { Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      statSync(
        join(config.administration!.identity!.directory, "identity.sqlite"),
      ).mode & 0o077,
      0,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await identity.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("public HTTPS origin behind a loopback proxy pins Host/Origin and uses Secure cookies", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-https-test-"));
  for (const name of ["index.html", "app.js", "app.css"])
    writeFileSync(join(root, name), "TEST");
  let handler: ReturnType<typeof createAdminHandler>;
  const server = createServer((req, res) => {
    void handler(req, res, []);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port,
    baseURL = "https://console.example.test";
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST HTTPS",
    listen: { port },
    dataDirectory: join(root, "workflows"),
    allowedOrigins: [],
    administration: {
      keyFile: join(root, "key"),
      identity: { directory: join(root, "identity"), baseURL },
    },
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  });
  const key = issueAdminKey(config.administration!.keyFile),
    identity = await openIdentity(config);
  handler = createAdminHandler(config, () => [], {
    identity,
    assetsDirectory: root,
  });
  let cookie = "";
  async function call(
    path: string,
    input?: unknown,
    extra: Record<string, string> = {},
  ) {
    const response = await new Promise<Response>((resolve, reject) => {
      const req = request(
        `http://127.0.0.1:${port}/admin/${path}`,
        {
          method: input === undefined ? "GET" : "POST",
          headers: {
            Host: "console.example.test",
            Origin: baseURL,
            "X-Agent-Admin": "1",
            "Content-Type": "application/json",
            Cookie: cookie,
            ...extra,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers))
              for (const item of Array.isArray(v) ? v : [v])
                if (item !== undefined) headers.append(k, item);
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers,
              }),
            );
          });
        },
      );
      req.on("error", reject);
      req.end(input === undefined ? undefined : JSON.stringify(input));
    });
    return response;
  }
  try {
    const login = await call("api/login", { key });
    assert.equal(login.status, 200);
    for (const value of login.headers.getSetCookie())
      assert.match(value, /; Secure/i);
    cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const created = await call("api/identity/bootstrap", {
      name: "TEST Owner",
      email: "test-https@example.test",
      password,
      organizationName: "TEST HTTPS",
    });
    assert.equal(created.status, 200);
    // Setup from the recovery console signs the owner in and ends the
    // recovery session, so the console runs as the owner.
    const handoff = created.headers.getSetCookie();
    assert.ok(
      handoff.some((c) => /session_token=[^;]+;.*Secure/i.test(c)),
      String(handoff),
    );
    assert.ok(handoff.some((c) => /^agent_admin_session=;.*Max-Age=0/.test(c)));
    cookie = "";
    const personal = await call("auth/sign-in/email", {
      email: "test-https@example.test",
      password,
    });
    assert.equal(personal.status, 200);
    assert(personal.headers.getSetCookie().length > 0);
    for (const value of personal.headers.getSetCookie())
      assert.match(value, /; Secure/i);
    // The browser remembers the account for 30 days, not the console's
    // 30-minute recovery-key session.
    const token = personal.headers
      .getSetCookie()
      .find((value) => value.includes("session_token="))!;
    assert.match(token, new RegExp(`Max-Age=${30 * 24 * 60 * 60}`, "i"));
    cookie = personal.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    assert.equal((await call("api/identity")).status, 200);
    assert.equal(
      (
        await call("api/identity", undefined, {
          Host: `127.0.0.1:${port}`,
          "X-Forwarded-Host": "console.example.test",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "api/logout",
          {},
          {
            Origin: "https://attacker.example.test",
            "X-Forwarded-Proto": "https",
          },
        )
      ).status,
      403,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await identity.close();
    rmSync(root, { recursive: true, force: true });
  }
});
