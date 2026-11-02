import React, { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { setStringAsync } from "expo-clipboard";
import { Workspace } from "../apps/mobile/App";
import { ChatSearchScreen } from "../apps/mobile/ChatSearch";
import { Composer, type Section } from "../apps/mobile/ScreenChrome";
import { attachmentSendReason } from "../apps/mobile/chat/composer";
import { projectThread, type ChatMessage } from "../apps/mobile/chat/thread";
import { resetChatSession } from "../apps/mobile/chat-session";
import type {
  ClientSession,
  SessionCommand,
  SessionState,
} from "../packages/client-core/session";
import { fromSnapshot } from "../packages/client-core/store";
import { emptySnapshot } from "../packages/test-fixtures";
import {
  CONVERSATION_HISTORY_PROFILE,
  type ConversationSummary,
} from "../packages/protocol";
import { CHAT_SEARCH_PROFILE } from "../packages/protocol/chat-search";

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
jest.mock("expo-crypto", () => ({ randomUUID: () => "TEST-parity-command" }));
jest.mock("../apps/mobile/ReplySpeech", () => ({
  useReplySpeech: () => ({
    player: { stop: jest.fn(), waitForReply: jest.fn() },
    state: { phase: "idle" },
    enabled: false,
  }),
}));

const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
const local = (value: string) => new Date(value).toISOString();
const messages: ChatMessage[] = [
  {
    id: "TEST-u1",
    role: "user",
    text: "TEST first question",
    createdAt: local("2026-11-01T10:00:00"),
  },
  {
    id: "TEST-a1",
    role: "assistant",
    text: "TEST first answer",
    createdAt: local("2026-11-01T10:01:00"),
  },
  {
    id: "TEST-u2",
    role: "user",
    text: "TEST second question",
    createdAt: local("2026-11-02T09:00:00"),
  },
  {
    id: "TEST-a2",
    role: "assistant",
    text: "TEST **second** answer",
    createdAt: local("2026-11-02T09:01:00"),
  },
];
const summary: ConversationSummary = {
  id: "TEST-A",
  title: "TEST chat",
  revision: 1,
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-02T08:01:00.000Z",
  messageCount: 4,
  readOnly: false,
};

/** One chat of four messages from yesterday and today; `paged` splits it. */
function fixture(paged = false) {
  const snapshot = emptySnapshot();
  snapshot.conversations.push({ id: "TEST-A", revision: 1, messages });
  let state: SessionState = {
    store: fromSnapshot("https://fixture.test/v1/a", snapshot.scope, snapshot),
    status: "online",
    pending: null,
    processPending: null,
    answerAttempts: [],
    answerRecoveryBlocked: false,
    commandStates: {},
    error: null,
    activity: null,
    activityConnection: "waiting",
  };
  const listeners = new Set<() => void>();
  const page = (part: ChatMessage[], nextAfter: string | null) => ({
    profile: CONVERSATION_HISTORY_PROFILE,
    scope: snapshot.scope,
    conversation: summary,
    messages: part,
    nextAfter,
  });
  const session = {
    identityKey: "TEST-server/alice/workspace-a",
    getSnapshot: () => state,
    subscribe: (r: () => void) => {
      listeners.add(r);
      return () => listeners.delete(r);
    },
    start: jest.fn(async () => {}),
    stop: jest.fn(),
    refresh: jest.fn(async () => {}),
    selectConversation: jest.fn(),
    readConversations: jest.fn(async () => ({
      profile: CONVERSATION_HISTORY_PROFILE,
      scope: snapshot.scope,
      conversations: [summary],
      nextAfter: null,
    })),
    readConversation: jest.fn(async (_id: string, after?: string | null) =>
      !paged
        ? page(messages, null)
        : after === "TEST-older"
          ? page(messages.slice(0, 2), null)
          : page(messages.slice(2), "TEST-older"),
    ),
    searchConversations: jest.fn(async () => ({
      profile: CHAT_SEARCH_PROFILE,
      scope: snapshot.scope,
      results: [
        {
          conversation: {
            id: "TEST-A",
            title: "TEST chat",
            updatedAt: summary.updatedAt,
            archived: false,
          },
          titleRanges: [],
          matches: [
            {
              messageId: "TEST-u1",
              role: "user",
              snippet: "TEST first question",
              ranges: [],
            },
          ],
          matchCount: 1,
        },
      ],
      nextAfter: null,
    })),
    send: jest.fn((command: SessionCommand) => {
      state = { ...state, pending: command };
      listeners.forEach((r) => r());
      return new Promise<void>(() => {});
    }),
    retry: jest.fn(async () => {}),
    interruptPending: jest.fn(async () => true),
  };
  function Harness() {
    const [section, setSection] = useState<Section>("chat");
    return (
      <Workspace
        session={session as unknown as ClientSession}
        language="en"
        section={section}
        setSection={setSection}
        settings={null}
        authError={null}
        spokenReplies={false}
      />
    );
  }
  return { session, Harness };
}

const menu = async () => {
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Menu" }));
    await flush();
  });
};
const openChat = async () => {
  await menu();
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "TEST chat" }));
    await flush();
  });
};
const composer = () => screen.getByLabelText("Type a message…");

beforeEach(() => {
  jest.clearAllMocks();
  resetChatSession();
  // Only the clock is fixed; timers and frames run as usual.
  jest.useFakeTimers({
    now: new Date("2026-11-02T15:00:00"),
    doNotFake: [
      "hrtime",
      "nextTick",
      "performance",
      "queueMicrotask",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
    ],
  });
});
afterEach(() => jest.useRealTimers());

test("each message shows its time and Copy, and a divider starts each day", async () => {
  const f = fixture();
  render(<f.Harness />);
  await act(flush);
  await openChat();
  expect(
    screen
      .getAllByTestId("day-separator")
      .map((d) => d.props.accessibilityLabel),
  ).toEqual(["Yesterday", "Today"]);
  expect(screen.getAllByTestId("message-meta")).toHaveLength(4);
  expect(
    screen.getByText(
      new Date(messages[3]!.createdAt!).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    ),
  ).toBeTruthy();
  const copies = screen.getAllByRole("button", { name: "Copy" });
  expect(copies).toHaveLength(4);
  await act(async () => {
    fireEvent.press(copies[3]!);
    await flush();
  });
  // The answer as written, Markdown included.
  expect(setStringAsync).toHaveBeenCalledWith("TEST **second** answer");
  expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  expect(f.session.send).not.toHaveBeenCalled();
});

test("Edit puts only the latest request back in the composer and sends nothing", async () => {
  const f = fixture();
  render(<f.Harness />);
  await act(flush);
  await openChat();
  const edits = screen.getAllByRole("button", { name: "Edit" });
  expect(edits).toHaveLength(1);
  await act(async () => {
    fireEvent.press(edits[0]!);
    await flush();
  });
  expect(composer().props.value).toBe("TEST second question");
  expect(f.session.send).not.toHaveBeenCalled();
});

test("Again sends the latest request once more and leaves what is typed", async () => {
  const f = fixture();
  render(<f.Harness />);
  await act(flush);
  await openChat();
  fireEvent.changeText(composer(), "TEST typing");
  const again = screen.getAllByRole("button", { name: "Again" });
  expect(again).toHaveLength(1);
  await act(async () => {
    fireEvent.press(again[0]!);
    await flush();
  });
  expect(f.session.send).toHaveBeenCalledTimes(1);
  expect(f.session.send.mock.calls[0]![0]).toMatchObject({
    type: "message.send",
    conversationId: "TEST-A",
    text: "TEST second question",
  });
  expect(composer().props.value).toBe("TEST typing");
});

test("a search hit opens the chat at an older message and outlines it", async () => {
  const f = fixture(true);
  render(<f.Harness />);
  await act(flush);
  await menu();
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Search" }));
    await flush();
  });
  fireEvent.changeText(screen.getByTestId("chat-search-input"), "first");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flush();
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "TEST chat" }));
    await flush();
  });
  await act(flush);
  // The newest page, then the older one the message is on.
  expect(f.session.readConversation).toHaveBeenCalledTimes(2);
  expect(f.session.readConversation.mock.calls[1]![1]).toBe("TEST-older");
  expect(screen.getByText("TEST first question")).toBeTruthy();
  expect(screen.getByTestId("message-highlight")).toBeTruthy();
});

test("under All, matching meetings follow the chats and open the meeting", async () => {
  const readMeetings = jest.fn(async () => ({
    meetings: [
      {
        id: "TEST-meeting",
        title: "TEST weekly",
        recordedAt: "2026-10-30T09:00:00.000Z",
      },
    ],
    matches: [
      {
        meetingId: "TEST-meeting",
        field: "transcript",
        snippet: "budget for November",
        at: 95,
      },
    ],
  }));
  const session = {
    identityKey: "alice",
    readConversations: jest.fn(async () => ({
      conversations: [],
      nextAfter: null,
    })),
    searchConversations: jest.fn(async () => ({
      results: [],
      nextAfter: null,
    })),
    readMeetings,
  } as unknown as ClientSession;
  const onOpenMeeting = jest.fn();
  render(
    <ChatSearchScreen
      session={session}
      language="cs"
      online
      onClose={() => {}}
      onOpen={() => {}}
      onOpenMeeting={onOpenMeeting}
    />,
  );
  await act(flush);
  fireEvent.changeText(screen.getByTestId("chat-search-input"), "budget");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flush();
  });
  expect(readMeetings).toHaveBeenCalledWith({ query: "budget" });
  expect(screen.getByText("Schůzky")).toBeTruthy();
  expect(screen.getByText("1:35 budget for November")).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: "TEST weekly" }));
  expect(onOpenMeeting).toHaveBeenCalledWith("TEST-meeting");
});

test("archived chats offer no Edit and no Again; Again only under the newest answer", () => {
  const project = (list: ChatMessage[], readOnly = false) =>
    projectThread({
      messages: list,
      work: [],
      anchors: new Map(),
      referencedWork: new Set(),
      readOnly,
      now: new Date("2026-11-02T15:00:00"),
    });
  const archived = project(messages, true);
  expect(archived.some((entry) => entry.editable || entry.again)).toBe(false);
  const open = project(messages);
  expect(
    open.filter((entry) => entry.editable).map((e) => e.message.id),
  ).toEqual(["TEST-u2"]);
  expect(open.at(-1)!.again?.id).toBe("TEST-u2");
  // A request still waiting for its answer: no Again anywhere.
  expect(project(messages.slice(0, 3)).some((entry) => entry.again)).toBe(
    false,
  );
});

test("Send says why it waits for an attachment", () => {
  expect(attachmentSendReason([{ state: "uploading" }], false)).toBe(
    "attachmentWait",
  );
  expect(
    attachmentSendReason([{ state: "uploaded" }, { state: "failed" }], false),
  ).toBe("attachmentFailedSend");
  expect(attachmentSendReason([{ state: "uploaded" }], true)).toBeUndefined();
  expect(attachmentSendReason([], false)).toBeUndefined();
  const send = jest.fn();
  render(
    <Composer
      language="cs"
      value="TEST caption"
      onChange={() => {}}
      onSend={send}
      onVoice={() => {}}
      hasAttachments
      sendBlocked
      sendBlockedReason="Počkej na přílohu"
      disabled={false}
    />,
  );
  expect(screen.getByTestId("composer-send-reason")).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: "Počkej na přílohu" }));
  expect(send).not.toHaveBeenCalled();
});
