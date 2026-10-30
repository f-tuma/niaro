import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Camera from "lucide-react-native/icons/camera";
import Images from "lucide-react-native/icons/images";
import File from "lucide-react-native/icons/file-text";
import CircleCheck from "lucide-react-native/icons/circle-check";
import { Text } from "../ui";
import { tokens as t } from "../design-tokens";
import {
  attachmentChoiceOrder,
  attachmentCopy,
  type AttachmentChoices,
  type AttachmentLanguage,
} from "./attachment-presentation";

const glyphs = {
  camera: Camera,
  photos: Images,
  file: File,
  task: CircleCheck,
};
/** Content for the existing DetailSheet. Missing capabilities stay absent; no picker or permission execution. */
export function AttachmentPicker({
  choices,
  language,
}: {
  choices: AttachmentChoices;
  language: AttachmentLanguage;
}) {
  const copy = attachmentCopy(language);
  return (
    <View style={styles.choices}>
      {attachmentChoiceOrder.map((id) => {
        const action = choices[id];
        if (!action) return null;
        const Glyph = glyphs[id];
        return (
          <Pressable
            key={id}
            accessibilityRole="button"
            accessibilityLabel={copy[id]}
            accessibilityState={{ disabled: !!action.disabled }}
            disabled={action.disabled}
            onPress={action.onPress}
            style={({ pressed }) => [
              styles.choice,
              pressed && styles.pressed,
              action.disabled && styles.disabled,
            ]}
          >
            <Glyph size={22} color={t.color.text.secondary} />
            <Text style={styles.label}>{copy[id]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
const styles = StyleSheet.create({
  choices: { gap: 4 },
  choice: {
    minHeight: 52,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 12,
  },
  label: { flex: 1, minWidth: 0 },
  pressed: { backgroundColor: t.color.pressed },
  disabled: { opacity: 0.45 },
});
