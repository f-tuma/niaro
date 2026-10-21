import React from "react";
import { act, render, screen } from "@testing-library/react-native";
import { VoiceSettings } from "../apps/mobile/VoiceSettings";
import { VoiceServiceCard } from "../packages/ui-catalog/VoiceServiceCard";
import { voiceCapabilities } from "../packages/protocol/voice";
import type { ClientSession } from "../packages/client-core/session";
import { SpokenRepliesCard } from "../packages/ui-catalog/SpokenRepliesCard";
import {
  SPEECH_PROFILE,
  SPEECH_TEXT_LENGTH,
  SpeechCapabilitiesSchema,
} from "../packages/protocol/speech";
test.each(["en", "cs"] as const)(
  "settings disclose cloud processing in %s without requesting recording",
  (language) => {
    render(
      <VoiceServiceCard
        language={language}
        capabilities={voiceCapabilities(true, "openrouter")}
      />,
    );
    expect(screen.getByText(/Gemini 3\.1 Flash Lite/)).toBeTruthy();
    expect(screen.queryByText(/google\/gemini-3\.1-flash-lite/)).toBeNull();
    expect(screen.getByText(/OpenRouter/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  },
);
test("disabled cloud remains disclosed; unknown service never claims local processing", () => {
  const { rerender } = render(
    <VoiceServiceCard
      language="en"
      capabilities={voiceCapabilities(false, "openrouter")}
    />,
  );
  expect(screen.getByText(/Not available/)).toBeTruthy();
  expect(screen.getByText(/OpenRouter/)).toBeTruthy();
  // A switched-off service never names the model it would use.
  expect(screen.queryByText(/Gemini 3\.1 Flash Lite/)).toBeNull();
  rerender(
    <VoiceServiceCard language="en" capabilities={voiceCapabilities(false)} />,
  );
  expect(screen.queryByText(/Whisper/)).toBeNull();
  expect(screen.queryByText(/Not available/)).toBeTruthy();
  expect(screen.queryByText(/Processed on this server/)).toBeNull();
  rerender(<VoiceServiceCard language="en" capabilities={null} />);
  expect(screen.queryByText(/Whisper/)).toBeNull();
});
test("switching connection ignores old capability response and aborts its request", async () => {
  let finish: (value: ReturnType<typeof voiceCapabilities>) => void = () => {};
  const old = {
    speechCapabilities: jest.fn(async () => null),
    voiceCapabilities: jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const next = {
    speechCapabilities: jest.fn(async () => null),
    voiceCapabilities: jest.fn(async () => voiceCapabilities(true)),
  };
  const { rerender } = render(
    <VoiceSettings
      language="en"
      session={old as unknown as ClientSession}
      spokenReplies
      onSpokenReplies={() => {}}
    />,
  );
  rerender(
    <VoiceSettings
      language="en"
      session={next as unknown as ClientSession}
      spokenReplies
      onSpokenReplies={() => {}}
    />,
  );
  await act(async () => {
    finish(voiceCapabilities(true, "openrouter"));
  });
  expect(screen.getByText(/Whisper small/)).toBeTruthy();
  expect(screen.queryByText(/Gemini 3\.1 Flash Lite/)).toBeNull();
  expect(
    (old.voiceCapabilities.mock.calls as unknown as [AbortSignal][])[0]![0]
      .aborted,
  ).toBe(true);
});
test("spoken replies offer no switch where the server has no voice output", () => {
  const change = jest.fn();
  const capabilities = (enabled: boolean) =>
    SpeechCapabilitiesSchema.parse({
      profile: SPEECH_PROFILE,
      enabled,
      model: enabled ? "openai/gpt-4o-mini-tts" : null,
      processing: "cloud",
      maxTextLength: SPEECH_TEXT_LENGTH,
    });
  const { rerender } = render(
    <SpokenRepliesCard
      language="en"
      enabled
      onChange={change}
      capabilities={capabilities(false)}
    />,
  );
  // Without voice output there is no switch to look switched on.
  expect(screen.queryByLabelText("Spoken replies")).toBeNull();
  expect(screen.getByText("Not available")).toBeTruthy();
  rerender(
    <SpokenRepliesCard
      language="en"
      enabled
      onChange={change}
      capabilities={capabilities(true)}
    />,
  );
  expect(screen.getByLabelText("Spoken replies").props.value).toBe(true);
  expect(change).not.toHaveBeenCalled();
});
