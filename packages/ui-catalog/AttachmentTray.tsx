import React from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import File from "lucide-react-native/icons/file-text";
import ImageIcon from "lucide-react-native/icons/image";
import Download from "lucide-react-native/icons/download";
import { Icon, Text } from "../ui";
import { tokens as t } from "../design-tokens";
import {
  attachmentCopy,
  interpretationLabel,
  rasterUri,
  transferLabel,
  transferPercent,
  type AttachmentAction,
  type AttachmentFile,
  type AttachmentInterpretation,
  type AttachmentLanguage,
  type DraftAttachment,
  type PersistedAttachment,
} from "./attachment-presentation";

export function AttachmentControl({
  label,
  icon,
  action,
}: {
  label: string;
  icon: "close" | "refresh" | "download";
  action: AttachmentAction;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!action.disabled }}
      disabled={action.disabled}
      onPress={action.onPress}
      style={({ pressed }) => [
        styles.control,
        pressed && styles.pressed,
        action.disabled && styles.disabled,
      ]}
    >
      {icon === "download" ? (
        <Download size={18} color={t.color.text.secondary} />
      ) : (
        <Icon name={icon} size={18} color={t.color.text.secondary} />
      )}
    </Pressable>
  );
}
function FileSummary({
  file,
  status,
  problem = false,
  preview = true,
}: {
  file: AttachmentFile;
  status: string;
  problem?: boolean;
  preview?: boolean;
}) {
  const uri = rasterUri(file.thumbnail);
  const Glyph = file.kind === "image" ? ImageIcon : File;
  const content = (
    <>
      <View style={styles.thumb}>
        {uri ? (
          <Image source={{ uri }} resizeMode="cover" style={styles.image} />
        ) : (
          <Glyph size={22} color={t.color.text.secondary} />
        )}
      </View>
      <View style={styles.words}>
        <Text role="caption" numberOfLines={1} ellipsizeMode="middle">
          {file.filename}
        </Text>
        <Text role="meta" tone="secondary" style={problem && styles.problem}>
          {status}
        </Text>
      </View>
    </>
  );
  return preview && file.preview ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={file.filename}
      accessibilityHint={status}
      disabled={file.preview.disabled}
      accessibilityState={{ disabled: !!file.preview.disabled }}
      onPress={file.preview.onPress}
      style={({ pressed }) => [styles.summary, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  ) : (
    <View
      accessible
      accessibilityLabel={`${file.filename}, ${status}`}
      style={styles.summary}
    >
      {content}
    </View>
  );
}

/** One horizontal row, even for ten files; the parent retains the composer and safe area. */
export function AttachmentTray({
  files,
  language,
}: {
  files: readonly DraftAttachment[];
  language: AttachmentLanguage;
}) {
  const { width } = useWindowDimensions();
  const copy = attachmentCopy(language);
  if (!files.length) return null;
  return (
    <View style={styles.tray}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.rail}
        accessibilityRole="list"
        accessibilityLabel={copy.attachments}
      >
        {files.map((file) => {
          const percent = transferPercent(file.transfer);
          return (
            <View
              key={file.id}
              role="listitem"
              testID={`attachment-${file.id}`}
              style={[
                styles.chip,
                { width: Math.min(304, Math.max(240, width - 48)) },
              ]}
            >
              <View style={styles.row}>
                <FileSummary
                  file={file}
                  status={transferLabel(file.transfer, language)}
                  problem={
                    file.transfer.state === "failed" ||
                    file.transfer.state === "uncertain"
                  }
                />
                {file.transfer.state === "failed" && file.retry ? (
                  <AttachmentControl
                    icon="refresh"
                    label={`${copy.retry}: ${file.filename}`}
                    action={file.retry}
                  />
                ) : null}
                {file.remove ? (
                  <AttachmentControl
                    icon="close"
                    label={`${copy.remove}: ${file.filename}`}
                    action={{
                      ...file.remove,
                      disabled:
                        file.remove.disabled ||
                        file.transfer.state === "removing",
                    }}
                  />
                ) : null}
              </View>
              {file.transfer.state === "uploading" ? (
                <View
                  accessibilityRole="progressbar"
                  accessibilityLabel={`${copy.uploading}: ${file.filename}`}
                  accessibilityValue={
                    percent === undefined
                      ? { text: copy.uploading }
                      : { min: 0, max: 100, now: percent }
                  }
                  style={styles.track}
                >
                  {percent !== undefined ? (
                    <View style={[styles.progress, { width: `${percent}%` }]} />
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function PersistedAttachments({
  files,
  language,
}: {
  files: readonly PersistedAttachment[];
  language: AttachmentLanguage;
}) {
  const copy = attachmentCopy(language);
  if (!files.length) return null;
  return (
    <View style={styles.history}>
      {files.map((file) => {
        const available = file.availability === "available";
        const status = !available
          ? copy.unavailable
          : file.downloadState === "failed"
            ? copy.failedDownload
            : file.downloadState === "loading"
              ? copy.loadingDownload
              : file.detail;
        return (
          <View
            key={file.id}
            testID={`retained-${file.id}`}
            style={[styles.chip, styles.row]}
          >
            <FileSummary
              file={{
                ...file,
                thumbnail: available ? file.thumbnail : undefined,
              }}
              status={status}
              problem={!available || file.downloadState === "failed"}
              preview={available}
            />
            {available && file.download ? (
              <AttachmentControl
                icon="download"
                label={`${copy.download}: ${file.filename}`}
                action={{
                  ...file.download,
                  disabled:
                    file.download.disabled || file.downloadState === "loading",
                }}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export function AttachmentProcessing({
  value,
  language,
}: {
  value: AttachmentInterpretation;
  language: AttachmentLanguage;
}) {
  const copy = attachmentCopy(language);
  const retryable = ["failed", "unavailable", "retry_required"].includes(
    value.state,
  );
  return (
    <View style={styles.processing}>
      <Text
        role="caption"
        tone="secondary"
        accessibilityLiveRegion="polite"
        style={styles.words}
      >
        {interpretationLabel(value, language)}
      </Text>
      {retryable && value.retry ? (
        <AttachmentControl
          icon="refresh"
          label={copy.retryProcessing}
          action={value.retry}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tray: { minWidth: 0 },
  rail: { gap: 8, paddingBottom: 4 },
  chip: {
    backgroundColor: t.color.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: t.color.hairline,
    overflow: "hidden",
    minWidth: 0,
  },
  row: { flexDirection: "row", alignItems: "center", minWidth: 0 },
  summary: {
    flexDirection: "row",
    flex: 1,
    minWidth: 0,
    gap: 10,
    alignItems: "center",
    minHeight: 60,
    padding: 10,
    borderRadius: 12,
  },
  thumb: {
    width: 32,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: 6,
  },
  image: { width: "100%", height: "100%" },
  words: { flex: 1, minWidth: 0, gap: 3 },
  control: {
    minWidth: 48,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
  },
  pressed: { backgroundColor: t.color.pressed },
  disabled: { opacity: 0.45 },
  problem: { color: t.color.action.danger },
  track: { height: 3, backgroundColor: t.color.fill },
  progress: { height: 3, backgroundColor: t.color.action.link },
  history: { gap: 6, minWidth: 0 },
  processing: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 24,
  },
});
