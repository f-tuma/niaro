import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { RecoveryCard } from "../spikes/audio/RecoveryCard";
import type { RecoveryCandidate } from "../spikes/audio/journal";
const candidate: RecoveryCandidate = {
  uri: "file:///documents/example.m4a",
  bytes: 2048,
  reason: "unfinished",
  status: "unchecked",
};
test("recovery render is passive and offers keep only after file check", () => {
  const props = {
    candidate,
    language: "en" as const,
    onCheck: jest.fn(),
    onRecover: jest.fn(),
    onIgnore: jest.fn(),
  };
  const { rerender } = render(<RecoveryCard {...props} />);
  expect(props.onCheck).not.toHaveBeenCalled();
  expect(props.onRecover).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Keep recovered portion" }),
  ).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Check file" }));
  expect(props.onCheck).toHaveBeenCalledTimes(1);
  rerender(
    <RecoveryCard
      {...props}
      candidate={{ ...candidate, status: "ready", durationMillis: 4000 }}
    />,
  );
  fireEvent.press(
    screen.getByRole("button", { name: "Keep recovered portion" }),
  );
  expect(props.onRecover).toHaveBeenCalledTimes(1);
});
test("Czech unreadable state keeps retry and hide controls, disabled during another operation", () => {
  const props = {
    candidate: { ...candidate, status: "unreadable" as const },
    language: "cs" as const,
    onCheck: jest.fn(),
    onRecover: jest.fn(),
    onIgnore: jest.fn(),
  };
  const { rerender } = render(<RecoveryCard {...props} busy />);
  expect(screen.getByText(/Soubor se nepodařilo načíst/)).toBeTruthy();
  fireEvent.press(
    screen.getByRole("button", { name: "Skrýt a ponechat soubor" }),
  );
  expect(props.onIgnore).not.toHaveBeenCalled();
  rerender(<RecoveryCard {...props} />);
  fireEvent.press(
    screen.getByRole("button", { name: "Skrýt a ponechat soubor" }),
  );
  expect(props.onIgnore).toHaveBeenCalledTimes(1);
});
