import React from "react";
import { View } from "react-native";
import {
  WorkItemSchema,
  InputRequestSchema,
  type WorkItem,
  type InputRequest,
  type Language,
  type ActionProposal,
  type Operation,
} from "../protocol";
import { translate } from "../i18n";
import {
  Surface,
  Text,
  Row,
  Icon,
  Button,
  Notice,
  StatusPill,
  type StatusTone,
} from "../ui";
import { tokens as t } from "../design-tokens";
import { InputRequestForm, type FormState } from "./InputRequestForm";
import { ActionApprovalCard } from "./ActionApprovalCard";
import { ServiceActionCard } from "./ServiceActionCard";
import { CardDocumentView } from "./CardDocumentView";
import { MarkdownText } from "./MarkdownText";
import { QuestionChoices } from "./QuestionChoices";
const workTone: Record<WorkItem["status"], StatusTone> = {
  queued: "unknown",
  running: "running",
  waiting_input: "needsInput",
  waiting_approval: "needsInput",
  waiting_system: "running",
  scheduled: "unknown",
  succeeded: "success",
  failed: "error",
  cancelled: "unknown",
  expired: "unknown",
  superseded: "unknown",
};
export type WorkItemCardProps = {
  work: WorkItem;
  input?: InputRequest;
  language: Language;
  formState?: FormState;
  proposal?: ActionProposal;
  operations?: Operation[];
  approvalState?: FormState;
  source?: string;
  workspace?: string;
  onReconcile?: (operation: Operation) => void;
  onDecision?: (decision: "approve" | "reject", revision: number) => void;
  onRevise?: (
    participantId: string,
    startsAt: string,
    revision: number,
  ) => void;
  stale?: boolean;
  blocked?: boolean;
  compact?: boolean;
  onExpand?: () => void;
  onAnswer: (contactId: string, revision: number) => void;
  onReply?: () => void;
  /** Sends one of the assistant question's offered answers. */
  onAnswerQuestion?: (answer: string) => void;
  onNativeDecision?: (approved: boolean) => void;
  onRetryNative?: () => void;
  retryUnavailable?: boolean;
  onProcessDecision?: (approved: boolean) => void;
  /** Trusted client detail control; never supplied by a server card document. */
  processOutputDetail?: React.ReactNode;
};
export function WorkItemCard({
  work,
  input,
  language,
  formState,
  proposal,
  operations = [],
  approvalState,
  source = "",
  workspace,
  onDecision,
  onRevise,
  onReconcile,
  stale,
  blocked,
  compact = false,
  onExpand,
  onAnswer,
  onReply,
  onAnswerQuestion,
  onNativeDecision,
  onRetryNative,
  retryUnavailable = false,
  onProcessDecision,
  processOutputDetail,
}: WorkItemCardProps) {
  const tr = translate(language);
  // Catalog v1 supports only these validated types and variants, never server styles/code.
  WorkItemSchema.parse(work);
  if (input) InputRequestSchema.parse(input);
  const process = work.native?.process;
  const choices = !!work.native?.question?.options && !!onAnswerQuestion;
  const processQuestion = process?.question;
  const processApproval = process?.approval;
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
    process.status === "waiting" &&
    process.journalStatus === "waiting" &&
    process.detailsAvailable &&
    process.journalRevision !== undefined;
  return (
    <Surface
      testID={`work-${work.id}`}
      style={compact ? { padding: 14, gap: 10 } : undefined}
    >
      {!(compact && (proposal || input?.status === "open")) ? (
        <>
          <Row>
            <View
              style={{
                width: 40,
                height: 40,
                backgroundColor: t.color.fill,
                borderRadius: t.radius.control,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon
                name={
                  work.native?.process
                    ? "bolt"
                    : work.native
                      ? "chat"
                      : "calendar"
                }
                size={20}
                color={t.color.text.primary}
              />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text role={compact ? "label" : "cardTitle"}>{work.title}</Text>
              {!compact && !(work.native?.process && work.card) ? (
                <Text role="caption" tone="secondary">
                  {work.context}
                </Text>
              ) : null}
            </View>
          </Row>
        </>
      ) : null}
      {!(compact && (proposal || input?.status === "open")) ? (
        <Row style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
          <StatusPill
            tone={workTone[work.status]}
            busy={work.status === "running"}
            label={tr(
              proposal?.parameters.calendar && work.status === "succeeded"
                ? "calendarSucceeded"
                : work.native && work.status === "succeeded"
                  ? "nativeSucceeded"
                  : work.native?.process?.status === "unknown"
                    ? "processUnknown"
                    : work.native?.process?.status === "interrupted"
                      ? "processInterrupted"
                      : work.status,
            )}
          />
        </Row>
      ) : null}
      {input && (!proposal || input.status === "open") ? (
        <InputRequestForm
          key={input.id}
          input={input}
          language={language}
          state={formState}
          stale={stale}
          blocked={blocked}
          onAnswer={onAnswer}
          compact={compact}
          onExpand={onExpand}
        />
      ) : null}
      {work.native?.action && onNativeDecision ? (
        <ServiceActionCard
          result={work.native.action}
          language={language}
          embedded
          disabled={
            !!stale ||
            !!blocked ||
            approvalState === "sending" ||
            approvalState === "accepted"
          }
          onDecide={onNativeDecision}
        />
      ) : null}
      {work.native?.question ? (
        <MarkdownText text={work.native.question.question} />
      ) : null}
      {choices && work.native?.question ? (
        <QuestionChoices
          question={work.native.question}
          language={language}
          disabled={!!stale || !!blocked}
          onAnswer={onAnswerQuestion!}
          onOther={onReply}
        />
      ) : null}
      {processApproval ? (
        <>
          {!canDecideProcess ? (
            <Notice>{tr("processApprovalUnavailable")}</Notice>
          ) : null}
          {stale ? <Notice>{tr("processApprovalStale")}</Notice> : null}
          <ServiceActionCard
            result={processApproval.result}
            language={language}
            embedded
            reviewFrame={{
              source,
              workspace,
              nativeRevision: work.native!.revision,
              serviceId: processApproval.serviceId,
              serviceRevision: processApproval.serviceRevision,
              actionId: processApproval.actionId,
              actionRevision: processApproval.actionRevision,
            }}
            disabled={
              !canDecideProcess ||
              !onProcessDecision ||
              !!stale ||
              !!blocked ||
              approvalState === "sending" ||
              approvalState === "accepted"
            }
            onDecide={onProcessDecision ?? (() => {})}
          />
        </>
      ) : process && work.status === "waiting_approval" ? (
        <Notice>{tr("processApprovalUnavailable")}</Notice>
      ) : null}
      {processQuestion && !work.card ? (
        <MarkdownText text={processQuestion.question} />
      ) : null}
      {/* In chat, a waiting meeting approval already shows these facts. */}
      {work.card &&
      (!work.native || work.native.process) &&
      !(compact && proposal?.status === "awaiting_approval") ? (
        <CardDocumentView document={work.card} language={language} embedded />
      ) : null}
      {process?.outputUnavailable ? (
        <Notice>
          {tr(
            process.outputUnavailable === "limit"
              ? "process_output_limit"
              : process.outputUnavailable === "invalid"
                ? "process_output_invalid"
                : "process_output_unavailable",
          )}
        </Notice>
      ) : null}
      {proposal && onDecision && onRevise ? (
        <ActionApprovalCard
          key={proposal.id}
          proposal={proposal}
          operations={operations}
          contacts={input?.options ?? []}
          source={source}
          language={language}
          state={approvalState}
          stale={stale}
          blocked={blocked}
          onDecision={onDecision}
          onRevise={onRevise}
          onReconcile={onReconcile}
          compact={compact}
          onExpand={onExpand}
        />
      ) : null}
      {work.native &&
      (["succeeded", "failed", "cancelled"].includes(work.status) ||
        work.native.process) &&
      !work.native.action &&
      work.result ? (
        !work.native.process || !work.card ? (
          <MarkdownText text={work.result} />
        ) : null
      ) : null}
      {work.demo && work.status === "succeeded" && !proposal ? (
        <Text role="caption" tone="secondary">
          {tr("demoResult")}
        </Text>
      ) : null}
      {canReplyToProcess && stale ? <Notice>{tr("stale")}</Notice> : null}
      {work.native?.sourceCommandId &&
      ["failed", "cancelled"].includes(work.status) &&
      onRetryNative ? (
        <Button
          variant="quiet"
          label={tr("retryFailedTask")}
          onPress={onRetryNative}
          disabled={!!stale || !!blocked}
        />
      ) : null}
      {work.native?.sourceCommandId &&
      ["failed", "cancelled"].includes(work.status) &&
      retryUnavailable ? (
        <Notice>{tr("retrySourceUnavailable")}</Notice>
      ) : null}
      {(canReplyToProcess ||
        input?.status === "open" ||
        work.native?.question) &&
      onReply &&
      !choices ? (
        <Button
          variant="quiet"
          icon="chat"
          label={tr("replyInChat")}
          onPress={onReply}
          disabled={!!process && (!!stale || !!blocked)}
        />
      ) : null}
      {processOutputDetail}
    </Surface>
  );
}
