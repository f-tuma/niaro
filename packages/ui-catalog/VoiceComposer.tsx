import React from "react";
import {
  ActivityIndicator,
  Animated,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { translate, en, type TranslationKey } from "../i18n";
import type { Language } from "../protocol";
import type { VoiceTranscript } from "../protocol/voice";
import { VoiceVisualizer } from "../ui/VoiceVisualizer";
import { tokens as t } from "../design-tokens";
import { Button, Icon, Text, ui, type IconName } from "../ui";
import {
  MotionPressable,
  useMotionTarget,
  useReducedMotion,
} from "../ui/motion";

export type VoiceComposerProps = {
  language: Language;
  stage:
    | "idle"
    | "starting"
    | "recording"
    | "stopping"
    | "recorded"
    | "transcribing"
    | "review"
    | "submitted"
    | "cancelling";
  text: string;
  reviewReasons?: VoiceTranscript["reviewReasons"];
  error?: string | null;
  blocked?: boolean;
  level?: number;
  bands?: readonly [number, number, number];
  /** 24 bands, 0–1, low to high: the shape of the voice. */
  spectrum?: readonly number[];
  onStart(): void;
  onStop(): void;
  onUpload(): void;
  onEdit(text: string): void;
  onSend(): void;
  onCancel(): void;
};
/** A ring behind the Done button that grows with the voice it hears. */
function LevelRing({ level }: { level: number }) {
  const scale = useMotionTarget(1 + Math.min(1, Math.max(0, level)) * 0.45, 90);
  return (
    <Animated.View
      aria-hidden
      style={[styles.ring, { transform: [{ scale }] }]}
    />
  );
}
function Control({
  label,
  icon,
  onPress,
  primary = false,
  disabled = false,
  compact = false,
}: {
  label: string;
  icon: IconName;
  onPress(): void;
  primary?: boolean;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={compact ? 4 : undefined}
      style={[
        styles.control,
        compact && styles.compactControl,
        {
          backgroundColor: primary ? t.color.action.primary : "transparent",
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Icon
        name={icon}
        color={primary ? t.color.text.inverse : t.color.text.primary}
      />
    </MotionPressable>
  );
}
export function VoiceComposer({
  language,
  stage,
  text,
  error,
  blocked,
  reviewReasons = [],
  level = 0,
  bands,
  spectrum,
  onStart,
  onStop,
  onUpload,
  onEdit,
  onSend,
  onCancel,
}: VoiceComposerProps) {
  const tr = translate(language);
  const reduced = useReducedMotion();
  const recording = stage === "recording";
  const review = stage === "review";
  const pending = [
    "starting",
    "stopping",
    "transcribing",
    "cancelling",
  ].includes(stage);
  const status = {
    idle: "voice_ready",
    starting: "voice_starting",
    recording: "voice_recording_short",
    stopping: "voice_stopping",
    recorded: "voice_recorded",
    transcribing: "voice_transcribing_short",
    review: "voice_review",
    submitted: "voice_submitted",
    cancelling: "voice_cancelling",
  } as const;
  return (
    <View>
      {error ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.toast}
        >
          <Icon name="info" size={18} color={t.color.action.danger} />
          <Text
            role="caption"
            style={{ flex: 1, color: t.color.action.danger }}
          >
            {tr(
              error in en ? (error as TranslationKey) : "voice_capture_failed",
            )}
          </Text>
        </View>
      ) : null}
      <View
        testID="voice-composer"
        style={[
          ui.composerFrame,
          styles.bubble,
          review ? styles.review : styles.live,
        ]}
      >
        {recording || pending ? (
          <VoiceVisualizer
            level={recording ? level : 0}
            bands={recording ? bands : undefined}
            variant="border"
            mode={recording ? "recording" : "processing"}
          />
        ) : null}
        <View style={styles.row}>
          {!review ? (
            <Control
              label={tr("voice_discard")}
              icon="close"
              onPress={onCancel}
            />
          ) : null}
          <View style={styles.center}>
            {!recording && !pending && !error ? (
              <View style={styles.status} accessibilityLiveRegion="polite">
                {!recording &&
                !review &&
                stage !== "idle" &&
                stage !== "recorded" ? (
                  reduced ? (
                    <Icon name="clock" size={16} />
                  ) : (
                    <ActivityIndicator
                      size="small"
                      color={t.color.action.primary}
                    />
                  )
                ) : null}
                <Text
                  role={review ? "label" : "caption"}
                  style={{ flexShrink: 1 }}
                >
                  {tr(status[stage])}
                </Text>
              </View>
            ) : null}
            {recording || pending || error ? (
              <View
                testID="voice-waveform"
                accessible
                accessibilityRole="image"
                accessibilityLabel={tr(status[stage])}
                accessibilityLiveRegion={pending ? "polite" : undefined}
                style={styles.wave}
              >
                <VoiceVisualizer
                  key={error ? "inactive" : "active"}
                  level={recording ? level : 0}
                  bands={recording ? bands : undefined}
                  spectrum={recording ? spectrum : undefined}
                  mode={
                    recording || !pending
                      ? "recording"
                      : stage === "starting"
                        ? "starting"
                        : "processing"
                  }
                />
              </View>
            ) : null}
          </View>
          {review ? (
            <Control
              label={tr("voice_discard")}
              icon="close"
              onPress={onCancel}
              compact
            />
          ) : (
            <View style={styles.primary}>
              {recording ? <LevelRing level={level} /> : null}
              <Control
                label={tr(
                  recording
                    ? "voice_stop"
                    : stage === "recorded"
                      ? "voice_upload"
                      : "voice_start",
                )}
                icon={
                  recording ? "check" : stage === "recorded" ? "refresh" : "mic"
                }
                primary
                disabled={
                  blocked ||
                  (!recording && stage !== "idle" && stage !== "recorded")
                }
                onPress={
                  recording ? onStop : stage === "recorded" ? onUpload : onStart
                }
              />
            </View>
          )}
        </View>
        {review ? (
          <>
            <TextInput
              accessibilityLabel={tr("voice_transcript")}
              value={text}
              onChangeText={onEdit}
              editable={!blocked}
              multiline
              maxLength={4000}
              scrollEnabled
              style={styles.input}
            />
            <Text role="caption" tone="secondary">
              {tr(
                reviewReasons.includes("limit")
                  ? "voice_limit_review"
                  : reviewReasons.length
                    ? "voice_uncertain_review_short"
                    : "voice_review_hint",
              )}
            </Text>
            <Button
              label={tr("voice_send")}
              disabled={blocked || !text.trim()}
              onPress={onSend}
            />
          </>
        ) : null}
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  bubble: { gap: 8 },
  // Same outer height as the text composer (44 + 2 × 4 + 1px edges): no jump.
  live: { padding: 4 },
  primary: { alignItems: "center", justifyContent: "center" },
  ring: {
    position: "absolute",
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: t.color.action.primary,
    opacity: 0.22,
  },
  review: { padding: t.spacing.cardPadding, gap: t.spacing.md },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  center: { flex: 1, minWidth: 0, gap: 2 },
  status: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 4,
  },
  control: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  compactControl: { width: 40, height: 40, borderRadius: 20 },
  wave: { height: 40, justifyContent: "center", overflow: "hidden" },
  toast: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: "100%",
    marginBottom: 10,
    padding: 12,
    borderRadius: t.radius.control,
    backgroundColor: t.color.action.dangerSoft,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    ...t.elevation.card,
  },
  input: {
    minHeight: t.typography.body.lineHeight * 3,
    maxHeight: t.typography.body.lineHeight * 4,
    padding: 0,
    textAlignVertical: "top",
    color: t.color.text.primary,
    ...t.typography.body,
  },
});
