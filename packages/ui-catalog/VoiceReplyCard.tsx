import React from "react";
import { translate, en, type TranslationKey } from "../i18n";
import type { Language } from "../protocol";
import type { VoiceTranscript } from "../protocol/voice";
import { ActivityIndicator, View } from "react-native";
import { tokens as t } from "../design-tokens";
import { useReducedMotion } from "../ui/motion";
import {
  Surface,
  Text,
  Button,
  Field,
  Notice,
  DetailRow,
  Disclosure,
  Icon,
} from "../ui";

export type VoiceReplyStage =
  | "checking"
  | "unavailable"
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "recorded"
  | "transcribing"
  | "review"
  | "submitted"
  | "cancelling";
export function VoiceReplyCard({
  language,
  stage,
  address,
  question,
  text,
  error,
  blocked,
  showTitle = true,
  reviewReasons = [],
  onStart,
  onStop,
  onUpload,
  onEdit,
  onSend,
  onCancel,
}: {
  language: Language;
  stage: VoiceReplyStage;
  address: string;
  question?: string;
  reviewReasons?: VoiceTranscript["reviewReasons"];
  text: string;
  error?: string | null;
  blocked?: boolean;
  showTitle?: boolean;
  onStart: () => void;
  onStop: () => void;
  onUpload: () => void;
  onEdit: (text: string) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  const tr = translate(language);
  const reduced = useReducedMotion();
  const status = {
    checking: "voice_checking",
    unavailable: "voice_unavailable",
    idle: "voice_ready",
    starting: "voice_starting",
    recording: "voice_recording",
    stopping: "voice_stopping",
    recorded: "voice_recorded",
    transcribing: "voice_transcribing",
    review: "voice_review",
    submitted: "voice_submitted",
    cancelling: "voice_cancelling",
  } as const;
  return (
    <Surface>
      {showTitle ? <Text role="cardTitle">{tr("voice_reply")}</Text> : null}
      <DetailRow
        icon="chat"
        label={tr(question ? "voice_question" : "voice_new_request")}
      >
        {question ? (
          <Text>{question}</Text>
        ) : (
          <Text role="caption" tone="secondary">
            {tr("voice_example")}
          </Text>
        )}
      </DetailRow>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: t.spacing.sm,
        }}
        accessibilityLiveRegion="polite"
      >
        {["starting", "stopping", "transcribing"].includes(stage) ? (
          reduced ? (
            <Icon name="clock" size={18} color={t.color.action.primary} />
          ) : (
            <ActivityIndicator size="small" color={t.color.action.primary} />
          )
        ) : null}
        <Text tone="secondary" style={{ flex: 1 }}>
          {tr(status[stage])}
        </Text>
      </View>
      {stage !== "unavailable" && stage !== "checking" ? (
        <>
          {stage === "idle" ? (
            <Text role="caption" tone="secondary">
              {tr("voice_short_disclosure")}
            </Text>
          ) : null}
        </>
      ) : null}
      {error ? (
        <Notice error>
          {tr(error in en ? (error as TranslationKey) : "voice_capture_failed")}
        </Notice>
      ) : null}
      {stage === "idle" ? (
        <Button
          label={tr("voice_start")}
          icon="mic"
          disabled={blocked}
          onPress={onStart}
        />
      ) : null}
      {stage === "recording" ? (
        <Button label={tr("voice_stop")} onPress={onStop} />
      ) : null}
      {stage === "recorded" ? (
        <Button
          label={tr("voice_upload")}
          disabled={blocked}
          onPress={onUpload}
        />
      ) : null}
      {stage === "review" ? (
        <>
          <Field
            label={tr("voice_transcript")}
            value={text}
            onChangeText={onEdit}
            multiline
            maxLength={4000}
            editable={!blocked}
          />
          <Notice>
            {tr(
              reviewReasons.includes("limit")
                ? "voice_limit_review"
                : reviewReasons.length
                  ? "voice_uncertain_review"
                  : "voice_review_hint",
            )}
          </Notice>
          <Button
            label={tr("voice_send")}
            disabled={blocked || !text.trim()}
            onPress={onSend}
          />
        </>
      ) : null}
      {stage !== "unavailable" && stage !== "checking" ? (
        <Disclosure label={tr("voice_details")}>
          <DetailRow icon="link" label={tr("voice_destination")}>
            <Text role="caption" selectable>
              {address}
            </Text>
          </DetailRow>
          <Text role="caption" tone="secondary">
            {tr("voice_disclosure")}
          </Text>
        </Disclosure>
      ) : null}
      {!["idle", "checking", "unavailable", "cancelling", "submitted"].includes(
        stage,
      ) ? (
        <Button
          label={tr("voice_discard")}
          variant="quiet"
          onPress={onCancel}
        />
      ) : null}
    </Surface>
  );
}
