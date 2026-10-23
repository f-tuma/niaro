import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { webcrypto } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  commandTarget,
  type ClientSession,
  type SessionCommand,
  type SessionState,
} from "../packages/client-core/session";
import type { Store } from "../packages/client-core/store";
import type {
  Conversation,
  ConversationSummary,
  NativeQuestion,
  WorkItem,
} from "../packages/protocol";
import {
  MENTIONS_PROFILE,
  type MentionDirectory,
} from "../packages/protocol/mentions";
import { ChatConversation } from "../apps/server-admin/web/app/chat-page";
import { draftKey, saveDraft } from "../apps/server-admin/web/app/chat-store";
import {
  ChatHistoryNav,
  searchChats,
} from "../apps/server-admin/web/app/chat-history";
import {
  filterMentions,
  insertMention,
  mentionQuery,
  mentionsInText,
  messageMentions,
  removeMention,
} from "../apps/server-admin/web/app/chat-composer";
import { questionAnswer } from "../apps/server-admin/web/app/chat-question";
import { ArchivedChats } from "../apps/server-admin/web/app/archived-chats";
import { conversationNamesKey } from "../packages/client-core/conversation-preferences";
import { ConversationOpenWorkError } from "../packages/client-core/conversation-directory";

if (!globalThis.crypto?.randomUUID)
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const mockApp: { session?: unknown } = {};
jest.mock("@tanstack/react-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Link: ({
      to,
      params: _params,
      ...props
    }: React.ComponentProps<"a"> & { to: string; params?: unknown }) =>
      React.createElement("a", { ...props, href: to }),
    useNavigate: () => jest.fn(),
    useParams: () => ({}),
    useRouterState: () => "/",
  };
});
// Generated charts draw with recharts, which Jest cannot parse.
jest.mock("../apps/server-admin/web/app/generative-ui/charts", () => ({}));
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({ language: "cs", session: mockApp.session }),
  useAppSession: () => {
    throw new Error("Pass the session directly");
  },
}));
const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input-group", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/label", () => host(), { virtual: true });
jest.mock("@admin/components/ui/switch", () => host(), { virtual: true });
jest.mock("@admin/components/ui/progress", () => host(), { virtual: true });
jest.mock("@admin/components/ui/separator", () => host(), { virtual: true });
jest.mock("@admin/components/ui/radio-group", () => host(), { virtual: true });
jest.mock("@admin/components/ui/spinner", () => host(), { virtual: true });
jest.mock("@admin/components/ui/item", () => host(), { virtual: true });
jest.mock("@admin/components/ui/sidebar", () => host(), { virtual: true });
jest.mock("@admin/components/ui/dropdown-menu", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/ui/tooltip", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert-dialog", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/ui/badge", () => host(), { virtual: true });
jest.mock("@admin/components/ui/kbd", () => host(), { virtual: true });
jest.mock("@admin/components/ui/checkbox", () => host(), { virtual: true });
jest.mock("@admin/components/console/status", () => host(), { virtual: true });
jest.mock("@admin/components/console/page", () => host(), { virtual: true });
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });
jest.mock("@admin/components/console/time", () => host(), { virtual: true });
jest.mock("@admin/components/console/disclosure", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/entity-icon", () => host(), {
  virtual: true,
});
jest.mock(
  "@admin/components/ui/markdown",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      Markdown: ({ text }: { text: string }) =>
        React.createElement("div", { "data-host": "Markdown" }, text),
    };
  },
  { virtual: true },
);

const scope = {
  connectionId: "connection-1",
  serverId: "server-1",
  userId: "user-1",
  workspaceId: "workspace-1",
};
const summary = (
  id: string,
  extra: Partial<ConversationSummary> = {},
): ConversationSummary => ({
  id,
  revision: 4,
  title: "Klient",
  createdAt: "2026-10-16T08:00:00.000Z",
  updatedAt: "2026-10-16T09:00:00.000Z",
  messageCount: 2,
  readOnly: false,
  ...extra,
});
const storeWith = (
  conversations: Conversation[],
  workItems: WorkItem[] = [],
): Store => ({
  connectionKey: "https://aa.example/v1/a",
  scope,
  cursor: 1,
  conversations: Object.fromEntries(conversations.map((c) => [c.id, c])),
  workItems: Object.fromEntries(workItems.map((w) => [w.id, w])),
  inputRequests: {},
  actionProposals: {},
  operations: {},
  seen: [],
  stale: false,
  needsSnapshot: false,
});
const directory: MentionDirectory = {
  profile: MENTIONS_PROFILE,
  items: [
    { kind: "service", id: "svc-crm", name: "CRM", description: "Twenty" },
    { kind: "process", id: "proc-onboard", name: "Onboarding klienta" },
    { kind: "skill", id: "skill-mail", name: "Krátký e-mail" },
  ],
};
function fakeSession(
  store: Store,
  mentions: () => Promise<MentionDirectory> = async () => directory,
) {
  let state: SessionState = {
    store,
    status: "online",
    commandStates: {},
    pending: null,
    processPending: null,
    answerAttempts: [],
    answerRecoveryBlocked: false,
    error: null,
    processNotice: null,
    activity: null,
    activityConnection: "waiting",
  };
  const listeners = new Set<() => void>();
  const sent: SessionCommand[] = [];
  const publish = (update: Partial<SessionState>) => {
    state = { ...state, ...update };
    listeners.forEach((listener) => listener());
  };
  const session = {
    identityKey: "identity-1",
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    start: jest.fn(async () => {}),
    refresh: jest.fn(async () => {}),
    selectConversation: jest.fn(),
    retry: jest.fn(async () => {}),
    interruptPending: jest.fn(async () => true),
    canRetryNativeWork: () => false,
    getRetrySource: () => undefined,
    discardProcessAnswerAttempt: jest.fn(async () => true),
    readMentions: jest.fn(mentions),
    getDirectoryVersion: () => 0,
    renameConversation: jest.fn(async () => {}),
    deleteConversation: jest.fn(async () => {}),
    archiveConversation: jest.fn(async () => {}),
    restoreConversation: jest.fn(async () => {}),
    cancelWork: jest.fn(async () => {}),
    readConversations: jest.fn(async () => ({
      conversations: [],
      nextAfter: null,
    })),
    readConversation: jest.fn(async (id: string) => ({
      profile: "agent-conversations/1",
      scope,
      conversation: summary(id),
      messages: (state.store?.conversations[id]?.messages ?? []).map(
        ({ result: _result, ...message }) => message,
      ),
      nextAfter: null,
    })),
    send: jest.fn(async (command: SessionCommand) => {
      sent.push(command);
      publish({
        commandStates: {
          ...state.commandStates,
          [commandTarget(command)]: "accepted",
        },
      });
    }),
  };
  return { session: session as unknown as ClientSession, sent, publish };
}

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              queries: { retry: false, gcTime: Infinity },
              mutations: { gcTime: Infinity },
            },
          })
        }
      >
        {element}
      </QueryClientProvider>,
    );
  });
  await settle();
  return renderer.root;
}
const renderChat = (session: ClientSession, routeId?: string) =>
  render(
    <ChatConversation
      session={session}
      routeId={routeId}
      onSaved={jest.fn()}
    />,
  );
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
function button(root: ReactTestInstance, label: string) {
  const found = root.findAll(
    (node) =>
      node.type === "button" &&
      (node.props["aria-label"] === label || text(node).includes(label)),
  );
  if (!found.length) throw new Error(`No button "${label}"`);
  return found[0]!;
}
/** An item of a row's "…" menu (the host mock renders menus open). */
function rowMenuItem(root: ReactTestInstance, label: string) {
  const found = root.findAll(
    (node) =>
      typeof node.type === "string" &&
      node.props["data-host"] === "DropdownMenuItem" &&
      text(node).includes(label),
  );
  if (!found.length) throw new Error(`No menu item "${label}"`);
  return found[0]!;
}
const byTestId = (root: ReactTestInstance, id: string) =>
  root.find((node) => node.props["data-testid"] === id);
const allByTestId = (root: ReactTestInstance, id: string) =>
  root.findAll((node) => node.props["data-testid"] === id);
const key = (
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  key: name,
  shiftKey: false,
  nativeEvent: { isComposing: false },
  preventDefault: jest.fn(),
  ...extra,
});
async function typeInto(root: ReactTestInstance, value: string) {
  await act(async () =>
    root.findByType("textarea").props.onChange({
      target: { value, selectionStart: value.length },
    }),
  );
}
async function press(root: ReactTestInstance, name: string) {
  await act(async () => root.findByType("textarea").props.onKeyDown(key(name)));
  await act(async () => {});
}

/** Query results reach the page on the next ticks. */
async function settle() {
  for (let tick = 0; tick < 4; tick++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

/** Window key listeners, as the page registers them. */
const keyListeners = new Set<(event: KeyboardEvent) => void>();
beforeAll(() => {
  Object.assign(window, {
    addEventListener: (type: string, listener: (e: KeyboardEvent) => void) => {
      if (type === "keydown") keyListeners.add(listener);
    },
    removeEventListener: (
      type: string,
      listener: (e: KeyboardEvent) => void,
    ) => {
      if (type === "keydown") keyListeners.delete(listener);
    },
  });
});
async function windowKey(name: string, target: unknown = { tagName: "BODY" }) {
  const event = {
    key: name,
    target,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: jest.fn(),
  } as unknown as KeyboardEvent;
  await act(async () => keyListeners.forEach((listener) => listener(event)));
  await act(async () => {});
}
beforeEach(() => keyListeners.clear());

const question = (extra: Partial<NativeQuestion> = {}): NativeQuestion => ({
  runtime: "mastra",
  id: "question-1",
  revision: 1,
  workItemId: "work-1",
  conversationId: "conv-1",
  question: "Který den?",
  status: "open",
  options: ["Pondělí", "Úterý", "Středa"],
  ...extra,
});
const asking = (q: NativeQuestion) =>
  ({
    id: "work-1",
    conversationId: "conv-1",
    revision: 2,
    title: "Schůzka",
    context: q.question,
    status: "waiting_input",
    inputRequestIds: [],
    actionProposalIds: [],
    operationIds: [],
    demo: false,
    native: { runId: "work-1", revision: 2, question: q },
    presentation: {
      type: "workflow.progress",
      version: 1,
      variant: "default",
    },
  }) as WorkItem;
const chat = (messages: Conversation["messages"]): Conversation => ({
  id: "conv-1",
  revision: 4,
  messages,
});

describe("questions from the assistant", () => {
  test("one offered answer sends at once to that question; the draft stays", async () => {
    const { session, sent } = fakeSession(
      storeWith(
        [chat([{ id: "m-1", role: "user", text: "Domluv schůzku" }])],
        [asking(question())],
      ),
    );
    const root = await renderChat(session, "conv-1");
    await typeInto(root, "rozepsáno");
    const choices = byTestId(root, "question-choices");
    await act(async () => button(choices, "Úterý").props.onClick());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "message.send",
      conversationId: "conv-1",
      text: "Úterý",
      context: {
        workItemId: "work-1",
        inputRequestId: "question-1",
        expectedInputRevision: 1,
        runtime: "mastra",
      },
    });
    expect(sent[0]).not.toHaveProperty("mentions");
    expect(root.findByType("textarea").props.value).toBe("rozepsáno");
  });

  test("several answers are ticked and sent together in the offered order", async () => {
    const { session, sent } = fakeSession(
      storeWith([chat([])], [asking(question({ multiple: true }))]),
    );
    const root = await renderChat(session, "conv-1");
    const choices = byTestId(root, "question-choices");
    const boxes = choices.findAll(
      (node) => node.props["data-host"] === "Checkbox",
    );
    expect(boxes).toHaveLength(3);
    expect(button(choices, "Odeslat").props.disabled).toBe(true);
    await act(async () => boxes[2]!.props.onCheckedChange(true));
    await act(async () => boxes[0]!.props.onCheckedChange(true));
    await act(async () => button(choices, "Odeslat").props.onClick());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ text: "Pondělí, Středa" });
  });

  test("Other opens the composer as the answer to the question", async () => {
    const { session, sent } = fakeSession(
      storeWith([chat([])], [asking(question())]),
    );
    const root = await renderChat(session, "conv-1");
    // Offered answers carry their own way to type; no second reply button.
    expect(() => button(root, "Odpovědět v chatu")).toThrow();
    await act(async () =>
      button(byTestId(root, "question-choices"), "Jiné…").props.onClick(),
    );
    await typeInto(root, "Až příští týden");
    await press(root, "Enter");
    expect(sent[0]).toMatchObject({
      text: "Až příští týden",
      context: { inputRequestId: "question-1", runtime: "mastra" },
    });
  });

  test("digits pick an answer unless the person is typing", async () => {
    const { session, sent } = fakeSession(
      storeWith([chat([])], [asking(question())]),
    );
    await renderChat(session, "conv-1");
    await windowKey("2", { tagName: "TEXTAREA" });
    await windowKey("9");
    expect(sent).toHaveLength(0);
    await windowKey("3");
    expect(sent[0]).toMatchObject({ text: "Středa" });
  });

  test("a question without options is answered by typing, as before", async () => {
    const { session } = fakeSession(
      storeWith([chat([])], [asking(question({ options: undefined }))]),
    );
    const root = await renderChat(session, "conv-1");
    expect(allByTestId(root, "question-choices")).toHaveLength(0);
    expect(button(root, "Odpovědět v chatu")).toBeTruthy();
  });

  test("offered answers join in the order they were offered", () => {
    expect(questionAnswer(question(), ["Středa", "Pondělí"])).toBe(
      "Pondělí, Středa",
    );
  });
});

describe("message actions", () => {
  const conversation = chat([
    { id: "m-1", role: "user", text: "Shrň @CRM" },
    { id: "m-2", role: "assistant", text: "**Hotovo**" },
    { id: "m-3", role: "user", text: "A co Jan?" },
    { id: "m-4", role: "assistant", text: "Jan je v pořádku." },
  ]);

  test("copy takes the message as written", async () => {
    const writeText = jest.fn(async () => {});
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { session } = fakeSession(storeWith([conversation]));
    const root = await renderChat(session, "conv-1");
    const actions = allByTestId(root, "message-actions");
    expect(actions).toHaveLength(4);
    await act(async () => button(actions[1]!, "Kopírovat").props.onClick());
    expect(writeText).toHaveBeenCalledWith("**Hotovo**");
    await act(async () => button(actions[2]!, "Kopírovat").props.onClick());
    expect(writeText).toHaveBeenLastCalledWith("A co Jan?");
    expect(button(actions[2]!, "Zkopírováno")).toBeTruthy();
    // The confirmation fades back to the action.
    await act(() => new Promise((resolve) => setTimeout(resolve, 1600)));
    expect(button(actions[2]!, "Kopírovat")).toBeTruthy();
  });

  test("Again resends the previous request as a new message", async () => {
    const { session, sent } = fakeSession(storeWith([conversation]));
    const root = await renderChat(session, "conv-1");
    const actions = allByTestId(root, "message-actions");
    // Only the latest answer can be asked again.
    expect(() => button(actions[1]!, "Znovu")).toThrow();
    await typeInto(root, "rozepsáno");
    await act(async () => button(actions[3]!, "Znovu").props.onClick());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "message.send",
      conversationId: "conv-1",
      text: "A co Jan?",
    });
    const command = sent[0] as Extract<
      SessionCommand,
      { type: "message.send" }
    >;
    expect(command.retryOf).toBeUndefined();
    expect(command.context).toBeUndefined();
    expect(root.findByType("textarea").props.value).toBe("rozepsáno");
  });

  test("Edit brings the last request back to the composer without sending", async () => {
    const { session, sent } = fakeSession(storeWith([conversation]));
    const root = await renderChat(session, "conv-1");
    const actions = allByTestId(root, "message-actions");
    expect(() => button(actions[0]!, "Upravit")).toThrow();
    await act(async () => button(actions[2]!, "Upravit").props.onClick());
    expect(root.findByType("textarea").props.value).toBe("A co Jan?");
    expect(sent).toHaveLength(0);
    await press(root, "Enter");
    expect(sent[0]).toMatchObject({ text: "A co Jan?" });
  });

  test("an edited message brings its tags back", async () => {
    const { session, sent } = fakeSession(
      storeWith([chat([{ id: "m-1", role: "user", text: "Shrň @CRM" }])]),
    );
    const root = await renderChat(session, "conv-1");
    await act(async () => button(root, "Upravit").props.onClick());
    expect(text(byTestId(root, "composer-mentions"))).toContain("CRM");
    await press(root, "Enter");
    expect(sent[0]).toMatchObject({
      mentions: [{ kind: "service", id: "svc-crm" }],
    });
  });

  test("a sent meeting tag stays on the message, its edit and its resend", async () => {
    // Meetings aren't in the directory; "Ask" hands the tag in the draft.
    const asked = "K schůzce „@Nabídka pro klienta“: co dál?";
    const meeting = { kind: "meeting" as const, id: "meet-1" };
    saveDraft(draftKey("identity-1", "conv-1"), {
      text: asked,
      revision: 0,
      mentions: [{ ...meeting, name: "Nabídka pro klienta" }],
    });
    const { session, sent, publish } = fakeSession(storeWith([chat([])]));
    const root = await renderChat(session, "conv-1");
    await press(root, "Enter");
    expect(sent[0]).toMatchObject({ mentions: [meeting] });
    await act(async () =>
      publish({
        store: storeWith([
          {
            ...chat([
              { id: "m-1", role: "user", text: asked },
              { id: "m-2", role: "assistant", text: "Pošli nabídku." },
            ]),
            revision: 5,
          },
        ]),
      }),
    );
    await settle();
    expect(text(byTestId(root, "message-mentions"))).toContain(
      "Nabídka pro klienta",
    );
    await act(async () => button(root, "Znovu").props.onClick());
    expect(sent[1]).toMatchObject({ text: asked, mentions: [meeting] });
    await act(async () => button(root, "Upravit").props.onClick());
    expect(text(byTestId(root, "composer-mentions"))).toContain(
      "Nabídka pro klienta",
    );
  });
});

describe("tagging with @", () => {
  test("the picker filters, moves with the keys and turns picks into tags", async () => {
    const { session, sent } = fakeSession(
      storeWith([chat([{ id: "m-1", role: "user", text: "Ahoj" }])]),
    );
    const root = await renderChat(session, "conv-1");
    await typeInto(root, "Pošli @k");
    const picker = byTestId(root, "mention-picker");
    // "Krátký e-mail" starts with k; "Onboarding klienta" has a word that does.
    expect(
      picker
        .findAll(
          (node) =>
            typeof node.type === "string" && node.props.role === "option",
        )
        .map((option) => text(option)),
    ).toEqual([
      expect.stringContaining("Krátký e-mail"),
      expect.stringContaining("Onboarding klienta"),
    ]);
    const field = root.findByType("textarea");
    expect(field.props.role).toBe("combobox");
    expect(field.props["aria-expanded"]).toBe(true);
    await press(root, "ArrowDown");
    expect(root.findByType("textarea").props["aria-activedescendant"]).toMatch(
      /-1$/,
    );
    await press(root, "Enter");
    expect(root.findByType("textarea").props.value).toBe(
      "Pošli @Onboarding klienta ",
    );
    expect(allByTestId(root, "mention-picker")).toHaveLength(0);
    expect(text(byTestId(root, "composer-mentions"))).toContain(
      "Onboarding klienta",
    );
    await typeInto(root, "Pošli @Onboarding klienta Janovi @");
    await act(async () =>
      byTestId(root, "mention-picker")
        .findAll((node) => node.props.role === "option")[0]!
        .props.onClick(),
    );
    expect(root.findByType("textarea").props.value).toBe(
      "Pošli @Onboarding klienta Janovi @CRM ",
    );
    await press(root, "Enter");
    expect(sent[0]).toMatchObject({
      type: "message.send",
      text: "Pošli @Onboarding klienta Janovi @CRM",
      mentions: [
        { kind: "process", id: "proc-onboard" },
        { kind: "service", id: "svc-crm" },
      ],
    });
  });

  test("the @ button starts a tag at the end of the text and opens the picker", async () => {
    const { session } = fakeSession(
      storeWith([chat([{ id: "m-1", role: "user", text: "Ahoj" }])]),
    );
    const root = await renderChat(session, "conv-1");
    await typeInto(root, "Pošli");
    await act(async () => button(root, "Označit").props.onClick());
    expect(root.findByType("textarea").props.value).toBe("Pošli @");
    expect(byTestId(root, "mention-picker")).toBeTruthy();
  });

  test("Escape closes the picker and a removed chip drops its text", async () => {
    const { session, sent } = fakeSession(storeWith([chat([])]));
    const root = await renderChat(session, "conv-1");
    await typeInto(root, "@cr");
    await press(root, "Escape");
    expect(allByTestId(root, "mention-picker")).toHaveLength(0);
    await typeInto(root, "@cr");
    await press(root, "Tab");
    expect(root.findByType("textarea").props.value).toBe("@CRM ");
    await act(async () =>
      button(
        byTestId(root, "composer-mentions"),
        "Odebrat: CRM",
      ).props.onClick(),
    );
    expect(root.findByType("textarea").props.value).toBe("");
    await typeInto(root, "Ahoj");
    await press(root, "Enter");
    expect(sent[0]).not.toHaveProperty("mentions");
  });

  test("a sent message shows what it tagged", async () => {
    const { session } = fakeSession(
      storeWith([chat([{ id: "m-1", role: "user", text: "Shrň @CRM" }])]),
    );
    const root = await renderChat(session, "conv-1");
    expect(text(byTestId(root, "message-mentions"))).toContain("CRM");
  });

  test("without the directory (404) there is no picker", async () => {
    const { session, sent } = fakeSession(storeWith([chat([])]), async () => {
      throw new Error("mentions_unavailable");
    });
    const root = await renderChat(session, "conv-1");
    await typeInto(root, "Ahoj @cr");
    expect(allByTestId(root, "mention-picker")).toHaveLength(0);
    expect(root.findByType("textarea").props.role).toBeUndefined();
    await press(root, "Enter");
    expect(sent[0]).toMatchObject({ text: "Ahoj @cr" });
    expect(sent[0]).not.toHaveProperty("mentions");
  });

  test("tag helpers find, insert and remove tags", () => {
    expect(mentionQuery("Ahoj @kr", 8)).toEqual({ start: 5, query: "kr" });
    expect(mentionQuery("mail@firma.cz", 13)).toBeNull();
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(filterMentions(directory.items, "kratky")[0]?.id).toBe("skill-mail");
    expect(
      insertMention("A @cr B", { start: 2, query: "cr" }, directory.items[0]!),
    ).toEqual({ text: "A @CRM B", caret: 7 });
    expect(removeMention("Shrň @CRM a dál", directory.items[0]!)).toBe(
      "Shrň a dál",
    );
    // "@CRMko" is a different word, not the CRM tag.
    expect(messageMentions("@CRMko", directory.items)).toEqual([]);
    expect(
      mentionsInText("@CRM a @Krátký e-mail", directory.items),
    ).toHaveLength(2);
  });

  test("the composer refuses a message over the protocol's length", async () => {
    const { session, sent } = fakeSession(storeWith([chat([])]));
    const root = await renderChat(session, "conv-1");
    await typeInto(root, "a".repeat(4001));
    expect(root.findByType("textarea").props["aria-invalid"]).toBe(true);
    await press(root, "Enter");
    expect(sent).toHaveLength(0);
    expect(root.findByType("textarea").props.value).toHaveLength(4001);
  });

  test("Escape stops a running answer", async () => {
    const { session, publish } = fakeSession(storeWith([chat([])]));
    await renderChat(session, "conv-1");
    await act(async () =>
      publish({
        pending: {
          type: "message.send",
          commandId: "c-2",
          idempotencyKey: "c-2",
          conversationId: "conv-1",
          text: "Najdi Jana",
          language: "cs",
        },
        commandStates: { chat: "sending" },
      }),
    );
    await windowKey("Escape");
    expect(session.interruptPending).toHaveBeenCalled();
  });
});

describe("chat history", () => {
  const storage = new Map<string, string>();
  beforeAll(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
      },
    });
  });
  beforeEach(() => storage.clear());

  test("search matches titles without case or accents", () => {
    const rows = [
      { id: "a", title: "Schůzka s Janem" },
      { id: "b", title: "Faktury" },
    ];
    expect(
      searchChats(rows, "SCHUZKA jan", (row) => row.title).map((r) => r.id),
    ).toEqual(["a"]);
    expect(searchChats(rows, " ", (row) => row.title)).toHaveLength(2);
  });

  async function renderHistory(
    pages: { conversations: ConversationSummary[]; nextAfter: string | null }[],
  ) {
    const { session } = fakeSession(storeWith([]));
    (session.readConversations as jest.Mock).mockImplementation(
      async (after: string | null) => ({
        profile: "agent-conversations/1",
        scope,
        ...pages[after ? Number(after.slice("next-".length)) : 0]!,
      }),
    );
    mockApp.session = session;
    const root = await render(<ChatHistoryNav />);
    await settle();
    return { root, session };
  }
  const titles = (root: ReactTestInstance) =>
    root.findAll((node) => node.type === "a").map((link) => text(link).trim());
  test("the list has no title filter (search is its own screen) and loads older chats on demand", async () => {
    const { root, session } = await renderHistory([
      {
        conversations: [
          summary("chat-1", { title: "Schůzka s Janem" }),
          summary("chat-2", { title: "Faktury" }),
        ],
        nextAfter: "next-1",
      },
      {
        conversations: [
          summary("chat-3", {
            title: "Rozpočet",
            updatedAt: "2026-10-01T09:00:00.000Z",
          }),
        ],
        nextAfter: null,
      },
    ]);
    expect(titles(root)).toEqual(["Schůzka s Janem", "Faktury"]);
    expect(
      root.findAll(
        (node) =>
          typeof node.type === "string" &&
          node.props["data-host"] === "SidebarInput",
      ),
    ).toHaveLength(0);
    await act(async () => button(root, "Zobrazit další").props.onClick());
    await settle();
    expect(session.readConversations).toHaveBeenLastCalledWith(
      "next-1",
      expect.anything(),
      "active",
    );
    expect(titles(root)).toEqual(["Schůzka s Janem", "Faktury", "Rozpočet"]);
  });

  /** The first listed chat's menu item. */
  const menuItem = (root: ReactTestInstance, label: string) =>
    root.findAll(
      (node) =>
        typeof node.type === "string" &&
        node.props["data-host"] === "DropdownMenuItem" &&
        text(node).includes(label),
    )[0]!;

  test("a chat is renamed on the server; the old browser-only names are dropped", async () => {
    storage.set(
      conversationNamesKey("identity-1"),
      JSON.stringify({ version: 1, names: { "chat-1": "Starý" } }),
    );
    const { root, session } = await renderHistory([
      {
        conversations: [summary("chat-1", { title: "Klient" })],
        nextAfter: null,
      },
    ]);
    expect(storage.has(conversationNamesKey("identity-1"))).toBe(false);
    expect(titles(root)).toEqual(["Klient"]);
    await act(async () => menuItem(root, "Přejmenovat").props.onSelect());
    const field = () =>
      root.find(
        (node) =>
          typeof node.type === "string" &&
          node.props["data-host"] === "SidebarInput" &&
          node.props["aria-label"] === "Název chatu",
      );
    expect(field().props.defaultValue).toBe("Klient");
    await act(async () =>
      field().props.onKeyDown({
        key: "Enter",
        currentTarget: { value: "Můj klient" },
        preventDefault: () => {},
      }),
    );
    await settle();
    expect(session.renameConversation).toHaveBeenCalledWith(
      "chat-1",
      "Můj klient",
      expect.any(String),
    );
    // Unchanged names send nothing.
    await act(async () => menuItem(root, "Přejmenovat").props.onSelect());
    await act(async () =>
      field().props.onBlur({ currentTarget: { value: "Klient " } }),
    );
    expect(session.renameConversation).toHaveBeenCalledTimes(1);
  });

  test("deleting asks first, then removes the chat everywhere", async () => {
    const { root, session } = await renderHistory([
      {
        conversations: [
          summary("chat-1", { title: "Klient" }),
          summary("chat-2", { title: "Faktury" }),
        ],
        nextAfter: null,
      },
    ]);
    const dialog = () =>
      root.find(
        (node) =>
          typeof node.type === "string" &&
          node.props["data-host"] === "AlertDialog",
      );
    expect(dialog().props.open).toBe(false);
    await act(async () => menuItem(root, "Smazat").props.onSelect());
    expect(dialog().props.open).toBe(true);
    expect(text(dialog())).toContain("Klient");
    expect(session.deleteConversation).not.toHaveBeenCalled();
    const confirm = root.find(
      (node) =>
        typeof node.type === "string" &&
        node.props["data-host"] === "AlertDialogAction",
    );
    expect(confirm.props.variant).toBe("destructive");
    (session.readConversations as jest.Mock).mockImplementation(async () => ({
      profile: "agent-conversations/1",
      scope,
      conversations: [summary("chat-2", { title: "Faktury" })],
      nextAfter: null,
    }));
    await act(async () => confirm.props.onClick());
    await settle();
    expect(session.deleteConversation).toHaveBeenCalledWith(
      "chat-1",
      expect.any(String),
    );
    expect(titles(root)).toEqual(["Faktury"]);
  });

  test("a chat still answering is not deleted and says so", async () => {
    const { root, session } = await renderHistory([
      {
        conversations: [summary("chat-1", { title: "Klient" })],
        nextAfter: null,
      },
    ]);
    (session.deleteConversation as jest.Mock).mockRejectedValueOnce(
      new Error("conversation_busy"),
    );
    await act(async () => menuItem(root, "Smazat").props.onSelect());
    await act(async () =>
      root
        .find(
          (node) =>
            typeof node.type === "string" &&
            node.props["data-host"] === "AlertDialogAction",
        )
        .props.onClick(),
    );
    await settle();
    expect(text(root)).toContain("Chat ještě odpovídá");
    expect(titles(root)).toEqual(["Klient"]);
  });
});

describe("archived chats", () => {
  const storage = new Map<string, string>();
  beforeAll(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
      },
    });
  });
  const links = (root: ReactTestInstance) =>
    root.findAll((node) => node.type === "a").map((link) => text(link).trim());
  const menuItems = (root: ReactTestInstance, label: string) =>
    root.findAll(
      (node) =>
        typeof node.type === "string" &&
        node.props["data-host"] === "DropdownMenuItem" &&
        text(node).includes(label),
    );

  test("the sidebar lists only active chats; Archivovat moves one out, never a hub item's chat", async () => {
    const { session } = fakeSession(storeWith([]));
    (session.readConversations as jest.Mock).mockImplementation(async () => ({
      profile: "agent-conversations/1",
      scope,
      conversations: [
        summary("chat-1", { title: "Klient" }),
        summary("chat-hub-1", { title: "Přehled" }),
        // An older server lists the archive too; it never shows here.
        summary("archived-1", { title: "Starý", readOnly: true }),
      ],
      nextAfter: null,
    }));
    mockApp.session = session;
    const root = await render(<ChatHistoryNav />);
    expect(session.readConversations).toHaveBeenCalledWith(
      null,
      expect.anything(),
      "active",
    );
    expect(links(root)).toEqual(["Klient", "Přehled"]);
    // One row offers it: the hub item's chat does not.
    expect(menuItems(root, "Archivovat")).toHaveLength(1);
    (session.archiveConversation as jest.Mock).mockRejectedValueOnce(
      new Error("conversation_open_work"),
    );
    await act(async () => menuItems(root, "Archivovat")[0]!.props.onSelect());
    await settle();
    expect(text(root)).toContain("Chat čeká na tvoji odpověď");
    expect(links(root)).toContain("Klient");
    await act(async () => menuItems(root, "Archivovat")[0]!.props.onSelect());
    await settle();
    expect(session.archiveConversation).toHaveBeenLastCalledWith(
      "chat-1",
      expect.any(String),
    );
    expect(links(root)).toEqual(["Přehled"]);
  });

  test("the account page lists the archive: open, restore, delete after a confirmation", async () => {
    const { session } = fakeSession(storeWith([]));
    (session.readConversations as jest.Mock).mockImplementation(async () => ({
      profile: "agent-conversations/1",
      scope,
      conversations: [
        summary("archived-1", {
          title: "Rozpočet",
          readOnly: true,
          messageCount: 3,
        }),
        summary("chat-9", {
          title: "Faktury",
          readOnly: true,
          messageCount: 5,
          updatedAt: "2026-10-17T09:00:00.000Z",
        }),
      ],
      nextAfter: null,
    }));
    mockApp.session = session;
    const root = await render(<ArchivedChats />);
    expect(session.readConversations).toHaveBeenCalledWith(
      null,
      expect.anything(),
      "archived",
    );
    // Newest first, each opening the chat (read only) by its address.
    expect(links(root)).toEqual(["Faktury", "Rozpočet"]);
    expect(
      root.findAll((node) => node.type === "a").map((a) => a.props.href),
    ).toEqual(["/chat/$conversationId", "/chat/$conversationId"]);
    expect(text(root)).toContain("5 zpráv");
    expect(text(root)).toContain("3 zprávy");

    await act(async () => button(root, "Obnovit").props.onClick());
    await settle();
    expect(session.restoreConversation).toHaveBeenCalledWith(
      "chat-9",
      expect.any(String),
    );
    expect(links(root)).toEqual(["Rozpočet"]);

    const confirm = () =>
      root.find(
        (node) =>
          typeof node.type === "string" &&
          node.props["data-host"] === "ConfirmAction",
      );
    expect(confirm().props.open).toBe(false);
    // Delete lives in the row's "…" menu, labelled per chat, like the sidebar.
    expect(
      root
        .findAll(
          (node) =>
            typeof node.type === "string" &&
            node.props["data-host"] === "MoreActions",
        )
        .map((node) => node.props.label),
    ).toEqual(["Možnosti chatu: Rozpočet"]);
    await act(async () => rowMenuItem(root, "Smazat").props.onSelect());
    expect(confirm().props.open).toBe(true);
    expect(confirm().props.description).toContain("Rozpočet");
    expect(session.deleteConversation).not.toHaveBeenCalled();
    await act(async () => confirm().props.onConfirm());
    await settle();
    expect(session.deleteConversation).toHaveBeenCalledWith(
      "archived-1",
      expect.any(String),
    );
    expect(links(root)).toEqual([]);
    expect(text(root)).toContain("Nic tu není.");
  });

  test("a long archive gets a search", async () => {
    const { session } = fakeSession(storeWith([]));
    (session.readConversations as jest.Mock).mockImplementation(async () => ({
      profile: "agent-conversations/1",
      scope,
      conversations: Array.from({ length: 9 }, (_, index) =>
        summary(`archived-${index + 1}`, {
          title: index === 4 ? "Schůzka s Janem" : `Chat ${index + 1}`,
          readOnly: true,
        }),
      ),
      nextAfter: null,
    }));
    mockApp.session = session;
    const root = await render(<ArchivedChats />);
    const field = root.find(
      (node) =>
        typeof node.type === "string" &&
        node.props["data-host"] === "Input" &&
        node.props.type === "search",
    );
    await act(async () =>
      field.props.onChange({ target: { value: "schuzka" } }),
    );
    expect(links(root)).toEqual(["Schůzka s Janem"]);
  });
});

describe("message times", () => {
  test("a timed message shows its time and a new day gets a divider; untimed ones show none", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(9, 5, 0, 0);
    const today = new Date();
    today.setHours(0, 30, 0, 0);
    const { session } = fakeSession(
      storeWith([
        chat([
          { id: "m-0", role: "user", text: "Bez času" },
          {
            id: "m-1",
            role: "user",
            text: "Včerejší",
            createdAt: yesterday.toISOString(),
          },
          {
            id: "m-2",
            role: "assistant",
            text: "Odpověď",
            createdAt: yesterday.toISOString(),
          },
          {
            id: "m-3",
            role: "user",
            text: "Dnešní",
            createdAt: today.toISOString(),
          },
        ]),
      ]),
    );
    const root = await renderChat(session, "conv-1");
    const times = root.findAll((node) => node.type === "time");
    expect(times.map((node) => node.props.dateTime)).toEqual([
      yesterday.toISOString(),
      yesterday.toISOString(),
      today.toISOString(),
    ]);
    expect(text(times[0]!)).toBe("09:05");
    const separators = root
      .findAll((node) => node.type === "div" && node.props.role === "separator")
      .map((node) => node.props["aria-label"]);
    expect(separators).toEqual(["Včera", "Dnes"]);
  });
});

describe("open work in a chat", () => {
  const storage = new Map<string, string>();
  beforeAll(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
      },
    });
  });
  const waiting = new ConversationOpenWorkError([
    { workItemId: "run-1", title: "Schůzka s Petrem", kind: "question" },
    { workItemId: "run-2", title: "Onboarding klienta", kind: "process" },
  ]);
  const hosts = (root: ReactTestInstance, name: string) =>
    root.findAll(
      (node) =>
        typeof node.type === "string" && node.props["data-host"] === name,
    );
  const openWorkDialog = (root: ReactTestInstance) =>
    hosts(root, "AlertDialog").find((dialog) =>
      text(dialog).includes("V chatu čeká"),
    );
  async function sidebar() {
    const { session } = fakeSession(storeWith([]));
    (session.readConversations as jest.Mock).mockImplementation(async () => ({
      profile: "agent-conversations/1",
      scope,
      conversations: [summary("chat-1", { title: "Klient" })],
      nextAfter: null,
    }));
    mockApp.session = session;
    const root = await render(<ChatHistoryNav />);
    return { root, session };
  }
  const menuItem = (root: ReactTestInstance, label: string) =>
    hosts(root, "DropdownMenuItem").find((node) => text(node).includes(label))!;

  test("a refused delete names what waits and cancels it before deleting", async () => {
    const { root, session } = await sidebar();
    (session.deleteConversation as jest.Mock).mockRejectedValueOnce(waiting);
    await act(async () => menuItem(root, "Smazat").props.onSelect());
    await act(async () => hosts(root, "AlertDialogAction")[0]!.props.onClick());
    await settle();
    const dialog = openWorkDialog(root)!;
    expect(dialog.props.open).toBe(true);
    expect(text(dialog)).toContain("Schůzka s Petrem");
    expect(text(dialog)).toContain("(otázka)");
    expect(text(dialog)).toContain("Onboarding klienta");
    expect(text(dialog)).toContain("(proces)");
    // Nothing went away yet.
    expect(text(root)).toContain("Klient");
    const confirm = hosts(dialog, "AlertDialogAction")[0]!;
    expect(confirm.props.variant).toBe("destructive");
    expect(text(confirm)).toBe("Zrušit a smazat");
    await act(async () => confirm.props.onClick());
    await settle();
    expect(session.deleteConversation).toHaveBeenLastCalledWith(
      "chat-1",
      expect.any(String),
      { cancelOpenWork: true },
    );
    expect(openWorkDialog(root)).toBeUndefined();
  });

  test("a refused archive offers to cancel and archive; keeping it changes nothing", async () => {
    const { root, session } = await sidebar();
    (session.archiveConversation as jest.Mock).mockRejectedValueOnce(waiting);
    await act(async () => menuItem(root, "Archivovat").props.onSelect());
    await settle();
    const dialog = openWorkDialog(root)!;
    expect(text(hosts(dialog, "AlertDialogAction")[0]!)).toBe(
      "Zrušit a archivovat",
    );
    expect(text(hosts(dialog, "AlertDialogCancel")[0]!)).toBe("Nechat");
    await act(async () => dialog.props.onOpenChange(false));
    expect(openWorkDialog(root)).toBeUndefined();
    expect(session.archiveConversation).toHaveBeenCalledTimes(1);
    (session.archiveConversation as jest.Mock).mockRejectedValueOnce(waiting);
    await act(async () => menuItem(root, "Archivovat").props.onSelect());
    await settle();
    await act(async () =>
      hosts(openWorkDialog(root)!, "AlertDialogAction")[0]!.props.onClick(),
    );
    await settle();
    expect(session.archiveConversation).toHaveBeenLastCalledWith(
      "chat-1",
      expect.any(String),
      { cancelOpenWork: true },
    );
  });

  test("an older server's refusal without a list still offers to cancel", async () => {
    const { root, session } = await sidebar();
    (session.deleteConversation as jest.Mock).mockRejectedValueOnce(
      new ConversationOpenWorkError([]),
    );
    await act(async () => menuItem(root, "Smazat").props.onSelect());
    await act(async () => hosts(root, "AlertDialogAction")[0]!.props.onClick());
    await settle();
    const dialog = openWorkDialog(root)!;
    expect(text(dialog)).toContain("Chat čeká na tvoji odpověď");
    expect(text(hosts(dialog, "AlertDialogAction")[0]!)).toBe(
      "Zrušit a smazat",
    );
  });

  test("the archive's delete cancels open work after the same question", async () => {
    const { session } = fakeSession(storeWith([]));
    (session.readConversations as jest.Mock).mockImplementation(async () => ({
      profile: "agent-conversations/1",
      scope,
      conversations: [summary("chat-9", { title: "Faktury", readOnly: true })],
      nextAfter: null,
    }));
    (session.deleteConversation as jest.Mock).mockRejectedValueOnce(waiting);
    mockApp.session = session;
    const root = await render(<ArchivedChats />);
    await act(async () => rowMenuItem(root, "Smazat").props.onSelect());
    await act(async () => hosts(root, "ConfirmAction")[0]!.props.onConfirm());
    await settle();
    const dialog = openWorkDialog(root)!;
    expect(text(dialog)).toContain("Schůzka s Petrem");
    await act(async () =>
      hosts(dialog, "AlertDialogAction")[0]!.props.onClick(),
    );
    await settle();
    expect(session.deleteConversation).toHaveBeenLastCalledWith(
      "chat-9",
      expect.any(String),
      { cancelOpenWork: true },
    );
  });

  test("a waiting native question can be cancelled from its card", async () => {
    const { session } = fakeSession(
      storeWith([chat([])], [asking(question())]),
    );
    const root = await renderChat(session, "conv-1");
    const card = byTestId(root, "work-work-1");
    await act(async () => button(card, "Zrušit").props.onClick());
    await settle();
    expect(session.cancelWork).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "work-1",
        revision: 2,
        conversationId: "conv-1",
      }),
      "cs",
      expect.any(String),
    );
  });

  test("a failed cancel says why; finished or unconfirmed work offers none", async () => {
    const { session } = fakeSession(
      storeWith(
        [chat([])],
        [
          asking(question()),
          {
            ...asking(question()),
            id: "work-2",
            status: "waiting_system",
            native: {
              runId: "work-2",
              revision: 2,
              action: {
                type: "service.action",
                operationId: "op-1",
                service: "CRM",
                title: "Uložit kontakt",
                effect: "write",
                status: "unknown",
              },
            },
          } as unknown as WorkItem,
          {
            ...asking(question()),
            id: "work-3",
            status: "succeeded",
            native: { runId: "work-3", revision: 2 },
          } as WorkItem,
        ],
      ),
    );
    (session.cancelWork as jest.Mock).mockRejectedValueOnce(
      new Error("work_busy"),
    );
    const root = await renderChat(session, "conv-1");
    await act(async () =>
      button(byTestId(root, "work-work-1"), "Zrušit").props.onClick(),
    );
    await settle();
    expect(text(byTestId(root, "work-work-1"))).toContain("Ještě to běží");
    for (const id of ["work-work-2", "work-work-3"]) {
      const card = allByTestId(root, id)[0];
      if (card) expect(() => button(card, "Zrušit")).toThrow();
    }
  });
});
