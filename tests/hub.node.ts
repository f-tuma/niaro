import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HubStore } from "../apps/server-identity/hub-store";
import {
  createHub,
  hubItemStale,
  hubOutput,
} from "../apps/server-identity/hub";
import { IdentityError } from "../apps/server-identity/error";
import {
  HUB_ITEM_LIMIT,
  HUB_PROFILE,
  HUB_PROFILE_V2,
  HubDashboardSchema,
  HubViewSchema,
  hubConversationId,
} from "../packages/protocol/hub";
import {
  hubCompact,
  hubDefaultView,
  hubDragLayout,
  hubFitLayout,
  hubLayoutIssue,
  hubMove,
  hubOverlaps,
  hubPack,
  hubPlace,
  hubResolveView,
  hubViewChoices,
} from "../packages/protocol/hub-dashboard";
import {
  hubFields,
  hubSnapshot,
  hubWidgetData,
} from "../apps/server-identity/hub-widgets";
import type { ProcessExecutionEntry } from "../packages/protocol/process-execution";
import type { ProcessData } from "../packages/protocol/service-processes";

type OutputSchema = Extract<ProcessData, { type: "object" }>;

const org = "TEST-org";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspace = "22222222-2222-4222-8222-222222222222";
const person = (
  userId: string,
  role: "owner" | "admin" | "member" = "member",
) => ({
  actor: { organizationId: org, workspaceId, userId, role },
  scope: {
    connectionId: `account-${workspaceId}`,
    serverId: "TEST-server",
    workspaceId,
    userId,
  },
});
const anna = person("TEST-anna");
const petr = person("TEST-petr");
const code = (value: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === value;
const object = (required: string[] = []) => ({
  type: "object" as const,
  properties: Object.fromEntries(
    required.map((key) => [key, { type: "string" as const }]),
  ),
  required,
  additionalProperties: false as const,
});
const entry = (
  processId: string,
  extra: Partial<ProcessExecutionEntry> = {},
): ProcessExecutionEntry =>
  ({
    processId,
    name: `TEST ${processId}`,
    description: "TEST process",
    kind: "workflow",
    version: 1,
    artifactDigest: "a".repeat(64),
    availability: "ready",
    inputSchema: object(),
    ...extra,
  }) as ProcessExecutionEntry;

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organization(id TEXT PRIMARY KEY);
    CREATE TABLE user(id TEXT PRIMARY KEY);
    CREATE TABLE member(id TEXT PRIMARY KEY, "organizationId" TEXT REFERENCES organization(id) ON DELETE CASCADE, "userId" TEXT REFERENCES user(id) ON DELETE CASCADE);
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT REFERENCES organization(id) ON DELETE CASCADE);
    CREATE TABLE agent_workspace_member(workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE, member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE, PRIMARY KEY(workspace_id, member_id)) STRICT;
    INSERT INTO organization VALUES ('${org}');
    INSERT INTO user VALUES ('TEST-anna'), ('TEST-petr'), ('TEST-stranger');
    INSERT INTO member VALUES ('TEST-m-anna','${org}','TEST-anna'), ('TEST-m-petr','${org}','TEST-petr');
    INSERT INTO agent_workspace VALUES ('${workspaceId}','${org}'), ('${otherWorkspace}','${org}');
    INSERT INTO agent_workspace_member VALUES ('${workspaceId}','TEST-m-anna'), ('${workspaceId}','TEST-m-petr');`);
  let now = Date.parse("2026-10-16T08:00:00.000Z");
  const store = new HubStore(db, () => now);
  let inventory: ProcessExecutionEntry[] = [
    entry("TEST-day"),
    entry("TEST-needs-input", { inputSchema: object(["name"]) }),
    entry("TEST-blocked", {
      availability: "blocked",
      reason: "connection_required",
    } as Partial<ProcessExecutionEntry>),
    entry("TEST-company"),
    entry("TEST-writes"),
    entry("TEST-approved"),
  ];
  // What each process may do unattended under the current catalog policy.
  const effects = new Map<string, "read" | "approval" | "write">([
    ["TEST-writes", "write"],
    ["TEST-approved", "approval"],
  ]);
  const inventoryReads: string[] = [];
  /** Each process's frozen output schema; the default has a summary and a count. */
  const outputs = new Map<string, OutputSchema>();
  const defaultOutput: OutputSchema = {
    type: "object",
    properties: { summary: { type: "string" }, count: { type: "number" } },
    required: [],
    additionalProperties: false,
  };
  const admissions = new Map<string, unknown>();
  const journals = new Map<string, unknown>();
  const hub = createHub({
    store,
    processes: {
      unattendedEffect: (actor, id, expected) => {
        assert.equal(expected.artifactDigest, "a".repeat(64));
        return effects.get(id) ?? "read";
      },
      activeOutputSchema: (actor, id, expected) => {
        assert.equal(expected.artifactDigest, "a".repeat(64));
        return outputs.get(id) ?? defaultOutput;
      },
      executionInventory: (actor, scope) => {
        inventoryReads.push(actor.userId);
        assert.equal(scope.userId, actor.userId);
        return {
          profile: "agent-process-execution/1",
          scope,
          fingerprint: "f".repeat(64),
          processes: inventory,
          nextAfter: null,
        };
      },
    },
    starts: () => ({
      forParent: (actor, scope, parentRunId) => {
        const saved = admissions.get(parentRunId) as
          | { userId: string; receipt: unknown }
          | undefined;
        if (!saved || saved.userId !== actor.userId)
          throw new IdentityError(404, "process_start_not_found");
        return saved as never;
      },
    }),
    journal: (id) => journals.get(id),
    humanTasks: {
      open: (scope, limit) =>
        scope.userId === "TEST-anna"
          ? [
              { id: "TEST-task-1", title: "TEST call the client" },
              { id: "TEST-task-2", title: "TEST send the offer" },
            ].slice(0, limit)
          : [],
      openCount: (scope) => (scope.userId === "TEST-anna" ? 2 : 0),
    },
    timeZone: () => "Europe/Prague",
    now: () => now,
  });
  const run = (
    parentRunId: string,
    userId: string,
    processId: string,
    itemId: string,
    journal: Record<string, unknown>,
  ) => {
    admissions.set(parentRunId, {
      userId,
      receipt: {
        status: "admitted",
        parentRunId,
        processId,
        createdAt: new Date(now).toISOString(),
        origin: {
          type: "command",
          conversationId: hubConversationId(itemId),
          requestId: "TEST-request",
        },
      },
    });
    journals.set(parentRunId, {
      kind: "service-process-1",
      revision: 2,
      runId: "TEST-run",
      processId,
      version: 1,
      artifactDigest: "a".repeat(64),
      compilerVersion: "TEST",
      scopeDigest: "TEST",
      inputDigest: "TEST",
      input: {},
      text: "",
      status: "succeeded",
      startedAt: now,
      visited: [],
      operations: [],
      receipts: [],
      sources: [],
      trace: {
        startedAt: new Date(now).toISOString(),
        finishedAt: new Date(now + 1000).toISOString(),
        status: "succeeded",
        steps: [],
        truncated: false,
      },
      ...journal,
    });
  };
  return {
    db,
    store,
    hub,
    run,
    inventoryReads,
    outputs,
    setInventory: (value: ProcessExecutionEntry[]) => {
      inventory = value;
    },
    effects,
    advance: (ms: number) => {
      now += ms;
    },
    command: (who: typeof anna, command: Record<string, unknown>) =>
      hub.command(who.actor, who.scope, "cs", {
        profile: HUB_PROFILE,
        ...command,
      }),
    dashboard: (who: typeof anna, command: Record<string, unknown>) =>
      HubDashboardSchema.parse(
        hub.command(who.actor, who.scope, "cs", {
          profile: HUB_PROFILE_V2,
          ...command,
        }).view,
      ),
  };
}

test("a new hub starts with the built-in Tasks item and summarizes open items", () => {
  const f = fixture();
  const view = f.hub.view(anna.actor, anna.scope, "cs");
  HubViewSchema.parse(view);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0]!.kind, "tasks");
  assert.equal(view.items[0]!.title, "Úkoly");
  assert.equal(view.items[0]!.stale, false);
  assert.deepEqual(view.tasks, {
    open: 2,
    top: [
      { id: "TEST-task-1", title: "TEST call the client" },
      { id: "TEST-task-2", title: "TEST send the offer" },
    ],
  });
  // Reading again neither seeds a second Tasks item nor changes the revision.
  assert.equal(
    f.hub.view(anna.actor, anna.scope, "en").revision,
    view.revision,
  );
  assert.equal(f.hub.view(anna.actor, anna.scope, "en").items.length, 1);
  // Constructing the store again on the same database is a no-op migration.
  new HubStore(f.db);
  assert.equal(f.hub.view(anna.actor, anna.scope, "cs").items.length, 1);
});

test("only ready processes that start without input can be added, once each", () => {
  const f = fixture();
  assert.throws(
    () =>
      f.command(anna, {
        type: "add",
        kind: "process",
        processId: "TEST-needs-input",
      }),
    code("hub_process_needs_input"),
  );
  assert.throws(
    () =>
      f.command(anna, {
        type: "add",
        kind: "process",
        processId: "TEST-blocked",
      }),
    code("hub_process_unavailable"),
  );
  assert.throws(
    () =>
      f.command(anna, {
        type: "add",
        kind: "process",
        processId: "TEST-missing",
      }),
    code("hub_process_unavailable"),
  );
  const added = f.command(anna, {
    type: "add",
    kind: "process",
    processId: "TEST-day",
  });
  const item = added.view.items.find((value) => value.kind === "process")!;
  assert.equal(item.title, "TEST TEST-day");
  assert.equal(item.refresh, "daily");
  // A new item refreshes right away and shows that it is running.
  assert.deepEqual(added.refresh, [item.id]);
  assert.equal(item.result?.status, "running");
  assert.equal(item.result?.conversationId, hubConversationId(item.id));
  assert.throws(
    () =>
      f.command(anna, { type: "add", kind: "process", processId: "TEST-day" }),
    code("hub_item_exists"),
  );
  // Inventory is re-read under the person's own authority for every add.
  assert(f.inventoryReads.every((user) => user === "TEST-anna"));
});

test("only processes that write nothing unattended can be on the hub", () => {
  const f = fixture();
  // A writing action without approval would run on every page open.
  assert.throws(
    () =>
      f.command(anna, {
        type: "add",
        kind: "process",
        processId: "TEST-writes",
      }),
    code("hub_process_writes"),
  );
  // Writes that wait for the person's approval are fine.
  const approved = f.command(anna, {
    type: "add",
    kind: "process",
    processId: "TEST-approved",
  });
  const item = approved.view.items.find(
    (value) => value.processId === "TEST-approved",
  )!;
  assert.deepEqual(approved.refresh, [item.id]);
  f.hub.record(anna.actor, anna.scope, item.id, {
    type: "failed",
    error: "hub_refresh_failed",
  });
  // The policy changes (approval switched off): the next refresh is refused
  // before anything runs.
  f.effects.set("TEST-approved", "write");
  const refused = f.command(anna, { type: "refresh", itemIds: [item.id] });
  assert.deepEqual(refused.refresh, []);
  const result = refused.view.items.find(
    (value) => value.id === item.id,
  )!.result!;
  assert.equal(result.status, "failed");
  assert.equal(result.error, "hub_process_writes");
  assert.equal(f.hub.isActive(anna.actor, item.id), false);
  // The agent is offered and may add only the safe ones, and its item waits.
  const agent = f.hub.agent(anna.actor, anna.scope, "cs");
  assert.deepEqual(
    agent
      .list()
      .addable.map((entry) => entry.processId)
      .sort(),
    ["TEST-company", "TEST-day"],
  );
  assert.throws(
    () => agent.add({ id: "TEST-agent-writes", processId: "TEST-writes" }),
    code("hub_process_writes"),
  );
  const added = agent.add({ id: "TEST-agent-day", processId: "TEST-day" });
  assert.equal(added.refresh, "manual");
  const waiting = f.hub
    .view(anna.actor, anna.scope, "cs")
    .items.find((value) => value.id === "TEST-agent-day")!;
  assert.equal(waiting.result, null);
  assert.equal(waiting.stale, false);
  assert.deepEqual(
    f.command(anna, { type: "refresh", stale: true }).refresh,
    [],
  );
  // The person's explicit refresh starts it.
  assert.deepEqual(
    f.command(anna, { type: "refresh", itemIds: ["TEST-agent-day"] }).refresh,
    ["TEST-agent-day"],
  );
});

test("a refresh naming an unknown item changes nothing", () => {
  const f = fixture();
  const item = f
    .command(anna, { type: "add", kind: "process", processId: "TEST-day" })
    .view.items.find((value) => value.kind === "process")!;
  f.hub.record(anna.actor, anna.scope, item.id, {
    type: "failed",
    error: "hub_refresh_failed",
  });
  assert.throws(
    () =>
      f.command(anna, {
        type: "refresh",
        itemIds: [item.id, "TEST-unknown"],
      }),
    code("hub_item_not_found"),
  );
  const after = f.hub
    .view(anna.actor, anna.scope, "cs")
    .items.find((value) => value.id === item.id)!;
  assert.equal(after.result?.status, "failed");
  assert.equal(f.hub.isActive(anna.actor, item.id), false);
});

test("hubs are per person: another member sees and changes only their own", () => {
  const f = fixture();
  const mine = f.command(anna, {
    type: "add",
    kind: "process",
    processId: "TEST-day",
  });
  const id = mine.view.items.find((item) => item.kind === "process")!.id;
  const theirs = f.hub.view(petr.actor, petr.scope, "cs");
  assert.equal(theirs.items.length, 1);
  assert.equal(theirs.tasks.open, 0);
  assert.throws(
    () => f.command(petr, { type: "rename", itemId: id, title: "TEST mine" }),
    code("hub_item_not_found"),
  );
  assert.throws(
    () => f.command(petr, { type: "refresh", itemIds: [id] }),
    code("hub_item_not_found"),
  );
  // Removing someone else's item changes nothing.
  f.command(petr, { type: "remove", itemId: id });
  assert.equal(f.hub.view(anna.actor, anna.scope, "cs").items.length, 2);
  // A person outside the organization has no hub at all.
  const stranger = person("TEST-stranger");
  assert.throws(
    () => f.hub.view(stranger.actor, stranger.scope, "cs"),
    code("identity_forbidden"),
  );
});

test("rename, refresh policy, reorder and remove change only the person's list", () => {
  const f = fixture();
  f.command(anna, { type: "add", kind: "process", processId: "TEST-day" });
  const view = f.command(anna, {
    type: "add",
    kind: "process",
    processId: "TEST-company",
  }).view;
  const [tasks, day, company] = view.items;
  f.command(anna, { type: "rename", itemId: day!.id, title: "  Můj den " });
  f.command(anna, { type: "setRefresh", itemId: day!.id, refresh: "hourly" });
  assert.throws(
    () => f.command(anna, { type: "reorder", itemIds: [day!.id, tasks!.id] }),
    code("hub_changed"),
  );
  const reordered = f.command(anna, {
    type: "reorder",
    itemIds: [company!.id, day!.id, tasks!.id],
  }).view;
  assert.deepEqual(
    reordered.items.map((item) => item.id),
    [company!.id, day!.id, tasks!.id],
  );
  assert.equal(reordered.items[1]!.title, "Můj den");
  assert.equal(reordered.items[1]!.refresh, "hourly");
  assert(reordered.revision > view.revision);
  const removed = f.command(anna, { type: "remove", itemId: tasks!.id }).view;
  assert.deepEqual(
    removed.items.map((item) => item.kind),
    ["process", "process"],
  );
  // The built-in item can come back; there is only ever one.
  f.command(anna, { type: "add", kind: "tasks" });
  assert.throws(
    () => f.command(anna, { type: "add", kind: "tasks" }),
    code("hub_item_exists"),
  );
});

test("the hub holds at most twelve items", () => {
  const f = fixture();
  f.setInventory(
    Array.from({ length: HUB_ITEM_LIMIT + 1 }, (_, i) => entry(`TEST-p${i}`)),
  );
  for (let i = 0; i < HUB_ITEM_LIMIT - 1; i++)
    f.command(anna, { type: "add", kind: "process", processId: `TEST-p${i}` });
  assert.throws(
    () =>
      f.command(anna, {
        type: "add",
        kind: "process",
        processId: `TEST-p${HUB_ITEM_LIMIT}`,
      }),
    code("hub_full"),
  );
});

test("a refresh result comes from the run's own journal and its admission", () => {
  const f = fixture();
  const added = f.command(anna, {
    type: "add",
    kind: "process",
    processId: "TEST-day",
  });
  const item = added.view.items.find((value) => value.kind === "process")!;
  // While the runner owns it, a second refresh does not start another run.
  assert.deepEqual(
    f.command(anna, { type: "refresh", itemIds: [item.id] }).refresh,
    [],
  );
  f.run("TEST-parent-1", "TEST-anna", "TEST-day", item.id, {
    output: {
      summary: "**TEST** three meetings today",
      meetings: [
        { title: "TEST standup", start: "09:00" },
        { title: "TEST client call", start: "13:00" },
      ],
      accessToken: "TEST-secret-token",
    },
  });
  f.hub.record(anna.actor, anna.scope, item.id, {
    type: "admitted",
    parentRunId: "TEST-parent-1",
  });
  const result = f.hub
    .view(anna.actor, anna.scope, "cs")
    .items.find((value) => value.id === item.id)!.result!;
  assert.equal(result.status, "succeeded");
  assert.equal(result.runId, "TEST-parent-1");
  assert.equal(result.producedAt, "2026-10-16T08:00:01.000Z");
  assert.equal(result.output?.text, "**TEST** three meetings today");
  assert.deepEqual(result.output?.fields, [
    {
      label: "Meetings",
      items: ["TEST standup, 09:00", "TEST client call, 13:00"],
    },
  ]);
  assert.equal(result.output?.redacted, true);
  assert(!JSON.stringify(result).includes("TEST-secret-token"));

  // A run of another process or another chat cannot be recorded on the item.
  f.command(anna, { type: "refresh", itemIds: [item.id] });
  f.run("TEST-parent-2", "TEST-anna", "TEST-company", item.id, {});
  assert.throws(
    () =>
      f.hub.record(anna.actor, anna.scope, item.id, {
        type: "admitted",
        parentRunId: "TEST-parent-2",
      }),
    code("hub_run_mismatch"),
  );
  // Someone else's run is not even readable.
  f.command(anna, { type: "refresh", itemIds: [item.id] });
  f.run("TEST-parent-3", "TEST-petr", "TEST-day", item.id, {});
  assert.throws(
    () =>
      f.hub.record(anna.actor, anna.scope, item.id, {
        type: "admitted",
        parentRunId: "TEST-parent-3",
      }),
    code("process_start_not_found"),
  );
});

test("waiting runs link to their chat and settle when the person answers there", () => {
  const f = fixture();
  const item = f
    .command(anna, { type: "add", kind: "process", processId: "TEST-day" })
    .view.items.find((value) => value.kind === "process")!;
  f.run("TEST-parent-w", "TEST-anna", "TEST-day", item.id, {
    status: "waiting",
    pending: undefined,
  });
  f.hub.record(anna.actor, anna.scope, item.id, {
    type: "admitted",
    parentRunId: "TEST-parent-w",
  });
  let current = f.hub.view(anna.actor, anna.scope, "cs").items[1]!;
  assert.equal(current.result?.status, "waiting");
  assert.equal(current.result?.waiting, "approval");
  assert.equal(current.result?.conversationId, hubConversationId(item.id));
  assert.equal(current.stale, false);
  // The person approves in the chat; the next read shows the finished run.
  f.run("TEST-parent-w", "TEST-anna", "TEST-day", item.id, {
    output: { summary: "TEST done" },
  });
  current = f.hub.view(anna.actor, anna.scope, "cs").items[1]!;
  assert.equal(current.result?.status, "succeeded");
  assert.equal(current.result?.output?.text, "TEST done");
});

test("failures keep the last output with a short reason; lost runs are interrupted", () => {
  const f = fixture();
  const item = f
    .command(anna, { type: "add", kind: "process", processId: "TEST-day" })
    .view.items.find((value) => value.kind === "process")!;
  f.run("TEST-parent-a", "TEST-anna", "TEST-day", item.id, {
    output: { summary: "TEST yesterday" },
  });
  f.hub.record(anna.actor, anna.scope, item.id, {
    type: "admitted",
    parentRunId: "TEST-parent-a",
  });
  f.command(anna, { type: "refresh", itemIds: [item.id] });
  f.hub.record(anna.actor, anna.scope, item.id, {
    type: "failed",
    error: "catalog_budget_exhausted",
  });
  let result = f.hub.view(anna.actor, anna.scope, "cs").items[1]!.result!;
  assert.equal(result.status, "failed");
  assert.equal(result.error, "catalog_budget_exhausted");
  assert.equal(result.output?.text, "TEST yesterday");
  // A failed process run reports its failure code.
  f.command(anna, { type: "refresh", itemIds: [item.id] });
  f.run("TEST-parent-b", "TEST-anna", "TEST-day", item.id, {
    status: "failed",
    failure: { code: "process_definition_invalid" },
  });
  f.hub.record(anna.actor, anna.scope, item.id, {
    type: "admitted",
    parentRunId: "TEST-parent-b",
  });
  result = f.hub.view(anna.actor, anna.scope, "cs").items[1]!.result!;
  assert.equal(result.error, "process_definition_invalid");
  // A refresh this server no longer runs (restart) is shown as interrupted.
  const restarted = createHub({
    store: f.store,
    processes: {
      executionInventory: () => assert.fail("no inventory read"),
      unattendedEffect: () => assert.fail("no policy read"),
      activeOutputSchema: () => assert.fail("no schema read"),
    },
    starts: () => undefined,
    journal: () => undefined,
    humanTasks: { open: () => [], openCount: () => 0 },
  });
  f.command(anna, { type: "refresh", itemIds: [item.id] });
  result = restarted.view(anna.actor, anna.scope, "cs").items[1]!.result!;
  assert.equal(result.status, "failed");
  assert.equal(result.error, "hub_refresh_interrupted");
});

test("staleness follows the item's refresh policy", () => {
  const at = Date.parse("2026-10-16T08:00:00.000Z");
  const done = (minutes: number) => ({
    status: "succeeded" as const,
    startedAt: new Date(at - minutes * 60_000).toISOString(),
    producedAt: new Date(at - minutes * 60_000).toISOString(),
  });
  const stale = (
    refresh: "manual" | "hourly" | "daily" | "on_open",
    minutes: number,
  ) =>
    hubItemStale(
      { kind: "process", refresh, result: done(minutes) },
      at,
      "Europe/Prague",
    );
  // Never refreshed: due unless manual (an agent-added item waits for the person).
  assert.equal(
    hubItemStale({ kind: "process", refresh: "manual", result: null }, at),
    false,
  );
  assert.equal(
    hubItemStale({ kind: "process", refresh: "daily", result: null }, at),
    true,
  );
  assert.equal(stale("manual", 10_000), false);
  assert.equal(stale("on_open", 2), false);
  assert.equal(stale("on_open", 6), true);
  assert.equal(stale("hourly", 59), false);
  assert.equal(stale("hourly", 61), true);
  // 08:00 UTC is 10:00 in Prague; 9 h earlier was the same day, 11 h was not.
  assert.equal(stale("daily", 9 * 60), false);
  assert.equal(stale("daily", 11 * 60), true);
  assert.equal(
    hubItemStale(
      {
        kind: "process",
        refresh: "hourly",
        result: { ...done(600), status: "running" },
      },
      at,
    ),
    false,
  );
  assert.equal(
    hubItemStale({ kind: "tasks", refresh: "on_open", result: null }, at),
    false,
  );
});

test("the stale refresh starts only what is due", () => {
  const f = fixture();
  const first = f
    .command(anna, { type: "add", kind: "process", processId: "TEST-day" })
    .view.items.find((value) => value.kind === "process")!;
  f.run("TEST-parent-s", "TEST-anna", "TEST-day", first.id, {
    output: { summary: "TEST" },
  });
  f.hub.record(anna.actor, anna.scope, first.id, {
    type: "admitted",
    parentRunId: "TEST-parent-s",
  });
  const second = f
    .command(anna, { type: "add", kind: "process", processId: "TEST-company" })
    .view.items.find((value) => value.processId === "TEST-company")!;
  f.hub.release(anna.scope, second.id);
  f.hub.record(anna.actor, anna.scope, second.id, {
    type: "failed",
    error: "connection_required",
  });
  // Neither is due yet: one just succeeded, the other just failed.
  assert.deepEqual(
    f.command(anna, { type: "refresh", stale: true }).refresh,
    [],
  );
  f.advance(16 * 60_000);
  assert.deepEqual(f.command(anna, { type: "refresh", stale: true }).refresh, [
    second.id,
  ]);
});

test("removing the member, their workspace access or the workspace removes their hub", () => {
  const f = fixture();
  f.command(anna, { type: "add", kind: "process", processId: "TEST-day" });
  f.hub.view(petr.actor, petr.scope, "cs");
  const count = (member: string) =>
    Number(
      f.db
        .prepare(
          "SELECT (SELECT count(*) FROM agent_hub WHERE member_id=?) + (SELECT count(*) FROM agent_hub_item WHERE member_id=?) AS n",
        )
        .get(member, member)!.n,
    );
  assert.equal(count("TEST-m-anna"), 3);
  f.db.prepare("DELETE FROM member WHERE id='TEST-m-anna'").run();
  assert.equal(count("TEST-m-anna"), 0);
  assert.equal(count("TEST-m-petr"), 2);
  f.db
    .prepare("DELETE FROM agent_workspace_member WHERE member_id='TEST-m-petr'")
    .run();
  assert.equal(count("TEST-m-petr"), 0);
  f.hub.view(petr.actor, petr.scope, "cs");
  f.db.prepare(`DELETE FROM agent_workspace WHERE id='${workspaceId}'`).run();
  assert.equal(count("TEST-m-petr"), 0);
});

test("output projection is bounded, ordered and hides sensitive values", () => {
  const long = "x".repeat(5000);
  const output = hubOutput({
    title: "TEST Den",
    report: long,
    count: 3,
    done: true,
    owner: { name: "TEST Anna", password: "TEST-pw" },
    list: Array.from({ length: 11 }, (_, i) => `TEST ${i}`),
    note: "Bearer abcdefghijklmnopqrstuvwxyz",
    apiKey: "TEST-key",
  });
  assert.equal(output.text?.length, 4000);
  assert.deepEqual(
    output.fields.map((field) => field.label),
    ["Title", "Count", "Done", "Owner", "List", "Note"],
  );
  assert.equal(output.fields[3]!.value, "Name: TEST Anna");
  assert.equal(output.fields[4]!.items?.length, 8);
  assert.equal(output.fields[4]!.more, 3);
  assert.equal(output.fields[5]!.value, "[redacted authorization]");
  assert.equal(output.truncated, true);
  assert.equal(output.redacted, true);
  assert(!JSON.stringify(output).includes("TEST-key"));
  assert(!JSON.stringify(output).includes("TEST-pw"));
  // Secrets are hidden by key words and by their shape in any value.
  const secrets = hubOutput({
    summary: "TEST done",
    sessionId: "TEST-session",
    pinCode: "1234",
    otp: "654321",
    jwt: "TEST-jwt",
    cookie: "TEST-cookie",
    shipping: "TEST parcel",
    tokens: 5,
    found: [
      "TEST plain",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
      "ghp_" + "a".repeat(36),
      "gho_" + "b".repeat(36),
      "xoxb-1234567890-abcdef",
      "AKIA" + "ABCDEFGHIJKLMNOP",
      "glpat-" + "c".repeat(20),
      "sk-proj-" + "d".repeat(24),
    ],
    header: "Authorization: Bearer TESTtokenvalue123",
  });
  const shown = JSON.stringify(secrets);
  for (const hidden of [
    "TEST-session",
    "1234",
    "654321",
    "TEST-jwt",
    "TEST-cookie",
    "eyJhbGci",
    "ghp_",
    "gho_",
    "xoxb-",
    "AKIAABCD",
    "glpat-",
    "sk-proj-",
    "TESTtokenvalue123",
  ])
    assert(!shown.includes(hidden), hidden);
  assert(shown.includes("TEST parcel"));
  assert(shown.includes("TEST plain"));
  assert.equal(secrets.redacted, true);
  // A single text field is the readable text.
  assert.deepEqual(hubOutput({ anything: "TEST only" }), {
    text: "TEST only",
    fields: [],
    truncated: false,
    redacted: false,
  });
});

const schema = (properties: Record<string, ProcessData>): OutputSchema => ({
  type: "object",
  properties,
  required: [],
  additionalProperties: false,
});
const stages = schema({
  stages: {
    type: "array",
    items: schema({ label: { type: "string" }, value: { type: "number" } }),
  },
});
const layoutsOf = (items: { id: string; layout: unknown }[]) =>
  Object.fromEntries(items.map((item) => [item.id, item.layout]));

test("dashboard grid: places, moves, resizes and packs without overlaps", () => {
  const items = [
    { id: "a", layout: { x: 0, y: 0, w: 6, h: 4 } },
    { id: "b", layout: { x: 6, y: 0, w: 6, h: 4 } },
    { id: "c", layout: { x: 0, y: 4, w: 4, h: 2 } },
  ];
  assert.deepEqual(
    hubPlace(
      items.map((item) => item.layout),
      { w: 4, h: 2 },
    ),
    { x: 4, y: 4, w: 4, h: 2 },
  );
  // Dropping "c" onto "a" pushes "a" down; nothing overlaps afterwards.
  const moved = hubMove(items, "c", { x: 0, y: 0, w: 4, h: 2 });
  const at = layoutsOf(moved);
  assert.deepEqual(at.c, { x: 0, y: 0, w: 4, h: 2 });
  assert.deepEqual(at.a, { x: 0, y: 2, w: 6, h: 4 });
  for (const [index, item] of moved.entries())
    for (const other of moved.slice(index + 1))
      assert(!hubOverlaps(item.layout, other.layout), `${item.id} ${other.id}`);
  // Widening "a" over "b" moves "b" below it.
  const wide = layoutsOf(hubMove(items, "a", { x: 0, y: 0, w: 12, h: 4 }));
  assert.deepEqual(wide.b, { x: 6, y: 4, w: 6, h: 4 });
  // Gaps float up.
  assert.deepEqual(
    layoutsOf(hubCompact([{ id: "z", layout: { x: 3, y: 7, w: 2, h: 2 } }])).z,
    { x: 3, y: 0, w: 2, h: 2 },
  );
  // Packing keeps the reading order it is given.
  const packed = hubPack([
    { id: "wide", w: 8, h: 2 },
    { id: "small", w: 3, h: 2 },
    { id: "next", w: 3, h: 2 },
  ]);
  assert.deepEqual(
    packed.map((item) => [item.id, item.layout.x, item.layout.y]),
    [
      ["wide", 0, 0],
      ["small", 8, 0],
      ["next", 0, 2],
    ],
  );
  // Sizes stay inside the grid and above each view's minimum.
  assert.deepEqual(hubFitLayout({ x: 11, y: -2, w: 1, h: 30 }, "chart"), {
    x: 9,
    y: 0,
    w: 3,
    h: 10,
  });
  assert.deepEqual(
    hubDragLayout(
      { x: 0, y: 0, w: 4, h: 3 },
      "resize",
      { x: 170, y: 95 },
      { width: 84, height: 96 },
      "list",
    ),
    { x: 0, y: 0, w: 6, h: 4 },
  );
  assert.equal(
    hubLayoutIssue([
      { layout: { x: 0, y: 0, w: 6, h: 4 }, type: "chart" },
      { layout: { x: 5, y: 0, w: 4, h: 4 }, type: "list" },
    ]),
    "hub_layout_invalid",
  );
  assert.equal(
    hubLayoutIssue([{ layout: { x: 0, y: 0, w: 2, h: 2 }, type: "table" }]),
    "hub_layout_invalid",
  );
});

test("views follow the frozen output schema; defaults pick what fits", () => {
  const count = hubFields(schema({ count: { type: "integer" } }))!;
  assert.deepEqual(hubDefaultView("process", count), {
    type: "number",
    field: "count",
  });
  const chart = hubFields(stages)!;
  assert.deepEqual(hubDefaultView("process", chart), {
    type: "chart",
    chart: "bar",
    field: "stages",
    x: "label",
    y: "value",
  });
  assert.deepEqual(hubViewChoices("process", chart), [
    "chart",
    "list",
    "table",
    "summary",
  ]);
  const rows = hubFields(
    schema({
      deals: {
        type: "array",
        items: schema({
          name: { type: "string" },
          stage: { type: "string" },
          amount: { type: "number" },
          owner: { type: "string" },
          apiKey: { type: "string" },
        }),
      },
    }),
  )!;
  // Sensitive keys never become fields.
  assert.deepEqual(
    rows[0]!.fields!.map((field) => field.key),
    ["name", "stage", "amount", "owner"],
  );
  assert.equal(hubDefaultView("process", rows).type, "table");
  const day = hubFields(
    schema({
      summary: { type: "string" },
      meetings: { type: "array", items: { type: "string" } },
    }),
  )!;
  assert.deepEqual(hubDefaultView("process", day), { type: "summary" });
  assert.deepEqual(hubDefaultView("tasks", null), { type: "tasks" });
  // Checked against the fields: types, keys and the item fields of arrays.
  const invalid = { error: "hub_view_invalid" };
  assert.deepEqual(
    hubResolveView({ type: "number", field: "summary" }, "process", day),
    invalid,
  );
  assert.deepEqual(
    hubResolveView({ type: "text", field: "missing" }, "process", day),
    invalid,
  );
  assert.deepEqual(
    hubResolveView(
      { type: "chart", chart: "pie", field: "stages", y: "label" },
      "process",
      chart,
    ),
    invalid,
  );
  assert.deepEqual(
    hubResolveView(
      { type: "table", field: "deals", columns: [{ key: "nope" }] },
      "process",
      rows,
    ),
    invalid,
  );
  assert.deepEqual(
    hubResolveView(
      { type: "list", field: "meetings", title: "x" },
      "process",
      day,
    ),
    invalid,
  );
  assert.deepEqual(
    hubResolveView(
      { type: "number", field: "count", compare: { field: "count" } },
      "process",
      count,
    ),
    invalid,
  );
  assert.deepEqual(hubResolveView({ type: "tasks" }, "process", day), invalid);
  assert.deepEqual(hubResolveView({ type: "summary" }, "tasks", null), invalid);
  assert.deepEqual(
    hubResolveView({ type: "text", field: "summary" }, "process", null),
    { error: "hub_view_unavailable" },
  );
});

test("widget data is projected from a bounded, redacted copy of the output", () => {
  const snapshot = hubSnapshot({
    count: 1381,
    target: 1500,
    summary: "TEST token sk-abcdefghijklmnopqrstuvwxyz",
    password: "TEST-hidden",
    stages: [
      ...Array.from({ length: 30 }, (_, index) => ({
        label: `TEST stage ${index}`,
        value: index,
        session: "TEST-hidden",
      })),
      { label: "TEST no value" },
    ],
  })!;
  assert(!JSON.stringify(snapshot).includes("TEST-hidden"));
  assert(!JSON.stringify(snapshot).includes("sk-abcdefghij"));
  assert.equal(snapshot.totals.stages, 31);
  const previous = hubSnapshot({ count: 1300 });
  assert.deepEqual(
    hubWidgetData(
      { type: "number", field: "count", compare: "previous" },
      null,
      snapshot,
      previous,
    ),
    { type: "number", value: 1381, compare: { value: 1300 } },
  );
  assert.deepEqual(
    hubWidgetData(
      { type: "number", field: "count", compare: { field: "target" } },
      null,
      snapshot,
    ),
    { type: "number", value: 1381, compare: { value: 1500 } },
  );
  const chart = hubWidgetData(
    { type: "chart", chart: "bar", field: "stages", x: "label", y: "value" },
    hubFields(stages),
    snapshot,
  );
  assert(chart?.type === "chart");
  assert.equal(chart.points.length, 24);
  assert.deepEqual(chart.points[2], { label: "TEST stage 2", value: 2 });
  assert.equal(chart.more, 6);
  const table = hubWidgetData(
    { type: "table", field: "stages", columns: [{ key: "label" }] },
    hubFields(stages),
    snapshot,
  );
  assert(table?.type === "table");
  assert.deepEqual(table.columns, [{ key: "label", label: "Label" }]);
  assert.equal(table.rows.length, 20);
  assert.equal(table.more, 11);
  const list = hubWidgetData(
    { type: "list", field: "stages", title: "label", subtitle: "value" },
    null,
    snapshot,
  );
  assert(list?.type === "list");
  assert.deepEqual(list.rows[1], { title: "TEST stage 1", subtitle: "1" });
  const text = hubWidgetData(
    { type: "text", field: "summary" },
    null,
    snapshot,
  );
  assert(text?.type === "text" && text.text.includes("[redacted]"));
  // A field the output no longer has shows nothing rather than a wrong value.
  assert.equal(
    hubWidgetData({ type: "text", field: "gone" }, null, snapshot),
    null,
  );
  assert.equal(hubWidgetData({ type: "summary" }, null, snapshot), null);
});

test("agent-hub/2: add picks a view, setView and layout are checked, v1 stays the same", () => {
  const f = fixture();
  f.outputs.set("TEST-day", stages);
  f.outputs.set("TEST-company", schema({ count: { type: "integer" } }));
  let view = f.dashboard(anna, {
    type: "add",
    kind: "process",
    processId: "TEST-day",
  });
  let day = view.items.find((item) => item.processId === "TEST-day")!;
  assert.equal(day.view.type, "chart");
  assert.deepEqual(day.layout, { x: 4, y: 0, w: 6, h: 4 });
  assert.deepEqual(
    day.fields?.map((field) => field.key),
    ["stages"],
  );
  view = f.dashboard(anna, {
    type: "add",
    kind: "process",
    processId: "TEST-company",
    view: { type: "number", field: "count", unit: "firem" },
  });
  const company = view.items.find((item) => item.processId === "TEST-company")!;
  assert.deepEqual(company.view, {
    type: "number",
    field: "count",
    unit: "firem",
  });
  // The first free place for its size.
  assert.deepEqual(company.layout, { x: 0, y: 3, w: 3, h: 2 });
  // A view the output cannot fill is refused.
  assert.throws(
    () =>
      f.dashboard(anna, {
        type: "setView",
        itemId: company.id,
        view: { type: "chart", chart: "bar", field: "count" },
      }),
    code("hub_view_invalid"),
  );
  // Another chart kind on the same data; the axes are filled in.
  view = f.dashboard(anna, {
    type: "setView",
    itemId: day.id,
    view: { type: "chart", chart: "pie", field: "stages" },
  });
  day = view.items.find((item) => item.id === day.id)!;
  assert.deepEqual(day.view, {
    type: "chart",
    chart: "pie",
    field: "stages",
    x: "label",
    y: "value",
  });
  // A table needs four columns: the narrow widget grows.
  const tasks = view.items.find((item) => item.kind === "tasks")!;
  view = f.dashboard(anna, {
    type: "layout",
    items: [
      { itemId: tasks.id, layout: { x: 0, y: 0, w: 3, h: 3 } },
      { itemId: day.id, layout: { x: 3, y: 0, w: 3, h: 3 } },
      { itemId: company.id, layout: { x: 6, y: 0, w: 2, h: 2 } },
    ],
  });
  assert.deepEqual(
    view.items.map((item) => item.position),
    [0, 1, 2],
  );
  view = f.dashboard(anna, {
    type: "setView",
    itemId: day.id,
    view: { type: "table", field: "stages", columns: [{ key: "label" }] },
  });
  const grown = view.items.find((item) => item.id === day.id)!;
  assert.equal(grown.layout.w, 4);
  for (const [index, item] of view.items.entries())
    for (const other of view.items.slice(index + 1))
      assert(!hubOverlaps(item.layout, other.layout));
  // Layouts must cover every item once, fit and not overlap.
  assert.throws(
    () =>
      f.dashboard(anna, {
        type: "layout",
        items: [{ itemId: tasks.id, layout: { x: 0, y: 0, w: 3, h: 3 } }],
      }),
    code("hub_changed"),
  );
  assert.throws(
    () =>
      f.dashboard(anna, {
        type: "layout",
        items: view.items.map((item) => ({
          itemId: item.id,
          layout: { x: 0, y: 0, w: 4, h: 4 },
        })),
      }),
    code("hub_layout_invalid"),
  );
  // Petr cannot change Anna's widgets.
  assert.throws(
    () =>
      f.dashboard(petr, {
        type: "setView",
        itemId: company.id,
        view: { type: "summary" },
      }),
    code("hub_item_not_found"),
  );
  // agent-hub/1 answers in its own shape, in reading order.
  const legacy = f.command(anna, { type: "refresh", itemIds: [] }).view;
  HubViewSchema.parse(legacy);
  assert.equal(legacy.profile, HUB_PROFILE);
  assert(!("layout" in legacy.items[0]!));
  // A v1 reorder lays the grid out again in that order.
  const order = [company.id, tasks.id, day.id];
  f.command(anna, { type: "reorder", itemIds: order });
  const after = f.hub.dashboard(anna.actor, anna.scope, "cs");
  assert.deepEqual(
    [...after.items]
      .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
      .map((item) => item.id),
    order,
  );
});

test("a refresh keeps the output for the widget and the previous one for comparison", () => {
  const f = fixture();
  f.outputs.set("TEST-day", schema({ count: { type: "integer" } }));
  const added = f.dashboard(anna, {
    type: "add",
    kind: "process",
    processId: "TEST-day",
    view: { type: "number", field: "count", compare: "previous" },
  });
  const item = added.items.find((value) => value.kind === "process")!;
  assert.equal(item.data, null);
  f.run("TEST-parent-1", "TEST-anna", "TEST-day", item.id, {
    output: { count: 1300 },
  });
  f.hub.record(anna.actor, anna.scope, item.id, {
    type: "admitted",
    parentRunId: "TEST-parent-1",
  });
  f.command(anna, { type: "refresh", itemIds: [item.id] });
  f.run("TEST-parent-2", "TEST-anna", "TEST-day", item.id, {
    output: { count: 1381 },
  });
  f.hub.record(anna.actor, anna.scope, item.id, {
    type: "admitted",
    parentRunId: "TEST-parent-2",
  });
  const widget = f.hub
    .dashboard(anna.actor, anna.scope, "cs")
    .items.find((value) => value.id === item.id)!;
  assert.deepEqual(widget.data, {
    type: "number",
    value: 1381,
    compare: { value: 1300 },
  });
  // A failed refresh keeps the last good data.
  f.command(anna, { type: "refresh", itemIds: [item.id] });
  f.hub.record(anna.actor, anna.scope, item.id, {
    type: "failed",
    error: "process_step_limit",
  });
  const failed = f.hub
    .dashboard(anna.actor, anna.scope, "cs")
    .items.find((value) => value.id === item.id)!;
  assert.equal(failed.result?.status, "failed");
  assert.deepEqual(failed.data, widget.data);
});

test("hubs from before the dashboard keep their items as summary widgets in order", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=OFF;
    CREATE TABLE member(id TEXT PRIMARY KEY, "organizationId" TEXT, "userId" TEXT);
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT);
    CREATE TABLE agent_workspace_member(workspace_id TEXT, member_id TEXT);
    INSERT INTO member VALUES ('TEST-m-anna','${org}','TEST-anna');
    INSERT INTO agent_workspace VALUES ('${workspaceId}','${org}');
    CREATE TABLE agent_hub (workspace_id TEXT NOT NULL, member_id TEXT NOT NULL, user_id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id, member_id)) STRICT;
    CREATE TABLE agent_hub_item (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, member_id TEXT NOT NULL, kind TEXT NOT NULL, process_id TEXT, title TEXT NOT NULL, refresh TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL, result TEXT) STRICT;
    INSERT INTO agent_hub VALUES ('${workspaceId}','TEST-m-anna','TEST-anna',3,'2026-10-01T00:00:00.000Z');
    INSERT INTO agent_hub_item VALUES
      ('TEST-a','${workspaceId}','TEST-m-anna','process','TEST-day','TEST day','daily',1,'2026-10-01T00:00:00.000Z',NULL),
      ('TEST-t','${workspaceId}','TEST-m-anna','tasks',NULL,'Úkoly','on_open',0,'2026-10-01T00:00:00.000Z',NULL),
      ('TEST-b','${workspaceId}','TEST-m-anna','process','TEST-company','TEST company','manual',2,'2026-10-01T00:00:00.000Z',NULL);`);
  const store = new HubStore(db);
  const { items, revision } = store.read(
    { organizationId: org, workspaceId, userId: "TEST-anna" },
    "Úkoly",
  );
  assert.equal(revision, 3);
  assert.deepEqual(
    items.map((item) => [item.id, item.view.type, item.layout]),
    [
      ["TEST-t", "tasks", { x: 0, y: 0, w: 4, h: 3 }],
      ["TEST-a", "summary", { x: 4, y: 0, w: 6, h: 4 }],
      ["TEST-b", "summary", { x: 0, y: 4, w: 6, h: 4 }],
    ],
  );
  // Opening the database again changes nothing more.
  new HubStore(db);
  assert.deepEqual(
    store
      .read({ organizationId: org, workspaceId, userId: "TEST-anna" }, "Úkoly")
      .items.map((item) => item.layout),
    items.map((item) => item.layout),
  );
});
