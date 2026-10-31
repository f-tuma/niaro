import { petCopy } from "./pet-profile-copy";
import React from "react";
import { View } from "react-native";
import type { Language } from "../../packages/protocol";
import { translate } from "../../packages/i18n";
import { tokens as t } from "../../packages/design-tokens";
import { Group, IconTile, ListRow, Text } from "../../packages/ui";

/** Entry points to real mobile capabilities, without a second data store. */
export function CompanionLibrary({
  language,
  connected,
  onMeetings,
  onHistory,
  onProcesses,
  onSettings,
  onPet,
}: {
  language: Language;
  connected: boolean;
  onMeetings: () => void;
  onHistory: () => void;
  onProcesses: () => void;
  onSettings: () => void;
  onPet?: () => void;
}) {
  const tr = translate(language);
  return (
    <View testID="companion-library" style={{ gap: t.spacing.section }}>
      <Group>
        {onPet && (
          <ListRow
            label={petCopy(language).title}
            leading={<IconTile icon="paw" size={38} />}
            onPress={onPet}
            disabled={!connected}
          />
        )}
        <ListRow
          label={tr("meetings")}
          leading={<IconTile icon="calendar" size={38} />}
          onPress={onMeetings}
        />
        <ListRow
          label={tr("chatHistory")}
          leading={<IconTile icon="history" size={38} />}
          onPress={onHistory}
          disabled={!connected}
        />
        <ListRow
          label={tr("processesTitle")}
          leading={<IconTile icon="bolt" size={38} />}
          onPress={onProcesses}
          disabled={!connected}
        />
      </Group>
      <Group>
        <ListRow
          label={tr("settingsTitle")}
          icon="settings"
          onPress={onSettings}
        />
      </Group>
      {!connected ? (
        <Text
          role="caption"
          tone="secondary"
          style={{ paddingHorizontal: t.spacing.sm }}
        >
          {tr("connectFirst")}
        </Text>
      ) : null}
    </View>
  );
}
