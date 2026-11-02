import React from "react";
import { render, screen } from "@testing-library/react-native";
import { Home } from "../apps/mobile/ScreenChrome";
import type { PetViewProps } from "../packages/ui/PetView";

const pets: { mounts: number; props: PetViewProps[] } = {
  mounts: 0,
  props: [],
};
jest.mock("../packages/ui/PetView", () => {
  const React = jest.requireActual("react");
  const { View } = jest.requireActual("react-native");
  return {
    PetView: (props: PetViewProps) => {
      React.useEffect(() => {
        pets.mounts++;
      }, []);
      pets.props.push(props);
      return React.createElement(View, { testID: props.testID });
    },
  };
});

const home = (compact: boolean) => (
  <Home
    language="en"
    connected
    busy={false}
    onMeeting={() => {}}
    onTasks={() => {}}
    onConnect={() => {}}
    compact={compact}
  />
);

test("the keyboard shrinks the one Home pet instead of building a second one", () => {
  const { rerender } = render(home(false));
  expect(pets.mounts).toBe(1);
  expect(pets.props.at(-1)).toMatchObject({
    size: 220,
    drawingSize: 220,
    motionKey: "home",
    interactive: true,
  });
  rerender(home(true));
  expect(screen.getByTestId("home-pet-compact")).toBeTruthy();
  expect(screen.queryByTestId("home-pet-stage")).toBeNull();
  expect(pets.props.at(-1)).toMatchObject({
    size: 140,
    drawingSize: 220,
    motionKey: "home",
    interactive: false,
  });
  rerender(home(false));
  expect(screen.getByTestId("home-pet-stage")).toBeTruthy();
  expect(pets.props.at(-1)).toMatchObject({ size: 220, interactive: true });
  expect(pets.mounts).toBe(1);
});
