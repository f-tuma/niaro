import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  questionFixture,
  askQuestion,
} from "./helpers/process-questions-runtime";
import { admin, scope, signal, code } from "./helpers/service-process-runtime";
import { createProcessCoordinator } from "../apps/server-identity/process-coordinator";
import { ProcessResolveStore } from "../apps/server-identity/process-resolve-store";
import { NativeCommandRequests } from "../apps/server-identity/native-command-requests";
import { PROCESS_EXECUTION_PROFILE } from "../packages/protocol/process-execution";
import {
  PROCESS_QUESTION_EXECUTION_PROFILE,
  ProcessAnswerCommandSchema,
} from "../packages/protocol/process-questions";
import {
  ProcessRuntimeResponseSchema,
  type ProcessRuntimeResponse,
} from "../packages/protocol/process-coordinator";
import {
  PROCESS_START_PROFILE,
  ProcessStartCommandSchema,
  type ProcessStartOrigin,
} from "../packages/protocol/process-start";
import { processDigest } from "../apps/server-identity/process-validation";
import { IdentityError } from "../apps/server-identity/error";
import { callProcessTool } from "./helpers/service-process-agent";

const coordinator = (
  h: ReturnType<typeof questionFixture>,
  v2 = true,
  tracker = new NativeCommandRequests(),
  validateMeetingOrigin?: (origin: ProcessStartOrigin) => void,
) =>
  createProcessCoordinator(
    h.controller,
    h.registry,
    h.starts,
    new ProcessResolveStore(h.db, h.starts),
    h.context,
    scope,
    admin.organizationId,
    tracker,
    {
      memory: h.memory,
      questions: h.questions,
      executionProfile: v2
        ? PROCESS_QUESTION_EXECUTION_PROFILE
        : PROCESS_EXECUTION_PROFILE,
      validateMeetingOrigin,
    },
  );
const answer = (
  state: ProcessRuntimeResponse,
  id = "TEST-answer-A",
  text = "  TEST answer A\n",
) => {
  const q = state.process?.question;
  assert(q);
  return ProcessAnswerCommandSchema.parse({
    profile: PROCESS_QUESTION_EXECUTION_PROFILE,
    type: "process.answer",
    commandId: id,
    idempotencyKey: id + "-key",
    conversationId: state.admission.origin.conversationId,
    workItemId: state.process!.parentRunId,
    expectedWorkRevision: state.process!.revision,
    nodeId: q.nodeId,
    childRunId: q.childRunId,
    toolCallId: q.toolCallId,
    questionId: q.questionId,
    questionRevision: q.questionRevision,
    answer: text,
    language: "cs",
  });
};
async function isolated(
  run: (h: ReturnType<typeof questionFixture>, path: string) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "niaro-question-coordinator-")),
    path = join(root, "identity.sqlite");
  const h = questionFixture(path);
  try {
    await run(h, path);
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
}
test("V2 executes native questions, A retry cannot answer or interrupt B across two reopens", () =>
  isolated(async (h, path) => {
    const { command: start } = h.admit();
    let calls = 0;
    h.onModel(() =>
      ++calls === 1
        ? askQuestion()
        : calls === 2
          ? askQuestion("TEST B?")
          : { content: '{"result":"TEST done"}' },
    );
    const c = coordinator(h);
    const a = ProcessRuntimeResponseSchema.parse(
      await c.execute(start, signal(), () => {}),
    );
    assert.equal(a.profile, PROCESS_QUESTION_EXECUTION_PROFILE);
    assert(a.process?.question);
    assert(!a.process.approval);
    assert.equal("resourceId" in a.process.question, false);
    const command = answer(a);
    const b = await c.execute(command, signal(), () => {
      throw Error("TEST answer cannot remap origin");
    });
    assert(b.process?.question);
    assert.equal(b.process.question.questionRevision, 2);
    assert.equal(h.models().length, 2);
    assert.deepEqual(h.counts(), []);
    assert.deepEqual(await c.execute(command, signal(), () => {}), b);
    const stop = await c.interrupt(command);
    assert.equal(stop.status, "settled");
    assert.equal(
      (await c.read(b.process.parentRunId)).process?.question?.questionId,
      b.process.question.questionId,
    );
    await h.close();
    for (let i = 0; i < 2; i++) {
      const reopened = questionFixture(path, h.ids);
      const current = coordinator(reopened);
      try {
        assert.deepEqual(await current.execute(command, signal(), () => {}), b);
        assert.equal(reopened.models().length, 2);
        assert.deepEqual(reopened.counts(), []);
        const state = await current.read(b.process.parentRunId);
        assert.equal(
          state.process?.question?.questionId,
          b.process.question.questionId,
        );
        const changed = { ...command, answer: "TEST changed" };
        await assert.rejects(
          current.execute(changed, signal(), () => {}),
          code("idempotency_conflict"),
        );
      } finally {
        await reopened.close();
      }
    }
  }));
test("V1 cannot admit compiler3 or answer a question; existing question reads omit the new shape", () =>
  isolated(async (h) => {
    const { command } = h.setup(h.definition());
    const legacy = coordinator(h, false);
    await assert.rejects(
      legacy.execute(command, signal(), () => {}),
      code("process_profile_unsupported"),
    );
    assert.equal(h.models().length, 0);
    assert.deepEqual(h.counts(), []);
    assert.equal(
      h.db
        .prepare("SELECT count(*) AS n FROM agent_process_start_command")
        .get()!.n,
      0,
    );
    h.onModel(() => askQuestion());
    const current = coordinator(h);
    const state = await current.execute(command, signal(), () => {});
    assert(state.process?.question);
    const old = await legacy.read(state.process.parentRunId);
    assert.equal(old.profile, PROCESS_EXECUTION_PROFILE);
    assert(!old.process?.question);
    assert(!old.process?.approval);
    const exact = answer(state);
    await assert.rejects(
      legacy.execute(exact, signal(), () => {}),
      code("process_profile_unsupported"),
    );
    await assert.rejects(
      legacy.interrupt(exact),
      code("process_profile_unsupported"),
    );
    assert.equal(h.models().length, 1);
    assert.equal(
      h.db
        .prepare("SELECT count(*) AS n FROM agent_process_answer_command")
        .get()!.n,
      0,
    );
  }));
test("a meeting task closed while waiting blocks the question answer before binding or resume", () =>
  isolated(async (h) => {
    const processId = h.activate(h.definition());
    const artifact = h.registry.version(admin, processId, 1);
    const meetingId = "33333333-3333-4333-8333-333333333333";
    const recordDigest = "e".repeat(64);
    const requestId = "TEST-meeting-stale-question-origin";
    const selectedTask = { id: `meeting:${meetingId}:0`, revision: 1 };
    const intent = h.starts.issue(
      admin,
      scope,
      {
        origin: {
          type: "meeting",
          conversationId: "conversation-1",
          requestId,
          meetingId,
          recordDigest,
          selectedTask,
          sourceBindings: { name: "summary" },
        },
        processId,
        version: artifact.version,
        artifactDigest: artifact.digest,
        formDigest: processDigest({
          requestId,
          inputSchema: artifact.definition.inputSchema,
        }),
        fields: {},
      },
      () => {},
    );
    const start = ProcessStartCommandSchema.parse({
      profile: PROCESS_START_PROFILE,
      type: "process.start",
      commandId: "TEST-meeting-stale-question-start",
      idempotencyKey: "TEST-meeting-stale-question-start-key",
      intentId: intent.intentId,
      conversationId: "conversation-1",
      language: "en",
      input: { name: "TEST meeting summary" },
    });
    let selectedTaskOpen = true;
    let modelCalls = 0;
    h.onModel(() => {
      modelCalls++;
      return askQuestion();
    });
    const c = coordinator(h, true, undefined, (origin) => {
      if (
        origin.type !== "meeting" ||
        origin.selectedTask?.id !== selectedTask.id ||
        origin.recordDigest !== recordDigest ||
        !selectedTaskOpen
      )
        throw new IdentityError(409, "process_origin_changed");
    });
    const waiting = await c.execute(start, signal(), () => {});
    assert(waiting.process?.question);
    assert.equal(modelCalls, 1);
    const command = answer(waiting);

    selectedTaskOpen = false;
    await assert.rejects(
      c.execute(command, signal(), () => {}),
      /process_origin_changed/,
    );
    assert.equal(
      h.db
        .prepare("SELECT COUNT(*) AS count FROM agent_process_answer_command")
        .get()!.count,
      0,
    );
    assert.equal(modelCalls, 1, "stale source must not resume the native agent");
    assert.equal(
      h.journal(waiting.process.parentRunId).status,
      "waiting",
    );
  }));
test("public answer tuple conflicts fail before native hydration and current authority gates replay", () =>
  isolated(async (h) => {
    const { command: start } = h.admit();
    h.onModel(() => askQuestion());
    const c = coordinator(h);
    const a = await c.execute(start, signal(), () => {}),
      exact = answer(a);
    for (const wrong of [
      { toolCallId: "TEST-wrong" },
      { nodeId: "TEST_wrong" },
      { childRunId: "TEST-wrong" },
      { questionRevision: 2 },
      { expectedWorkRevision: exact.expectedWorkRevision + 1 },
      { questionId: "TEST-wrong" },
    ])
      await assert.rejects(
        c.execute({ ...exact, ...wrong }, signal(), () => {}),
        code("process_question_conflict"),
      );
    assert.equal(h.models().length, 1);
    assert.deepEqual(h.counts(), []);
    assert.equal(
      h.db
        .prepare("SELECT count(*) AS n FROM agent_process_answer_command")
        .get()!.n,
      0,
    );
    h.onModel(() => ({ content: '{"result":"TEST done"}' }));
    const done = await c.execute(exact, signal(), () => {});
    assert.equal(done.process?.status, "succeeded");
    h.revoke();
    await assert.rejects(
      c.execute(exact, signal(), () => {}),
      code("identity_forbidden"),
    );
    await assert.rejects(
      c.read(done.process!.parentRunId),
      code("identity_forbidden"),
    );
    assert.equal(h.models().length, 2);
  }));
test("V1 cannot resolve a compiler3 approval after a question", () =>
  isolated(async (h) => {
    const { command: start } = h.admit();
    let calls = 0;
    h.onModel(() => (++calls === 1 ? askQuestion() : callProcessTool()));
    const current = coordinator(h),
      legacy = coordinator(h, false);
    const a = await current.execute(start, signal(), () => {});
    const waiting = await current.execute(answer(a), signal(), () => {});
    assert(waiting.process?.approval);
    const approval = {
      profile: PROCESS_EXECUTION_PROFILE,
      type: "service.resolve" as const,
      commandId: "TEST-compiler3-approve",
      idempotencyKey: "TEST-compiler3-approve-key",
      conversationId: start.conversationId,
      workItemId: waiting.process.parentRunId,
      expectedWorkRevision: waiting.process.revision,
      operationId: waiting.process.approval.operationId,
      approved: true,
      language: "en" as const,
    };
    await assert.rejects(
      legacy.execute(approval, signal(), () => {}),
      code("process_profile_unsupported"),
    );
    assert.equal(h.models().length, 2);
    assert.deepEqual(h.counts(), []);
    assert.equal(
      h.db
        .prepare("SELECT count(*) AS n FROM agent_process_resolve_command")
        .get()!.n,
      0,
    );
  }));
test("shared in-flight request preserves per-caller profile and V1 cannot join compiler3 question execution", () =>
  isolated(async (h) => {
    const { command } = h.admit(),
      tracker = new NativeCommandRequests();
    const current = coordinator(h, true, tracker),
      legacy = coordinator(h, false, tracker);
    let started!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => {
        started = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    h.onModel(() => askQuestion());
    h.onModelDispatch(async () => {
      started();
      await gate;
    });
    const running = current.execute(command, signal(), () => {});
    await reached;
    const joining = legacy.execute(command, signal(), () => {});
    void joining.catch(() => {});
    release();
    const result = await running;
    assert(result.process?.question);
    await assert.rejects(joining, code("process_profile_unsupported"));
    assert.equal(h.models().length, 1);
  }));
