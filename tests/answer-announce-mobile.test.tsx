import React from "react";
import { AccessibilityInfo } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { resetChatSession } from "../apps/mobile/chat-session";
import { answerAnnouncement, answerGist } from "../apps/mobile/chat/announce";
import { chatFixture, flush, messages } from "./helpers/mobile-chat-fixture";

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
jest.mock("expo-crypto", () => ({ randomUUID: () => "TEST-announce-command" }));
const mockSpeech = {
  phase: "idle" as string,
  messageId: undefined as string | undefined,
};
jest.mock("../apps/mobile/ReplySpeech", () => ({
  useReplySpeech: () => ({
    player: { stop: jest.fn(), waitForReply: jest.fn() },
    state: mockSpeech,
    enabled: false,
  }),
}));

let announce: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  resetChatSession();
  mockSpeech.phase = "idle";
  mockSpeech.messageId = undefined;
  announce = jest
    .spyOn(AccessibilityInfo, "announceForAccessibility")
    .mockImplementation(() => {});
});
afterEach(() => announce.mockRestore());

test("the gist is the first paragraph in plain words", () => {
  expect(
    answerGist(
      "## Deals\n\nYou have **3** open [deals](https://crm.test/deals) in `Twenty`.\n\nThe rest.",
    ),
  ).toBe("You have 3 open deals in Twenty.");
  expect(
    answerGist("```\ncode first\n```\n| a | b |\n|---|---|\n\n- one\n- two"),
  ).toBe("one two");
  // snake_case words keep their underscores; _emphasis_ loses its marks.
  expect(answerGist("Field due_date is _required_.")).toBe(
    "Field due_date is required.",
  );
  expect(answerGist("# Only a heading")).toBe("Only a heading");
  expect(answerGist("x".repeat(400))).toHaveLength(300);
  expect(answerAnnouncement("Odpověď je hotová", "")).toBe("Odpověď je hotová");
});

const openChat = async () => {
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Menu" }));
    await flush();
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "TEST chat" }));
    await flush();
  });
};
const answer = (
  f: ReturnType<typeof chatFixture>,
  message: { id: string; text: string; replyToCommandId?: string },
) =>
  act(async () => {
    const store = f.state().store!;
    const conversation = store.conversations["TEST-A"]!;
    f.publish({
      store: {
        ...store,
        conversations: {
          ...store.conversations,
          "TEST-A": {
            ...conversation,
            revision: conversation.revision + 1,
            messages: [
              ...conversation.messages,
              { role: "assistant", ...message },
            ],
          },
        },
      },
    });
    await flush();
  });

test("a stored answer is announced once; history read on opening is not", async () => {
  const f = chatFixture();
  render(<f.Harness />);
  await act(flush);
  await openChat();
  expect(screen.getByText(messages[0]!.text)).toBeTruthy();
  expect(announce).not.toHaveBeenCalled();
  await answer(f, { id: "TEST-a3", text: "**Done.** Three deals.\n\nDetails" });
  expect(announce).toHaveBeenCalledTimes(1);
  expect(announce).toHaveBeenCalledWith("Answer ready. Done. Three deals.");
  // Another change to the chat says nothing new.
  await act(async () => {
    f.publish({ error: null });
    await flush();
  });
  expect(announce).toHaveBeenCalledTimes(1);
});

test("an answer being read aloud is not announced", async () => {
  const f = chatFixture();
  render(<f.Harness />);
  await act(flush);
  await openChat();
  mockSpeech.phase = "playing";
  mockSpeech.messageId = "TEST-spoken";
  await answer(f, { id: "TEST-spoken", text: "TEST spoken answer" });
  expect(announce).not.toHaveBeenCalled();
});
