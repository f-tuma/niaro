import { z } from "zod";
import type { Snapshot, WorkItem, DomainEvent } from "./index";
import { ProcessRuntimeQuestionSchema } from "./process-question-target";
import { IdentityId } from "./identity";
import {
  ProcessOutputProvenanceSchema,
  ProcessOutputReferenceSchema,
  PROCESS_OUTPUT_WORK_PROFILE,
} from "./process-output";
import { ServiceResultSchema } from "./service-result";
export { PROCESS_OUTPUT_WORK_PROFILE } from "./process-output";

export const PROCESS_WORK_PROFILE = "agent-process-work/1" as const;
export const PROCESS_QUESTION_WORK_PROFILE = "agent-process-work/2" as const;
export const PROCESS_APPROVAL_WORK_PROFILE = "agent-process-work/3" as const;
export function processWorkDeliveryPath(
  path: string,
  profile:
    | typeof PROCESS_WORK_PROFILE
    | typeof PROCESS_QUESTION_WORK_PROFILE
    | typeof PROCESS_APPROVAL_WORK_PROFILE
    | typeof PROCESS_OUTPUT_WORK_PROFILE = PROCESS_WORK_PROFILE,
) {
  return `${path}${path.includes("?") ? "&" : "?"}tasks=${encodeURIComponent(profile)}`;
}

function withoutOutput(work: WorkItem): WorkItem {
  if (!work.native?.process) return work;
  const {
    output: _output,
    outputUnavailable: _unavailable,
    outputSummary: _summary,
    ...process
  } = work.native.process;
  return { ...work, native: { ...work.native, process } };
}
export function snapshotWithoutProcessOutputs(snapshot: Snapshot): Snapshot {
  return { ...snapshot, workItems: snapshot.workItems.map(withoutOutput) };
}
export function eventsWithoutProcessOutputs(
  events: DomainEvent[],
): DomainEvent[] {
  return events.map((event) =>
    event.type === "work_item.upserted"
      ? { ...event, entity: withoutOutput(event.entity) }
      : event,
  );
}

function withoutQuestion(work: WorkItem): WorkItem {
  if (!work.native?.process) return work;
  const {
    question: _question,
    journalRevision: _journalRevision,
    answerHistory: _answerHistory,
    ...process
  } = work.native.process;
  return {
    ...work,
    status: work.status === "waiting_input" ? "waiting_system" : work.status,
    native: { ...work.native, process },
  };
}
function withoutApproval(work: WorkItem): WorkItem {
  if (!work.native?.process) return work;
  const {
    approval: _approval,
    approvalUnavailable: _unavailable,
    ...process
  } = work.native.process;
  return { ...work, native: { ...work.native, process } };
}
/** Both earlier strict process-work profiles predate canonical approval review. */
export function snapshotWithoutProcessApprovals(snapshot: Snapshot): Snapshot {
  return { ...snapshot, workItems: snapshot.workItems.map(withoutApproval) };
}
export function eventsWithoutProcessApprovals(
  events: DomainEvent[],
): DomainEvent[] {
  return events.map((event) =>
    event.type === "work_item.upserted"
      ? { ...event, entity: withoutApproval(event.entity) }
      : event,
  );
}
export function snapshotWithoutProcessQuestions(snapshot: Snapshot): Snapshot {
  return { ...snapshot, workItems: snapshot.workItems.map(withoutQuestion) };
}
export function eventsWithoutProcessQuestions(
  events: DomainEvent[],
): DomainEvent[] {
  return events.map((event) =>
    event.type === "work_item.upserted"
      ? { ...event, entity: withoutQuestion(event.entity) }
      : event,
  );
}
function compatibleWork(work: WorkItem): WorkItem {
  if (!work.native?.process) return work;
  const { card: _card, ...plain } = work;
  const { process: _process, ...native } = work.native;
  return { ...plain, native };
}
/** Unnegotiated strict clients keep a safe textual projection, without new native fields. */
export function snapshotWithoutProcessWork(snapshot: Snapshot): Snapshot {
  return { ...snapshot, workItems: snapshot.workItems.map(compatibleWork) };
}
export function eventsWithoutProcessWork(events: DomainEvent[]): DomainEvent[] {
  return events.map((event) =>
    event.type === "work_item.upserted"
      ? { ...event, entity: compatibleWork(event.entity) }
      : event,
  );
}

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);
/** Historical identity of the pinned run; never an active-version lookup. */
export const ProcessProvenanceSchema = ProcessOutputProvenanceSchema;
const catalogRevision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
/** Exact original pending receipt; passive generated cards are not approval authority. */
export const ProcessApprovalSchema = z.strictObject({
  nodeId: z.string().min(1).max(80),
  serviceId: IdentityId,
  serviceRevision: catalogRevision,
  actionId: IdentityId,
  actionRevision: catalogRevision,
  result: ServiceResultSchema.omit({ card: true }).extend({
    status: z.literal("awaiting_approval"),
    inputJson: z
      .string()
      .min(2)
      .max(131072)
      .refine((value) => {
        try {
          const input = JSON.parse(value);
          return (
            input !== null && typeof input === "object" && !Array.isArray(input)
          );
        } catch {
          return false;
        }
      }, "Approval parameters must contain the complete original JSON object"),
  }),
});
export type ProcessApproval = z.infer<typeof ProcessApprovalSchema>;
export const ProcessWorkSchema = z
  .strictObject({
    kind: z.literal("service-process-1"),
    provenance: ProcessProvenanceSchema,
    /** Server-owned admission time for stable recent-run ordering in clients. */
    startedAt: z.iso.datetime().optional(),
    status: z.enum([
      "running",
      "waiting",
      "succeeded",
      "failed",
      "unknown",
      "cancelled",
      "interrupted",
    ]),
    journalStatus: z.enum([
      "running",
      "waiting",
      "succeeded",
      "failed",
      "unknown",
      "cancelled",
    ]),
    detailsAvailable: z.boolean(),
    output: ProcessOutputReferenceSchema.optional(),
    outputUnavailable: z.enum(["context", "invalid", "limit"]).optional(),
    outputSummary: z
      .strictObject({
        fieldCount: z.number().int().min(0).max(40),
        shownFields: z.number().int().min(0).max(8),
        clipped: z.boolean(),
        redacted: z.boolean(),
      })
      .optional(),
    approval: ProcessApprovalSchema.optional(),
    approvalUnavailable: z
      .enum(["context", "parameters", "identity"])
      .optional(),
    question: ProcessRuntimeQuestionSchema.optional(),
    /** Authoritative parent generation; outer projected WorkItem revision is independent. */
    journalRevision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    /** Consumed user text only; never a native completion or approval claim. */
    answerHistory: z
      .array(
        z.strictObject({
          commandId: id,
          questionId: id,
          answer: z
            .string()
            .max(4000)
            .refine((value) => value.trim().length > 0),
        }),
      )
      .max(64)
      .refine(
        (values) =>
          new Set(values.map((v) => v.questionId)).size === values.length &&
          new Set(values.map((v) => v.commandId)).size === values.length,
      )
      .optional(),
    receipts: z
      .array(
        z.strictObject({
          operationId: id,
          title: z.string().min(1).max(100),
          service: z.string().min(1).max(100),
          effect: z.enum(["read", "write"]),
          status: z.enum([
            "awaiting_approval",
            "running",
            "succeeded",
            "failed",
            "unknown",
            "rejected",
          ]),
          summary: z.string().max(600),
        }),
      )
      .max(64)
      .refine(
        (values) =>
          new Set(values.map((v) => v.operationId)).size === values.length,
      ),
  })
  .refine(
    (value) =>
      !value.output ||
      (value.detailsAvailable &&
        value.status === "succeeded" &&
        value.journalStatus === "succeeded" &&
        !value.outputUnavailable &&
        !!value.outputSummary &&
        value.outputSummary.shownFields <= value.outputSummary.fieldCount &&
        value.output.provenance.artifactDigest ===
          value.provenance.artifactDigest &&
        JSON.stringify(value.output.provenance) ===
          JSON.stringify(value.provenance)),
    { message: "Output must identify the exact available completed process" },
  )
  .refine((value) => !value.question || value.journalRevision !== undefined, {
    message: "A question needs its native journal generation",
  })
  .refine(
    (value) => {
      if (!value.approval) return true;
      const awaiting = value.receipts.filter(
        (receipt) => receipt.status === "awaiting_approval",
      );
      const result = value.approval.result;
      return (
        !value.approvalUnavailable &&
        !value.question &&
        value.detailsAvailable &&
        value.status === "waiting" &&
        value.journalStatus === "waiting" &&
        awaiting.length === 1 &&
        awaiting[0]!.operationId === result.operationId &&
        awaiting[0]!.title === result.title &&
        awaiting[0]!.service === result.service &&
        awaiting[0]!.effect === result.effect
      );
    },
    {
      message: "An approval must identify the exact available waiting receipt",
    },
  );
export type ProcessProvenance = z.infer<typeof ProcessProvenanceSchema>;
export type ProcessWork = z.infer<typeof ProcessWorkSchema>;
