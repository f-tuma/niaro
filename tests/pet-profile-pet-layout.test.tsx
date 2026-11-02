import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { PetProfile } from "../apps/mobile/PetProfile";
import type { ClientSession } from "../packages/client-core/session";
import type { PetProfile as Profile } from "../packages/protocol/work-pet";
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
      return React.createElement(View, { testID: "TEST-pet" });
    },
  };
});

const profile: Profile = {
  profile: "work-pet/1",
  organizationId: "org",
  workspaceId: "ws",
  userId: "owner",
  revision: 0,
  settings: {
    name: "Niaro",
    colour: "#BDB3FA",
    shape: "cookie",
    animate: true,
    showInChat: true,
    jobTitle: "",
    department: "",
  },
  automaticShape: "circle",
  look: ["work", "projects", "tools", "people", "style", "rhythm"].map(
    (section) => ({ section, weight: 0, count: 0 }),
  ) as Profile["look"],
};
const session = {
  petMemory: async () => ({
    enabled: true,
    optOut: false,
    personalThings: "keep",
    version: 1,
    items: [],
    nextCursor: null,
  }),
} as unknown as ClientSession;

test("the profile pet waits for its measured box, then only scales with it", async () => {
  render(
    <PetProfile
      session={session}
      language="en"
      profile={profile}
      onSave={async () => profile}
      onRefresh={async () => {}}
      appearance={false}
      onAppearance={() => {}}
      onOpenSource={() => {}}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Work" })).toBeTruthy(),
  );
  // No pet at a guessed size before the box is laid out.
  expect(screen.queryByTestId("TEST-pet")).toBeNull();
  const box = (height: number) =>
    fireEvent(screen.getByTestId("profile-pet-bounds"), "layout", {
      nativeEvent: { layout: { y: 150, height } },
    });
  // The box grows once the page has measured the room it fills, never past the stage maximum.
  box(100);
  expect(pets.mounts).toBe(1);
  const first = pets.props.at(-1)!;
  expect(first).toMatchObject({ size: 100, motionKey: "profile" });
  const largest = first.drawingSize!;
  expect(largest).toBeGreaterThan(100);
  box(largest);
  expect(pets.mounts).toBe(1);
  expect(pets.props.at(-1)).toMatchObject({
    size: largest,
    drawingSize: largest,
  });
});
