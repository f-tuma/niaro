import React, { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Workspace } from "../apps/mobile/App";
import { ChatHistory } from "../apps/mobile/ChatHistory";
import { type Section } from "../apps/mobile/ScreenChrome";
import { resetChatSession } from "../apps/mobile/chat-session";
import {
  commandTarget,
  type ClientSession,
  type SessionState,
  type SessionCommand,
} from "../packages/client-core/session";
import { conversationPinsKey } from "../packages/client-core/conversation-preferences";
import { fromSnapshot } from "../packages/client-core/store";
import { emptySnapshot, nativeTaskQuestion } from "../packages/test-fixtures";
import {
  CONVERSATION_HISTORY_PROFILE,
  WorkItemSchema,
  type ConversationSummary,
  type ConversationHistoryPage,
} from "../packages/protocol";

jest.mock("../apps/mobile/voice-capture", () => ({
  createVoiceCapture: jest.fn(),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));
jest.mock("../apps/mobile/feedback", () => ({
  feedback: () => 0,
  setFeedbackEnabled: jest.fn(),
}));
jest.mock("../apps/mobile/app-login", () => ({
  loginProof: jest.fn(),
  authorizeApp: jest.fn(),
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => "TEST-mobile-command" }));
const mockStop = jest.fn();
jest.mock("../apps/mobile/ReplySpeech", () => ({
  useReplySpeech: () => ({
    player: { stop: mockStop, waitForReply: jest.fn() },
    state: { phase: "idle" },
    enabled: false,
  }),
}));
const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
};
/** Holds a chat row and returns its menu action (pin or unpin). */
const menuAction = async (title: string, name: "Pin chat" | "Unpin chat") => {
  await act(async () => {
    fireEvent(screen.getByRole("button", { name: title }), "longPress");
    await flush();
  });
  return screen.getByRole("menuitem", { name });
};
const choose = async (item: ReturnType<typeof screen.getByRole>) =>
  act(async () => {
    fireEvent.press(item);
    await flush();
  });
const summary = (id: string): ConversationSummary => ({
  id,
  title: `TEST chat ${id}`,
  revision: 1,
  createdAt: "2026-10-07T00:00:00.000Z",
  updatedAt: `2026-10-07T00:00:${id === "TEST-B" ? "02" : "01"}.000Z`,
  messageCount: 1,
  readOnly: false,
});

function fixture(unsupported = false, withWaitingNativeQuestion = false) {
  const snapshot = emptySnapshot();
  if (withWaitingNativeQuestion) snapshot.workItems.push(nativeTaskQuestion());
  snapshot.conversations.push(
    ...["TEST-A", "TEST-B"].map((id) => ({
      id,
      revision: 1,
      messages: [
        {
          id: `TEST-message-${id}`,
          role: "assistant" as const,
          text: `TEST stored ${id}`,
        },
      ],
    })),
  );
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
  const delivery = gate();
  const publish = (patch: Partial<SessionState>) => {
    state = { ...state, ...patch };
    listeners.forEach((r) => r());
  };
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
    readConversations: jest.fn(async (): Promise<ConversationHistoryPage> => {
      if (unsupported) throw Error("conversation_history_unavailable");
      return {
        profile: CONVERSATION_HISTORY_PROFILE,
        scope: snapshot.scope,
        conversations: [summary("TEST-A"), summary("TEST-B")],
        nextAfter: null,
      };
    }),
    readConversation: jest.fn(async (id: string) => ({
      profile: CONVERSATION_HISTORY_PROFILE,
      scope: snapshot.scope,
      conversation: {
        ...summary(id),
        revision: state.store!.conversations[id]!.revision,
      },
      messages: state.store!.conversations[id]!.messages,
      nextAfter: null,
    })),
    send: jest.fn((command: SessionCommand) => {
      if (command.type === "task.open") return Promise.resolve();
      publish({
        pending: command,
        commandStates: {
          ...state.commandStates,
          [commandTarget(command)]: "sending",
        },
      });
      return delivery.promise;
    }),
    retry: jest.fn(async () => {}),
    interruptPending: jest.fn(async () => true),
  };
  const settle = () => {
    const command = state.pending;
    if (command?.type === "conversation.create") {
      publish({
        pending: null,
        commandStates: {
          ...state.commandStates,
          [commandTarget(command)]: "accepted",
        },
        store: {
          ...state.store!,
          conversations: {
            ...state.store!.conversations,
            [command.conversationId]: {
              id: command.conversationId,
              revision: 1,
              messages: [],
            },
          },
        },
      });
      delivery.resolve();
      return;
    }
    if (!command || command.type !== "message.send")
      throw Error("TEST no send");
    const conversation = state.store!.conversations[command.conversationId]!;
    publish({
      pending: null,
      commandStates: {
        ...state.commandStates,
        [commandTarget(command)]: "accepted",
      },
      store: {
        ...state.store!,
        conversations: {
          ...state.store!.conversations,
          [conversation.id]: {
            ...conversation,
            revision: conversation.revision + 1,
            messages: [
              ...conversation.messages,
              {
                id: `message-${command.commandId}-user`,
                role: "user",
                text: command.text,
              },
            ],
          },
        },
      },
    });
    delivery.resolve();
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
  return { session, state: () => state, publish, settle, Harness };
}
const local = new Map<string, string>();
beforeEach(() => {
  jest.clearAllMocks();
  resetChatSession();
  local.clear();
  jest
    .mocked(AsyncStorage.getItem)
    .mockImplementation(async (key) => local.get(key) ?? null);
  jest.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
    local.set(key, value);
  });
});
const open = async () => {
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Menu" }));
    await flush();
  });
};
const select = async (id: string) => {
  await open();
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: `TEST chat ${id}` }));
    await flush();
  });
};

test("New chat stays on this device until its first message, which saves it before sending", async () => {
  const f = fixture();
  render(<f.Harness />);
  await act(flush);
  expect(f.session.readConversations).not.toHaveBeenCalled();
  const newChat = () => screen.getByRole("button", { name: "New chat" });
  expect(newChat().props.accessibilityState.disabled).toBe(false);
  await act(async () => {
    fireEvent.press(newChat());
    await flush();
  });
  // An empty chat never reaches the server.
  expect(f.session.send).not.toHaveBeenCalled();
  expect(f.session.selectConversation).toHaveBeenLastCalledWith(
    "chat-TEST-mobile-command",
  );
  // Already in a fresh chat: another one would be the same empty chat.
  expect(newChat().props.accessibilityState.disabled).toBe(true);
  fireEvent.changeText(
    screen.getByLabelText("Type a message…"),
    "TEST new input",
  );
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await flush();
  });
  expect(f.session.send).toHaveBeenCalledTimes(1);
  expect(f.session.send).toHaveBeenCalledWith({
    type: "conversation.create",
    conversationId: "chat-TEST-mobile-command",
    commandId: "TEST-mobile-command",
    idempotencyKey: "TEST-mobile-command",
  });
  await act(async () => {
    f.settle();
    await flush();
  });
  const command = f.session.send.mock.calls[1]![0];
  expect(command).toMatchObject({
    type: "message.send",
    conversationId: "chat-TEST-mobile-command",
    text: "TEST new input",
  });
  expect(command).not.toHaveProperty("session");
  expect(f.state().store!.conversations["TEST-A"]!.messages[0]!.text).toBe(
    "TEST stored TEST-A",
  );
});

test("header cannot create offline or while answer recovery is blocked", async () => {
  const f = fixture();
  f.publish({ status: "offline" });
  render(<f.Harness />);
  await act(flush);
  const newChat = () => screen.getByRole("button", { name: "New chat" });
  expect(newChat().props.accessibilityState.disabled).toBe(true);
  fireEvent.press(newChat());
  expect(f.session.send).not.toHaveBeenCalled();
  act(() => f.publish({ status: "online", answerRecoveryBlocked: true }));
  expect(newChat().props.accessibilityState.disabled).toBe(true);
  fireEvent.press(newChat());
  expect(f.session.send).not.toHaveBeenCalled();
});

test("a first message that cannot save its chat keeps the draft; the previous chat keeps its own", async () => {
  const f = fixture();
  render(<f.Harness />);
  await select("TEST-A");
  fireEvent.changeText(
    screen.getByLabelText("Type a message…"),
    "TEST keep draft",
  );
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "New chat" }));
    await flush();
  });
  expect(screen.queryByText("TEST stored TEST-A")).toBeNull();
  expect(screen.getByLabelText("Type a message…").props.value).toBe("");
  fireEvent.changeText(screen.getByLabelText("Type a message…"), "TEST first");
  f.session.send.mockRejectedValueOnce(Error("connection_failed"));
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await flush();
  });
  expect(f.session.send).toHaveBeenCalledTimes(1);
  expect(f.session.send.mock.calls[0]![0].type).toBe("conversation.create");
  expect(screen.getByLabelText("Type a message…").props.value).toBe(
    "TEST first",
  );
  await select("TEST-A");
  expect(screen.getByText("TEST stored TEST-A")).toBeTruthy();
  expect(screen.getByLabelText("Type a message…").props.value).toBe(
    "TEST keep draft",
  );
});

test("legacy server receives no automatic history or create commands; explicit open gives update-needed state", async () => {
  const f = fixture(true);
  render(<f.Harness />);
  await act(flush);
  expect(f.session.readConversations).not.toHaveBeenCalled();
  expect(f.session.readConversation).not.toHaveBeenCalled();
  await open();
  expect(
    screen.getByText("Update the server to use chat history and new chats."),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "New chat" }).props.accessibilityState
      .disabled,
  ).toBe(true);
  expect(f.session.send).not.toHaveBeenCalled();
  fireEvent.press(screen.getAllByRole("button", { name: "Close menu" })[0]!);
  fireEvent.changeText(
    screen.getByLabelText("Type a message…"),
    "TEST legacy input",
  );
  fireEvent.press(screen.getByRole("button", { name: "Send" }));
  expect(f.session.send.mock.calls[0]![0]).toEqual(
    expect.objectContaining({
      type: "message.send",
      conversationId: "conversation-1",
      text: "TEST legacy input",
      session: "new",
    }),
  );
});

test("passive selection restores full transcript and protects identical B draft from late A consumption", async () => {
  const f = fixture();
  render(<f.Harness />);
  await select("TEST-A");
  expect(screen.getByText("TEST stored TEST-A")).toBeTruthy();
  expect(f.session.send).not.toHaveBeenCalled();
  fireEvent.changeText(
    screen.getByLabelText("Type a message…"),
    "TEST identical draft",
  );
  fireEvent.press(screen.getByRole("button", { name: "Send" }));
  expect(f.session.send.mock.calls[0]![0]).toEqual(
    expect.objectContaining({
      conversationId: "TEST-A",
      text: "TEST identical draft",
    }),
  );
  expect(f.session.send.mock.calls[0]![0]).not.toHaveProperty("session");
  await select("TEST-B");
  fireEvent.changeText(
    screen.getByLabelText("Type a message…"),
    "TEST identical draft",
  );
  await act(async () => {
    f.settle();
    await flush();
  });
  expect(screen.getByLabelText("Type a message…").props.value).toBe(
    "TEST identical draft",
  );
  expect(screen.getByText("TEST stored TEST-B")).toBeTruthy();
  await select("TEST-A");
  expect(screen.getByLabelText("Type a message…").props.value).toBe("");
  expect(screen.getByText("TEST identical draft")).toBeTruthy();
  await select("TEST-B");
  expect(screen.getByLabelText("Type a message…").props.value).toBe(
    "TEST identical draft",
  );
  expect(mockStop).toHaveBeenCalled();
});

test("left menu drawer exhausts passive pages, persists pins by identity, restores them on reopen and never dispatches selection", async () => {
  const f = fixture();
  let pages = 0;
  f.session.readConversations.mockImplementation(async () => ({
    profile: CONVERSATION_HISTORY_PROFILE,
    scope: f.state().store!.scope,
    conversations: [summary(pages++ % 2 ? "TEST-B" : "TEST-A")],
    nextAfter: pages % 2 ? "40" : null,
  }));
  const onSelect = jest.fn(),
    onNew = jest.fn(async () => {}),
    onClose = jest.fn();
  const props = {
    session: f.session as unknown as ClientSession,
    language: "en" as const,
    open: true,
    selectedId: "TEST-A",
    busy: false,
    online: true,
    onClose,
    onSelect,
    onNew,
  };
  const mounted = render(<ChatHistory {...props} />);
  await act(flush);
  expect(f.session.readConversations).toHaveBeenCalledTimes(2);
  expect(
    screen.getByTestId("chat-history-panel").props.style.justifyContent,
  ).toBe("flex-start");
  // Rows carry no pin control; holding a row opens its menu.
  expect(screen.queryByRole("button", { name: "Pin chat" })).toBeNull();
  expect(screen.queryByText("Pinned")).toBeNull();
  await choose(await menuAction("TEST chat TEST-A", "Pin chat"));
  expect(screen.queryByTestId("chat-row-menu")).toBeNull();
  expect(
    JSON.parse(local.get(conversationPinsKey(f.session.identityKey))!).ids,
  ).toEqual(["TEST-A"]);
  mounted.rerender(<ChatHistory {...props} open={false} />);
  mounted.rerender(<ChatHistory {...props} />);
  await act(flush);
  // The pinned chat leads in its own section although TEST-B is newer.
  expect(screen.getByText("Pinned")).toBeTruthy();
  expect(
    screen.getAllByRole("button", { name: /TEST chat/ })[0]!.props
      .accessibilityLabel,
  ).toBe("TEST chat TEST-A");
  expect(await menuAction("TEST chat TEST-A", "Unpin chat")).toBeTruthy();
  await choose(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByTestId("chat-row-menu")).toBeNull();
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "TEST chat TEST-A" }));
  expect(onSelect).toHaveBeenCalledWith(summary("TEST-A"));
  expect(f.session.send).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "New chat" }));
    await flush();
  });
  expect(onNew).toHaveBeenCalledTimes(1);
  mounted.rerender(
    <ChatHistory
      {...props}
      session={
        {
          ...f.session,
          identityKey: "TEST-server/bob/workspace-a",
        } as unknown as ClientSession
      }
    />,
  );
  await act(flush);
  expect(screen.queryByText("Pinned")).toBeNull();
});

test.each([false, true])(
  "A→B→A preserves draft ownership before late acceptance; newer identical edit=%s",
  async (newerEdit) => {
    const f = fixture();
    render(<f.Harness />);
    await select("TEST-A");
    fireEvent.changeText(
      screen.getByLabelText("Type a message…"),
      "TEST retained A draft",
    );
    fireEvent.press(screen.getByRole("button", { name: "Send" }));
    await select("TEST-B");
    await select("TEST-A");
    expect(screen.getByLabelText("Type a message…").props.value).toBe(
      "TEST retained A draft",
    );
    if (newerEdit)
      fireEvent.changeText(
        screen.getByLabelText("Type a message…"),
        "TEST retained A draft",
      );
    await act(async () => {
      f.settle();
      await flush();
    });
    expect(screen.getByLabelText("Type a message…").props.value).toBe(
      newerEdit ? "TEST retained A draft" : "",
    );
  },
);

test("a pending pin write keeps ownership across drawer remount; hydration waits before another pin", async () => {
  const f = fixture(),
    firstWrite = gate();
  let count = 0;
  jest.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
    if (count++ === 0) await firstWrite.promise;
    local.set(key, value);
  });
  const props = {
    session: f.session as unknown as ClientSession,
    language: "en" as const,
    open: true,
    selectedId: "TEST-A",
    busy: false,
    online: true,
    onClose: jest.fn(),
    onSelect: jest.fn(),
    onNew: jest.fn(async () => {}),
  };
  const mounted = render(<ChatHistory {...props} />);
  await act(flush);
  await choose(await menuAction("TEST chat TEST-A", "Pin chat"));
  mounted.rerender(<ChatHistory {...props} open={false} />);
  mounted.rerender(<ChatHistory {...props} />);
  await act(flush);
  const early = await menuAction("TEST chat TEST-B", "Pin chat");
  expect(early.props.accessibilityState.disabled).toBe(true);
  await choose(early);
  await choose(screen.getByRole("button", { name: "Close" }));
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
  await act(async () => {
    firstWrite.resolve();
    await flush();
  });
  expect(screen.getByText("Pinned")).toBeTruthy();
  await choose(await menuAction("TEST chat TEST-B", "Pin chat"));
  expect(
    JSON.parse(
      local.get(conversationPinsKey(f.session.identityKey))!,
    ).ids.sort(),
  ).toEqual(["TEST-A", "TEST-B"]);
});

test("opening a genuine native waiting question supersedes an unresolved history read and re-enables the composer", async () => {
  const f = fixture(false, true);
  const question = f.state().store!.workItems["TEST-native-work"]!;
  const { question: _legacyQuestion, ...native } = question.native!;
  question.native = {
    ...native,
    process: {
      kind: "service-process-1",
      provenance: {
        runId: question.id,
        processId: "TEST-process",
        version: 1,
        artifactDigest: "a".repeat(64),
        actorId: f.state().store!.scope.userId,
        conversationId: question.conversationId,
      },
      startedAt: "2026-10-12T00:00:00.000Z",
      status: "waiting",
      journalStatus: "waiting",
      journalRevision: 4,
      detailsAvailable: true,
      question: {
        nodeId: "TEST_node",
        childRunId: "TEST-child",
        toolCallId: "TEST-call",
        questionId: "TEST-native-question",
        questionRevision: 1,
        question: "Which day should the meeting take place?",
      },
      receipts: [],
    },
  };
  WorkItemSchema.parse(question);
  f.session.readConversation.mockImplementation(() => new Promise(() => {}));
  render(<f.Harness />);
  await select("TEST-A");
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Menu" }));
    await flush();
  });
  await act(async () => {
    fireEvent.press(screen.getByText("Processes"));
    await flush();
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId("process-run-history-TEST-native-work"));
    await flush();
  });
  fireEvent.press(screen.getByRole("button", { name: "Reply in chat" }));
  await act(flush);
  expect(f.session.send).not.toHaveBeenCalled();
  expect(f.session.selectConversation).toHaveBeenLastCalledWith(
    "conversation-1",
  );
  fireEvent.changeText(
    screen.getByLabelText("Type a message…"),
    "TEST normal draft",
  );
  expect(
    screen.getByRole("button", { name: "Send" }).props.accessibilityState
      .disabled,
  ).toBe(false);
});
test("screen readers pin a chat with a row action instead of holding it", async () => {
  const f = fixture();
  f.session.readConversations.mockImplementation(async () => ({
    profile: CONVERSATION_HISTORY_PROFILE,
    scope: f.state().store!.scope,
    conversations: [summary("TEST-A"), summary("TEST-B")],
    nextAfter: null,
  }));
  render(
    <ChatHistory
      session={f.session as unknown as ClientSession}
      language="en"
      open
      selectedId="TEST-A"
      busy={false}
      online
      onClose={jest.fn()}
      onSelect={jest.fn()}
      onNew={jest.fn(async () => {})}
    />,
  );
  await act(flush);
  const row = screen.getByRole("button", { name: "TEST chat TEST-A" });
  expect(row.props.accessibilityActions).toEqual([
    { name: "togglePin", label: "Pin chat" },
    { name: "longpress", label: "Chat options" },
  ]);
  await act(async () => {
    fireEvent(row, "accessibilityAction", {
      nativeEvent: { actionName: "togglePin" },
    });
    await flush();
  });
  expect(
    JSON.parse(local.get(conversationPinsKey(f.session.identityKey))!).ids,
  ).toEqual(["TEST-A"]);
  expect(screen.getByText("Pinned")).toBeTruthy();
});

test("the row menu renames a chat for every device and deletes it after one confirmation", async () => {
  const f = fixture();
  const session = f.session as unknown as Record<string, unknown>;
  const renameConversation = jest.fn(async () => {});
  const deleteConversation = jest.fn(async () => {});
  Object.assign(session, { renameConversation, deleteConversation });
  f.session.readConversations.mockImplementation(async () => ({
    profile: CONVERSATION_HISTORY_PROFILE,
    scope: f.state().store!.scope,
    conversations: [summary("TEST-A"), summary("TEST-B")],
    nextAfter: null,
  }));
  const onDeleted = jest.fn();
  render(
    <ChatHistory
      session={f.session as unknown as ClientSession}
      language="en"
      open
      selectedId="TEST-A"
      busy={false}
      online
      onClose={jest.fn()}
      onSelect={jest.fn()}
      onNew={jest.fn(async () => {})}
      onDeleted={onDeleted}
    />,
  );
  await act(flush);
  const hold = async (title: string) =>
    act(async () => {
      fireEvent(screen.getByRole("button", { name: title }), "longPress");
      await flush();
    });
  await hold("TEST chat TEST-A");
  await choose(screen.getByRole("menuitem", { name: "Rename" }));
  const field = screen.getByLabelText("Chat name");
  expect(field.props.value).toBe("TEST chat TEST-A");
  fireEvent.changeText(field, "TEST renamed");
  await choose(screen.getByRole("button", { name: "Rename" }));
  expect(renameConversation).toHaveBeenCalledWith(
    "TEST-A",
    "TEST renamed",
    "TEST-mobile-command",
  );
  expect(screen.getByRole("button", { name: "TEST renamed" })).toBeTruthy();

  await hold("TEST chat TEST-B");
  await choose(screen.getByRole("menuitem", { name: "Delete" }));
  expect(screen.getByText("Delete this chat?")).toBeTruthy();
  expect(deleteConversation).not.toHaveBeenCalled();
  await choose(screen.getByRole("button", { name: "Delete" }));
  expect(deleteConversation).toHaveBeenCalledWith(
    "TEST-B",
    "TEST-mobile-command",
  );
  expect(screen.queryByRole("button", { name: "TEST chat TEST-B" })).toBeNull();
  expect(onDeleted).toHaveBeenCalledWith("TEST-B");

  // A chat still answering stays, and the drawer says why.
  deleteConversation.mockRejectedValueOnce(new Error("conversation_busy"));
  await hold("TEST renamed");
  await choose(screen.getByRole("menuitem", { name: "Delete" }));
  await choose(screen.getByRole("button", { name: "Delete" }));
  expect(
    screen.getByText("The chat is still answering. Try again in a moment."),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "TEST renamed" })).toBeTruthy();
});

test("the drawer lists only active chats; Archive moves a chat to Settings, never a hub item's chat", async () => {
  const f = fixture();
  const archiveConversation = jest.fn(async () => {});
  Object.assign(f.session as unknown as Record<string, unknown>, {
    archiveConversation,
  });
  f.session.readConversations.mockImplementation(async () => ({
    profile: CONVERSATION_HISTORY_PROFILE,
    scope: f.state().store!.scope,
    conversations: [
      summary("TEST-A"),
      { ...summary("chat-hub-TEST"), title: "TEST hub" },
      // An older server lists the archive too; it never shows here.
      { ...summary("archived-1"), title: "TEST archived", readOnly: true },
    ],
    nextAfter: null,
  }));
  const onDeleted = jest.fn();
  render(
    <ChatHistory
      session={f.session as unknown as ClientSession}
      language="en"
      open
      selectedId="TEST-A"
      busy={false}
      online
      onClose={jest.fn()}
      onSelect={jest.fn()}
      onNew={jest.fn(async () => {})}
      onDeleted={onDeleted}
    />,
  );
  await act(flush);
  expect(f.session.readConversations).toHaveBeenCalledWith(
    null,
    expect.anything(),
    "active",
  );
  expect(screen.queryByRole("button", { name: "TEST archived" })).toBeNull();
  const hold = async (title: string) =>
    act(async () => {
      fireEvent(screen.getByRole("button", { name: title }), "longPress");
      await flush();
    });
  await hold("TEST hub");
  expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
  await choose(screen.getByRole("button", { name: "Close" }));
  await hold("TEST chat TEST-A");
  await choose(screen.getByRole("menuitem", { name: "Archive" }));
  expect(archiveConversation).toHaveBeenCalledWith(
    "TEST-A",
    "TEST-mobile-command",
  );
  expect(screen.queryByRole("button", { name: "TEST chat TEST-A" })).toBeNull();
  expect(onDeleted).toHaveBeenCalledWith("TEST-A");
});

test("Settings lists archived chats: restore, delete after a confirmation, open one read-only and restore it there", async () => {
  const f = fixture();
  const archived = (id: string, title: string, updatedAt: string) => ({
    ...summary(id),
    title,
    updatedAt,
    readOnly: true,
    messageCount: 3,
  });
  let archive = [
    archived("archived-1", "TEST old plan", "2026-10-07T00:00:01.000Z"),
    archived("archived-2", "TEST budget", "2026-10-08T00:00:01.000Z"),
    archived("archived-3", "TEST invoices", "2026-10-09T00:00:01.000Z"),
  ];
  const restoreConversation = jest.fn(async (id: string) => {
    archive = archive.filter((c) => c.id !== id);
  });
  const deleteConversation = jest.fn(async (id: string) => {
    archive = archive.filter((c) => c.id !== id);
  });
  Object.assign(f.session as unknown as Record<string, unknown>, {
    restoreConversation,
    deleteConversation,
    getDirectoryVersion: () => 0,
  });
  f.session.readConversations.mockImplementation(
    async (_after?: string | null, _signal?: AbortSignal, state?: string) => ({
      profile: CONVERSATION_HISTORY_PROFILE,
      scope: f.state().store!.scope,
      conversations: state === "archived" ? archive : [summary("TEST-A")],
      nextAfter: null,
    }),
  );
  f.session.readConversation.mockImplementation(async (id: string) => ({
    profile: CONVERSATION_HISTORY_PROFILE,
    scope: f.state().store!.scope,
    conversation: {
      ...summary(id),
      title: "TEST old plan",
      readOnly: archive.some((c) => c.id === id),
    },
    messages: [{ id: "TEST-old-1", role: "user", text: "TEST archived words" }],
    nextAfter: null,
  }));
  function Settings() {
    const [section, setSection] = useState<Section>("more");
    return (
      <Workspace
        session={f.session as unknown as ClientSession}
        language="en"
        section={section}
        setSection={setSection}
        settings={null}
        authError={null}
        spokenReplies={false}
      />
    );
  }
  render(<Settings />);
  await act(flush);
  expect(f.session.readConversations).toHaveBeenCalledWith(
    null,
    expect.anything(),
    "archived",
  );
  expect(screen.getByText("Archived chats")).toBeTruthy();
  expect(screen.getAllByText(/3 messages/)).toHaveLength(3);
  await choose(
    // The row itself is a button too; its own actions come last.
    screen.getAllByRole("button", { name: "Restore: TEST invoices" }).at(-1)!,
  );
  expect(restoreConversation).toHaveBeenCalledWith(
    "archived-3",
    "TEST-mobile-command",
  );
  expect(screen.queryByRole("button", { name: "TEST invoices" })).toBeNull();

  await choose(
    screen.getAllByRole("button", { name: "Delete: TEST budget" }).at(-1)!,
  );
  expect(screen.getByText("Delete this chat?")).toBeTruthy();
  expect(deleteConversation).not.toHaveBeenCalled();
  await choose(screen.getByRole("button", { name: "Delete" }));
  expect(deleteConversation).toHaveBeenCalledWith(
    "archived-2",
    "TEST-mobile-command",
  );
  expect(screen.queryByRole("button", { name: "TEST budget" })).toBeNull();

  // Opening one shows it read-only, with a way back to the menu.
  await choose(screen.getAllByRole("button", { name: "TEST old plan" })[0]!);
  expect(screen.getByTestId("read-only-composer")).toBeTruthy();
  expect(screen.getByText("TEST archived words")).toBeTruthy();
  await choose(screen.getByRole("button", { name: "Restore" }));
  expect(restoreConversation).toHaveBeenLastCalledWith(
    "archived-1",
    "TEST-mobile-command",
  );
  expect(screen.queryByTestId("read-only-composer")).toBeNull();
  expect(screen.getByLabelText("Type a message…")).toBeTruthy();
  expect(f.session.send).not.toHaveBeenCalled();
});
