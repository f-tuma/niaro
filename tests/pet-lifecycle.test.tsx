import React from "react";
import { AppState } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { PetView } from "../packages/ui/PetView";
import { createPetShader } from "../packages/ui/pet-shader";
import { useReducedMotion } from "../packages/ui/motion";

jest.mock("../packages/ui/pet-shader", () => ({
  createPetShader: jest.fn(() => ({ draw: jest.fn(), dispose: jest.fn() })),
}));
jest.mock("../packages/ui/motion", () => ({
  useReducedMotion: jest.fn(() => true),
}));
jest.mock("../packages/ui/gl-surface", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require("react-native");
  return {
    supportedGLView: () => (props: object) =>
      React.createElement(View, { ...props, testID: "pet-gl" }),
    GLBoundary: ({ children }: { children: React.ReactNode }) => children,
  };
});

const callbacks = new Map<number, FrameRequestCallback>();
let next = 0;
beforeEach(() => {
  callbacks.clear();
  next = 0;
  jest.spyOn(global, "requestAnimationFrame").mockImplementation((callback) => {
    callbacks.set(++next, callback);
    return next;
  });
  jest.spyOn(global, "cancelAnimationFrame").mockImplementation((id) => {
    if (id != null) callbacks.delete(id);
  });
});
afterEach(() => {
  jest.restoreAllMocks();
});
const frame = (now: number) =>
  act(() => {
    const entry = callbacks.entries().next().value;
    if (!entry) throw Error("No scheduled frame");
    callbacks.delete(entry[0]);
    entry[1](now);
  });

test("reduced motion draws once and releases its context resources on unmount", () => {
  jest.mocked(useReducedMotion).mockReturnValue(true);
  const { unmount } = render(<PetView />);
  fireEvent(
    screen.getByTestId("pet-gl", { includeHiddenElements: true }),
    "contextCreate",
    {
      endFrameEXP: jest.fn(),
    },
  );
  const shader = jest.mocked(createPetShader).mock.results.at(-1)!.value;
  frame(1000);
  expect(shader.draw).toHaveBeenCalledTimes(1);
  expect(callbacks.size).toBe(0);
  unmount();
  expect(shader.dispose).toHaveBeenCalledTimes(1);
});

test("backgrounding cancels animation, resuming restarts, and frames are capped at 30fps", () => {
  jest.mocked(useReducedMotion).mockReturnValue(false);
  let change: (next: "active" | "background") => void = () => {};
  const remove = jest.fn();
  jest.spyOn(AppState, "addEventListener").mockImplementation((_, callback) => {
    change = callback;
    return { remove };
  });
  const { unmount } = render(<PetView />);
  fireEvent(
    screen.getByTestId("pet-gl", { includeHiddenElements: true }),
    "contextCreate",
    {
      endFrameEXP: jest.fn(),
    },
  );
  const shader = jest.mocked(createPetShader).mock.results.at(-1)!.value;
  frame(1000);
  frame(1016);
  expect(shader.draw).toHaveBeenCalledTimes(1);
  frame(1034);
  expect(shader.draw).toHaveBeenCalledTimes(2);
  act(() => change("background"));
  expect(callbacks.size).toBe(0);
  act(() => change("active"));
  frame(3000);
  expect(shader.draw).toHaveBeenCalledTimes(3);
  unmount();
  expect(remove).toHaveBeenCalledTimes(1);
  expect(callbacks.size).toBe(0);
  expect(shader.dispose).toHaveBeenCalledTimes(1);
});
