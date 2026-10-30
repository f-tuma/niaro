import { useFonts } from "expo-font";

/**
 * Separate static families avoid variable-font and synthetic-weight differences
 * between Android, iOS and the web. Each is registered as a regular face; choose
 * its family to select the visual weight, with fontWeight: "normal" on native.
 * Metro needs static require calls so these assets ship with the application.
 */
export const companionFonts = {
  NiaroRegular: require("../../assets/fonts/NiaroRegular.ttf"),
  NiaroMedium: require("../../assets/fonts/NiaroMedium.ttf"),
  NiaroSemibold: require("../../assets/fonts/NiaroSemibold.ttf"),
  NiaroBold: require("../../assets/fonts/NiaroBold.ttf"),
} as const;

/** A font failure must never prevent chat or recording from opening. */
export function useCompanionFonts() {
  const [loaded, error] = useFonts(companionFonts);
  return { loaded, error, ready: loaded || !!error };
}

/** Omit the custom family on load failure to use the platform's own typeface. */
export function companionFontFamily(
  weight: 400 | 500 | 600 | 700,
  loaded: boolean,
) {
  if (!loaded) return undefined;
  return {
    400: "NiaroRegular",
    500: "NiaroMedium",
    600: "NiaroSemibold",
    700: "NiaroBold",
  }[weight];
}
