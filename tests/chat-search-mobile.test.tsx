import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import {
  ChatSearchScreen,
  MOBILE_SEARCH_DEBOUNCE_MS,
} from "../apps/mobile/ChatSearch";
import type { ClientSession } from "../packages/client-core/session";
import type {
  ConversationHistoryPage,
  ConversationSummary,
} from "../packages/protocol";
import {
  CHAT_SEARCH_PROFILE,
  type ChatSearchPage,
} from "../packages/protocol/chat-search";

jest.mock("../apps/mobile/feedback", () => ({
  feedback: () => 0,
  setFeedbackEnabled: jest.fn(),
}));

const scope = {
  connectionId: "c",
  serverId: "s",
  userId: "alice",
  workspaceId: "a",
};
const recent: ConversationSummary = {
  id: "chat-recent",
  revision: 3,
  title: "Plán na pondělí",
  createdAt: "2026-10-17T08:00:00.000Z",
  updatedAt: "2026-10-17T08:00:00.000Z",
  messageCount: 4,
  readOnly: false,
};
const directory: ConversationHistoryPage = {
  profile: "agent-conversations/1",
  scope,
  conversations: [
    recent,
    { ...recent, id: "chat-empty", title: "", messageCount: 0 },
  ],
  nextAfter: null,
};
const found: ChatSearchPage = {
  profile: CHAT_SEARCH_PROFILE,
  scope,
  results: [
    {
      conversation: {
        id: "archived-4",
        title: "Schůzka s Petrem",
        updatedAt: "2026-09-01T09:00:00.000Z",
        archived: true,
      },
      titleRanges: [[0, 7]],
      matches: [
        {
          messageId: "m-1",
          role: "user",
          snippet: "Naplánuj <i>schůzku</i>",
          ranges: [[13, 20]],
        },
      ],
      matchCount: 1,
    },
  ],
  nextAfter: null,
};

const flush = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("the mobile search lists recent chats, searches as one types and opens the found chat", async () => {
  const searchConversations = jest.fn(async () => found);
  const readConversations = jest.fn(async () => directory);
  const session = {
    identityKey: "alice",
    readConversations,
    searchConversations,
  } as unknown as ClientSession;
  const onOpen = jest.fn();
  const onClose = jest.fn();
  render(
    <ChatSearchScreen
      session={session}
      language="cs"
      online
      onClose={onClose}
      onOpen={onOpen}
    />,
  );
  await act(flush);
  expect(readConversations).toHaveBeenCalledWith(null, undefined, "active");
  expect(screen.getAllByTestId("chat-search-result")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Plán na pondělí" })).toBeTruthy();

  fireEvent.changeText(screen.getByTestId("chat-search-input"), "schuzka");
  await act(async () => {
    jest.advanceTimersByTime(MOBILE_SEARCH_DEBOUNCE_MS);
    await flush();
  });
  expect(searchConversations).toHaveBeenCalledWith("schuzka", {
    includeArchived: true,
    after: null,
  });
  const row = screen.getByRole("button", { name: "Schůzka s Petrem" });
  expect(screen.getByText("Archivováno")).toBeTruthy();
  // Server text stays text; only the ranges are bold.
  expect(screen.getByText("<i>schůzku</i>", { exact: false })).toBeTruthy();
  fireEvent.press(row);
  expect(onOpen).toHaveBeenCalledWith({
    id: "archived-4",
    revision: 1,
    title: "Schůzka s Petrem",
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-01T09:00:00.000Z",
    messageCount: 1,
    readOnly: true,
  });

  fireEvent.press(screen.getByRole("radio", { name: "Odpovědi" }));
  await act(flush);
  expect(searchConversations).toHaveBeenLastCalledWith("schuzka", {
    includeArchived: true,
    role: "assistant",
    after: null,
  });
  fireEvent.press(screen.getByRole("button", { name: "Zpět" }));
  expect(onClose).toHaveBeenCalled();
});

test("an older server says so", async () => {
  const session = {
    identityKey: "alice",
    readConversations: jest.fn(async () => directory),
    searchConversations: jest.fn(async () => {
      throw new Error("chat_search_unavailable");
    }),
  } as unknown as ClientSession;
  render(
    <ChatSearchScreen
      session={session}
      language="cs"
      online
      onClose={() => {}}
      onOpen={() => {}}
    />,
  );
  await act(flush);
  fireEvent.changeText(screen.getByTestId("chat-search-input"), "x");
  await act(async () => {
    jest.advanceTimersByTime(MOBILE_SEARCH_DEBOUNCE_MS);
    await flush();
  });
  expect(
    screen.getByText("Tenhle server v chatech hledat neumí."),
  ).toBeTruthy();
});
