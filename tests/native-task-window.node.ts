import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { nativeTaskQuestion, choosePeter } from "../packages/test-fixtures";
import {
  fromSnapshot,
  applyEvent,
  mergeSnapshot,
  selectTasks,
} from "../packages/client-core/store";
import type { WorkItem } from "../packages/protocol";

const scope = {
  connectionId: "account-11111111-1111-4111-8111-111111111111",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  userId: "TEST-user",
  serverId: "TEST-server",
};

function work(id: string, revision = 1): WorkItem {
  const template = nativeTaskQuestion();
  return {
    ...template,
    id,
    revision,
    native: { runId: id, revision },
    status: "running",
  };
}
function engine() {
  return new FixtureEngine(
    scope.workspaceId,
    undefined,
    undefined,
    undefined,
    scope,
  );
}
test("authoritative membership is explicit: deltas keep other tasks, windows evict natives only and unchanged windows do not churn", () => {
  const e = engine();
  const demo = { ...choosePeter().work, inputRequestIds: [] };
  e.data.snapshot.workItems.push(demo);
  e.syncNativeWork([work("TEST-A"), work("TEST-B")], true, true);
  e.syncNativeWork([work("TEST-A", 2)]);
  assert.deepEqual(
    e.snapshot().workItems.map((w) => w.id),
    [demo.id, "TEST-A", "TEST-B"],
  );
  const before = e.snapshot();
  const state = fromSnapshot("TEST", scope, before);
  const old = e
    .events(0)!
    .events.findLast(
      (event) =>
        event.type === "work_item.upserted" && event.entity.id === "TEST-B",
    )!;
  e.syncNativeWork([work("TEST-A", 2)], true, true);
  assert.deepEqual(
    e.snapshot().workItems.map((w) => w.id),
    [demo.id, "TEST-A"],
  );
  assert.equal(e.events(before.cursor), null);
  const current = mergeSnapshot(state, "TEST", e.snapshot());
  assert.equal(current.workItems["TEST-B"], undefined);
  assert.deepEqual(applyEvent(current, "TEST", old), current);
  assert.deepEqual(mergeSnapshot(current, "TEST", before), current);
  const cursor = e.snapshot().cursor;
  e.syncNativeWork([work("TEST-A", 2)], true, true);
  assert.equal(e.snapshot().cursor, cursor);
  e.syncNativeWork([work("TEST-A", 1)]);
  assert.equal(
    e.snapshot().workItems.find((w) => w.id === "TEST-A")!.native!.revision,
    2,
  );
  e.syncNativeWork([work("TEST-A", 3)]);
  const fresh = e.events(cursor)!;
  assert.equal(fresh.events.length, 1);
  assert.equal(
    applyEvent(current, "TEST", fresh.events[0]).workItems["TEST-A"]!.native!
      .revision,
    3,
  );
  e.syncNativeWork([], true, true);
  assert.deepEqual(
    e.snapshot().workItems.map((w) => w.id),
    [demo.id],
  );
});
test("native materialization stays within effective snapshot capacity across repeated400-root turnover; full delta cannot silently evict", () => {
  const e = engine();
  for (let i = 0; i < 130; i++)
    e.data.snapshot.workItems.push({
      ...choosePeter().work,
      id: `work-demo-${i}`,
      inputRequestIds: [],
    });
  for (let generation = 0; generation < 4; generation++) {
    const values = Array.from({ length: 400 }, (_, i) =>
      work(`TEST-${generation}-${i}`),
    );
    e.syncNativeWork(values, true, true);
    assert.equal(e.snapshot().workItems.length, 500);
    assert.equal(e.snapshot().workItems.filter((w) => w.native).length, 370);
    assert(e.snapshot().workItems.some((w) => w.id === values[0]!.id));
  }
  const before = e.snapshot();
  assert.throws(
    () => e.syncNativeWork([work("TEST-extra")]),
    /native_work_window_required/,
  );
  assert.deepEqual(e.snapshot(), before);
  assert.throws(
    () =>
      e.syncNativeWork([work("TEST-double"), work("TEST-double")], true, true),
    /Invalid native work window/,
  );
});
test("window removal floor is atomic before commit and durable after lost publication across two storage reopens", () => {
  const directory = mkdtempSync(join(tmpdir(), "niaro-task-window-"));
  let cut: "before_commit" | "after_commit" | undefined;
  let storage = new FixtureStorage(
    directory,
    scope.serverId,
    undefined,
    (stage) => {
      if (stage === cut) throw Error("TEST cut");
    },
  );
  try {
    storage.syncNativeWork(scope, [work("TEST-A"), work("TEST-B")], true);
    const before = storage.snapshot(scope);
    cut = "before_commit";
    assert.throws(
      () => storage.syncNativeWork(scope, [work("TEST-A", 2)], true),
      /TEST cut/,
    );
    cut = undefined;
    assert.deepEqual(storage.snapshot(scope), before);
    assert(storage.events(scope, 0));
    cut = "after_commit";
    assert.throws(
      () => storage.syncNativeWork(scope, [work("TEST-A", 2)], true),
      /TEST cut/,
    );
    cut = undefined;
    const committed = storage.snapshot(scope);
    assert(committed.cursor > before.cursor);
    assert.equal(storage.events(scope, before.cursor), null);
    for (let i = 0; i < 2; i++) {
      storage.close();
      storage = new FixtureStorage(directory, scope.serverId);
      assert.deepEqual(storage.snapshot(scope), committed);
      assert.equal(storage.events(scope, before.cursor), null);
      assert(storage.events(scope, committed.cursor));
    }
    storage.syncNativeWork(scope, [], true);
    const empty = storage.snapshot(scope);
    assert.equal(empty.workItems.length, 0);
    storage.close();
    storage = new FixtureStorage(directory, scope.serverId);
    assert.deepEqual(storage.snapshot(scope), empty);
    assert.deepEqual(storage.events(scope, empty.cursor)?.events, []);
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("the three task filters cover every lifecycle status and preserve unsuccessful terminal work", () => {
  const statuses = [
    "queued",
    "running",
    "waiting_input",
    "waiting_approval",
    "waiting_system",
    "scheduled",
    "succeeded",
    "failed",
    "cancelled",
    "expired",
    "superseded",
  ] as const;
  const e = engine();
  e.syncNativeWork(
    statuses.map((status, i) => ({ ...work(`TEST-status-${i}`), status })),
    true,
    true,
  );
  const state = fromSnapshot("TEST", scope, e.snapshot());
  assert.deepEqual(
    selectTasks(state, "allTasks").map((w) => w.status),
    statuses,
  );
  assert.deepEqual(
    selectTasks(state, "completed").map((w) => w.status),
    ["succeeded", "failed", "cancelled", "expired", "superseded"],
  );
  assert.deepEqual(
    selectTasks(state, "needsInput").map((w) => w.status),
    ["waiting_input", "waiting_approval"],
  );
  assert.deepEqual(
    selectTasks(state, "upcoming").map((w) => w.status),
    ["queued", "running", "waiting_system", "scheduled"],
  );
  const visible = (["needsInput", "upcoming", "completed"] as const).flatMap(
    (tab) => selectTasks(state, tab),
  );
  assert.equal(visible.length, statuses.length);
  assert.equal(new Set(visible.map((w) => w.id)).size, statuses.length);
});
