import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { LoopsStore } from "../apps/server-identity/loops";
import { ServiceCatalogStore } from "../apps/server-identity/service-catalog";
import {
  LoopFiltersSchema,
  LoopQuery,
  type LoopStatus,
} from "../packages/protocol/loops";

const id = (value: string) =>
  createHash("sha256").update(`TEST-loop-filters-${value}`).digest("hex");
const day = (n: number) =>
  new Date(
    Date.parse("2026-10-01T08:00:00.000Z") + n * 86_400_000,
  ).toISOString();
const trace = (status: LoopStatus, startedAt: string) => ({
  startedAt,
  finishedAt: status === "running" ? null : startedAt,
  status,
  steps: [],
  truncated: false,
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organization(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT NOT NULL) STRICT;
    CREATE TABLE member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT) STRICT;
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,name TEXT NOT NULL) STRICT;
    INSERT INTO organization VALUES('org-a'),('org-b');
    INSERT INTO user VALUES('alice','TEST Alice'),('bob','TEST Bob'),('carol','TEST Carol');
    INSERT INTO agent_workspace VALUES('workspace-a','org-a','TEST One'),('workspace-a2','org-a','TEST Two'),('workspace-b','org-b','TEST Foreign');
    CREATE TABLE agent_service_process_version(process_id TEXT NOT NULL,version INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(process_id,version)) STRICT;
    CREATE TABLE agent_service_process_run(run_id TEXT PRIMARY KEY,process_id TEXT NOT NULL,version INTEGER NOT NULL,workspace_id TEXT NOT NULL,user_id TEXT NOT NULL) STRICT;
    CREATE TABLE agent_process_start_command(run_id TEXT PRIMARY KEY,data TEXT NOT NULL) STRICT;`);
  const catalog = new ServiceCatalogStore(db, "TEST-loop-filters-secret", []);
  const store = new LoopsStore(db, catalog);
  const insert = db.prepare("INSERT INTO agent_service_turn VALUES (?,?,?,?)");
  const chat = (
    name: string,
    options: {
      conversationId?: string;
      status?: LoopStatus;
      at?: string;
      user?: string;
      workspace?: string;
      text?: string;
    } = {},
  ) => {
    const turnId = id(name);
    insert.run(
      turnId,
      options.workspace ?? "workspace-a",
      options.user ?? "alice",
      JSON.stringify({
        kind: "mastra-1",
        runId: turnId,
        text: options.text ?? `TEST chat ${name}`,
        goal: options.text ?? `TEST chat ${name}`,
        modelCalls: 1,
        inference: 1,
        ...(options.conversationId
          ? { conversationId: options.conversationId }
          : {}),
        clock: { referenceNow: options.at ?? day(0) },
        trace: trace(options.status ?? "succeeded", options.at ?? day(0)),
        ...(options.status === "failed"
          ? {}
          : { answer: { reply: "TEST ok" } }),
      }),
    );
    return turnId;
  };
  const process = (
    name: string,
    options: {
      processId?: string;
      version?: number;
      origin?: "command" | "meeting";
      conversationId?: string;
      corroborated?: boolean;
      status?: LoopStatus;
      at?: string;
      user?: string;
      workspace?: string;
      title?: string;
    } = {},
  ) => {
    const turnId = id(name),
      processId = options.processId ?? "TEST-process-weekly",
      version = options.version ?? 1,
      workspace = options.workspace ?? "workspace-a",
      user = options.user ?? "alice",
      digest = createHash("sha256")
        .update(`${processId}:${version}`)
        .digest("hex"),
      runId = `TEST-run-${name}`;
    insert.run(
      turnId,
      workspace,
      user,
      JSON.stringify({
        kind: "service-process-1",
        runId,
        processId,
        version,
        artifactDigest: digest,
        text: options.title ?? "TEST Weekly pipeline",
        inference: 1,
        operations: [],
        receipts: [],
        trace: trace(options.status ?? "succeeded", options.at ?? day(0)),
      }),
    );
    if (options.corroborated === false) return turnId;
    db.prepare(
      "INSERT OR IGNORE INTO agent_service_process_version VALUES (?,?,?)",
    ).run(processId, version, digest);
    db.prepare("INSERT INTO agent_service_process_run VALUES (?,?,?,?,?)").run(
      turnId,
      processId,
      version,
      workspace,
      user,
    );
    db.prepare("INSERT INTO agent_process_start_command VALUES (?,?)").run(
      turnId,
      JSON.stringify({
        receipt: {
          status: "admitted",
          parentRunId: turnId,
          runId,
          processId,
          version,
          artifactDigest: digest,
          commandId: `TEST-command-${name}`,
          receiptId: `TEST-admission-${name}`,
          origin: {
            type: options.origin ?? "command",
            conversationId: options.conversationId ?? `chat-${name}`,
          },
        },
        scope: { userId: user, workspaceId: workspace },
      }),
    );
    return turnId;
  };
  const ids = (query: Partial<Parameters<LoopsStore["page"]>[0]>) =>
    store
      .page({ organizationId: "org-a", ...query })
      .entries.map((entry) => entry.id);
  return { db, store, chat, process, ids };
}

test("run filters: process, version, person, origin, status and date go through the server", () => {
  const f = fixture();
  try {
    const plain = f.chat("plain", { conversationId: "chat-1", at: day(0) });
    const hubChat = f.chat("hub-chat", {
      conversationId: "chat-hub-item-1",
      at: day(1),
    });
    const fromPage = f.process("from-page", { version: 1, at: day(2) });
    const fromMeeting = f.process("from-meeting", {
      version: 2,
      origin: "meeting",
      at: day(3),
      user: "bob",
    });
    const fromHub = f.process("from-hub", {
      version: 3,
      conversationId: "chat-hub-item-2",
      status: "failed",
      at: day(4),
    });
    const other = f.process("other-process", {
      processId: "TEST-process-other",
      title: "TEST Other process",
      at: day(5),
    });
    const failedChat = f.chat("failed-chat", {
      status: "failed",
      at: day(6),
      user: "bob",
    });
    assert.deepEqual(f.ids({ processId: "TEST-process-weekly" }), [
      fromHub,
      fromMeeting,
      fromPage,
    ]);
    assert.deepEqual(
      f.ids({ processId: "TEST-process-weekly", version: "3" }),
      [fromHub],
    );
    assert.deepEqual(f.ids({ actorId: "bob" }), [failedChat, fromMeeting]);
    assert.deepEqual(f.ids({ origin: "chat" }), [failedChat, plain]);
    assert.deepEqual(f.ids({ origin: "hub" }), [fromHub, hubChat]);
    assert.deepEqual(f.ids({ origin: "meeting" }), [fromMeeting]);
    assert.deepEqual(f.ids({ origin: "processes" }), [other, fromPage]);
    assert.deepEqual(f.ids({ status: "failed" }), [failedChat, fromHub]);
    assert.deepEqual(f.ids({ from: day(3), to: day(5) }), [
      fromHub,
      fromMeeting,
    ]);
    // "All failed runs of Weekly pipeline v3 this week."
    assert.deepEqual(
      f.ids({
        processId: "TEST-process-weekly",
        version: "3",
        status: "failed",
        from: day(2),
      }),
      [fromHub],
    );
    const page = f.store.page({ organizationId: "org-a", origin: "meeting" });
    assert.equal(page.entries[0]!.origin, "meeting");
    assert.equal(page.entries[0]!.process?.version, 2);
    assert.equal(
      f.store
        .page({ organizationId: "org-a" })
        .entries.find((entry) => entry.id === plain)?.origin,
      "chat",
    );
  } finally {
    f.db.close();
  }
});

test("filters never select a run by something the list does not show", () => {
  const f = fixture();
  try {
    const shown = f.process("shown", { at: day(0) });
    // The journal claims a process, but no pin corroborates it: the list shows
    // the run without process or origin, so no filter may pick it by them.
    const claimed = f.process("claimed", {
      processId: "TEST-process-secret",
      corroborated: false,
      at: day(1),
    });
    const foreign = f.process("foreign", {
      workspace: "workspace-b",
      user: "carol",
      at: day(2),
    });
    const all = f.store.page({ organizationId: "org-a" }).entries;
    assert.deepEqual(
      all.map((entry) => entry.id),
      [claimed, shown],
    );
    assert.equal(all[0]!.process, undefined);
    assert.equal(all[0]!.origin, undefined);
    assert.deepEqual(f.ids({ processId: "TEST-process-secret" }), []);
    for (const origin of ["hub", "meeting", "processes"] as const)
      assert(!f.ids({ origin }).includes(claimed), origin);
    // Another organization's run never matches, even by its exact process.
    assert.deepEqual(f.ids({ processId: "TEST-process-weekly" }), [shown]);
    assert.deepEqual(f.ids({ actorId: "carol" }), []);
    assert.deepEqual(
      f.store
        .page({ organizationId: "org-b", actorId: "carol" })
        .entries.map((entry) => entry.id),
      [foreign],
    );
    const choices = LoopFiltersSchema.parse(
      f.store.filters({ organizationId: "org-a" }),
    );
    assert.deepEqual(
      choices.processes.map((process) => process.processId),
      ["TEST-process-weekly"],
    );
    assert.deepEqual(
      choices.people.map((person) => person.actorId),
      ["alice"],
    );
    assert.deepEqual(
      f.store.filters({ organizationId: "org-a", workspaceId: "workspace-a2" })
        .processes,
      [],
    );
  } finally {
    f.db.close();
  }
});

test("redaction applies to filtered results and to filter choices", () => {
  const f = fixture();
  try {
    const secret = "sk-TESTabcdefghijklmnopqrstuvwxyz0123";
    const run = f.process("secret-title", {
      title: `TEST Weekly pipeline api_key=${secret} Bearer TESTtoken123456`,
      status: "failed",
      at: day(1),
    });
    const chat = f.chat("secret-chat", {
      text: `TEST look up https://user:pass@example.test/a?token=${secret}`,
      at: day(2),
      status: "failed",
    });
    const filtered = f.store.page({
      organizationId: "org-a",
      status: "failed",
      from: day(0),
    });
    assert.deepEqual(
      filtered.entries.map((entry) => entry.id),
      [chat, run],
    );
    const byProcess = f.store.page({
      organizationId: "org-a",
      processId: "TEST-process-weekly",
      version: "1",
      origin: "processes",
    });
    assert.deepEqual(
      byProcess.entries.map((entry) => entry.id),
      [run],
    );
    const choices = f.store.filters({ organizationId: "org-a" });
    for (const value of [filtered, byProcess, choices]) {
      const text = JSON.stringify(value);
      assert(!text.includes(secret), text);
      assert(!text.includes("TESTtoken123456"), text);
      assert(!text.includes("user:pass"), text);
    }
    assert.match(byProcess.entries[0]!.request, /\[redacted/);
    assert.match(choices.processes[0]!.name, /\[redacted/);
  } finally {
    f.db.close();
  }
});

test("filtered pages keep stable cursors and continue past runs that do not match", () => {
  const f = fixture();
  try {
    const matching: string[] = [];
    for (let i = 0; i < 120; i++) {
      if (i % 2) matching.push(f.chat(`mixed-${i}`, { user: "bob" }));
      else f.chat(`mixed-${i}`);
    }
    const first = f.store.page({ organizationId: "org-a", actorId: "bob" });
    assert.deepEqual(
      first.entries.map((entry) => entry.id),
      matching.slice(10).reverse(),
    );
    assert(first.nextBefore);
    const second = f.store.page({
      organizationId: "org-a",
      actorId: "bob",
      before: first.nextBefore,
    });
    assert.deepEqual(
      second.entries.map((entry) => entry.id),
      matching.slice(0, 10).reverse(),
    );
    assert.equal(second.nextBefore, null);

    // Many uncorroborated runs that only look like the process: a page may
    // end empty, but its cursor still leads to the older match.
    const g = fixture();
    try {
      const old = g.process("old-real", { at: day(0) });
      g.db.exec("BEGIN");
      for (let i = 0; i < 5_100; i++)
        g.process(`fake-${i}`, { corroborated: false, at: day(1) });
      g.db.exec("COMMIT");
      const empty = g.store.page({
        organizationId: "org-a",
        processId: "TEST-process-weekly",
      });
      assert.deepEqual(empty.entries, []);
      assert(empty.nextBefore);
      const next = g.store.page({
        organizationId: "org-a",
        processId: "TEST-process-weekly",
        before: empty.nextBefore,
      });
      assert.deepEqual(
        next.entries.map((entry) => entry.id),
        [old],
      );
      assert.equal(next.nextBefore, null);
    } finally {
      g.db.close();
    }
  } finally {
    f.db.close();
  }
});

test("run filter queries are strict", () => {
  const base = { organizationId: "org-a" };
  for (const query of [
    { ...base, version: "2" },
    { ...base, processId: "TEST-p", version: "0" },
    { ...base, origin: "email" },
    { ...base, actorId: "not an id!" },
    { ...base, from: "2026-10-02" },
    { ...base, from: day(2), to: day(1) },
    { ...base, from: day(1), to: day(1) },
    { ...base, unknown: "x" },
  ])
    assert.equal(
      LoopQuery.safeParse(query).success,
      false,
      JSON.stringify(query),
    );
  assert(
    LoopQuery.safeParse({
      ...base,
      processId: "TEST-p",
      version: "3",
      actorId: "alice",
      origin: "hub",
      from: day(0),
      to: day(7),
    }).success,
  );
});
