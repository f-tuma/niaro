import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { VoiceReplyCard } from "../packages/ui-catalog/VoiceReplyCard";
const props = {
  language: "en" as const,
  stage: "idle" as const,
  address: "http://localhost:8793/v1/a",
  text: "Choose Peter Novak",
  onStart: jest.fn(),
  onStop: jest.fn(),
  onUpload: jest.fn(),
  onEdit: jest.fn(),
  onSend: jest.fn(),
  onCancel: jest.fn(),
};
afterEach(() => jest.clearAllMocks());
test("general voice starts only on press and explains auto-send before recording", () => {
  const { rerender } = render(<VoiceReplyCard {...props} />);
  expect(props.onStart).not.toHaveBeenCalled();
  expect(props.onSend).not.toHaveBeenCalled();
  expect(screen.getByText("New request")).toBeTruthy();
  expect(screen.getByText(/is sent automatically/)).toBeTruthy();
  expect(screen.queryByText(props.address)).toBeNull();
  fireEvent.press(
    screen.getByRole("button", { name: "How voice input works" }),
  );
  expect(screen.getByText(props.address)).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: "Start recording" }));
  expect(props.onStart).toHaveBeenCalledTimes(1);
  rerender(<VoiceReplyCard {...props} stage="recording" />);
  fireEvent.press(screen.getByRole("button", { name: "Done" }));
  expect(props.onStop).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("button", { name: "Retry transcription" }),
  ).toBeNull();
});
test("uncertain Czech transcript can be corrected or discarded and needs one explicit send", () => {
  render(
    <VoiceReplyCard
      {...props}
      language="cs"
      stage="review"
      reviewReasons={["uncertain"]}
      question="Kterého Petera myslíš?"
    />,
  );
  expect(screen.getByText("Kterého Petera myslíš?")).toBeTruthy();
  expect(props.onSend).not.toHaveBeenCalled();
  expect(screen.getByText(/Část řeči nebyla jasná/)).toBeTruthy();
  fireEvent.changeText(
    screen.getByLabelText("Rozpoznaný text"),
    "Vyber Petera Svobodu.",
  );
  expect(props.onEdit).toHaveBeenCalledWith("Vyber Petera Svobodu.");
  fireEvent.press(screen.getByRole("button", { name: "Odeslat text" }));
  expect(props.onSend).toHaveBeenCalledTimes(1);
});
test("time limit explains incomplete input; empty or blocked text cannot be sent", () => {
  const { rerender } = render(
    <VoiceReplyCard
      {...props}
      stage="review"
      text=" "
      reviewReasons={["limit"]}
    />,
  );
  expect(screen.getByText(/Stopped at 2 minutes/)).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: "Send text" }));
  expect(props.onSend).not.toHaveBeenCalled();
  rerender(<VoiceReplyCard {...props} stage="review" blocked />);
  fireEvent.press(screen.getByRole("button", { name: "Send text" }));
  expect(props.onSend).not.toHaveBeenCalled();
});
test("failed transcription offers explicit retry without starting it during render", () => {
  render(
    <VoiceReplyCard
      {...props}
      stage="recorded"
      error="voice_processing_failed"
    />,
  );
  expect(props.onUpload).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Retry transcription" }));
  expect(props.onUpload).toHaveBeenCalledTimes(1);
});
