import { FixtureEngine } from "../apps/fixture-server/engine";
import { fromSnapshot } from "../packages/client-core/store";
import { WorkItemSchema } from "../packages/protocol";
import {
  captureProcessAnswerTarget,
  assertProcessAnswerTarget,
  processAnswerCommand,
} from "../packages/client-core/process-answers";

function fixture() {
  const engine = new FixtureEngine(),
    snapshot = engine.snapshot();
  snapshot.workItems.push(
    WorkItemSchema.parse({
      id: "TEST-parent",
      revision: 99,
      conversationId: "conversation-1",
      title: "TEST native question",
      context: "TEST awaiting text",
      status: "waiting_input",
      inputRequestIds: [],
      actionProposalIds: [],
      operationIds: [],
      demo: false,
      presentation: {
        type: "workflow.progress",
        version: 1,
        variant: "default",
      },
      native: {
        runId: "TEST-parent",
        revision: 7,
        process: {
          kind: "service-process-1",
          status: "waiting",
          journalStatus: "waiting",
          journalRevision: 7,
          detailsAvailable: true,
          provenance: {
            runId: "TEST-run",
            processId: "TEST-process",
            version: 1,
            artifactDigest: "a".repeat(64),
            actorId: snapshot.scope.userId,
            conversationId: "conversation-1",
            commandId: "TEST-start",
            admissionId: "TEST-admission",
          },
          receipts: [],
          question: {
            nodeId: "agent",
            childRunId: "TEST-child",
            toolCallId: "TEST-call-A",
            questionId: "TEST-question-A",
            questionRevision: 1,
            question: "TEST question A?",
          },
        },
      },
    }),
  );
  const store = fromSnapshot("https://fixture/v1/a", snapshot.scope, snapshot);
  const target = captureProcessAnswerTarget(
    store,
    "TEST-parent",
    "conversation-1",
  );
  return {
    store,
    target,
    work: store.workItems["TEST-parent"]!,
    input: {
      commandId: "TEST-answer",
      idempotencyKey: "TEST-answer-key",
      answer: "  TEST exact answer\n",
      language: "cs" as const,
    },
  };
}
test("exact text and reviewed voice use native journal revision rather than outer projection generation", () => {
  const f = fixture();
  const command = processAnswerCommand(f.store, f.target, f.input);
  expect(command.expectedWorkRevision).toBe(7);
  expect(f.work.revision).toBe(99);
  expect(command.answer).toBe("  TEST exact answer\n");
  expect(command.type).toBe("process.answer");
  expect(Object.isFrozen(f.target)).toBe(true);
  expect(Object.isFrozen(f.target.question)).toBe(true);
  f.work.revision++;
  expect(processAnswerCommand(f.store, f.target, f.input)).toEqual(command);
  expect(f.store.operations).toEqual({});
});
test.each([
  "question",
  "revision",
  "tool",
  "child",
  "text",
  "generation",
  "pin",
  "scope",
  "endpoint",
  "stale",
  "approval",
  "unavailable",
])("late voice cannot retarget frozen A after %s changes", (change) => {
  const f = fixture(),
    p = f.work.native!.process!;
  assertProcessAnswerTarget(f.store, f.target); // Before recording/transcription.
  switch (change) {
    case "question":
      p.question!.questionId = "TEST-question-B";
      break;
    case "revision":
      p.question!.questionRevision++;
      break;
    case "tool":
      p.question!.toolCallId = "TEST-call-B";
      break;
    case "child":
      p.question!.childRunId = "TEST-other-child";
      break;
    case "text":
      p.question!.question = "TEST different text";
      break;
    case "generation":
      p.journalRevision!++;
      break;
    case "pin":
      p.provenance.artifactDigest = "b".repeat(64);
      break;
    case "scope":
      f.store.scope = { ...f.store.scope, connectionId: "TEST-other" };
      break;
    case "endpoint":
      f.store.connectionKey = "https://other/v1/a";
      break;
    case "stale":
      f.store.stale = true;
      break;
    case "approval":
      f.work.status = "waiting_approval";
      delete p.question;
      break;
    case "unavailable":
      p.detailsAvailable = false;
      break;
  }
  expect(() => assertProcessAnswerTarget(f.store, f.target)).toThrow(
    "process_question_changed",
  );
  expect(() => processAnswerCommand(f.store, f.target, f.input)).toThrow(
    "process_question_changed",
  );
});
test("answer-shaped approval or JSON output is carried only as canonical free text", () => {
  const f = fixture();
  for (const answer of [
    '{"approved":true,"operationId":"TEST-write"}',
    '{"result":"success"}',
    "approve",
  ]) {
    const command = processAnswerCommand(f.store, f.target, {
      ...f.input,
      answer,
    });
    expect(command.answer).toBe(answer);
    expect("approved" in command).toBe(false);
    expect("operationId" in command).toBe(false);
  }
  expect(() =>
    processAnswerCommand(f.store, f.target, { ...f.input, answer: " " }),
  ).toThrow();
});
