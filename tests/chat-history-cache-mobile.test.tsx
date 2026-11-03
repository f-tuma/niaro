import React from "react";
import { RefreshControl } from "react-native";
import { act, render, screen } from "@testing-library/react-native";
import { ChatHistory } from "../apps/mobile/ChatHistory";
import {
  CHAT_LIST,
  ListCache,
  listCacheKey,
} from "../packages/client-core/list-cache";
import type { ClientSession } from "../packages/client-core/session";
import { emptySnapshot } from "../packages/test-fixtures";
import {
  CONVERSATION_HISTORY_PROFILE,
  type ConversationHistoryPage,
  type ConversationSummary,
} from "../packages/protocol";
import { en } from "../packages/i18n";

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
}));
jest.mock("../apps/mobile/feedback", () => ({
  feedback: () => 0,
  setFeedbackEnabled: jest.fn(),
  touch: jest.fn(),
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => "TEST-cache" }));

const flush = async () => {
  for (let n = 0; n < 40; n++) await Promise.resolve();
};
const device = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      values.delete(key);
    }),
  };
};
const IDENTITY = "TEST-server/alice/workspace-a";
const chat = (id: string, title = `TEST chat ${id}`): ConversationSummary => ({
  id,
  title,
  revision: 1,
  createdAt: "2026-11-01T08:00:00.000Z",
  updatedAt: `2026-11-01T08:00:0${"ABCD".indexOf(id.slice(-1))}.000Z`,
  messageCount: 1,
  readOnly: false,
});
/** A signed-in session as the drawer sees it: the chat list, the events
 * cursor and the directory version. */
function session(conversations: ConversationSummary[]) {
  const snapshot = emptySnapshot();
  const listeners = new Set<() => void>();
  let cursor = 1;
  let directory = 0;
  const state = () => ({ store: { cursor } });
  let current = state();
  const notify = () => {
    current = state();
    listeners.forEach((listener) => listener());
  };
  let answer = conversations;
  const value = {
    identityKey: IDENTITY,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => current,
    getDirectoryVersion: () => directory,
    readConversations: jest.fn(
      async (): Promise<ConversationHistoryPage> => ({
        profile: CONVERSATION_HISTORY_PROFILE,
        scope: snapshot.scope,
        conversations: answer,
        nextAfter: null,
      }),
    ),
  };
  return {
    value,
    answer: (next: ConversationSummary[]) => {
      answer = next;
    },
    /** An event arrived (a message in any chat). */
    event: () => {
      cursor++;
      notify();
    },
    /** A chat was renamed, archived or deleted here or elsewhere. */
    directoryChanged: () => {
      directory++;
      notify();
    },
  };
}
function drawer(
  owner: ReturnType<typeof session>,
  lists: ListCache,
  online = true,
) {
  const props = {
    session: owner.value as unknown as ClientSession,
    language: "en" as const,
    selectedId: "TEST-A",
    busy: false,
    online,
    onClose: jest.fn(),
    onSelect: jest.fn(),
    onNew: jest.fn(async () => {}),
    lists,
  };
  const view = render(<ChatHistory {...props} open />);
  return {
    view,
    close: () => view.rerender(<ChatHistory {...props} open={false} />),
    open: () => view.rerender(<ChatHistory {...props} open />),
  };
}
const titles = () =>
  screen
    .queryAllByRole("button", { name: /TEST chat|TEST renamed/ })
    .map((row) => row.props.accessibilityLabel as string);

test("after app start the drawer shows the last known chats at once and swaps in the server's answer quietly", async () => {
  const storage = device();
  // The previous run kept its chats on the device.
  const previous = new ListCache(storage);
  const before = session([]);
  await previous.adopt(IDENTITY);
  await previous.write(before.value, CHAT_LIST, [
    chat("TEST-B"),
    chat("TEST-A"),
  ]);
  expect(storage.values.has(listCacheKey(IDENTITY, CHAT_LIST))).toBe(true);

  const lists = new ListCache(storage);
  const now = session([chat("TEST-C"), chat("TEST-A", "TEST renamed A")]);
  let answer!: () => void;
  const gate = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const read = now.value.readConversations.getMockImplementation()!;
  now.value.readConversations.mockImplementation(async () => {
    await gate;
    return read();
  });
  drawer(now, lists);
  // The device copy arrives before the server answers; nothing says loading.
  expect(screen.queryByText(en.loading)).toBeNull();
  await act(flush);
  expect(titles()).toEqual(["TEST chat TEST-B", "TEST chat TEST-A"]);
  expect(screen.queryByText(en.loading)).toBeNull();
  expect(now.value.readConversations).toHaveBeenCalledTimes(1);
  await act(async () => {
    answer();
    await flush();
  });
  // Replaced at once by the whole answer, never emptied in between.
  expect(titles()).toEqual(["TEST chat TEST-C", "TEST renamed A"]);
  expect(screen.queryByText(en.loading)).toBeNull();
  // And kept for the next start.
  expect(await new ListCache(storage).read(now.value, CHAT_LIST)).toEqual([
    chat("TEST-C"),
    chat("TEST-A", "TEST renamed A"),
  ]);
});

test("re-opening within the freshness window makes no server call; an event, a directory change or time asks again", async () => {
  let clock = Date.parse("2026-11-03T09:00:00.000Z");
  const lists = new ListCache(device(), () => clock);
  const owner = session([chat("TEST-A"), chat("TEST-B")]);
  const menu = drawer(owner, lists);
  await act(flush);
  expect(owner.value.readConversations).toHaveBeenCalledTimes(1);
  expect(titles()).toEqual(["TEST chat TEST-B", "TEST chat TEST-A"]);

  // Quick re-open: the chats are there in the first frame, no call.
  menu.close();
  menu.open();
  expect(titles()).toEqual(["TEST chat TEST-B", "TEST chat TEST-A"]);
  await act(flush);
  menu.close();
  clock += 60_000;
  menu.open();
  await act(flush);
  expect(owner.value.readConversations).toHaveBeenCalledTimes(1);

  // A message somewhere moved the events cursor: the next opening reads.
  menu.close();
  act(() => owner.event());
  owner.answer([chat("TEST-A"), chat("TEST-B"), chat("TEST-C")]);
  menu.open();
  expect(titles()).toEqual(["TEST chat TEST-B", "TEST chat TEST-A"]);
  await act(flush);
  expect(owner.value.readConversations).toHaveBeenCalledTimes(2);
  expect(titles()).toEqual([
    "TEST chat TEST-C",
    "TEST chat TEST-B",
    "TEST chat TEST-A",
  ]);

  // A rename or deletion elsewhere re-reads the open list.
  owner.answer([chat("TEST-C")]);
  await act(async () => {
    owner.directoryChanged();
    await flush();
  });
  expect(owner.value.readConversations).toHaveBeenCalledTimes(3);
  expect(titles()).toEqual(["TEST chat TEST-C"]);

  // After the freshness window the next opening reads again.
  menu.close();
  menu.open();
  await act(flush);
  expect(owner.value.readConversations).toHaveBeenCalledTimes(3);
  menu.close();
  clock += CHAT_LIST.freshMs;
  menu.open();
  await act(flush);
  expect(owner.value.readConversations).toHaveBeenCalledTimes(4);
});

test("pull to refresh reads again; a failed read keeps the last known chats with the error", async () => {
  const lists = new ListCache(device());
  const owner = session([chat("TEST-A")]);
  const menu = drawer(owner, lists);
  await act(flush);
  expect(owner.value.readConversations).toHaveBeenCalledTimes(1);
  owner.value.readConversations.mockRejectedValueOnce(
    new Error("connection_failed"),
  );
  await act(async () => {
    menu.view.UNSAFE_getByType(RefreshControl).props.onRefresh();
    await flush();
  });
  expect(owner.value.readConversations).toHaveBeenCalledTimes(2);
  expect(screen.getByText(en.chatHistoryLoadFailed)).toBeTruthy();
  expect(titles()).toEqual(["TEST chat TEST-A"]);
  expect(menu.view.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(
    false,
  );
});

test("offline the drawer shows the last known chats and offers no pull to refresh", async () => {
  const storage = device();
  const previous = new ListCache(storage);
  await previous.adopt(IDENTITY);
  await previous.write(session([]).value, CHAT_LIST, [chat("TEST-A")]);
  const owner = session([]);
  owner.value.readConversations.mockRejectedValue(
    new Error("connection_failed"),
  );
  const menu = drawer(owner, new ListCache(storage), false);
  await act(flush);
  expect(titles()).toEqual(["TEST chat TEST-A"]);
  expect(screen.getByText(en.chatHistoryLoadFailed)).toBeTruthy();
  expect(menu.view.UNSAFE_queryByType(RefreshControl)).toBeNull();
});
