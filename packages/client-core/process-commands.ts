import { z } from "zod";
import {
  ScopeSchema,
  WorkItemSchema,
  sameScope,
  type Scope,
  type Language,
  type WorkItem,
} from "../protocol";
import {
  PROCESS_EXECUTION_PROFILE,
  ProcessExecutionEntrySchema,
  ProcessInputCardSchema,
  type ProcessExecutionEntry,
  type ProcessInputCard,
} from "../protocol/process-execution";
import {
  ProcessResolveCommandSchema,
  ProcessRuntimeResponseSchema,
  type ProcessResolveCommand,
} from "../protocol/process-coordinator";
import {
  PROCESS_START_PROFILE,
  ProcessStartCommandSchema,
  type ProcessStartCommand,
} from "../protocol/process-start";
import {
  ProcessProvenanceSchema,
  ProcessWorkSchema,
  ProcessApprovalSchema,
} from "../protocol/process-work";
import {
  canonicalProcessJson,
  processCommandDigest,
} from "./process-command-digest";
import type { Store } from "./store";

const connectionKey = z.string().min(1).max(2000);
const sameJson = (left: unknown, right: unknown) =>
  canonicalProcessJson(left) === canonicalProcessJson(right);

export function deepFreezeProcessValue<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreezeProcessValue(child);
    Object.freeze(value);
  }
  return value;
}

/** The complete server form and reviewed ready inventory entry travel with retries. */
export const ProcessStartTargetSchema = z
  .strictObject({
    type: z.literal("process.start"),
    connectionKey,
    scope: ScopeSchema,
    entry: ProcessExecutionEntrySchema.options[0],
    card: ProcessInputCardSchema,
  })
  .refine(
    ({ scope, entry, card }) => {
      const { form, intent } = card;
      return (
        sameScope(scope, form.scope) &&
        form.processId === entry.processId &&
        form.version === entry.version &&
        form.artifactDigest === entry.artifactDigest &&
        form.kind === entry.kind &&
        form.name === entry.name &&
        form.description === entry.description &&
        sameJson(form.inputSchema, entry.inputSchema) &&
        sameJson(form.inputSchema, intent.inputSchema) &&
        sameJson(form.origin, intent.origin) &&
        (form.origin.type === "command" ||
          form.origin.type === "meeting") &&
        processCommandDigest(form) === card.formDigest &&
        card.formDigest === intent.formDigest
      );
    },
    {
      message: "The reviewed process entry and complete issued form must match",
    },
  );
export type ProcessStartTarget = z.infer<typeof ProcessStartTargetSchema>;

const provenance = ProcessProvenanceSchema.extend({
  conversationId: ProcessResolveCommandSchema.shape.conversationId,
  commandId: ProcessResolveCommandSchema.shape.commandId,
  admissionId: ProcessResolveCommandSchema.shape.workItemId,
});
export const ProcessResolveTargetSchema = z
  .strictObject({
    type: z.literal("service.resolve"),
    connectionKey,
    scope: ScopeSchema,
    workItemId: ProcessResolveCommandSchema.shape.workItemId,
    conversationId: ProcessResolveCommandSchema.shape.conversationId,
    expectedWorkRevision:
      ProcessResolveCommandSchema.shape.expectedWorkRevision,
    provenance,
    receipt: ProcessWorkSchema.shape.receipts.element.extend({
      status: z.literal("awaiting_approval"),
    }),
    /** Optional only for historical, already-persisted exact retries. */
    approval: ProcessApprovalSchema.optional(),
  })
  .refine(
    (target) =>
      target.provenance.actorId === target.scope.userId &&
      target.provenance.conversationId === target.conversationId &&
      (!target.approval ||
        (target.approval.result.operationId === target.receipt.operationId &&
          target.approval.result.effect === target.receipt.effect &&
          target.approval.result.title === target.receipt.title &&
          target.approval.result.service === target.receipt.service)),
    { message: "An approval must belong to the exact actor and conversation" },
  );
export type ProcessResolveTarget = z.infer<typeof ProcessResolveTargetSchema>;
export const ProcessCommandTargetSchema = z.discriminatedUnion("type", [
  ProcessStartTargetSchema,
  ProcessResolveTargetSchema,
]);
export type ProcessCommandTarget = z.infer<typeof ProcessCommandTargetSchema>;
export type ProcessCommand = ProcessStartCommand | ProcessResolveCommand;

export function captureProcessStartTarget(
  endpoint: string,
  scope: Scope,
  entry: ProcessExecutionEntry,
  card: ProcessInputCard,
): ProcessStartTarget {
  return deepFreezeProcessValue(
    ProcessStartTargetSchema.parse({
      type: "process.start",
      connectionKey: endpoint,
      scope,
      entry,
      card,
    }),
  );
}

export function captureProcessResolveTarget(
  store: Store,
  workItemId: string,
  operationId?: string,
  conversationId?: string,
  reviewedWork?: WorkItem,
): ProcessResolveTarget {
  if (store.stale || store.needsSnapshot)
    throw Error("process_approval_changed");
  const parsed = WorkItemSchema.safeParse(
    reviewedWork ?? store.workItems[workItemId],
  );
  if (!parsed.success) throw Error("process_approval_changed");
  const work = parsed.data,
    native = work.native,
    process = native?.process;
  const pending = process?.receipts.filter(
    (receipt) => receipt.status === "awaiting_approval",
  );
  if (
    !native ||
    !process ||
    work.id !== workItemId ||
    work.status !== "waiting_approval" ||
    process.status !== "waiting" ||
    process.journalStatus !== "waiting" ||
    !process.detailsAvailable ||
    !process.approval ||
    process.approvalUnavailable ||
    process.question ||
    pending?.length !== 1 ||
    (operationId !== undefined && pending[0]!.operationId !== operationId) ||
    (conversationId !== undefined && work.conversationId !== conversationId)
  )
    throw Error("process_approval_changed");
  const target = ProcessResolveTargetSchema.safeParse({
    type: "service.resolve",
    connectionKey: store.connectionKey,
    scope: store.scope,
    workItemId: work.id,
    conversationId: work.conversationId,
    expectedWorkRevision: native.revision,
    provenance: process.provenance,
    receipt: pending[0],
    approval: process.approval,
  });
  if (!target.success) throw Error("process_approval_changed");
  const frozen = deepFreezeProcessValue(target.data);
  // A rendered review cannot capture a newer pending operation through its old callback.
  if (reviewedWork) assertProcessCommandTarget(store, frozen);
  return frozen;
}

/** First delivery needs a fresh store. Explicit original retries retain their saved target. */
export function assertProcessCommandTarget(
  store: Store,
  target: ProcessCommandTarget,
): void {
  const frozen = ProcessCommandTargetSchema.parse(target);
  const error =
    frozen.type === "process.start"
      ? "process_start_changed"
      : "process_approval_changed";
  if (
    store.stale ||
    store.needsSnapshot ||
    store.connectionKey !== frozen.connectionKey ||
    !sameScope(store.scope, frozen.scope)
  )
    throw Error(error);
  if (frozen.type === "service.resolve") {
    const current = captureProcessResolveTarget(
      store,
      frozen.workItemId,
      frozen.receipt.operationId,
      frozen.conversationId,
    );
    if (!sameJson(current, frozen)) throw Error(error);
  }
}

/** Validate a durable target without consulting a newer inventory or pending operation. */
export function validateProcessCommandTarget(
  raw: unknown,
  rawTarget: ProcessCommandTarget,
  address: string,
  scope: Scope,
): void {
  const target = ProcessCommandTargetSchema.parse(rawTarget);
  if (target.connectionKey !== address || !sameScope(target.scope, scope))
    throw Error("scope_mismatch");
  if (target.type === "process.start") {
    const command = ProcessStartCommandSchema.parse(raw);
    if (
      command.intentId !== target.card.intent.intentId ||
      command.conversationId !== target.card.form.origin.conversationId ||
      command.language !== target.card.form.language
    )
      throw Error("process_start_changed");
  } else {
    const command = ProcessResolveCommandSchema.parse(raw);
    if (
      command.workItemId !== target.workItemId ||
      command.conversationId !== target.conversationId ||
      command.operationId !== target.receipt.operationId ||
      command.expectedWorkRevision !== target.expectedWorkRevision
    )
      throw Error("process_approval_changed");
  }
}

export function processStartCommand(
  target: ProcessStartTarget,
  input: {
    commandId: string;
    idempotencyKey: string;
    input: unknown;
    language: Language;
  },
): ProcessStartCommand {
  const frozen = ProcessStartTargetSchema.parse(target);
  const command = ProcessStartCommandSchema.parse({
    profile: PROCESS_START_PROFILE,
    type: "process.start",
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    intentId: frozen.card.intent.intentId,
    conversationId: frozen.card.form.origin.conversationId,
    language: input.language,
    input: input.input,
  });
  validateProcessCommandTarget(
    command,
    frozen,
    frozen.connectionKey,
    frozen.scope,
  );
  return deepFreezeProcessValue(command);
}
export const createProcessStartCommand = processStartCommand;

export function processResolveCommand(
  store: Store,
  target: ProcessResolveTarget,
  input: {
    commandId: string;
    idempotencyKey: string;
    approved: boolean;
    language: Language;
  },
): ProcessResolveCommand {
  assertProcessCommandTarget(store, target);
  const frozen = ProcessResolveTargetSchema.parse(target);
  return deepFreezeProcessValue(
    ProcessResolveCommandSchema.parse({
      profile: PROCESS_EXECUTION_PROFILE,
      type: "service.resolve",
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      conversationId: frozen.conversationId,
      workItemId: frozen.workItemId,
      expectedWorkRevision: frozen.expectedWorkRevision,
      operationId: frozen.receipt.operationId,
      approved: input.approved,
      language: input.language,
    }),
  );
}

/** Public admission consistency only; the envelope has no separate decision proof. */
export function assertProcessCommandResponse(
  rawCommand: unknown,
  rawTarget: ProcessCommandTarget,
  rawResult: unknown,
  expectedTransportProfile: string,
): void {
  const target = ProcessCommandTargetSchema.parse(rawTarget);
  validateProcessCommandTarget(
    rawCommand,
    target,
    target.connectionKey,
    target.scope,
  );
  const command =
    target.type === "process.start"
      ? ProcessStartCommandSchema.parse(rawCommand)
      : ProcessResolveCommandSchema.parse(rawCommand);
  const result = ProcessRuntimeResponseSchema.parse(rawResult),
    receipt = result.admission;
  const reject = () => {
    throw Error("process_response_mismatch");
  };
  if (
    result.profile !== expectedTransportProfile ||
    !sameScope(result.scope, target.scope) ||
    result.commandId !== command.commandId
  )
    reject();
  if (target.type === "process.start" && command.type === "process.start") {
    const { intent } = target.card;
    if (
      receipt.commandId !== command.commandId ||
      receipt.idempotencyKey !== command.idempotencyKey ||
      receipt.commandDigest !== processCommandDigest(command) ||
      receipt.intentId !== command.intentId ||
      !sameJson(receipt.origin, intent.origin) ||
      receipt.processId !== intent.processId ||
      receipt.version !== intent.version ||
      receipt.artifactDigest !== intent.artifactDigest ||
      receipt.formDigest !== intent.formDigest
    )
      reject();
    if (
      receipt.status === "admitted" &&
      (receipt.inputDigest !== processCommandDigest(command.input) ||
        receipt.inputDigest !== processCommandDigest(receipt.input) ||
        !sameJson(receipt.input, command.input))
    )
      reject();
  } else if (target.type === "service.resolve") {
    const p = target.provenance;
    if (
      receipt.status !== "admitted" ||
      receipt.receiptId !== p.admissionId ||
      receipt.commandId !== p.commandId ||
      receipt.origin.conversationId !== target.conversationId ||
      receipt.parentRunId !== target.workItemId ||
      receipt.runId !== p.runId ||
      receipt.processId !== p.processId ||
      receipt.version !== p.version ||
      receipt.artifactDigest !== p.artifactDigest ||
      receipt.inputDigest !== processCommandDigest(receipt.input)
    )
      reject();
  }
  if (receipt.status === "rejected") {
    if (result.process) reject();
  } else {
    const p = result.process;
    if (
      !p ||
      p.parentRunId !== receipt.parentRunId ||
      p.runId !== receipt.runId ||
      p.processId !== receipt.processId ||
      p.version !== receipt.version
    )
      reject();
    // Resolving A may advance the run to B or a question. A remains the frozen command target.
  }
}
export const validateProcessRuntimeResponse = assertProcessCommandResponse;
