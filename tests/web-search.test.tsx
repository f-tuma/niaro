import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClientSession } from "../packages/client-core/session";
import type {
  ConversationHistoryPage,
  ConversationSummary,
} from "../packages/protocol";
import {
  CHAT_SEARCH_PROFILE,
  type ChatSearchPage,
} from "../packages/protocol/chat-search";
import {
  ChatSearch,
  SEARCH_DEBOUNCE_MS,
} from "../apps/server-admin/web/app/search-page";
import {
  linkedMessageId,
  useMessageLink,
  MESSAGE_HIGHLIGHT_MS,
} from "../apps/server-admin/web/app/message-link";
import { highlightParts } from "../packages/client-core/chat-search";

const mockNavigate = jest.fn();
const mockBack = jest.fn();
let mockSearch = "";
jest.mock("@tanstack/react-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Link: ({
      to,
      params,
      search,
      ...props
    }: React.ComponentProps<"a"> & {
      to: string;
      params?: Record<string, string>;
      search?: Record<string, string>;
    }) => {
      const path = Object.entries(params ?? {}).reduce(
        (path, [key, value]) => path.replace(`$${key}`, value),
        to,
      );
      const query = new URLSearchParams(search ?? {}).toString();
      return React.createElement("a", {
        ...props,
        href: query ? `${path}?${query}` : path,
      });
    },
    useNavigate: () => mockNavigate,
    useRouter: () => ({
      history: { canGoBack: () => true, back: mockBack },
    }),
    useRouterState: ({
      select,
    }: {
      select: (state: { location: { searchStr: string } }) => unknown;
    }) => select({ location: { searchStr: mockSearch } }),
  };
});
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({ language: "cs" }),
  useAppSession: () => {
    throw new Error("Pass the session directly");
  },
}));
jest.mock(
  "@admin/components/ui/badge",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/button",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/skeleton",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/spinner",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/alert",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/empty",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/input-group",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/item",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/toggle-group",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/sidebar",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/dropdown-menu",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/alert-dialog",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);

const NOW = new Date("2026-10-17T12:00:00.000Z");
const scope = {
  connectionId: "c",
  serverId: "s",
  userId: "alice",
  workspaceId: "a",
};
const summary = (
  id: string,
  title: string,
  updatedAt: string,
  extra: Partial<ConversationSummary> = {},
): ConversationSummary => ({
  id,
  revision: 1,
  title,
  createdAt: updatedAt,
  updatedAt,
  messageCount: 2,
  readOnly: false,
  ...extra,
});
const directory = (
  conversations: ConversationSummary[],
): ConversationHistoryPage => ({
  profile: "agent-conversations/1",
  scope,
  conversations,
  nextAfter: null,
});
const results: ChatSearchPage = {
  profile: CHAT_SEARCH_PROFILE,
  scope,
  results: [
    {
      conversation: {
        id: "chat-meeting",
        title: "Schůzka s Petrem",
        updatedAt: "2026-10-17T09:00:00.000Z",
        archived: false,
      },
      titleRanges: [[0, 7]],
      matches: [
        {
          messageId: "m-2",
          role: "assistant",
          createdAt: "2026-10-16T09:00:00.000Z",
          snippet: "…schůzka je <b>zítra</b> v devět",
          ranges: [[1, 8]],
        },
        {
          messageId: "m-1",
          role: "user",
          snippet: "Naplánuj schůzku",
          ranges: [[9, 16]],
        },
      ],
      matchCount: 2,
    },
    {
      conversation: {
        id: "archived-3",
        title: "Stará schůzka",
        updatedAt: "2026-03-01T09:00:00.000Z",
        archived: true,
      },
      titleRanges: [[6, 13]],
      matches: [],
      matchCount: 0,
    },
  ],
  nextAfter: null,
};

function setup(
  search: ClientSession["searchConversations"] = jest.fn(async () => results),
  extra: Record<string, unknown> = {},
) {
  const readConversations = jest.fn(
    async (
      _after?: string | null,
      _signal?: AbortSignal,
      state?: "active" | "archived",
    ) =>
      state === "archived"
        ? directory([
            summary("archived-1", "Archivní", "2026-09-01T10:00:00.000Z", {
              readOnly: true,
            }),
          ])
        : directory([
            summary("chat-today", "Dnešní", "2026-10-17T08:00:00.000Z"),
            summary("chat-yesterday", "Včerejší", "2026-10-16T08:00:00.000Z"),
            summary("chat-week", "Týdenní", "2026-10-13T08:00:00.000Z"),
            summary("chat-old", "Srpnový", "2026-08-03T08:00:00.000Z"),
            summary("chat-empty", "", "2026-10-17T09:00:00.000Z", {
              messageCount: 0,
            }),
          ]),
  );
  const session = {
    identityKey: "alice",
    readConversations,
    searchConversations: search,
    ...extra,
  } as unknown as ClientSession;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <ChatSearch session={session} now={NOW} />
      </QueryClientProvider>,
    );
  });
  return { renderer, readConversations, search, root: renderer.root };
}

const text = (node: ReactTestInstance): string =>
  node.children
    .map((child) => (typeof child === "string" ? child : text(child)))
    .join("");
const input = (root: ReactTestInstance) =>
  root.find((node) => node.props["data-host"] === "InputGroupInput");
const options = (root: ReactTestInstance) =>
  root.findAll((node) => node.type === "a" && node.props.role === "option");
const flush = async () => {
  // Queries settle through promises and the query client's zero timers.
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
};
const type = async (root: ReactTestInstance, value: string) => {
  act(() => input(root).props.onChange({ target: { value } }));
  await act(async () => {
    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
  });
  await flush();
};
const key = (root: ReactTestInstance, name: string) => {
  const event = {
    key: name,
    preventDefault: jest.fn(),
    nativeEvent: { isComposing: false },
  };
  act(() => input(root).props.onKeyDown(event));
  return event;
};

beforeEach(() => {
  jest.useFakeTimers();
  mockNavigate.mockClear();
  mockBack.mockClear();
  mockSearch = "";
});
afterEach(() => jest.useRealTimers());

test("an empty search shows recent chats by day, the field ready to type", async () => {
  const { root, search } = setup();
  await flush();
  expect(input(root).props.autoFocus).toBe(true);
  const groups = root
    .findAll((node) => node.props.role === "group")
    .filter((node) => typeof node.type !== "string");
  expect(groups.map((group) => group.props["aria-label"])).toEqual([
    "Dnes",
    "Včera",
    "Posledních 7 dní",
    "Srpen",
  ]);
  expect(options(root).map((option) => option.props.href)).toEqual([
    "/chat/chat-today",
    "/chat/chat-yesterday",
    "/chat/chat-week",
    "/chat/chat-old",
  ]);
  expect(search).not.toHaveBeenCalled();
});

test("typing searches once it settles; results are one row per chat with marked, plain-text snippets", async () => {
  const { root, search } = setup();
  await flush();
  act(() => input(root).props.onChange({ target: { value: "sch" } }));
  act(() => input(root).props.onChange({ target: { value: "schůzka" } }));
  await act(async () => {
    jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
  });
  expect(search).not.toHaveBeenCalled();
  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  await flush();
  expect(search).toHaveBeenCalledTimes(1);
  expect(search).toHaveBeenCalledWith(
    "schůzka",
    { includeArchived: true, after: null },
    expect.anything(),
  );
  const rows = options(root);
  expect(rows.map((row) => row.props.href)).toEqual([
    "/chat/chat-meeting?m=m-2",
    "/chat/archived-3",
  ]);
  const marks = rows[0]!.findAllByType("mark").map(text);
  expect(marks).toEqual(["Schůzka", "schůzka", "schůzku"]);
  // Server text is never markup.
  expect(text(rows[0]!)).toContain("<b>zítra</b>");
  expect(rows[0]!.findAll((node) => node.type === "b")).toHaveLength(0);
  expect(text(rows[0]!)).toContain("Asistent:");
  expect(text(rows[1]!)).toContain("Archivováno");
  expect(text(rows[0]!)).not.toContain("Archivováno");
  // The best match's day, named when it was yesterday.
  expect(rows[0]!.findByType("time").props.children).toBe("Včera");
  expect(text(root)).toContain("Nalezeny 2 chaty");
});

test("arrows move through results, Enter opens the message, Esc clears and then goes back", async () => {
  const { root } = setup();
  await flush();
  await type(root, "schůzka");
  const selected = () =>
    options(root).map((option) => option.props["aria-selected"]);
  expect(selected()).toEqual([true, false]);
  expect(key(root, "ArrowDown").preventDefault).toHaveBeenCalled();
  expect(selected()).toEqual([false, true]);
  key(root, "ArrowDown");
  expect(selected()).toEqual([false, true]);
  key(root, "ArrowUp");
  expect(input(root).props["aria-activedescendant"]).toBe(
    options(root)[0]!.props.id,
  );
  key(root, "Enter");
  expect(mockNavigate).toHaveBeenCalledWith({
    to: "/chat/$conversationId",
    params: { conversationId: "chat-meeting" },
    search: { m: "m-2" },
  });
  key(root, "Escape");
  expect(input(root).props.value).toBe("");
  expect(mockBack).not.toHaveBeenCalled();
  key(root, "Escape");
  expect(mockBack).toHaveBeenCalledTimes(1);
});

test("meetings that match are a group of their own and open the meeting", async () => {
  const meetingId = "11111111-1111-4111-8111-111111111111";
  const readMeetings = jest.fn(async () => ({
    profile: "niaro-meetings/1",
    scope: { connectionId: "c", serverId: "s", workspaceId: "w", userId: "u" },
    meetings: [
      {
        id: meetingId,
        title: "Porada obchodu",
        recordedAt: "2026-10-16T08:00:00.000Z",
      },
    ],
    matches: [
      {
        meetingId,
        field: "transcript",
        snippet: "…domluvená schůzka…",
        at: 75,
      },
    ],
  }));
  const { root } = setup(undefined, { readMeetings });
  await flush();
  await type(root, "schůzka");
  expect(readMeetings).toHaveBeenCalledWith(
    expect.objectContaining({ query: "schůzka" }),
  );
  const group = root
    .findAll((node) => node.props.role === "group")
    .find((node) => node.props["aria-label"] === "Schůzky")!;
  const meeting = group.find(
    (node) => node.type === "a" && node.props.role === "option",
  );
  expect(meeting.props.href).toBe(`/meetings/${meetingId}`);
  expect(text(meeting)).toContain("1:15 …domluvená schůzka…");
  // Chats first, then meetings; Enter on a meeting opens it.
  expect(options(root)).toHaveLength(3);
  key(root, "ArrowDown");
  key(root, "ArrowDown");
  key(root, "Enter");
  expect(mockNavigate).toHaveBeenCalledWith({
    to: "/meetings/$meetingId",
    params: { meetingId },
  });
});

test("filters ask for the person's questions, the answers or the archive", async () => {
  const { root, search, readConversations } = setup();
  await flush();
  const chips = () =>
    root.find((node) => node.props["data-host"] === "ToggleGroup");
  expect(
    chips()
      .findAll((node) => node.props["data-host"] === "ToggleGroupItem")
      .map(text),
  ).toEqual(["Vše", "Moje otázky", "Odpovědi", "Archivované"]);
  await type(root, "schůzka");
  act(() => chips().props.onValueChange("mine"));
  await flush();
  expect(search).toHaveBeenLastCalledWith(
    "schůzka",
    { includeArchived: true, role: "user", after: null },
    expect.anything(),
  );
  act(() => chips().props.onValueChange("answers"));
  await flush();
  expect(search).toHaveBeenLastCalledWith(
    "schůzka",
    { includeArchived: true, role: "assistant", after: null },
    expect.anything(),
  );
  // Unpressing the pressed chip keeps it.
  act(() => chips().props.onValueChange(""));
  expect(chips().props.value).toBe("answers");
  act(() => chips().props.onValueChange("archived"));
  await flush();
  expect(search).toHaveBeenLastCalledWith(
    "schůzka",
    { archivedOnly: true, after: null },
    expect.anything(),
  );
  // Without words, the archive lists its chats.
  key(root, "Escape");
  await flush();
  expect(readConversations).toHaveBeenLastCalledWith(
    null,
    expect.anything(),
    "archived",
  );
  expect(options(root).map((option) => option.props.href)).toEqual([
    "/chat/archived-1",
  ]);
});

test("nothing found, a failure and an older server each say so", async () => {
  const empty = setup(jest.fn(async () => ({ ...results, results: [] })));
  await flush();
  await type(empty.root, "xyz");
  expect(text(empty.root)).toContain("Nic jsme nenašli");

  const failing = setup(
    jest.fn(async () => {
      throw new Error("connection_failed");
    }),
  );
  await flush();
  await type(failing.root, "xyz");
  expect(text(failing.root)).toContain("Hledání nevyšlo.");

  // An older server: the loaded chats' names are searched instead.
  const older = setup(
    jest.fn(async () => {
      throw new Error("chat_search_unavailable");
    }),
  );
  await flush();
  await type(older.root, "vcerejsi");
  expect(text(older.root)).toContain("Tenhle server hledá jen v názvech");
  expect(options(older.root).map((option) => option.props.href)).toEqual([
    "/chat/chat-yesterday",
  ]);
});

test("highlight parts clip bad ranges and never invent text", () => {
  expect(
    highlightParts("abcdef", [
      [1, 3],
      [2, 4],
      [5, 99],
    ]),
  ).toEqual([
    { text: "a", match: false },
    { text: "bc", match: true },
    { text: "d", match: true },
    { text: "e", match: false },
    { text: "f", match: true },
  ]);
  expect(highlightParts("abc", [])).toEqual([{ text: "abc", match: false }]);
});

test("a chat opened at ?m= reads older pages until the message is there, then scrolls to and highlights it", () => {
  expect(linkedMessageId("?m=message-1")).toBe("message-1");
  expect(linkedMessageId("?m=%22123%22")).toBe("123");
  expect(linkedMessageId("?x=1")).toBeUndefined();

  type Node = {
    dataset: Record<string, string>;
    scrollIntoView: jest.Mock;
  };
  const nodes: Node[] = [];
  const show = (id: string) => {
    const node: Node = {
      dataset: { messageId: id },
      scrollIntoView: jest.fn(),
    };
    nodes.push(node);
    return node;
  };
  const container = {
    current: {
      querySelectorAll: () => nodes,
    } as unknown as HTMLElement,
  };
  const loadOlder = jest.fn();
  const onFound = jest.fn();
  function Probe(props: { ids: string[]; hasOlder: boolean }) {
    useMessageLink({
      container,
      ready: true,
      messageIds: props.ids,
      hasOlder: props.hasOlder,
      loadOlder,
      onFound,
    });
    return null;
  }
  mockSearch = "?m=m-1";
  show("m-40");
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe ids={["m-40"]} hasOlder />);
  });
  expect(loadOlder).toHaveBeenCalledTimes(1);
  expect(onFound).not.toHaveBeenCalled();
  const target = show("m-1");
  act(() => renderer.update(<Probe ids={["m-1", "m-40"]} hasOlder={false} />));
  expect(onFound).toHaveBeenCalledTimes(1);
  expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  expect(target.dataset.highlighted).toBe("true");
  act(() => jest.advanceTimersByTime(MESSAGE_HIGHLIGHT_MS));
  expect(target.dataset.highlighted).toBeUndefined();
  // Only once: later renders leave the reader where they scrolled.
  act(() =>
    renderer.update(<Probe ids={["m-1", "m-40", "m-41"]} hasOlder={false} />),
  );
  expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  act(() => renderer.unmount());
});

test("a message without its own element scrolls to the one before it", () => {
  const nodes = [
    {
      dataset: { messageId: "m-1" } as Record<string, string>,
      scrollIntoView: jest.fn(),
    },
  ];
  const container = {
    current: { querySelectorAll: () => nodes } as unknown as HTMLElement,
  };
  function Probe() {
    useMessageLink({
      container,
      ready: true,
      messageIds: ["m-1", "m-card"],
      hasOlder: false,
      loadOlder: () => {},
      onFound: () => {},
    });
    return null;
  }
  mockSearch = "?m=m-card";
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  expect(nodes[0]!.scrollIntoView).toHaveBeenCalled();
  expect(nodes[0]!.dataset.highlighted).toBe("true");
  act(() => renderer.unmount());
});
