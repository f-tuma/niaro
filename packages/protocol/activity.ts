import { z } from "zod";
import { CommandSchema, ScopeSchema } from "./index";

/** Optional, read-only extension. Progress never grants consent or changes work. */
export const LEGACY_ACTIVITY_PROFILE = "agent-activity/1" as const;
export const TOOL_ACTIVITY_PROFILE = "agent-activity/2" as const;
export const WORKFLOW_ACTIVITY_PROFILE = "agent-activity/3" as const;
/** Adds the answer's draft while it is written. */
export const ACTIVITY_PROFILE = "agent-activity/4" as const;
/** A reply (2,000 characters) and its program (16,000) with the fence. */
export const ACTIVITY_DRAFT_MAX = 18_500;
export const ActivityCommandIdSchema = CommandSchema.options[0].shape.commandId;
const ActivityBase = z.strictObject({
  commandId: ActivityCommandIdSchema,
  conversationId: ActivityCommandIdSchema,
  status: z.enum(["running", "succeeded", "failed"]),
  steps: z
    .array(
      z.strictObject({
        id: z.enum(["understanding", "crm", "preparing"]),
        status: z.enum(["pending", "running", "succeeded", "failed"]),
      }),
    )
    .min(2)
    .max(3),
});
export const LegacyRequestActivitySchema = ActivityBase.superRefine(
  (activity, ctx) => {
    const pattern = activity.steps.map((step) => step.id).join(",");
    const states = activity.steps.map((step) => step.status).join(",");
    const valid =
      activity.status === "succeeded"
        ? activity.steps.every((step) => step.status === "succeeded")
        : new RegExp(
            `^(succeeded,)*${activity.status === "running" ? "running" : "failed"}(,pending)*$`,
          ).test(states);
    if (
      !valid ||
      !["understanding,preparing", "understanding,crm,preparing"].includes(
        pattern,
      )
    )
      ctx.addIssue({ code: "custom", message: "Invalid activity sequence" });
  },
);
export const ActivityToolSchema = z.strictObject({
  id: z.literal("datetime"),
  status: z.enum(["running", "succeeded", "needs_input", "failed"]),
  calls: z.number().int().min(1).max(4),
});
export type ActivityTool = z.infer<typeof ActivityToolSchema>;
export const ToolRequestActivitySchema = ActivityBase.extend({
  tools: z.array(ActivityToolSchema).max(1).optional(),
}).superRefine((activity, ctx) => {
  const { tools, ...base } = activity;
  if (!LegacyRequestActivitySchema.safeParse(base).success)
    ctx.addIssue({ code: "custom", message: "Invalid activity sequence" });
  if (
    activity.status !== "running" &&
    tools?.some(
      (tool) =>
        tool.status === "running" ||
        (activity.status === "succeeded" && tool.status === "failed"),
    )
  )
    ctx.addIssue({ code: "custom", message: "Invalid terminal tool status" });
});
/** Bounded server-owned stages only; labels and presentation belong to clients. */
export const ActivityWorkflowSchema = z.strictObject({
  step: z.number().int().min(1).max(5),
  stage: z.enum(["service", "action", "inputs", "execute"]),
});
export type ActivityWorkflow = z.infer<typeof ActivityWorkflowSchema>;
export const WorkflowRequestActivitySchema = ActivityBase.extend({
  tools: z.array(ActivityToolSchema).max(1).optional(),
  workflow: ActivityWorkflowSchema.optional(),
}).superRefine((activity, ctx) => {
  const { workflow: _workflow, ...base } = activity;
  if (!ToolRequestActivitySchema.safeParse(base).success)
    ctx.addIssue({ code: "custom", message: "Invalid activity sequence" });
});
/**
 * `draft` is the answer while the model writes it: its raw text, with any
 * OpenUI program not yet admitted. Clients show it in place of the progress
 * until the stored message replaces it; it may differ from that message or
 * vanish (a checker repair, a system answer, a failure). Transient memory only.
 */
export const RequestActivitySchema = ActivityBase.extend({
  tools: z.array(ActivityToolSchema).max(1).optional(),
  workflow: ActivityWorkflowSchema.optional(),
  draft: z.string().min(1).max(ACTIVITY_DRAFT_MAX).optional(),
}).superRefine((activity, ctx) => {
  const { draft, ...base } = activity;
  if (!WorkflowRequestActivitySchema.safeParse(base).success)
    ctx.addIssue({ code: "custom", message: "Invalid activity sequence" });
  if (draft !== undefined && activity.status !== "running")
    ctx.addIssue({
      code: "custom",
      message: "A finished request has no draft",
    });
});
export type RequestActivity = z.infer<typeof RequestActivitySchema>;
export function workflowActivity(activity: RequestActivity | null) {
  if (!activity) return null;
  const { draft: _draft, ...base } = activity;
  return base;
}
export function toolActivity(activity: RequestActivity | null) {
  if (!activity) return null;
  const { workflow: _workflow, draft: _draft, ...base } = activity;
  return base;
}
export function legacyActivity(activity: RequestActivity | null) {
  if (!activity) return null;
  return {
    commandId: activity.commandId,
    conversationId: activity.conversationId,
    status: activity.status,
    steps: activity.steps,
  };
}
const ResponseBase = z.strictObject({
  scope: ScopeSchema,
  commandId: ActivityCommandIdSchema,
});
export const ActivityResponseSchema = z
  .discriminatedUnion("profile", [
    ResponseBase.extend({
      profile: z.literal(ACTIVITY_PROFILE),
      activity: RequestActivitySchema.nullable(),
    }),
    ResponseBase.extend({
      profile: z.literal(WORKFLOW_ACTIVITY_PROFILE),
      activity: WorkflowRequestActivitySchema.nullable(),
    }),
    ResponseBase.extend({
      profile: z.literal(TOOL_ACTIVITY_PROFILE),
      activity: ToolRequestActivitySchema.nullable(),
    }),
    ResponseBase.extend({
      profile: z.literal(LEGACY_ACTIVITY_PROFILE),
      activity: LegacyRequestActivitySchema.nullable(),
    }),
  ])
  .refine(
    (value) => !value.activity || value.activity.commandId === value.commandId,
    "Activity must match the requested command",
  );
