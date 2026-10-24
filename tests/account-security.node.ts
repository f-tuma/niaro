import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIdentity } from "../apps/server-identity/service";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { issueAdminKey } from "../apps/server-admin/auth";
import { ServerConfigSchema } from "../apps/reference-server/config";

/**
 * People can get in without SMTP: copyable invitation links with precise
 * reasons, own password change, admin-issued reset links, and the person's
 * own sign-ins with revoke.
 */
test("invitation links, passwords, reset links and own sign-ins", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-account-security-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert(addr && typeof addr !== "string");
  const origin = `http://127.0.0.1:${addr.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST account security",
    listen: { port: addr.port },
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
  const identity = await openIdentity(config);
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
  const db = identity["db"];
  function client(userAgent = "TEST-agent") {
    const jar = new Map<string, string>();
    return async (path: string, body?: unknown) => {
      const r = await fetch(`${origin}/admin/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          "User-Agent": userAgent,
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
  type Client = ReturnType<typeof client>;
  const password = "TEST-owner-password";
  const owner = client();
  const tokenOf = (link: string) => new URL(link).hash.slice(1);
  const signIn = async (c: Client, email: string, pw: string) =>
    (await c("auth/sign-in/email", { email, password: pw })).status;
  // A personal MCP grant as the MCP store writes it (no live server needed).
  const mcpGrant = (userId: string, memberId: string, workspaceId: string) => {
    const id = randomUUID();
    const member = db
      .prepare('SELECT "organizationId" AS o FROM member WHERE id=?')
      .get(memberId)!;
    db.prepare(
      "INSERT INTO agent_mcp_access (id,token_digest,user_id,member_id,organization_id,workspace_id,server_id,label,scopes_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      randomUUID(),
      userId,
      memberId,
      String(member.o),
      workspaceId,
      "TEST-server",
      "TEST desktop",
      '["native.run"]',
      Date.now(),
      Date.now() + 3_600_000,
    );
    return id;
  };
  const mcpRevoked = (id: string) =>
    db.prepare("SELECT revoked_at FROM agent_mcp_access WHERE id=?").get(id)!
      .revoked_at !== null;
  const audit = (action: string) =>
    Number(
      db
        .prepare("SELECT count(*) AS n FROM agent_audit WHERE action=?")
        .get(action)!.n,
    );
  try {
    await owner("api/login", { key });
    await owner("api/identity/bootstrap", {
      name: "TEST Owner",
      email: "owner@example.test",
      password,
      organizationName: "TEST Org",
    });
    assert.equal(await signIn(owner, "owner@example.test", password), 200);
    const organizationId = (await owner("api/identity")).data.organizations[0]
      .id as string;
    await owner("api/identity/command", {
      type: "createWorkspace",
      organizationId,
      name: "TEST Workspace",
    });
    // Setup also created a first workspace named like the organization.
    const workspaceId = (
      await owner(`api/identity/organization?id=${organizationId}`)
    ).data.workspaces.find((w: { name: string }) => w.name === "TEST Workspace")
      .id as string;
    const target = { organizationId, workspaceId };
    const invite = async (email: string) => {
      const sent = await owner("api/identity/invitations", {
        ...target,
        action: "send",
        email,
      });
      assert.equal(sent.status, 200);
      return sent.data as {
        id: string;
        delivery: string;
        link: string;
        expiresAt: number;
      };
    };
    const join = async (c: Client, link: string, name: string, pw: string) =>
      c("api/identity/invitation", {
        token: tokenOf(link),
        accept: true,
        name,
        password: pw,
      });

    await t.test(
      "without SMTP the administrator gets a copyable 48 h link",
      async () => {
        const list = await owner("api/identity/invitations", {
          ...target,
          action: "list",
        });
        assert.equal(list.data.mail, false);
        const sent = await invite("member@example.test");
        assert.equal(sent.delivery, "link");
        assert.match(sent.link, new RegExp(`^${origin}/account/invite#`));
        const hours = (sent.expiresAt - Date.now()) / 3600000;
        assert(hours > 47.9 && hours <= 48);
        // Only the digest is stored.
        assert.equal(
          db
            .prepare(
              "SELECT count(*) AS n FROM agent_workspace_invitation WHERE digest=?",
            )
            .get(tokenOf(sent.link))!.n,
          0,
        );
        const pending = (
          await owner("api/identity/invitations", { ...target, action: "list" })
        ).data.invitations;
        assert.deepEqual(
          pending.map((i: { email: string; delivery: string }) => [
            i.email,
            i.delivery,
          ]),
          [["member@example.test", "link"]],
        );
        assert.equal(audit("invitation.created"), 1);
      },
    );

    await t.test("each unusable invitation says why", async () => {
      const reason = async (token: string) =>
        (await client()("api/identity/invitation", { token })).data.error;
      assert.equal(await reason("x".repeat(43)), "invitation_invalid");
      const replaced = await invite("again@example.test");
      const current = await invite("again@example.test");
      assert.equal(await reason(tokenOf(replaced.link)), "invitation_revoked");
      await owner("api/identity/invitations", {
        ...target,
        action: "revoke",
        id: current.id,
      });
      assert.equal(await reason(tokenOf(current.link)), "invitation_revoked");
      assert.equal(audit("invitation.revoked"), 1);
      const expired = await invite("late@example.test");
      db.prepare(
        "UPDATE agent_workspace_invitation SET expires_at=? WHERE id=?",
      ).run(Date.now() - 1, expired.id);
      assert.equal(await reason(tokenOf(expired.link)), "invitation_expired");
      const used = await invite("used@example.test");
      const person = client();
      assert.equal(
        (await join(person, used.link, "TEST Used", "TEST-used-password"))
          .status,
        200,
      );
      assert.equal(await reason(tokenOf(used.link)), "invitation_used");
      // An existing account must accept with its own sign-in.
      const forOwner = await invite("used@example.test");
      const accepted = await owner("api/identity/invitation", {
        token: tokenOf(forOwner.link),
        accept: true,
      });
      assert.equal(accepted.status, 403);
      assert.equal(accepted.data.error, "invitation_account_mismatch");
    });

    let memberId = "";
    const member = client("Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0");
    const memberPassword = "TEST-member-password";
    await t.test("the invited person joins with the copied link", async () => {
      const sent = await invite("member2@example.test");
      // A copied link says nothing about whether the address has an account.
      const inspected = await client()("api/identity/invitation", {
        token: tokenOf(sent.link),
      });
      assert.equal(inspected.status, 200);
      assert.equal("existing" in inspected.data, false);
      const forOwner = await invite("owner@example.test");
      const ownerView = await client()("api/identity/invitation", {
        token: tokenOf(forOwner.link),
      });
      assert.equal("existing" in ownerView.data, false);
      // Signed in as that account, the page learns it can just accept.
      const signedIn = await owner("api/identity/invitation", {
        token: tokenOf(forOwner.link),
      });
      assert.equal(signedIn.data.existing, true);
      assert.equal(signedIn.data.matching, true);
      assert.equal(
        (await join(member, sent.link, "TEST Member", memberPassword)).status,
        200,
      );
      assert.equal(
        await signIn(member, "member2@example.test", memberPassword),
        200,
      );
      // Nobody proved they read that mailbox, so the address stays unverified.
      assert.equal(
        Number(
          db
            .prepare('SELECT "emailVerified" AS v FROM user WHERE email=?')
            .get("member2@example.test")!.v,
        ),
        0,
      );
      memberId = (
        await owner(`api/identity/organization?id=${organizationId}`)
      ).data.members.find(
        (m: { email: string }) => m.email === "member2@example.test",
      ).id;
    });

    await t.test(
      "a person changes their own password; other browsers sign out",
      async () => {
        const other = client("Other browser");
        assert.equal(
          await signIn(other, "member2@example.test", memberPassword),
          200,
        );
        const userId = (await member("api/identity")).data.user.id as string;
        const grant = mcpGrant(userId, memberId, workspaceId);
        // An outstanding reset link stops working when the person changes it.
        const pendingReset = await owner("api/identity/password-reset", {
          organizationId,
          memberId,
        });
        assert.equal(pendingReset.status, 200);
        const wrong = await member("api/identity/account/password", {
          currentPassword: "not-the-password",
          newPassword: "TEST-member-new-password",
        });
        assert.equal(wrong.status, 403);
        assert.equal(wrong.data.error, "password_incorrect");
        assert.equal(
          (
            await member("api/identity/account/password", {
              currentPassword: memberPassword,
              newPassword: "short",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await member("api/identity/account/password", {
              currentPassword: memberPassword,
              newPassword: "TEST-member-new-password",
            })
          ).status,
          200,
        );
        assert.equal((await member("api/identity")).status, 200);
        assert.equal((await other("api/identity")).status, 401);
        assert.equal(mcpRevoked(grant), true);
        assert.equal(
          (
            await client()("api/identity/account/reset", {
              token: tokenOf(pendingReset.data.link),
            })
          ).data.error,
          "password_reset_invalid",
        );
        assert.equal(
          await signIn(client(), "member2@example.test", memberPassword),
          401,
        );
        assert.equal(
          await signIn(
            client(),
            "member2@example.test",
            "TEST-member-new-password",
          ),
          200,
        );
        assert.equal(audit("password.changed"), 1);
        // Guessing the current password is bounded.
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++)
          statuses.push(
            (
              await member("api/identity/account/password", {
                currentPassword: "still-not-the-password",
                newPassword: "TEST-member-third-password",
              })
            ).status,
          );
        assert.equal(statuses.at(-1), 429);
      },
    );

    await t.test(
      "the person sees and revokes their devices and browsers",
      async () => {
        const userId = (await member("api/identity")).data.user.id as string;
        identity["mobile"].issueApp({
          member_id: memberId,
          organization_id: organizationId,
          workspace_id: workspaceId,
          user_id: userId,
          server_id: "TEST-server",
        });
        const second = client("Second browser");
        await signIn(
          second,
          "member2@example.test",
          "TEST-member-new-password",
        );
        const grant = mcpGrant(userId, memberId, workspaceId);
        const list = await member("api/identity/account/access", {
          action: "list",
        });
        assert.equal(list.status, 200);
        assert.equal(list.data.mcp.length, 1);
        assert.equal(list.data.mcp[0].label, "TEST desktop");
        assert.equal(list.data.mcp[0].workspaceName, "TEST Workspace");
        assert.match(list.data.mcp[0].id, /^[A-Za-z0-9_-]{32}$/);
        // Only the owner of the grant can revoke it.
        assert.equal(
          (
            await owner("api/identity/account/access", {
              action: "revoke",
              id: list.data.mcp[0].id,
            })
          ).status,
          404,
        );
        assert.equal(mcpRevoked(grant), false);
        await member("api/identity/account/access", {
          action: "revoke",
          id: list.data.mcp[0].id,
        });
        assert.equal(mcpRevoked(grant), true);
        assert.equal(list.data.hasPassword, true);
        assert.equal(list.data.limit, 8);
        assert.equal(list.data.devices.length, 1);
        assert.equal(list.data.devices[0].workspaceName, "TEST Workspace");
        assert.match(list.data.devices[0].id, /^[A-Za-z0-9_-]{32}$/);
        const browsers = list.data.browsers as {
          id: string;
          current: boolean;
          userAgent: string;
        }[];
        assert.equal(browsers.filter((b) => b.current).length, 1);
        assert.match(
          browsers.find((b) => b.current)!.userAgent,
          /Firefox\/130/,
        );
        // Nobody else's sign-ins can be addressed.
        assert.equal(
          (
            await owner("api/identity/account/access", {
              action: "revoke",
              id: list.data.devices[0].id,
            })
          ).status,
          404,
        );
        await member("api/identity/account/access", {
          action: "revoke",
          id: list.data.devices[0].id,
        });
        const otherBrowser = browsers.find(
          (b) => !b.current && b.userAgent === "Second browser",
        )!;
        await member("api/identity/account/access", {
          action: "revoke",
          id: otherBrowser.id,
        });
        assert.equal((await second("api/identity")).status, 401);
        const after = (
          await member("api/identity/account/access", { action: "list" })
        ).data;
        assert.equal(after.devices.length, 0);
        assert.equal(after.mcp.length, 0);
        assert(
          !after.browsers.some((b: { id: string }) => b.id === otherBrowser.id),
        );
        assert(audit("session.revoked") >= 2);
      },
    );

    await t.test(
      "an administrator issues a single-use reset link; using it signs out everywhere",
      async () => {
        const forbidden = await member("api/identity/password-reset", {
          organizationId,
          memberId,
        });
        assert.equal(forbidden.status, 403);
        const ownerMemberId = (
          await owner(`api/identity/organization?id=${organizationId}`)
        ).data.members.find(
          (m: { email: string }) => m.email === "owner@example.test",
        ).id;
        assert.equal(
          (
            await owner("api/identity/password-reset", {
              organizationId,
              memberId: ownerMemberId,
            })
          ).data.error,
          "password_reset_forbidden",
        );
        const first = await owner("api/identity/password-reset", {
          organizationId,
          memberId,
        });
        assert.equal(first.status, 200);
        assert.equal(first.data.delivery, "link");
        assert.match(first.data.link, new RegExp(`^${origin}/account/reset#`));
        const issued = await owner("api/identity/password-reset", {
          organizationId,
          memberId,
        });
        const anonymous = client();
        // Only the newest link works.
        assert.equal(
          (
            await anonymous("api/identity/account/reset", {
              token: tokenOf(first.data.link),
            })
          ).data.error,
          "password_reset_invalid",
        );
        const inspected = await anonymous("api/identity/account/reset", {
          token: tokenOf(issued.data.link),
        });
        assert.deepEqual(inspected.data, { email: "member2@example.test" });
        const userId = (await member("api/identity")).data.user.id as string;
        identity["mobile"].issueApp({
          member_id: memberId,
          organization_id: organizationId,
          workspace_id: workspaceId,
          user_id: userId,
          server_id: "TEST-server",
        });
        const grant = mcpGrant(userId, memberId, workspaceId);
        assert.equal(
          (
            await anonymous("api/identity/account/reset", {
              token: tokenOf(issued.data.link),
              password: "TEST-reset-password",
            })
          ).status,
          200,
        );
        assert.equal(mcpRevoked(grant), true);
        assert.equal((await member("api/identity")).status, 401);
        assert.equal(
          Number(
            db
              .prepare(
                "SELECT count(*) AS n FROM agent_mobile_device WHERE user_id=?",
              )
              .get(userId)!.n,
          ),
          0,
        );
        assert.equal(
          (
            await anonymous("api/identity/account/reset", {
              token: tokenOf(issued.data.link),
              password: "TEST-reset-password-2",
            })
          ).data.error,
          "password_reset_used",
        );
        assert.equal(
          await signIn(client(), "member2@example.test", "TEST-reset-password"),
          200,
        );
        // Two here plus the one the password change cancelled.
        assert.equal(audit("password.reset_issued"), 3);
        assert.equal(audit("password.reset_used"), 1);
        const expired = await owner("api/identity/password-reset", {
          organizationId,
          memberId,
        });
        db.prepare("UPDATE agent_password_reset SET expires_at=?").run(
          Date.now() - 1,
        );
        assert.equal(
          (
            await anonymous("api/identity/account/reset", {
              token: tokenOf(expired.data.link),
            })
          ).data.error,
          "password_reset_expired",
        );
      },
    );

    await t.test(
      "re-issuing a link for the same person still counts toward the hourly limit",
      async () => {
        const statuses: number[] = [];
        for (let i = 0; i < 25 && statuses.at(-1) !== 429; i++)
          statuses.push(
            (
              await owner("api/identity/password-reset", {
                organizationId,
                memberId,
              })
            ).status,
          );
        assert.equal(statuses.at(-1), 429);
        assert(statuses.length <= 21);
        // Only the newest link works.
        assert.equal(
          Number(
            db
              .prepare(
                "SELECT count(*) AS n FROM agent_password_reset WHERE used_at IS NULL AND superseded_at IS NULL AND expires_at>?",
              )
              .get(Date.now())!.n,
          ),
          1,
        );
      },
    );

    await t.test(
      "a person in another organization cannot be reset by this one",
      async () => {
        const now = new Date().toISOString(),
          other = randomUUID();
        db.prepare(
          'INSERT INTO organization(id,name,slug,"createdAt") VALUES(?,?,?,?)',
        ).run(other, "TEST Other", "test-other", now);
        const userId = db
          .prepare("SELECT id FROM user WHERE email=?")
          .get("member2@example.test")!.id;
        db.prepare(
          'INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES(?,?,?,?,?)',
        ).run(randomUUID(), other, userId!, "member", now);
        assert.equal(
          (
            await owner("api/identity/password-reset", {
              organizationId,
              memberId,
            })
          ).data.error,
          "password_reset_other_organization",
        );
      },
    );

    // Sign-ins are rate limited per address: these two tests share theirs.
    const person = client("This browser");
    const elsewhere = client("Other browser");
    let userId = "";
    let grant = "";
    await t.test(
      "signing out other browsers keeps this one, devices and MCP access",
      async () => {
        assert.equal(
          await signIn(person, "member2@example.test", "TEST-reset-password"),
          200,
        );
        userId = (await person("api/identity")).data.user.id as string;
        grant = mcpGrant(userId, memberId, workspaceId);
        identity["mobile"].issueApp({
          member_id: memberId,
          organization_id: organizationId,
          workspace_id: workspaceId,
          user_id: userId,
          server_id: "TEST-server",
        });
        await signIn(elsewhere, "member2@example.test", "TEST-reset-password");
        const before = audit("session.revoked");
        // Another site can't sign the person's browsers out.
        const foreign = await fetch(
          `${origin}/admin/api/identity/account/access`,
          {
            method: "POST",
            headers: {
              Origin: "https://evil.example",
              "X-Agent-Admin": "1",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ action: "revokeOthers" }),
          },
        );
        assert.notEqual(foreign.status, 200);
        const response = await person("api/identity/account/access", {
          action: "revokeOthers",
        });
        assert.equal(response.status, 200);
        // The answer is the new list: only this browser is left.
        assert.deepEqual(
          response.data.browsers.map(
            (b: { current: boolean; userAgent: string }) => [
              b.current,
              b.userAgent,
            ],
          ),
          [[true, "This browser"]],
        );
        assert.equal(response.data.devices.length, 1);
        assert.equal(response.data.mcp.length, 1);
        assert.equal((await person("api/identity")).status, 200);
        assert.equal((await elsewhere("api/identity")).status, 401);
        assert.equal(mcpRevoked(grant), false);
        // Nobody else is signed out.
        assert.equal((await owner("api/identity")).status, 200);
        // One row per organization the person belongs to.
        const audited = audit("session.revoked");
        assert(audited > before);
        // Nothing left to sign out: nothing to audit.
        assert.equal(
          (
            await person("api/identity/account/access", {
              action: "revokeOthers",
            })
          ).status,
          200,
        );
        assert.equal(audit("session.revoked"), audited);
      },
    );

    await t.test("sign out everywhere ends this browser too", async () => {
      assert.equal(
        (await person("api/identity/account/access", { action: "revokeAll" }))
          .status,
        200,
      );
      assert.equal((await person("api/identity")).status, 401);
      assert.equal(
        Number(
          db
            .prepare('SELECT count(*) AS n FROM session WHERE "userId"=?')
            .get(userId)!.n,
        ),
        0,
      );
      assert.equal(mcpRevoked(grant), true);
    });

    await t.test("account pages receive the shell", async () => {
      for (const path of ["/account/reset", "/me"]) {
        const r = await fetch(origin + path);
        assert.equal(r.status, 200, path);
        assert.match(await r.text(), /app.js/);
      }
      for (const path of ["/account/other", "/me/x"])
        assert.notEqual(
          (await fetch(origin + path)).headers.get("content-type"),
          "text/html; charset=utf-8",
          path,
        );
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => app.close(() => r()));
    await identity.close();
    rmSync(root, { recursive: true, force: true });
  }
});
