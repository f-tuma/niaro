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
}: {
  entries: readonly ThreadEntry[];
  pendingMessage: { kind: "message" | "answer"; text: string } | null;
  trailing: readonly WorkItem[];
  heldReply?: string;
  state: SessionState;
  conversationId: string;
  /** Resends the pending request when its delivery is uncertain. */
  onRetry?: () => void;
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
            connection={state.activityConnection}
            failed={!!state.error?.startsWith("model_")}
            onRetry={onRetry}
            retryDisabled={!chat.online}
            interrupted={
              !chat.online ||
              Object.values(state.commandStates).includes("network_error")
            }
          />
          {state.activity?.draft ? (
            <AnswerDraft draft={state.activity.draft} language={language} />
          ) : null}
        </AssistantMessage>
      ) : null}
    </>
  );
}
