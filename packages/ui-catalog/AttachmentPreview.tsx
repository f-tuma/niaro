import React from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import RotateCw from "lucide-react-native/icons/rotate-cw";
import Camera from "lucide-react-native/icons/camera";
import { Text } from "../ui";
import { tokens as t } from "../design-tokens";
import {
  attachmentCopy,
  rasterUri,
  type AttachmentAction,
  type AttachmentPreviewProps,
} from "./attachment-presentation";

/** Transient content for the app's DetailSheet; its parent owns dismissal, safe area and image resources. */
export function AttachmentPreview({
  language,
  filename,
  raster,
  rotation,
  loading,
  failed,
  onImageError,
  rotate,
  retake,
  confirm,
}: AttachmentPreviewProps) {
  const copy = attachmentCopy(language);
  const uri = rasterUri(raster);
  const ready = !!uri && !loading && !failed;
  const control = (
    label: string,
    action: AttachmentAction,
    primary = false,
    glyph?: React.ReactNode,
  ) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={action.disabled}
      accessibilityState={{ disabled: !!action.disabled }}
      onPress={action.onPress}
      style={({ pressed }) => [
        styles.control,
        primary && styles.primary,
        pressed && styles.pressed,
        action.disabled && styles.disabled,
      ]}
    >
      {glyph}
      <Text role="label" style={styles.label}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <View style={styles.content}>
      <Text role="caption" selectable style={styles.filename}>
        {filename}
      </Text>
      <View style={styles.canvas}>
        {ready ? (
          <Image
            accessibilityLabel={filename}
            source={{ uri }}
            resizeMode="contain"
            onError={onImageError}
            style={[
              styles.image,
              { transform: [{ rotate: `${rotation}deg` }] },
            ]}
          />
        ) : (
          <Text
            role="caption"
            tone="secondary"
            accessibilityLiveRegion="polite"
            style={styles.status}
          >
            {loading ? copy.loadingPreview : copy.previewUnavailable}
          </Text>
        )}
      </View>
      <View style={styles.tools}>
        {rotate
          ? control(
              copy.rotate,
              { ...rotate, disabled: rotate.disabled || !ready },
              false,
              <RotateCw size={20} color={t.color.text.secondary} />,
            )
          : null}
        {retake
          ? control(
              copy.retake,
              retake,
              false,
              <Camera size={20} color={t.color.text.secondary} />,
            )
          : null}
      </View>
      {confirm
        ? control(
            copy.confirm,
            { ...confirm, disabled: confirm.disabled || !ready },
            true,
          )
        : null}
    </View>
  );
}
const styles = StyleSheet.create({
  content: { gap: 12, minWidth: 0 },
  filename: { flexShrink: 1 },
  canvas: {
    width: "100%",
    aspectRatio: 1,
    maxWidth: 360,
    alignSelf: "center",
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: t.color.background,
    alignItems: "center",
    justifyContent: "center",
  },
  image: { width: "100%", height: "100%" },
  status: { textAlign: "center", padding: 20 },
  tools: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  control: {
    flexGrow: 1,
    minWidth: 0,
    minHeight: 48,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    padding: 12,
    backgroundColor: t.color.fill,
  },
  primary: { backgroundColor: t.color.action.primary },
  label: { flexShrink: 1, textAlign: "center" },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.45 },
});
