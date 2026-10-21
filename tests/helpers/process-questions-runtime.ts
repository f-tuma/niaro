import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { ProcessDefinitionSchema } from "../../packages/protocol/service-processes";
import {
  PROCESS_QUESTION_EXECUTION_PROFILE,
  ProcessAnswerCommandSchema,
  type ProcessQuestion,
  type ProcessQuestionAccess,
} from "../../packages/protocol/process-questions";
import { ProcessQuestionStore } from "../../apps/server-identity/process-question-store";
import { createServiceProcessRuntime } from "../../apps/server-identity/service-process-runtime";
import { JournalSchema } from "../../apps/server-identity/service-process-journal";
import { startFixture } from "./process-start";
import { admin, scope, signal } from "./service-process-runtime";
import { processAgent } from "./service-process-agent";

export const askQuestion = (question = "TEST question A?") => ({
  content: null,
  tool_calls: [
    {
      id: "TEST-question-provider-call",
      type: "function",
      function: {
        name: "ask_user",
        arguments: JSON.stringify({ question }),
      },
    },
  ],
});

/** Real identity persistence, canonical admissions/bindings and native checkpoints. */
export function questionFixture(
  path: string,
  ids?: Parameters<typeof startFixture>[1],
  access?: (store: ProcessQuestionStore) => ProcessQuestionAccess,
) {
  const h = startFixture(path, ids);
  const questions = new ProcessQuestionStore(h.db, h.starts);
  const runtime = createServiceProcessRuntime(
    h.controller,
    h.registry,
    h.context,
    scope,
    admin.organizationId,
    {
      memory: h.memory,
      questions: access?.(questions) ?? questions,
    },
  );
  const journal = (parentRunId: string) =>
    JournalSchema.parse(
      h.catalog.turn(parentRunId, scope.workspaceId, scope.userId),
    );
  const resume = (
    binding: ReturnType<ProcessQuestionStore["bind"]>["binding"],
  ) => ({
    kind: "question" as const,
    nodeId: binding.question.nodeId,
    questionId: binding.question.questionId,
    questionRevision: binding.question.questionRevision,
    answerId: binding.bindingId,
  });
  return {
    ...h,
    questions,
    runtime,
    journal,
    resume,
    definition: () =>
      ProcessDefinitionSchema.parse({ ...processAgent(h), humanInput: "text" }),
    admit: (
      definition = ProcessDefinitionSchema.parse({
        ...processAgent(h),
        humanInput: "text",
      }),
    ) => {
      const setup = h.setup(definition);
      const admission = h.starts.admit(
        admin,
        scope,
        setup.command.intentId,
        setup.command,
        () => {},
      );
      assert.equal(admission.status, "admitted", JSON.stringify(admission));
      if (admission.status !== "admitted")
        throw Error("TEST admission rejected");
      return { ...setup, admission };
    },
    bind: (
      question: ProcessQuestion,
      id = "TEST-answer-A",
      answer = "TEST canonical answer A",
    ) => {
      const state = journal(question.parentRunId);
      const command = ProcessAnswerCommandSchema.parse({
        profile: PROCESS_QUESTION_EXECUTION_PROFILE,
        type: "process.answer",
        commandId: id,
        idempotencyKey: id + "-key",
        conversationId: "conversation-1",
        workItemId: question.parentRunId,
        expectedWorkRevision: state.revision,
        nodeId: question.nodeId,
        childRunId: question.childRunId,
        toolCallId: question.toolCallId,
        questionId: question.questionId,
        questionRevision: question.questionRevision,
        answer,
        language: "en",
      });
      return { command, ...questions.bind(admin, scope, command, () => {}) };
    },
  };
}

// Actual process death after the consumption transaction commits, before native tool ACK.
if (process.argv[2] === "--crash-consumption") {
  const path = process.argv[3]!;
  const cutPath = process.argv[4]!;
  const h = questionFixture(path, undefined, (store) => ({
    issue: (q) => store.issue(q),
    question: (id) => store.question(id),
    answer: (id) => store.answer(id),
    consumed: (id, q) => store.consumed(id, q),
    consume: (id, q, commit) => {
      const answer = store.consume(id, q, commit);
      writeFileSync(
        cutPath,
        JSON.stringify({
          ids: h.ids,
          binding: store.answer(id),
          journal: h.journal(q.parentRunId),
        }),
      );
      process.kill(process.pid, "SIGKILL");
      return answer;
    },
  }));
  void (async () => {
    const { admission } = h.admit();
    h.onModel(() => askQuestion());
    const waiting = await h.runtime.start(
      admission.processId,
      admission.runId,
      admission.input,
      signal(),
    );
    assert(waiting.question, JSON.stringify(waiting));
    const { binding } = h.bind(waiting.question);
    await h.runtime.resume(admission.runId, h.resume(binding), signal());
    throw Error("TEST expected SIGKILL before ACK");
  })().catch((error) => {
    process.stderr.write(String(error.stack ?? error));
    process.exitCode = 1;
  });
}
