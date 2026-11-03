import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AppState } from "react-native";
import {
  createVoiceCapture,
  ensureMicrophone,
} from "../apps/mobile/voice-capture";
import { resetChatSession } from "../apps/mobile/chat-session";
import { voiceCapabilities } from "../packages/protocol/voice";
import { chatFixture, flush } from "./helpers/mobile-chat-fixture";

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
jest.mock("expo-crypto", () => ({ randomUUID: () => "TEST-voice-command" }));
jest.mock("../apps/mobile/ReplySpeech", () => ({
  useReplySpeech: () => ({
    player: { stop: jest.fn(), waitForReply: jest.fn() },
    state: { phase: "idle" },
    enabled: false,
  }),
}));

const BLOCKED = "Microphone blocked. Allow access or type.";

beforeEach(() => {
  jest.clearAllMocks();
  resetChatSession();
  AppState.currentState = "active";
});

test("a microphone allowed after a refusal clears Microphone blocked as voice starts, and it does not come back (NIAR-277)", async () => {
  const f = chatFixture();
  const capture = {
    supported: () => true,
    start: jest.fn(async () => {}),
    stop: jest.fn(async () => ({
      mimeType: "audio/wav" as const,
      base64: "YWJjZA==",
    })),
    discard: jest.fn(async () => {}),
  };
  jest.mocked(createVoiceCapture).mockReturnValue(capture);
  Object.assign(f.session, {
    voiceCapabilities: jest.fn(async () => voiceCapabilities(true)),
    transcribe: jest.fn(async () => ({ text: "", reviewReasons: [] })),
  });
  render(<f.Harness />);
  await act(flush);
  const talk = async () =>
    act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Voice input" }));
      await flush();
    });
  // Refused: the chat says so and nothing records.
  jest.mocked(ensureMicrophone).mockResolvedValueOnce(false);
  await talk();
  expect(screen.getByText(BLOCKED)).toBeTruthy();
  expect(capture.start).not.toHaveBeenCalled();
  // Allowed in the system settings, then tapped again: listening, and the notice is gone.
  jest.mocked(ensureMicrophone).mockResolvedValueOnce(true);
  await talk();
  expect(capture.start).toHaveBeenCalledTimes(1);
  expect(screen.getAllByText("Listening").length).toBeGreaterThan(0);
  expect(screen.queryByText(BLOCKED)).toBeNull();
  // Through recording and after closing it, it stays gone.
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    await flush();
  });
  expect(screen.queryByText(BLOCKED)).toBeNull();
  await talk();
  expect(capture.start).toHaveBeenCalledTimes(2);
  expect(ensureMicrophone).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(BLOCKED)).toBeNull();
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    await flush();
  });
});
