import { z } from "zod";
import {
  CommandSchema,
  CommandResultSchema,
  ScopeSchema,
  sameScope,
} from "./index";

/** Explicit interruption never retries the original command or grants consent. */
export const REQUEST_INTERRUPTION_PROFILE =
  "agent-request-interruption/1" as const;
export const RequestInterruptionRequestSchema = z.strictObject({
  profile: z.literal(REQUEST_INTERRUPTION_PROFILE),
  command: CommandSchema,
});
const base = z.strictObject({
  profile: z.literal(REQUEST_INTERRUPTION_PROFILE),
  scope: ScopeSchema,
  commandId: CommandSchema.options[0].shape.commandId,
});
export const RequestInterruptionResponseSchema = z
  .discriminatedUnion("status", [
    base.extend({ status: z.literal("settled"), result: CommandResultSchema }),
    base.extend({
      status: z.literal("unknown"),
      reason: z.enum(["not_running", "not_settled"]),
    }),
  ])
  .refine(
    (value) =>
      value.status !== "settled" ||
      (value.commandId === value.result.commandId &&
        sameScope(value.scope, value.result.snapshot.scope)),
    "The result must match the interrupted command and authenticated scope",
  );
export type RequestInterruptionRequest = z.infer<
  typeof RequestInterruptionRequestSchema
>;
export type RequestInterruptionResponse = z.infer<
  typeof RequestInterruptionResponseSchema
>;
