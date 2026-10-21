import React, { useState } from "react";
import {
  ActionProposalSchema,
  type ActionProposal,
  type InputRequest,
  type Language,
  type Operation,
} from "../protocol";
import { translate } from "../i18n";
import { Button, Text, Stack, Row, Notice, DetailRow, Disclosure } from "../ui";
import { DateTimeFields } from "../ui/DateTimeFields";
import { localDateTime, localDateTimeToIso } from "../ui/local-date-time";
import type { FormState } from "./InputRequestForm";
import { MeetingFacts } from "./MeetingFacts";
export type ActionApprovalProps = {
  proposal: ActionProposal;
  operations: Operation[];
  contacts: InputRequest["options"];
  source: string;
  language: Language;
  state?: FormState;
  stale?: boolean;
  blocked?: boolean;
  compact?: boolean;
  timeZone?: string;
  onExpand?: () => void;
  onReconcile?: (operation: Operation) => void;
  onDecision(decision: "approve" | "reject", revision: number): void;
  onRevise(participantId: string, startsAt: string, revision: number): void;
};
export function ActionApprovalCard({
  proposal,
  operations,
  contacts,
  source,
  language,
  state = "idle",
  stale = false,
  blocked = false,
  compact = false,
  timeZone,
  onExpand,
  onDecision,
  onRevise,
  onReconcile,
}: ActionApprovalProps) {
  ActionProposalSchema.parse(proposal);
  const tr = translate(language);
  const [reviewedRevision, setReviewedRevision] = useState(proposal.revision);
  const [editing, setEditing] = useState(false);
  const [participant, setParticipant] = useState(
    proposal.parameters.participant.id,
  );
  const [date, setDate] = useState(
    () => localDateTime(proposal.parameters.startsAt).date,
  );
  const [time, setTime] = useState(
    () => localDateTime(proposal.parameters.startsAt).time,
  );
  const [invalid, setInvalid] = useState(false);
  const changed =
    proposal.status === "awaiting_approval" &&
    reviewedRevision !== proposal.revision;
  const waiting = proposal.status === "awaiting_approval";
  const currentOperation = operations.find(
    (o) => o.id === proposal.approval?.operationId,
  );
  const canRevise =
    waiting ||
    (proposal.status === "approved" && currentOperation?.status === "pending");
  const disabled =
    stale ||
    blocked ||
    state === "sending" ||
    state === "network_error" ||
    changed;
  const format = (iso: string) =>
    new Intl.DateTimeFormat(language, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(iso));
  return (
    <Stack>
      {compact ? (
        <MeetingFacts
          parameters={proposal.parameters}
          language={language}
          timeZone={timeZone}
        />
      ) : (
        <>
          <Text role="cardTitle">
            {tr(waiting ? "reviewMeeting" : "meetingDetails")}
          </Text>
          <Text role="label">{proposal.parameters.title}</Text>
          <Stack style={{ gap: 16 }}>
            <DetailRow icon="person" label={tr("meetingParticipant")}>
              <Text>{proposal.parameters.participant.label}</Text>
              <Text role="caption" tone="secondary">
                {proposal.parameters.participant.email}
              </Text>
            </DetailRow>
            <DetailRow
              icon="clock"
              label={`${tr("meetingStart")} → ${tr("meetingEnd")} · UTC`}
            >
              <Text>{format(proposal.parameters.startsAt)}</Text>
              <Text role="caption" tone="secondary">
                {tr("meetingEnd")}: {format(proposal.parameters.endsAt)}
              </Text>
            </DetailRow>
            {proposal.parameters.calendar ? (
              <DetailRow icon="calendar" label={tr("calendarTarget")}>
                <Text>{proposal.parameters.calendar.label}</Text>
                <Text role="caption" tone="secondary">
                  {proposal.parameters.calendar.collectionUrl}
                </Text>
              </DetailRow>
            ) : null}
          </Stack>
        </>
      )}
      {waiting ? (
        compact ? (
          <Text role="caption" tone="secondary">
            {tr(
              proposal.parameters.calendar
                ? "calendarEffectShort"
                : "approvalEffectShort",
            )}
          </Text>
        ) : (
          <Notice>
            {tr(
              proposal.parameters.calendar
                ? "calendarEffect"
                : "approvalEffect",
            )}
          </Notice>
        )
      ) : null}
      {changed && canRevise ? (
        <>
          <Notice>{tr("proposalChanged")}</Notice>
          <Button
            variant="secondary"
            label={tr("reviewCurrentProposal")}
            disabled={
              stale ||
              blocked ||
              state === "sending" ||
              state === "network_error"
            }
            onPress={() => {
              setReviewedRevision(proposal.revision);
              setEditing(false);
              setInvalid(false);
            }}
          />
        </>
      ) : null}
      {stale ? <Notice>{tr("stale")}</Notice> : null}
      {state === "conflict" ||
      state === "rejected" ||
      state === "network_error" ? (
        <Notice error>
          {tr(state === "conflict" ? "proposalConflict" : state)}
        </Notice>
      ) : null}
      {proposal.status === "rejected" ? (
        <Notice>{tr("proposalRejected")}</Notice>
      ) : null}
      {editing && canRevise ? (
        <Stack>
          <Text role="label">{tr("meetingParticipant")}</Text>
          {contacts.map((c) => (
            <Button
              key={c.id}
              label={c.label}
              variant={participant === c.id ? "primary" : "secondary"}
              disabled={disabled}
              onPress={() => setParticipant(c.id)}
            />
          ))}
          <DateTimeFields
            date={date}
            time={time}
            initialValue={proposal.parameters.startsAt}
            dateLabel={tr("meetingDate")}
            timeLabel={`${tr("meetingTime")} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}
            language={language}
            disabled={disabled}
            onDateChange={setDate}
            onTimeChange={setTime}
          />
          {invalid ? <Notice error>{tr("invalid_proposal")}</Notice> : null}
          <Button
            label={tr("saveProposal")}
            disabled={disabled}
            onPress={() => {
              const iso = localDateTimeToIso(
                date,
                time,
                proposal.parameters.startsAt,
              );
              if (!iso) {
                setInvalid(true);
                return;
              }
              setInvalid(false);
              onRevise(participant, iso, reviewedRevision);
            }}
          />
          <Button
            variant="quiet"
            label={tr("cancel")}
            disabled={state === "sending"}
            onPress={() => setEditing(false)}
          />
        </Stack>
      ) : (
        <>
          {waiting ? (
            <Button
              label={tr(
                compact
                  ? proposal.parameters.calendar
                    ? "approveCalendarShort"
                    : "approveDemoShort"
                  : proposal.parameters.calendar
                    ? "approveCalendarMeeting"
                    : "approveMeeting",
              )}
              disabled={disabled}
              loading={state === "sending"}
              onPress={() => onDecision("approve", reviewedRevision)}
            />
          ) : null}
          {canRevise ? (
            <Row style={{ alignItems: "stretch" }}>
              <Button
                style={{ flex: 1 }}
                variant="secondary"
                label={tr(compact ? "editProposalShort" : "editProposal")}
                disabled={disabled}
                onPress={() => {
                  onExpand?.();
                  setReviewedRevision(proposal.revision);
                  setParticipant(proposal.parameters.participant.id);
                  setDate(localDateTime(proposal.parameters.startsAt).date);
                  setTime(localDateTime(proposal.parameters.startsAt).time);
                  setEditing(true);
                  setInvalid(false);
                }}
              />
              <Button
                style={{ flex: 1 }}
                variant="danger"
                label={tr(compact ? "rejectProposalShort" : "rejectProposal")}
                disabled={disabled}
                onPress={() => onDecision("reject", proposal.revision)}
              />
            </Row>
          ) : null}
        </>
      )}
      <Disclosure
        label={tr(compact ? "meetingDetails" : "technicalDetails")}
        onToggle={() => onExpand?.()}
      >
        {compact ? (
          <>
            <Text role="caption">
              {tr("meetingStart")}: {format(proposal.parameters.startsAt)} · UTC
            </Text>
            <Text role="caption">
              {tr("meetingEnd")}: {format(proposal.parameters.endsAt)} · UTC
            </Text>
            {proposal.parameters.calendar ? (
              <Text role="caption" selectable>
                {proposal.parameters.calendar.collectionUrl}
              </Text>
            ) : null}
          </>
        ) : null}
        <Text role="caption" tone="secondary">
          {tr("approvalSource")}: {source} · {tr("revision")}{" "}
          {proposal.revision}
        </Text>
        {compact
          ? operations.map((op) => (
              <Text key={op.id} role="caption" tone="secondary">
                {tr("approvedRevision")} {op.acceptedProposalRevision}
                {op.result?.kind === "calendar"
                  ? ` · ${op.result.reference}`
                  : ""}
              </Text>
            ))
          : null}
      </Disclosure>
      {(compact
        ? currentOperation
          ? [currentOperation]
          : []
        : operations
      ).map((op) => (
        <Stack key={op.id}>
          <Text role="label">
            {tr(
              op.parameters.calendar && op.status === "executing"
                ? "calendarExecuting"
                : op.parameters.calendar && op.status === "succeeded"
                  ? "calendarSucceeded"
                  : `operation_${op.status}`,
            )}
          </Text>
          {!compact ? (
            <Text role="caption" tone="secondary">
              {tr("approvedRevision")} {op.acceptedProposalRevision}
            </Text>
          ) : null}
          {!compact && op.status === "succeeded" ? (
            <Text>
              {tr(
                op.result?.kind === "calendar"
                  ? "calendarResult"
                  : "demoResult",
              )}
            </Text>
          ) : null}
          {!compact && op.result?.kind === "calendar" ? (
            <Text role="caption">
              {tr("calendarReference")}: {op.result.reference}
            </Text>
          ) : null}
          {op.error ? (
            <Notice error>{tr(`calendar_error_${op.error}`)}</Notice>
          ) : null}
          {op.parameters.calendar &&
          op.status === "result_unknown" &&
          onReconcile ? (
            <Button
              label={tr("reconcileCalendar")}
              disabled={disabled}
              onPress={() => onReconcile(op)}
            />
          ) : null}
          {op.status === "result_unknown" ? (
            <Notice>{tr("operationUnknownHint")}</Notice>
          ) : null}
        </Stack>
      ))}
    </Stack>
  );
}
