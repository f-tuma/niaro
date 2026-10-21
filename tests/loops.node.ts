import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { LoopsStore, loopText } from "../apps/server-identity/loops";
import {
  newLoopTrace,
  startLoopStep,
  finishLoopStep,
  finishLoopTrace,
} from "../apps/server-identity/loop-trace";
import {
  ServiceCatalogStore,
  type StoredInvocation,
} from "../apps/server-identity/service-catalog";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { openIdentity } from "../apps/server-identity/service";
import { issueAdminKey } from "../apps/server-admin/auth";
import {
  LoopDetailSchema,
  LoopPageSchema,
  type LoopStatus,
} from "../packages/protocol/loops";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../packages/protocol/identity";
import { seedIdentityFixture } from "./helpers/identity-seed";

const at = "2026-10-01T08:00:00.000Z";
const id = (value: string) =>
  createHash("sha256").update(`TEST-loops-${value}`).digest("hex");
function turn(changes: Record<string, unknown> = {}) {
  return {
    kind: "agent-1",
    text: "TEST find a contact",
    clock: { referenceNow: at },
    modelCalls: 2,
    calls: 1,
    inference: 3,
    transcript: [],
    operations: [],
    receipts: [],
    answer: { reply: "TEST the result is ready" },
    ...changes,
  };
}
function recorded(status: LoopStatus, changes: Record<string, unknown> = {}) {
  return turn({
    trace: {
      startedAt: at,
      finishedAt: status === "running" ? null : at,
      status,
      steps: [],
      truncated: false,
    },
    ...changes,
  });
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organization(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT NOT NULL) STRICT;
    CREATE TABLE member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT) STRICT;
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,name TEXT NOT NULL) STRICT;
    INSERT INTO organization VALUES('org-a'),('org-b');
    INSERT INTO user VALUES('alice','TEST Alice'),('bob','TEST Bob');
    INSERT INTO agent_workspace VALUES('workspace-a','org-a','TEST One'),('workspace-a2','org-a','TEST Two'),('workspace-b','org-b','TEST Foreign');`);
  const catalog = new ServiceCatalogStore(db, "TEST-loops-only-secret", []);
  const store = new LoopsStore(db, catalog);
  const save = (
    name: string,
    value = turn(),
    workspace = "workspace-a",
    user = "alice",
  ) => {
    const runId = id(name);
    catalog.saveTurn(runId, workspace, user, value);
    return runId;
  };
  return { db, catalog, store, save };
}

test("loops pages isolate organizations/workspaces and details refuse guessed foreign IDs", () => {
  const f = fixture();
  try {
    const own = f.save("one"),
      sibling = f.save("two", turn(), "workspace-a2"),
      foreign = f.save("foreign", turn(), "workspace-b", "bob");
    assert.deepEqual(
      f.store.page({ organizationId: "org-a" }).entries.map((run) => run.id),
      [sibling, own],
    );
    assert.deepEqual(
      f.store
        .page({ organizationId: "org-a", workspaceId: "workspace-a" })
        .entries.map((run) => run.id),
      [own],
    );
    assert.deepEqual(
      f.store.page({ organizationId: "org-a", workspaceId: "workspace-b" })
        .entries,
      [],
    );
    assert.equal(f.store.detail("org-a", foreign), null);
    assert.equal(f.store.detail("org-b", own), null);
    assert.equal(f.store.detail("org-a", id("absent")), null);
    assert.equal(f.store.detail("org-b", foreign)?.run.actorName, "TEST Bob");
    f.db
      .prepare("INSERT INTO agent_service_turn VALUES (?,?,?,?)")
      .run(id("invalid-json"), "workspace-a", "alice", "{invalid");
    f.save("other-kind", turn({ kind: "legacy-fixture" }));
    assert.equal(f.store.detail("org-a", id("other-kind")), null);
    assert.equal(f.store.page({ organizationId: "org-a" }).entries.length, 2);
  } finally {
    f.db.close();
  }
});

test("loop row cursors remain stable after new inserts and updates, with exact status filters", () => {
  const f = fixture();
  try {
    const ids = Array.from({ length: 63 }, (_, index) =>
      f.save(`page-${index}`, recorded(index % 2 ? "waiting" : "succeeded")),
    );
    const first = f.store.page({ organizationId: "org-a" });
    assert.equal(first.entries.length, 50);
    assert.deepEqual(
      first.entries.map((run) => run.id),
      ids.slice(13).reverse(),
    );
    assert(first.nextBefore);
    f.save("new-after-page", recorded("succeeded"));
    f.catalog.saveTurn(ids[0]!, "workspace-a", "alice", recorded("failed"));
    const second = f.store.page({
      organizationId: "org-a",
      before: first.nextBefore,
    });
    assert.deepEqual(
      second.entries.map((run) => run.id),
      ids.slice(0, 13).reverse(),
    );
    assert.equal(second.nextBefore, null);
    assert.equal(
      new Set([...first.entries, ...second.entries].map((run) => run.id)).size,
      63,
    );
    const failed = f.store.page({ organizationId: "org-a", status: "failed" });
    assert.deepEqual(
      failed.entries.map((run) => run.id),
      [ids[0]],
    );
    const waiting = f.store.page({
      organizationId: "org-a",
      status: "waiting",
    });
    assert.equal(waiting.entries.length, 31);
    assert(waiting.entries.every((run) => run.status === "waiting"));
    assert.throws(() => f.store.page({ organizationId: "org-a", before: "0" }));
    assert.throws(() =>
      f.store.page({ organizationId: "org-a", before: "9007199254740992" }),
    );
  } finally {
    f.db.close();
  }
});

test("legacy reconstruction shows observed tool flow without assistant reasoning, arguments or raw results", () => {
  const f = fixture();
  try {
    const runId = f.save(
      "legacy",
      turn({
        transcript: [
          { role: "system", content: "TEST PRIVATE SYSTEM PROMPT" },
          {
            role: "assistant",
            content: "TEST PRIVATE REASONING",
            tool_calls: [
              {
                id: "TEST-call",
                type: "function",
                function: {
                  name: "find_service",
                  arguments: '{"password":"TEST RAW ARGUMENT"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "TEST-call",
            content: '{"status":"succeeded","data":"TEST RAW RESULT"}',
          },
          { role: "assistant", content: "TEST UNCOMMITTED ASSISTANT PROSE" },
          {
            role: "tool",
            tool_call_id: "orphan",
            content: '{"error":"TEST ORPHAN ERROR"}',
          },
        ],
      }),
    );
    const detail = f.store.detail("org-a", runId)!;
    assert.equal(detail.run.traceMode, "reconstructed");
    assert.deepEqual(
      detail.nodes.map((node) => node.kind),
      ["request", "model", "tool", "result", "reply"],
    );
    const tool = detail.nodes.find((node) => node.kind === "tool")!;
    assert.equal(tool.label, "find_service");
    assert.equal(tool.status, "succeeded");
    assert(
      detail.edges.some(
        (edge) => edge.source === tool.id && edge.kind === "result",
      ),
    );
    const serialized = JSON.stringify(detail);
    for (const privateValue of [
      "TEST PRIVATE SYSTEM PROMPT",
      "TEST PRIVATE REASONING",
      "TEST RAW ARGUMENT",
      "TEST RAW RESULT",
      "TEST UNCOMMITTED ASSISTANT PROSE",
      "TEST ORPHAN ERROR",
    ])
      assert(!serialized.includes(privateValue));
    const unknownId = f.save(
      "unknown-label",
      turn({
        transcript: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: "TEST-unknown-call",
                function: { name: "TEST PRIVATE TOOL LABEL", arguments: "{}" },
              },
            ],
          },
        ],
      }),
    );
    const unknown = f.store.detail("org-a", unknownId)!;
    assert.equal(
      unknown.nodes.find((node) => node.kind === "tool")?.label,
      "Unknown tool",
    );
    assert(!JSON.stringify(unknown).includes("TEST PRIVATE TOOL LABEL"));
  } finally {
    f.db.close();
  }
});

test("receipt context is joined only through this run, workspace, actor and organization", () => {
  const f = fixture();
  try {
    const receipt: StoredInvocation = {
      id: "TEST-operation",
      organizationId: "org-a",
      workspaceId: "workspace-a",
      userId: "alice",
      serviceId: "TEST-service",
      actionId: "TEST-action",
      serviceRevision: 1,
      actionRevision: 1,
      policyRevision: 1,
      input: { password: "TEST SECRET ARGUMENT" },
      result: { credentials: { value: "TEST PRIVATE RESULT" } },
      status: "succeeded",
      title: "TEST Find contact",
      serviceName: "TEST Directory",
      effect: "read",
    };
    f.catalog.saveInvocation(receipt);
    const data = turn({
      operations: [receipt.id],
      receipts: [{ callId: "TEST-call", operationId: receipt.id }],
      transcript: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "TEST-call",
              function: { name: "TEST_find_contact", arguments: "{}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "TEST-call",
          content: '{"status":"succeeded"}',
        },
      ],
    });
    const own = f.save("receipt-own", data);
    const sibling = f.save("receipt-sibling", data, "workspace-a2");
    const otherActor = f.save("receipt-other-user", data, "workspace-a", "bob");
    const unbound = f.save("receipt-unbound", { ...data, operations: [] });
    assert(
      JSON.stringify(f.store.detail("org-a", own)).includes("TEST Directory"),
    );
    assert(
      !JSON.stringify(f.store.detail("org-a", own)).includes(
        "TEST SECRET ARGUMENT",
      ),
    );
    assert(
      !JSON.stringify(f.store.detail("org-a", own)).includes(
        "TEST PRIVATE RESULT",
      ),
    );
    for (const runId of [sibling, otherActor, unbound])
      assert(
        !JSON.stringify(f.store.detail("org-a", runId)).includes(
          "TEST Directory",
        ),
      );
    f.catalog.saveInvocation({ ...receipt, organizationId: "org-b" });
    assert(
      !JSON.stringify(f.store.detail("org-a", own)).includes("TEST Directory"),
    );
  } finally {
    f.db.close();
  }
});

test("recorded steps expose operational routing and tool/result links while ignoring transcript content", () => {
  const f = fixture();
  try {
    const current = { trace: newLoopTrace() };
    finishLoopStep(
      startLoopStep(current, "model", "TEST model", [
        { label: "Model", value: "TEST-fixture" },
      ]),
      "succeeded",
    );
    finishLoopStep(
      startLoopStep(current, "decision", "TEST route", [
        { label: "Selected branch", value: "TEST_read_contact" },
      ]),
      "succeeded",
    );
    finishLoopStep(
      startLoopStep(current, "tool", "TEST_lookup_a", [], "TEST-a"),
      "succeeded",
    );
    finishLoopStep(
      startLoopStep(current, "tool", "TEST_lookup_b", [], "TEST-b"),
      "failed",
    );
    finishLoopStep(
      startLoopStep(current, "result", "TEST result a", [], "TEST-a"),
      "succeeded",
    );
    finishLoopTrace(current, "succeeded");
    const runId = f.save(
      "recorded-flow",
      turn({
        trace: current.trace,
        transcript: [
          {
            role: "assistant",
            content: "TEST HIDDEN REASONING",
            tool_calls: [
              {
                id: "TEST-secret-call",
                function: {
                  name: "TEST_private_tool",
                  arguments: '{"raw":"TEST PRIVATE ARGS"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "TEST-secret-call",
            content: '{"raw":"TEST PRIVATE BODY"}',
          },
        ],
      }),
    );
    const detail = f.store.detail("org-a", runId)!;
    assert.equal(detail.run.traceMode, "recorded");
    assert.deepEqual(
      detail.nodes.map((node) => node.kind),
      ["request", "model", "decision", "tool", "tool", "result", "reply"],
    );
    const a = detail.nodes.find((node) => node.label === "TEST_lookup_a")!,
      b = detail.nodes.find((node) => node.label === "TEST_lookup_b")!,
      result = detail.nodes.find((node) => node.kind === "result")!;
    assert.equal(b.status, "failed");
    assert(
      detail.edges.some(
        (edge) =>
          edge.source === a.id &&
          edge.target === result.id &&
          edge.kind === "result",
      ),
    );
    const data = JSON.stringify(detail);
    for (const hidden of [
      "TEST HIDDEN REASONING",
      "TEST PRIVATE ARGS",
      "TEST PRIVATE BODY",
      "TEST_private_tool",
      "TEST-secret-call",
    ])
      assert(!data.includes(hidden));
  } finally {
    f.db.close();
  }
});

test("credential redaction happens before previews are truncated, including JSON keys and URL parameters", () => {
  const secrets = [
    "TEST-json-password",
    "TEST-json-key",
    "TEST-bearer-token",
    "TEST-url-user",
    "TEST-url-password",
    "TEST-url-token",
    "TEST-pem-data",
    "sk-TESTabcdefghijklmnopqrstuvwxyz",
  ];
  const raw = `password="${secrets[0]}" {"api_key":"${secrets[1]}"} Bearer ${secrets[2]} https://${secrets[3]}:${secrets[4]}@example.test/review?access_token=${secrets[5]}#private -----BEGIN PRIVATE KEY-----\n${secrets[6]}\n-----END PRIVATE KEY----- ${secrets[7]}`;
  const clean = loopText(raw);
  for (const secret of secrets)
    assert(!clean.includes(secret), `Synthetic credential leaked: ${secret}`);
  assert(clean.includes("[redacted]"));
  assert.equal(
    loopText(`password="${"TEST-long-secret-".repeat(200)}"`, 20),
    "[redacted]",
  );
  assert.equal(loopText("TEST safe " + "x".repeat(2000), 500).length, 500);
  const f = fixture();
  try {
    const runId = f.save(
      "redacted",
      recorded("succeeded", {
        text: raw,
        answer: { reply: raw },
        trace: {
          startedAt: at,
          finishedAt: at,
          status: "succeeded",
          truncated: false,
          steps: [
            {
              id: "step-1",
              kind: "decision",
              status: "succeeded",
              label: raw.slice(0, 160),
              startedAt: at,
              finishedAt: at,
              details: [{ label: "Metadata", value: raw }],
            },
          ],
        },
      }),
    );
    const serialized = JSON.stringify({
      page: f.store.page({ organizationId: "org-a" }),
      detail: f.store.detail("org-a", runId),
    });
    for (const secret of secrets)
      assert(
        !serialized.includes(secret),
        `Loop response leaked synthetic credential: ${secret}`,
      );
  } finally {
    f.db.close();
  }
});

test("startup marks running diagnostics interrupted without retrying tools or changing waiting turns", () => {
  const f = fixture();
  try {
    const trace = newLoopTrace();
    const live = { trace };
    startLoopStep(
      live,
      "tool",
      "TEST pending external action",
      [],
      "TEST-call",
    );
    const running = {
      ...turn({
        trace,
        answer: undefined,
        operations: ["TEST-pending-operation"],
        pending: "TEST-pending-operation",
        receipts: [
          { callId: "TEST-call", operationId: "TEST-pending-operation" },
        ],
      }),
      trace,
    };
    const runningId = f.save("running", running);
    const waiting = recorded("waiting", {
      pending: "TEST-approval",
      answer: { reply: "TEST Please confirm" },
    });
    const waitingId = f.save("waiting", waiting);
    const recovered = new LoopsStore(f.db, f.catalog);
    const run = recovered.detail("org-a", runningId)!;
    assert.equal(run.run.status, "interrupted");
    assert.equal(
      run.nodes.find((node) => node.kind === "tool")?.status,
      "interrupted",
    );
    assert(run.run.finishedAt);
    const saved = f.catalog.turn(
      runningId,
      "workspace-a",
      "alice",
    ) as typeof running;
    const { trace: savedTrace, ...savedBusiness } = saved;
    const { trace: _oldTrace, ...business } = running;
    assert.deepEqual(savedBusiness, JSON.parse(JSON.stringify(business)));
    assert.equal(savedTrace.status, "interrupted");
    assert.deepEqual(
      f.catalog.turn(waitingId, "workspace-a", "alice"),
      waiting,
    );
    assert.equal(
      recovered.detail("org-a", waitingId)?.nodes.at(-1)?.kind,
      "question",
    );
    assert.equal(
      recovered.page({ organizationId: "org-a", status: "running" }).entries
        .length,
      0,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM agent_service_invocation").get()
        ?.n,
      0,
    );
  } finally {
    f.db.close();
  }
});

test("trace recording caps steps and finishes pending metadata truthfully; legacy graph stays bounded", () => {
  const f = fixture();
  try {
    const current = { trace: newLoopTrace() };
    for (let i = 0; i < 125; i++) {
      const step = startLoopStep(current, "model", "TEST model pass", [
        { label: "Purpose", value: "TEST task routing" },
      ]);
      if (i < 119) finishLoopStep(step, "succeeded");
    }
    assert.equal(current.trace.steps.length, 120);
    assert.equal(current.trace.truncated, true);
    finishLoopTrace(current, "waiting");
    assert.equal(current.trace.steps.at(-1)?.status, "interrupted");
    const recordedId = f.save(
      "bounded-recorded",
      turn({ trace: current.trace }),
    );
    assert.equal(f.store.detail("org-a", recordedId)?.truncated, true);
    const transcript = Array.from({ length: 120 }, (_, index) => ({
      role: "assistant",
      tool_calls: Array.from({ length: 4 }, (_, child) => ({
        id: `TEST-call-${index}-${child}`,
        function: { name: "TEST_find_contact", arguments: "{}" },
      })),
    }));
    const historicalId = f.save("bounded-history", turn({ transcript }));
    const detail = f.store.detail("org-a", historicalId)!;
    assert.equal(detail.truncated, true);
    assert.equal(detail.nodes.length, 160);
    assert(detail.edges.length <= 320);
    const nodes = new Set(detail.nodes.map((node) => node.id));
    assert.equal(nodes.size, detail.nodes.length);
    assert(
      detail.edges.every(
        (edge) => nodes.has(edge.source) && nodes.has(edge.target),
      ),
    );
  } finally {
    f.db.close();
  }
});

type HttpResult = { status: number; data: unknown };
type Client = (path: string, input?: unknown) => Promise<HttpResult>;
test("loops HTTP uses current organization administration roles and scoped read-only endpoints", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loops-http-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST Loops",
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
  let dispatches = 0;
  const identity = await openIdentity(config, {
    integrationTransport: async () => {
      dispatches++;
      throw Error("TEST Loops reads must never invoke model or provider");
    },
  });
  app = createReferenceServer(config, {}, identity);
  const client = (): Client => {
    const cookies = new Map<string, string>();
    return async (path, input) => {
      const response = await fetch(`${origin}/admin/${path}`, {
        method: input === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...cookies]
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!,
          split = pair.indexOf("=");
        cookies.set(pair.slice(0, split), pair.slice(split + 1));
      }
      return {
        status: response.status,
        data: (await response.json()) as unknown,
      };
    };
  };
  const owner = client(),
    admin = client(),
    member = client(),
    anonymous = client(),
    operator = client();
  const password = "TEST-loops-password-only-2026";
  try {
    assert.equal((await operator("api/login", { key })).status, 200);
    assert.equal(
      (
        await operator("api/identity/bootstrap", {
          name: "TEST Loops Owner",
          email: "owner-loops@example.test",
          password,
          organizationName: "TEST Loops tenant",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await owner("auth/sign-in/email", {
          email: "owner-loops@example.test",
          password,
        })
      ).status,
      200,
    );
    const state = IdentityStateSchema.parse((await owner("api/identity")).data),
      organizationId = state.organizations[0]!.id;
    for (const name of ["TEST Loops One", "TEST Loops Two"])
      assert.equal(
        (
          await owner("api/identity/command", {
            type: "createWorkspace",
            organizationId,
            name,
          })
        ).status,
        200,
      );
    for (const role of ["admin", "member"] as const)
      await seedIdentityFixture(identity, {
        type: "createAccount",
        organizationId,
        name: `TEST Loops ${role}`,
        email: `${role}-loops@example.test`,
        password,
        role,
      });
    const organization = OrganizationDetailSchema.parse(
      (await owner(`api/identity/organization?id=${organizationId}`)).data,
    );
    const workspaceId = organization.workspaces[0]!.id,
      secondId = organization.workspaces[1]!.id;
    const adminMember = organization.members.find(
        (entry) => entry.role === "admin",
      )!,
      memberInfo = organization.members.find(
        (entry) => entry.role === "member",
      )!;
    await seedIdentityFixture(identity, {
      type: "setWorkspaceMember",
      organizationId,
      workspaceId,
      memberId: memberInfo.id,
      allowed: true,
    });
    assert.equal(
      (
        await admin("auth/sign-in/email", {
          email: "admin-loops@example.test",
          password,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await member("auth/sign-in/email", {
          email: "member-loops@example.test",
          password,
        })
      ).status,
      200,
    );
    const db = identity["db"];
    // Fixture seeding only; the HTTP API has no trace insertion or mutation switch.
    const save = (name: string, ws: string, data = recorded("succeeded")) => {
      db.prepare("INSERT INTO agent_service_turn VALUES (?,?,?,?)").run(
        id(name),
        ws,
        state.user!.id,
        JSON.stringify(data),
      );
      return id(name);
    };
    const first = save("http-own", workspaceId),
      second = save(
        "http-second",
        secondId,
        recorded("waiting", { pending: "TEST-input" }),
      );
    db.prepare(
      'INSERT INTO organization (id,name,slug,"createdAt") VALUES (?,?,?,?)',
    ).run("TEST-foreign-org", "TEST Foreign", "test-foreign-loops", Date.now());
    db.prepare("INSERT INTO agent_workspace VALUES (?,?,?)").run(
      "TEST-foreign-workspace",
      "TEST-foreign-org",
      "TEST Foreign workspace",
    );
    const foreign = save("http-foreign", "TEST-foreign-workspace");
    const pagePath = (changes: Record<string, string> = {}) =>
      `api/identity/loops?${new URLSearchParams({ organizationId, ...changes })}`;
    const detailPath = (runId: string, changes: Record<string, string> = {}) =>
      `api/identity/loops/${runId}?${new URLSearchParams({ organizationId, ...changes })}`;
    await t.test(
      "owner/admin can inspect; member with workspace access, operator key and anonymous cannot",
      async () => {
        for (const privileged of [owner, admin]) {
          const response = await privileged(pagePath());
          assert.equal(response.status, 200);
          assert.deepEqual(
            LoopPageSchema.parse(response.data).entries.map((run) => run.id),
            [second, first],
          );
          assert.equal(
            LoopDetailSchema.parse((await privileged(detailPath(first))).data)
              .run.workspaceId,
            workspaceId,
          );
        }
        for (const denied of [member, anonymous, operator]) {
          assert([401, 403].includes((await denied(pagePath())).status));
          assert([401, 403].includes((await denied(detailPath(first))).status));
        }
      },
    );
    await t.test(
      "guessed foreign IDs and mismatched workspace filters never expose another loop",
      async () => {
        assert.equal((await owner(detailPath(foreign))).status, 404);
        assert.equal((await owner(detailPath(id("http-missing")))).status, 404);
        assert.equal(
          (await owner(detailPath(first, { workspaceId: secondId }))).status,
          404,
        );
        assert.equal(
          (await owner(pagePath({ organizationId: "TEST-foreign-org" })))
            .status,
          403,
        );
        assert.equal(
          (await owner(pagePath({ workspaceId: "TEST-foreign-workspace" })))
            .status,
          404,
        );
        const response = await owner(
          pagePath({ workspaceId, status: "succeeded" }),
        );
        assert.deepEqual(
          LoopPageSchema.parse(response.data).entries.map((run) => run.id),
          [first],
        );
        assert.deepEqual(
          LoopPageSchema.parse(
            (await owner(pagePath({ workspaceId, status: "waiting" }))).data,
          ).entries,
          [],
        );
      },
    );
    await t.test(
      "strict query and ID validation rejects unsupported shapes before exposing diagnostics",
      async () => {
        const invalidQueries: Record<string, string>[] = [
          { before: "0" },
          { before: "9007199254740992" },
          { status: "done" },
          { actorId: state.user!.id },
        ];
        for (const changes of invalidQueries)
          assert.equal((await owner(pagePath(changes))).status, 400);
        assert.equal((await owner(detailPath("not-a-loop-id"))).status, 400);
      },
    );
    await t.test(
      "a live session loses loop access immediately after administrator demotion/removal",
      async () => {
        assert.equal(
          (
            await owner("api/identity/command", {
              type: "changeRole",
              organizationId,
              memberId: adminMember.id,
              role: "member",
            })
          ).status,
          200,
        );
        assert.equal((await admin(pagePath())).status, 403);
        assert.equal((await admin(detailPath(first))).status, 403);
        assert.equal(
          (
            await owner("api/identity/command", {
              type: "changeRole",
              organizationId,
              memberId: adminMember.id,
              role: "admin",
            })
          ).status,
          200,
        );
        assert.equal((await admin(pagePath())).status, 200);
        assert.equal(
          (
            await owner("api/identity/command", {
              type: "removeMember",
              organizationId,
              memberId: adminMember.id,
            })
          ).status,
          200,
        );
        assert.equal((await admin(pagePath())).status, 403);
        assert.equal((await admin(detailPath(first))).status, 403);
      },
    );
    assert.equal(dispatches, 0);
  } finally {
    app.emit("close");
    await identity.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
