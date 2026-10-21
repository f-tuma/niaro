import { seedIdentityFixture } from "./helpers/identity-seed";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openIdentity } from "../apps/server-identity/service";
import {
  createReferenceServer,
  type ServerAdapters,
} from "../apps/reference-server/runtime";
import { issueAdminKey } from "../apps/server-admin/auth";
import { ServerConfigSchema } from "../apps/reference-server/config";
import {
  messageCommand,
  proposalDecision,
} from "../packages/client-core/commands";
import {
  CredentialSchema,
  SnapshotSchema,
  AUTH_PROFILE,
  PROFILE,
  type Credential,
} from "../packages/protocol";
import {
  CalendarCollectionUrl,
  WorkspaceCalendarSchema,
} from "../packages/protocol/workspace-calendar";

const password = "TEST-calendar-password-only-2026";
const collection = "https://calendar.example.test/test/one/";
function hold() {
  let release!: () => void, enter!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    enter = r;
  });
  return { release, enter, wait, started };
}
async function until<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
): Promise<T> {
  const end = Date.now() + 12000;
  do {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 40));
  } while (Date.now() < end);
  throw Error("TEST timed out waiting for calendar result");
}
test("Workspace calendar: permissions, approved writes and recovery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-workspace-calendar-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST Calendar",
    listen: { port: address.port },
    dataDirectory: join(root, "workflow"),
    allowedOrigins: [],
    administration: {
      keyFile: join(root, "key"),
      identity: {
        directory: join(root, "identity"),
        baseURL: origin,
        calendarCollections: [
          collection,
          "https://calendar.example.test/test/two/",
        ],
      },
    },
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  });
  const key = issueAdminKey(config.administration!.keyFile);
  const events = new Map<string, string>();
  const calls: { method: string; url: string }[] = [];
  let gate: ReturnType<typeof hold> | undefined;
  let gateMethod = "GET",
    losePut = false,
    expectedPassword = password;
  const transport: typeof fetch = async (input, init) => {
    const url = String(input),
      method = init?.method ?? "GET";
    assert(url.startsWith(collection));
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      `Basic ${Buffer.from(`test:${expectedPassword}`).toString("base64")}`,
    );
    assert.equal(init?.redirect, "error");
    calls.push({ method, url });
    let result: Response;
    if (method === "PUT") {
      assert.equal(new Headers(init?.headers).get("If-None-Match"), "*");
      assert(!events.has(url), "Never overwrite a previously written event");
      const body = String(init?.body);
      assert(!/^(ATTENDEE|ORGANIZER|METHOD)[:;]/m.test(body));
      events.set(url, body);
      if (losePut) {
        losePut = false;
        throw Error("TEST lost PUT response");
      }
      result = new Response(null, { status: 201 });
    } else {
      assert.equal(method, "GET");
      result = events.has(url)
        ? new Response(events.get(url), {
            status: 200,
            headers: { etag: '"test-etag"' },
          })
        : new Response(null, { status: 404 });
    }
    if (gate && method === gateMethod) {
      gate.enter();
      await gate.wait;
    }
    return result;
  };
  let sequence = 0;
  const adapters: ServerAdapters = {
    aiProfiles: {
      models: [
        {
          id: "test",
          label: "TEST meeting",
          provider: "custom",
          adapter: {
            timeZone: "UTC",
            async decide() {
              return {
                kind: "meeting" as const,
                contactId: "peter-novak",
                title: `TEST Meeting ${++sequence}`,
                localStart: new Date(Date.now() + 2 * 86400000)
                  .toISOString()
                  .slice(0, 16),
                durationMinutes: 30,
                reply: null,
              };
            },
          },
        },
      ],
      voices: [],
    },
  };
  let identity = await openIdentity(config, { calendarTransport: transport });
  app = createReferenceServer(config, adapters, identity);
  const db = new DatabaseSync(join(root, "identity", "identity.sqlite"));
  function client() {
    const cookies = new Map<string, string>();
    return async (path: string, input?: unknown) => {
      const res = await fetch(origin + "/admin/" + path, {
        method: input === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(5000),
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      for (const c of res.headers.getSetCookie()) {
        const pair = c.split(";")[0]!,
          i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return { status: res.status, data: await res.json() };
    };
  }
  const owner = client(),
    admin = client(),
    member = client(),
    operator = client();
  async function mobile(c: Credential, path: string, input?: unknown) {
    const res = await fetch(`${origin}/v1/${c.scope.workspaceId}/${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${c.accessToken}`,
        "Content-Type": "application/json",
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: res.status, data: await res.json() };
  }
  const restart = async () => {
    app.emit("close");
    await identity.close();
    identity = await openIdentity(config, { calendarTransport: transport });
    app = createReferenceServer(config, adapters, identity);
  };
  try {
    assert.equal((await operator("api/login", { key })).status, 200);
    assert.equal(
      (
        await operator("api/identity/bootstrap", {
          name: "TEST Owner",
          email: "owner@example.test",
          password,
          organizationName: "TEST Calendar",
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
    const command = (values: object) =>
      owner("api/identity/command", { organizationId, ...values });
    for (const name of ["TEST One", "TEST Two"])
      assert.equal(
        (await command({ type: "createWorkspace", name })).status,
        200,
      );
    for (const role of ["admin", "member"])
      assert.equal(
        (
          await seedIdentityFixture(identity, {
            organizationId,
            ...{
              type: "createAccount",
              name: `TEST ${role}`,
              email: `${role}@example.test`,
              password,
              role,
            },
          })
        ).status,
        200,
      );
    const detail = (
      await owner(`api/identity/organization?id=${organizationId}`)
    ).data;
    const workspaceId = detail.workspaces[0].id,
      secondId = detail.workspaces[1].id;
    const memberId = detail.members.find((m: any) => m.role === "member").id;
    const adminId = detail.members.find((m: any) => m.role === "admin").id;
    const target = { organizationId, workspaceId };
    for (const [who, email] of [
      [admin, "admin@example.test"],
      [member, "member@example.test"],
    ] as const)
      await who("auth/sign-in/email", { email, password });
    assert.equal(
      (
        await seedIdentityFixture(identity, {
          organizationId,
          ...{
            type: "setWorkspaceMember",
            workspaceId,
            memberId,
            allowed: true,
          },
        })
      ).status,
      200,
    );
    const path = `api/identity/calendar?${new URLSearchParams(target)}`;
    const inventory = async () =>
      WorkspaceCalendarSchema.parse((await owner(path)).data);
    const post = (values: object, who = owner) =>
      who("api/identity/calendar", { ...target, ...values });
    const create = () =>
      post({
        type: "create",
        name: "TEST Calendar",
        collectionUrl: collection,
        username: "test",
        password,
      });
    const update = async (values: object, who = owner) => {
      const row = (await inventory()).calendar!;
      return post(
        { calendarId: row.id, revision: row.revision, ...values },
        who,
      );
    };
    const configure = (
      enabled: boolean,
      roles = ["owner", "admin", "member"],
    ) => update({ type: "configure", enabled, roles });
    const pair = async (who = owner, id = workspaceId) => {
      const issued = await who("api/identity/mobile/pairing", {
        organizationId,
        workspaceId: id,
      });
      assert.equal(issued.status, 200);
      const res = await fetch(`${origin}/v1/${id}/auth/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authProfile: AUTH_PROFILE,
          profile: PROFILE,
          code: issued.data.code,
        }),
      });
      assert.equal(res.status, 200);
      return CredentialSchema.parse(await res.json());
    };
    const credential = await pair();
    const snapshot = async (c = credential) =>
      SnapshotSchema.parse((await mobile(c, "snapshot")).data);
    const prepare = async (c = credential) => {
      const result = await mobile(
        c,
        "commands",
        messageCommand("TEST prepare a new meeting", "en", randomUUID()),
      );
      assert.equal(result.status, 202, JSON.stringify(result.data));
      return (
        await until(
          () => snapshot(c),
          (s) =>
            s.actionProposals.some((p) => p.status === "awaiting_approval"),
        )
      ).actionProposals.find((p) => p.status === "awaiting_approval")!;
    };
    const approve = async (c = credential) => {
      const p = await prepare(c);
      const cmd = proposalDecision(p, "approve", randomUUID());
      const result = await mobile(c, "commands", cmd);
      assert.equal(result.status, 202, JSON.stringify(result.data));
      return {
        p,
        cmd,
        id: SnapshotSchema.parse(result.data.snapshot).operations.find(
          (o) => o.proposalId === p.id,
        )!.id,
      };
    };
    const outcome = (id: string, status = "succeeded", c = credential) =>
      until(
        () => snapshot(c),
        (s) => s.operations.some((o) => o.id === id && o.status === status),
      );
    await t.test(
      "strict input, default deny, role isolation, encrypted credentials and transactional audit",
      async () => {
        for (const url of [
          "",
          "not a url",
          "http://example.test/calendar/",
          "https://a.test/x/../y/",
          "https://a.test/%61/",
          "https://a.test/c/?x=1",
        ])
          assert.equal(CalendarCollectionUrl.safeParse(url).success, false);
        assert.equal((await inventory()).calendar, null);
        for (const who of [member, operator])
          assert.equal(
            (
              await post(
                {
                  type: "create",
                  name: "TEST",
                  collectionUrl: collection,
                  username: "test",
                  password,
                },
                who,
              )
            ).status,
            403,
          );
        for (const collectionUrl of ["", "not a url"])
          assert.equal(
            (
              await post({
                type: "create",
                name: "TEST",
                collectionUrl,
                username: "test",
                password,
              })
            ).status,
            400,
          );
        assert.equal(
          (
            await post({
              type: "create",
              name: "TEST",
              collectionUrl: "https://unlisted.test/cal/",
              username: "test",
              password,
            })
          ).status,
          403,
        );
        assert.equal((await create()).status, 200);
        let view = await inventory();
        assert.equal(view.calendar!.enabled, false);
        assert.deepEqual(view.calendar!.roles, []);
        assert.equal((await member(path)).data.calendar, null);
        assert(!JSON.stringify(view).includes(password));
        assert(!JSON.stringify(view).includes('"username"'));
        assert(
          !String(
            db
              .prepare(
                "SELECT secret FROM agent_workspace_calendar WHERE workspace_id=?",
              )
              .get(workspaceId)!.secret,
          ).includes(password),
        );
        const stale = {
          type: "configure",
          calendarId: view.calendar!.id,
          revision: view.calendar!.revision,
          enabled: true,
          roles: ["owner"],
        };
        assert.equal(
          (await post({ ...stale, organizationId: "other-org" })).status,
          403,
        );
        assert.equal(
          (await post({ ...stale, workspaceId: secondId })).status,
          409,
        );
        assert.equal((await post({ ...stale, unexpected: true })).status, 400);
        assert.equal((await post(stale, admin)).status, 200);
        assert.equal((await post(stale)).status, 409);
        assert.equal(
          (
            await update(
              { type: "configure", enabled: true, roles: ["member"] },
              member,
            )
          ).status,
          403,
        );
        view = await inventory();
        db.exec(
          "CREATE TRIGGER calendar_audit_failure BEFORE INSERT ON agent_audit WHEN NEW.action='calendar.configured' BEGIN SELECT RAISE(ABORT,'TEST failure'); END",
        );
        try {
          assert.equal((await configure(false)).status, 503);
          assert.deepEqual(await inventory(), view);
        } finally {
          db.exec("DROP TRIGGER calendar_audit_failure");
        }
        assert.equal(
          (
            await post({
              type: "create",
              workspaceId: secondId,
              name: "TEST duplicate",
              collectionUrl: collection,
              username: "test",
              password,
            })
          ).status,
          409,
        );
        assert.equal(calls.length, 0);
        await configure(true, ["member"]);
        assert.equal((await inventory()).calendar!.canCreate, false); // No owner bypass.
        await configure(true);
        assert.equal((await member(path)).data.calendar.canCreate, true);
        assert.deepEqual((await member(path)).data.calendar.roles, []);
        assert.deepEqual((await member(path)).data.allowedCollections, []);
        assert.equal(
          (
            await owner("api/identity/ai", {
              ...target,
              revision: 0,
              selection: { modelId: "test", voiceId: null },
            })
          ).status,
          200,
        );
      },
    );
    await t.test(
      "an approved chat proposal writes once, verifies the event and survives replay",
      async () => {
        const before = calls.length;
        const job = await approve();
        assert.equal(calls.length, before);
        await outcome(job.id);
        assert.deepEqual(
          calls.slice(before).map((c) => c.method),
          ["GET", "PUT", "GET"],
        );
        assert.equal(
          (await mobile(credential, "commands", job.cmd)).status,
          202,
        );
        assert.equal(calls.length, before + 3);
        assert.equal(
          (await mobile(await pair(owner, secondId), "server")).data
            .configuredServices.calendar,
          "simulated",
        );
        const audit = (
          await owner(
            `api/identity/audit?organizationId=${organizationId}&category=tools`,
          )
        ).data.entries;
        assert(
          audit.some(
            (e: any) =>
              e.action === "calendar.executed" &&
              e.outcome === "succeeded" &&
              e.source === "chat",
          ),
        );
        assert(!JSON.stringify(audit).includes(password));
        assert(!JSON.stringify(audit).includes("BEGIN:VCALENDAR"));
      },
    );
    await t.test(
      "configuration changes reject pending approval and stale forms cannot mutate a replacement",
      async () => {
        const p = await prepare();
        const old = (await inventory()).calendar!;
        await configure(false);
        await configure(true);
        const rejected = await mobile(
          credential,
          "commands",
          proposalDecision(p, "approve", randomUUID()),
        );
        assert.equal(rejected.data.code, "integration_unavailable");
        await mobile(
          credential,
          "commands",
          proposalDecision(p, "reject", randomUUID()),
        );
        await update({ type: "remove" });
        await create();
        for (const command of [
          { type: "configure", enabled: true, roles: ["owner"] },
          { type: "rotate", username: "test", password },
          { type: "remove" },
        ]) {
          assert.equal(
            (await post({ ...command, calendarId: old.id, revision: 1 }))
              .status,
            409,
          );
        }
        await configure(true);
      },
    );
    await t.test(
      "revocation during preflight blocks PUT even after permissions are restored",
      async () => {
        gate = hold();
        gateMethod = "GET";
        try {
          const before = calls.length,
            job = await approve();
          await gate.started;
          await configure(false);
          await configure(true);
          gate.release();
          const s = await outcome(job.id, "result_unknown");
          assert.equal(
            s.operations.find((o) => o.id === job.id)!.error,
            "configuration_changed",
          );
          assert.deepEqual(
            calls.slice(before).map((c) => c.method),
            ["GET"],
          );
        } finally {
          gate?.release();
          gate = undefined;
        }
      },
    );
    await t.test(
      "revocation after PUT remains unconfirmed; never reports a cancelled write as successful",
      async () => {
        gate = hold();
        gateMethod = "PUT";
        try {
          const before = calls.length,
            count = events.size,
            job = await approve();
          await gate.started;
          await update({
            type: "rotate",
            username: "test",
            password: password + "-rotated",
          });
          expectedPassword = password + "-rotated";
          gate.release();
          await outcome(job.id, "result_unknown");
          assert.equal(events.size, count + 1);
          assert.deepEqual(
            calls.slice(before).map((c) => c.method),
            ["GET", "PUT"],
          );
          const audit = (
            await owner(
              `api/identity/audit?organizationId=${organizationId}&category=tools`,
            )
          ).data.entries;
          assert(
            audit.some(
              (e: any) =>
                e.action === "calendar.executed" &&
                e.outcome === "unknown" &&
                e.details.reason === "access_changed",
            ),
          );
        } finally {
          gate?.release();
          gate = undefined;
        }
      },
    );
    await t.test(
      "lost PUT response reconciles after restart and unrelated organization changes",
      async () => {
        const before = calls.length,
          count = events.size;
        losePut = true;
        const job = await approve();
        await outcome(job.id, "result_unknown");
        assert.equal(events.size, count + 1);
        assert.equal(
          (await command({ type: "createWorkspace", name: "TEST Unrelated" }))
            .status,
          200,
        );
        assert.equal(
          (
            await seedIdentityFixture(identity, {
              organizationId,
              ...{
                type: "setWorkspaceMember",
                workspaceId: secondId,
                memberId,
                allowed: true,
              },
            })
          ).status,
          200,
        );
        await restart();
        await outcome(job.id);
        assert.deepEqual(
          calls.slice(before).map((c) => c.method),
          ["GET", "PUT", "GET"],
        );
        assert.equal(events.size, count + 1);
      },
    );
    await t.test(
      "member revoke and restore permanently invalidates that member's approved attempt",
      async () => {
        const c = await pair(member);
        gate = hold();
        gateMethod = "GET";
        try {
          const before = calls.length,
            job = await approve(c);
          await gate.started;
          await command({
            type: "setWorkspaceMember",
            workspaceId,
            memberId,
            allowed: false,
          });
          await seedIdentityFixture(identity, {
            organizationId,
            ...{
              type: "setWorkspaceMember",
              workspaceId,
              memberId,
              allowed: true,
            },
          });
          const fresh = await pair(member);
          gate.release();
          await outcome(job.id, "result_unknown", fresh);
          assert.deepEqual(
            calls.slice(before).map((c) => c.method),
            ["GET"],
          );
          assert.equal((await mobile(c, "snapshot")).status, 401);
        } finally {
          gate?.release();
          gate = undefined;
        }
        const adminCredential = await pair(admin),
          beforeTarget = identity.calendarTarget(adminCredential.scope);
        await command({
          type: "changeRole",
          memberId: adminId,
          role: "member",
        });
        assert.equal(identity.calendarTarget(adminCredential.scope), undefined);
        await command({ type: "changeRole", memberId: adminId, role: "admin" });
        assert.notDeepEqual(
          identity.calendarTarget(adminCredential.scope),
          beforeTarget,
        );
        await command({ type: "removeMember", memberId: adminId });
        assert.equal(identity.calendarTarget(adminCredential.scope), undefined);
      },
    );
    await t.test(
      "operator removal of allowed collection takes effect after restart",
      async () => {
        config.administration!.identity!.calendarCollections = [];
        await restart();
        assert.equal((await inventory()).calendar!.state, "unavailable");
        assert.equal((await configure(true)).status, 403);
        assert.equal((await member(path)).data.calendar, null);
        assert.equal(
          (await mobile(credential, "server")).data.configuredServices.calendar,
          "simulated",
        );
      },
    );
  } finally {
    gate?.release();
    app.emit("close");
    await identity.close();
    db.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
