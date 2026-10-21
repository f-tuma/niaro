import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { VoiceReply } from "../apps/mobile/VoiceReply";
import { VoiceDraft } from "../packages/client-core/voice";

jest.mock("../apps/mobile/feedback", () => ({ feedback: () => 0 }));
jest.mock("../apps/mobile/voice-capture", () => ({
  createVoiceCapture: jest.fn(),
}));

// This existing composer already has catalogue stories. Exercise the changed
// busy-state controls here; no new layout or visual variant is introduced.
test("an outstanding command allows microphone start and stop while keeping transcript send blocked", async () => {
  const capture = {
    supported: () => true,
    start: jest.fn(async () => {}),
    stop: jest.fn(async () => ({
      mimeType: "audio/wav" as const,
      base64: "YWJjZA==",
    })),
    discard: jest.fn(async () => {}),
  };
  const deliver = jest.fn();
  const draft = new VoiceDraft(
    capture,
    undefined,
    "en",
    async () => ({ text: "My new request", reviewReasons: ["uncertain"] }),
    () => "voice-request",
    deliver,
  );
  render(<VoiceReply draft={draft} language="en" blocked onClose={() => {}} />);
  expect(
    screen.getByRole("button", { name: "Start recording" }).props
      .accessibilityState.disabled,
  ).toBe(false);
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Start recording" }));
  });
  expect(capture.start).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "Done" }).props.accessibilityState
      .disabled,
  ).toBe(false);
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Done" }));
  });
  expect(capture.stop).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "Send text" }).props.accessibilityState
      .disabled,
  ).toBe(true);
  fireEvent.press(screen.getByRole("button", { name: "Send text" }));
  expect(deliver).not.toHaveBeenCalled();
  await act(async () => {
    await draft.cancel();
  });
});
