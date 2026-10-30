import React from "react";
import { AppState } from "react-native";
import { act, render, screen } from "@testing-library/react-native";
import { PetView } from "../packages/ui/PetView";
import { PetFallback } from "../packages/ui/PetFallback";
import { createPetShader } from "../packages/ui/pet-shader";
import { petFrame, type PetState } from "../packages/ui/pet-motion";
import { supportedGLView } from "../packages/ui/gl-surface";
import { useReducedMotion } from "../packages/ui/motion";

jest.mock("../packages/ui/pet-shader", () => ({
  createPetShader: jest.fn(() => ({ draw: jest.fn(), dispose: jest.fn() })),
}));
jest.mock("../packages/ui/motion", () => ({
  useReducedMotion: jest.fn(() => false),
}));
jest.mock("../packages/ui/gl-surface", () => {
  const React = jest.requireActual("react");
  const { View } = jest.requireActual("react-native");
  return {
    supportedGLView: jest.fn(
      () =>
        function TestSurface(props: object) {
          return React.createElement(View, { ...props, testID: "pet-gl" });
        },
    ),
    GLBoundary: ({ children }: { children: React.ReactNode }) => children,
  };
});

const frames = new Map<number, FrameRequestCallback>();
let id = 0,
  now = 1000;
beforeEach(() => {
  frames.clear();
  id = 0;
  now = 1000;
  jest.mocked(useReducedMotion).mockReturnValue(false);
  jest.spyOn(global, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++id, callback);
    return id;
  });
  jest.spyOn(global, "cancelAnimationFrame").mockImplementation((key) => {
    if (key != null) frames.delete(key);
  });
});
afterEach(() => jest.restoreAllMocks());
function advance(count = 1) {
  act(() => {
    for (let i = 0; i < count; i++) {
      now += 40;
      const entry = frames.entries().next().value;
      if (!entry) return;
      frames.delete(entry[0]);
      entry[1](now);
    }
  });
}
const touch = (x: number, y: number, fingers = 1) => ({
  nativeEvent: {
    locationX: x,
    locationY: y,
    touches: Array.from({ length: fingers }, () => ({})),
  },
});
// RNTL fireEvent invokes onStartShouldSetResponder without its native event.
// Feed actual responder events instead, including the hit-test negotiation.
function start(x = 100, y = 100) {
  const pet = screen.getByTestId("niaro-pet");
  const accepted = pet.props.onStartShouldSetResponder(touch(x, y));
  if (accepted) act(() => pet.props.onResponderGrant(touch(x, y)));
  return accepted;
}
function move(x: number, y = 100, fingers = 1) {
  act(() =>
    screen.getByTestId("niaro-pet").props.onResponderMove(touch(x, y, fingers)),
  );
}
function end(cancel = false) {
  act(() =>
    screen
      .getByTestId("niaro-pet")
      .props[cancel ? "onResponderTerminate" : "onResponderRelease"](),
  );
}
function gl() {
  act(() =>
    screen
      .getByTestId("pet-gl", { includeHiddenElements: true })
      .props.onContextCreate({ endFrameEXP: jest.fn() }),
  );
  advance();
  const renderer = jest.mocked(createPetShader).mock.results.at(-1)!.value;
  return {
    renderer,
    pose: () => {
      const [motion, state, reduced] = renderer.draw.mock.calls.at(-1)!;
      return petFrame(motion, state, reduced);
    },
  };
}

test("only the visible body accepts touch; tap acknowledges and returns to the same idle clock", () => {
  const action = jest.fn();
  render(<PetView size={200} interactive onPress={action} />);
  const { pose } = gl();
  expect(start(10, 10)).toBe(false);
  const before = pose();
  expect(start()).toBe(true);
  end();
  advance(5);
  expect(action).toHaveBeenCalledTimes(1);
  expect(pose().smile).toBeGreaterThan(before.smile);
  expect(Math.abs(pose().stretch)).toBeLessThanOrEqual(0.02);
  expect(pose().time).toBeGreaterThan(before.time);
  advance(80);
  expect(pose().smile).toBeCloseTo(before.smile, 3);
});

test("repeated strokes follow direction continuously, and cancellation releases without a tap action", () => {
  const action = jest.fn();
  render(<PetView size={200} interactive onPress={action} />);
  const { pose } = gl();
  start(80, 100);
  for (let x = 85; x <= 125; x += 5) {
    move(x);
    advance(2);
  }
  expect(pose().tilt).toBeGreaterThan(0);
  expect(pose().pleased).toBeGreaterThan(0.1);
  const right = pose();
  for (let x = 120; x >= 80; x -= 5) {
    move(x);
    advance(2);
  }
  expect(pose().tilt).toBeLessThan(0);
  expect(pose().time).toBeGreaterThan(right.time);
  end(true);
  end();
  advance(80);
  expect(action).not.toHaveBeenCalled();
  expect(Math.abs(pose().tilt)).toBeLessThan(0.001);
  expect(pose().pleased).toBeLessThan(0.001);
});

test.each(["working", "listening", "speaking", "resting"] as PetState[])(
  "%s preempts a stroke and prevents new reactions",
  (state) => {
    const action = jest.fn();
    const { rerender } = render(
      <PetView size={200} interactive onPress={action} />,
    );
    const { pose } = gl();
    start();
    move(120);
    advance(4);
    rerender(<PetView size={200} interactive onPress={action} state={state} />);
    advance();
    end();
    expect(start()).toBe(false);
    expect(pose().pleased).toBe(0);
    expect(pose().tilt).toBe(0);
    expect(action).not.toHaveBeenCalled();
  },
);

test("leaving the body or adding a second finger cancels the contact", () => {
  const action = jest.fn();
  render(<PetView size={200} interactive onPress={action} />);
  const { pose } = gl();
  start();
  move(180);
  end();
  advance(80);
  expect(action).not.toHaveBeenCalled();
  expect(pose().pleased).toBeLessThan(0.001);
  start();
  move(100, 100, 2);
  end();
  advance(80);
  expect(action).not.toHaveBeenCalled();
  expect(pose().pleased).toBeLessThan(0.001);
});

test("background and unmount cancel contact and frame ownership", () => {
  let change: (state: "active" | "background") => void = () => {};
  jest.spyOn(AppState, "addEventListener").mockImplementation((_, listener) => {
    change = listener;
    return { remove: jest.fn() };
  });
  const { unmount } = render(<PetView size={200} interactive />);
  const { pose, renderer } = gl();
  start();
  move(120);
  advance(4);
  act(() => change("background"));
  expect(frames.size).toBe(0);
  act(() => change("active"));
  advance();
  expect(pose().pleased).toBe(0);
  unmount();
  expect(frames.size).toBe(0);
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
});

test("a stationary second down cancels until both fingers lift, without a tap", () => {
  const action = jest.fn();
  render(<PetView size={200} interactive onPress={action} />);
  const { pose } = gl();
  start();
  const pet = screen.getByTestId("niaro-pet");
  act(() => pet.props.onResponderStart(touch(100, 100, 1)));
  advance(3);
  act(() => pet.props.onResponderStart(touch(100, 100, 2)));
  // RN sends end for each finger, then release when the last finger lifts.
  act(() => pet.props.onResponderEnd?.(touch(100, 100, 1)));
  act(() => pet.props.onResponderEnd?.(touch(100, 100, 0)));
  act(() => pet.props.onResponderRelease(touch(100, 100, 0)));
  advance(80);
  expect(action).not.toHaveBeenCalled();
  expect(pose().pleased).toBeLessThan(0.001);
  expect(Math.abs(pose().tilt)).toBeLessThan(0.001);
  // A fresh single-finger sequence still works after cancellation.
  start();
  end();
  expect(action).toHaveBeenCalledTimes(1);
});

test("reduced motion keeps one still frame, including accessible activation", () => {
  jest.mocked(useReducedMotion).mockReturnValue(true);
  render(<PetView size={200} interactive />);
  const { pose } = gl();
  const before = pose();
  start();
  move(120);
  end();
  act(() =>
    screen
      .getByRole("button")
      .props.onAccessibilityAction({ nativeEvent: { actionName: "activate" } }),
  );
  advance();
  expect(pose()).toEqual(before);
  expect(frames.size).toBe(0);
});

test("GL fallback acknowledges accessibly, eases back and stops its temporary frame loop", () => {
  jest.mocked(supportedGLView).mockReturnValueOnce(null);
  const { UNSAFE_getByType, unmount } = render(
    <PetView size={200} interactive />,
  );
  act(() =>
    screen
      .getByRole("button")
      .props.onAccessibilityAction({ nativeEvent: { actionName: "activate" } }),
  );
  expect(UNSAFE_getByType(PetFallback).props.pleased).toBe(true);
  advance(100);
  expect(UNSAFE_getByType(PetFallback).props.pleased).toBe(false);
  expect(frames.size).toBe(0);
  unmount();
});
