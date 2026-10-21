import { z } from "zod";
import { ScopeSchema, sameScope, type Language, type Scope } from "../protocol";
import { PROCESS_START_REJECTIONS } from "../protocol/process-start";
import type { ProcessRuntimeResponse } from "../protocol/process-coordinator";
import type { TranslationKey } from "../i18n";
import { processCommandDigest } from "./process-command-digest";
import type {
  ClientSession,
  ProcessPendingView,
  SessionCommand,
  SessionState,
} from "./session";

/** Local display metadata only; never a server/native failure or delivery outcome. */
export const PROCESS_EXECUTION_UNVERIFIED =
  "client.process-execution-unverified" as const;
const executionUnverifiedCopy = "savedProcessExecutionUnverified" as const;

export function isReservedProcessRecoveryCopy(code: string) {
  return (
    code === PROCESS_EXECUTION_UNVERIFIED || code === executionUnverifiedCopy
  );
}

/** Only a validated unknown outbox selects internal recovery copy. Local errors win. */
export function processPendingRecoveryError(
  pending: ProcessPendingView | null,
  error: string | null,
): string | null {
  if (
    pending?.outcome === "unknown" &&
    !pending.notice &&
    pending.error === PROCESS_EXECUTION_UNVERIFIED
  ) {
    if (!error || error === "network_error") return executionUnverifiedCopy;
    return isReservedProcessRecoveryCopy(error) ? "network_error" : error;
  }
  const code = pending?.error ?? error;
  return code && isReservedProcessRecoveryCopy(code)
    ? error && !isReservedProcessRecoveryCopy(error)
      ? error
      : "network_error"
    : code;
}

const id = z.string().min(1).max(160);
const provenance = z.strictObject({
  parentRunId: id,
  runId: id,
  processId: id,
  version: z.number().int().positive(),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  admissionId: id,
  startCommandId: id,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum([
    "running",
    "waiting",
    "succeeded",
    "failed",
    "unknown",
    "cancelled",
  ]),
});
/** Display evidence only. It cannot authorize delivery, approval or retry. */
export const ProcessCommandNoticeSchema = z.strictObject({
  commandId: id,
  commandType: z.enum(["process.start", "service.resolve", "process.answer"]),
  commandDigest: z.string().regex(/^[a-f0-9]{64}$/),
  connectionKey: z.string().min(1).max(2048),
  scope: ScopeSchema,
  conversationId: id,
  approved: z.boolean().optional(),
  rawCode: z.string().max(160).nullable(),
  result: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("refused"),
      reason: z.enum(PROCESS_START_REJECTIONS),
    }),
    provenance.extend({ kind: z.literal("process") }),
  ]),
});
export type ProcessCommandNotice = z.infer<typeof ProcessCommandNoticeSchema>;
/** The instance and UI generation are deliberately never serialized. */
export type ProcessNoticeOwner = Readonly<{
  session: ClientSession;
  identityKey: string;
  connectionKey: string;
  scope: Scope;
  conversationId: string;
  chatGeneration: number;
  language: Language;
}>;
export type ProcessCommandNoticeView = Readonly<{
  notice: ProcessCommandNotice;
  owner: ProcessNoticeOwner | null;
  /** Ephemeral causal evidence; a matching string alone never owns an error. */
  errorSource:
    | Readonly<{ kind: "runtime" }>
    | Readonly<{
        kind: "local";
        code:
          | "storage_error"
          | "auth_expired"
          | "network_error"
          | "connection_failed"
          | "requestInterruptFailed";
      }>;
}>;
export type ProcessNoticeLocalError = Extract<
  ProcessCommandNoticeView["errorSource"],
  { kind: "local" }
>["code"];
export type SelectedProcessNotice = Readonly<{
  kind: "declined" | "failed" | "unknown" | "interrupted" | "refused";
  key: TranslationKey;
  detailKey?: TranslationKey;
  error: boolean;
}>;
// Runtime failure codes and display copy are different contracts. Only these
// explicit causes have copy that is safe after earlier actions have completed.
const failureDetails: Readonly<Record<string, TranslationKey>> = Object.freeze({
  catalog_budget_exhausted: "catalog_budget_exhausted",
  catalog_budget_price_required: "catalog_budget_price_required",
  catalog_budget_overrun: "catalog_budget_overrun",
  catalog_budget_usage_unknown: "catalog_budget_usage_unknown",
  catalog_budget_policy_changed: "catalog_budget_policy_changed",
  catalog_budget_request_too_large: "catalog_budget_request_too_large",
  catalog_provider_limit: "catalog_provider_limit",
  catalog_model_required: "catalog_model_required",
  catalog_conflict: "catalog_conflict",
  catalog_not_found: "catalog_not_found",
  process_service_unavailable: "process_service_unavailable",
  process_model_unavailable: "process_model_unavailable",
  process_source_changed: "process_source_changed",
  process_sources_changed: "process_sources_changed",
  process_origin_changed: "process_origin_changed",
  process_connection_required: "process_connection_required",
  process_qualification_required: "process_qualification_required",
  process_definition_invalid: "process_definition_invalid",
  process_budget_unavailable: "process_budget_unavailable",
  process_output_invalid: "processResultOutputInvalid",
});

export function captureProcessNoticeOwner(
  session: ClientSession,
  context: Pick<
    ProcessNoticeOwner,
    "conversationId" | "chatGeneration" | "language"
  >,
): ProcessNoticeOwner | undefined {
  const store = session.getSnapshot().store;
  if (!store) return undefined;
  return Object.freeze({
    session,
    identityKey: session.identityKey,
    connectionKey: store.connectionKey,
    scope: Object.freeze({ ...store.scope }),
    conversationId: context.conversationId,
    chatGeneration: context.chatGeneration,
    language: context.language,
  });
}

export function sameProcessNoticeOwner(
  left: ProcessNoticeOwner | null,
  right: ProcessNoticeOwner | undefined,
) {
  return (
    !!left &&
    !!right &&
    left.session === right.session &&
    left.identityKey === right.identityKey &&
    left.connectionKey === right.connectionKey &&
    sameScope(left.scope, right.scope) &&
    left.conversationId === right.conversationId &&
    left.chatGeneration === right.chatGeneration &&
    left.language === right.language
  );
}

export function processCommandNotice(
  command: SessionCommand,
  response: ProcessRuntimeResponse,
  connectionKey: string,
): ProcessCommandNotice | null {
  if (
    command.type !== "process.start" &&
    command.type !== "process.answer" &&
    !(command.type === "service.resolve" && "profile" in command)
  )
    return null;
  const admission = response.admission;
  if (admission.status === "admitted" && !response.process) return null;
  const parsed = ProcessCommandNoticeSchema.parse({
    commandId: command.commandId,
    commandType: command.type,
    commandDigest: processCommandDigest(command),
    connectionKey,
    scope: response.scope,
    conversationId: command.conversationId,
    ...(command.type === "service.resolve"
      ? { approved: command.approved }
      : {}),
    rawCode:
      admission.status === "rejected"
        ? admission.reason
        : response.process?.failure?.code || null,
    result:
      admission.status === "rejected"
        ? { kind: "refused", reason: admission.reason }
        : {
            kind: "process",
            parentRunId: admission.parentRunId,
            runId: admission.runId,
            processId: admission.processId,
            version: admission.version,
            artifactDigest: admission.artifactDigest,
            admissionId: admission.receiptId,
            startCommandId: admission.commandId,
            revision: response.process!.revision,
            status: response.process!.status,
          },
  });
  Object.freeze(parsed.scope);
  Object.freeze(parsed.result);
  return Object.freeze(parsed);
}

export function noticeMatchesCommand(
  notice: ProcessCommandNotice,
  command: SessionCommand,
  connectionKey: string,
  scope: Scope,
) {
  return (
    notice.commandId === command.commandId &&
    notice.commandType === command.type &&
    notice.commandDigest === processCommandDigest(command) &&
    notice.connectionKey === connectionKey &&
    sameScope(notice.scope, scope) &&
    notice.conversationId === command.conversationId &&
    (command.type === "service.resolve"
      ? notice.approved === command.approved
      : notice.approved === undefined)
  );
}

export function processNoticeCopy(
  notice: ProcessCommandNotice,
  unknownReceipt = false,
): SelectedProcessNotice | null {
  if (notice.result.kind === "refused")
    return { kind: "refused", key: notice.result.reason, error: true };
  const status = unknownReceipt ? "unknown" : notice.result.status;
  if (status === "unknown")
    return { kind: "unknown", key: "processResultUnknown", error: false };
  if (status === "cancelled")
    return notice.commandType === "service.resolve" &&
      notice.approved === false &&
      notice.rawCode === "process_action_rejected"
      ? { kind: "declined", key: "processDecisionDeclined", error: false }
      : { kind: "interrupted", key: "requestInterrupted", error: false };
  if (status !== "failed") return null;
  return {
    kind: "failed",
    key: "processResultFailed",
    error: true,
    ...(notice.rawCode && Object.hasOwn(failureDetails, notice.rawCode)
      ? { detailKey: failureDetails[notice.rawCode]! }
      : {}),
  };
}

/** Only the original response or the exact same native generation supplies status. */
export function selectProcessCommandNotice(
  state: Pick<SessionState, "store" | "error" | "processNotice">,
  owner: ProcessNoticeOwner | undefined,
  commandId?: string,
): {
  notice: SelectedProcessNotice | null;
  suppressError: boolean;
  localError?: ProcessNoticeLocalError;
} {
  const view = state.processNotice;
  if (!view) return { notice: null, suppressError: false };
  const { notice } = view;
  if (view.errorSource.kind === "local")
    return {
      notice: null,
      suppressError: false,
      localError: view.errorSource.code,
    };
  const correlated = state.error === notice.rawCode;
  // A new local/transport/auth error must not be hidden by an earlier outcome.
  if (state.error !== null && !correlated)
    return { notice: null, suppressError: false };
  const hidden = { notice: null, suppressError: correlated };
  if (
    !sameProcessNoticeOwner(view.owner, owner) ||
    (commandId !== undefined && commandId !== notice.commandId) ||
    !owner ||
    notice.connectionKey !== owner.connectionKey ||
    !sameScope(notice.scope, owner.scope) ||
    notice.conversationId !== owner.conversationId
  )
    return hidden;
  const store = state.store;
  if (
    !store ||
    store.connectionKey !== notice.connectionKey ||
    !sameScope(store.scope, notice.scope)
  )
    return hidden;
  let unknownReceipt = false;
  if (notice.result.kind === "process") {
    const result = notice.result;
    const work = store.workItems[result.parentRunId];
    const native = work?.native;
    const process = native?.process;
    if (
      work &&
      (!native ||
        !process ||
        work.conversationId !== notice.conversationId ||
        process.provenance.actorId !== notice.scope.userId ||
        process.provenance.conversationId !== notice.conversationId ||
        process.provenance.runId !== result.runId ||
        process.provenance.processId !== result.processId ||
        process.provenance.version !== result.version ||
        process.provenance.artifactDigest !== result.artifactDigest ||
        process.provenance.commandId !== result.startCommandId ||
        process.provenance.admissionId !== result.admissionId ||
        !process.detailsAvailable ||
        native.revision > result.revision)
    )
      return hidden;
    if (!work && !store.stale && notice.commandType !== "process.start")
      return hidden;
    unknownReceipt =
      native?.revision === result.revision &&
      !!process?.receipts.some((receipt) => receipt.status === "unknown");
  }
  return {
    notice: processNoticeCopy(notice, unknownReceipt),
    suppressError: correlated,
  };
}
