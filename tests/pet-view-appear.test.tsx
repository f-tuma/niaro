import React from "react";
import { Image } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
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

test("a look with no still shows its drawing from the first frame, never an empty box (NIAR-277)", () => {
  jest.useFakeTimers();
  try {
    // A look no still was kept for (the default one has a bundled still, below).
    render(<PetView label="Niaro" appearance={{ shape: "pebble" }} />);
    expect(screen.UNSAFE_queryAllByType(PetFallback)).toHaveLength(1);
    expect(screen.UNSAFE_queryAllByType(Image)).toHaveLength(0);
    act(() => jest.advanceTimersByTime(5000));
    expect(screen.UNSAFE_queryAllByType(PetFallback)).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
});

test("the default pet shows its bundled still at once; the drawing covers only its decoding", () => {
  jest.useFakeTimers();
  try {
    render(<PetView label="Niaro" />);
    expect(
      screen.getByTestId("niaro-pet-still", { includeHiddenElements: true }),
    ).toBeTruthy();
    const still = screen.UNSAFE_getByType(Image);
    expect(JSON.stringify(still.props.source)).toContain("pet-still.png");
    // Until the image is decoded, the drawing is under it, so no frame is empty.
    expect(screen.UNSAFE_queryAllByType(PetFallback)).toHaveLength(1);
    fireEvent(still, "load");
    expect(screen.UNSAFE_queryAllByType(PetFallback)).toHaveLength(0);
    act(() => jest.advanceTimersByTime(1300));
    expect(screen.UNSAFE_queryAllByType(PetFallback)).toHaveLength(0);
  } finally {
    jest.useRealTimers();
  }
});
