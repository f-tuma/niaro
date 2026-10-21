import { z } from "zod";
import { IdentityId } from "./identity";
import { ProcessKey } from "./service-processes";

/** Safe exact public target; private checkpoint proof and scope stay on the server. */
export const ProcessRuntimeQuestionSchema = z.strictObject({
  nodeId: ProcessKey,
  childRunId: IdentityId,
  toolCallId: z.string().min(1).max(200),
  questionId: IdentityId,
  questionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  question: z
    .string()
    .min(1)
    .max(2000)
    .refine((value) => value.trim().length > 0),
});
