import { renderHook } from "@testing-library/react-native";
import { useFonts } from "expo-font";
import {
  companionFontFamily,
  useCompanionFonts,
} from "../apps/mobile/CompanionFonts";

// Expo's Jest runtime cannot load native font files. Control only that boundary;
// keep the app's failure/readiness and platform-fallback decisions real.
jest.mock("expo-font", () => ({ useFonts: jest.fn() }));
const load = jest.mocked(useFonts);

test("bundled font loading gates readiness, but a failed load releases the app with system fonts", () => {
  load.mockReturnValue([false, null]);
  const { result, rerender } = renderHook(() => useCompanionFonts());
  expect(result.current.ready).toBe(false);
  load.mockReturnValue([false, new Error("TEST font unavailable")]);
  rerender({});
  expect(result.current.ready).toBe(true);
  expect(companionFontFamily(600, result.current.loaded)).toBeUndefined();
});

test("loaded static families retain the selected visual weight on every platform", () => {
  load.mockReturnValue([true, null]);
  const { result } = renderHook(() => useCompanionFonts());
  expect(result.current.ready).toBe(true);
  expect(companionFontFamily(400, result.current.loaded)).toBe("NiaroRegular");
  expect(companionFontFamily(500, result.current.loaded)).toBe("NiaroMedium");
  expect(companionFontFamily(600, result.current.loaded)).toBe("NiaroSemibold");
  expect(companionFontFamily(700, result.current.loaded)).toBe("NiaroBold");
});
