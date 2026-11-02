import React, { useCallback, useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { randomUUID } from "expo-crypto";
import type { ClientSession } from "../../packages/client-core/session";
import {
  ConnectionFlow,
  type ConnectionState,
} from "../../packages/client-core/service-connection-flow";
import type { Language } from "../../packages/protocol";
import {
  processProposalWebUrl,
  type ProcessProposalResult,
  type ProcessProposalStatus,
} from "../../packages/protocol/process-proposal";
import { translate, type TranslationKey } from "../../packages/i18n";
import { tokens as t } from "../../packages/design-tokens";
import { Button, Icon, Notice, Row, Text } from "../../packages/ui";
import { connectionPlatform } from "./ServiceConnection";

type Readiness = NonNullable<ProcessProposalStatus["services"]>[number];

/** How far a running save has come, one short line. */
const phases: Record<
  NonNullable<ProcessProposalStatus["phase"]>,
  TranslationKey
> = {
  saving: "processProposalSaving",
  testing: "processProposalTesting",
  activating: "processProposalActivating",
  hub: "processProposalHubbing",
};
const failures: Record<string, TranslationKey> = {
  process_proposal_changed: "processProposalChanged",
  process_proposal_test_failed: "processProposalTestFailed",
  process_proposal_interrupted: "processProposalInterrupted",
};

/**
 * A personal process drafted in chat, on the phone. **Save and turn on**
 * runs the server's own pipeline (save, test, turn on, overview) and the card
 * follows its status; editing stays in the web app. Each service shows
 * whether the person is signed in to it, read live with the status.
 */
export function ProcessProposalCard({
  session,
  language,
  proposal,
  disabled,
  online,
}: {
  session: ClientSession;
  language: Language;
  proposal: ProcessProposalResult;
  /** Busy, offline or an archived chat: nothing can be pressed. */
  disabled: boolean;
  online: boolean;
}) {
  const tr = translate(language);
  const sessionId = proposal.sessionId;
  const [status, setStatus] = useState<ProcessProposalStatus | null>(null);
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  /** A press whose answer was lost is sent again with the same id. */
  const press = useRef<string | undefined>(undefined);
  const [reads, setReads] = useState(0);
  const running = status?.state === "running";
  useEffect(() => {
    if (!sessionId || !online) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      session
        .readProcessProposal(sessionId, controller.signal)
        .then((value) => {
          if (controller.signal.aborted) return;
          setStatus(value);
          if (value.state === "running") timer = setTimeout(read, 1500);
        })
        .catch(() => {
          if (!controller.signal.aborted && running)
            timer = setTimeout(read, 3000);
        });
    };
    read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [session, sessionId, online, running, reads]);
  const refresh = useCallback(() => setReads((value) => value + 1), []);
  const save = async () => {
    if (!sessionId || proposal.revision === null || !proposal.reviewDigest)
      return;
    const requestId = (press.current ??= randomUUID());
    setSending(true);
    setRefused(null);
    try {
      setStatus(
        await session.acceptProcessProposal(
          {
            sessionId,
            requestId,
            revision: proposal.revision,
            reviewDigest: proposal.reviewDigest,
            // Exactly the assumptions this card shows.
            assumptions: proposal.assumptions.map(({ id, digest }) => ({
              id,
              digest,
            })),
            addToHub: proposal.addToHub && proposal.hubEligible,
          },
          language,
        ),
      );
      press.current = undefined;
    } catch (error) {
      setRefused(
        error instanceof Error ? error.message : "process_proposal_failed",
      );
    } finally {
      setSending(false);
    }
  };
  const state = status?.state ?? "open";
  const failure = refused ?? (state === "failed" ? status?.failure : null);
  // Limits can change, so these stops (and an outgrown version) can be pressed again.
  const again =
    (state === "stopped" &&
      ["model_reservation_too_large", "limits_exceeded"].includes(
        status?.gap ?? "",
      )) ||
    (state === "done" && status?.resize === true);
  const settled = (state === "done" || state === "stopped") && !again;
  const canSave =
    proposal.status === "ready" && !settled && !running && !sending;
  const web = processProposalWebUrl(session.address, proposal);
  const services: Readiness[] | { name: string }[] =
    status?.services ?? proposal.services;
  return (
    <View testID="process-proposal" style={{ gap: 10 }}>
      <View style={{ gap: 2 }}>
        <Text role="caption" tone="secondary">
          {tr("processProposalTitle")}
        </Text>
        <Text style={{ fontWeight: "600" }}>{proposal.name}</Text>
        {proposal.description ? (
          <Text role="caption" tone="secondary">
            {proposal.description}
          </Text>
        ) : null}
      </View>
      {proposal.status === "budget" ? (
        <Notice>{tr("processProposalBudget")}</Notice>
      ) : null}
      {proposal.steps.length ? (
        <View
          accessibilityLabel={tr("processProposalSteps")}
          style={{ gap: 4 }}
        >
          {proposal.steps.map((step, index) => (
            <Row key={index} style={{ gap: 8, alignItems: "flex-start" }}>
              <Text role="caption" tone="secondary" style={{ minWidth: 16 }}>
                {`${index + 1}.`}
              </Text>
              <Text role="caption" style={{ flex: 1 }}>
                {step.type === "action"
                  ? `${step.service} · ${step.action}${
                      step.effect === "write"
                        ? ` · ${tr(step.approval ? "processProposalWritesApproved" : "processProposalWrites")}`
                        : ""
                    }`
                  : step.type === "agent"
                    ? `${tr("processProposalAi")}: ${step.task}`
                    : step.type === "branch"
                      ? tr("processProposalBranch")
                      : `${tr("processProposalResult")}: ${step.fields.join(", ")}`}
              </Text>
            </Row>
          ))}
        </View>
      ) : null}
      {services.length ? (
        <View style={{ gap: 4 }}>
          <Text role="caption" tone="secondary">
            {tr("processProposalServices")}
          </Text>
          {services.map((service) => (
            <ServiceReadiness
              key={service.name}
              session={session}
              language={language}
              service={service}
              disabled={disabled || !online}
              onSignedIn={refresh}
            />
          ))}
        </View>
      ) : null}
      {proposal.assumptions.length ? (
        <View style={{ gap: 4 }}>
          <Text role="caption" tone="secondary">
            {tr("processProposalAssumptions")}
          </Text>
          {proposal.assumptions.map((assumption) => (
            <Text key={assumption.id} role="caption">
              {`• ${assumption.text}`}
            </Text>
          ))}
        </View>
      ) : null}
      {proposal.status === "questions" ? (
        <View style={{ gap: 4 }}>
          <Text role="caption" tone="secondary">
            {tr("processProposalQuestions")}
          </Text>
          {proposal.questions.map((question, index) => (
            <Text key={index} role="caption">
              {`• ${question}`}
            </Text>
          ))}
          <Text role="caption" tone="secondary">
            {tr("processProposalAnswerHint")}
          </Text>
        </View>
      ) : null}
      {proposal.addToHub && proposal.hubEligible && !settled ? (
        <Text role="caption" tone="secondary">
          {tr("processProposalHub")}
        </Text>
      ) : null}
      {running && status?.phase ? (
        <Text
          testID="process-proposal-state"
          role="caption"
          tone="secondary"
          accessibilityLiveRegion="polite"
        >
          {tr(phases[status.phase])}
        </Text>
      ) : state === "done" ? (
        <Row
          testID="process-proposal-state"
          accessibilityLiveRegion="polite"
          style={{ gap: 6 }}
        >
          <Icon name="check" size={16} color={t.color.status.success} />
          <Text role="caption" style={{ flex: 1 }}>
            {status?.hub === "added"
              ? tr("processProposalDoneHub")
              : status?.resize
                ? tr("processProposalResize")
                : tr("processProposalDone")}
          </Text>
        </Row>
      ) : state === "stopped" ? (
        <Text testID="process-proposal-state" role="caption" tone="secondary">
          {tr("processProposalStopped")}
        </Text>
      ) : failure ? (
        <Notice error>
          {`${tr("processProposalFailed")} ${failures[failure] ? tr(failures[failure]) : ""}`.trim()}
        </Notice>
      ) : null}
      <Row style={{ gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <Button
          label={tr("processProposalOpenWeb")}
          variant="secondary"
          size="small"
          onPress={() => void Linking.openURL(web).catch(() => {})}
        />
        {canSave || sending || running ? (
          <Button
            label={tr(
              failure ? "processProposalSaveAgain" : "processProposalSave",
            )}
            size="small"
            loading={sending || running}
            disabled={disabled || !online || !canSave}
            onPress={() => void save()}
          />
        ) : null}
      </Row>
    </View>
  );
}

/**
 * One service the proposal uses: signed in, not signed in (with Sign in),
 * or needing no sign-in. It says signed in, never that the service works.
 */
function ServiceReadiness({
  session,
  language,
  service,
  disabled,
  onSignedIn,
}: {
  session: ClientSession;
  language: Language;
  service: Readiness | { name: string };
  disabled: boolean;
  onSignedIn: () => void;
}) {
  const tr = translate(language);
  const readiness = "signIn" in service ? service : undefined;
  const flow = useRef<ConnectionFlow | null>(null);
  const [connection, setConnection] = useState<ConnectionState>();
  const signedIn = useRef(onSignedIn);
  useEffect(() => {
    signedIn.current = onSignedIn;
  });
  const needed = readiness?.signIn === "needed";
  const serviceId = readiness?.serviceId;
  useEffect(() => {
    if (!needed || !serviceId) return;
    const owner = new ConnectionFlow(
      session,
      serviceId,
      setConnection,
      () => signedIn.current(),
      connectionPlatform,
    );
    flow.current = owner;
    void owner.load();
    return () => {
      owner.dispose();
      flow.current = null;
    };
  }, [session, serviceId, needed]);
  const phase = connection?.phase;
  const label = !readiness
    ? undefined
    : readiness.signIn === "connected" || phase === "connected"
      ? tr("processProposalSignedIn")
      : readiness.signIn === "none"
        ? tr("processProposalNoSignIn")
        : phase === "pending" || phase === "starting"
          ? tr("processProposalSigningIn")
          : tr("processProposalNotSignedIn");
  const canSignIn =
    needed &&
    !!phase &&
    ["disconnected", "expired", "cancelled", "error"].includes(phase);
  return (
    <Row
      testID="process-proposal-service"
      style={{ gap: 8, minHeight: 32, flexWrap: "wrap" }}
    >
      <Text role="caption" style={{ flex: 1, minWidth: 120 }}>
        {service.name}
      </Text>
      {label ? (
        <Text
          role="caption"
          tone={needed && phase !== "connected" ? undefined : "secondary"}
          style={
            needed && phase !== "connected"
              ? { color: t.color.status.warning }
              : undefined
          }
        >
          {label}
        </Text>
      ) : null}
      {canSignIn ? (
        <Button
          label={`${tr("processProposalSignIn")}: ${service.name}`}
          variant="quiet"
          size="small"
          disabled={disabled}
          onPress={() => void flow.current?.start()}
        />
      ) : null}
    </Row>
  );
}
