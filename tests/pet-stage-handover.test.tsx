import React from "react";
import { act, render, screen } from "@testing-library/react-native";
import { PetSlot, PetStage } from "../packages/ui/PetStage";

// NIAR-277: handing the one pet to a new slot. The UI thread places the pet a frame or more after
// the new screen shows; here the test says when (`place`), so the frames in between are seen.
jest.mock("../packages/ui/pet-shader", () => ({
  PET_SHADER_SOURCE: "TEST shader",
  createPetShader: jest.fn(),
}));
jest.mock("../packages/ui/pet-snapshot-io", () => ({
  canSavePetSnapshot: () => false,
  glSettled: jest.fn(async () => {}),
  savedPetSnapshots: () => [],
  savePetSnapshot: jest.fn(),
}));
jest.mock("../packages/ui/gl-surface", () => {
  const { View } = jest.requireActual("react-native");
  return {
    supportedGLView: () => View,
    GLBoundary: ({ children }: { children: React.ReactNode }) => children,
  };
});
const follower: {
  props?: {
    slot: number | null;
    shown: boolean;
    revealed: boolean;
    onPlaced: (slot: number) => void;
  };
} = {};
jest.mock("../packages/ui/pet-stage-follow.web", () => {
  const React = jest.requireActual("react");
  const { View } = jest.requireActual("react-native");
  return {
    useFollowRef: () => React.useRef(null),
    FollowView: View,
    attachFollow: () => {},
    Follower: (
      props: typeof follower.props & { children: React.ReactNode },
    ) => {
      follower.props = props;
      return React.createElement(View, { testID: "pet-stage" }, props.children);
    },
  };
});
/** The UI thread has put the pet over the newest slot. */
const place = () => act(() => follower.props!.onPlaced(follower.props!.slot!));
const stillIn = (slot: string) =>
  screen
    .getByTestId(slot)
    .findAll((node) => node.props.testID === "pet-slot-still", { deep: true })
    .length > 0;

function App({ sheet, visible = true }: { sheet: boolean; visible?: boolean }) {
  return (
    <PetStage enabled look={null}>
      {sheet ? null : (
        <PetSlot testID="home-pet" size={220} visible={visible} />
      )}
      {sheet ? (
        <PetSlot
          testID="voice-pet"
          size={140}
          background="#222"
          state="listening"
        />
      ) : null}
    </PetStage>
  );
}

test("a sheet's slot shows the pet itself until the drawn pet stands over it; the drawn pet is never seen meanwhile", () => {
  const { rerender } = render(<App sheet={false} />);
  // Home before the pet is placed: its own still, the drawn pet out of sight.
  expect(stillIn("home-pet")).toBe(true);
  expect(follower.props!.revealed).toBe(false);
  place();
  expect(stillIn("home-pet")).toBe(false);
  expect(follower.props!.revealed).toBe(true);
  // The sheet opens: in the same commit the drawn pet hides (it still stands over Home's place,
  // on the sheet's card) and the sheet's slot shows the still, so it is never empty.
  rerender(<App sheet />);
  expect(follower.props!.revealed).toBe(false);
  expect(stillIn("voice-pet")).toBe(true);
  // A report for the slot that is gone does not show the pet.
  act(() => follower.props!.onPlaced(follower.props!.slot! - 1));
  expect(follower.props!.revealed).toBe(false);
  place();
  expect(follower.props!.revealed).toBe(true);
  expect(stillIn("voice-pet")).toBe(false);
  // And back: Home's new slot gets the same hand-over.
  rerender(<App sheet={false} />);
  expect(follower.props!.revealed).toBe(false);
  expect(stillIn("home-pet")).toBe(true);
  place();
  expect(stillIn("home-pet")).toBe(false);
});

test("a slot under a sheet keeps its pet, only paused, so it is not emptied before the sheet covers it", () => {
  const { rerender } = render(<App sheet={false} />);
  place();
  rerender(<App sheet={false} visible={false} />);
  expect(follower.props).toMatchObject({ shown: true, revealed: true });
  const pet = screen
    .getByTestId("pet-stage")
    .findAll((node) => node.props.drawingSize !== undefined)[0]!;
  expect(pet.props.visible).toBe(false);
  expect(stillIn("home-pet")).toBe(false);
});
