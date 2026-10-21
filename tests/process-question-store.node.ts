import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFixture } from "./helpers/process-start";
import { processAgent } from "./helpers/service-process-agent";
import { admin, scope, code } from "./helpers/service-process-runtime";
import { ProcessQuestionStore } from "../apps/server-identity/process-question-store";
import { ProcessResolveStore } from "../apps/server-identity/process-resolve-store";
import { JournalSchema } from "../apps/server-identity/service-process-journal";
import { processDigest } from "../apps/server-identity/process-validation";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import {
  PROCESS_QUESTION_EXECUTION_PROFILE,
  ProcessQuestionSchema,
  ProcessAnswerCommandSchema,
} from "../packages/protocol/process-questions";
import { PROCESS_EXECUTION_PROFILE } from "../packages/protocol/process-execution";

async function isolated(
  run: (f: ReturnType<typeof setup>) => Promise<void> | void,
) {
  const root = mkdtempSync(join(tmpdir(), "niaro-question-store-"));
  const f = setup(join(root, "identity.sqlite"));
  try {
    await run(f);
  } finally {
    await f.h.close();
    rmSync(root, { recursive: true, force: true });
  }
}
function setup(path: string) {
  const h = startFixture(path);
  const { command: start } = h.setup(
    ProcessDefinitionSchema.parse({ ...processAgent(h), humanInput: "text" }),
  );
  const admission = h.starts.admit(
    admin,
    scope,
    start.intentId,
    start,
    () => {},
  );
  assert.equal(admission.status, "admitted");
  if (admission.status !== "admitted") throw Error("TEST admission");
  const store = new ProcessQuestionStore(h.db, h.starts);
  const resolves = new ProcessResolveStore(h.db, h.starts);
  const read = () =>
    JournalSchema.parse(
      h.catalog.turn(admission.parentRunId, scope.workspaceId, scope.userId),
    );
  const save = (j: ReturnType<typeof read>) =>
    h.catalog.saveTurn(
      admission.parentRunId,
      scope.workspaceId,
      scope.userId,
      JournalSchema.parse(j),
    );
  const issue = (revision = 1) => {
    const j = read(),
      nodeId = "agent";
    const childRunId = processDigest([admission.parentRunId, "agent", nodeId]);
    const childThreadId = processDigest([
      admission.parentRunId,
      j.scopeDigest,
      "agent-thread",
      nodeId,
    ]);
    const toolCallId = "TEST-question-" + revision,
      question = "  TEST exact question " + revision + "  ";
    const q = ProcessQuestionSchema.parse({
      kind: "question",
      questionId: processDigest([
        admission.parentRunId,
        "question",
        nodeId,
        childRunId,
        toolCallId,
      ]),
      questionRevision: revision,
      parentRunId: admission.parentRunId,
      nodeId,
      childRunId,
      childThreadId,
      resourceId: j.scopeDigest,
      toolCallId,
      question,
      questionDigest: processDigest(question),
      artifactDigest: j.artifactDigest,
      compilerVersion: j.compilerVersion,
      inputDigest: j.inputDigest,
      issuedWorkRevision: j.revision + 1,
    });
    store.issue(q);
    j.status = "waiting";
    j.revision++;
    j.pending = q;
    j.agents.agent = {
      runId: childRunId,
      threadId: childThreadId,
      inputDigest: processDigest({ name: "TEST child input" }),
      decisions: [],
      pending: { kind: "question", toolCallId, question, questionProof: q },
      questionRevision: revision,
    };
    save(j);
    return q;
  };
  const question = issue();
  const command = ProcessAnswerCommandSchema.parse({
    profile: PROCESS_QUESTION_EXECUTION_PROFILE,
    type: "process.answer",
    commandId: "TEST-answer",
    idempotencyKey: "TEST-answer-key",
    conversationId: start.conversationId,
    workItemId: admission.parentRunId,
    expectedWorkRevision: read().revision,
    nodeId: question.nodeId,
    childRunId: question.childRunId,
    toolCallId: question.toolCallId,
    questionId: question.questionId,
    questionRevision: question.questionRevision,
    answer: "  TEST exact answer\n",
    language: "cs",
  });
  return {
    h,
    store,
    resolves,
    read,
    save,
    issue,
    question,
    command,
    admission,
    start,
  };
}
test("immutable issue and exact answer preserve text; A replay while B pending never binds B", () =>
  isolated((f) => {
    assert.deepEqual(f.store.issue(f.question), f.question);
    assert.throws(
      () =>
        f.store.issue({
          ...f.question,
          question: "changed",
          questionDigest: processDigest("changed"),
        }),
      code("process_question_conflict"),
    );
    const a = f.store.bind(admin, scope, f.command, () => {});
    assert.equal(a.replay, false);
    assert.equal(a.binding.command.answer, "  TEST exact answer\n");
    const b = f.issue(2);
    let validations = 0;
    assert.deepEqual(
      f.store.bind(admin, scope, f.command, () => {
        validations++;
      }),
      { ...a, replay: true },
    );
    assert.equal(validations, 0);
    assert.equal(f.read().pending?.nodeId, b.nodeId);
    assert.throws(
      () =>
        f.store.bind(
          admin,
          scope,
          { ...f.command, answer: "changed" },
          () => {},
        ),
      code("idempotency_conflict"),
    );
    assert.equal(f.store.consumed(a.binding.bindingId, b), false);
    assert.throws(
      () => f.store.consume(a.binding.bindingId, b, () => {}),
      code("process_question_conflict"),
    );
  }));
test("new answers reject each wrong tuple, extra raw permission, stale revision, and double answer", () =>
  isolated((f) => {
    const replacements = [
      { workItemId: "TEST-other" },
      { conversationId: "TEST-other" },
      { nodeId: "other" },
      { childRunId: "TEST-other" },
      { toolCallId: "TEST-other" },
      { questionId: "TEST-other" },
      { questionRevision: 2 },
      { expectedWorkRevision: f.command.expectedWorkRevision + 1 },
      { approved: true },
      { answer: " " },
    ];
    for (const change of replacements)
      assert.throws(() =>
        f.store.bind(admin, scope, { ...f.command, ...change }, () => {}),
      );
    const a = f.store.bind(admin, scope, f.command, () => {});
    assert.throws(
      () =>
        f.store.bind(
          admin,
          scope,
          {
            ...f.command,
            commandId: "TEST-second",
            idempotencyKey: "TEST-second-key",
          },
          () => {},
        ),
      code("process_question_conflict"),
    );
    assert.equal(
      f.h.db
        .prepare("SELECT count(*) AS n FROM agent_process_answer_command")
        .get()!.n,
      1,
    );
    assert.equal(
      f.store.answer(a.binding.bindingId)?.command.answer,
      f.command.answer,
    );
  }));
test("complete private journal proof must match the issued question before answer binding", () =>
  isolated((f) => {
    for (const field of [
      "resourceId",
      "childThreadId",
      "inputDigest",
    ] as const) {
      const original = f.read(),
        j = structuredClone(original);
      assert(j.pending && "kind" in j.pending);
      j.pending[field] =
        field === "childThreadId" ? "TEST-other" : "f".repeat(64);
      f.save(j);
      assert.throws(
        () => f.store.bind(admin, scope, f.command, () => {}),
        code("process_question_conflict"),
      );
      f.save(original);
    }
  }));
test("consumption and journal mutation commit atomically; retry cannot replay the callback", () =>
  isolated((f) => {
    const b = f.store.bind(admin, scope, f.command, () => {}).binding;
    const original = f.read();
    let calls = 0;
    assert.deepEqual(
      f.store.history(admin, scope, f.admission.parentRunId),
      [],
    );
    assert.throws(
      () =>
        f.store.consume(b.bindingId, f.question, () => {
          calls++;
          const j = f.read();
          j.status = "running";
          delete j.pending;
          f.save(j);
          throw Error("TEST callback failure");
        }),
      /TEST callback failure/,
    );
    assert.equal(f.store.consumed(b.bindingId, f.question), false);
    assert.deepEqual(f.read(), original);
    assert.deepEqual(
      f.store.history(admin, scope, f.admission.parentRunId),
      [],
    );
    assert.equal(
      f.store.consume(b.bindingId, f.question, () => {
        calls++;
        const j = f.read();
        j.status = "running";
        delete j.pending;
        f.save(j);
      }),
      f.command.answer,
    );
    assert.equal(f.store.consumed(b.bindingId, f.question), true);
    assert.deepEqual(f.store.history(admin, scope, f.admission.parentRunId), [
      {
        commandId: f.command.commandId,
        questionId: f.question.questionId,
        answer: f.command.answer,
      },
    ]);
    assert.throws(() =>
      f.store.history(
        admin,
        { ...scope, connectionId: "TEST-other" },
        f.admission.parentRunId,
      ),
    );
    assert.equal(
      f.store.consume(b.bindingId, f.question, () => {
        throw Error("TEST consumed replay must not mutate");
      }),
      f.command.answer,
    );
    assert.equal(calls, 2);
  }));
test("private original authority gates both accepted and recorded answer reads", () =>
  isolated((f) => {
    f.store.bind(admin, scope, f.command, () => {});
    assert.throws(() =>
      f.store.read(admin, { ...scope, connectionId: "TEST-other" }, f.command),
    );
    f.h.revoke();
    assert.throws(
      () => f.store.bind(admin, scope, f.command, () => {}),
      code("identity_forbidden"),
    );
    assert.throws(
      () => f.store.read(admin, scope, f.command),
      code("identity_forbidden"),
    );
    assert.throws(
      () => f.store.history(admin, scope, f.admission.parentRunId),
      code("identity_forbidden"),
    );
  }));
test("start, approval and answer share command and idempotency namespaces", () =>
  isolated((f) => {
    for (const change of [
      { commandId: f.start.commandId },
      { idempotencyKey: f.start.idempotencyKey },
    ])
      assert.throws(
        () => f.store.bind(admin, scope, { ...f.command, ...change }, () => {}),
        code("idempotency_conflict"),
      );
    f.store.bind(admin, scope, f.command, () => {});
    for (const [commandId, idempotencyKey] of [
      [f.command.commandId, "TEST-new"],
      ["TEST-new", f.command.idempotencyKey],
    ]) {
      assert.throws(
        () => f.resolves.assertUnused(scope, commandId!, idempotencyKey!),
        code("idempotency_conflict"),
      );
      assert.throws(
        () =>
          f.resolves.bind(
            admin,
            scope,
            {
              profile: PROCESS_EXECUTION_PROFILE,
              type: "service.resolve",
              commandId,
              idempotencyKey,
              conversationId: f.start.conversationId,
              workItemId: f.admission.parentRunId,
              expectedWorkRevision: f.read().revision,
              operationId: "TEST-operation",
              approved: true,
              language: "en",
            },
            () => {},
          ),
        code("idempotency_conflict"),
      );
    }
  }));
test("immutable SQL triggers reject edits to question, answer and consumed binding", () =>
  isolated((f) => {
    const b = f.store.bind(admin, scope, f.command, () => {}).binding;
    f.store.consume(b.bindingId, f.question, () => {});
    for (const table of [
      "agent_process_question",
      "agent_process_answer_command",
      "agent_process_answer_consumption",
    ])
      assert.throws(
        () =>
          f.h.db.exec(
            `UPDATE ${table} SET ${table === "agent_process_answer_consumption" ? "question_digest" : "data"}='changed'`,
          ),
        /immutable/,
      );
  }));
