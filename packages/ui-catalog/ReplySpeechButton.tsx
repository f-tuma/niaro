import React from "react";
import { ActivityIndicator, View } from "react-native";
import { MotionPressable } from "../ui/motion";
import { Icon, Text } from "../ui";
import { translate } from "../i18n";
import type { Language } from "../protocol";
import { tokens as t } from "../design-tokens";
export function ReplySpeechButton({
  language,
  phase,
  privacyBlocked = false,
  summary = false,
  disabled,
  onPress,
}: {
  language: Language;
  phase: "idle" | "loading" | "playing" | "error";
  summary?: boolean;
  privacyBlocked?: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const tr = translate(language);
  const active = phase === "loading" || phase === "playing";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 8,
      }}
    >
      {phase === "error" && (
        <Text
          accessibilityRole="alert"
          tone="secondary"
          style={{ fontSize: 12, flex: 1 }}
        >
          {tr(privacyBlocked ? "speech_privacy_unavailable" : "speech_failed")}
        </Text>
      )}
      <MotionPressable
        accessibilityRole="button"
        accessibilityLabel={tr(
          active ? "speech_stop" : summary ? "speech_summary" : "speech_play",
        )}
        accessibilityState={{ disabled, busy: phase === "loading" }}
        disabled={disabled}
        onPress={onPress}
        style={{
          minWidth: 44,
          minHeight: 44,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          opacity: disabled ? 0.4 : 1,
        }}
      >
        {phase === "loading" && (
          <ActivityIndicator size="small" color={t.color.text.secondary} />
        )}
        <Icon
          name={active ? "stop" : "speaker"}
          size={17}
          color={t.color.text.secondary}
        />
      </MotionPressable>
    </View>
  );
}
