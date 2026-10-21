// API-level pilot journey against a fresh server: first run with the
// recovery key, owner bootstrap, workspace, invitation by link (no SMTP),
// member onboarding and the member's web app API calls.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  assert,
  Client,
  delay,
  expectStatus,
  Report,
  StepFailed,
} from "./lib.mjs";

const J = "api";
const CONVERSATION_PROJECTION = "agent-conversation-projection/1";
const PROCESS_EXECUTION = "agent-process-execution/1";

export function smokeAccounts() {
  const suffix = randomUUID().slice(0, 8);
  return {
    owner: {
      name: "Smoke Owner",
      email: `owner-${suffix}@smoke.test`,
      password: `owner-pass-${suffix}-long`,
    },
    member: {
      name: "Smoke Member",
      email: `member-${suffix}@smoke.test`,
      password: `member-pass-${suffix}-long`,
    },
    organizationName: "Smoke Company",
    workspaceName: "Smoke Workspace",
  };
}

/** Runs the journey; returns what the browser journey needs. */
export async function apiJourney(
  report,
  { base, adminKey, accounts = smokeAccounts() },
) {
  const step = (name, run, options) => report.step(J, name, run, options);
  const anonymous = new Client(base);
  const recovery = new Client(base);
  const owner = new Client(base);
  const invitee = new Client(base);
  const member = new Client(base);
  const ctx = { accounts };

  await step("health: /healthz and /readyz answer ok", async () => {
    for (const path of ["/healthz", "/readyz"])
      assert.deepEqual(expectStatus(await anonymous.get(path), 200, path), {
        status: "ok",
      });
    expectStatus(
      await anonymous.get("/admin/api/overview"),
      401,
      "anonymous overview",
    );
  });

  await step("recovery key login", async () => {
    assert.match(adminKey, /^acadmin_[A-Za-z0-9_-]+$/, "admin key format");
    expectStatus(
      await recovery.post("/admin/api/login", { key: "acadmin_wrong" }),
      401,
      "wrong recovery key",
    );
    expectStatus(
      await recovery.post("/admin/api/login", { key: adminKey }),
      200,
      "login",
    );
    assert.ok(
      recovery.cookies.has("agent_admin_session"),
      "recovery session cookie",
    );
    const state = expectStatus(
      await recovery.get("/admin/api/identity"),
      200,
      "identity",
    );
    assert.equal(state.needsSetup, true, "a fresh volume needs setup");
  });

  await step("bootstrap owner and organization (setup form)", async () => {
    expectStatus(
      await recovery.post("/admin/api/identity/bootstrap", {
        ...accounts.owner,
        organizationName: accounts.organizationName,
      }),
      200,
      "bootstrap",
    );
    const state = expectStatus(
      await recovery.get("/admin/api/identity"),
      200,
      "identity",
    );
    assert.equal(state.needsSetup, false, "setup closed after bootstrap");
    expectStatus(
      await recovery.post("/admin/api/identity/bootstrap", {
        ...accounts.owner,
        email: "second@smoke.test",
        organizationName: "Second",
      }),
      409,
      "second bootstrap",
    );
  });

  await step("owner signs in with email and password", async () => {
    expectStatus(
      await owner.post("/admin/auth/sign-in/email", {
        email: accounts.owner.email,
        password: "definitely-wrong-password",
      }),
      401,
      "wrong password",
    );
    expectStatus(
      await owner.post("/admin/auth/sign-in/email", {
        email: accounts.owner.email,
        password: accounts.owner.password,
      }),
      200,
      "sign-in",
    );
    const state = expectStatus(
      await owner.get("/admin/api/identity"),
      200,
      "identity",
    );
    assert.equal(state.user?.email, accounts.owner.email);
    const organization = state.organizations.find(
      (o) => o.name === accounts.organizationName,
    );
    assert.ok(organization, "owner sees the organization");
    assert.equal(organization.role, "owner");
    ctx.organizationId = organization.id;
  });

  await step(
    "owner overview opens administration (console: true)",
    async () => {
      const overview = expectStatus(
        await owner.get("/admin/api/overview"),
        200,
        "overview",
      );
      assert.equal(overview.authentication.console, true);
      assert.equal(overview.authentication.current, "better-auth");
    },
  );

  await step("owner creates the workspace", async () => {
    const before = expectStatus(
      await owner.get(
        `/admin/api/identity/organization?id=${ctx.organizationId}`,
      ),
      200,
      "organization detail",
    );
    let workspace = before.workspaces.find(
      (w) => w.name === accounts.workspaceName,
    );
    if (!workspace) {
      expectStatus(
        await owner.post("/admin/api/identity/command", {
          type: "createWorkspace",
          organizationId: ctx.organizationId,
          name: accounts.workspaceName,
        }),
        200,
        "createWorkspace",
      );
      const after = expectStatus(
        await owner.get(
          `/admin/api/identity/organization?id=${ctx.organizationId}`,
        ),
        200,
        "organization detail",
      );
      workspace = after.workspaces.find(
        (w) => w.name === accounts.workspaceName,
      );
    }
    assert.ok(workspace, "workspace listed");
    assert.equal(before.canManageMembers, true);
    ctx.workspaceId = workspace.id;
  });

  await step("owner invites a member by link (no SMTP)", async () => {
    const target = {
      organizationId: ctx.organizationId,
      workspaceId: ctx.workspaceId,
    };
    const sent = expectStatus(
      await owner.post("/admin/api/identity/invitations", {
        ...target,
        action: "send",
        email: accounts.member.email,
      }),
      200,
      "send invitation",
    );
    assert.equal(
      sent.delivery,
      "link",
      "without SMTP the invitation is a link",
    );
    assert.ok(
      sent.link.startsWith(`${base}/account/invite#`),
      `link ${sent.link}`,
    );
    ctx.inviteToken = sent.link.split("#")[1];
    ctx.inviteLink = sent.link;
    const list = expectStatus(
      await owner.post("/admin/api/identity/invitations", {
        ...target,
        action: "list",
      }),
      200,
      "list invitations",
    );
    assert.equal(list.mail, false);
    assert.ok(list.invitations.some((i) => i.email === accounts.member.email));
  });

  await step("invitation page loads and inspects the link", async () => {
    const page = await invitee.get("/account/invite", {
      headers: {
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Site": "none",
      },
    });
    expectStatus(page, 200, "/account/invite");
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const inspected = expectStatus(
      await invitee.post("/admin/api/identity/invitation", {
        token: ctx.inviteToken,
      }),
      200,
      "inspect invitation",
    );
    assert.equal(inspected.email, accounts.member.email);
    assert.equal(inspected.workspace, accounts.workspaceName);
    // A link-mode invitation doesn't reveal whether the email has an account.
    assert.equal("existing" in inspected, false);
  });

  await step("member accepts with a new password", async () => {
    expectStatus(
      await invitee.post("/admin/api/identity/invitation", {
        token: ctx.inviteToken,
        accept: true,
        name: accounts.member.name,
        password: accounts.member.password,
      }),
      200,
      "accept",
    );
    const reused = await invitee.post("/admin/api/identity/invitation", {
      token: ctx.inviteToken,
      accept: true,
      name: accounts.member.name,
      password: accounts.member.password,
    });
    assert.equal(
      reused.json?.error,
      "invitation_used",
      `reuse: ${reused.status} ${reused.text}`,
    );
  });

  await step("member signs in", async () => {
    expectStatus(
      await member.post("/admin/auth/sign-in/email", {
        email: accounts.member.email,
        password: accounts.member.password,
      }),
      200,
      "member sign-in",
    );
    const state = expectStatus(
      await member.get("/admin/api/identity"),
      200,
      "identity",
    );
    assert.equal(state.user?.email, accounts.member.email);
    const organization = state.organizations.find(
      (o) => o.id === ctx.organizationId,
    );
    assert.equal(organization?.role, "member");
  });

  await step(
    "member organization detail shows only the workspace and self",
    async () => {
      const detail = expectStatus(
        await member.get(
          `/admin/api/identity/organization?id=${ctx.organizationId}`,
        ),
        200,
        "organization detail",
      );
      assert.deepEqual(
        detail.workspaces.map((w) => w.id),
        [ctx.workspaceId],
      );
      assert.equal(detail.members.length, 1);
      assert.equal(detail.members[0].email, accounts.member.email);
      assert.equal(detail.canManageMembers, false);
      assert.equal(detail.canManageWorkspaces, false);
    },
  );

  await step(
    "member is refused administration APIs",
    async () => {
      const overview = expectStatus(
        await member.get("/admin/api/overview"),
        200,
        "overview",
      );
      assert.equal(
        overview.authentication.console,
        false,
        "member overview console:false",
      );
      assert.deepEqual(overview.services, []);
      assert.deepEqual(overview.tools, []);
      for (const path of ["/admin/api/catalog", "/admin/api/services"])
        expectStatus(await member.get(path), 403, `member GET ${path}`);
      expectStatus(
        await member.post("/admin/api/identity/invitations", {
          organizationId: ctx.organizationId,
          workspaceId: ctx.workspaceId,
          action: "list",
        }),
        403,
        "member invitations list",
      );
      expectStatus(
        await member.post("/admin/api/identity/command", {
          type: "createWorkspace",
          organizationId: ctx.organizationId,
          name: "Member workspace",
        }),
        403,
        "member createWorkspace",
      );
      expectStatus(
        await member.get(
          `/admin/api/identity/audit?organizationId=${ctx.organizationId}`,
        ),
        403,
        "member audit",
      );
    },
    { soft: true },
  );

  await step(
    "member gets the web app chat credential (app/session)",
    async () => {
      const issued = expectStatus(
        await member.post("/admin/api/identity/app/session", {
          organizationId: ctx.organizationId,
          workspaceId: ctx.workspaceId,
        }),
        200,
        "app/session",
      );
      assert.equal(issued.address, `${base}/v1/${ctx.workspaceId}`);
      assert.equal(typeof issued.credential?.accessToken, "string");
      ctx.bearer = issued.credential.accessToken;
      ctx.app = `/v1/${ctx.workspaceId}`;
    },
  );

  const app = (path, options) =>
    member.request(options?.body ? "POST" : "GET", `${ctx.app}/${path}`, {
      ...options,
      bearer: ctx.bearer,
    });
  const appPath = (path) =>
    `${path}${path.includes("?") ? "&" : "?"}chats=${CONVERSATION_PROJECTION}`;

  await step("app snapshot", async () => {
    expectStatus(
      await member.get(`${ctx.app}/snapshot`),
      401,
      "snapshot without bearer",
    );
    const snapshot = expectStatus(
      await app(appPath("snapshot")),
      200,
      "snapshot",
    );
    assert.ok(Array.isArray(snapshot.conversations));
    ctx.snapshot = snapshot;
  });

  await step(
    "chat: conversation.create + message.send reach a terminal outcome",
    async () => {
      const conversationId = `chat-smoke-${randomUUID()}`;
      const createId = randomUUID();
      const created = await app(appPath("commands"), {
        body: {
          type: "conversation.create",
          commandId: createId,
          idempotencyKey: createId,
          conversationId,
        },
      });
      assert.equal(
        created.status,
        202,
        `conversation.create: ${created.status} ${created.text.slice(0, 300)}`,
      );
      assert.notEqual(created.json.status, "rejected");
      const sendId = randomUUID();
      const sent = await app(appPath("commands"), {
        body: {
          type: "message.send",
          commandId: sendId,
          idempotencyKey: sendId,
          conversationId,
          text: "Ahoj, tohle je smoke test. Odpověz jednou větou.",
          language: "cs",
          timeZone: "Europe/Prague",
        },
        timeout: 180_000,
      });
      // 202 accepted with a reply or a settled refusal; 503 only for a model error code.
      assert.ok(
        [202, 422, 503].includes(sent.status),
        `message.send: ${sent.status} ${sent.text.slice(0, 300)}`,
      );
      // Poll until nothing for this chat is pending any more.
      let conversation, snapshot;
      for (let i = 0; i < 60; i++) {
        snapshot = expectStatus(
          await app(
            appPath(
              `snapshot?conversationId=${encodeURIComponent(conversationId)}`,
            ),
          ),
          200,
          "snapshot",
        );
        conversation = snapshot.conversations.find(
          (c) => c.id === conversationId,
        );
        const pending = (snapshot.workItems ?? []).filter(
          (w) =>
            w.conversationId === conversationId &&
            ["queued", "running", "pending"].includes(w.status),
        );
        const user =
          conversation?.messages?.findIndex((m) => m.role === "user") ?? -1;
        const reply = conversation?.messages
          ?.slice(user + 1)
          .find((m) => m.role !== "user");
        if (user >= 0 && reply && !pending.length) break;
        conversation = undefined;
        await delay(1000);
      }
      assert.ok(
        conversation,
        `chat did not settle: ${JSON.stringify(snapshot)?.slice(0, 800)}`,
      );
      const reply = conversation.messages
        .filter((m) => m.role !== "user")
        .at(-1);
      ctx.chat = {
        conversationId,
        httpStatus: sent.status,
        commandStatus: sent.json?.status,
        reply: String(reply.text ?? "").slice(0, 160),
      };
    },
  );

  await step("human tasks list", async () => {
    const page = expectStatus(
      await app("human-tasks?tab=open"),
      200,
      "human-tasks",
    );
    assert.ok(Array.isArray(page.tasks));
    assert.equal(page.scope?.workspaceId ?? ctx.workspaceId, ctx.workspaceId);
  });

  await step("processes start inventory", async () => {
    const inventory = expectStatus(
      await app(`processes?profile=${encodeURIComponent(PROCESS_EXECUTION)}`),
      200,
      "processes",
    );
    assert.ok(inventory && typeof inventory === "object");
    ctx.processes = inventory;
  });

  await step("hub view with the built-in tasks item", async () => {
    const hub = expectStatus(await app("hub?language=cs"), 200, "hub");
    assert.ok(Array.isArray(hub.items));
    assert.ok(
      hub.items.some((item) => item.kind === "tasks"),
      `built-in tasks item: ${JSON.stringify(hub.items).slice(0, 300)}`,
    );
    assert.ok(hub.tasks && typeof hub.tasks.open === "number");
  });

  await step(
    "typed hub widget (agent-hub/3): add a built-in, read it, remove it",
    async () => {
      const v3 = "hub?language=cs&profile=" + encodeURIComponent("agent-hub/3");
      const added = expectStatus(
        await app(v3, {
          body: {
            profile: "agent-hub/3",
            type: "add",
            kind: "widget",
            widget: { type: "meetings" },
          },
        }),
        200,
        "hub add widget",
      );
      assert.equal(added.profile, "agent-hub/3");
      const widget = added.items.find((item) => item.kind === "widget");
      assert.ok(
        widget,
        `typed widget: ${JSON.stringify(added.items).slice(0, 300)}`,
      );
      assert.equal(widget.widget.type, "meetings");
      assert.ok(Array.isArray(widget.widget.data?.meetings));
      // Older profiles keep answering without it.
      const v1 = expectStatus(await app("hub?language=cs"), 200, "hub v1");
      assert.ok(!v1.items.some((item) => item.id === widget.id));
      const removed = expectStatus(
        await app(v3, {
          body: { profile: "agent-hub/3", type: "remove", itemId: widget.id },
        }),
        200,
        "hub remove widget",
      );
      assert.ok(!removed.items.some((item) => item.id === widget.id));
    },
  );

  await step("personal sign-ins (connections) list", async () => {
    const list = expectStatus(
      await member.post("/admin/api/identity/catalog/oauth/list", {
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
      }),
      200,
      "catalog/oauth/list",
    );
    assert.ok(list && typeof list === "object");
  });

  await step("account access list (devices and sessions)", async () => {
    const access = expectStatus(
      await member.post("/admin/api/identity/account/access", {
        action: "list",
      }),
      200,
      "account/access",
    );
    assert.ok(access && typeof access === "object");
    ctx.access = access;
  });

  await step("member web pages are served", async () => {
    for (const path of [
      "/",
      "/tasks",
      "/processes",
      "/connections",
      "/me",
      "/admin/",
    ]) {
      const page = await member.get(path, {
        headers: {
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Site": "none",
        },
      });
      expectStatus(page, 200, path);
      assert.match(page.headers.get("content-type") ?? "", /text\/html/, path);
    }
  });

  return ctx;
}

// Standalone: node scripts/smoke/api-journey.mjs <base URL> <admin key>
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [base, adminKey] = process.argv.slice(2);
  const report = new Report();
  try {
    const ctx = await apiJourney(report, { base, adminKey });
    console.log(JSON.stringify({ chat: ctx.chat }, null, 2));
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error;
  }
  console.log(report.summary());
  process.exitCode = report.failed ? 1 : 0;
}
