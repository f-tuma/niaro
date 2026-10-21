import React from "react";
import { Linking, StyleSheet, View } from "react-native";
import type { Language } from "../protocol";
import { displayLink } from "../protocol/display-link";
import { tokens as t } from "../design-tokens";
import { translate } from "../i18n";
import { Icon, Row, Text, type IconName } from "../ui";
import { MotionPressable } from "../ui/motion";

export function CardDataField({
  label,
  value,
  icon,
  language,
  disabled = false,
}: {
  label: string;
  value: string;
  icon?: IconName;
  language: Language;
  disabled?: boolean;
}) {
  const tr = translate(language);
  const link = displayLink(value, icon === "phone" ? "phone" : undefined);
  const content = (
    <Row style={styles.fieldRow}>
      {icon ? (
        <View style={styles.icon}>
          <Icon
            name={icon}
            size={18}
            color={link ? t.color.action.primary : t.color.text.secondary}
          />
        </View>
      ) : null}
      <View style={styles.content}>
        <Text role="meta" tone="secondary">
          {label}
        </Text>
        <Text
          selectable={!link}
          style={[styles.value, link ? styles.linkValue : undefined]}
        >
          {value}
        </Text>
      </View>
    </Row>
  );
  if (!link) return content;
  const action = tr(
    link.kind === "phone"
      ? "contactCall"
      : link.kind === "email"
        ? "contactWrite"
        : "contactOpen",
  ).replace("{value}", value);
  return (
    <MotionPressable
      accessibilityRole="link"
      accessibilityLabel={action}
      accessibilityState={{ disabled }}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={() => {
        if (!disabled) void Linking.openURL(link.href).catch(() => {});
      }}
      style={styles.linkField}
    >
      {content}
    </MotionPressable>
  );
}

const styles = StyleSheet.create({
  fieldRow: { alignItems: "flex-start", gap: t.spacing.md },
  icon: { width: 32, alignItems: "center", paddingTop: 1 },
  content: { flex: 1, minWidth: 0, gap: 1 },
  value: { minWidth: 0, flexShrink: 1 },
  linkField: { minHeight: 44, justifyContent: "center" },
  linkValue: { color: t.color.action.primary, fontWeight: "500" },
});
