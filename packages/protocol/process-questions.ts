import { z } from "zod";
import { LanguageSchema, ScopeSchema } from "./index";
import { IdentityId } from "./identity";
import { ProcessKey } from "./service-processes";
import { ProcessStartAdmissionSchema } from "./process-start";

export const PROCESS_QUESTION_EXECUTION_PROFILE =
  "agent-process-execution/2" as const;
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commandId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);
const text = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0);

/** Private, immutable server proof. Model arguments supply only the question text. */
export const ProcessQuestionSchema = z.strictObject({
  kind: z.literal("question"),
  questionId: IdentityId,
  questionRevision: revision,
  parentRunId: IdentityId,
  nodeId: ProcessKey,
  childRunId: IdentityId,
  childThreadId: IdentityId,
  resourceId: digest,
  toolCallId: z.string().min(1).max(200),
  question: text(2000),
  questionDigest: digest,
  artifactDigest: digest,
  compilerVersion: z.literal("niaro-native-workflow/3"),
  inputDigest: digest,
  issuedWorkRevision: revision,
});
export type ProcessQuestion = z.infer<typeof ProcessQuestionSchema>;

/** Native parent resume references a server binding, never caller-supplied answer text. */
export const ProcessQuestionResumeSchema = z.strictObject({
  kind: z.literal("question"),
  nodeId: ProcessKey,
  questionId: IdentityId,
  questionRevision: revision,
  answerId: IdentityId,
});
export type ProcessQuestionResume = z.infer<typeof ProcessQuestionResumeSchema>;

/** Explicitly negotiated exact answer; it cannot carry an operation or approval. */
export const ProcessAnswerCommandSchema = z.strictObject({
  profile: z.literal(PROCESS_QUESTION_EXECUTION_PROFILE),
  type: z.literal("process.answer"),
  commandId,
  idempotencyKey: commandId,
  conversationId: commandId,
  workItemId: IdentityId,
  expectedWorkRevision: revision,
  nodeId: ProcessKey,
  childRunId: IdentityId,
  toolCallId: z.string().min(1).max(200),
  questionId: IdentityId,
  questionRevision: revision,
  answer: text(4000),
  language: LanguageSchema,
});
export type ProcessAnswerCommand = z.infer<typeof ProcessAnswerCommandSchema>;

/** Admission plus the complete question and original command make retries immutable. */
export const ProcessAnswerBindingSchema = z.strictObject({
  bindingId: IdentityId,
  scope: ScopeSchema,
  command: ProcessAnswerCommandSchema,
  admission: ProcessStartAdmissionSchema,
  question: ProcessQuestionSchema,
  createdAt: z.iso.datetime(),
});
export type ProcessAnswerBinding = z.infer<typeof ProcessAnswerBindingSchema>;

/** Trusted synchronous storage interface; callers hold current domain authority and queue. */
export type ProcessQuestionAccess = {
  issue(question: ProcessQuestion): ProcessQuestion;
  question(questionId: string): ProcessQuestion | undefined;
  answer(bindingId: string): ProcessAnswerBinding | undefined;
  consume(
    bindingId: string,
    question: ProcessQuestion,
    commit: () => void,
  ): string;
  consumed(bindingId: string, question: ProcessQuestion): boolean;
};
