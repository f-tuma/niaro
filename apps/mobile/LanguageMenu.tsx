import React, { useEffect, useRef, useState } from "react";
import {
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LanguageSchema, type Language } from "../../packages/protocol";
import { translate } from "../../packages/i18n";
import { tokens as t } from "../../packages/design-tokens";
import { Icon, ListRow, Text } from "../../packages/ui";

// Native names stay recognizable even when the current UI language is unfamiliar.
const names: Record<Language, string> = { en: "English", cs: "Čeština" };

export function LanguageMenu({
  language,
  onChange,
}: {
  language: Language;
  onChange: (language: Language) => void;
}) {
  const tr = translate(language);
  const anchor = useRef<View>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    const subscription = Dimensions.addEventListener("change", () =>
      setPosition(null),
    );
    return () => subscription.remove();
  }, []);
  const close = () => setPosition(null);
  const open = () => {
    anchor.current?.measureInWindow((x, y, anchorWidth, anchorHeight) => {
      const edge = t.spacing.md;
      const gap = t.spacing.xs;
      const menuWidth = Math.min(280, width - edge * 2);
      const availableBelow =
        height - insets.bottom - edge - y - anchorHeight - gap;
      const availableAbove = y - insets.top - edge - gap;
      const desiredHeight = Math.min(
        360,
        LanguageSchema.options.length * Math.max(48, 24 * fontScale + 24) + 8,
      );
      const below =
        availableBelow >= desiredHeight || availableBelow >= availableAbove;
      const maxHeight = Math.max(
        48,
        Math.min(desiredHeight, below ? availableBelow : availableAbove),
      );
      setPosition({
        left: Math.max(
          edge,
          Math.min(x + anchorWidth - menuWidth, width - menuWidth - edge),
        ),
        top: below ? y + anchorHeight + gap : y - gap - maxHeight,
        width: menuWidth,
        maxHeight,
      });
    });
  };
  return (
    <View ref={anchor} collapsable={false}>
      <ListRow
        icon="globe"
        label={tr("language")}
        value={names[language]}
        accessibilityLabel={`${tr("language")}: ${names[language]}`}
        onPress={open}
        chevron={false}
        trailing={
          <View style={{ transform: [{ rotate: "90deg" }] }}>
            <Icon name="chevron" size={18} color={t.color.text.secondary} />
          </View>
        }
      />
      {position ? (
        <Modal
          transparent
          visible
          statusBarTranslucent
          navigationBarTranslucent
          onRequestClose={close}
          supportedOrientations={["portrait", "landscape"]}
        >
          <View style={styles.overlay} onAccessibilityEscape={close}>
            <Pressable
              style={StyleSheet.absoluteFill}
              accessibilityRole="button"
              accessibilityLabel={tr("close")}
              onPress={close}
            />
            <View accessibilityViewIsModal style={[styles.menu, position]}>
              <ScrollView
                accessibilityRole="menu"
                accessibilityLabel={tr("language")}
              >
                {LanguageSchema.options.map((option) => (
                  <Pressable
                    key={option}
                    accessibilityRole="menuitem"
                    accessibilityLabel={names[option]}
                    accessibilityState={{ selected: option === language }}
                    onPress={() => {
                      close();
                      if (option !== language) onChange(option);
                    }}
                    style={({ pressed }) => [
                      styles.option,
                      {
                        backgroundColor: pressed
                          ? t.color.fillPressed
                          : "transparent",
                      },
                    ]}
                  >
                    <Text style={{ flex: 1 }}>{names[option]}</Text>
                    {option === language ? (
                      <Icon
                        name="check"
                        size={18}
                        color={t.color.action.link}
                      />
                    ) : null}
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1 },
  menu: {
    position: "absolute",
    backgroundColor: t.color.surfaceRaised,
    borderColor: t.color.border,
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 4,
    overflow: "hidden",
  },
  option: {
    minHeight: 48,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: t.spacing.md,
  },
});
