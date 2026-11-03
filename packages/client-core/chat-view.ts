import { en, type TranslationKey } from "../i18n";
import { isReservedProcessRecoveryCopy } from "./process-command-notice";
import {
  commandTarget,
  type SessionCommand,
  type SessionState,
} from "./session";
import type { ProcessAnswerAttempt } from "./process-answer-attempts";
import type { Store } from "./store";

/**
 * Pure chat presentation rules shared by every client. They read session
 * state only; none of them sends, retries or changes a command.
 */

/** The person's own message for this command is in the conversation. */
export function isUserMessageRecorded(
  store: Store | null | undefined,
  command: SessionCommand,
) {
  const logicalMessageId =
    command.type === "message.send"
      ? (command.logicalMessageId ?? command.commandId)
      : command.commandId;
  return !!store?.conversations[command.conversationId]?.messages.some(
    (message) =>
      message.role === "user" &&
      (message.logicalMessageId === logicalMessageId ||
        (!message.logicalMessageId &&
          message.id.startsWith(`message-${command.commandId}-`))),
  );
}

type ProcessDeliveryState = Pick<SessionState, "pending"> &
  Partial<Pick<SessionState, "commandStates" | "deliveryCheck">>;

/**
 * A kept process start, answer or decision is on its way, or the session is
 * checking its lost outcome by itself (NIAR-284): it shows as working, with no
 * Retry and no "not confirmed" wording. A kept process command with an
 * unknown outcome that is not working has failed and offers Try again.
 */
export function processCommandWorking(
  state: ProcessDeliveryState,
  commandId: string,
) {
  const pending = state.pending;
  return (
    pending?.commandId === commandId &&
    (state.commandStates?.[commandTarget(pending)] === "sending" ||
      state.deliveryCheck === "checking")
  );
}

/**
 * A saved process answer shows its own card once the server answered for it
 * (accepted or refused) or when its delivery failed; while it is on its way
 * or being checked it shows as the person's message being sent instead.
 */
export function processAnswerCardShown(
  state: ProcessDeliveryState,
  attempt: Pick<ProcessAnswerAttempt, "command" | "outcome">,
) {
  return (
    attempt.outcome !== "unknown" ||
    !processCommandWorking(state, attempt.command.commandId)
  );
}

/** The person's decision on this process approval is on its way or being checked. */
export function processDecisionWorking(
  state: ProcessDeliveryState,
  operationId: string,
) {
  const pending = state.pending;
  return (
    pending?.type === "service.resolve" &&
    "profile" in pending &&
    pending.operationId === operationId &&
    processCommandWorking(state, pending.commandId)
  );
}

/**
 * The text being sent in this chat, shown until the server records it. A
 * process answer shows here too while it is on its way or being checked; one
 * the server answered for, or whose delivery failed, has its own card instead.
 */
export function selectPendingChatMessage(
  state: Pick<SessionState, "pending" | "answerAttempts" | "store"> &
    Partial<Pick<SessionState, "commandStates" | "deliveryCheck">>,
  conversationId: string,
): { kind: "message" | "answer"; text: string } | null {
  const pending = state.pending;
  if (
    (pending?.type !== "message.send" && pending?.type !== "process.answer") ||
    pending.conversationId !== conversationId ||
    (state.answerAttempts ?? []).some(
      (attempt) =>
        attempt.command.commandId === pending.commandId &&
        processAnswerCardShown(state, attempt),
    )
  )
    return null;
  const recorded = state.store?.conversations[conversationId]?.messages.some(
    (m) =>
      m.role === "user" &&
      (pending.type === "process.answer"
        ? m.id === `message-process-answer-${pending.questionId}`
        : m.logicalMessageId ===
            (pending.logicalMessageId ?? pending.commandId) ||
          (!m.logicalMessageId &&
            m.id.startsWith(`message-${pending.commandId}-`))),
  );
  if (recorded) return null;
  return pending.type === "process.answer"
    ? { kind: "answer", text: pending.answer }
    : { kind: "message", text: pending.text };
}

/**
 * Delivery of the pending command is uncertain; resending it is safe. Given a
 * chat, only that chat's own pending command counts. A chat request whose
 * lost outcome the session is checking by itself offers no Retry: it is shown
 * as still working until the answer comes or the check says it failed.
 */
export function canRetryPending(
  state: Pick<SessionState, "commandStates" | "error" | "pending"> &
    Partial<Pick<SessionState, "deliveryCheck">>,
  conversationId?: string,
) {
  const pending = state.pending;
  const checking =
    pending && state.deliveryCheck === "checking"
      ? commandTarget(pending)
      : null;
  if (conversationId !== undefined)
    return (
      !checking &&
      pending?.conversationId === conversationId &&
      (state.commandStates[commandTarget(pending)] === "network_error" ||
        state.error === "storage_error")
    );
  return (
    Object.entries(state.commandStates).some(
      ([target, value]) => value === "network_error" && target !== checking,
    ) ||
    (state.error === "storage_error" && !!state.pending && !checking)
  );
}

/**
 * The chat's kept request failed: its chat shows it with Retry and Dismiss.
 * A request still running, or one whose lost outcome is being checked, is not.
 */
export function chatRequestFailed(
  state: Pick<SessionState, "commandStates" | "error" | "pending"> &
    Partial<Pick<SessionState, "deliveryCheck">>,
  conversationId: string,
) {
  const pending = state.pending;
  return (
    !!pending &&
    state.commandStates[commandTarget(pending)] !== "sending" &&
    canRetryPending(state, conversationId)
  );
}

/**
 * The session still keeps this exact command after its send ended: the server
 * may have recorded it, so its words are not unsent. The session's own check,
 * a Retry or a Dismiss settles it; only a Dismiss the server confirms gives
 * the words back.
 */
export function heldForRecovery(
  state: Pick<SessionState, "pending">,
  command: Pick<SessionCommand, "commandId">,
) {
  return state.pending?.commandId === command.commandId;
}

/** The chat whose command is on its way to the server, if any. */
export function runningChat(
  state: Pick<SessionState, "pending" | "commandStates">,
): string | null {
  const pending = state.pending;
  return pending &&
    !pending.type.startsWith("conversation.") &&
    state.commandStates[commandTarget(pending)] === "sending"
    ? pending.conversationId
    : null;
}

/**
 * The session's error belongs to this chat: its command is pending here or
 * was sent from here last. An error no command caused belongs to every chat.
 */
export function chatOwnsError(
  state: Pick<SessionState, "pending" | "commandConversationId">,
  conversationId: string,
) {
  const owner = state.pending?.conversationId ?? state.commandConversationId;
  return owner === undefined || owner === conversationId;
}

/** A server or local code as display copy; unknown codes fall back to a generic line. */
export function chatErrorKey(
  replyError: TranslationKey | null,
  announcement: {
    localError?: TranslationKey;
    suppressError: boolean;
  },
  error: string | null,
  processReply: boolean,
): TranslationKey | null {
  return (
    replyError ??
    announcement.localError ??
    (announcement.suppressError
      ? null
      : error && !isReservedProcessRecoveryCopy(error) && error in en
        ? (error as TranslationKey)
        : error
          ? processReply
            ? "process_question_rejected"
            : "requestRejected"
          : null)
  );
}
