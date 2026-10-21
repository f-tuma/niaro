import { z } from "zod";
import { ScopeSchema } from "./index";
import { MeetingId, MeetingSourceSchema } from "./meetings";
export const HUMAN_TASK_PROFILE = "niaro-human-tasks/2";
export const HumanTaskId = z.string().regex(/^[a-zA-Z0-9:._-]{1,160}$/);
/** What is still to be resolved and what is missing to resolve it. */
export const HumanTaskContentSchema = z.strictObject({
  title: z.string().trim().min(1).max(1000),
  detail: z.string().max(2000),
  assignee: z.string().min(1).max(160).nullable(),
  due: z.string().min(1).max(160).nullable(),
  /** `due` as a local date (or date and time with offset), when it could be resolved. */
  dueDate: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z))?$/,
    )
    .optional(),
});
export const HumanTaskStatusSchema = z.enum(["open", "done", "removed"]);
/** Who closed an item and why; an agent always says why. */
export const HumanTaskResolutionSchema = z.strictObject({
  by: z.enum(["agent", "user"]),
  reason: z.string().max(500),
  at: z.iso.datetime(),
});
export const HumanTaskSchema = HumanTaskContentSchema.extend({
  id: HumanTaskId,
  scope: ScopeSchema,
  revision: z.number().int().positive(),
  status: HumanTaskStatusSchema,
  resolution: HumanTaskResolutionSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  origin: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("meeting"),
      meetingId: MeetingId,
      meetingTitle: z.string().max(160),
      recordDigest: z.string().regex(/^[a-f0-9]{64}$/),
      sources: z.array(MeetingSourceSchema).min(1).max(4),
    }),
    z.strictObject({
      kind: z.literal("agent"),
      runId: HumanTaskId,
      toolCallId: HumanTaskId,
      conversationId: HumanTaskId,
    }),
  ]),
});
export type HumanTask = z.infer<typeof HumanTaskSchema>;
/** The person's own choices; resolving an item with the agent happens in chat. */
export const HumanTaskCommandSchema = z.strictObject({
  profile: z.literal(HUMAN_TASK_PROFILE),
  commandId: HumanTaskId,
  idempotencyKey: HumanTaskId,
  expectedRevision: z.number().int().positive(),
  decision: z.enum(["complete", "remove", "reopen"]),
});
export type HumanTaskCommand = z.infer<typeof HumanTaskCommandSchema>;
export type HumanTaskTab = "open" | "done";
export const HumanTaskListSchema = z.strictObject({
  profile: z.literal(HUMAN_TASK_PROFILE),
  scope: ScopeSchema,
  tasks: z.array(HumanTaskSchema).max(100),
  next: HumanTaskId.nullable(),
  counts: z.strictObject({
    open: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
  }),
});

export type HumanTaskContent = z.infer<typeof HumanTaskContentSchema>;

/** The status a decision leads to, or null when it does not apply. */
export function humanTaskTransition(
  status: HumanTask["status"],
  decision: HumanTaskCommand["decision"],
): HumanTask["status"] | null {
  if (decision === "reopen") return status === "open" ? null : "open";
  if (status !== "open") return null;
  return decision === "complete" ? "done" : "removed";
}

/** Stored v1 items: proposals and accepted work are open; dismissed ones are removed. */
export function migrateHumanTask(value: unknown): HumanTask {
  const raw = value as Record<string, unknown>;
  if (
    raw.status === "open" ||
    raw.status === "done" ||
    raw.status === "removed"
  )
    return HumanTaskSchema.parse(raw);
  const status =
    raw.status === "completed"
      ? "done"
      : raw.status === "dismissed"
        ? "removed"
        : "open";
  return HumanTaskSchema.parse({
    ...raw,
    status,
    resolution:
      status === "open"
        ? null
        : { by: "user", reason: "", at: String(raw.updatedAt) },
  });
}
