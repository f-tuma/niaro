import React, { useEffect, useState } from "react";
import { Animated, Platform, StyleSheet, TextInput, View } from "react-native";
import { translate, en, type TranslationKey } from "../i18n";
import type { Language } from "../protocol";
import type { VoiceTranscript } from "../protocol/voice";
import { useCompanionTypography } from "../ui/typography";
import { PetView } from "../ui/PetView";
import { tokens as t } from "../design-tokens";
import { Icon, Text, ui, type IconName } from "../ui";
import { MotionPressable, useReducedMotion } from "../ui/motion";

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
  /** The same live microphone meter shared with the pet, without React frames. */
  petLevel?: Animated.Value;
  /** Actual time since capture entered recording, not a processing estimate. */
  elapsedSeconds?: number;
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

const copy = {
  cs: {
    listening: "Poslouchám",
    silence: "Odmlkou nahrávku ukončíš.",
  },
  en: {
    listening: "Listening",
    silence: "Pause to finish.",
  },
} as const;

function Control({
  label,
  accessibilityLabel = label,
  icon,
  onPress,
  primary = false,
  disabled = false,
}: {
  label: string;
  accessibilityLabel?: string;
  icon?: IconName;
  onPress(): void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.control,
        {
          backgroundColor: primary
            ? pressed
              ? t.color.action.pressed
              : t.color.action.primary
            : pressed
              ? t.color.fillPressed
              : t.color.fill,
          borderColor: primary ? "transparent" : t.color.border,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      {icon ? (
        <Icon
          name={icon}
          size={18}
          color={primary ? t.color.text.inverse : t.color.text.primary}
        />
      ) : null}
      <Text
        role="button"
        style={[
          styles.controlLabel,
          { color: primary ? t.color.text.inverse : t.color.text.primary },
        ]}
      >
        {label}
      </Text>
    </MotionPressable>
  );
}

/** A small meter of actual capture intensity. No generated activity after capture. */
function CaptureMeter({
  level,
  bands,
  spectrum,
  label,
}: Pick<VoiceComposerProps, "bands" | "spectrum"> & {
  level: number;
  label: string;
}) {
  const reduced = useReducedMotion();
  const strength = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  return (
    <View
      testID="voice-waveform"
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={styles.wave}
    >
      {Array.from({ length: 24 }, (_, i) => {
        const sample = spectrum?.[i] ?? bands?.[Math.min(2, Math.floor(i / 8))];
        const amplitude = reduced
          ? 0
          : sample !== undefined && Number.isFinite(sample)
            ? Math.min(1, Math.max(0, sample))
            : strength * (0.35 + 0.65 * Math.sin(((i + 1) / 25) * Math.PI));
        return (
          <View
            key={i}
            style={[
              styles.waveBar,
              {
                height: 3 + amplitude * 25,
                backgroundColor: t.color.action.primary,
                opacity: reduced ? 0.6 : 0.35 + amplitude * 0.65,
              },
            ]}
          />
        );
      })}
    </View>
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
  petLevel,
  elapsedSeconds,
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
  const inputFont = useCompanionTypography(t.typography.body);
  const words = copy[language];
  const recording = stage === "recording";
  const review = stage === "review";
  const pending = [
    "starting",
    "stopping",
    "transcribing",
    "cancelling",
  ].includes(stage);
  // Stories and independent consumers may provide only the numerical meter.
  const [localLevel] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!petLevel) localLevel.setValue(recording ? level : 0);
  }, [petLevel, localLevel, recording, level]);
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
  const primaryLabel = tr(
    recording
      ? "voice_stop"
      : stage === "recorded"
        ? "voice_upload"
        : "voice_start",
  );
  const seconds = Math.max(0, Math.floor(elapsedSeconds ?? 0));
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
        style={[ui.composerFrame, styles.tray, review && styles.review]}
      >
        {review ? (
          <>
            <Text role="sheetTitle" accessibilityRole="header">
              {tr("voice_review")}
            </Text>
            {reviewReasons.length ? (
              <Text role="caption" tone="secondary">
                {tr(
                  reviewReasons.includes("limit")
                    ? "voice_limit_review"
                    : "voice_uncertain_review_short",
                )}
              </Text>
            ) : null}
            <TextInput
              accessibilityLabel={tr("voice_transcript")}
              value={text}
              onChangeText={onEdit}
              editable={!blocked}
              multiline
              maxLength={4000}
              scrollEnabled
              placeholderTextColor={t.color.text.secondary}
              style={[styles.input, inputFont]}
            />
            <View style={styles.actions}>
              <Control
                label={tr("cancel")}
                accessibilityLabel={tr("voice_discard")}
                onPress={onCancel}
              />
              <Control
                label={tr("voice_send")}
                primary
                disabled={blocked || !text.trim()}
                onPress={onSend}
              />
            </View>
          </>
        ) : (
          <>
            <View
              style={styles.grabber}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
            <View style={styles.pet}>
              <PetView
                testID="voice-pet"
                size={140}
                background={t.color.surfaceRaised}
                state={
                  recording ? "listening" : pending ? "working" : "resting"
                }
                level={petLevel ?? localLevel}
                label={recording ? words.listening : tr(status[stage])}
              />
            </View>
            <Text
              role="sheetTitle"
              accessibilityLiveRegion="polite"
              style={styles.center}
            >
              {recording ? words.listening : tr(status[stage])}
            </Text>
            {recording ? (
              <>
                {elapsedSeconds !== undefined ? (
                  <Text role="meta" tone="secondary" style={styles.timer}>
                    {Math.floor(seconds / 60)}:
                    {String(seconds % 60).padStart(2, "0")}
                  </Text>
                ) : null}
                <CaptureMeter
                  level={level}
                  bands={bands}
                  spectrum={spectrum}
                  label={tr("voice_recording_short")}
                />
                <Text role="caption" tone="secondary" style={styles.center}>
                  {words.silence}
                </Text>
              </>
            ) : null}
            <View style={styles.actions}>
              <Control
                label={tr("cancel")}
                accessibilityLabel={tr("voice_discard")}
                onPress={onCancel}
              />
              {recording || stage === "idle" || stage === "recorded" ? (
                <Control
                  label={primaryLabel}
                  icon={
                    recording
                      ? "check"
                      : stage === "recorded"
                        ? "refresh"
                        : "mic"
                  }
                  primary
                  disabled={blocked}
                  onPress={
                    recording
                      ? onStop
                      : stage === "recorded"
                        ? onUpload
                        : onStart
                  }
                />
              ) : null}
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tray: {
    padding: 16,
    paddingTop: 8,
    gap: 6,
    borderRadius: 24,
    backgroundColor: t.color.surfaceRaised,
  },
  review: { paddingTop: 16, gap: 12 },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: t.color.text.disabled,
    alignSelf: "center",
    opacity: 0.5,
  },
  pet: { alignItems: "center", marginTop: -2, marginBottom: -8 },
  center: { textAlign: "center" },
  timer: { textAlign: "center", fontVariant: ["tabular-nums"] },
  actions: { flexDirection: "row", gap: 10, marginTop: 4 },
  control: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: 14,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  controlLabel: { flexShrink: 1, textAlign: "center" },
  wave: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  waveBar: { width: 3, borderRadius: 2 },
  toast: {
    marginBottom: 10,
    padding: 12,
    borderRadius: t.radius.control,
    backgroundColor: t.color.action.dangerSoft,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  input: {
    minHeight: 80,
    maxHeight: 120,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: t.color.border,
    borderRadius: 14,
    textAlignVertical: "top",
    color: t.color.text.primary,
    backgroundColor: t.color.background,
    ...t.typography.body,
    ...(Platform.OS === "web"
      ? { outlineStyle: "solid", outlineWidth: 0 }
      : {}),
  },
});
