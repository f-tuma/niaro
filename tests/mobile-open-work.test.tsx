import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { ChatHistory } from "../apps/mobile/ChatHistory";
import { ArchivedChats } from "../apps/mobile/ArchivedChats";
import { MobileWorkItemCard } from "../apps/mobile/MobileWorkItemCard";
import { ConversationOpenWorkError } from "../packages/client-core/conversation-directory";
import type {
  ClientSession,
  SessionState,
} from "../packages/client-core/session";
import { fromSnapshot } from "../packages/client-core/store";
import {
  emptySnapshot,
  nativeTaskApproval,
  nativeTaskQuestion,
} from "../packages/test-fixtures";
import {
  CONVERSATION_HISTORY_PROFILE,
  type ConversationSummary,
  type WorkItem,
} from "../packages/protocol";

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
}));
jest.mock("../apps/mobile/feedback", () => ({
  feedback: () => 0,
  setFeedbackEnabled: jest.fn(),
  touch: jest.fn(),
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => "TEST-open-work" }));

const flush = async () => {
  for (let n = 0; n < 40; n++) await Promise.resolve();
};
const press = async (element: ReturnType<typeof screen.getByRole>) =>
  act(async () => {
    fireEvent.press(element);
    await flush();
  });
const summary = (id: string, readOnly = false): ConversationSummary => ({
  id,
  title: `TEST chat ${id}`,
  revision: 1,
  createdAt: "2026-10-07T00:00:00.000Z",
  updatedAt: "2026-10-07T00:00:01.000Z",
  messageCount: 1,
  readOnly,
});
const waiting = new ConversationOpenWorkError([
  { workItemId: "TEST-q", title: "TEST asks a day", kind: "question" },
  { workItemId: "TEST-p", title: "TEST invoice run", kind: "process" },
]);
function directorySession(readOnly = false) {
  const snapshot = emptySnapshot();
  return {
    identityKey: "TEST-server/alice/workspace-a",
    subscribe: () => () => {},
    getDirectoryVersion: () => 0,
    readConversations: jest.fn(async () => ({
      profile: CONVERSATION_HISTORY_PROFILE,
      scope: snapshot.scope,
      conversations: [summary("TEST-A", readOnly)],
      nextAfter: null,
    })),
    deleteConversation: jest.fn(async () => {}),
    archiveConversation: jest.fn(async () => {}),
    restoreConversation: jest.fn(async () => {}),
  };
}
const drawer = (
  session: ReturnType<typeof directorySession>,
  language: "en" | "cs" = "en",
) =>
  render(
    <ChatHistory
      session={session as unknown as ClientSession}
      language={language}
      open
      selectedId="TEST-A"
      busy={false}
      online
      onClose={jest.fn()}
      onSelect={jest.fn()}
      onNew={jest.fn(async () => {})}
      onDeleted={jest.fn()}
    />,
  );
const hold = async (title: string) =>
  act(async () => {
    fireEvent(screen.getByRole("button", { name: title }), "longPress");
    await flush();
  });

test("a refused delete names the waiting work and cancels it before deleting", async () => {
  const session = directorySession();
  session.deleteConversation.mockRejectedValueOnce(waiting);
  drawer(session, "cs");
  await act(flush);
  await hold("TEST chat TEST-A");
  await press(screen.getByRole("menuitem", { name: "Smazat" }));
  await press(screen.getByRole("button", { name: "Smazat" }));
  expect(
    screen.getByText(
      "V chatu čeká: TEST asks a day (otázka), TEST invoice run (proces)",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "TEST chat TEST-A" })).toBeTruthy();
  await press(screen.getByRole("button", { name: "Zrušit a smazat" }));
  expect(session.deleteConversation).toHaveBeenLastCalledWith(
    "TEST-A",
    "TEST-open-work",
    { cancelOpenWork: true },
  );
  expect(screen.queryByTestId("open-work-notice")).toBeNull();
  expect(screen.queryByRole("button", { name: "TEST chat TEST-A" })).toBeNull();
});

test("an older server's refusal keeps the general sentence; Keep leaves the chat", async () => {
  const session = directorySession();
  session.archiveConversation.mockRejectedValueOnce(
    new ConversationOpenWorkError([]),
  );
  drawer(session);
  await act(flush);
  await hold("TEST chat TEST-A");
  await press(screen.getByRole("menuitem", { name: "Archive" }));
  expect(
    screen.getByText(
      "This chat is waiting for your answer or approval. Finish or cancel that first.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Cancel and archive" }),
  ).toBeTruthy();
  await press(screen.getByRole("button", { name: "Keep" }));
  expect(screen.queryByTestId("open-work-notice")).toBeNull();
  expect(session.archiveConversation).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "TEST chat TEST-A" })).toBeTruthy();
});

test("the archive offers to cancel waiting work and delete", async () => {
  const session = directorySession(true);
  session.deleteConversation.mockRejectedValueOnce(waiting);
  render(
    <ArchivedChats
      session={session as unknown as ClientSession}
      language="en"
      online
      onOpen={jest.fn()}
    />,
  );
  await act(flush);
  await press(
    screen.getAllByRole("button", { name: "Delete: TEST chat TEST-A" }).at(-1)!,
  );
  await press(screen.getByRole("button", { name: "Delete" }));
  expect(
    screen.getByText(
      "Waiting in this chat: TEST asks a day (question), TEST invoice run (process)",
    ),
  ).toBeTruthy();
  await press(screen.getByRole("button", { name: "Cancel and delete" }));
  expect(session.deleteConversation).toHaveBeenLastCalledWith(
    "TEST-A",
    "TEST-open-work",
    { cancelOpenWork: true },
  );
  expect(screen.queryByText("TEST chat TEST-A")).toBeNull();
});

function cardSession(pending: SessionState["pending"] = null) {
  const snapshot = emptySnapshot();
  const state: SessionState = {
    store: fromSnapshot("https://fixture.test/v1/a", snapshot.scope, snapshot),
    status: "online",
    pending,
    processPending: null,
    answerAttempts: [],
    answerRecoveryBlocked: false,
    commandStates: {},
    error: null,
    activity: null,
    activityConnection: "waiting",
  };
  return {
    getSnapshot: () => state,
    subscribe: () => () => {},
    cancelWork: jest.fn(async () => {}),
    canRetryNativeWork: () => false,
    getRetrySource: () => undefined,
  };
}
const card = (session: ReturnType<typeof cardSession>, work: WorkItem) =>
  render(
    <MobileWorkItemCard
      session={session as unknown as ClientSession}
      conversationId="conversation-1"
      chatGeneration={1}
      work={work}
      language="cs"
      onAnswer={jest.fn()}
    />,
  );

test("a waiting native question can be cancelled from its card", async () => {
  const session = cardSession();
  const work = nativeTaskQuestion("cs");
  card(session, work);
  await press(screen.getByRole("button", { name: "Zrušit" }));
  expect(session.cancelWork).toHaveBeenCalledWith(work, "cs", "TEST-open-work");
  session.cancelWork.mockRejectedValueOnce(new Error("work_busy"));
  await press(screen.getByRole("button", { name: "Zrušit" }));
  expect(screen.getByText("Ještě to běží. Zkus to za chvíli.")).toBeTruthy();
});

test("no cancel for an unconfirmed outcome, a fixture task or while the chat answers", () => {
  const question = nativeTaskQuestion("cs");
  const { native: _native, ...plain } = question;
  const approval = nativeTaskApproval("cs");
  const unknown: WorkItem = {
    ...approval,
    status: "waiting_system",
    native: {
      ...approval.native!,
      action: { ...approval.native!.action!, status: "unknown" },
    },
  };
  const views = [
    card(cardSession(), unknown),
    card(cardSession(), { ...plain, demo: true }),
    card(
      cardSession({
        type: "message.send",
        commandId: "TEST-c",
        idempotencyKey: "TEST-c",
        conversationId: "conversation-1",
        text: "TEST",
        language: "cs",
      }),
      question,
    ),
  ];
  for (const view of views) {
    expect(view.queryByRole("button", { name: "Zrušit" })).toBeNull();
    view.unmount();
  }
});
