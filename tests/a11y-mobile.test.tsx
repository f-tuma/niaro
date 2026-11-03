/**
 * What TalkBack and VoiceOver are given for the wave 1 phone controls
 * (NIAR-278): each is a button with a spoken name and its state, not only
 * something findable in a test. Speech, focus order and gestures on a real
 * device still need a person with a screen reader.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { resetChatSession } from "../apps/mobile/chat-session";
import { ActionApprovalCard } from "../packages/ui-catalog/ActionApprovalCard";
import { choosePeter, meetingProposal } from "../packages/test-fixtures";
import { chatFixture, flush } from "./helpers/mobile-chat-fixture";

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(async () => true),
}));
jest.mock("../apps/mobile/voice-capture", () => ({
  ensureMicrophone: jest.fn(async () => true),
  createVoiceCapture: jest.fn(),
}));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
}));
jest.mock("../apps/mobile/feedback", () => ({
  feedback: () => 0,
  setFeedbackEnabled: jest.fn(),
}));
jest.mock("../apps/mobile/app-login", () => ({
  loginProof: jest.fn(),
  authorizeApp: jest.fn(),
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => "TEST-a11y-command" }));
jest.mock("../apps/mobile/ReplySpeech", () => ({
  useReplySpeech: () => ({
    player: { stop: jest.fn(), waitForReply: jest.fn() },
    state: { phase: "idle" },
    enabled: false,
  }),
}));

const press = async (element: ReturnType<typeof screen.getByRole>) =>
  act(async () => {
    fireEvent.press(element);
    await flush();
  });
/** The props a screen reader reads, on the element that carries them. */
const spoken = (element: ReturnType<typeof screen.getByRole>) => ({
  role: element.props.accessibilityRole,
  label: element.props.accessibilityLabel,
  disabled: !!element.props.accessibilityState?.disabled,
});

beforeEach(() => {
  jest.clearAllMocks();
  resetChatSession();
});

test("Copy, Edit, Again and the top bar's … are named buttons with their state", async () => {
  const f = chatFixture();
  render(<f.Harness />);
  await act(flush);
  await press(screen.getByRole("button", { name: "Menu" }));
  await press(screen.getByRole("button", { name: "TEST chat" }));

  const copies = screen.getAllByRole("button", { name: "Copy" });
  expect(copies.length).toBeGreaterThan(0);
  for (const copy of copies)
    expect(spoken(copy)).toEqual({
      role: "button",
      label: "Copy",
      disabled: false,
    });
  expect(spoken(screen.getByRole("button", { name: "Edit" }))).toEqual({
    role: "button",
    label: "Edit",
    disabled: false,
  });
  expect(spoken(screen.getByRole("button", { name: "Again" }))).toEqual({
    role: "button",
    label: "Again",
    disabled: false,
  });
  const options = screen.getByRole("button", { name: "Chat options" });
  expect(spoken(options)).toEqual({
    role: "button",
    label: "Chat options",
    disabled: false,
  });
  // The menu it opens lists menu items, each read by its name.
  await press(options);
  expect(
    screen
      .getAllByRole("menuitem")
      .map((item) => item.props.accessibilityLabel),
  ).toEqual(expect.arrayContaining(["Rename", "Archive", "Delete"]));
  // A copied message says so on the same button.
  await press(copies[0]!);
  expect(spoken(screen.getByRole("button", { name: "Copied" })).label).toBe(
    "Copied",
  );
});

test.each(["en", "cs"] as const)(
  "%s meeting decisions are named buttons; a blocked card says they are disabled",
  (language) => {
    const props = {
      proposal: meetingProposal(language),
      contacts: choosePeter(language).input.options,
      operations: [],
      source: "fixture-local / a",
      language,
      compact: true,
      onDecision: jest.fn(),
      onRevise: jest.fn(),
    };
    const { rerender } = render(<ActionApprovalCard {...props} />);
    const names =
      language === "cs"
        ? ["Upravit", "Odmítnout", "Potvrdit"]
        : ["Edit", "Decline", "Approve"];
    for (const name of names)
      expect(spoken(screen.getByRole("button", { name }))).toEqual({
        role: "button",
        label: name,
        disabled: false,
      });
    rerender(<ActionApprovalCard {...props} stale />);
    for (const name of names)
      expect(spoken(screen.getByRole("button", { name })).disabled).toBe(true);
  },
);
