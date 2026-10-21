import React, { useState } from "react";
import { Pressable, View } from "react-native";
import type { Language, NativeQuestion } from "../protocol";
import { translate } from "../i18n";
import { tokens as t } from "../design-tokens";
import { Text, Icon, Button } from "../ui";

/**
 * The answers an assistant question offers, as tappable chips. One choice
 * answers at once; several are picked first and sent together. "Other" goes
 * back to typing in the composer.
 */
export function QuestionChoices({
  question,
  language,
  disabled = false,
  onAnswer,
  onOther,
}: {
  question: NativeQuestion;
  language: Language;
  disabled?: boolean;
  onAnswer: (answer: string) => void;
  onOther?: () => void;
}) {
  const tr = translate(language);
  const [picked, setPicked] = useState<string[]>([]);
  const options = question.options ?? [];
  if (!options.length) return null;
  const multiple = !!question.multiple;
  const chip = (label: string, selected: boolean, onPress: () => void) => (
    <Pressable
      key={label}
      accessibilityRole={multiple ? "checkbox" : "button"}
      accessibilityLabel={label}
      accessibilityState={{
        disabled,
        checked: multiple ? selected : undefined,
      }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        minHeight: 36,
        maxWidth: "100%",
        paddingHorizontal: 14,
        borderRadius: t.radius.pill,
        borderWidth: 1,
        borderColor: selected ? t.color.action.primary : t.color.border,
        backgroundColor:
          selected || pressed ? t.color.accent.softBlue : t.color.surfaceRaised,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {selected ? <Icon name="check" size={14} /> : null}
      <Text role="label" numberOfLines={2} style={{ flexShrink: 1 }}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <View
      accessibilityLabel={tr("questionChoices")}
      style={{ gap: t.spacing.sm }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {options.map((option) =>
          chip(option, picked.includes(option), () =>
            multiple
              ? setPicked((current) =>
                  current.includes(option)
                    ? current.filter((value) => value !== option)
                    : [...current, option],
                )
              : onAnswer(option),
          ),
        )}
        {onOther ? chip(tr("questionOther"), false, onOther) : null}
      </View>
      {multiple ? (
        <Button
          size="small"
          label={tr("sendAnswer")}
          disabled={disabled || !picked.length}
          onPress={() =>
            onAnswer(options.filter((o) => picked.includes(o)).join(", "))
          }
        />
      ) : null}
    </View>
  );
}
