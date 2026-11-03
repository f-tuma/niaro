import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { resetChatSession } from "../apps/mobile/chat-session";
import { companionCopy } from "../apps/mobile/companion-copy";
import { OtherChatNotice } from "../apps/mobile/chat/OtherChatNotice";
import { translate } from "../packages/i18n";
import type { SessionCommand } from "../packages/client-core/session";
import { chatFixture, flush } from "./helpers/mobile-chat-fixture";
import { AppState } from "react-native";
import { createVoiceCapture } from "../apps/mobile/voice-capture";
import { microphoneAllowed } from "../apps/mobile/microphone-permission";
import { voiceCapabilities } from "../packages/protocol/voice";

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

test("NIAR-286: Dismiss lets go of the failed request and the composer stays empty", async () => {
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
  // Sent words never go back to the composer.
  expect(screen.getByLabelText("Type a message…").props.value).toBe("");
  expect(screen.queryByRole("button", { name: tr("send") })).toBeNull();
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

const composerValue = () =>
  screen.getByLabelText("Type a message…").props.value;
const typeAndSend = async (text: string) => {
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText("Type a message…"), text);
    await flush();
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: tr("send") }));
    await flush();
  });
};

/** Nothing in the chat calls the result unconfirmed or offers to check it. */
const noUnconfirmedCard = () => {
  for (const words of [
    /Result not confirmed/,
    /Výsledek není potvrzený/,
    /Status unavailable/,
    /Stav není dostupný/,
    /Check result/,
    /Ověřit výsledek/,
    /Delivery unclear/,
    /Doručení je nejisté/,
  ])
    expect(screen.queryByText(words)).toBeNull();
  expect(
    screen.queryByRole("button", { name: tr("progressRetry") }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: tr("progressDismiss") }),
  ).toBeNull();
};

test.each([true, false])(
  "NIAR-280: an answer lost mid-way shows no card while the session checks it (online: %s); the answer then simply appears",
  async (online) => {
    const f = chatFixture();
    f.session.send.mockImplementation(async (command: SessionCommand) => {
      f.publish({
        pending: command,
        commandStates: { chat: "network_error" },
        error: null,
        deliveryCheck: "checking",
      });
    });
    render(<f.Harness />);
    await act(flush);
    await openChat();
    await typeAndSend("TEST lost autumn poem");
    if (!online)
      await act(async () =>
        f.publish({ status: "offline", error: "connection_failed" }),
      );
    // The quiet Thinking line, the words kept, nothing to press.
    expect(screen.getByTestId("request-progress")).toBeTruthy();
    expect(screen.getByText(tr("progressThinking"))).toBeTruthy();
    expect(screen.queryByText(tr("progressFailed"))).toBeNull();
    expect(screen.getByText("TEST lost autumn poem")).toBeTruthy();
    noUnconfirmedCard();
    expect(composerValue()).toBe("");
    // The check came back with the answer.
    const store = f.session.getSnapshot().store!;
    const chat = store.conversations["TEST-A"]!;
    await act(async () =>
      f.publish({
        status: "online",
        error: null,
        pending: null,
        deliveryCheck: null,
        commandStates: { chat: "accepted" },
        store: {
          ...store,
          conversations: {
            ...store.conversations,
            "TEST-A": {
              ...chat,
              revision: chat.revision + 1,
              messages: [
                ...chat.messages,
                {
                  id: "message-TEST-failed-command-user",
                  logicalMessageId: "TEST-failed-command",
                  role: "user",
                  text: "TEST lost autumn poem",
                  createdAt: new Date().toISOString(),
                },
                {
                  id: "message-TEST-failed-command-assistant",
                  role: "assistant",
                  text: "TEST the poem",
                  replyToCommandId: "TEST-failed-command",
                  createdAt: new Date().toISOString(),
                },
              ],
            },
          },
        },
      }),
    );
    await act(flush);
    expect(screen.getByText("TEST the poem")).toBeTruthy();
    expect(screen.queryByTestId("request-progress")).toBeNull();
    noUnconfirmedCard();
    expect(f.session.retry).not.toHaveBeenCalled();
    expect(composerValue()).toBe("");
  },
);

test("NIAR-280: with no activity feed, a lost answer being checked offers no Stop, Retry, Dismiss or unconfirmed words (EN or CS)", async () => {
  const f = chatFixture();
  render(<f.Harness />);
  await act(flush);
  await openChat();
  await act(async () =>
    f.publish({
      pending: failedSend,
      commandStates: { chat: "network_error" },
      error: null,
      deliveryCheck: "checking",
      activityConnection: "unavailable",
    }),
  );
  noUnconfirmedCard();
  expect(screen.getByTestId("request-progress")).toBeTruthy();
  expect(stop()).toBeNull();
});

test("a message whose answer was lost stays out of the composer, through a confirmed Dismiss too (NIAR-286)", async () => {
  const f = chatFixture();
  // The connection dropped mid-answer: the session keeps the exact command
  // and checks it by itself.
  f.session.send.mockImplementation(async (command: SessionCommand) => {
    f.publish({
      pending: command,
      commandStates: { chat: "network_error" },
      error: null,
      deliveryCheck: "checking",
    });
  });
  f.session.discardPending.mockImplementation(async () => {
    f.publish({ pending: null, commandStates: { chat: "idle" }, error: null });
    return true;
  });
  render(<f.Harness />);
  await act(flush);
  await openChat();
  await typeAndSend("TEST lost autumn poem");
  expect(f.session.send).toHaveBeenCalledTimes(1);
  // Not unsent: sending it again could repeat it.
  expect(composerValue()).toBe("");
  expect(stop()).toBeNull();
  noUnconfirmedCard();
  // The check found that it did not finish: an ordinary failed message.
  await act(async () =>
    f.publish({ deliveryCheck: "failed", error: "model_unavailable" }),
  );
  expect(screen.getByText(tr("progressFailed"))).toBeTruthy();
  expect(composerValue()).toBe("");
  expect(
    screen.getByRole("button", { name: tr("progressRetry") }),
  ).toBeTruthy();
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: tr("progressDismiss") }),
    );
    await flush();
  });
  expect(f.session.discardPending).toHaveBeenCalledTimes(1);
  expect(composerValue()).toBe("");
  expect(f.session.send).toHaveBeenCalledTimes(1);
});

/** A send the session takes at once (pending), settled later by `settle`. */
const takenSend = (f: ReturnType<typeof chatFixture>) => {
  let settle!: (patch: Parameters<typeof f.publish>[0]) => void;
  f.session.send.mockImplementation((command: SessionCommand) => {
    f.publish({ pending: command, commandStates: { chat: "sending" } });
    return new Promise<void>((resolve) => {
      settle = (patch) => {
        f.publish(patch);
        resolve();
      };
    });
  });
  return {
    settle: async (patch: Parameters<typeof f.publish>[0]) =>
      act(async () => {
        settle(patch);
        await flush();
      }),
  };
};
const sentCommand = (f: ReturnType<typeof chatFixture>) =>
  f.session.send.mock.calls[0]![0] as Extract<
    SessionCommand,
    { type: "message.send" }
  >;
/** No Send button turning while a request is pending or checked. */
const noSendSpinner = () => {
  const send = screen.queryByRole("button", { name: tr("send") });
  if (send) expect(send.props.accessibilityState?.busy).toBeFalsy();
};

test("NIAR-286: a message the server refused stays in the chat as failed with Try again; the composer stays empty", async () => {
  const f = chatFixture();
  const send = takenSend(f);
  render(<f.Harness />);
  await act(flush);
  await openChat();
  await typeAndSend("TEST refused question");
  expect(composerValue()).toBe("");
  const command = sentCommand(f);
  await send.settle({
    pending: null,
    commandStates: { chat: "rejected" },
    error: "catalog_conflict",
    failedMessages: [{ command, error: "catalog_conflict" }],
  });
  expect(composerValue()).toBe("");
  expect(screen.getByTestId("failed-message")).toBeTruthy();
  expect(screen.getByText("TEST refused question")).toBeTruthy();
  expect(screen.getByText(/Not sent\./)).toBeTruthy();
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: tr("progressRetry") }));
    await flush();
  });
  expect(f.session.retryFailedMessage).toHaveBeenCalledWith(
    command.commandId,
    expect.any(String),
  );
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: tr("progressDismiss") }),
    );
    await flush();
  });
  expect(f.session.dismissFailedMessage).toHaveBeenCalledWith(
    command.commandId,
  );
  await act(async () => f.publish({ failedMessages: [] }));
  expect(screen.queryByTestId("failed-message")).toBeNull();
  expect(composerValue()).toBe("");
});

test("NIAR-286: a send the session did not take at all keeps its words in the composer", async () => {
  const f = chatFixture();
  // Not taken: nothing became pending, nothing left the phone.
  f.session.send.mockImplementation(async () => {});
  render(<f.Harness />);
  await act(flush);
  await openChat();
  await typeAndSend("TEST never left");
  expect(composerValue()).toBe("TEST never left");
});

test.each([
  [
    "refused",
    (command: SessionCommand) => ({
      pending: null,
      deliveryCheck: null,
      commandStates: { chat: "rejected" as const },
      error: "catalog_conflict",
      failedMessages: [
        {
          command: command as Extract<SessionCommand, { type: "message.send" }>,
          error: "catalog_conflict",
        },
      ],
    }),
  ],
  [
    "model error",
    () => ({
      commandStates: { chat: "network_error" as const },
      deliveryCheck: "failed" as const,
      error: "model_unavailable",
    }),
  ],
  [
    "checks gave up (timeouts)",
    () => ({
      commandStates: { chat: "network_error" as const },
      deliveryCheck: "failed" as const,
      error: null,
    }),
  ],
])(
  "NIAR-286, the owner's sequence: send, lost answer, background check, then %s; the composer never gets the words back and never shows a turning Send",
  async (_name, outcome) => {
    const f = chatFixture();
    const send = takenSend(f);
    render(<f.Harness />);
    await act(flush);
    await openChat();
    await typeAndSend("TEST owner's question");
    const command = sentCommand(f);
    expect(composerValue()).toBe("");
    // The answer was lost: the session keeps the command and checks it.
    await send.settle({
      commandStates: { chat: "network_error" },
      error: null,
      deliveryCheck: "checking",
    });
    // The background check posts it again: "sending", yet still a check.
    await act(async () =>
      f.publish({
        commandStates: { chat: "sending" },
        activityConnection: "waiting",
      }),
    );
    expect(composerValue()).toBe("");
    noSendSpinner();
    expect(screen.queryByRole("button", { name: tr("send") })).toBeNull();
    expect(stop()).toBeNull();
    expect(screen.getByText(tr("progressThinking"))).toBeTruthy();
    expect(screen.getByText("TEST owner's question")).toBeTruthy();
    noUnconfirmedCard();
    // Typing the next message meanwhile shows Send, never turning.
    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText("Type a message…"),
        "TEST next",
      );
      await flush();
    });
    noSendSpinner();
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText("Type a message…"), "");
      await flush();
    });
    // The check settles.
    await act(async () => f.publish(outcome(command)));
    expect(composerValue()).toBe("");
    noSendSpinner();
    expect(screen.getByText("TEST owner's question")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: tr("progressRetry") }),
    ).toBeTruthy();
    // Dismiss: the composer stays empty.
    if (_name === "refused") {
      await act(async () => {
        fireEvent.press(
          screen.getByRole("button", { name: tr("progressDismiss") }),
        );
        await flush();
      });
      expect(f.session.dismissFailedMessage).toHaveBeenCalledWith(
        command.commandId,
      );
      await act(async () => f.publish({ failedMessages: [] }));
    } else {
      f.session.discardPending.mockImplementation(async () => {
        f.publish({
          pending: null,
          deliveryCheck: null,
          commandStates: { chat: "idle" },
          error: null,
        });
        return true;
      });
      await act(async () => {
        fireEvent.press(
          screen.getByRole("button", { name: tr("progressDismiss") }),
        );
        await flush();
      });
      expect(f.session.discardPending).toHaveBeenCalledTimes(1);
    }
    expect(composerValue()).toBe("");
    expect(f.session.send).toHaveBeenCalledTimes(1);
  },
);

test("NIAR-286, the owner's report: a spoken message whose answer was lost never lands in the composer, and the background check shows no turning Send", async () => {
  const f = chatFixture();
  const send = takenSend(f);
  AppState.currentState = "active";
  microphoneAllowed();
  jest.mocked(createVoiceCapture).mockReturnValue({
    supported: () => true,
    start: jest.fn(async () => {}),
    stop: jest.fn(async () => ({
      mimeType: "audio/wav" as const,
      base64: "YWJjZA==",
    })),
    discard: jest.fn(async () => {}),
  });
  Object.assign(f.session, {
    voiceCapabilities: jest.fn(async () => voiceCapabilities(true)),
    transcribe: jest.fn(async () => ({
      text: "TEST spoken question",
      reviewReasons: [],
    })),
  });
  render(<f.Harness />);
  await act(flush);
  await openChat();
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: tr("voice_reply") }));
    await flush();
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Done" }));
    await flush();
  });
  expect(f.session.send).toHaveBeenCalledTimes(1);
  expect(sentCommand(f).text).toBe("TEST spoken question");
  // The answer was lost; before NIAR-286 the transcript went into the
  // composer here.
  await send.settle({
    commandStates: { chat: "network_error" },
    error: null,
    deliveryCheck: "checking",
  });
  expect(composerValue()).toBe("");
  // The background check posts it again: before, Send turned beside the text.
  await act(async () => f.publish({ commandStates: { chat: "sending" } }));
  expect(composerValue()).toBe("");
  expect(screen.queryByRole("button", { name: tr("send") })).toBeNull();
  expect(stop()).toBeNull();
  expect(screen.getByText(tr("progressThinking"))).toBeTruthy();
  expect(screen.getByText("TEST spoken question")).toBeTruthy();
  // Refused in the end: a failed message with Try again, the composer empty.
  await act(async () =>
    f.publish({
      pending: null,
      deliveryCheck: null,
      commandStates: { chat: "rejected" },
      error: "catalog_conflict",
      failedMessages: [{ command: sentCommand(f), error: "catalog_conflict" }],
    }),
  );
  expect(composerValue()).toBe("");
  expect(screen.getByTestId("failed-message")).toBeTruthy();
  expect(screen.getByText("TEST spoken question")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: tr("progressRetry") }),
  ).toBeTruthy();
});

test("offline, a request still on its way offers no Stop", async () => {
  const f = chatFixture();
  render(<f.Harness />);
  await act(flush);
  await openChat();
  await act(async () =>
    f.publish({
      pending: failedSend,
      commandStates: { chat: "sending" },
      status: "offline",
    }),
  );
  expect(stop()).toBeNull();
  await act(async () => f.publish({ status: "online" }));
  expect(stop()).toBeTruthy();
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

test.each([
  [
    "waiting",
    "network_error",
    "An unfinished request is waiting in another chat",
  ],
  ["running", "sending", "An answer is still running in another chat"],
] as const)(
  "another chat's %s message is named with Open, and Stop only while it runs",
  async (_name, commandState, line) => {
    const f = chatFixture();
    render(<f.Harness />);
    await act(flush);
    // The main chat is open; the message belongs to TEST-A.
    await act(async () =>
      f.publish({
        pending: failedSend,
        commandStates: { chat: commandState },
        error: commandState === "sending" ? null : "model_unavailable",
      }),
    );
    expect(screen.getByTestId("other-chat-busy")).toBeTruthy();
    expect(screen.getByText(line)).toBeTruthy();
    expect(stop()).toBeNull();
    const otherStop = screen.queryByRole("button", { name: "Stop" });
    if (commandState === "sending") {
      expect(otherStop).toBeTruthy();
      await act(async () => {
        fireEvent.press(otherStop!);
        await flush();
      });
      expect(f.session.interruptPending).toHaveBeenCalledTimes(1);
    } else expect(otherStop).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Open" }));
      await flush();
    });
    expect(f.session.readConversation).toHaveBeenCalledWith("TEST-A");
    // Now in its own chat: no line, and the chat's own controls.
    expect(screen.queryByTestId("other-chat-busy")).toBeNull();
    if (commandState === "sending") expect(stop()).toBeTruthy();
    else
      expect(
        screen.getByRole("button", { name: tr("progressDismiss") }),
      ).toBeTruthy();
    expect(f.session.send).not.toHaveBeenCalled();
  },
);

test("the other chat's line reads in Czech", () => {
  const onOpen = jest.fn();
  render(
    <OtherChatNotice
      language="cs"
      running={false}
      onOpen={onOpen}
      onStop={jest.fn()}
      disabled={false}
    />,
  );
  expect(
    screen.getByText("V jiném chatu čeká nedokončený požadavek"),
  ).toBeTruthy();
  // A request that no longer runs is not stopped from here.
  expect(screen.queryByRole("button", { name: "Zastavit" })).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Otevřít" }));
  expect(onOpen).toHaveBeenCalledTimes(1);
});
