import { z } from "zod";
import { LanguageSchema, ScopeSchema } from "./index";
import { IdentityId } from "./identity";
import { PROCESS_EXECUTION_PROFILE } from "./process-execution";
import {
  PROCESS_QUESTION_EXECUTION_PROFILE,
  ProcessAnswerCommandSchema,
} from "./process-questions";
import { ProcessRuntimeQuestionSchema } from "./process-question-target";
import {
  ProcessStartCommandSchema,
  ProcessStartReceiptSchema,
  ProcessStartInputSchema,
} from "./process-start";
export { ProcessRuntimeQuestionSchema } from "./process-question-target";

const commandId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);
/** A process approval requires the exact parent generation; ordinary chat approvals remain separate. */
export const ProcessResolveCommandSchema = z.strictObject({
  profile: z.literal(PROCESS_EXECUTION_PROFILE),
  type: z.literal("service.resolve"),
  commandId,
  idempotencyKey: commandId,
  conversationId: commandId,
  workItemId: IdentityId,
  expectedWorkRevision: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER),
  operationId: IdentityId,
  approved: z.boolean(),
  language: LanguageSchema,
});
export type ProcessResolveCommand = z.infer<typeof ProcessResolveCommandSchema>;
export const ProcessRuntimeCommandSchema = z.union([
  ProcessStartCommandSchema,
  ProcessResolveCommandSchema,
  ProcessAnswerCommandSchema,
]);
export type ProcessRuntimeCommand = z.infer<typeof ProcessRuntimeCommandSchema>;
export const ProcessRuntimeProfileSchema = z.enum([
  PROCESS_EXECUTION_PROFILE,
  PROCESS_QUESTION_EXECUTION_PROFILE,
]);
export type ProcessRuntimeProfile = z.infer<typeof ProcessRuntimeProfileSchema>;
/** Operational metadata only. Task/chat card projection is a separate contract. */
export const ProcessRuntimeStateSchema = z
  .strictObject({
    parentRunId: IdentityId,
    runId: IdentityId,
    processId: IdentityId,
    version: z.number().int().positive(),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    status: z.enum([
      "running",
      "waiting",
      "succeeded",
      "failed",
      "unknown",
      "cancelled",
    ]),
    approval: z
      .strictObject({ nodeId: z.string().max(80), operationId: IdentityId })
      .optional(),
    question: ProcessRuntimeQuestionSchema.optional(),
    failure: z
      .strictObject({
        code: z.string().max(160),
        nodeId: z.string().max(80).optional(),
        operationId: IdentityId.optional(),
      })
      .optional(),
    output: ProcessStartInputSchema.optional(),
    /** A valid native output can exceed the mobile envelope; keep success and omit it safely. */
    outputTruncated: z.boolean().optional(),
  })
  .refine((value) => !(value.approval && value.question), {
    message: "A question cannot be an approval",
  });
export type ProcessRuntimeState = z.infer<typeof ProcessRuntimeStateSchema>;
export const ProcessRuntimeResponseSchema = z
  .strictObject({
    profile: ProcessRuntimeProfileSchema,
    scope: ScopeSchema,
    commandId,
    admission: ProcessStartReceiptSchema,
    process: ProcessRuntimeStateSchema.optional(),
  })
  .refine(
    (value) =>
      value.profile !== PROCESS_EXECUTION_PROFILE || !value.process?.question,
    { message: "Questions require execution profile 2" },
  );
export type ProcessRuntimeResponse = z.infer<
  typeof ProcessRuntimeResponseSchema
>;
export const ProcessRuntimeReadQuerySchema = z.strictObject({
  parentRunId: IdentityId,
});
export const ProcessRuntimeInterruptRequestSchema = z
  .strictObject({
    profile: ProcessRuntimeProfileSchema,
    command: ProcessRuntimeCommandSchema,
  })
  .refine(
    (value) =>
      value.command.type !== "process.answer" ||
      value.profile === PROCESS_QUESTION_EXECUTION_PROFILE,
    { message: "Answers require execution profile 2" },
  );
export const ProcessRuntimeInterruptResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      profile: ProcessRuntimeProfileSchema,
      scope: ScopeSchema,
      commandId,
      status: z.literal("settled"),
      result: ProcessRuntimeResponseSchema,
    }),
    z.strictObject({
      profile: ProcessRuntimeProfileSchema,
      scope: ScopeSchema,
      commandId,
      status: z.literal("unknown"),
      reason: z.enum(["not_running", "not_settled"]),
    }),
  ],
);
