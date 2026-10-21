import { z } from "zod";
import { ActionFailureSchema } from "./action-failure";
import { IdentityId, IdentityName } from "./identity";
import { ProcessProvenanceSchema } from "./process-work";

export const LOOPS_PROFILE = "agent-loops/1" as const;
export const LoopStatus = z.enum([
  "running",
  "succeeded",
  "waiting",
  "failed",
  "cancelled",
  "interrupted",
  "unknown",
]);
// Schema and inferred type intentionally share the public contract name.
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type LoopStatus = z.infer<typeof LoopStatus>;
export const LoopId = z.string().regex(/^[a-f0-9]{64}$/);
export const LoopQuery = z.strictObject({
  organizationId: IdentityId,
  workspaceId: IdentityId.optional(),
  status: LoopStatus.optional(),
  before: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .refine((value) => Number.isSafeInteger(Number(value)))
    .optional(),
});
export const LoopSummarySchema = z.strictObject({
  id: LoopId,
  workspaceId: IdentityId,
  workspaceName: IdentityName.nullable(),
  actorId: IdentityId,
  actorName: IdentityName.nullable(),
  request: z.string().max(8000),
  reply: z.string().max(2000).nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  status: LoopStatus,
  /** Set only when a native run was persisted as running at this server's startup. */
  statusEvidence: z.enum(["last_saved_unverified"]).optional(),
  /** A terminal candidate exists, but the runtime has not confirmed a final result. */
  unconfirmedFailure: z.literal(true).optional(),
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  inferenceCalls: z.number().int().nonnegative(),
  traceMode: z.enum(["recorded", "reconstructed"]),
  process: ProcessProvenanceSchema.optional(),
});
export type LoopSummary = z.infer<typeof LoopSummarySchema>;
const LoopActionField = z.strictObject({
  label: z.string().max(80),
  value: z.string().max(1000),
});
/** Allowlisted operational previews. Empty fields do not imply recorded evidence. */
export const LoopToolDetailsSchema = z.strictObject({
  name: z.string().min(1).max(160),
  outcome: z.enum([
    "pending",
    "completed",
    "waiting",
    "failed",
    "invalid_arguments",
    "unavailable",
    "skipped",
    "cancelled",
    "unknown",
  ]),
  input: z.array(LoopActionField).max(12),
  output: z.array(LoopActionField).max(12),
  inputRecorded: z.boolean(),
  outputRecorded: z.boolean(),
  inputTruncated: z.boolean(),
  outputTruncated: z.boolean(),
  failure: ActionFailureSchema.optional(),
});
export type LoopToolDetails = z.infer<typeof LoopToolDetailsSchema>;
export const LoopActionDetailsSchema = z.strictObject({
  operationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  serviceName: z.string().max(100),
  actionName: z.string().max(100),
  effect: z.enum(["read", "write"]),
  status: z.enum([
    "awaiting_approval",
    "running",
    "succeeded",
    "failed",
    "unknown",
    "rejected",
  ]),
  phase: z.enum(["proposal", "execution"]),
  input: z.array(LoopActionField).max(12),
  output: z.array(LoopActionField).max(12),
  inputTruncated: z.boolean(),
  outputTruncated: z.boolean(),
  failure: ActionFailureSchema.optional(),
});
export type LoopActionDetails = z.infer<typeof LoopActionDetailsSchema>;
export const LoopNodeSchema = z.strictObject({
  id: z.string().min(1).max(160),
  kind: z.enum([
    "request",
    "model",
    "decision",
    "tool",
    "result",
    "question",
    "reply",
    "error",
  ]),
  label: z.string().max(160),
  status: LoopStatus,
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  details: z
    .array(
      z.strictObject({
        label: z.string().max(80),
        value: z.string().max(2000),
      }),
    )
    .max(12),
  action: LoopActionDetailsSchema.optional(),
  tool: LoopToolDetailsSchema.optional(),
});
export type LoopNode = z.infer<typeof LoopNodeSchema>;
export const LoopEdgeSchema = z.strictObject({
  id: z.string().min(1).max(160),
  source: z.string().min(1).max(160),
  target: z.string().min(1).max(160),
  kind: z.enum(["flow", "result", "retry"]),
});
export type LoopEdge = z.infer<typeof LoopEdgeSchema>;
export const LoopPageSchema = z.strictObject({
  profile: z.literal(LOOPS_PROFILE),
  organizationId: IdentityId,
  entries: z.array(LoopSummarySchema).max(50),
  nextBefore: z.string().nullable(),
});
export type LoopPage = z.infer<typeof LoopPageSchema>;
export const LoopDetailSchema = z.strictObject({
  profile: z.literal(LOOPS_PROFILE),
  organizationId: IdentityId,
  run: LoopSummarySchema,
  nodes: z.array(LoopNodeSchema).max(160),
  edges: z.array(LoopEdgeSchema).max(320),
  truncated: z.boolean(),
});
export type LoopDetail = z.infer<typeof LoopDetailSchema>;
