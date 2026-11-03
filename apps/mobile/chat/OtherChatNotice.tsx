import React from "react";
import { View } from "react-native";
import type { Language } from "../../../packages/protocol";
import { tokens as t } from "../../../packages/design-tokens";
import { Button, Text } from "../../../packages/ui";

const copy = {
  en: {
    running: "An answer is still running in another chat",
    waiting: "An unfinished request is waiting in another chat",
    open: "Open",
    stop: "Stop",
  },
  cs: {
    running: "V jiném chatu ještě běží odpověď",
    waiting: "V jiném chatu čeká nedokončený požadavek",
    open: "Otevřít",
    stop: "Zastavit",
  },
} as const;

/**
 * Another chat holds the one request the person may have at a time, so this
 * chat cannot send: say so, lead there, and stop it while it still runs.
 */
export function OtherChatNotice({
  language,
  running,
  onOpen,
  onStop,
  disabled,
}: {
  language: Language;
  running: boolean;
  onOpen: () => void;
  /** Offered only while the other chat's request runs. */
  onStop?: () => void;
  disabled: boolean;
}) {
  const c = copy[language];
  return (
    <View
      testID="other-chat-busy"
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        columnGap: t.spacing.sm,
      }}
    >
      <Text role="caption" tone="secondary">
        {running ? c.running : c.waiting}
      </Text>
      <Button variant="quiet" size="small" label={c.open} onPress={onOpen} />
      {running && onStop ? (
        <Button
          variant="quiet"
          size="small"
          label={c.stop}
          onPress={onStop}
          disabled={disabled}
        />
      ) : null}
    </View>
  );
}
