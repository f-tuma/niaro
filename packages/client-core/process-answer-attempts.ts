import { z } from "zod";
import { ScopeSchema, sameScope, type Scope } from "../protocol";
import { ProcessAnswerCommandSchema } from "../protocol/process-questions";
import { ProcessAnswerTargetSchema } from "./process-answers";

export const PROCESS_ANSWER_ATTEMPTS_LIMIT = 32;
// Includes JSON escaping of all 32 maximum-sized raw answers/questions plus
// their bounded ownership fields. The same UTF-8 cap guards reads and writes.
export const PROCESS_ANSWER_ATTEMPTS_MAX_BYTES = 2_000_000;
export const ProcessAnswerAttemptSchema = z
  .strictObject({
    target: ProcessAnswerTargetSchema,
    command: ProcessAnswerCommandSchema,
    outcome: z.enum(["unknown", "accepted", "rejected"]),
    error: z.string().min(1).max(160).nullable(),
  })
  .refine(
    ({ target, command }) =>
      target.workItemId === command.workItemId &&
      target.conversationId === command.conversationId &&
      target.journalRevision === command.expectedWorkRevision &&
      target.question.nodeId === command.nodeId &&
      target.question.childRunId === command.childRunId &&
      target.question.toolCallId === command.toolCallId &&
      target.question.questionId === command.questionId &&
      target.question.questionRevision === command.questionRevision &&
      target.provenance.actorId === target.scope.userId &&
      (target.provenance.conversationId === undefined ||
        target.provenance.conversationId === command.conversationId),
  );
export type ProcessAnswerAttempt = z.infer<typeof ProcessAnswerAttemptSchema>;

/** The retained envelope is authoritative even when empty: legacy pending text cannot resurrect. */
export const ProcessAnswerAttemptsEnvelopeSchema = z
  .strictObject({
    version: z.literal(1),
    connectionKey: ProcessAnswerTargetSchema.shape.connectionKey,
    scope: ScopeSchema,
    attempts: z
      .array(ProcessAnswerAttemptSchema)
      .max(PROCESS_ANSWER_ATTEMPTS_LIMIT),
    pendingCommandId: ProcessAnswerCommandSchema.shape.commandId.nullable(),
  })
  .refine(
    (value) =>
      new Set(value.attempts.map((attempt) => attempt.command.commandId))
        .size === value.attempts.length &&
      value.attempts.every(
        (attempt) =>
          attempt.target.connectionKey === value.connectionKey &&
          sameScope(attempt.target.scope, value.scope) &&
          (attempt.outcome !== "unknown" ||
            attempt.command.commandId === value.pendingCommandId),
      ) &&
      (value.pendingCommandId === null ||
        value.attempts.some(
          (attempt) =>
            attempt.command.commandId === value.pendingCommandId &&
            attempt.outcome === "unknown",
        )),
  );
export type ProcessAnswerAttemptsEnvelope = z.infer<
  typeof ProcessAnswerAttemptsEnvelopeSchema
>;

function storageBytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
export function serializeProcessAnswerAttempts(
  envelope: ProcessAnswerAttemptsEnvelope,
): string {
  const serialized = JSON.stringify(envelope);
  if (
    serialized.length > PROCESS_ANSWER_ATTEMPTS_MAX_BYTES ||
    storageBytes(serialized) > PROCESS_ANSWER_ATTEMPTS_MAX_BYTES
  )
    throw Error("process_answer_attempts_full");
  return serialized;
}

function freezeAttempt(attempt: ProcessAnswerAttempt): ProcessAnswerAttempt {
  Object.freeze(attempt.target.scope);
  Object.freeze(attempt.target.question);
  Object.freeze(attempt.target.provenance);
  Object.freeze(attempt.target);
  Object.freeze(attempt.command);
  return Object.freeze(attempt);
}
export function parseProcessAnswerAttempts(
  raw: string,
  connectionKey: string,
  scope: Scope,
): ProcessAnswerAttemptsEnvelope {
  if (
    raw.length > PROCESS_ANSWER_ATTEMPTS_MAX_BYTES ||
    storageBytes(raw) > PROCESS_ANSWER_ATTEMPTS_MAX_BYTES
  )
    throw Error("storage_error");
  const envelope = ProcessAnswerAttemptsEnvelopeSchema.parse(JSON.parse(raw));
  if (
    envelope.connectionKey !== connectionKey ||
    !sameScope(envelope.scope, scope)
  )
    throw Error("scope_mismatch");
  envelope.attempts = envelope.attempts.map(freezeAttempt);
  return envelope;
}
export function immutableProcessAnswerAttempt(
  raw: ProcessAnswerAttempt,
): ProcessAnswerAttempt {
  return freezeAttempt(ProcessAnswerAttemptSchema.parse(raw));
}
