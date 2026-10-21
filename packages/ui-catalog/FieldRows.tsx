import React from "react";
import { StyleSheet, View } from "react-native";
import { tokens as t } from "../design-tokens";
import { Chip, Text } from "../ui";
import type { DisplayField } from "./field-format";

/** Label-value rows inside a card: muted label column, value or chips beside it. */
export function FieldRows({
  fields,
  testID,
}: {
  fields: readonly DisplayField[];
  testID?: string;
}) {
  if (!fields.length) return null;
  return (
    <View testID={testID} style={styles.rows}>
      {fields.map((field, index) => (
        <View
          key={`${field.label}:${index}`}
          style={[styles.row, index > 0 && styles.separated]}
        >
          <Text role="meta" tone="secondary" style={styles.label}>
            {field.label}
          </Text>
          {field.items && field.items.every((item) => item.length <= 22) ? (
            <View
              accessible
              accessibilityLabel={`${field.label}: ${field.value}`}
              style={styles.chips}
            >
              {field.items.map((item, itemIndex) => (
                <Chip key={itemIndex} label={item} />
              ))}
            </View>
          ) : (
            <Text
              selectable
              accessibilityLabel={`${field.label}: ${field.value}`}
              style={styles.value}
            >
              {field.items ? field.items.join("\n") : field.value}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  rows: { minWidth: 0 },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: t.spacing.md,
    paddingVertical: 10,
    minWidth: 0,
  },
  separated: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.color.border,
  },
  label: { width: 80, flexShrink: 0, paddingTop: 2 },
  value: { flex: 1, minWidth: 0, fontWeight: "500" },
  chips: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
});
