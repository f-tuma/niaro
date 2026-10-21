import { authInfo, credential } from "./auth-fixtures";
import React from "react";
import { render, fireEvent, screen } from "@testing-library/react-native";
import {
  ConnectionCard,
  type ConnectionCardProps,
} from "../packages/ui-catalog/ConnectionCard";
const props = (): ConnectionCardProps => ({
  language: "en",
  address: "https://server.example/v1/a",
  activeAddress: null,
  status: "signed_out",
  identity: null,
  error: null,
  development: false,
  web: false,
  onAddress: jest.fn(),
  onPair: jest.fn(),
  onDisconnect: jest.fn(),
});
test("account login needs only a server address and an explicit continue", () => {
  const p = props(),
    start = jest.fn();
  render(<ConnectionCard {...p} onBrowserSignIn={start} />);
  expect(screen.queryByLabelText("Pairing code")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Use a backup pairing code" }),
  ).toBeNull();
  fireEvent.changeText(
    screen.getByLabelText("Server address"),
    "https://different.example",
  );
  expect(p.onAddress).toHaveBeenCalledWith("https://different.example");
  expect(start).not.toHaveBeenCalled();
  fireEvent.press(
    screen.getByRole("button", { name: "Continue with account" }),
  );
  expect(start).toHaveBeenCalledTimes(1);
  expect(p.onPair).not.toHaveBeenCalled();
});
test("CS expiry and web retention are explained; pairing state prevents duplicate submission", () => {
  const p = props();
  const { rerender } = render(
    <ConnectionCard {...p} language="cs" status="expired" web />,
  );
  expect(screen.getByText(/Relace skončila/)).toBeTruthy();
  expect(screen.getByText(/přihlášení vydrží do obnovení/)).toBeTruthy();
  rerender(<ConnectionCard {...p} status="pairing" />);
  expect(
    screen.getByRole("button", { name: "Continue with account" }).props
      .accessibilityState.disabled,
  ).toBe(true);
  fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
  expect(p.onDisconnect).toHaveBeenCalledTimes(1);
});

test("connected settings tuck pairing away and expose errors without hiding connection controls", () => {
  const p = props();
  const identity = authInfo(credential());
  render(
    <ConnectionCard
      {...p}
      status="connected"
      identity={identity}
      error="connection_failed"
    />,
  );
  expect(screen.queryByLabelText("Pairing code")).toBeNull();
  expect(screen.getByText(/Can't reach the server/)).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: "Change connection" }));
  expect(screen.getByLabelText("Server address")).toBeTruthy();
  expect(p.onPair).not.toHaveBeenCalled();
});
test("legacy polling codes are never exposed by the new login card", () => {
  const p = props();
  render(
    <ConnectionCard
      {...p}
      status="pairing"
      onBrowserSignIn={jest.fn()}
      browserLogin={{
        userCode: "ABCD1234EF56",
        verificationUri: "https://server.example/admin/device#ABCD1234EF56",
        expiresAt: "2099-01-01T00:00:00Z",
      }}
    />,
  );
  expect(screen.queryByText("ABCD · 1234 · EF56")).toBeNull();
  expect(screen.queryByLabelText("Pairing code")).toBeNull();
});
test("a stored sign-in does not claim the workspace data is connected while offline", () => {
  const p = props();
  const identity = authInfo(credential());
  const ui = render(
    <ConnectionCard
      {...p}
      status="connected"
      identity={identity}
      sessionStatus="offline"
    />,
  );
  expect(screen.getByText("Signed in · data unavailable")).toBeTruthy();
  expect(screen.queryByText("Connected")).toBeNull();
  ui.rerender(
    <ConnectionCard
      {...p}
      status="connected"
      identity={identity}
      sessionStatus="online"
    />,
  );
  expect(screen.getByText("Connected")).toBeTruthy();
});
