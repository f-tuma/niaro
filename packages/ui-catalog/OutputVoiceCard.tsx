import React from "react";
import type { Language } from "../protocol";
import type {
  OutputVoiceChoice,
  OutputVoiceSnapshot,
} from "../protocol/output-voice";
import { translate, type TranslationKey } from "../i18n";
import { Group, ListBlock, ListRow, Text } from "../ui";

/** Presentation only. The settings surface owns requests and the sheet. */
export function OutputVoiceCard({
  language,
  snapshot,
  pending = false,
  loading = false,
  disabled = false,
  issue,
  options = false,
  onOpen,
  onChoose,
  onReset,
  onRetry,
  onRefresh,
}: {
  language: Language;
  snapshot?: OutputVoiceSnapshot | null;
  /** Active mutation waiting; passive reads have their own loading state. */
  pending?: boolean;
  loading?: boolean;
  disabled?: boolean;
  issue?: TranslationKey;
  options?: boolean;
  onOpen?: () => void;
  onChoose?: (choice: OutputVoiceChoice) => void;
  onReset?: () => void;
  onRetry?: () => void;
  onRefresh?: () => void;
}) {
  const tr = translate(language);
  if (snapshot === null) return null;
  const defaultLabel = `${tr("outputVoiceDefault")}${snapshot?.serverDefault ? ` (${snapshot.serverDefault.label})` : ""}`;
  const label =
    snapshot?.effective.choice.kind === "catalogue"
      ? snapshot.effective.label
      : defaultLabel;
  const fallback = snapshot?.effective.reason === "saved-choice-unavailable";
  const clearable =
    snapshot &&
    ((snapshot.saved?.choice.kind === "catalogue" &&
      snapshot.effective.reason !== "selected") ||
      (!snapshot.saved &&
        snapshot.revision > 0 &&
        (fallback || snapshot.effective.reason === "speech-unavailable")));
  const detail = !snapshot
    ? issue
      ? undefined
      : tr("outputVoiceLoading")
    : snapshot.availability === "speech-unavailable"
      ? tr("outputVoiceUnavailable")
      : fallback
        ? tr("outputVoiceFallback")
        : snapshot.availability === "server-default-only"
          ? tr("outputVoiceDefaultOnly")
          : undefined;
  const canChoose = snapshot?.availability === "selectable";
  const inactive = pending || loading || disabled;
  const status = loading
    ? snapshot
      ? "outputVoiceLoading"
      : undefined
    : pending
      ? "outputVoiceSaving"
      : issue;
  const content = (
    <>
      {options && snapshot && canChoose ? (
        <>
          <ListRow
            label={defaultLabel}
            selected={snapshot.effective.choice.kind === "server-default"}
            disabled={inactive}
            chevron={false}
            onPress={() => onChoose?.({ kind: "server-default" })}
          />
          {snapshot.options.map((option) => (
            <ListRow
              key={option.optionId}
              label={option.label}
              selected={
                snapshot.effective.choice.kind === "catalogue" &&
                snapshot.effective.choice.optionId === option.optionId
              }
              disabled={inactive}
              chevron={false}
              onPress={() =>
                onChoose?.({ kind: "catalogue", optionId: option.optionId })
              }
            />
          ))}
        </>
      ) : (
        <ListRow
          icon="speaker"
          label={tr("outputVoice")}
          description={snapshot ? label : detail}
          accessibilityLabel={[
            tr("outputVoice"),
            snapshot ? label : undefined,
            detail,
          ]
            .filter(Boolean)
            .join(", ")}
          onPress={canChoose ? onOpen : undefined}
          disabled={inactive}
        >
          {snapshot && detail ? (
            <Text role="meta" tone="secondary">
              {detail}
            </Text>
          ) : null}
        </ListRow>
      )}
      {options && detail && canChoose ? (
        <ListBlock>
          <Text role="meta" tone="secondary">
            {detail}
          </Text>
        </ListBlock>
      ) : null}
      {clearable ? (
        <ListRow
          label={tr("outputVoiceReset")}
          onPress={onReset}
          disabled={inactive}
          chevron={false}
        />
      ) : null}
      {status ? (
        <ListBlock>
          <Text
            role="meta"
            accessibilityRole={loading ? undefined : "alert"}
            accessibilityLiveRegion={loading ? "polite" : undefined}
            accessibilityState={{ busy: loading || pending }}
            tone="secondary"
          >
            {tr(status)}
          </Text>
        </ListBlock>
      ) : null}
      {onRetry ? (
        <ListRow
          label={tr("outputVoiceRetry")}
          onPress={onRetry}
          disabled={inactive}
          chevron={false}
        />
      ) : null}
      {onRefresh ? (
        <ListRow
          label={tr("outputVoiceRefresh")}
          onPress={onRefresh}
          disabled={inactive}
          chevron={false}
        />
      ) : null}
    </>
  );
  return options ? <Group>{content}</Group> : content;
}
