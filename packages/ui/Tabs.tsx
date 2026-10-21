import React, { useState } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { tokens as t } from "../design-tokens";
import { Text } from "./index";
import { MotionPressable, useMotionTarget } from "./motion";

export type TabOption<T extends string> = {
  id: T;
  label: string;
  /** Work waiting behind this tab; shown only when positive. */
  count?: number;
};
/** Equal-width tabs over one view; the indicator slides, content never animates layout. */
export function Tabs<T extends string>({
  options,
  value,
  onChange,
  testID,
  indicatorTestID,
}: {
  options: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  testID?: string;
  indicatorTestID?: string;
}) {
  const [width, setWidth] = useState(0);
  const cell = Math.max(0, width - 6) / options.length;
  const index = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  );
  const position = useMotionTarget(index * cell);
  return (
    <View
      testID={testID}
      style={styles.track}
      accessibilityRole="tablist"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {width > 0 ? (
        <Animated.View
          testID={indicatorTestID}
          style={[
            styles.indicator,
            { width: cell, transform: [{ translateX: position }] },
          ]}
        />
      ) : null}
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <MotionPressable
            key={option.id}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityValue={
              option.count ? { text: String(option.count) } : undefined
            }
            accessibilityState={{ selected }}
            aria-selected={selected}
            onPress={() => onChange(option.id)}
            style={styles.tab}
          >
            <Text
              role="caption"
              tone={selected ? "primary" : "secondary"}
              numberOfLines={1}
              style={[
                { flexShrink: 1, textAlign: "center" },
                selected && { fontWeight: "600" },
              ]}
            >
              {option.label}
            </Text>
            {option.count ? (
              <View style={styles.count}>
                <Text
                  role="caption"
                  tone="inverse"
                  style={{ fontWeight: "600", fontSize: 12, lineHeight: 16 }}
                >
                  {option.count}
                </Text>
              </View>
            ) : null}
          </MotionPressable>
        );
      })}
    </View>
  );
}
const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    padding: 3,
    borderRadius: t.radius.control,
    backgroundColor: t.color.fill,
  },
  indicator: {
    pointerEvents: "none",
    position: "absolute",
    top: 3,
    bottom: 3,
    left: 3,
    borderRadius: 9,
    backgroundColor: t.color.surfaceRaised,
    ...t.elevation.card,
  },
  tab: {
    flex: 1,
    minHeight: 38,
    borderRadius: 10,
    paddingHorizontal: 5,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  count: {
    borderRadius: 10,
    minWidth: 20,
    minHeight: 20,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.color.action.primary,
  },
});
