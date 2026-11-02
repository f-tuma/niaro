import React from "react";
import { Animated, TextInput, View } from "react-native";
import type { Language, HumanTaskReference } from "../../../packages/protocol";
import type { VoiceDraft } from "../../../packages/client-core/voice";
import { translate, type TranslationKey } from "../../../packages/i18n";
import { tokens as t } from "../../../packages/design-tokens";
import { ActionToast, FadeEdge, Notice, Row, Text } from "../../../packages/ui";
import type { PetAppearance } from "../../../packages/ui/pet-motion";
import { ProcessCommandNoticeView } from "../../../packages/ui-catalog/ProcessCommandNoticeView";
import { ConnectionFailureNotice } from "../../../packages/ui-catalog/ConnectionFailureNotice";
import {
  chrome as styles,
  Composer,
  IconButton,
  ReadOnlyComposer,
} from "../ScreenChrome";
import { companionCopy } from "../companion-copy";
import {
  MobileAttachmentDraft,
  type MobileAttachments,
} from "../AttachmentControls";
import {
  MobileMentionSuggestions,
  MobileMentionTray,
  type useMobileComposerMentions,
} from "../MobileMentions";
import {
  VoiceReply,
  isProcessReply,
  type VoiceReplyContext,
} from "../VoiceReply";
import type { useReplySpeech } from "../ReplySpeech";

type Mentions = ReturnType<typeof useMobileComposerMentions>;
type Speech = ReturnType<typeof useReplySpeech>;

/**
 * The chat's footer: what went wrong, the spoken reply, the reply context or
 * attached task, and then the voice reply, the archived chat's way on or the
 * composer. The workspace owns the draft and every command.
 */
export function ChatFooter({
  language,
  notice,
  errorKey,
  diagnostic,
  speech,
  context,
  validContext,
  waitingForProcessAnswer,
  onClearContext,
  attachedTask,
  onDetachTask,
  voice,
  voiceOpen,
  voiceBlocked,
  onCloseVoice,
  voiceLevel,
  petAppearance,
  petAnimate,
  readOnly,
  onNewChat,
  onRestore,
  restoreError,
  attachments,
  mentions,
  inputRef,
  draft,
  onFocus,
  onBlur,
  onSend,
  onVoice,
  onAttach,
  disabled,
  sending,
  onStop,
  stopLabel,
  stopDisabled,
  voiceMode,
}: {
  language: Language;
  notice?: React.ComponentProps<typeof ProcessCommandNoticeView>["notice"];
  errorKey: TranslationKey | null;
  diagnostic?: React.ComponentProps<
    typeof ConnectionFailureNotice
  >["diagnostic"];
  speech: Speech;
  context?: VoiceReplyContext;
  validContext: boolean;
  waitingForProcessAnswer: boolean;
  onClearContext: () => void;
  /** The open item from Tasks that rides on this chat's next message. */
  attachedTask?: HumanTaskReference;
  onDetachTask: () => void;
  voice?: VoiceDraft;
  /** The voice reply replaces the composer. */
  voiceOpen: boolean;
  voiceBlocked: boolean;
  onCloseVoice: () => void;
  voiceLevel: Animated.Value;
  petAppearance?: PetAppearance;
  petAnimate: boolean;
  readOnly: boolean;
  onNewChat?: () => void;
  onRestore?: () => void;
  restoreError?: TranslationKey;
  attachments: MobileAttachments;
  mentions: Mentions;
  inputRef: React.RefObject<TextInput | null>;
  draft: string;
  onFocus: () => void;
  onBlur: () => void;
  onSend: () => void;
  onVoice: () => void;
  onAttach: () => void;
  disabled: boolean;
  sending: boolean;
  onStop?: () => void;
  stopLabel: string;
  stopDisabled: boolean;
  voiceMode: "ready" | "disabled" | "settings";
}) {
  const tr = translate(language);
  return (
    <View testID="screen-footer" style={styles.footer}>
      <FadeEdge />
      {notice ? (
        <ProcessCommandNoticeView language={language} notice={notice} />
      ) : null}
      {errorKey ? (
        <View style={{ gap: t.spacing.sm }}>
          {errorKey === "connection_failed" && diagnostic ? (
            <ConnectionFailureNotice
              language={language}
              diagnostic={diagnostic}
            />
          ) : (
            <Notice error>{tr(errorKey)}</Notice>
          )}
        </View>
      ) : null}
      {speech.state.phase === "playing" ? (
        <Row style={{ justifyContent: "space-between" }}>
          <Text role="caption" tone="secondary">
            {companionCopy(language).speaking}
          </Text>
          <IconButton
            icon="stop"
            label={companionCopy(language).stopSpeech}
            onPress={speech.player.stop}
          />
        </Row>
      ) : null}
      {speech.state.phase === "error" ? (
        <ActionToast
          message={tr(
            speech.state.error === "speech_privacy_unavailable"
              ? "speech_privacy_short"
              : "spoken_replies_failed",
          )}
          description={
            speech.state.error === "speech_privacy_unavailable"
              ? tr("speech_privacy_unavailable")
              : undefined
          }
          actionLabel={tr("close")}
          onAction={speech.player.stop}
        />
      ) : null}
      {context ? (
        <View style={styles.reply}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text role="caption" tone="secondary">
              {tr(
                waitingForProcessAnswer
                  ? "process_question_pending"
                  : validContext
                    ? "replyTo"
                    : "inputContextChanged",
              )}
            </Text>
            <Text role="caption" numberOfLines={2}>
              {isProcessReply(context)
                ? context.target.question.question
                : context.question}
            </Text>
          </View>
          <IconButton
            icon="close"
            label={tr("clearContext")}
            onPress={onClearContext}
          />
        </View>
      ) : attachedTask ? (
        <View testID="composer-task" style={styles.reply}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text role="caption" tone="secondary">
              {tr("humanTaskAttached")}
            </Text>
            <Text role="caption" numberOfLines={2}>
              {attachedTask.title}
            </Text>
          </View>
          <IconButton
            icon="close"
            label={tr("humanTaskDetach")}
            onPress={onDetachTask}
          />
        </View>
      ) : null}
      {voice && voiceOpen ? (
        <VoiceReply
          draft={voice}
          language={language}
          blocked={voiceBlocked}
          onClose={onCloseVoice}
          level={voiceLevel}
          petAppearance={petAppearance}
          petAnimate={petAnimate}
        />
      ) : readOnly ? (
        <ReadOnlyComposer
          language={language}
          onNewChat={onNewChat}
          onRestore={onRestore}
          error={restoreError}
        />
      ) : (
        <View>
          <MobileAttachmentDraft value={attachments} />
          <MobileMentionSuggestions
            items={mentions.items}
            language={language}
            onPick={mentions.pick}
          />
          <Composer
            inputRef={inputRef}
            language={language}
            value={draft}
            onChange={mentions.type}
            onSelectionChange={mentions.select}
            selection={mentions.selection}
            onFocus={onFocus}
            onBlur={onBlur}
            references={
              <MobileMentionTray
                selected={mentions.selected}
                language={language}
              />
            }
            hasAttachments={attachments.state.entries.length > 0}
            sendBlocked={
              attachments.state.entries.length > 0 && !attachments.ready
            }
            onSend={onSend}
            onVoice={onVoice}
            onAttach={onAttach}
            disabled={disabled}
            sending={sending}
            onStop={onStop}
            stopLabel={stopLabel}
            stopDisabled={stopDisabled}
            voice={voiceMode}
          />
        </View>
      )}
    </View>
  );
}
