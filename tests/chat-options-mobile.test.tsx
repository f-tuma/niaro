import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { resetChatSession } from "../apps/mobile/chat-session";
import { ConversationOpenWorkError } from "../packages/client-core/conversation-directory";
import { conversationPinsKey } from "../packages/client-core/conversation-preferences";
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
jest.mock("expo-crypto", () => ({ randomUUID: () => "TEST-options-command" }));
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
const openChat = async () => {
  await press(screen.getByRole("button", { name: "Menu" }));
  await press(screen.getByRole("button", { name: "TEST chat" }));
};
const options = () =>
  press(screen.getByRole("button", { name: "Chat options" }));

beforeEach(() => {
  jest.clearAllMocks();
  resetChatSession();
});

test("the top bar holds the chat's … instead of New chat, which is in the menu", async () => {
  const f = chatFixture();
  render(<f.Harness />);
  await act(flush);
  expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
  await openChat();
  expect(
    screen.getByRole("button", { name: "Chat options" }).props
      .accessibilityState.disabled,
  ).toBe(false);
  await options();
  expect(
    screen
      .getAllByRole("menuitem")
      .map((item) => item.props.accessibilityLabel),
  ).toEqual(["Pin chat", "Rename", "Archive", "Delete"]);
});

test("Rename from the … names the chat and the top bar shows it", async () => {
  const f = chatFixture();
  render(<f.Harness />);
  await act(flush);
  await openChat();
  await options();
  await press(screen.getByRole("menuitem", { name: "Rename" }));
  fireEvent.changeText(screen.getByLabelText("Chat name"), "TEST renamed");
  await press(screen.getByRole("button", { name: "Rename" }));
  expect(f.session.renameConversation).toHaveBeenCalledWith(
    "TEST-A",
    "TEST renamed",
    "TEST-options-command",
  );
  expect(screen.getByText("TEST renamed")).toBeTruthy();
});

test("Pin from the … keeps the pin on this device", async () => {
  const f = chatFixture();
  render(<f.Harness />);
  await act(flush);
  await openChat();
  await options();
  await press(screen.getByRole("menuitem", { name: "Pin chat" }));
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    conversationPinsKey(f.session.identityKey),
    expect.stringContaining("TEST-A"),
  );
});

test("Delete from the … asks first, then leaves for the main chat", async () => {
  const f = chatFixture();
  render(<f.Harness />);
  await act(flush);
  await openChat();
  await options();
  await press(screen.getByRole("menuitem", { name: "Delete" }));
  expect(f.session.deleteConversation).not.toHaveBeenCalled();
  await press(screen.getByRole("button", { name: "Delete" }));
  expect(f.session.deleteConversation).toHaveBeenCalledWith(
    "TEST-A",
    "TEST-options-command",
  );
  expect(f.session.selectConversation).toHaveBeenLastCalledWith(
    "conversation-1",
  );
});

test("an archive refused for waiting work says so in the chat and can cancel it and go on", async () => {
  const f = chatFixture();
  f.session.archiveConversation.mockRejectedValueOnce(
    new ConversationOpenWorkError([
      { kind: "approval", id: "TEST-work", title: "TEST send the e-mail" },
    ] as never),
  );
  render(<f.Harness />);
  await act(flush);
  await openChat();
  await options();
  await press(screen.getByRole("menuitem", { name: "Archive" }));
  expect(screen.getByTestId("open-work-notice")).toBeTruthy();
  expect(screen.getByText(/TEST send the e-mail/)).toBeTruthy();
  await press(screen.getByRole("button", { name: "Cancel and archive" }));
  expect(f.session.archiveConversation).toHaveBeenLastCalledWith(
    "TEST-A",
    "TEST-options-command",
    { cancelOpenWork: true },
  );
  expect(screen.queryByTestId("open-work-notice")).toBeNull();
  expect(f.session.selectConversation).toHaveBeenLastCalledWith(
    "conversation-1",
  );
});
