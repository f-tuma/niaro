import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  questionFixture,
  askQuestion,
} from "./helpers/process-questions-runtime";
import { admin, scope, signal } from "./helpers/service-process-runtime";
import { createProcessTaskProjection } from "../apps/server-identity/process-work-items";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { snapshotWithoutProcessQuestions } from "../packages/protocol/process-work";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { nativeTaskQuestion } from "../packages/test-fixtures";
import { WorkItemSchema } from "../packages/protocol";

const accountScope = { ...scope, connectionId: `account-${scope.workspaceId}` };
function savedWork(revision = 1) {
  const base = nativeTaskQuestion();
  return WorkItemSchema.parse({
    ...base,
    id: "TEST-history-parent",
    revision,
    status: "succeeded",
    inputRequestIds: [],
    actionProposalIds: [],
    operationIds: [],
    native: {
      runId: "TEST-history-parent",
      revision,
      process: {
        kind: "service-process-1",
        status: "succeeded",
        journalStatus: "succeeded",
        detailsAvailable: true,
        provenance: {
          runId: "TEST-history-run",
          processId: "TEST-history-process",
          version: 1,
          artifactDigest: "a".repeat(64),
          actorId: scope.userId,
          conversationId: base.conversationId,
        },
        receipts: [],
        answerHistory: [
          {
            commandId: "c".repeat(160),
            questionId: "a".repeat(64),
            answer: "  TEST exact durable text\n",
          },
        ],
      },
    },
  });
}
test("SQL history publication survives redaction, eviction, chat archival and two workflow-store reopens", () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-question-message-store-"));
  let storage = new FixtureStorage(dir, scope.serverId);
  try {
    storage.syncNativeWork(accountScope, [savedWork()], true);
    assert.equal(
      storage.snapshot(accountScope).conversations[0]!.messages.length,
      1,
    );
    storage.startSession(accountScope);
    const redacted = savedWork(2);
    delete redacted.native!.process!.answerHistory;
    redacted.native!.process!.detailsAvailable = false;
    storage.syncNativeWork(accountScope, [redacted], true);
    for (let i = 0; i < 2; i++) {
      storage.close();
      storage = new FixtureStorage(dir, scope.serverId);
      storage.syncNativeWork(accountScope, [], true);
      storage.syncNativeWork(accountScope, [savedWork(3 + i)], true);
      assert.equal(
        storage.snapshot(accountScope).conversations[0]!.messages.length,
        0,
      );
    }
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("history marker and message roll back together on publication failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-question-message-rollback-"));
  let reject = true;
  const storage = new FixtureStorage(
    dir,
    scope.serverId,
    undefined,
    (stage, change) => {
      if (reject && stage === "before_commit" && change === "command")
        throw Error("TEST publication failed");
    },
  );
  try {
    assert.throws(
      () => storage.syncNativeWork(accountScope, [savedWork()], true),
      /TEST publication failed/,
    );
    reject = false;
    storage.syncNativeWork(accountScope, [savedWork()], true);
    const snapshot = storage.snapshot(accountScope);
    assert.equal(snapshot.conversations[0]!.messages.length, 1);
    assert.equal(
      snapshot.conversations[0]!.messages[0]!.text,
      "  TEST exact durable text\n",
    );
    const cursor = snapshot.cursor;
    storage.syncNativeWork(accountScope, [savedWork()], true);
    assert.equal(storage.snapshot(accountScope).cursor, cursor);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only consumed exact answers enter passive chat once; archived answers never return on the next question", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-question-history-"));
  const h = questionFixture(join(dir, "identity.sqlite"));
  const projection = createProcessTaskProjection(
    h.controller,
    h.registry,
    h.starts,
    h.context,
    scope,
    admin.organizationId,
    h.memory,
    undefined,
    h.questions,
  );
  const items = async () =>
    projection.project(
      (await projection.roots()).filter((r) => r.kind === "service-process-1"),
    );
  const engine = new FixtureEngine(
    scope.workspaceId,
    undefined,
    undefined,
    undefined,
    scope,
  );
  try {
    const { admission } = h.admit();
    let calls = 0;
    h.onModel(() =>
      ++calls < 4
        ? askQuestion(`TEST question ${calls}?`)
        : { content: '{"result":"TEST done"}' },
    );
    const a = await h.runtime.start(
      admission.processId,
      admission.runId,
      admission.input,
      signal(),
    );
    assert(a.question);
    engine.syncNativeWork(await items(), true, true);
    const answerA = h.bind(
      a.question,
      "TEST-history-answer-A",
      "  TEST exact A\n",
    );
    assert.deepEqual(
      h.questions.history(admin, scope, admission.parentRunId),
      [],
    );
    assert.equal(engine.snapshot().conversations[0]!.messages.length, 0);
    const b = await h.runtime.resume(
      admission.runId,
      h.resume(answerA.binding),
      signal(),
    );
    assert(b.question);
    engine.syncNativeWork(await items(), true, true);
    const accepted = engine.snapshot();
    // Stored answers carry when they were stored.
    assert(accepted.conversations[0]!.messages.every((m) => !!m.createdAt));
    assert.deepEqual(
      accepted.conversations[0]!.messages.map(
        ({ createdAt: _createdAt, ...message }) => message,
      ),
      [
        {
          id: `message-process-answer-${a.question.questionId}`,
          role: "user",
          text: "  TEST exact A\n",
          workItemId: admission.parentRunId,
        },
      ],
    );
    const cursor = accepted.cursor;
    engine.syncNativeWork(await items(), true, true);
    assert.equal(engine.snapshot().cursor, cursor);
    assert(
      !snapshotWithoutProcessQuestions(accepted).workItems[0]!.native!.process!
        .answerHistory,
    );
    assert.equal(h.models().length, 2);
    assert.deepEqual(h.counts(), []);
    engine.startSession();
    const restored = new FixtureEngine(
      scope.workspaceId,
      structuredClone(engine.data),
      undefined,
      undefined,
      scope,
    );
    const answerB = h.bind(b.question, "TEST-history-answer-B", "TEST B");
    const c = await h.runtime.resume(
      admission.runId,
      h.resume(answerB.binding),
      signal(),
    );
    assert(c.question);
    restored.syncNativeWork(await items(), true, true);
    assert.deepEqual(
      restored
        .snapshot()
        .conversations[0]!.messages.map(
          ({ createdAt: _createdAt, ...message }) => message,
        ),
      [
        {
          id: `message-process-answer-${b.question.questionId}`,
          role: "user",
          text: "TEST B",
          workItemId: admission.parentRunId,
        },
      ],
    );
    assert.equal(
      restored.snapshot().workItems[0]!.native!.process!.answerHistory!.length,
      2,
    );
    await h.runtime.resume(
      admission.runId,
      h.resume(answerA.binding),
      signal(),
    );
    const before = restored.snapshot();
    restored.syncNativeWork(await items(), true, true);
    assert.deepEqual(restored.snapshot(), before);
    assert.equal(h.models().length, 3);
    assert.deepEqual(h.counts(), []);
    h.revoke();
    assert.deepEqual(await items(), []);
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
