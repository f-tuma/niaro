import React from "react";
import { View } from "react-native";
import type { SessionState } from "../../../packages/client-core/session";
import type { Language, WorkItem } from "../../../packages/protocol";
import { translate } from "../../../packages/i18n";
import { Text } from "../../../packages/ui";
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
