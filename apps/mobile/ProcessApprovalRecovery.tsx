import React, {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  commandTarget,
  type ClientSession,
  type ProcessPendingView,
  type SessionState,
} from "../../packages/client-core/session";
import { validateProcessCommandTarget } from "../../packages/client-core/process-commands";
import type { Language } from "../../packages/protocol";
import { translate, en, type TranslationKey } from "../../packages/i18n";
import {
  captureProcessNoticeOwner,
  processNoticeCopy,
  processPendingRecoveryError,
  isReservedProcessRecoveryCopy,
} from "../../packages/client-core/process-command-notice";
import { ProcessApprovalRecoveryCard } from "../../packages/ui-catalog/ProcessApprovalRecoveryCard";

type Props = {
  session: ClientSession;
  language: Language;
  conversationId: string;
  chatGeneration: number;
};
type ResolvePending = ProcessPendingView & {
  command: Extract<ProcessPendingView["command"], { type: "service.resolve" }>;
  target: Extract<ProcessPendingView["target"], { type: "service.resolve" }>;
};

function reviewedPending(
  session: ClientSession,
  state: SessionState,
): ResolvePending | null {
  const saved = state.processPending;
  if (
    !saved ||
    saved.command.type !== "service.resolve" ||
    saved.target.type !== "service.resolve" ||
    JSON.stringify(state.pending) !== JSON.stringify(saved.command)
  )
    return null;
  try {
    const scope = saved.target.scope;
    if (
      session.identityKey !==
      JSON.stringify([
        session.address,
        scope.connectionId,
        scope.serverId,
        scope.userId,
        scope.workspaceId,
      ])
    )
      return null;
    validateProcessCommandTarget(
      saved.command,
      saved.target,
      session.address,
      scope,
    );
    return saved as ResolvePending;
  } catch {
    return null;
  }
}

function retryAllowed(state: SessionState, saved: ResolvePending): boolean {
  return (
    !state.answerRecoveryBlocked &&
    state.commandStates[commandTarget(saved.command)] !== "sending" &&
    (saved.outcome === "unknown"
      ? state.status === "online" &&
        !!state.store &&
        !state.store.stale &&
        !state.store.needsSnapshot
      : state.status === "online" || state.status === "offline")
  );
}

/** Recovered decisions retain their original identity across newer UI contexts. */
export function ProcessApprovalRecovery(props: Props) {
  const [owner, setOwner] = useState(() => ({ ...props, revision: 0 }));
  if (
    owner.session !== props.session ||
    owner.language !== props.language ||
    owner.conversationId !== props.conversationId ||
    owner.chatGeneration !== props.chatGeneration
  ) {
    setOwner({ ...props, revision: owner.revision + 1 });
    return null;
  }
  return <OwnedApprovalRecovery key={owner.revision} {...props} />;
}

function OwnedApprovalRecovery({
  session,
  language,
  conversationId,
  chatGeneration,
}: Props) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const guard = useRef({ alive: false, retrying: false });
  useLayoutEffect(() => {
    const current = guard.current;
    current.alive = true;
    return () => {
      current.alive = false;
    };
  }, []);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const pending = state.pending;
  if (pending?.type !== "service.resolve" || !("profile" in pending))
    return null;
  const saved = reviewedPending(session, state);
  // Only the captured saved command/target may authorize a retry, never current work B.
  const commandBytes = saved ? JSON.stringify(saved.command) : null;
  const targetBytes = saved ? JSON.stringify(saved.target) : null;
  const canRetry = !!saved && !retrying && retryAllowed(state, saved);
  const retry = () => {
    const owned = guard.current;
    if (!owned.alive || owned.retrying || !saved || !canRetry) return;
    const current = session.getSnapshot();
    const original = reviewedPending(session, current);
    if (
      !original ||
      original.outcome !== saved.outcome ||
      JSON.stringify(original.command) !== commandBytes ||
      JSON.stringify(original.target) !== targetBytes ||
      !retryAllowed(current, original)
    )
      return;
    owned.retrying = true;
    setRetrying(true);
    setError(null);
    void session
      .retry(
        captureProcessNoticeOwner(session, {
          language,
          conversationId,
          chatGeneration,
        }),
      )
      .then(
        () => {
          if (!owned.alive) return;
          owned.retrying = false;
          setRetrying(false);
        },
        () => {
          if (!owned.alive) return;
          owned.retrying = false;
          setRetrying(false);
          setError("savedProcessApprovalChanged");
        },
      );
  };
  const explanation = error
    ? isReservedProcessRecoveryCopy(error)
      ? "savedProcessApprovalChanged"
      : error
    : processPendingRecoveryError(saved, state.error);
  const processCopy =
    saved?.notice && state.processNotice?.errorSource.kind !== "local"
      ? processNoticeCopy(saved.notice)
      : null;
  const tr = translate(language);
  return (
    <ProcessApprovalRecoveryCard
      language={language}
      review={
        saved
          ? {
              title: saved.target.receipt.title,
              service: saved.target.receipt.service,
              approved: saved.command.approved,
              effect: saved.target.receipt.effect,
              result: saved.target.approval?.result,
              frame: {
                source: saved.target.connectionKey,
                workspace: saved.target.scope.workspaceId,
                nativeRevision: saved.target.expectedWorkRevision,
                conversationId: saved.target.conversationId,
                language: saved.command.language,
                serviceId: saved.target.approval?.serviceId,
                serviceRevision: saved.target.approval?.serviceRevision,
                actionId: saved.target.approval?.actionId,
                actionRevision: saved.target.approval?.actionRevision,
              },
            }
          : undefined
      }
      outcome={saved?.outcome ?? "unknown"}
      explanation={
        state.processNotice?.errorSource.kind === "local" && !error
          ? tr(state.processNotice.errorSource.code)
          : processCopy && !error
            ? tr(processCopy.key) +
              (processCopy.detailKey ? ` ${tr(processCopy.detailKey)}` : "")
            : explanation
              ? explanation in en
                ? tr(explanation as TranslationKey)
                : explanation
              : undefined
      }
      canRetry={canRetry}
      retrying={retrying}
      onRetry={retry}
    />
  );
}
