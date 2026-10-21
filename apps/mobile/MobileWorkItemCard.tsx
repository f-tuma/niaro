import React, {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { randomUUID } from "expo-crypto";
import type {
  ClientSession,
  SessionState,
} from "../../packages/client-core/session";
import {
  captureProcessResolveTarget,
  processResolveCommand,
  type ProcessResolveTarget,
} from "../../packages/client-core/process-commands";
import {
  WorkItemCard,
  type WorkItemCardProps,
} from "../../packages/ui-catalog/WorkItemCard";
import { Button, Notice, Row } from "../../packages/ui";
import {
  isCancellableWork,
  workCancelError,
} from "../../packages/client-core/conversation-directory";
import { translate, en, type TranslationKey } from "../../packages/i18n";
import { ProcessOutputInspector } from "./ProcessOutputInspector";
import {
  captureProcessNoticeOwner,
  selectProcessCommandNotice,
} from "../../packages/client-core/process-command-notice";

type Props = WorkItemCardProps & {
  session: ClientSession | null;
  conversationId: string;
  chatGeneration: number;
};
const emptySnapshot: SessionState = {
  store: null,
  status: "offline",
  pending: null,
  processPending: null,
  commandStates: {},
  answerAttempts: [],
  answerRecoveryBlocked: false,
  error: null,
  activity: null,
  activityConnection: "waiting",
};
const readEmpty = () => emptySnapshot;
const subscribeEmpty = () => () => {};

/** A prior UI owner never gains the authority of a later connection or chat. */
export function MobileWorkItemCard(props: Props) {
  const { session, language, conversationId, chatGeneration } = props;
  const [owner, setOwner] = useState({
    session,
    language,
    conversationId,
    chatGeneration,
    revision: 1,
  });
  if (
    owner.session !== session ||
    owner.language !== language ||
    owner.conversationId !== conversationId ||
    owner.chatGeneration !== chatGeneration
  ) {
    setOwner({
      session,
      language,
      conversationId,
      chatGeneration,
      revision: owner.revision + 1,
    });
    return null;
  }
  return <OwnedWorkItemCard key={owner.revision} {...props} />;
}

function OwnedWorkItemCard({
  session,
  conversationId,
  chatGeneration,
  ...props
}: Props) {
  const state = useSyncExternalStore(
    session?.subscribe ?? subscribeEmpty,
    session?.getSnapshot ?? readEmpty,
    session?.getSnapshot ?? readEmpty,
  );
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
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<TranslationKey>();
  const pendingHere =
    !!state.pending &&
    "conversationId" in state.pending &&
    state.pending.conversationId === props.work.conversationId;
  // An answer in flight projects as waiting: only settled waiting work stops.
  const cancellable = !!(
    session &&
    typeof session.cancelWork === "function" &&
    isCancellableWork(props.work) &&
    // An approval card declines with its own Cancel; that is the same stop.
    props.work.status !== "waiting_approval" &&
    !pendingHere
  );
  const cancel = () => {
    const owned = guard.current;
    if (!owned.alive || owned.sending || !session || !cancellable) return;
    owned.sending = true;
    setCancelling(true);
    setCancelError(undefined);
    void session
      .cancelWork(props.work, props.language, randomUUID())
      .catch((e: unknown) => {
        if (owned.alive) setCancelError(workCancelError(e));
      })
      .finally(() => {
        owned.sending = false;
        if (owned.alive) setCancelling(false);
      });
  };
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const tr = translate(props.language);
  const retryAvailable = !!(
    session &&
    typeof session.canRetryNativeWork === "function" &&
    session.canRetryNativeWork(props.work, conversationId) &&
    !props.blocked &&
    !state.pending &&
    !state.answerRecoveryBlocked
  );
  const retryUnavailable = !!(
    session &&
    props.work.native?.sourceCommandId &&
    ["failed", "cancelled"].includes(props.work.status) &&
    !session.getRetrySource(props.work.native.sourceCommandId)
  );
  const retryFailed = () => {
    const owned = guard.current;
    if (
      !owned.alive ||
      owned.sending ||
      !session ||
      typeof session.retryNativeWork !== "function" ||
      typeof session.canRetryNativeWork !== "function" ||
      !retryAvailable ||
      !session.canRetryNativeWork(props.work, conversationId)
    )
      return;
    owned.sending = true;
    setRetrying(true);
    setRetryError(false);
    void session
      .retryNativeWork(props.work, conversationId, {
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
      })
      .catch(() => {
        if (owned.alive) setRetryError(true);
      })
      .finally(() => {
        owned.sending = false;
        if (owned.alive) setRetrying(false);
      });
  };
  let reviewed: ProcessResolveTarget | undefined;
  if (state.store && props.work.native?.process?.approval) {
    try {
      reviewed = captureProcessResolveTarget(
        state.store,
        props.work.id,
        undefined,
        props.work.conversationId,
        props.work,
      );
    } catch {
      // The passive card still renders; changed review cannot grant authority.
    }
  }
  const sameDecision =
    reviewed &&
    decision &&
    JSON.stringify(reviewed) === JSON.stringify(decision.target)
      ? decision
      : undefined;
  const decide = (approved: boolean) => {
    const owned = guard.current;
    if (!owned.alive || owned.sending || !session || !reviewed) return;
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
      const id = randomUUID();
      command = processResolveCommand(current.store, reviewed, {
        commandId: id,
        idempotencyKey: id,
        approved,
        language: props.language,
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
    // This exact rendered target, including all parameters, accompanies the command.
    const noticeOwner = captureProcessNoticeOwner(session, {
      conversationId,
      chatGeneration,
      language: props.language,
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
  return (
    <>
      <WorkItemCard
        {...props}
        processOutputDetail={
          session ? (
            <ProcessOutputInspector
              session={session}
              work={props.work}
              language={props.language}
            />
          ) : undefined
        }
        onProcessDecision={decide}
        onRetryNative={retryAvailable ? retryFailed : undefined}
        retryUnavailable={retryUnavailable}
        blocked={
          props.blocked ||
          !!state.pending ||
          ("answerRecoveryBlocked" in state && !!state.answerRecoveryBlocked) ||
          (!!props.work.native?.process?.approval && !reviewed)
        }
        stale={
          props.stale ||
          state.status !== "online" ||
          state.store?.stale ||
          state.store?.needsSnapshot
        }
        approvalState={
          sameDecision?.phase === "sending" ||
          sameDecision?.phase === "accepted"
            ? sameDecision.phase
            : props.approvalState
        }
      />
      {cancellable ? (
        <Row style={{ justifyContent: "flex-end" }}>
          <Button
            variant="quiet"
            size="small"
            label={tr("cancelWork")}
            loading={cancelling}
            disabled={props.blocked || props.stale || state.status !== "online"}
            onPress={cancel}
          />
        </Row>
      ) : null}
      {cancelError ? <Notice error>{tr(cancelError)}</Notice> : null}
      {retrying ? <Notice>{tr("retryingTask")}</Notice> : null}
      {retryError ? <Notice>{tr("retryTaskFailed")}</Notice> : null}
      {sameDecision?.error ? <Notice>{tr(sameDecision.error)}</Notice> : null}
    </>
  );
}
