import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Camera from "lucide-react-native/icons/camera";
import Images from "lucide-react-native/icons/images";
import File from "lucide-react-native/icons/file-text";
import BookOpen from "lucide-react-native/icons/book-open";
import { translate } from "../i18n";
import CircleCheck from "lucide-react-native/icons/circle-check";
import { Text } from "../ui";
import { tokens as t } from "../design-tokens";
import {
  attachmentChoiceOrder,
  attachmentCopy,
  type AttachmentChoices,
  type AttachmentAction,
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
  references,
}: {
  choices: AttachmentChoices;
  language: AttachmentLanguage;
  references?: AttachmentAction;
}) {
  const copy = attachmentCopy(language);
  return (
    <View style={styles.choices}>
      {[
        ...attachmentChoiceOrder.map((id) => ({
          id,
          action: choices[id],
          label: copy[id],
          Glyph: glyphs[id],
        })),
        ...(references
          ? [
              {
                id: "references",
                action: references,
                label: translate(language)("composerReferences"),
                Glyph: BookOpen,
              },
            ]
          : []),
      ].map(({ id, action, label, Glyph }) => {
        if (!action) return null;
        return (
          <Pressable
            key={id}
            accessibilityRole="button"
            accessibilityLabel={label}
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
            <Text style={styles.label}>{label}</Text>
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
