import React from "react";
import { AccessibilityInfo, View } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import {
  MotionProvider,
  MotionPressable,
  useReducedMotion,
} from "../packages/ui/motion";
import { Disclosure, Text } from "../packages/ui";
import { DetailSheet } from "../apps/mobile/ScreenChrome";

const motionInfo = AccessibilityInfo as {
  addEventListener(
    name: "reduceMotionChanged",
    listener: (value: boolean) => void,
  ): { remove(): void };
};
function Preference() {
  return <Text>{useReducedMotion() ? "still" : "animated"}</Text>;
}
afterEach(() => jest.restoreAllMocks());
test("one shared motion preference follows changes and removes its listener", async () => {
  const remove = jest.fn();
  let change: ((value: boolean) => void) | undefined;
  jest
    .spyOn(motionInfo, "addEventListener")
    .mockImplementation((_name, listener) => {
      change = listener as (v: boolean) => void;
      return { remove };
    });
  jest
    .spyOn(AccessibilityInfo, "isReduceMotionEnabled")
    .mockResolvedValue(false);
  const { unmount } = render(
    <MotionProvider>
      <Preference />
    </MotionProvider>,
  );
  expect(screen.getByText("still")).toBeTruthy();
  await act(async () => {});
  expect(screen.getByText("animated")).toBeTruthy();
  act(() => change?.(true));
  expect(screen.getByText("still")).toBeTruthy();
  unmount();
  expect(remove).toHaveBeenCalledTimes(1);
});
test("a late preference query cannot overwrite a newer reduce-motion event", async () => {
  let resolve!: (value: boolean) => void;
  let change: ((value: boolean) => void) | undefined;
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  jest
    .spyOn(motionInfo, "addEventListener")
    .mockImplementation((_name, listener) => {
      change = listener as (v: boolean) => void;
      return { remove: jest.fn() };
    });
  render(
    <MotionProvider>
      <Preference />
    </MotionProvider>,
  );
  act(() => change?.(true));
  await act(async () => resolve(false));
  expect(screen.getByText("still")).toBeTruthy();
});
test("reduced motion sheet closes once immediately even on repeated close presses", () => {
  const close = jest.fn();
  render(
    <DetailSheet title="Details" language="en" onClose={close}>
      <Text>Content</Text>
    </DetailSheet>,
  );
  fireEvent.press(screen.getByRole("button", { name: "Close" }));
  fireEvent.press(screen.getByRole("button", { name: "Close" }));
  expect(close).toHaveBeenCalledTimes(1);
});
test("press feedback does not execute an action; disabled presses remain inert", () => {
  const onPress = jest.fn();
  const { rerender } = render(
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel="Action"
      onPress={onPress}
    >
      <View />
    </MotionPressable>,
  );
  fireEvent(screen.getByRole("button"), "pressIn", {});
  expect(onPress).not.toHaveBeenCalled();
  fireEvent(screen.getByRole("button"), "pressOut", {});
  expect(onPress).not.toHaveBeenCalled();
  rerender(
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel="Action"
      disabled
      onPress={onPress}
    >
      <View />
    </MotionPressable>,
  );
  fireEvent.press(screen.getByRole("button"));
  expect(onPress).not.toHaveBeenCalled();
});
test("optional detail is revealed by a labeled control with correct expanded state", () => {
  render(
    <Disclosure label="More information">
      <Text>Additional context</Text>
    </Disclosure>,
  );
  expect(screen.queryByText("Additional context")).toBeNull();
  const control = screen.getByRole("button", { name: "More information" });
  expect(control.props.accessibilityState.expanded).toBe(false);
  fireEvent.press(control);
  expect(screen.getByText("Additional context")).toBeTruthy();
  expect(control.props.accessibilityState.expanded).toBe(true);
});
