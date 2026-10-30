import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { VoiceComposer } from "../packages/ui-catalog/VoiceComposer";
const props = {
  language: "en" as const,
  stage: "recording" as const,
  text: "",
  onStart: jest.fn(),
  onStop: jest.fn(),
  onUpload: jest.fn(),
  onEdit: jest.fn(),
  onSend: jest.fn(),
  onCancel: jest.fn(),
};
afterEach(() => jest.clearAllMocks());
test("recording composer exposes completion and cancellation, never starts or sends on render", () => {
  render(<VoiceComposer {...props} level={0.7} />);
  expect(screen.getByText("Listening")).toBeTruthy();
  expect(screen.queryByLabelText("Recognized text")).toBeNull();
  expect(screen.queryByText(/0:20|Done transcribes/)).toBeNull();
  expect(props.onStart).not.toHaveBeenCalled();
  expect(props.onSend).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Done" }));
  expect(props.onStop).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole("button", { name: "Discard voice draft" }));
  expect(props.onCancel).toHaveBeenCalledTimes(1);
});
test("uncertain transcript remains editable in composer and empty text cannot send", () => {
  const { rerender } = render(
    <VoiceComposer
      {...props}
      language="cs"
      stage="review"
      text=""
      reviewReasons={["uncertain"]}
    />,
  );
  fireEvent.press(screen.getByRole("button", { name: "Odeslat text" }));
  expect(props.onSend).not.toHaveBeenCalled();
  fireEvent.changeText(
    screen.getByLabelText("Rozpoznaný text"),
    "Opravený požadavek",
  );
  expect(props.onEdit).toHaveBeenCalledWith("Opravený požadavek");
  rerender(
    <VoiceComposer
      {...props}
      language="cs"
      stage="review"
      text="Opravený požadavek"
    />,
  );
  fireEvent.press(screen.getByRole("button", { name: "Odeslat text" }));
  expect(props.onSend).toHaveBeenCalledTimes(1);
});
test("failed transcription needs explicit retry and does not reopen the microphone", () => {
  render(
    <VoiceComposer
      {...props}
      stage="recorded"
      error="voice_processing_failed"
    />,
  );
  expect(props.onUpload).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Start recording" })).toBeNull();
  expect(props.onStart).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Retry transcription" }));
  expect(props.onUpload).toHaveBeenCalledTimes(1);
});

test.each(["starting", "stopping", "transcribing"] as const)(
  "%s names the actual state without implying the microphone is still recording",
  (stage) => {
    render(<VoiceComposer {...props} stage={stage} />);
    expect(screen.queryByTestId("voice-waveform")).toBeNull();
    const status = {
      starting: "Requesting microphone…",
      stopping: "Stopping microphone…",
      transcribing: "Transcribing…",
    };
    expect(screen.getByText(status[stage])).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Start recording" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(props.onStart).not.toHaveBeenCalled();
    fireEvent.press(
      screen.getByRole("button", { name: "Discard voice draft" }),
    );
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  },
);

test("recording errors appear outside the unchanged composer", () => {
  render(<VoiceComposer {...props} stage="idle" error="voice_permission" />);
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(
    screen
      .getByTestId("voice-composer")
      .findAllByProps({ accessibilityRole: "alert" }),
  ).toHaveLength(0);
});

test("review makes room for editable text and removes the recording pet and meter", () => {
  const { rerender } = render(<VoiceComposer {...props} elapsedSeconds={18} />);
  expect(screen.getAllByTestId("voice-pet")).toHaveLength(1);
  expect(screen.getByText("0:18")).toBeTruthy();
  rerender(<VoiceComposer {...props} stage="review" text="My request" />);
  expect(screen.queryByTestId("voice-pet")).toBeNull();
  expect(screen.queryByTestId("voice-waveform")).toBeNull();
  expect(screen.queryByText("0:18")).toBeNull();
  expect(screen.getByLabelText("Recognized text")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Discard voice draft" }),
  ).toBeTruthy();
});
