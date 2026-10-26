import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Calendar,
  Check,
  ChevronRight,
  CircleAlert,
  Clock,
  MessageSquare,
  RefreshCw,
  Reply,
  User,
  Workflow,
  X,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@admin/components/ui/card";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Spinner } from "@admin/components/ui/spinner";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import { Markdown } from "@admin/components/ui/markdown";
import { StatusBadge, type Tone } from "@admin/components/console/status";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { Disclosure } from "@admin/components/console/disclosure";
import {
  answerCommand,
  proposalDecision,
  reconcileOperation,
} from "../../../../packages/client-core/commands";
import {
  captureProcessNoticeOwner,
  selectProcessCommandNotice,
} from "../../../../packages/client-core/process-command-notice";
import {
  captureProcessResolveTarget,
  processResolveCommand,
  type ProcessResolveTarget,
} from "../../../../packages/client-core/process-commands";
import type {
  ClientSession,
  SessionState,
} from "../../../../packages/client-core/session";
import {
  isCancellableWork,
  workCancelError,
} from "../../../../packages/client-core/conversation-directory";
import { en, type TranslationKey } from "../../../../packages/i18n";
import type {
  ActionProposal,
  InputRequest,
  Operation,
  WorkItem,
} from "../../../../packages/protocol";
import type { RequestActivity } from "../../../../packages/protocol/activity";
import type { AnswerStreamStep } from "../../../../packages/protocol/answer-stream";
import { formatRange } from "../../../../packages/ui-catalog/field-format";
import { CardDocumentView, ServiceActionView } from "./chat-cards";
import { loopNodeLabel, loopsCopy, type LoopsCopy } from "../loops-copy";
import { useApp } from "./context";
import { useChatCopy } from "./chat-copy";
import { QuestionChoices } from "./chat-question";

const newId = () => crypto.randomUUID();

const workTone: Record<WorkItem["status"], Tone> = {
  queued: "neutral",
  running: "info",
  waiting_input: "warning",
  waiting_approval: "warning",
  waiting_system: "info",
  scheduled: "neutral",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
  expired: "neutral",
  superseded: "neutral",
};

/**
 * One live task in the chat: its state, the question or approval it waits
 * on, and its result. Every decision carries the revision it was shown at.
 */
export function WorkCard({
  session,
  state,
  work,
  conversationId,
  stale,
  blocked,
  onReply,
  onAnswerQuestion,
  questionShortcuts = false,
}: {
  session: ClientSession;
  state: SessionState;
  work: WorkItem;
  conversationId: string;
  stale: boolean;
  blocked: boolean;
  onReply?: () => void;
  /** Sends one of the offered answers of the run's open question. */
  onAnswerQuestion?: (answer: string) => void;
  /** The newest open question in the chat takes the digit keys. */
  questionShortcuts?: boolean;
}) {
  const { tr, language } = useChatCopy();
  const store = state.store;
  const input: InputRequest | undefined =
    store?.inputRequests[work.inputRequestIds[0] ?? ""];
  const proposal: ActionProposal | undefined =
    store?.actionProposals[work.actionProposalIds[0] ?? ""];
  const operations = work.operationIds.flatMap((id) =>
    store?.operations[id] ? [store.operations[id]] : [],
  );
  const process = work.native?.process;
  const processQuestion = process?.question;
  const processApproval = process?.approval;
  const approvalState = proposal
    ? (state.commandStates[proposal.approval?.operationId ?? ""] ??
      state.commandStates[proposal.id])
    : work.native?.action
      ? state.commandStates[work.native.action.operationId]
      : processApproval
        ? state.commandStates[processApproval.result.operationId]
        : undefined;
  const guard = useRef({ alive: false, sending: false });
  useLayoutEffect(() => {
    const current = guard.current;
    current.alive = true;
    return () => {
      current.alive = false;
    };
  }, []);
  const [decision, setDecision] = useState<{
    target: ProcessResolveTarget;
    phase: "sending" | "accepted" | "rejected" | "unknown";
    error: TranslationKey | null;
  }>();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<TranslationKey | null>(null);

  const isBlocked =
    blocked ||
    !!state.pending ||
    !!state.answerRecoveryBlocked ||
    (!!processApproval && !reviewedTarget());
  const isStale =
    stale ||
    state.status !== "online" ||
    !!store?.stale ||
    !!store?.needsSnapshot;

  function reviewedTarget() {
    if (!store || !processApproval) return undefined;
    try {
      return captureProcessResolveTarget(
        store,
        work.id,
        undefined,
        work.conversationId,
        work,
      );
    } catch {
      // The passive card still renders; a changed review grants no authority.
      return undefined;
    }
  }
  const reviewed = reviewedTarget();
  const sameDecision =
    reviewed &&
    decision &&
    JSON.stringify(reviewed) === JSON.stringify(decision.target)
      ? decision
      : undefined;
  const effectiveApprovalState =
    sameDecision?.phase === "sending" || sameDecision?.phase === "accepted"
      ? sameDecision.phase
      : approvalState;

  const decideProcess = (approved: boolean) => {
    const owned = guard.current;
    if (!owned.alive || owned.sending || !reviewed) return;
    const current = session.getSnapshot();
    if (
      current.status !== "online" ||
      !current.store ||
      current.pending ||
      current.answerRecoveryBlocked ||
      current.commandStates[reviewed.receipt.operationId] === "sending" ||
      current.commandStates[reviewed.receipt.operationId] === "accepted"
    )
      return;
    let command;
    try {
      const id = newId();
      command = processResolveCommand(current.store, reviewed, {
        commandId: id,
        idempotencyKey: id,
        approved,
        language,
      });
    } catch {
      setDecision({
        target: reviewed,
        phase: "rejected",
        error: "process_approval_changed",
      });
      return;
    }
    owned.sending = true;
    setDecision({ target: reviewed, phase: "sending", error: null });
    const noticeOwner = captureProcessNoticeOwner(session, {
      conversationId,
      chatGeneration: 0,
      language,
    });
    void session.send(command, false, reviewed, noticeOwner).then(
      () => {
        if (!owned.alive) return;
        const settled = session.getSnapshot();
        const phase = settled.commandStates[command.operationId];
        const selected = selectProcessCommandNotice(
          settled,
          noticeOwner,
          command.commandId,
        );
        const error =
          selected.notice?.key ??
          (settled.processNotice?.notice.commandId === command.commandId &&
          !selected.suppressError &&
          settled.error &&
          settled.error in en
            ? (settled.error as TranslationKey)
            : null);
        setDecision({
          target: reviewed,
          phase:
            phase === "accepted" || phase === "rejected" ? phase : "unknown",
          error: phase === "accepted" ? null : error,
        });
        owned.sending = false;
      },
      () => {
        if (!owned.alive) return;
        owned.sending = false;
        setDecision({
          target: reviewed,
          phase: "rejected",
          error: "process_approval_changed",
        });
      },
    );
  };

  const retryAvailable =
    session.canRetryNativeWork(work, conversationId) &&
    !blocked &&
    !state.pending &&
    !state.answerRecoveryBlocked;
  const retryUnavailable =
    !!work.native?.sourceCommandId &&
    ["failed", "cancelled"].includes(work.status) &&
    !session.getRetrySource(work.native.sourceCommandId);
  const retryFailed = () => {
    const owned = guard.current;
    if (
      !owned.alive ||
      owned.sending ||
      !retryAvailable ||
      !session.canRetryNativeWork(work, conversationId)
    )
      return;
    owned.sending = true;
    setRetrying(true);
    setRetryError(false);
    void session
      .retryNativeWork(work, conversationId, {
        commandId: newId(),
        idempotencyKey: newId(),
      })
      .catch(() => {
        if (owned.alive) setRetryError(true);
      })
      .finally(() => {
        owned.sending = false;
        if (owned.alive) setRetrying(false);
      });
  };

  const cancelWork = () => {
    const owned = guard.current;
    if (!owned.alive || owned.sending) return;
    owned.sending = true;
    setCancelling(true);
    setCancelError(null);
    void session
      .cancelWork(work, language, newId())
      .catch((error: unknown) => {
        if (owned.alive) setCancelError(workCancelError(error));
      })
      .finally(() => {
        owned.sending = false;
        if (owned.alive) setCancelling(false);
      });
  };

  const decideNative = (approved: boolean) => {
    if (!work.native?.action || work.native.process) return;
    const id = newId();
    void session.send({
      type: "service.resolve",
      commandId: id,
      idempotencyKey: id,
      conversationId: work.conversationId,
      operationId: work.native.action.operationId,
      workItemId: work.id,
      expectedWorkRevision: work.revision,
      approved,
      language,
    });
  };

  const waitingReceipts = process?.receipts.filter(
    (receipt) => receipt.status === "awaiting_approval",
  );
  const approvalReceipt = waitingReceipts?.[0];
  const canDecideProcess =
    !!processApproval &&
    work.status === "waiting_approval" &&
    process?.status === "waiting" &&
    process.journalStatus === "waiting" &&
    process.detailsAvailable &&
    !processQuestion &&
    !process.approvalUnavailable &&
    waitingReceipts?.length === 1 &&
    approvalReceipt?.operationId === processApproval.result.operationId &&
    approvalReceipt.title === processApproval.result.title &&
    approvalReceipt.service === processApproval.result.service &&
    approvalReceipt.effect === processApproval.result.effect &&
    processApproval.result.status === "awaiting_approval";
  const canReplyToProcess =
    !!processQuestion &&
    work.status === "waiting_input" &&
    process?.status === "waiting" &&
    process.journalStatus === "waiting" &&
    process.detailsAvailable &&
    process.journalRevision !== undefined;
  // An in-flight turn of this chat also projects as waiting: it answers now.
  // An approval card declines with its own button (the same "Cancel").
  const showCancel =
    isCancellableWork(work) &&
    state.pending?.conversationId !== work.conversationId &&
    !(
      work.status === "waiting_approval" &&
      ((!!work.native?.action && !process) || canDecideProcess)
    );
  const focused = !!proposal || input?.status === "open";
  const statusLabel = tr(
    proposal?.parameters.calendar && work.status === "succeeded"
      ? "calendarSucceeded"
      : work.native && work.status === "succeeded"
        ? "nativeSucceeded"
        : process?.status === "unknown"
          ? "processUnknown"
          : process?.status === "interrupted"
            ? "processInterrupted"
            : (work.status as TranslationKey),
  );
  const notices: TranslationKey[] = [
    ...(processApproval && !canDecideProcess
      ? (["processApprovalUnavailable"] as const)
      : []),
    ...(processApproval && isStale ? (["processApprovalStale"] as const) : []),
    ...(!processApproval && process && work.status === "waiting_approval"
      ? (["processApprovalUnavailable"] as const)
      : []),
    ...(process?.outputUnavailable
      ? ([
          process.outputUnavailable === "limit"
            ? "process_output_limit"
            : process.outputUnavailable === "invalid"
              ? "process_output_invalid"
              : "process_output_unavailable",
        ] as const)
      : []),
    ...(canReplyToProcess && isStale ? (["stale"] as const) : []),
    ...(retrying ? (["retryingTask"] as const) : []),
    ...(retryError ? (["retryTaskFailed"] as const) : []),
    ...(work.native?.sourceCommandId &&
    ["failed", "cancelled"].includes(work.status) &&
    retryUnavailable
      ? (["retrySourceUnavailable"] as const)
      : []),
    ...(sameDecision?.error ? [sameDecision.error] : []),
    ...(cancelError && showCancel ? [cancelError] : []),
  ];
  const showResult =
    !!work.native &&
    (["succeeded", "failed", "cancelled"].includes(work.status) ||
      !!work.native.process) &&
    !work.native.action &&
    !!work.result &&
    (!work.native.process || !work.card);
  const showRetry =
    !!work.native?.sourceCommandId &&
    ["failed", "cancelled"].includes(work.status) &&
    retryAvailable;
  // Offered answers carry their own "Other" that opens the composer.
  const choices = !!work.native?.question?.options && !!onAnswerQuestion;
  const showReply =
    (canReplyToProcess ||
      input?.status === "open" ||
      !!work.native?.question) &&
    !!onReply &&
    !choices;
  return (
    <Card size="sm" data-testid={`work-${work.id}`}>
      {!focused && (
        <CardHeader>
          <div className="flex min-w-0 items-center gap-3">
            <EntityIcon size="md">
              {process ? (
                <Workflow aria-hidden="true" />
              ) : work.native ? (
                <MessageSquare aria-hidden="true" />
              ) : (
                <Calendar aria-hidden="true" />
              )}
            </EntityIcon>
            <span className="min-w-0 flex-1 truncate font-medium">
              {work.title}
            </span>
            <StatusBadge tone={workTone[work.status]}>
              {statusLabel}
            </StatusBadge>
          </div>
        </CardHeader>
      )}
      <CardContent>
        <div className="flex min-w-0 flex-col gap-3">
          {input && (!proposal || input.status === "open") && (
            <ContactChoice
              input={input}
              state={input ? state.commandStates[input.id] : undefined}
              stale={isStale}
              blocked={isBlocked}
              onAnswer={(contact, revision) =>
                void session.send(
                  answerCommand({ ...input, revision }, contact, newId()),
                )
              }
            />
          )}
          {work.native?.action && (
            <ServiceActionView
              result={work.native.action}
              embedded
              disabled={
                isStale ||
                isBlocked ||
                effectiveApprovalState === "sending" ||
                effectiveApprovalState === "accepted"
              }
              onDecide={decideNative}
            />
          )}
          {work.native?.question && (
            <Markdown text={work.native.question.question} />
          )}
          {choices && work.native?.question && (
            <QuestionChoices
              question={work.native.question}
              disabled={isStale || isBlocked}
              shortcuts={questionShortcuts && !isStale && !isBlocked}
              onAnswer={onAnswerQuestion!}
              onOther={onReply}
            />
          )}
          {processApproval && store && (
            <ServiceActionView
              result={processApproval.result}
              embedded
              reviewFrame={{
                source: store.connectionKey,
                workspace: store.scope.workspaceId,
                nativeRevision: work.native!.revision,
                serviceId: processApproval.serviceId,
                serviceRevision: processApproval.serviceRevision,
                actionId: processApproval.actionId,
                actionRevision: processApproval.actionRevision,
              }}
              disabled={
                !canDecideProcess ||
                isStale ||
                isBlocked ||
                effectiveApprovalState === "sending" ||
                effectiveApprovalState === "accepted"
              }
              onDecide={decideProcess}
            />
          )}
          {processQuestion && !work.card && (
            <Markdown text={processQuestion.question} />
          )}
          {work.card &&
            (!work.native || work.native.process) &&
            proposal?.status !== "awaiting_approval" && (
              <CardDocumentView document={work.card} />
            )}
          {proposal && (
            <ProposalReview
              key={proposal.id}
              proposal={proposal}
              operations={operations}
              state={effectiveApprovalState}
              stale={isStale}
              blocked={isBlocked}
              onDecision={(choice, revision) =>
                void session.send(
                  proposalDecision({ ...proposal, revision }, choice, newId()),
                )
              }
              onReconcile={(operation) =>
                void session.send(reconcileOperation(operation, newId()))
              }
            />
          )}
          {showResult && <Markdown text={work.result!} />}
          {work.demo && work.status === "succeeded" && !proposal && (
            <p className="text-xs text-muted-foreground">{tr("demoResult")}</p>
          )}
          {notices.map((key) => (
            <Alert key={key}>
              <AlertDescription>{tr(key)}</AlertDescription>
            </Alert>
          ))}
        </div>
      </CardContent>
      {(showRetry || showReply || showCancel) && (
        <CardFooter>
          <div className="flex flex-wrap gap-2">
            {showReply && (
              <Button
                variant="outline"
                disabled={!!process && (isStale || isBlocked)}
                onClick={onReply}
              >
                <Reply data-icon="inline-start" aria-hidden="true" />
                {tr("replyInChat")}
              </Button>
            )}
            {showRetry && (
              <Button
                variant="ghost"
                disabled={isStale || isBlocked}
                onClick={retryFailed}
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {tr("retryFailedTask")}
              </Button>
            )}
            {showCancel && (
              <Button
                variant="ghost"
                disabled={isStale || cancelling}
                onClick={cancelWork}
              >
                {cancelling ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <X data-icon="inline-start" aria-hidden="true" />
                )}
                {tr("cancelWork")}
              </Button>
            )}
          </div>
        </CardFooter>
      )}
    </Card>
  );
}

/** A contact the assistant needs; choosing one answers at the shown revision. */
function ContactChoice({
  input,
  state = "idle",
  stale,
  blocked,
  onAnswer,
}: {
  input: InputRequest;
  state?: string;
  stale: boolean;
  blocked: boolean;
  onAnswer: (contactId: string, revision: number) => void;
}) {
  const { copy, tr } = useChatCopy();
  const [shownRevision, setShownRevision] = useState(input.revision);
  const [showAll, setShowAll] = useState(false);
  const changed = shownRevision !== input.revision;
  if (input.status !== "open")
    return (
      <p className="text-muted-foreground">
        {tr(
          input.status === "resolved" ? "questionResolved" : "questionClosed",
        )}
        {input.resolution
          ? ` · ${input.options.find((o) => o.id === input.resolution?.selectedContactId)?.label ?? ""}`
          : ""}
      </p>
    );
  const disabled =
    stale ||
    blocked ||
    state === "sending" ||
    state === "accepted" ||
    state === "network_error" ||
    changed;
  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium">{input.question}</p>
      {changed && (
        <Alert>
          <AlertDescription>{tr("questionUpdated")}</AlertDescription>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 justify-self-start"
            onClick={() => setShownRevision(input.revision)}
          >
            {tr("refresh")}
          </Button>
        </Alert>
      )}
      <div
        role="group"
        aria-label={tr("selectContact")}
        className="flex flex-col gap-1.5"
      >
        {(showAll ? input.options : input.options.slice(0, 3)).map((option) => (
          <Item key={option.id} variant="outline" size="sm" asChild>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onAnswer(option.id, shownRevision)}
            >
              <ItemMedia variant="icon">
                <User aria-hidden="true" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{option.label}</ItemTitle>
                <ItemDescription>{option.detail}</ItemDescription>
              </ItemContent>
            </button>
          </Item>
        ))}
      </div>
      {input.options.length > 3 && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? copy.showLess : copy.showAll}
        </Button>
      )}
      {(state === "conflict" ||
        state === "rejected" ||
        state === "network_error") && (
        <p role="alert" className="text-xs text-destructive">
          {tr(state as TranslationKey)}
        </p>
      )}
      {stale && <p className="text-xs text-muted-foreground">{tr("stale")}</p>}
    </div>
  );
}

/** A meeting to approve or reject at the reviewed revision. */
function ProposalReview({
  proposal,
  operations,
  state = "idle",
  stale,
  blocked,
  onDecision,
  onReconcile,
}: {
  proposal: ActionProposal;
  operations: Operation[];
  state?: string;
  stale: boolean;
  blocked: boolean;
  onDecision: (decision: "approve" | "reject", revision: number) => void;
  onReconcile: (operation: Operation) => void;
}) {
  const { copy, tr, language } = useChatCopy();
  const [reviewedRevision, setReviewedRevision] = useState(proposal.revision);
  const waiting = proposal.status === "awaiting_approval";
  const changed = waiting && reviewedRevision !== proposal.revision;
  const current = operations.find(
    (operation) => operation.id === proposal.approval?.operationId,
  );
  const canRevise =
    waiting ||
    (proposal.status === "approved" && current?.status === "pending");
  const disabled =
    stale ||
    blocked ||
    state === "sending" ||
    state === "network_error" ||
    changed;
  const parameters = proposal.parameters;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-2 font-medium">
          <Calendar
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          {parameters.title}
        </span>
        <span className="flex items-center gap-2">
          <User
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          {parameters.participant.label}
          <span className="truncate text-muted-foreground">
            {parameters.participant.email}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <Clock
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          {formatRange(parameters.startsAt, parameters.endsAt, language) ??
            parameters.startsAt}
        </span>
      </div>
      {waiting && (
        <p className="text-xs text-muted-foreground">
          {tr(
            parameters.calendar ? "calendarEffectShort" : "approvalEffectShort",
          )}
        </p>
      )}
      {changed && canRevise && (
        <Alert>
          <AlertDescription>{tr("proposalChanged")}</AlertDescription>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 justify-self-start"
            disabled={
              stale ||
              blocked ||
              state === "sending" ||
              state === "network_error"
            }
            onClick={() => setReviewedRevision(proposal.revision)}
          >
            {tr("reviewCurrentProposal")}
          </Button>
        </Alert>
      )}
      {(state === "conflict" ||
        state === "rejected" ||
        state === "network_error") && (
        <p role="alert" className="text-xs text-destructive">
          {tr(
            state === "conflict"
              ? "proposalConflict"
              : (state as TranslationKey),
          )}
        </p>
      )}
      {proposal.status === "rejected" && (
        <p className="text-muted-foreground">{tr("proposalRejected")}</p>
      )}
      {canRevise && (
        <div className="flex flex-wrap gap-2">
          {waiting && (
            <Button
              disabled={disabled}
              onClick={() => onDecision("approve", reviewedRevision)}
            >
              {state === "sending" && <Spinner data-icon="inline-start" />}
              {tr(
                parameters.calendar
                  ? "approveCalendarShort"
                  : "approveDemoShort",
              )}
            </Button>
          )}
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => onDecision("reject", proposal.revision)}
          >
            {tr("rejectProposalShort")}
          </Button>
        </div>
      )}
      {current && (
        <div className="flex flex-col gap-2">
          <span className="font-medium">
            {tr(
              (current.parameters.calendar && current.status === "executing"
                ? "calendarExecuting"
                : current.parameters.calendar && current.status === "succeeded"
                  ? "calendarSucceeded"
                  : `operation_${current.status}`) as TranslationKey,
            )}
          </span>
          {current.error && (
            <p role="alert" className="text-xs text-destructive">
              {tr(`calendar_error_${current.error}` as TranslationKey)}
            </p>
          )}
          {current.parameters.calendar &&
            current.status === "result_unknown" && (
              <Button
                variant="outline"
                className="self-start"
                disabled={disabled}
                onClick={() => onReconcile(current)}
              >
                {tr("reconcileCalendar")}
              </Button>
            )}
          {current.status === "result_unknown" && (
            <p className="text-xs text-muted-foreground">
              {tr("operationUnknownHint")}
            </p>
          )}
        </div>
      )}
      <Disclosure title={copy.details}>
        <p className="text-xs text-muted-foreground">
          {tr("revision")} {proposal.revision}
          {current?.result?.kind === "calendar"
            ? ` · ${current.result.reference}`
            : ""}
        </p>
      </Disclosure>
    </div>
  );
}

type StepStatus =
  | "running"
  | "pending"
  | "succeeded"
  | "failed"
  | "unknown"
  | "needs_input";
const stepLabels = {
  understanding: "progressUnderstanding",
  crm: "progressCrm",
  preparing: "progressPreparing",
  datetime: "progressDatetime",
} as const;
const workflowLabels = {
  service: "progressService",
  action: "progressAction",
  inputs: "progressInputs",
  execute: "progressExecute",
} as const;
const statusLabels = {
  running: "progressRunning",
  pending: "progressPending",
  succeeded: "progressDone",
  failed: "progressStopped",
  unknown: "progressUnconfirmed",
  needs_input: "progressNeedsInput",
} as const;
/**
 * Steps the person is not shown: the assistant's own bookkeeping (finding a
 * service, loading actions, resolving a date, memory, skills). What remains is
 * what touches the person's services and the web.
 */
const INTERNAL_STEPS = new Set([
  "find_service",
  "find_actions",
  "use_actions",
  "internal_datetime_resolve",
  "ask_user",
  "compose_card",
  "memory_search",
  "memory_remember",
  "memory_revise",
  "memory_forget",
  "verified_prior_read",
  "skill_load",
  "skill_propose",
  "process_propose",
  "process_offer",
  "human_task_create",
  "human_task_close",
  "hub_list",
  "hub_add",
  "hub_add_widget",
  "hub_set_widget",
  "hub_set_view",
  "hub_refresh",
  "hub_remove",
]);
export const isInternalStep = (step: Pick<AnswerStreamStep, "label">) =>
  INTERNAL_STEPS.has(step.label) || /^hub_/.test(step.label);
/** "search_companies" reads as "Search companies"; a title stays as it is. */
const humanize = (label: string) =>
  /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(label)
    ? label.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
    : label;
const stepField = (list: AnswerStreamStep["input"], labels: string[]) =>
  list.find((entry) => labels.includes(entry.label));
/** A step's label as shown: the Runs name, else a readable tool name. */
export const humanizeLabel = (label: string, copy?: LoopsCopy) =>
  humanize(copy ? loopNodeLabel({ kind: "tool", label }, copy) : label);
/** The service a step touches, when the step says so. */
export function liveStepService(step: AnswerStreamStep) {
  return (
    stepField(step.input, ["Service"]) ?? stepField(step.output, ["Service"])
  )?.value;
}
/** One streamed step as a line: "Twenty CRM · Search companies · 71 records". */
export function liveStepText(
  step: AnswerStreamStep,
  copy?: LoopsCopy,
  tr?: (key: TranslationKey) => string,
) {
  const label = copy
    ? loopNodeLabel({ kind: "tool", label: step.label }, copy)
    : step.label;
  const service = liveStepService(step);
  // The count of the outermost list: "Returned items" or "data · companies · Returned items".
  const items = step.output
    .filter(
      (entry) =>
        entry.label === "Returned items" ||
        entry.label.endsWith(" · Returned items"),
    )
    .sort((a, b) => a.label.length - b.label.length)[0];
  const message = stepField(step.output, ["Message"]);
  const count = items
    ? tr
      ? tr(
          Number(items.value) === 1
            ? "stepRecord"
            : Number(items.value) >= 2 && Number(items.value) <= 4
              ? "stepRecordsFew"
              : "stepRecords",
        ).replace("{n}", items.value)
      : `${items.value} records`
    : message
      ? message.value.replace(/…$/, "")
      : undefined;
  const failed =
    step.status === "failed" ? (tr ? tr("stepFailed") : "failed") : undefined;
  return [
    service && service !== step.label ? service : undefined,
    humanize(label === step.label ? label : label),
    count,
    failed,
  ]
    .filter(Boolean)
    .join(" · ");
}
/**
 * The steps as the person sees them: internal ones left out, a step repeated
 * right after itself counted once ("× 2"), the latest status of the group.
 */
export function summarizeLiveSteps(steps: readonly AnswerStreamStep[]) {
  const groups: { key: string; step: AnswerStreamStep; count: number }[] = [];
  for (const step of steps) {
    if (isInternalStep(step)) continue;
    const last = groups.at(-1);
    if (last && last.step.label === step.label) {
      last.count += 1;
      last.step = step;
    } else groups.push({ key: step.toolCallId, step, count: 1 });
  }
  return groups;
}
/** Seconds since the progress appeared, from five seconds on. */
export function useElapsedSeconds(active: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.round((Date.now() - started) / 1000)),
      1000,
    );
    return () => {
      clearInterval(timer);
      setSeconds(0);
    };
  }, [active]);
  return active && seconds >= 5 ? seconds : null;
}
/**
 * What the assistant is doing right now, as one "Thinking" line like an AI
 * chat; the server's bounded stages open beneath it on request. Uncertain
 * delivery offers a safe resend of the same command.
 */
export function ProgressView({
  activity,
  steps,
  connection,
  interrupted,
  failed,
  onRetry,
  retryDisabled,
  onToggle,
  hint,
}: {
  activity: RequestActivity | null;
  /** The tool steps streamed so far: which service is read and what came back. */
  steps?: AnswerStreamStep[];
  connection: "waiting" | "live" | "unavailable";
  interrupted: boolean;
  failed: boolean;
  /** Why the request stopped, in one line; replaces the generic hint. */
  hint?: string;
  onRetry?: () => void;
  retryDisabled: boolean;
  /** Called before the steps open or close, so the transcript stays put. */
  onToggle?: () => void;
}) {
  const loops = loopsCopy[useApp().language];
  const { copy, tr } = useChatCopy();
  const [open, setOpen] = useState(false);
  const unknown = interrupted || connection === "unavailable";
  const stopped = unknown || failed || activity?.status === "failed";
  const shownSteps = summarizeLiveSteps(steps ?? []);
  const reading = shownSteps.find((group) => group.step.status === "running");
  const elapsed = useElapsedSeconds(!stopped);
  // "Thinking" becomes "Reading Twenty CRM" while a service answers and
  // "Writing" once the reply is on its way.
  const phase =
    failed || activity?.status === "failed"
      ? tr("progressFailed")
      : unknown
        ? tr("progressUnknown")
        : reading
          ? tr("progressReading").replace(
              "{service}",
              liveStepService(reading.step) ??
                humanizeLabel(reading.step.label, loops),
            )
          : activity?.draft
            ? tr("progressWriting")
            : tr("progressThinking");
  const rows =
    activity?.steps.flatMap((step) => [
      { ...step, calls: 1 },
      ...(step.id === "understanding" ? (activity.tools ?? []) : []),
    ]) ?? [];
  return (
    <div
      data-testid="request-progress"
      role="status"
      aria-live="polite"
      className="flex flex-col gap-1.5 text-sm"
    >
      <button
        type="button"
        aria-expanded={open}
        disabled={!rows.length}
        onClick={() => {
          onToggle?.();
          setOpen((value) => !value);
        }}
        className="group flex items-center gap-1.5 self-start rounded-sm text-muted-foreground outline-offset-4 hover:text-foreground focus-visible:outline-2 disabled:cursor-default"
      >
        {stopped && <CircleAlert aria-hidden="true" className="size-4" />}
        <span data-thinking={stopped ? undefined : ""}>{phase}</span>
        {elapsed !== null && (
          <span className="text-xs tabular-nums">· {elapsed} s</span>
        )}
        {rows.length > 0 && (
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 transition-transform group-aria-expanded:rotate-90"
          />
        )}
      </button>
      {rows.length > 0 && (
        <ul
          hidden={!open}
          className="flex flex-col gap-1 border-l pl-3 text-xs text-muted-foreground"
        >
          {rows.map((step) => {
            const status: StepStatus =
              unknown && step.status === "running" ? "unknown" : step.status;
            const workflow =
              step.id === "understanding" ? activity?.workflow : undefined;
            const label = workflow
              ? tr(workflowLabels[workflow.stage])
              : `${tr(stepLabels[step.id])}${step.calls > 1 ? ` · ${step.calls}×` : ""}`;
            return (
              <li
                key={step.id}
                data-testid={`progress-step-${step.id}-${status}`}
                data-status={status}
                className="data-[status=pending]:opacity-50 data-[status=running]:text-foreground"
              >
                {label}
                {status === "failed" ||
                status === "needs_input" ||
                status === "unknown" ? (
                  <span> · {tr(statusLabels[status])}</span>
                ) : (
                  <span className="sr-only">{tr(statusLabels[status])}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {shownSteps.length > 0 && (
        <ul
          aria-live="off"
          data-testid="progress-live-steps"
          className="flex flex-col gap-1 text-xs text-muted-foreground"
        >
          {shownSteps.map(({ key, step, count }) => (
            <li
              key={key}
              data-status={step.status}
              className="flex items-center gap-1.5 data-[status=running]:text-foreground"
            >
              {step.status === "running" ? (
                <Spinner data-icon="inline-start" />
              ) : step.status === "failed" || step.status === "cancelled" ? (
                <CircleAlert aria-hidden="true" className="size-3" />
              ) : (
                <Check aria-hidden="true" className="size-3" />
              )}
              <span>
                {liveStepText(step, loops, tr)}
                {count > 1 ? ` × ${count}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {(unknown || hint) && (
        <p className="text-xs text-muted-foreground">
          {hint ?? tr(failed ? "progressFailedHint" : "progressUnavailable")}
        </p>
      )}
      {onRetry && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={retryDisabled}
          onClick={onRetry}
        >
          <RefreshCw data-icon="inline-start" aria-hidden="true" />
          {copy.retry}
        </Button>
      )}
    </div>
  );
}

/** A process answer whose delivery is uncertain or was refused. */
export function AnswerRecoveryView({
  question,
  answer,
  outcome,
  explanation,
  canReview,
  canRetry,
  canDiscard,
  onReview,
  onRetry,
  onDiscard,
}: {
  question: string;
  answer: string;
  outcome: "unknown" | "accepted" | "rejected";
  explanation?: string;
  canReview: boolean;
  canRetry: boolean;
  canDiscard: boolean;
  onReview: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const { copy, tr } = useChatCopy();
  return (
    <Card size="sm" data-testid="saved-process-answer">
      <CardContent>
        <div className="flex flex-col gap-2">
          <span className="font-medium">{tr("savedProcessAnswer")}</span>
          <span className="line-clamp-2 text-xs text-muted-foreground">
            {question}
          </span>
          <p className="break-words whitespace-pre-wrap">{answer}</p>
          <p
            data-error={outcome === "rejected" || !!explanation}
            className="text-xs text-muted-foreground data-[error=true]:text-destructive"
          >
            {tr(
              outcome === "unknown"
                ? "savedProcessAnswerUnknown"
                : outcome === "rejected"
                  ? "savedProcessAnswerRejected"
                  : "savedProcessAnswerAccepted",
            )}
            {explanation ? ` ${explanation}` : ""}
          </p>
        </div>
      </CardContent>
      <CardFooter>
        <div className="flex flex-wrap gap-2">
          {outcome === "unknown" ? (
            <Button size="sm" disabled={!canRetry} onClick={onRetry}>
              {copy.retry}
            </Button>
          ) : (
            <>
              <Button size="sm" disabled={!canReview} onClick={onReview}>
                {copy.review}
              </Button>
              {canRetry && (
                <Button size="sm" variant="outline" onClick={onRetry}>
                  {tr("savedProcessAnswerSave")}
                </Button>
              )}
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={outcome === "unknown" || !canDiscard}
            onClick={onDiscard}
          >
            {copy.discard}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
