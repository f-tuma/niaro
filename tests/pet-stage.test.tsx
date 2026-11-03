import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { VoiceReply } from "../apps/mobile/VoiceReply";
import { VoiceDraft } from "../packages/client-core/voice";
import { PetSlot, PetStage } from "../packages/ui/PetStage";
import { createPetShader } from "../packages/ui/pet-shader";

// NIAR-276/277: the app's one pet. Its GL surface is counted; it never gets a context here, so
// the pet never draws, which is exactly when nothing else may wait for it.
jest.mock("../apps/mobile/feedback", () => ({ feedback: () => 0 }));
jest.mock("../apps/mobile/voice-capture", () => ({
  ensureMicrophone: jest.fn(async () => true),
  createVoiceCapture: jest.fn(),
}));
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
const surfaces = { mounted: 0 };
jest.mock("../packages/ui/gl-surface", () => {
  const React = jest.requireActual("react");
  const { View } = jest.requireActual("react-native");
  function TestSurface(props: object) {
    React.useEffect(() => {
      surfaces.mounted++;
    }, []);
    return React.createElement(View, { ...props, testID: "pet-gl" });
  }
  return {
    supportedGLView: () => TestSurface,
    GLBoundary: ({ children }: { children: React.ReactNode }) => children,
  };
});

beforeEach(() => {
  surfaces.mounted = 0;
  jest.mocked(createPetShader).mockClear();
});
// The stage's own PetView (memo components are found through their drawn view).
const stagePet = () => {
  let node = screen.getByTestId("pet-stage-pet", {
    includeHiddenElements: true,
  }).parent;
  while (node && !("drawingSize" in node.props)) node = node.parent;
  return node!;
};
const pets = () =>
  screen.queryAllByTestId("pet-gl", { includeHiddenElements: true }).length;
const look = { shape: "clover" as const, tint: [0.62, 0.86, 0.78] };

function Screens({ screen: name }: { screen: string }) {
  return name === "home" ? (
    <PetSlot
      testID="home-pet"
      size={220}
      appearance={look}
      interactive
      clipped
    />
  ) : name === "chat" ? (
    <PetSlot testID="chat-pet" size={44} appearance={look} />
  ) : name === "profile" ? (
    <PetSlot
      testID="profile-pet"
      size={260}
      appearance={look}
      state="resting"
    />
  ) : null;
}

test("one pet for the whole run: screens only place slots, the GL surface is created once", () => {
  const { rerender } = render(
    <PetStage enabled look={look}>
      <Screens screen="home" />
    </PetStage>,
  );
  for (const name of ["library", "chat", "profile", "home", "chat"]) {
    rerender(
      <PetStage enabled look={look}>
        <Screens screen={name} />
      </PetStage>,
    );
    expect(pets()).toBe(1);
    expect(stagePet().props.visible).toBe(name !== "library");
  }
  expect(surfaces.mounted).toBe(1);
  // The pet takes the newest screen's state; its own size and buffer never change.
  rerender(
    <PetStage enabled look={look}>
      <Screens screen="profile" />
    </PetStage>,
  );
  expect(stagePet().props).toMatchObject({
    state: "resting",
    size: 220,
    drawingSize: 220,
  });
  expect(screen.getByTestId("profile-pet").props.style).toEqual({
    width: 260,
    height: 260,
  });
});

test("the pet starts with the remembered look before any screen, and is created as the app starts", () => {
  render(
    <PetStage enabled look={look}>
      {null}
    </PetStage>,
  );
  expect(surfaces.mounted).toBe(1);
  expect(stagePet().props).toMatchObject({ appearance: look, visible: false });
});

test("the newest slot holds the pet and the one under it gets it back", () => {
  const { rerender } = render(
    <PetStage enabled look={null}>
      <Screens screen="home" />
    </PetStage>,
  );
  rerender(
    <PetStage enabled look={null}>
      <Screens screen="home" />
      <PetSlot testID="sheet-pet" size={140} state="listening" />
    </PetStage>,
  );
  expect(stagePet().props.state).toBe("listening");
  rerender(
    <PetStage enabled look={null}>
      <Screens screen="home" />
    </PetStage>,
  );
  expect(stagePet().props.state).not.toBe("listening");
  expect(stagePet().props.appearance).toBe(look);
});

test("the slot is what the person reads and taps; the drawn pet is hidden from both", () => {
  const onPress = jest.fn();
  render(
    <PetStage enabled look={null}>
      <PetSlot testID="chat-pet" size={44} label="Mia" onPress={onPress} />
    </PetStage>,
  );
  const slot = screen.getByTestId("chat-pet");
  expect(slot.props).toMatchObject({
    accessible: true,
    accessibilityRole: "button",
    accessibilityLabel: "Mia",
  });
  expect(stagePet().props.controls).toBeTruthy();
  expect(
    screen.getByTestId("pet-stage-pet", { includeHiddenElements: true }).props,
  ).toMatchObject({ accessible: false, pointerEvents: "none" });
  // A screen reader's activation reaches the pet through its slot.
  act(() => slot.props.onAccessibilityTap());
  expect(onPress).toHaveBeenCalledTimes(1);
});

test("without a stage (browser, stories) a slot is a pet of its own", () => {
  render(<PetSlot testID="own-pet" size={120} clipped />);
  expect(pets()).toBe(1);
  expect(screen.getByTestId("own-pet").props.accessibilityRole).toBe("image");
  expect(screen.queryByTestId("pet-stage-pet")).toBeNull();
});

test("recording says it is listening as soon as the microphone starts, while the pet has not drawn (NIAR-277)", async () => {
  let microphone!: () => void;
  const capture = {
    supported: () => true,
    start: jest.fn(
      () => new Promise<void>((resolve) => (microphone = resolve)),
    ),
    stop: jest.fn(async () => ({
      mimeType: "audio/wav" as const,
      base64: "YWJjZA==",
    })),
    discard: jest.fn(async () => {}),
  };
  const draft = new VoiceDraft(
    capture,
    undefined,
    "en",
    async () => ({ text: "", reviewReasons: [] }),
    () => "voice-request",
    jest.fn(),
  );
  const app = (voice: boolean) => (
    <PetStage enabled look={look}>
      {voice ? (
        <VoiceReply
          draft={draft}
          language="en"
          blocked={false}
          onClose={() => {}}
          petAppearance={look}
        />
      ) : (
        <Screens screen="home" />
      )}
    </PetStage>
  );
  const { rerender } = render(app(false));
  // Opening voice moves the one pet into the sheet: no GL view is built for it.
  rerender(app(true));
  expect(surfaces.mounted).toBe(1);
  expect(pets()).toBe(1);
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Record" }));
  });
  expect(capture.start).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Requesting microphone…")).toBeTruthy();
  await act(async () => microphone());
  expect(screen.getAllByText("Listening").length).toBeGreaterThan(0);
  expect(stagePet().props.state).toBe("listening");
  // The pet never got a GL context, never compiled, never drew: none of it was waited for.
  expect(createPetShader).not.toHaveBeenCalled();
  expect(surfaces.mounted).toBe(1);
  await act(async () => {
    await draft.cancel();
  });
});
