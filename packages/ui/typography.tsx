import { createContext, useContext } from "react";
import { StyleSheet, type StyleProp, type TextStyle } from "react-native";

export const CompanionFontContext = createContext(false);

/** Explicit static faces keep weight rendering identical on Android and iOS. */
export function useCompanionTypography(style: StyleProp<TextStyle>): TextStyle {
  const loaded = useContext(CompanionFontContext);
  const flat = StyleSheet.flatten(style);
  if (!loaded || (flat?.fontFamily && !flat.fontFamily.startsWith("Niaro")))
    return {};
  const weight = flat?.fontWeight;
  const numeric = weight === "bold" ? 700 : Number(weight) || 400;
  return {
    fontFamily:
      numeric >= 700
        ? "NiaroBold"
        : numeric >= 600
          ? "NiaroSemibold"
          : numeric >= 500
            ? "NiaroMedium"
            : "NiaroRegular",
    fontWeight: "normal",
  };
}
