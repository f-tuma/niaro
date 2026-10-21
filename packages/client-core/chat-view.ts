import { en, type TranslationKey } from "../i18n";
import { isReservedProcessRecoveryCopy } from "./process-command-notice";
import type { SessionCommand, SessionState } from "./session";
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

/**
 * The text being sent in this chat, shown until the server records it.
 * A retained process answer has its own recovery card instead.
 */
export function selectPendingChatMessage(
  state: Pick<SessionState, "pending" | "answerAttempts" | "store">,
  conversationId: string,
): { kind: "message" | "answer"; text: string } | null {
  const pending = state.pending;
  if (
    (pending?.type !== "message.send" && pending?.type !== "process.answer") ||
    pending.conversationId !== conversationId ||
    (state.answerAttempts ?? []).some(
      (attempt) => attempt.command.commandId === pending.commandId,
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

/** Delivery of the pending command is uncertain; resending it is safe. */
export function canRetryPending(
  state: Pick<SessionState, "commandStates" | "error" | "pending">,
) {
  return (
    Object.values(state.commandStates).includes("network_error") ||
    (state.error === "storage_error" && !!state.pending)
  );
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
