import React from "react";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";
import { useNativePetProfile } from "../apps/mobile/pet-profile-model";
import { useHomePetVisibility } from "../apps/mobile/home-pet-visibility";
import { CompanionLibrary } from "../apps/mobile/CompanionLibrary";

import { PetProfile } from "../apps/mobile/PetProfile";
import type { ClientSession } from "../packages/client-core/session";
import type { PetProfile as Profile } from "../packages/protocol/work-pet";
jest.mock("../packages/ui/gl-surface", () => ({ supportedGLView: () => null }));
test("Library opens the real profile without adding a root destination", () => {
  const open = jest.fn();
  render(
    <CompanionLibrary
      language="en"
      connected
      onPet={open}
      onMeetings={() => {}}
      onHistory={() => {}}
      onProcesses={() => {}}
      onSettings={() => {}}
    />,
  );
  fireEvent.press(screen.getByText("You and Niaro"));
  expect(open).toHaveBeenCalledTimes(1);
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
    animate: false,
    showInChat: true,
    jobTitle: "",
    department: "",
  },
  automaticShape: "circle",
  look: ["work", "projects", "tools", "people", "style", "rhythm"].map(
    (section) => ({ section, weight: 0 }),
  ) as Profile["look"],
};
test("native actual profile reads the selected private section and retains a rejected correction", async () => {
  const item = {
    id: "memory-1",
    revision: 1,
    content: "Synthetic preference",
    origin: "observed",
    status: "active",
    trust: "model_inference",
    source: { type: "observed", section: "work", personal: false, sources: [] },
  };
  const read = jest.fn(async () => ({
    enabled: true,
    optOut: false,
    personalThings: "keep",
    version: 1,
    items: [item],
    nextCursor: null,
  }));
  const save = jest.fn(async () => {
    throw Error("memory_context_changed");
  });
  const session = {
    petMemory: read,
    savePetMemory: save,
  } as unknown as ClientSession;
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
  await waitFor(() => expect(read).toHaveBeenCalled());
  fireEvent.press(screen.getByRole("button", { name: "Work" }));
  await waitFor(() =>
    expect(read).toHaveBeenLastCalledWith(
      expect.objectContaining({
        section: "work",
        origin: "observed",
        personal: "work",
      }),
    ),
  );
  fireEvent.press(await screen.findByText("Correct"));
  fireEvent.changeText(screen.getByLabelText("Edit"), "My retained correction");
  fireEvent.press(screen.getByText("Save changes"));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(screen.getByDisplayValue("My retained correction")).toBeTruthy();
  expect(screen.getByText(/Couldn't confirm the save/)).toBeTruthy();
});

test("profile save acknowledgement fences earlier reads and later stale revisions per session", async () => {
  let finish!: (value: Profile) => void;
  const session = {
    petProfile: jest
      .fn()
      .mockResolvedValueOnce(profile)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(profile),
    savePetProfile: jest.fn(async () => ({ ...profile, revision: 1 })),
  } as unknown as ClientSession;
  let model!: ReturnType<typeof useNativePetProfile>;
  function Probe({ owner }: { owner: ClientSession }) {
    model = useNativePetProfile(owner);
    return null;
  }
  const view = render(<Probe owner={session} />);
  await waitFor(() => expect(model.profile?.revision).toBe(0));
  let pending!: Promise<void>;
  act(() => {
    pending = model.read();
  });
  await act(async () => {
    await model.save({
      requestId: "request",
      revision: 0,
      settings: profile.settings,
    });
  });
  expect(model.profile?.revision).toBe(1);
  await act(async () => {
    finish(profile);
    await pending;
  });
  expect(model.profile?.revision).toBe(1);
  await act(async () => {
    await model.read();
  });
  expect(model.profile?.revision).toBe(1);
  const other = {
    petProfile: async () => ({ ...profile, userId: "other" }),
  } as ClientSession;
  view.rerender(<Probe owner={other} />);
  await waitFor(() => expect(model.profile?.userId).toBe("other"));
  expect(model.profile?.revision).toBe(0);
});

test("profile hero visibility follows measured bounds and section selection focuses details", async () => {
  const focus = jest
    .spyOn(AccessibilityInfo, "setAccessibilityFocus")
    .mockImplementation(() => {});
  const handle = jest
    .spyOn(
      jest.requireActual<typeof import("react-native")>("react-native"),
      "findNodeHandle",
    )
    .mockReturnValue(77);
  let visibility!: ReturnType<typeof useHomePetVisibility>;
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
  function Probe() {
    visibility = useHomePetVisibility();
    return (
      <PetProfile
        session={session}
        language="en"
        profile={profile}
        onSave={async () => profile}
        onRefresh={async () => {}}
        appearance={false}
        onAppearance={() => {}}
        onOpenSource={() => {}}
        petVisible={visibility.visible}
        onPetBounds={visibility.onBounds}
      />
    );
  }
  render(<Probe />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Work" })).toBeTruthy(),
  );
  act(() => {
    visibility.onViewport(400);
  });
  fireEvent(screen.getByTestId("pet-profile"), "layout", {
    nativeEvent: { layout: { y: 20, height: 900 } },
  });
  fireEvent(screen.getByTestId("profile-pet-bounds"), "layout", {
    nativeEvent: { layout: { y: 150, height: 260 } },
  });
  expect(
    screen.UNSAFE_getByProps({ label: "Niaro", interactive: true }).props
      .visible,
  ).toBe(true);
  act(() => visibility.onScroll(440, 400));
  expect(
    screen.UNSAFE_getByProps({ label: "Niaro", interactive: true }).props
      .visible,
  ).toBe(false);
  act(() => visibility.onScroll(0, 400));
  expect(
    screen.UNSAFE_getByProps({ label: "Niaro", interactive: true }).props
      .visible,
  ).toBe(true);
  fireEvent.press(screen.getByRole("button", { name: "Work" }));
  await waitFor(() => expect(focus).toHaveBeenCalledWith(77));
  handle.mockRestore();
  focus.mockRestore();
});
