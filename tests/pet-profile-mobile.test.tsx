import React, { useEffect } from "react";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react-native";
import { AccessibilityInfo, Alert, AppState } from "react-native";
import { useNativePetProfile } from "../apps/mobile/pet-profile-model";
import { useHomePetVisibility } from "../apps/mobile/home-pet-visibility";
import { CompanionLibrary } from "../apps/mobile/CompanionLibrary";

import {
  PetProfile,
  petScreenTitle,
  PetTopBarActions,
  usePetScreen,
  type PetScreen,
} from "../apps/mobile/PetProfile";
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
    (section) => ({ section, weight: 0, count: 0 }),
  ) as Profile["look"],
};
test("native actual profile reads the selected private section and retains a rejected correction", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
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
  await screen.findByText("Synthetic preference");
  fireEvent.press(screen.getByRole("button", { name: "More" }));
  fireEvent.press(await screen.findByRole("button", { name: "Correct" }));
  fireEvent.changeText(screen.getByLabelText("Edit"), "My retained correction");
  fireEvent.press(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "revise",
      id: "memory-1",
      revision: 1,
      content: "My retained correction",
    }),
  );
  expect(screen.getByDisplayValue("My retained correction")).toBeTruthy();
  // The unconfirmed save asks in a dialog instead of shifting the page.
  await waitFor(() =>
    expect(alert).toHaveBeenCalledWith(
      "Couldn't confirm the save.",
      expect.stringContaining("This memory changed"),
      expect.arrayContaining([expect.objectContaining({ text: "Try again" })]),
    ),
  );
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
    const current = useNativePetProfile(owner);
    useEffect(() => {
      model = current;
    });
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
    const current = useHomePetVisibility();
    useEffect(() => {
      visibility = current;
    });
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
        petVisible={current.visible}
        onPetBounds={current.onBounds}
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

const counted: Profile = {
  ...profile,
  settings: {
    ...profile.settings,
    jobTitle: "Product manager",
    department: "",
  },
  look: [
    { section: "work", weight: 0.5, count: 5 },
    { section: "projects", weight: 0.3, count: 3 },
    { section: "tools", weight: 0.2, count: 2 },
    { section: "people", weight: 0.1, count: 1 },
    { section: "style", weight: 0.1, count: 1 },
    { section: "rhythm", weight: 0, count: 0 },
  ],
};
const memoryPage = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  optOut: false,
  personalThings: "keep",
  version: 1,
  items: [],
  nextCursor: null,
  ...overrides,
});
// The TopBar actions render the memory switch and the history toggle, so the
// page and the bar share one screen state as they do in the app.
function PetWithBar({
  session,
  value,
}: {
  session: ClientSession;
  value: Profile;
}) {
  const petScreen = usePetScreen();
  return (
    <>
      <PetTopBarActions screen={petScreen} language="en" />
      <PetProfile
        session={session}
        language="en"
        profile={value}
        onSave={async () => value}
        onRefresh={async () => {}}
        appearance={false}
        onAppearance={() => {}}
        onOpenSource={() => {}}
        screen={petScreen}
      />
    </>
  );
}
function renderPet(session: ClientSession, value: Profile = counted) {
  return render(<PetWithBar session={session} value={value} />);
}
test("the device shows honest per-section counts and sums them in the status line", async () => {
  const session = {
    petMemory: jest.fn(async () => memoryPage()),
  } as unknown as ClientSession;
  renderPet(session);
  await waitFor(() => expect(session.petMemory).toHaveBeenCalled());
  expect(screen.getByText("Knows 12 work things")).toBeTruthy();
  expect(screen.getByText("Product manager")).toBeTruthy();
  const work = screen.getByRole("button", { name: "Work" });
  expect(work.props.accessibilityValue).toEqual({ text: "5 observations" });
  expect(
    screen.getByRole("button", { name: "Rhythm" }).props.accessibilityValue,
  ).toEqual({ text: "0 observations" });
  expect(screen.getAllByText("5")).toHaveLength(1);
  expect(screen.queryByText("0")).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("switch", { name: "Use memory" }).props.value).toBe(
      true,
    ),
  );
});

test("an empty profile says it is still learning and no number animates in", async () => {
  const session = {
    petMemory: jest.fn(async () => memoryPage()),
  } as unknown as ClientSession;
  renderPet(session, profile);
  await waitFor(() => expect(session.petMemory).toHaveBeenCalled());
  expect(screen.getByText("Still learning you")).toBeTruthy();
});

test("memory off puts the pet to rest with an asleep status and keeps the counts", async () => {
  const session = {
    petMemory: jest.fn(async () => memoryPage({ optOut: true })),
    savePetMemory: jest.fn(async () => memoryPage({ optOut: false })),
  } as unknown as ClientSession;
  renderPet(session);
  await waitFor(() => expect(screen.getByText("Memory asleep")).toBeTruthy());
  expect(
    screen.UNSAFE_getByProps({ label: "Niaro", interactive: true }).props.state,
  ).toBe("resting");
  expect(screen.getByText("5")).toBeTruthy();
  const toggle = screen.getByRole("switch", { name: "Use memory" });
  expect(toggle.props.value).toBe(false);
  fireEvent(toggle, "valueChange", true);
  await waitFor(() =>
    expect(session.savePetMemory).toHaveBeenCalledWith(
      expect.objectContaining({ type: "preference", optOut: false }),
    ),
  );
});

test("a section opens as a nested screen and the back path restores focus to its opener", async () => {
  const focus = jest
    .spyOn(AccessibilityInfo, "setAccessibilityFocus")
    .mockImplementation(() => {});
  jest
    .spyOn(
      jest.requireActual<typeof import("react-native")>("react-native"),
      "findNodeHandle",
    )
    .mockImplementation((node) => (node ? 91 : null));
  const session = {
    petMemory: jest.fn(async (query: { section?: string }) =>
      memoryPage({
        items:
          query.section === "work"
            ? [
                {
                  id: "memory-1",
                  revision: 1,
                  content: "Leads weekly planning",
                  origin: "observed",
                  status: "active",
                  trust: "model_inference",
                  seenAt: new Date().toISOString(),
                  createdAt: new Date().toISOString(),
                  source: {
                    type: "observed",
                    section: "work",
                    personal: false,
                    sources: [],
                  },
                },
              ]
            : [],
      }),
    ),
  } as unknown as ClientSession;
  let petScreen!: PetScreen;
  function Probe() {
    const current = usePetScreen();
    useEffect(() => {
      petScreen = current;
    });
    return (
      <PetProfile
        session={session}
        language="en"
        profile={counted}
        onSave={async () => counted}
        onRefresh={async () => {}}
        appearance={false}
        onAppearance={() => {}}
        onOpenSource={() => {}}
        screen={current}
      />
    );
  }
  render(<Probe />);
  await waitFor(() => expect(session.petMemory).toHaveBeenCalled());
  expect(petScreenTitle(petScreen, "en")).toBe("You and Niaro");
  fireEvent.press(screen.getByRole("button", { name: "Work" }));
  expect(petScreenTitle(petScreen, "en")).toBe("Work");
  expect(await screen.findByText("Leads weekly planning")).toBeTruthy();
  expect(screen.getByText(/5 observations · last today/)).toBeTruthy();
  expect(screen.getByText("Observation · last today")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Personal" })).toBeTruthy();
  await waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
  focus.mockClear();
  act(() => {
    expect(petScreen.back()).toBe(true);
  });
  expect(petScreenTitle(petScreen, "en")).toBe("You and Niaro");
  await waitFor(() => expect(focus).toHaveBeenCalledWith(91));
  expect(screen.getByRole("button", { name: "Work" })).toBeTruthy();
  expect(petScreen.back()).toBe(false);
  jest.restoreAllMocks();
});

test("the row menu runs delete and classify through the confirmed commands", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const item = {
    id: "memory-1",
    revision: 3,
    content: "Writes specs in Notion",
    origin: "observed",
    status: "active",
    trust: "model_inference",
    seenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    source: { type: "observed", section: "work", personal: false, sources: [] },
  };
  const session = {
    petMemory: jest.fn(async () => memoryPage({ items: [item] })),
    savePetMemory: jest.fn(async () => memoryPage({ items: [] })),
  } as unknown as ClientSession;
  let petScreen!: PetScreen;
  function Probe() {
    const current = usePetScreen();
    useEffect(() => {
      petScreen = current;
    });
    return (
      <PetProfile
        session={session}
        language="en"
        profile={counted}
        onSave={async () => counted}
        onRefresh={async () => {}}
        appearance={false}
        onAppearance={() => {}}
        onOpenSource={() => {}}
        screen={current}
      />
    );
  }
  render(<Probe />);
  act(() => petScreen.setView({ kind: "section", section: "work" }));
  await screen.findByText("Writes specs in Notion");
  fireEvent.press(screen.getByRole("button", { name: "More" }));
  fireEvent.press(await screen.findByRole("button", { name: "Delete" }));
  expect(alert).toHaveBeenLastCalledWith(
    "Delete this memory and its earlier versions?",
    undefined,
    expect.arrayContaining([
      expect.objectContaining({ text: "Delete", style: "destructive" }),
    ]),
  );
  const buttons = alert.mock.calls.at(-1)![2]!;
  await act(async () => buttons[1]!.onPress!());
  expect(session.savePetMemory).toHaveBeenCalledWith(
    expect.objectContaining({ type: "forget", id: "memory-1", revision: 3 }),
  );
  await screen.findByText("Saved");
  await waitFor(() => expect(session.petMemory).toHaveBeenCalledTimes(3));
  fireEvent.press(screen.getByRole("button", { name: "More" }));
  fireEvent.press(
    await screen.findByRole("button", { name: "Mark as personal" }),
  );
  const classify = alert.mock.calls.at(-1)![2]!;
  await act(async () => classify[1]!.onPress!());
  expect(session.savePetMemory).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "classify",
      id: "memory-1",
      personal: true,
    }),
  );
  alert.mockRestore();
});
test("native profile follows changes made on the web", async () => {
  const listeners: ((state: string) => void)[] = [];
  const subscribe = jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((type, listener) => {
      if (type === "change") listeners.push(listener as (s: string) => void);
      return { remove: jest.fn() } as never;
    });
  const changed = {
    ...profile,
    revision: 3,
    settings: { ...profile.settings, shape: "heart" as const },
  };
  const petProfile = jest
    .fn()
    .mockResolvedValueOnce(profile)
    .mockResolvedValue(changed);
  const session = { petProfile } as unknown as ClientSession;
  let model!: ReturnType<typeof useNativePetProfile>;
  function Probe() {
    const current = useNativePetProfile(session);
    useEffect(() => {
      model = current;
    });
    return null;
  }
  render(<Probe />);
  await waitFor(() => expect(model.profile?.revision).toBe(0));
  act(() => listeners.forEach((listener) => listener("active")));
  await waitFor(() => expect(model.profile?.settings.shape).toBe("heart"));
  subscribe.mockRestore();
});
test("native profile follows the server's pet events live", async () => {
  const state = AppState.currentState;
  AppState.currentState = "active";
  const subscribe = jest
    .spyOn(AppState, "addEventListener")
    .mockReturnValue({ remove: jest.fn() } as never);
  let emit!: (type: "ready" | "pet") => void;
  const changed = {
    ...profile,
    revision: 4,
    settings: { ...profile.settings, shape: "cat" as const },
  };
  const petProfile = jest
    .fn()
    .mockResolvedValueOnce(profile)
    .mockResolvedValue(changed);
  const session = {
    petProfile,
    watchPet: jest.fn(
      (onEvent: typeof emit, signal: AbortSignal) =>
        new Promise((resolve) => {
          emit = onEvent;
          signal.addEventListener("abort", () => resolve("ended"));
        }),
    ),
  } as unknown as ClientSession;
  let model!: ReturnType<typeof useNativePetProfile>;
  function Probe() {
    const current = useNativePetProfile(session);
    useEffect(() => {
      model = current;
    });
    return null;
  }
  const view = render(<Probe />);
  await waitFor(() => expect(model.profile?.revision).toBe(0));
  // The first connect follows the initial read: nothing to catch up.
  act(() => emit("ready"));
  expect(petProfile).toHaveBeenCalledTimes(1);
  act(() => emit("pet"));
  await waitFor(() => expect(model.profile?.settings.shape).toBe("cat"));
  expect(model.changes).toBe(1);
  view.unmount();
  AppState.currentState = state;
  subscribe.mockRestore();
});
