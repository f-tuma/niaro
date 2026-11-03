import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { resetChatSession } from "../apps/mobile/chat-session";
import { companionCopy } from "../apps/mobile/companion-copy";
import { translate } from "../packages/i18n";
import type { SessionCommand } from "../packages/client-core/session";
import { chatFixture, flush } from "./helpers/mobile-chat-fixture";

/*
 * NIAR-279: a request that failed is not stopped. Its chat keeps it with
 * Retry and Dismiss, the composer is back to the microphone, and no other
 * screen offers a Retry of its own.
 */
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
jest.mock("expo-crypto", () => ({ randomUUID: () => "TEST-failed-command" }));
jest.mock("../apps/mobile/ReplySpeech", () => ({
  useReplySpeech: () => ({
    player: { stop: jest.fn(), waitForReply: jest.fn() },
    state: { phase: "idle" },
    enabled: false,
  }),
}));

const tr = translate("en");
const failedSend: SessionCommand = {
  type: "message.send",
  commandId: "TEST-failed-C",
  idempotencyKey: "TEST-failed-C",
  conversationId: "TEST-A",
  text: "TEST find Peter",
  language: "en",
};
const stop = () =>
  screen.queryByRole("button", { name: tr("progressInterrupt") });
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

beforeEach(() => {
  jest.clearAllMocks();
  resetChatSession();
});

test.each([
  "model_unavailable",
  "model_limit",
  "network_error",
  "storage_error",
])(
  "after %s the composer leaves Stop and the chat offers Retry and Dismiss",
  async (error) => {
    const f = chatFixture();
    render(<f.Harness />);
    await act(flush);
    await openChat();
    // While the request runs, the composer's button stops it.
    await act(async () =>
      f.publish({ pending: failedSend, commandStates: { chat: "sending" } }),
    );
    expect(stop()).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: tr("progressDismiss") }),
    ).toBeNull();
    // It failed: nothing runs, so there is nothing to stop.
    await act(async () =>
      f.publish({
        commandStates: {
          chat: error === "storage_error" ? "accepted" : "network_error",
        },
        error,
      }),
    );
    expect(stop()).toBeNull();
    // The microphone is back where Stop was.
    expect(
      screen.queryByRole("button", { name: tr("voice_reply") }) ??
        screen.queryByRole("button", { name: tr("voiceSettingsAction") }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: tr("progressRetry") }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: tr("progressDismiss") }),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", { name: tr("progressRetry") }),
      );
      await flush();
    });
    expect(f.session.retry).toHaveBeenCalledTimes(1);
    expect(f.session.interruptPending).not.toHaveBeenCalled();
  },
);

test("Dismiss lets go of the failed request and puts its text back in the composer", async () => {
  const f = chatFixture();
  f.session.discardPending.mockImplementation(async () => {
    f.publish({ pending: null, commandStates: { chat: "idle" }, error: null });
    return true;
  });
  render(<f.Harness />);
  await act(flush);
  await openChat();
  await act(async () =>
    f.publish({
      pending: failedSend,
      commandStates: { chat: "network_error" },
      error: "model_unavailable",
    }),
  );
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: tr("progressDismiss") }),
    );
    await flush();
  });
  expect(f.session.discardPending).toHaveBeenCalledTimes(1);
  expect(f.session.send).not.toHaveBeenCalled();
  expect(f.session.retry).not.toHaveBeenCalled();
  expect(screen.queryByTestId("request-progress")).toBeNull();
  expect(
    screen.queryByRole("button", { name: tr("progressDismiss") }),
  ).toBeNull();
  expect(screen.getByLabelText("Type a message…").props.value).toBe(
    "TEST find Peter",
  );
  expect(screen.getByRole("button", { name: tr("send") })).toBeTruthy();
});

test("a Dismiss the server cannot confirm keeps Retry and Dismiss", async () => {
  const f = chatFixture();
  f.session.discardPending.mockImplementation(async () => {
    f.publish({ error: "requestInterruptFailed" });
    return false;
  });
  render(<f.Harness />);
  await act(flush);
  await openChat();
  await act(async () =>
    f.publish({
      pending: failedSend,
      commandStates: { chat: "network_error" },
      error: "model_unavailable",
    }),
  );
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: tr("progressDismiss") }),
    );
    await flush();
  });
  expect(screen.getByText(tr("requestInterruptFailed"))).toBeTruthy();
  expect(stop()).toBeNull();
  expect(
    screen.getByRole("button", { name: tr("progressRetry") }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: tr("progressDismiss") }),
  ).toBeTruthy();
  expect(screen.getByLabelText("Type a message…").props.value).toBe("");
});

test("other screens offer no Retry of the chat's failed message", async () => {
  const f = chatFixture();
  render(<f.Harness />);
  await act(flush);
  await openChat();
  await act(async () =>
    f.publish({
      pending: failedSend,
      commandStates: { chat: "network_error" },
      error: "model_unavailable",
    }),
  );
  for (const tab of [
    tr("meetings"),
    companionCopy("en").tasks,
    companionCopy("en").library,
  ]) {
    await act(async () => {
      fireEvent.press(screen.getByRole("tab", { name: tab }));
      await flush();
    });
    expect(screen.queryByRole("button", { name: tr("retry") })).toBeNull();
    expect(
      screen.queryByRole("button", { name: tr("progressDismiss") }),
    ).toBeNull();
  }
});
