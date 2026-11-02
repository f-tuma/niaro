import React from "react";
import { act, render, screen } from "@testing-library/react-native";
import { PetFallback } from "../packages/ui/PetFallback";
import { PetView } from "../packages/ui/PetView";
jest.mock("../packages/ui/motion", () => ({
  ...jest.requireActual("../packages/ui/motion"),
  useReducedMotion: () => false,
}));
// A GL surface that never gets its context: the renderer is still starting.
jest.mock("../packages/ui/gl-surface", () => ({
  ...jest.requireActual("../packages/ui/gl-surface"),
  supportedGLView: () => () => null,
}));

test("a starting renderer shows no still drawing, and falls back only when it stalls", () => {
  jest.useFakeTimers();
  try {
    // A look no still was kept for (the default one has a bundled still, below).
    render(<PetView label="Niaro" appearance={{ shape: "pebble" }} />);
    expect(screen.UNSAFE_queryAllByType(PetFallback)).toHaveLength(0);
    act(() => jest.advanceTimersByTime(1100));
    expect(screen.UNSAFE_queryAllByType(PetFallback)).toHaveLength(0);
    act(() => jest.advanceTimersByTime(200));
    expect(screen.UNSAFE_queryAllByType(PetFallback)).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
});

test("the default pet shows its bundled still at once while the renderer starts", () => {
  jest.useFakeTimers();
  try {
    render(<PetView label="Niaro" />);
    expect(
      screen.getByTestId("niaro-pet-still", { includeHiddenElements: true }),
    ).toBeTruthy();
    act(() => jest.advanceTimersByTime(1300));
    expect(screen.UNSAFE_queryAllByType(PetFallback)).toHaveLength(0);
  } finally {
    jest.useRealTimers();
  }
});
