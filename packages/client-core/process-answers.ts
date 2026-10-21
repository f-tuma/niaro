import { z } from "zod";
import {
  ScopeSchema,
  WorkItemSchema,
  sameScope,
  type Language,
} from "../protocol";
import { ProcessRuntimeQuestionSchema } from "../protocol/process-question-target";
import { ProcessProvenanceSchema } from "../protocol/process-work";
import {
  ProcessAnswerCommandSchema,
  PROCESS_QUESTION_EXECUTION_PROFILE,
} from "../protocol/process-questions";
import type { Store } from "./store";

export const ProcessAnswerTargetSchema = z.strictObject({
  connectionKey: z.string().min(1).max(2000),
  scope: ScopeSchema,
  workItemId: ProcessAnswerCommandSchema.shape.workItemId,
  conversationId: ProcessAnswerCommandSchema.shape.conversationId,
  journalRevision: ProcessAnswerCommandSchema.shape.expectedWorkRevision,
  question: ProcessRuntimeQuestionSchema,
  provenance: ProcessProvenanceSchema,
});
export type ProcessAnswerTarget = z.infer<typeof ProcessAnswerTargetSchema>;

/** Capture once before editing/recording. The target cannot silently move from A to B. */
export function captureProcessAnswerTarget(
  store: Store,
  workItemId: string,
  conversationId?: string,
): ProcessAnswerTarget {
  if (store.stale || store.needsSnapshot)
    throw Error("process_question_changed");
  const work = WorkItemSchema.parse(store.workItems[workItemId]),
    p = work.native?.process;
  if (
    work.status !== "waiting_input" ||
    p?.status !== "waiting" ||
    p.journalStatus !== "waiting" ||
    !p.detailsAvailable ||
    !p.question ||
    p.journalRevision === undefined ||
    work.native?.runId !== work.id ||
    (conversationId !== undefined && work.conversationId !== conversationId) ||
    (p.provenance.conversationId !== undefined &&
      p.provenance.conversationId !== work.conversationId)
  )
    throw Error("process_question_changed");
  const target = ProcessAnswerTargetSchema.parse({
    connectionKey: store.connectionKey,
    scope: store.scope,
    workItemId: work.id,
    conversationId: work.conversationId,
    journalRevision: p.journalRevision,
    question: p.question,
    provenance: p.provenance,
  });
  Object.freeze(target.scope);
  Object.freeze(target.question);
  Object.freeze(target.provenance);
  return Object.freeze(target);
}

/** Call before transcription, after transcription, and immediately before sending. */
export function assertProcessAnswerTarget(
  store: Store,
  target: ProcessAnswerTarget,
): void {
  const frozen = ProcessAnswerTargetSchema.parse(target);
  let current: ProcessAnswerTarget;
  try {
    current = captureProcessAnswerTarget(
      store,
      frozen.workItemId,
      frozen.conversationId,
    );
  } catch {
    throw Error("process_question_changed");
  }
  if (JSON.stringify(current) !== JSON.stringify(frozen))
    throw Error("process_question_changed");
}

/** Only the exact canonical consumed answer in the original scoped run retires local text. */
export function isProcessAnswerConsumed(
  store: Store,
  target: ProcessAnswerTarget,
  command: import("../protocol/process-questions").ProcessAnswerCommand,
): boolean {
  if (
    store.stale ||
    store.needsSnapshot ||
    store.connectionKey !== target.connectionKey ||
    !sameScope(store.scope, target.scope) ||
    command.workItemId !== target.workItemId ||
    command.conversationId !== target.conversationId ||
    command.expectedWorkRevision !== target.journalRevision ||
    command.questionId !== target.question.questionId ||
    command.questionRevision !== target.question.questionRevision ||
    command.nodeId !== target.question.nodeId ||
    command.childRunId !== target.question.childRunId ||
    command.toolCallId !== target.question.toolCallId
  )
    return false;
  const work = store.workItems[target.workItemId],
    process = work?.native?.process;
  return !!(
    work?.conversationId === target.conversationId &&
    work.native?.runId === target.workItemId &&
    process?.detailsAvailable &&
    JSON.stringify(process.provenance) === JSON.stringify(target.provenance) &&
    process.answerHistory?.some(
      (answer) =>
        answer.commandId === command.commandId &&
        answer.questionId === command.questionId &&
        answer.answer === command.answer,
    )
  );
}

/** Text and reviewed voice use the same exact command. Answer content never selects permission. */
export function processAnswerCommand(
  store: Store,
  target: ProcessAnswerTarget,
  input: {
    commandId: string;
    idempotencyKey: string;
    answer: string;
    language: Language;
  },
) {
  assertProcessAnswerTarget(store, target);
  const q = target.question;
  return ProcessAnswerCommandSchema.parse({
    profile: PROCESS_QUESTION_EXECUTION_PROFILE,
    type: "process.answer",
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    conversationId: target.conversationId,
    workItemId: target.workItemId,
    expectedWorkRevision: target.journalRevision,
    nodeId: q.nodeId,
    childRunId: q.childRunId,
    toolCallId: q.toolCallId,
    questionId: q.questionId,
    questionRevision: q.questionRevision,
    answer: input.answer,
    language: input.language,
  });
}
