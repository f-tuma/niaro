import { z } from "zod";

/** Bounded diagnostic evidence, never authorization or permission to retry. */
export const ActionFailureSchema = z.strictObject({
  code: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/),
  kind: z.enum([
    "validation",
    "permission",
    "connection",
    "rate_limit",
    "provider",
    "response",
    "cancelled",
    "unknown",
  ]),
  stage: z.enum([
    "validation",
    "connection",
    "dispatch",
    "provider_response",
    "result_commit",
  ]),
  retry: z.enum([
    "correct_input",
    "reconnect",
    "later",
    "verify_first",
    "none",
  ]),
  message: z.string().max(600).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  fields: z
    .array(
      z.strictObject({ path: z.string().max(160), issue: z.string().max(300) }),
    )
    .max(8),
});
export type ActionFailure = z.infer<typeof ActionFailureSchema>;
