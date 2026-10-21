import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openIdentity } from "../apps/server-identity/service";
import {
  WEB_PER_BROWSER,
  WEB_PER_PERSON,
} from "../apps/server-identity/mobile";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { issueAdminKey } from "../apps/server-admin/auth";
import { ServerConfigSchema } from "../apps/reference-server/config";

test("App PKCE login and invitation-only public onboarding", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-app-login-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert(addr && typeof addr !== "string");
  const origin = `http://127.0.0.1:${addr.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST app",
    listen: { port: addr.port },
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
  // Isolated console assets: the test must not depend on a local admin build.
  const assets = join(root, "assets");
  mkdirSync(assets);
  writeFileSync(
    join(assets, "index.html"),
    '<div id="root"></div><script type="module" src="/admin/app.js"></script>',
  );
  writeFileSync(join(assets, "app.js"), "// TEST console");
  writeFileSync(join(assets, "app.css"), "body {}");
  app = createReferenceServer(config, {}, identity, {
    adminAssetsDirectory: assets,
  });
  const db = new DatabaseSync(join(root, "identity", "identity.sqlite"));
  function client() {
    const jar = new Map<string, string>();
    return async (path: string, body?: unknown) => {
      const r = await fetch(`${origin}/admin/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const c of r.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const i = pair!.indexOf("=");
        jar.set(pair!.slice(0, i), pair!.slice(i + 1));
      }
      return { status: r.status, data: await r.json() };
    };
  }
  const owner = client(),
    member = client(),
    anonymous = client();
  const password = "TEST-invitation-password";
  const request = async (
    action: string,
    input: unknown,
    originHeader?: string,
  ) => {
    const r = await fetch(`${origin}/v1/auth/app/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(originHeader ? { Origin: originHeader } : {}),
      },
      body: JSON.stringify(input),
    });
    return { status: r.status, data: await r.json() };
  };
  const digest = (s: string) => createHash("sha256").update(s).digest("hex");
  try {
    await owner("api/login", { key });
    await owner("api/identity/bootstrap", {
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
    const detail = (
      await owner(`api/identity/organization?id=${organizationId}`)
    ).data;
    const workspaceId = detail.workspaces[0].id;
    const userId = (await owner("api/identity")).data.user.id;
    const target = { organizationId, workspaceId };
    function invite(email: string, expires = Date.now() + 60000) {
      const token = randomBytes(32).toString("base64url");
      db.prepare(
        "INSERT INTO agent_workspace_invitation (id,digest,workspace_id,email,inviter_id,expires_at) VALUES (?,?,?,?,?,?)",
      ).run(
        randomBytes(16).toString("hex"),
        digest(token),
        workspaceId,
        email,
        userId,
        expires,
      );
      return token;
    }
    await t.test(
      "invite requires valid unexpired token; existing accounts cannot be taken over",
      async () => {
        const token = invite("owner@example.test");
        assert.equal(
          (
            await anonymous("api/identity/invitation", {
              token,
              accept: true,
              name: "hijack",
              password,
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await anonymous("api/identity/invitation", {
              token: invite("expired@example.test", Date.now() - 1),
            })
          ).status,
          410,
        );
        assert.equal(
          (
            await anonymous("api/identity/invitation", {
              token: "x".repeat(43),
            })
          ).status,
          410,
        );
      },
    );
    await t.test(
      "new invite creates only a member, grants one workspace and is single-use",
      async () => {
        const token = invite("member@example.test");
        const input = { token, accept: true, name: "TEST Member", password };
        // Joining takes nobody's authority away: running chats and processes
        // pinned to the organization policy epoch keep it.
        const epoch = () =>
          identity["connections"].policyVersion(organizationId);
        const before = epoch();
        assert.equal(
          (await member("api/identity/invitation", input)).status,
          200,
        );
        assert.equal(epoch(), before);
        assert.equal(
          (await member("api/identity/invitation", input)).status,
          410,
        );
        await member("auth/sign-in/email", {
          email: "member@example.test",
          password,
        });
        const state = (await member("api/identity")).data;
        assert.equal(state.organizations[0].role, "member");
        assert.equal(
          (await member(`api/identity/organization?id=${organizationId}`)).data
            .workspaces[0].id,
          workspaceId,
        );
        // Members only learn who they are, for the personal pages.
        const overview = await member("api/overview");
        assert.equal(overview.status, 200);
        assert.equal(overview.data.authentication.console, false);
        assert.equal((await member("api/catalog")).status, 403);
        // The web app's chat credential follows the browser session and never
        // uses a device slot; open tabs keep theirs (the newest dozen per
        // browser session and workspace).
        const web = async () => {
          const issued = await member("api/identity/app/session", target);
          assert.equal(issued.status, 200);
          assert.equal(issued.data.address, `${origin}/v1/${workspaceId}`);
          assert.equal(issued.data.credential.refresh, undefined);
          return issued.data.credential.accessToken as string;
        };
        const snapshot = (token: string) =>
          fetch(`${origin}/v1/${workspaceId}/snapshot`, {
            headers: { Authorization: `Bearer ${token}`, Origin: origin },
          }).then((r) => r.status);
        const first = await web();
        assert.equal(await snapshot(first), 200);
        const second = await web();
        assert.equal(await snapshot(second), 200);
        assert.equal(await snapshot(first), 200);
        const digestOf = (token: string) =>
          createHash("sha256").update(token).digest("hex");
        const row = db
          .prepare("SELECT * FROM agent_mobile_session WHERE digest=?")
          .get(digestOf(second))!;
        // An app sign-in made from the same browser session is not a web
        // credential and is never replaced by one.
        const insert = db.prepare(
          "INSERT INTO agent_mobile_session (digest,session_id,member_id,organization_id,workspace_id,user_id,server_id,expires_at,session_expires_at,web) VALUES (?,?,?,?,?,?,?,?,?,?)",
        );
        const copy = (digest: string, sessionId: unknown, web: number) =>
          insert.run(
            digest,
            String(sessionId),
            String(row.member_id),
            String(row.organization_id),
            String(row.workspace_id),
            String(row.user_id),
            String(row.server_id),
            Number(row.expires_at),
            Number(row.session_expires_at),
            web,
          );
        copy("TEST-app", row.session_id, 0);
        // A dozen tabs keep theirs; the next one replaces the oldest.
        const later: string[] = [];
        for (let i = 2; i < WEB_PER_BROWSER; i++) later.push(await web());
        assert.equal(await snapshot(first), 200);
        later.push(await web());
        assert.equal(await snapshot(first), 401);
        for (const token of [second, ...later])
          assert.equal(await snapshot(token), 200);
        const appRow = () =>
          db
            .prepare("SELECT 1 FROM agent_mobile_session WHERE digest=?")
            .get("TEST-app");
        assert(appRow());
        // Many browser sessions of one person: only the newest 32 web
        // credentials stay; they never count toward the server-wide limit.
        const columns = db
          .prepare("PRAGMA table_info(session)")
          .all()
          .map((column) => String(column.name));
        const cloneSession = db.prepare(
          `INSERT INTO session (${columns.map((c) => `"${c}"`).join(",")}) SELECT ${columns
            .map((c) =>
              c === "id" || c === "token" ? `? AS "${c}"` : `"${c}"`,
            )
            .join(",")} FROM session WHERE id=?`,
        );
        for (let i = 0; i < WEB_PER_PERSON + 4; i++) {
          const id = `TEST-session-${i}`;
          cloneSession.run(
            ...columns.flatMap((c) =>
              c === "id" ? [id] : c === "token" ? [`TEST-token-${i}`] : [],
            ),
            String(row.session_id),
          );
          copy(`TEST-web-${i}`, id, 1);
        }
        const sixth = await web();
        assert.equal(await snapshot(sixth), 200);
        const webRows = Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM agent_mobile_session WHERE user_id=? AND web=1",
            )
            .get(String(row.user_id))!.n,
        );
        assert.equal(webRows, WEB_PER_PERSON);
        assert(appRow());
        db.prepare("DELETE FROM agent_mobile_session WHERE digest=?").run(
          "TEST-app",
        );
        assert.equal(
          (await anonymous("api/identity/app/session", target)).status,
          401,
        );
        assert.equal(
          (
            await member("api/identity/invitations", {
              ...target,
              action: "send",
              email: "other@example.test",
            })
          ).status,
          403,
        );
      },
    );
    const begin = async () => {
      const verifier = randomBytes(32).toString("base64url"),
        state = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const start = await request("start", { challenge, state });
      assert.equal(start.status, 200);
      const url = new URL(start.data.authorizationUrl);
      assert.equal(url.pathname, "/account/login");
      const id = url.hash.slice(1);
      const consent = await member("api/identity/app/consent", {
        id,
        ...target,
      });
      assert.equal(consent.status, 200);
      assert.equal(consent.data.target, "agentclient://auth");
      return { verifier, state, code: consent.data.code };
    };
    await t.test(
      "PKCE/state enforced and code consumed exactly once",
      async () => {
        const proof = await begin();
        assert.equal(
          (await request("exchange", { ...proof, verifier: "x".repeat(43) }))
            .status,
          403,
        );
        assert.equal(
          (await request("exchange", { ...proof, state: "x".repeat(43) }))
            .status,
          403,
        );
        const result = await request("exchange", proof);
        assert.equal(result.status, 200);
        assert(result.data.credential.refresh);
        assert.equal((await request("exchange", proof)).status, 403);
      },
    );
    await t.test("logout invalidates pending authorization", async () => {
      const proof = await begin();
      await member("auth/sign-out", {});
      assert.equal((await request("exchange", proof)).status, 403);
      await member("auth/sign-in/email", {
        email: "member@example.test",
        password,
      });
    });
    await t.test(
      "revocation and removal prevent pending exchange",
      async () => {
        const proof = await begin();
        const m = (
          await owner(`api/identity/organization?id=${organizationId}`)
        ).data.members.find(
          (v: { email: string }) => v.email === "member@example.test",
        );
        const epoch = () =>
          identity["connections"].policyVersion(organizationId);
        const before = epoch();
        await owner("api/identity/command", {
          type: "setWorkspaceMember",
          ...target,
          memberId: m.id,
          allowed: false,
        });
        assert.equal((await request("exchange", proof)).status, 403);
        // Removing access still retires work running with the old authority.
        assert.equal(epoch(), before + 1);
        await owner("api/identity/command", {
          type: "changeRole",
          organizationId,
          memberId: m.id,
          role: "admin",
        });
        assert.equal(epoch(), before + 2);
        await owner("api/identity/command", {
          type: "createWorkspace",
          organizationId,
          name: "TEST second workspace",
        });
        assert.equal(epoch(), before + 2);
        await owner("api/identity/command", {
          type: "removeMember",
          organizationId,
          memberId: m.id,
        });
        assert.equal(epoch(), before + 3);
      },
    );
    await t.test(
      "public pages render without admin session and SMTP missing gives a link",
      async () => {
        // The web app's pages share the shell; anything else stays the API's.
        for (const path of [
          "/account/login",
          "/account/invite",
          "/account/reset",
          "/",
          "/chat",
          "/chat/chat-123",
          "/tasks",
          "/meetings",
          "/meetings/11111111-1111-4111-8111-111111111111",
          "/processes",
          "/processes/design",
          "/processes/TEST-process",
          "/skills",
          "/skills/new",
          "/skills/TEST-skill",
          "/connections",
          "/connections/TEST-service",
          "/search",
          "/me",
        ]) {
          const r = await fetch(origin + path);
          assert.equal(r.status, 200, path);
          assert.match(await r.text(), /app.js/);
        }
        for (const path of [
          "/v1",
          "/chat/a/b",
          "/tasks/x",
          "/meetings/a/b",
          "/processes/a/b",
          "/skills/a/b",
          "/connections/a/b",
          "/me/devices",
          "/search/x",
          "/account/other",
          "/unknown",
        ])
          assert.notEqual(
            (await fetch(origin + path)).headers.get("content-type"),
            "text/html; charset=utf-8",
            path,
          );
        const sent = (
          await owner("api/identity/invitations", {
            ...target,
            action: "send",
            email: "test@example.test",
          })
        ).data;
        assert.equal(sent.delivery, "link");
        assert.match(sent.link, new RegExp(`^${origin}/account/invite#`));
      },
    );
    await t.test(
      "designer deep links and reloads receive only the public SPA shell",
      async () => {
        for (const path of [
          "/admin/services/TEST-service/processes/design?sessionId=TEST-design",
          "/admin/services/TEST-service/processes/design/?processId=TEST-process",
        ]) {
          const response = await fetch(origin + path);
          assert.equal(response.status, 200);
          assert.match(
            response.headers.get("content-type") ?? "",
            /text\/html/,
          );
          assert.match(await response.text(), /app.js/);
        }
        for (const path of [
          "/admin/services/TEST-service/processes/design/unknown",
          "/admin/api/identity/catalog/processes/design?organizationId=TEST-org&workspaceId=TEST-workspace&sessionId=TEST-design",
        ]) {
          const response = await fetch(origin + path);
          assert.equal(response.status, 401);
          assert.doesNotMatch(await response.text(), /app.js/);
        }
      },
    );
    await t.test(
      "process console direct links and reloads serve the shell without exposing private APIs",
      async () => {
        for (const path of [
          "/admin/services/TEST-service/processes/TEST-process",
          "/admin/services/TEST-service/processes/TEST-process/?version=1",
        ]) {
          const response = await fetch(origin + path);
          assert.equal(response.status, 200);
          assert.match(
            response.headers.get("content-type") ?? "",
            /text\/html/,
          );
          assert.match(await response.text(), /app.js/);
        }
        for (const path of [
          "/admin/services/TEST-service/processes/TEST-process/unknown",
          "/admin/services/TEST-service/processes/app.js",
          "/admin/services/TEST-service/processes/TEST%2Fprocess",
          "/admin/api/identity/catalog/processes/versions?organizationId=TEST-org&workspaceId=TEST-workspace&profile=agent-process-versions%2F1&processId=TEST-process",
          "/admin/api/identity/catalog/processes/tests/native/detail?organizationId=TEST-org&workspaceId=TEST-workspace&profile=agent-process-native-tests%2F1&requestId=TEST-request",
        ]) {
          const response = await fetch(origin + path);
          assert.equal(response.status, 401);
          assert.doesNotMatch(await response.text(), /app.js/);
        }
        const post = await fetch(
          origin + "/admin/services/TEST-service/processes/TEST-process",
          { method: "POST" },
        );
        assert.equal(post.status, 403);
        assert.doesNotMatch(await post.text(), /app.js/);
      },
    );
  } finally {
    db.close();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => app.close(() => r()));
    await identity.close();
    rmSync(root, { recursive: true, force: true });
  }
});
