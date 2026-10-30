import React from "react";
import { act, render, screen } from "@testing-library/react-native";
import { PetView } from "../packages/ui/PetView";
jest.mock("../packages/ui/gl-surface", () => ({ supportedGLView: () => null }));

test("the no-GL companion keeps its label and only invokes the explicit action on press", () => {
  const onPress = jest.fn();
  const { rerender } = render(
    <PetView label="Talk to Niaro" onPress={onPress} />,
  );
  expect(onPress).not.toHaveBeenCalled();
  act(() =>
    screen
      .getByRole("button", { name: "Talk to Niaro" })
      .props.onAccessibilityAction({ nativeEvent: { actionName: "activate" } }),
  );
  expect(onPress).toHaveBeenCalledTimes(1);
  rerender(<PetView label="Talk to Niaro" onPress={onPress} disabled />);
  act(() =>
    screen
      .getByRole("button", { name: "Talk to Niaro" })
      .props.onAccessibilityAction({ nativeEvent: { actionName: "activate" } }),
  );
  expect(onPress).toHaveBeenCalledTimes(1);
});

test("decorative companion exposes an image and has no implied microphone action", () => {
  render(<PetView label="Niaro is preparing the answer" state="working" />);
  expect(
    screen.getByRole("image", { name: "Niaro is preparing the answer" }),
  ).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
