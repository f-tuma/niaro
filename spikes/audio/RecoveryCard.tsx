import React from "react";
import { Button, Surface, Text } from "../../packages/ui";
import { translate, type TranslationKey } from "../../packages/i18n";
import type { Language } from "../../packages/protocol";
import type { RecoveryCandidate } from "./journal";

const statusKeys: Record<RecoveryCandidate["status"], TranslationKey> = {
  unchecked: "audioRecoveryUnchecked",
  checking: "audioRecoveryChecking",
  ready: "audioRecoveryReady",
  unreadable: "audioRecoveryUnreadable",
  missing: "audioRecoveryMissing",
};
export function RecoveryCard({
  candidate,
  language,
  busy = false,
  onCheck,
  onRecover,
  onIgnore,
}: {
  candidate: RecoveryCandidate;
  language: Language;
  busy?: boolean;
  onCheck(): void;
  onRecover(): void;
  onIgnore(): void;
}) {
  const tr = translate(language);
  return (
    <Surface>
      <Text role="cardTitle">
        {tr(
          candidate.reason === "unfinished"
            ? "audioUnfinished"
            : "audioUnindexed",
        )}
      </Text>
      <Text accessibilityLiveRegion="polite">
        {tr(statusKeys[candidate.status])}
      </Text>
      <Text role="caption" selectable>
        {candidate.uri}
      </Text>
      <Text>
        {candidate.bytes.toLocaleString(language)} B
        {candidate.durationMillis
          ? ` · ${Math.round(candidate.durationMillis / 1000)} s`
          : ""}
      </Text>
      <Button
        label={tr("audioCheckFile")}
        disabled={busy}
        loading={candidate.status === "checking"}
        onPress={onCheck}
        variant="secondary"
      />
      {candidate.status === "ready" ? (
        <Button
          label={tr("audioKeepRecovered")}
          disabled={busy}
          onPress={onRecover}
        />
      ) : null}
      <Button
        label={tr("audioHideFile")}
        disabled={busy}
        onPress={onIgnore}
        variant="secondary"
      />
    </Surface>
  );
}
