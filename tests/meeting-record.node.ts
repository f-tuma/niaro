import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MeetingStore } from "../apps/server-identity/meeting-store";
import { IdentityError } from "../apps/server-identity/error";
import { assertMeetingProcessOrigin } from "../apps/server-identity/meeting-process-origin";
import {
  MeetingProcessor,
  type MeetingProcessingAccess,
} from "../apps/server-identity/meeting-processing";
import {
  MEETING_PROFILE,
  isAutomaticMeetingTitle,
  shortMeetingTitle,
  type MeetingSegment,
} from "../packages/protocol/meetings";
import { HUMAN_TASK_PROFILE } from "../packages/protocol/human-tasks";
import { HumanTaskStore } from "../apps/server-identity/human-task-store";
import {
  validateMeetingSynthesis,
  type MeetingSynthesis,
} from "../packages/protocol/meeting-record";
import {
  meetingProcessInitialInput,
  meetingProcessSourceOptions,
} from "../packages/protocol/meeting-process-input";
import type { ProcessData } from "../packages/protocol/service-processes";
import { encodeWav } from "../packages/audio/analysis";
const scope = {
  serverId: "TEST-server",
  connectionId: "TEST-connection",
  workspaceId: "TEST-workspace",
  userId: "TEST-user",
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "niaro-record-test-"));
  const db = new DatabaseSync(join(root, "identity.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const store = new MeetingStore(db);
  return {
    store,
    db,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const recordedAt = new Date().toISOString();
async function sealed(
  f: ReturnType<typeof fixture>,
  seconds: number,
  title = "TEST planning",
) {
  const audio = encodeWav(new Float32Array(8000 * seconds), 8000);
  const id = randomUUID();
  f.store.create(scope, {
    profile: MEETING_PROFILE,
    id,
    title,
    recordedAt,
    language: "cs",
    mimeType: "audio/wav",
    bytes: audio.length,
  });
  for (let at = 0; at < audio.length; at += 262144)
    f.store.append(scope, id, at, audio.slice(at, at + 262144));
  f.store.seal(scope, id, await f.store.hash(scope, id));
  f.store.update(scope, id, { durationSeconds: seconds });
  return id;
}
function segment(index: number, text: string): MeetingSegment {
  return {
    index,
    startSeconds: index * 60,
    endSeconds: (index + 1) * 60,
    text,
    reviewReasons: [],
    transcriber: "TEST/STT",
    analyzer: null,
    analysis: null,
  };
}
const synthesis: MeetingSynthesis = {
  summary: "Připravíme nabídku.",
  summarySources: [{ segment: 0, quote: "Připravíme nabídku." }],
  points: [],
  tasks: [
    {
      text: "Připravit nabídku",
      assignee: "Anna",
      due: "pátek",
      sources: [
        { segment: 0, quote: "Připravíme nabídku." },
        { segment: 1, quote: "Anna to převezme, termín je pátek." },
      ],
    },
  ],
  overflow: false,
};
const command = (
  decision: "complete" | "remove" | "reopen",
  revision: number,
): import("../packages/protocol/human-tasks").HumanTaskCommand => ({
  profile: HUMAN_TASK_PROFILE,
  commandId: randomUUID(),
  idempotencyKey: randomUUID(),
  expectedRevision: revision,
  decision,
});
async function settled(check: () => boolean) {
  const until = Date.now() + 15000;
  while (!check()) {
    assert(Date.now() < until, "TEST processing timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}
test("one continuous transcript and atomic whole record create scoped open items; replay preserves later decisions", async () => {
  const f = fixture();
  try {
    const id = await sealed(f, 780);
    for (let i = 0; i < 13; i++)
      f.store.putSegment(
        scope,
        id,
        segment(
          i,
          i === 0
            ? "Připravíme nabídku."
            : i === 1
              ? "Anna to převezme, termín je pátek."
              : `Část ${i}.`,
        ),
      );
    const before = f.store.record(scope, id);
    assert(before.transcriptComplete);
    assert(before.transcript.includes("Část 12."));
    assert(!before.transcript.includes("\n"));
    assert.equal(before.analysis, null);
    const record = f.store.publishRecord(scope, id, synthesis, "TEST/Mastra");
    assert.equal(record.meeting.status, "ready");
    assert.equal(record.humanTaskIds.length, 1);
    const taskId = record.humanTaskIds[0]!;
    const task = f.store.humanTasks.get(scope, taskId);
    assert.equal(task.status, "open");
    assert.equal(task.resolution, null);
    assert.equal(task.origin.kind, "meeting");
    assert.equal(f.store.humanTasks.list(scope, "open").counts.open, 1);
    const complete = command("complete", 1);
    const done = f.store.humanTasks.command(scope, taskId, complete);
    assert.equal(done.revision, 2);
    assert.equal(done.status, "done");
    assert.equal(done.resolution?.by, "user");
    const reopened = f.store.humanTasks.command(
      scope,
      taskId,
      command("reopen", 2),
    );
    assert.equal(reopened.status, "open");
    assert.equal(reopened.resolution, null);
    assert.equal(
      f.store.humanTasks.command(scope, taskId, complete).revision,
      2,
      "original receipt before current CAS",
    );
    f.store.publishRecord(scope, id, synthesis, "TEST/Mastra");
    assert.equal(f.store.humanTasks.get(scope, taskId).revision, 3);
    assert.equal(f.store.humanTasks.list(scope, "open").tasks.length, 1);
    assert.equal(f.store.humanTasks.list(scope, "done").tasks.length, 0);
    assert.throws(
      () =>
        f.store.humanTasks.command(scope, taskId, {
          ...complete,
          decision: "remove",
        }),
      /human_task_conflict/,
    );
    assert.throws(
      () => f.store.humanTasks.command(scope, taskId, command("complete", 2)),
      /human_task_revision_conflict/,
    );
    for (const key of Object.keys(scope))
      assert.throws(
        () => f.store.humanTasks.get({ ...scope, [key]: "TEST-other" }, taskId),
        /human_task_not_found/,
      );
    f.store.delete(scope, id);
    assert.equal(f.store.humanTasks.list(scope, "open").tasks.length, 0);
    assert.throws(
      () => f.store.humanTasks.command(scope, taskId, complete),
      /human_task_not_found/,
    );
  } finally {
    f.close();
  }
});

test("meeting process sources prefill only compatible fields and are revalidated against the scoped record", async () => {
  const f = fixture();
  try {
    const id = await sealed(f, 120, "TEST process source");
    f.store.putSegment(scope, id, segment(0, "Připravíme nabídku."));
    f.store.putSegment(
      scope,
      id,
      segment(1, "Anna to převezme, termín je pátek."),
    );
    const record = f.store.publishRecord(
      scope,
      id,
      {
        ...synthesis,
        points: [
          {
            text: "Prepare the offer",
            sources: [{ segment: 0, quote: "Připravíme nabídku." }],
          },
        ],
      },
      "TEST/Mastra",
    );
    const schema: ProcessData = {
      type: "object",
      properties: {
        summary: { type: "string" },
        points: { type: "array", items: { type: "string" } },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              assignee: { type: "string" },
              due: { type: "string" },
            },
            required: ["text"],
            additionalProperties: false,
          },
        },
        proposal: {
          type: "object",
          properties: {
            text: { type: "string" },
            assignee: { type: "string" },
            due: { type: "string" },
            sources: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  segment: { type: "integer" },
                  quote: { type: "string" },
                },
                required: ["segment", "quote"],
                additionalProperties: false,
              },
            },
          },
          required: ["text", "sources"],
          additionalProperties: false,
        },
        count: { type: "integer" },
      },
      required: ["summary", "count"],
      additionalProperties: false,
    };
    const selectedTaskId = record.humanTaskIds[0]!;
    const options = meetingProcessSourceOptions(record, schema, selectedTaskId);
    assert.deepEqual(options.summary, ["summary", "transcript"]);
    assert.deepEqual(options.points, ["points"]);
    assert.deepEqual(options.tasks, ["tasks"]);
    assert.deepEqual(options.proposal, ["selectedTask"]);
    assert.equal(options.count, undefined);

    const sourceBindings = {
      summary: "summary",
      points: "points",
      tasks: "tasks",
      proposal: "selectedTask",
    } as const;
    const selectedTask = { id: selectedTaskId, revision: 1 };
    const origin = {
      type: "meeting" as const,
      conversationId: "TEST-chat",
      requestId: "TEST-process-input",
      meetingId: id,
      recordDigest: record.recordDigest!,
      selectedTask,
      sourceBindings,
    };
    const input = meetingProcessInitialInput(
      record,
      schema,
      sourceBindings,
      origin,
    );
    assert.equal(input.summary, synthesis.summary);
    assert.deepEqual(input.points, ["Prepare the offer"]);
    assert.deepEqual(input.tasks, [
      { text: "Připravit nabídku", assignee: "Anna", due: "pátek" },
    ]);
    assert.deepEqual(input.proposal, {
      text: "Připravit nabídku",
      assignee: "Anna",
      due: "pátek",
      sources: [
        { segment: 0, quote: "Připravíme nabídku." },
        { segment: 1, quote: "Anna to převezme, termín je pátek." },
      ],
    });
    assert.equal(
      assertMeetingProcessOrigin(
        (currentScope, meetingId) => f.store.record(currentScope, meetingId),
        scope,
        origin,
        schema,
        (currentScope, taskId) => f.store.humanTasks.get(currentScope, taskId),
      ).recordDigest,
      record.recordDigest,
    );
    const readRecord = (currentScope: typeof scope, meetingId: string) =>
      f.store.record(currentScope, meetingId);
    const readTask = (currentScope: typeof scope, taskId: string) =>
      f.store.humanTasks.get(currentScope, taskId);
    assert.throws(
      () =>
        assertMeetingProcessOrigin(
          readRecord,
          scope,
          { ...origin, selectedTask: undefined },
          schema,
          readTask,
        ),
      /process_origin_changed/,
    );
    assert.throws(
      () =>
        assertMeetingProcessOrigin(
          readRecord,
          scope,
          { ...origin, selectedTask: { ...selectedTask, revision: 2 } },
          schema,
          readTask,
        ),
      /process_origin_changed/,
    );
    assert.throws(
      () =>
        assertMeetingProcessOrigin(
          readRecord,
          scope,
          origin,
          schema,
          (currentScope, taskId) =>
            f.store.humanTasks.get(
              { ...currentScope, userId: "TEST-other" },
              taskId,
            ),
        ),
      /process_origin_changed/,
    );
    assert.throws(
      () =>
        assertMeetingProcessOrigin(
          (currentScope, meetingId) => f.store.record(currentScope, meetingId),
          scope,
          { ...origin, sourceBindings: { summary: "tasks" } },
          schema,
          (currentScope, taskId) =>
            f.store.humanTasks.get(currentScope, taskId),
        ),
      /process_input_invalid/,
    );
    assert.throws(
      () =>
        assertMeetingProcessOrigin(
          (currentScope, meetingId) => f.store.record(currentScope, meetingId),
          scope,
          { ...origin, recordDigest: "b".repeat(64) },
          schema,
        ),
      /process_origin_changed/,
    );
    f.store.humanTasks.close(scope, selectedTaskId, "TEST closed proposal");
    assert.throws(
      () =>
        assertMeetingProcessOrigin(
          (currentScope, meetingId) => f.store.record(currentScope, meetingId),
          scope,
          origin,
          schema,
          (currentScope, taskId) =>
            f.store.humanTasks.get(currentScope, taskId),
        ),
      /process_origin_changed/,
    );
  } finally {
    f.close();
  }
});
test("publication rollback cannot expose half a task list or reset an older ready record", async () => {
  const f = fixture();
  try {
    const id = await sealed(f, 120);
    f.store.putSegment(scope, id, segment(0, "Připravíme nabídku."));
    f.store.putSegment(
      scope,
      id,
      segment(1, "Anna to převezme, termín je pátek."),
    );
    f.db.exec(
      "CREATE TRIGGER TEST_fail_human BEFORE INSERT ON niaro_human_task WHEN NEW.id LIKE '%:1' BEGIN SELECT RAISE(ABORT,'TEST publication failure'); END",
    );
    assert.throws(
      () =>
        f.store.publishRecord(
          scope,
          id,
          {
            ...synthesis,
            tasks: [
              synthesis.tasks[0]!,
              { ...synthesis.tasks[0]!, text: "Další úkol" },
            ],
          },
          "TEST",
        ),
      /TEST publication failure/,
    );
    assert.equal(f.store.record(scope, id).analysis, null);
    assert.equal(f.store.humanTasks.list(scope, "open").tasks.length, 0);
    assert.equal(f.store.get(scope, id).status, "sealed");
    f.db.exec("DROP TRIGGER TEST_fail_human");
    const ready = f.store.publishRecord(scope, id, synthesis, "TEST");
    assert(ready.analysis);
    assert.throws(
      () =>
        f.store.putSegment(
          { ...scope, userId: "TEST-other" },
          id,
          segment(0, "changed"),
        ),
      /meeting_not_found/,
    );
  } finally {
    f.close();
  }
});
test("whole source validation accepts cross-excerpt owners, clears invented owners, drops invented quotes and fails only on overflow", () => {
  const input = {
    segments: [
      { index: 0, text: "Připravíme nabídku." },
      { index: 1, text: "Anna to převezme, termín je pátek." },
    ],
  };
  const valid = validateMeetingSynthesis(synthesis, input);
  assert.equal(valid.version, 2);
  assert.equal(valid.summary, synthesis.summary);
  assert.deepEqual(valid.summarySources, synthesis.summarySources);
  assert.deepEqual(valid.tasks[0]!.sources, synthesis.tasks[0]!.sources);
  assert.equal(valid.tasks[0]!.assignee, "Anna");
  assert.equal(valid.tasks[0]!.owner, "Anna");
  assert.equal(valid.tasks[0]!.due, "pátek");
  assert.equal(valid.tasks[0]!.at, 0);
  assert.deepEqual(valid.decisions, []);
  assert.deepEqual(valid.openQuestions, []);
  // Validating a validated result changes nothing.
  assert.deepEqual(validateMeetingSynthesis(valid, input), valid);
  assert.throws(
    () => validateMeetingSynthesis({ ...synthesis, overflow: true }, input),
    /meeting_consolidation_limit/,
  );
  const invented = validateMeetingSynthesis(
    { ...synthesis, tasks: [{ ...synthesis.tasks[0]!, assignee: "Petr" }] },
    input,
  );
  assert.equal(invented.tasks.length, 1);
  assert.equal(
    invented.tasks[0]!.assignee,
    null,
    "an owner nobody said is cleared",
  );
  const nowhere = validateMeetingSynthesis(
    { ...synthesis, summarySources: [{ segment: 12, quote: "invented" }] },
    input,
  );
  assert.deepEqual(nowhere.summarySources, []);
  assert.equal(nowhere.summary, synthesis.summary);
});
test("whole synthesis merges only exact repeated task identity and keeps citations", () => {
  const original = synthesis.tasks[0]!;
  const repeated = {
    ...original,
    text: "  PŘIPRAVIT   nabídku ",
    sources: [
      { segment: 1, quote: "Anna to převezme, termín je pátek." },
      {
        segment: 2,
        quote: "Anna znovu připraví nabídku, termín pátek.",
      },
    ],
  };
  const input = {
    segments: [
      { index: 0, text: "Připravíme nabídku." },
      { index: 1, text: "Anna to převezme, termín je pátek." },
      {
        index: 2,
        text: "Anna znovu připraví nabídku, termín pátek.",
      },
      { index: 3, text: "Anna připraví nabídku v pondělí." },
      { index: 4, text: "Petr to převezme, termín je pátek." },
    ],
  };
  const merged = validateMeetingSynthesis(
    { ...synthesis, tasks: [original, repeated] },
    input,
  );
  assert.equal(merged.tasks.length, 1);
  assert.deepEqual(
    merged.tasks[0]!.sources.map((source) => source.segment),
    [0, 1, 2],
  );
  const disjointEvidence = validateMeetingSynthesis(
    {
      ...synthesis,
      tasks: [
        original,
        {
          ...original,
          sources: [
            {
              segment: 2,
              quote: "Anna znovu připraví nabídku, termín pátek.",
            },
          ],
        },
      ],
    },
    input,
  );
  assert.equal(
    disjointEvidence.tasks.length,
    2,
    "matching wording without shared evidence may describe another obligation",
  );
  const tooManySources = validateMeetingSynthesis(
    {
      ...synthesis,
      tasks: [
        original,
        {
          ...original,
          sources: [
            original.sources[1]!,
            {
              segment: 2,
              quote: "Anna znovu připraví nabídku, termín pátek.",
            },
            { segment: 3, quote: "Anna připraví další nabídku." },
            { segment: 4, quote: "Anna připraví nabídku také." },
          ],
        },
      ],
    },
    {
      segments: [
        ...input.segments,
        { index: 3, text: "Anna připraví další nabídku." },
        { index: 4, text: "Anna připraví nabídku také." },
      ],
    },
  );
  assert.equal(tooManySources.tasks.length, 2);
  assert.equal(
    tooManySources.tasks[1]!.sources.length,
    4,
    "the bounded source list is never truncated to force a merge",
  );
  const distinct = validateMeetingSynthesis(
    {
      ...synthesis,
      tasks: [
        original,
        {
          ...original,
          assignee: "Petr",
          sources: [
            { segment: 4, quote: "Petr to převezme, termín je pátek." },
          ],
        },
        {
          ...original,
          due: "pondělí",
          sources: [{ segment: 3, quote: "Anna připraví nabídku v pondělí." }],
        },
      ],
    },
    input,
  );
  assert.equal(distinct.tasks.length, 3);
  const exactFields = validateMeetingSynthesis(
    {
      ...synthesis,
      tasks: [
        original,
        {
          ...original,
          assignee: "anna",
          sources: [
            { segment: 2, quote: "anna to převezme, termín je pátek." },
          ],
        },
      ],
    },
    {
      segments: [
        ...input.segments,
        { index: 2, text: "anna to převezme, termín je pátek." },
      ],
    },
  );
  assert.equal(exactFields.tasks.length, 2);
});
test("whole synthesis uses ALL raw excerpts and a committed model checkpoint survives publication failure", async () => {
  const f = fixture();
  const processor = new MeetingProcessor(f.store);
  let releaseFailure!: () => void;
  const failureCleanup = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  let showFailure!: () => void;
  const failureVisible = new Promise<void>((resolve) => {
    showFailure = resolve;
  });
  try {
    const id = await sealed(f, 780);
    for (let i = 0; i < 13; i++)
      f.store.putSegment(
        scope,
        id,
        segment(
          i,
          i === 0
            ? "Připravíme nabídku."
            : i === 12
              ? "Anna to převezme, termín je pátek."
              : `Rozprava ${i}.`,
        ),
      );
    f.store.update(scope, id, { status: "ready" });
    assert.equal(f.store.record(scope, id).analysis, null);
    let models = 0,
      stt = 0;
    f.db.exec(
      "CREATE TRIGGER TEST_fail_record BEFORE INSERT ON niaro_meeting_record BEGIN SELECT RAISE(ABORT,'TEST lost publication'); END",
    );
    const access: MeetingProcessingAccess = {
      scope,
      run: async (fn) => fn(),
      failure: async (fn) => {
        const result = fn();
        showFailure();
        // Terminal status is visible while the previous owner still finalizes.
        await failureCleanup;
        return result;
      },
      transcriber: {
        transcribe: async () => {
          stt++;
          throw Error("TEST no STT");
        },
      },
      analyzer: {
        model: "TEST/model",
        fingerprint: "TEST/model-rev1",
        consolidate: async (input) => {
          models++;
          assert.equal(input.segments.length, 13);
          assert(input.segments[12]!.text.includes("Anna"));
          assert(input.segments[5]!.text.includes("Rozprava 5."));
          return {
            ...synthesis,
            tasks: [
              {
                ...synthesis.tasks[0]!,
                sources: [
                  synthesis.tasks[0]!.sources[0]!,
                  { segment: 12, quote: "Anna to převezme, termín je pátek." },
                ],
              },
            ],
          };
        },
      },
    };
    await processor.start(access, id, false);
    await failureVisible;
    assert.equal(f.store.get(scope, id).status, "failed");
    assert.equal(models, 1);
    assert.equal(f.store.humanTasks.list(scope, "open").tasks.length, 0);
    f.db.exec("DROP TRIGGER TEST_fail_record");
    assert.equal((await processor.start(access, id, false)).status, "failed");
    let retryReplies = 0;
    const retry = () =>
      processor.start(access, id, true).then((meeting) => {
        retryReplies++;
        return meeting;
      });
    const firstRetry = retry();
    const secondRetry = retry();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(retryReplies, 0, "explicit retries await the retiring owner");
    assert.equal(f.store.get(scope, id).processingAttempt, 1);
    releaseFailure();
    const admitted = await Promise.all([firstRetry, secondRetry]);
    assert(admitted.every((meeting) => meeting.processingAttempt === 2));
    await settled(() => f.store.get(scope, id).status === "ready");
    assert.equal(f.store.get(scope, id).processingAttempt, 2);
    assert.equal(models, 1, "committed full-model checkpoint reused");
    assert.equal(stt, 0);
    assert.equal(f.store.record(scope, id).analysis!.tasks.length, 1);
    await processor.start(access, id, false);
    assert.equal(models, 1);
    assert(f.store.record(scope, id).transcript.includes("Anna to převezme"));
  } finally {
    releaseFailure();
    await processor.close();
    f.close();
  }
});

test("a terminal-owner retry rechecks authorization after waiting and never replays an unknown model result", async () => {
  const f = fixture();
  const processor = new MeetingProcessor(f.store);
  let releaseFailure!: () => void;
  const failureCleanup = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  let showFailure!: () => void;
  const failureVisible = new Promise<void>((resolve) => {
    showFailure = resolve;
  });
  try {
    const id = await sealed(f, 60);
    f.store.putSegment(scope, id, segment(0, "Připravíme nabídku."));
    let revoked = false;
    let calls = 0;
    const access: MeetingProcessingAccess = {
      scope,
      run: async (fn) => {
        if (revoked) throw new IdentityError(401, "TEST_revoked");
        return fn();
      },
      failure: async (fn) => {
        const result = fn();
        showFailure();
        await failureCleanup;
        return result;
      },
      transcriber: {
        transcribe: async () => {
          throw Error("TEST committed segment must be reused");
        },
      },
      analyzer: {
        model: "TEST/model",
        consolidate: async () => {
          calls++;
          throw Error("TEST model result lost");
        },
      },
    };
    await processor.start(access, id, false);
    await failureVisible;
    assert.equal(calls, 1);
    assert.equal(f.store.get(scope, id).status, "failed");
    await assert.rejects(
      processor.start(
        { ...access, scope: { ...scope, userId: "TEST-other-user" } },
        id,
        true,
      ),
    );
    const retry = processor.start(access, id, true);
    const rejection = assert.rejects(retry, (error: unknown) => {
      return error instanceof IdentityError && error.status === 401;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    revoked = true;
    releaseFailure();
    await rejection;
    assert.equal(
      calls,
      1,
      "revoked retry cannot repeat the uncommitted model call",
    );
    assert.equal(f.store.get(scope, id).processingAttempt, 1);
    assert.equal(f.store.record(scope, id).analysis, null);
  } finally {
    releaseFailure();
    await processor.close();
    f.close();
  }
});

test("concurrent terminal retries cannot retry a newer attempt that failed before their admission", async () => {
  const f = fixture();
  const processor = new MeetingProcessor(f.store);
  let releaseFirst!: () => void;
  const firstCleanup = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let showFirst!: () => void;
  const firstVisible = new Promise<void>((resolve) => {
    showFirst = resolve;
  });
  let showSecond!: () => void;
  const secondVisible = new Promise<void>((resolve) => {
    showSecond = resolve;
  });
  try {
    const id = await sealed(f, 60);
    f.store.putSegment(scope, id, segment(0, "Připravíme nabídku."));
    let calls = 0;
    let failures = 0;
    const access: MeetingProcessingAccess = {
      scope,
      run: async (fn) => fn(),
      failure: async (fn) => {
        const result = fn();
        if (++failures === 1) {
          showFirst();
          await firstCleanup;
        } else showSecond();
        return result;
      },
      transcriber: {
        transcribe: async () => {
          throw Error("TEST committed segment must be reused");
        },
      },
      analyzer: {
        model: "TEST/model",
        consolidate: async () => {
          calls++;
          throw Error("TEST lost model result");
        },
      },
    };
    await processor.start(access, id, false);
    await firstVisible;
    const firstRetry = processor.start(access, id, true);
    let reads = 0;
    const slowRetry = processor.start(
      {
        ...access,
        run: async (fn) => {
          if (++reads === 2) await secondVisible;
          return fn();
        },
      },
      id,
      true,
    );
    releaseFirst();
    const [first, second] = await Promise.all([firstRetry, slowRetry]);
    assert.equal(first.processingAttempt, 2);
    assert.equal(second.processingAttempt, 2);
    assert.equal(second.status, "failed");
    assert.equal(f.store.get(scope, id).processingAttempt, 2);
    assert.equal(
      calls,
      2,
      "only one explicit new attempt repeats the lost result",
    );
    assert.equal(f.store.record(scope, id).analysis, null);
  } finally {
    releaseFirst();
    await processor.close();
    f.close();
  }
});

test("open item pagination is stable and filtered; a done item can only be reopened", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 105; i++)
      f.store.humanTasks.create(
        scope,
        `TEST-${String(i).padStart(3, "0")}`,
        { title: "TEST obligation", detail: "", assignee: null, due: null },
        {
          kind: "agent",
          runId: "TEST-run",
          toolCallId: `TEST-call-${i}`,
          conversationId: "TEST-chat",
        },
      );
    const first = f.store.humanTasks.list(scope, "open");
    assert.equal(first.tasks.length, 100);
    assert(first.next);
    const second = f.store.humanTasks.list(scope, "open", first.next!);
    assert.equal(second.tasks.length, 5);
    assert.equal(
      new Set([...first.tasks, ...second.tasks].map((t) => t.id)).size,
      105,
    );
    const id = first.tasks[0]!.id;
    f.store.humanTasks.command(scope, id, command("complete", 1));
    assert.throws(
      () => f.store.humanTasks.command(scope, id, command("remove", 2)),
      /human_task_transition_invalid/,
    );
    assert.throws(
      () => f.store.humanTasks.close(scope, id, "TEST resolved"),
      /human_task_transition_invalid/,
    );
    assert.equal(f.store.humanTasks.list(scope, "done").tasks.length, 1);
    assert.equal(f.store.humanTasks.list(scope, "open").counts.open, 104);
    assert.equal(f.store.humanTasks.open(scope, 30).length, 30);
  } finally {
    f.close();
  }
});
test("a meeting nobody named is named from its summary before its tasks; a named one keeps its name", async () => {
  const f = fixture();
  const processor = new MeetingProcessor(f.store);
  try {
    const run = async (title: string, name: () => Promise<string>) => {
      const id = await sealed(f, 120, title);
      f.store.putSegment(scope, id, segment(0, "Připravíme nabídku."));
      f.store.putSegment(
        scope,
        id,
        segment(1, "Anna to převezme, termín je pátek."),
      );
      f.store.update(scope, id, { status: "ready" });
      let named = 0;
      const access: MeetingProcessingAccess = {
        scope,
        run: async (fn) => fn(),
        failure: async (fn) => fn(),
        transcriber: { transcribe: async () => Promise.reject(Error("TEST")) },
        analyzer: {
          model: "TEST/model",
          consolidate: async () => synthesis,
          name: async (summary, language) => {
            named++;
            assert.equal(summary, synthesis.summary);
            assert.equal(language, "cs");
            return name();
          },
        },
      };
      await processor.start(access, id, false);
      await settled(() => f.store.get(scope, id).status === "ready");
      return { id, named };
    };
    const automatic = "Schůzka · 9. 10. 2026 22:16";
    const generated = await run(
      automatic,
      async () => "„Nabídka pro klienta Novák s.r.o.“.",
    );
    assert.equal(
      f.store.get(scope, generated.id).title,
      "Nabídka pro klienta Novák",
    );
    // Items are saved after naming, so they point at the new name.
    const task = f.store.humanTasks
      .list(scope, "open")
      .tasks.find(
        (t) =>
          t.origin.kind === "meeting" && t.origin.meetingId === generated.id,
      )!;
    assert.equal(
      task.origin.kind === "meeting" && task.origin.meetingTitle,
      "Nabídka pro klienta Novák",
    );
    // A replayed upload still carries the automatic title: the same meeting.
    const replay = f.store.create(scope, {
      profile: MEETING_PROFILE,
      id: generated.id,
      title: automatic,
      recordedAt,
      language: "cs",
      mimeType: "audio/wav",
      bytes: f.store.get(scope, generated.id).bytes,
    });
    assert.equal(replay.title, "Nabídka pro klienta Novák");
    const kept = await run("TEST rozpočet s Annou", async () => "Jiný název");
    assert.equal(kept.named, 0, "a person's name is never sent to be replaced");
    assert.equal(f.store.get(scope, kept.id).title, "TEST rozpočet s Annou");
    const failed = await run(automatic, async () =>
      Promise.reject(Error("TEST no name")),
    );
    assert.equal(failed.named, 1);
    assert.equal(f.store.get(scope, failed.id).title, automatic);
    assert(
      f.store.record(scope, failed.id).analysis,
      "the record does not depend on a name",
    );
  } finally {
    await processor.close();
    f.close();
  }
});
test("automatic titles are recognised; generated names keep four words", () => {
  for (const title of [
    "Meeting · Oct 9, 2026, 10:16 PM",
    "Schůzka · 9. 10. 2026 22:16",
    "Plan a meeting · 10/8/2026, 8:26:51 PM",
    "Naplánovat schůzku · 8. 10. 2026",
  ])
    assert(isAutomaticMeetingTitle(title), title);
  for (const title of [
    "Meeting with Anna",
    "Schůzka s klientem",
    "Q4 planning",
  ])
    assert(!isAutomaticMeetingTitle(title), title);
  assert.equal(
    shortMeetingTitle("  “Rozpočet na příští čtvrtletí a nábor.”  "),
    "Rozpočet na příští čtvrtletí",
  );
  assert.equal(shortMeetingTitle("Q4 planning!"), "Q4 planning");
  assert.equal(shortMeetingTitle("…"), "");
});

test("stored proposals and decisions from before open items migrate once", () => {
  const db = new DatabaseSync(":memory:");
  try {
    new HumanTaskStore(db);
    const owner = JSON.stringify([
      scope.connectionId,
      scope.serverId,
      scope.workspaceId,
      scope.userId,
    ]);
    const legacy = (id: string, status: string) => ({
      id,
      scope,
      title: `TEST ${status}`,
      detail: "",
      assignee: null,
      due: null,
      revision: 2,
      status,
      createdAt: "2026-10-08T10:00:00.000Z",
      updatedAt: "2026-10-08T11:00:00.000Z",
      origin: {
        kind: "agent",
        runId: "TEST-run",
        toolCallId: `TEST-${id}`,
        conversationId: "TEST-chat",
      },
    });
    for (const status of ["proposed", "active", "completed", "dismissed"])
      db.prepare("INSERT INTO niaro_human_task VALUES (?,?,?,?,?)").run(
        `TEST-${status}`,
        owner,
        "2026-10-08T10:00:00.000Z",
        null,
        JSON.stringify(legacy(`TEST-${status}`, status)),
      );
    db.prepare("INSERT INTO niaro_human_task_receipt VALUES (?,?,?,?,?,?)").run(
      owner,
      "TEST-old-command",
      "TEST-old-command",
      "TEST-completed",
      "a".repeat(64),
      JSON.stringify(legacy("TEST-completed", "completed")),
    );
    const store = new HumanTaskStore(db);
    assert.deepEqual(
      ["proposed", "active", "completed", "dismissed"].map(
        (status) => store.get(scope, `TEST-${status}`).status,
      ),
      ["open", "open", "done", "removed"],
    );
    assert.deepEqual(store.get(scope, "TEST-completed").resolution, {
      by: "user",
      reason: "",
      at: "2026-10-08T11:00:00.000Z",
    });
    assert.equal(store.get(scope, "TEST-active").resolution, null);
    assert.equal(
      Number(
        db.prepare("SELECT count(*) AS n FROM niaro_human_task_receipt").get()!
          .n,
      ),
      0,
    );
    assert.deepEqual(store.list(scope, "open").counts, { open: 2, done: 2 });
    new HumanTaskStore(db);
    assert.equal(store.get(scope, "TEST-active").revision, 2);
  } finally {
    db.close();
  }
});
