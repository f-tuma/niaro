import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MeetingStore } from "../apps/server-identity/meeting-store";
import { ListMarkCounter } from "../apps/server-identity/list-marks";
import { MEETING_PROFILE } from "../packages/protocol/meetings";
import { HUMAN_TASK_PROFILE } from "../packages/protocol/human-tasks";
import {
  LIST_MARKS_PROFILE,
  ListMarksSchema,
} from "../packages/protocol/list-marks";
import { ClientSession } from "../packages/client-core/session";
import { replyCorrelationPath } from "../packages/protocol/reply-correlation";

// NIAR-285: the events poll carries per-person change marks of Tasks and
// Meetings, so phones read those lists after a change instead of on a timer.
const scope = {
  serverId: "TEST-server",
  connectionId: "TEST-connection",
  workspaceId: "TEST-workspace",
  userId: "TEST-user",
};
const other = { ...scope, userId: "TEST-other-user" };
const meeting = (bytes = 4) => ({
  profile: MEETING_PROFILE as typeof MEETING_PROFILE,
  id: randomUUID(),
  title: "TEST meeting",
  recordedAt: new Date().toISOString(),
  language: "cs" as const,
  mimeType: "audio/wav" as const,
  bytes,
});
const agentOrigin = {
  kind: "agent" as const,
  runId: "TEST-run",
  toolCallId: "TEST-call",
  conversationId: "TEST-chat",
};
const content = (title: string) => ({
  title,
  detail: "",
  assignee: null,
  due: null,
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "niaro-list-marks-"));
  const db = new DatabaseSync(join(root, "identity.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const store = new MeetingStore(db);
  return {
    store,
    marks: () => store.marks.read(scope),
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("marks are opaque, per person and per list, and a new process starts a new epoch", () => {
  const a = new ListMarkCounter();
  const b = new ListMarkCounter();
  const first = a.read(scope);
  assert.ok(ListMarksSchema.safeParse(first).success);
  assert.deepEqual(a.read(scope), first);
  a.bump("tasks", scope);
  assert.notEqual(a.read(scope).tasks, first.tasks);
  assert.equal(a.read(scope).meetings, first.meetings);
  assert.deepEqual(a.read(other), first, "another person's marks stay");
  // After a restart every mark differs once, so every phone reads again.
  assert.notEqual(b.read(scope).tasks, first.tasks);
  assert.notEqual(b.read(scope).meetings, first.meetings);
});

test("every change of an item moves the tasks mark; a replayed decision does not", () => {
  const f = fixture();
  try {
    const otherBefore = f.store.marks.read(other);
    let before = f.marks();
    const task = f.store.humanTasks.create(
      scope,
      "TEST-task",
      content("TEST item"),
      agentOrigin,
    );
    assert.notEqual(f.marks().tasks, before.tasks, "created");
    assert.equal(f.marks().meetings, before.meetings);
    before = f.marks();
    // Repeating the same create returns the item unchanged.
    f.store.humanTasks.create(
      scope,
      "TEST-task",
      content("TEST item"),
      agentOrigin,
    );
    assert.deepEqual(f.marks(), before, "repeated create");
    const command = {
      profile: HUMAN_TASK_PROFILE as typeof HUMAN_TASK_PROFILE,
      commandId: "TEST-command",
      idempotencyKey: "TEST-command",
      expectedRevision: task.revision,
      decision: "complete" as const,
    };
    f.store.humanTasks.command(scope, task.id, command);
    assert.notEqual(f.marks().tasks, before.tasks, "decided");
    before = f.marks();
    f.store.humanTasks.command(scope, task.id, command);
    assert.deepEqual(f.marks(), before, "replayed decision");
    const second = f.store.humanTasks.create(
      scope,
      "TEST-task-2",
      content("TEST second"),
      agentOrigin,
    );
    before = f.marks();
    f.store.humanTasks.close(scope, second.id, "TEST resolved in chat");
    assert.notEqual(f.marks().tasks, before.tasks, "closed by the agent");
    assert.deepEqual(f.store.marks.read(other), otherBefore, "another person");
  } finally {
    f.close();
  }
});

test("a meeting's creation, every saved step and its deletion move the meetings mark", async () => {
  const f = fixture();
  try {
    let before = f.marks();
    const created = f.store.create(scope, meeting());
    assert.notEqual(f.marks().meetings, before.meetings, "created");
    assert.equal(f.marks().tasks, before.tasks);
    const steps: [string, () => unknown][] = [
      [
        "uploaded",
        () =>
          f.store.append(scope, created.id, 0, new Uint8Array([1, 2, 3, 4])),
      ],
      ["renamed", () => f.store.rename(scope, created.id, "TEST renamed")],
      [
        "transcribing",
        () => f.store.update(scope, created.id, { status: "transcribing" }),
      ],
      [
        "segment",
        () =>
          f.store.putSegment(scope, created.id, {
            index: 0,
            startSeconds: 0,
            endSeconds: 60,
            text: "TEST transcript.",
            reviewReasons: [],
            transcriber: "TEST",
            analyzer: null,
            analysis: null,
          }),
      ],
      [
        "failed",
        () =>
          f.store.update(scope, created.id, {
            status: "failed",
            failure: "meeting_processing_failed",
          }),
      ],
    ];
    for (const [step, change] of steps) {
      before = f.marks();
      await change();
      assert.notEqual(f.marks().meetings, before.meetings, step);
    }
    // Deleting a meeting removes its items too: both lists move.
    f.store.humanTasks.create(scope, "TEST-meeting-task", content("TEST"), {
      kind: "meeting",
      meetingId: created.id,
      meetingTitle: "TEST renamed",
      recordDigest: "a".repeat(64),
      sources: [{ segment: 0, quote: "TEST transcript." }],
    });
    before = f.marks();
    f.store.delete(scope, created.id);
    assert.notEqual(f.marks().meetings, before.meetings, "deleted");
    assert.notEqual(f.marks().tasks, before.tasks, "its items deleted");
    // Reading never moves a mark.
    before = f.marks();
    f.store.list(scope);
    f.store.humanTasks.list(scope, "open");
    assert.deepEqual(f.marks(), before);
  } finally {
    f.close();
  }
});

test("the paired server's events poll carries the marks only when asked, and they move with tasks and meetings", async () => {
  const { mobileIntegratedHttpFixture } = await import(
    "./helpers/process-mobile-integrated-http"
  );
  const fixture = await mobileIntegratedHttpFixture();
  let client: ClientSession | undefined;
  try {
    const setup = await fixture.configure({ questions: 0, writes: 0 });
    const store = fixture.identity["meetings"];
    const headers = { Authorization: `Bearer ${setup.credential.accessToken}` };
    const events = async (path: string) => {
      const response = await fetch(`${setup.endpoint}/${path}`, { headers });
      assert.equal(response.status, 200);
      return (await response.json()) as Record<string, unknown>;
    };
    const plain = await events(replyCorrelationPath("events?after=0"));
    assert.equal("lists" in plain, false, "older clients get no new field");
    const asked = await events(
      replyCorrelationPath(
        `events?after=0&lists=${encodeURIComponent(LIST_MARKS_PROFILE)}`,
      ),
    );
    const first = ListMarksSchema.parse(asked.lists);

    client = new ClientSession(
      setup.endpoint,
      { getItem: async () => null, setItem: async () => {} },
      setup.credential,
    );
    await client.start(false);
    await client.sync();
    assert.deepEqual(client.getListMarks(), first);

    store.humanTasks.create(
      setup.credential.scope,
      "TEST-list-mark-task",
      content("TEST item from the assistant"),
      agentOrigin,
    );
    await client.sync();
    assert.notEqual(client.getListMarks()?.tasks, first.tasks);
    assert.equal(client.getListMarks()?.meetings, first.meetings);

    const afterTask = client.getListMarks()!;
    await client.createMeeting(meeting(8));
    await client.sync();
    assert.notEqual(client.getListMarks()?.meetings, afterTask.meetings);
    assert.equal(client.getListMarks()?.tasks, afterTask.tasks);
  } finally {
    client?.stop();
    await fixture.close();
  }
});
