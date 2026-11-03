import React from "react";
import { View } from "react-native";
import type {
  FailedMessage,
  SessionState,
} from "../../../packages/client-core/session";
import { failedMessageCaption } from "../../../packages/client-core/chat-view";
import type { Language, WorkItem } from "../../../packages/protocol";
import { translate } from "../../../packages/i18n";
import { Button, Text } from "../../../packages/ui";
import { RequestProgressCard } from "../../../packages/ui-catalog/RequestProgressCard";
import { chrome as styles, AssistantMessage } from "../ScreenChrome";
import { AnswerDraft, ThreadMessage, useMobileChat } from "./parts";
import type { ThreadEntry } from "./thread";

/**
 * The thread: stored messages through the parts registry, the message on its
 * way, work no message presents, and the answer being written.
 */
export function ChatThread({
  entries,
  failedMessages = [],
  onRetryFailed,
  onDismissFailed,
  pendingMessage,
  trailing,
  heldReply,
  state,
  conversationId,
  onRetry,
  onDismiss,
  actionsDisabled = false,
}: {
  entries: readonly ThreadEntry[];
  /** Messages that failed after they left the composer; their words stay here. */
  failedMessages?: readonly FailedMessage[];
  /** Sends a failed message again as a new message; absent while it cannot. */
  onRetryFailed?: (commandId: string) => void;
  onDismissFailed?: (commandId: string) => void;
  pendingMessage: { kind: "message" | "answer"; text: string } | null;
  trailing: readonly WorkItem[];
  heldReply?: string;
  state: SessionState;
  conversationId: string;
  /** Resends the failed request: the identical command. */
  onRetry?: () => void;
  /** Lets go of the failed request; offered only once it failed. */
  onDismiss?: () => void;
  /** A Dismiss is being settled with the server. */
  actionsDisabled?: boolean;
}) {
  const chat = useMobileChat();
  const language: Language = chat.language;
  const tr = translate(language);
  return (
    <>
      {entries.map((entry) => (
        <ThreadMessage key={entry.message.id} entry={entry} />
      ))}
      {failedMessages.map((entry) => (
        <View
          key={`failed-${entry.command.commandId}`}
          testID="failed-message"
          style={styles.message}
        >
          {entry.command.text ? (
            <Text selectable>{entry.command.text}</Text>
          ) : null}
          <Text role="caption" tone="secondary">
            {failedMessageCaption(entry, tr)}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              variant="quiet"
              size="small"
              label={tr("progressRetry")}
              onPress={() => onRetryFailed?.(entry.command.commandId)}
              disabled={!onRetryFailed}
            />
            <Button
              variant="quiet"
              size="small"
              label={tr("progressDismiss")}
              onPress={() => onDismissFailed?.(entry.command.commandId)}
              disabled={!onDismissFailed}
            />
          </View>
        </View>
      ))}
      {pendingMessage ? (
        <View testID="pending-message" style={styles.message}>
          {pendingMessage.kind === "answer" ? (
            <Text role="caption" tone="secondary">
              {tr("process_question_pending")}
            </Text>
          ) : null}
          <Text selectable>{pendingMessage.text}</Text>
        </View>
      ) : null}
      {trailing.map((w) => (
        <View
          key={w.id}
          onLayout={(e) => chat.locateWork(w.id, e.nativeEvent.layout.y)}
        >
          <AssistantMessage>{chat.renderWork(w)}</AssistantMessage>
        </View>
      ))}
      {heldReply && !state.pending ? (
        <AssistantMessage key={`voice-${heldReply}`}>
          <RequestProgressCard
            language={language}
            activity={state.activity}
            voice
          />
        </AssistantMessage>
      ) : null}
      {state.pending?.type === "message.send" &&
      state.pending.conversationId === conversationId ? (
        <AssistantMessage key={`activity-${state.pending.commandId}`}>
          <RequestProgressCard
            language={language}
            activity={state.activity}
            // A lost outcome the session is still checking stays "Thinking";
            // only a failed request (Dismiss is offered then) says so.
            failed={!!onDismiss}
            onRetry={onDismiss ? onRetry : undefined}
            onDismiss={onDismiss}
            retryDisabled={!chat.online || actionsDisabled}
          />
          {state.activity?.draft ? (
            <AnswerDraft draft={state.activity.draft} language={language} />
          ) : null}
        </AssistantMessage>
      ) : null}
    </>
  );
}
