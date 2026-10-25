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
  WorkItem,
} from "../packages/protocol";
import type { ServiceResult } from "../packages/protocol/service-result";
import { ChatNextConversation } from "../apps/server-admin/web/app/chat-next/chat-next-page";
import {
  chatNextEnabled,
  setChatNext,
} from "../apps/server-admin/web/app/chat-next/switch";
import {
  MENTIONS_PROFILE,
  type MentionDirectory,
} from "../packages/protocol/mentions";
import { translate } from "../packages/i18n";

if (!globalThis.crypto?.randomUUID)
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
// assistant-ui's thread root listens on the document for Escape and the
// generated UI's renderer adds a style; the test renderer has no DOM, so
// they get a page that hears nothing and keeps nothing.
if (typeof document === "undefined")
  Object.defineProperty(globalThis, "document", {
    value: {
      addEventListener() {},
      removeEventListener() {},
      createElement: () => ({}),
      head: { appendChild() {} },
    },
    configurable: true,
  });

const mockNavigate = jest.fn();
jest.mock("@tanstack/react-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Link: ({
      to,
      params: _params,
      ...props
    }: React.ComponentProps<"a"> & { to: string; params?: unknown }) =>
      React.createElement("a", { ...props, href: to }),
    useNavigate: () => mockNavigate,
    useParams: () => ({}),
    useRouterState: () => "/",
  };
});
// Generated charts draw with recharts, which Jest cannot parse.
jest.mock("../apps/server-admin/web/app/generative-ui/charts", () => ({}));
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({ language: "cs" }),
  useAppSession: () => {
    throw new Error("Pass the session directly");
  },
}));
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
  "@admin/components/ui/card",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/input",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/label",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/switch",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/progress",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/separator",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/radio-group",
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
  "@admin/components/console/status",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/console/disclosure",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/tooltip",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
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
  "@admin/components/ui/kbd",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/checkbox",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule(),
  { virtual: true },
);
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
jest.mock(
  "@admin/components/console/entity-icon",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule({
        initials: (name: string) => name.slice(0, 2),
      }),
  { virtual: true },
);
jest.mock(
  "@admin/components/console/time",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule({ formatRelative: () => "" }),
  { virtual: true },
);

const tr = translate("cs");
const scope = {
  connectionId: "connection-1",
  serverId: "server-1",
  userId: "user-1",
  workspaceId: "workspace-1",
};
function summary(
  id: string,
  extra: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    revision: 4,
    title: "Klient",
    createdAt: "2026-10-16T08:00:00.000Z",
    updatedAt: "2026-10-16T09:00:00.000Z",
    messageCount: 2,
    readOnly: false,
    ...extra,
  };
}
type Message = Conversation["messages"][number];
function storeWith(
  conversations: Conversation[],
  workItems: WorkItem[] = [],
): Store {
  return {
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
  };
}
const directory: MentionDirectory = {
  profile: MENTIONS_PROFILE,
  items: [
    { kind: "service", id: "svc-crm", name: "CRM", description: "Twenty" },
    { kind: "process", id: "proc-onboard", name: "Onboarding klienta" },
  ],
};
/** A session double: commands are accepted and recorded, nothing is sent. */
function fakeSession(
  store: Store,
  history: Record<string, { conversation: ConversationSummary }> = {},
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
    readConversations: jest.fn(async () => ({
      conversations: [],
      nextAfter: null,
    })),
    readMentions: jest.fn(async () => directory),
    restoreConversation: jest.fn(async (id: string) => {
      const archived = history[id];
      if (archived)
        archived.conversation = { ...archived.conversation, readOnly: false };
    }),
    readConversation: jest.fn(async (id: string) => ({
      profile: "agent-conversations/1",
      scope,
      conversation:
        history[id]?.conversation ??
        summary(id, { revision: 1, title: "", messageCount: 0 }),
      // History pages carry text only; cards come from the live projection.
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

async function render(
  session: ClientSession,
  routeId?: string,
  onSaved = jest.fn(),
) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={new QueryClient()}>
        <ChatNextConversation
          session={session}
          routeId={routeId}
          onSaved={onSaved}
        />
      </QueryClientProvider>,
    );
  });
  await act(async () => {});
  return renderer;
}
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
function button(root: ReactTestInstance, label: string) {
  const found = root.findAll(
    (node) =>
      node.type === "button" &&
      (text(node).includes(label) || node.props["aria-label"] === label),
  );
  if (!found.length) throw new Error(`No button "${label}"`);
  return found[0]!;
}
const byTestId = (root: ReactTestInstance, id: string) =>
  root.find((node) => node.props["data-testid"] === id);
async function type(root: ReactTestInstance, value: string) {
  const input = root.findByType("textarea");
  await act(async () => input.props.onChange({ target: { value } }));
  await act(async () =>
    root.findByType("textarea").props.onKeyDown({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => {},
    }),
  );
  await act(async () => {});
}

const approval: ServiceResult = {
  type: "service.action",
  version: 1,
  operationId: "op-1",
  title: "Create person",
  service: "Twenty CRM",
  status: "awaiting_approval",
  effect: "write",
  fields: [{ label: "name", value: "Jan Novák" }],
  inputJson: '{"name":"Jan Novák"}',
  reviewTruncated: false,
  summary: "",
};
const user = (id: string, text: string): Message => ({
  id,
  role: "user",
  text,
});

beforeEach(() => {
  mockNavigate.mockReset();
});

/**
 * The next chat (assistant-ui) next to the classic one: the same commands,
 * the same cards, the thread's own parts. Every test here is a classic chat
 * test the next chat must pass the same way.
 */

test("the next chat is off until chosen, by the menu or the address", () => {
  expect(chatNextEnabled()).toBe(false);
  setChatNext(true);
  expect(chatNextEnabled()).toBe(true);
  setChatNext(false);
  expect(chatNextEnabled()).toBe(false);
});

test("a new chat is created on the server before its first message, then gets its address", async () => {
  const { session, sent } = fakeSession(storeWith([]));
  const onSaved = jest.fn();
  const root = (await render(session, undefined, onSaved)).root;
  expect(byTestId(root, "chat-next")).toBeTruthy();
  expect(text(root)).toContain("S čím ti můžu pomoct?");
  await type(root, "Ahoj, najdi Jana");
  expect(sent.map((command) => command.type)).toEqual([
    "conversation.create",
    "message.send",
  ]);
  const [create, message] = sent as [
    Extract<SessionCommand, { type: "conversation.create" }>,
    Extract<SessionCommand, { type: "message.send" }>,
  ];
  expect(create.conversationId).toMatch(/^chat-[0-9a-f-]{36}$/);
  expect(create.commandId).toBe(create.conversationId.slice("chat-".length));
  expect(message).toMatchObject({
    conversationId: create.conversationId,
    text: "Ahoj, najdi Jana",
    language: "cs",
  });
  expect(onSaved).toHaveBeenCalledWith(create.conversationId);
  expect(root.findByType("textarea").props.value).toBe("");
});

test("a sent message leaves the composer at once and returns if it isn't accepted", async () => {
  const conversation: Conversation = {
    id: "conv-1",
    revision: 1,
    messages: [],
  };
  const { session, publish } = fakeSession(storeWith([conversation]), {
    "conv-1": { conversation: summary("conv-1") },
  });
  let finish!: () => void;
  (session.send as jest.Mock).mockImplementationOnce(
    () => new Promise<void>((resolve) => (finish = resolve)),
  );
  const root = (await render(session, "conv-1")).root;
  await type(root, "Najdi Jana");
  expect(root.findByType("textarea").props.value).toBe("");
  await act(async () => {
    publish({ commandStates: { chat: "rejected" } });
    finish();
  });
  expect(root.findByType("textarea").props.value).toBe("Najdi Jana");
});

test("stored messages read as the person's bubble and the answer's Markdown, with a day divider", async () => {
  const conversation: Conversation = {
    id: "conv-1",
    revision: 4,
    messages: [
      {
        ...user("m-1", "Kolik máme objednávek?"),
        createdAt: "2026-10-16T08:00:00.000Z",
      },
      {
        id: "m-2",
        role: "assistant",
        text: "V září bylo **340** objednávek.",
        createdAt: "2026-10-16T08:00:05.000Z",
      },
    ],
  };
  const { session } = fakeSession(storeWith([conversation]), {
    "conv-1": { conversation: summary("conv-1") },
  });
  const root = (await render(session, "conv-1")).root;
  const log = root.find((node) => node.props.role === "log");
  expect(text(log)).toContain("Kolik máme objednávek?");
  expect(
    root.find((node) => node.props["data-host"] === "Markdown").props.children,
  ).toBe("V září bylo **340** objednávek.");
  expect(root.findAll((node) => node.props.role === "separator")).toHaveLength(
    1,
  );
  // Each message keeps its address for search links.
  expect(
    root.findAll(
      (node) => node.type === "div" && node.props["data-message-id"] === "m-2",
    ),
  ).toHaveLength(1);
});

test("approving a prepared write resolves exactly that operation in its chat", async () => {
  const conversation: Conversation = {
    id: "conv-1",
    revision: 4,
    messages: [
      user("m-1", "Založ Jana Nováka"),
      {
        id: "m-2",
        role: "assistant",
        text: "Připravil jsem zápis.",
        result: approval,
      },
    ],
  };
  const { session, sent } = fakeSession(storeWith([conversation]), {
    "conv-1": { conversation: summary("conv-1") },
  });
  const root = (await render(session, "conv-1")).root;
  const card = byTestId(root, "service-action-op-1");
  expect(text(card)).toContain("Jan Novák");
  await act(async () => button(card, tr("serviceApprove")).props.onClick());
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "service.resolve",
    conversationId: "conv-1",
    operationId: "op-1",
    approved: true,
    language: "cs",
  });
});

test("while the assistant works, the chat thinks until the first word, offers stop and a retry", async () => {
  const conversation: Conversation = {
    id: "conv-1",
    revision: 4,
    messages: [user("m-1", "Ahoj")],
  };
  const { session, publish } = fakeSession(storeWith([conversation]), {
    "conv-1": { conversation: summary("conv-1") },
  });
  const root = (await render(session, "conv-1")).root;
  const pending = {
    type: "message.send" as const,
    commandId: "c-2",
    idempotencyKey: "c-2",
    conversationId: "conv-1",
    text: "Najdi Jana",
    language: "cs" as const,
  };
  await act(async () =>
    publish({ pending, commandStates: { chat: "sending" } }),
  );
  expect(text(byTestId(root, "pending-message"))).toContain("Najdi Jana");
  expect(text(byTestId(root, "request-progress"))).toContain(
    tr("progressThinking"),
  );
  await act(async () => button(root, "Zastavit").props.onClick());
  expect(session.interruptPending).toHaveBeenCalled();
  // The first word replaces "Thinking".
  await act(async () =>
    publish({
      activity: {
        commandId: "c-2",
        conversationId: "conv-1",
        status: "running",
        steps: [
          { id: "understanding", status: "running" },
          { id: "preparing", status: "pending" },
        ],
        draft: "Jan Novák je",
      },
    }),
  );
  expect(
    root.findAll((node) => node.props["data-testid"] === "request-progress"),
  ).toHaveLength(0);
  expect(text(root)).toContain("Jan Novák je");
  // An uncertain delivery is resent as the same command.
  await act(async () =>
    publish({
      commandStates: { chat: "network_error" },
      error: "network_error",
    }),
  );
  await act(async () =>
    button(byTestId(root, "request-progress"), "Zkusit znovu").props.onClick(),
  );
  expect(session.retry).toHaveBeenCalled();
});

test("the streamed steps say which service is read and what came back, one line each", async () => {
  const conversation: Conversation = {
    id: "conv-1",
    revision: 4,
    messages: [user("m-1", "Kolik máme zápůjček?")],
  };
  const { session, publish } = fakeSession(storeWith([conversation]), {
    "conv-1": { conversation: summary("conv-1") },
  });
  const root = (await render(session, "conv-1")).root;
  await act(async () =>
    publish({
      pending: {
        type: "message.send",
        commandId: "c-2",
        idempotencyKey: "c-2",
        conversationId: "conv-1",
        text: "Kolik máme zápůjček?",
        language: "cs",
      },
      commandStates: { chat: "sending" },
      activity: {
        commandId: "c-2",
        conversationId: "conv-1",
        status: "running",
        steps: [
          { id: "understanding", status: "running" },
          { id: "preparing", status: "pending" },
        ],
      },
      activityConnection: "live",
      activitySteps: [
        {
          toolCallId: "c1",
          label: "Search loans",
          status: "succeeded",
          input: [{ label: "Service", value: "Twenty CRM" }],
          output: [{ label: "Returned items", value: "71" }],
        },
        {
          toolCallId: "c2",
          label: "Find payouts",
          status: "running",
          input: [],
          output: [],
        },
      ],
    }),
  );
  const steps = root.findAll(
    (node) => node.props["data-testid"] === "live-step",
  );
  expect(steps.map(text)).toEqual([
    "Twenty CRM · Search loans · returned items 71",
    "Find payouts",
  ]);
  expect(steps[1]!.props["data-status"]).toBe("running");
  await act(async () =>
    publish({
      pending: null,
      activity: null,
      activitySteps: null,
      commandStates: { chat: "accepted" },
    }),
  );
  expect(
    root.findAll((node) => node.props["data-testid"] === "live-step"),
  ).toHaveLength(0);
});

test("an answer is shown as it is written, inert, and the stored reply replaces it", async () => {
  const conversation: Conversation = {
    id: "conv-1",
    revision: 4,
    messages: [user("m-1", "Kolik máme objednávek?")],
  };
  const { session, publish } = fakeSession(storeWith([conversation]), {
    "conv-1": { conversation: summary("conv-1") },
  });
  const root = (await render(session, "conv-1")).root;
  const running = {
    commandId: "c-2",
    conversationId: "conv-1",
    status: "running" as const,
    steps: [
      { id: "understanding" as const, status: "running" as const },
      { id: "preparing" as const, status: "pending" as const },
    ],
  };
  await act(async () =>
    publish({
      pending: {
        type: "message.send",
        commandId: "c-2",
        idempotencyKey: "c-2",
        conversationId: "conv-1",
        text: "Kolik máme objednávek?",
        language: "cs",
      },
      commandStates: { chat: "sending" },
      activity: {
        ...running,
        draft: [
          "Za září **340** objednávek.",
          "```openui-lang",
          "root = Stack([b])",
          'b = Buttons([Button("Detail", @ToAssistant("Ukaž detail"), "primary")])',
        ].join("\n"),
      },
    }),
  );
  const ui = byTestId(root, "generated-ui");
  expect(button(ui, "Detail").props.disabled).toBe(true);
  expect(text(root)).toContain("Za září **340** objednávek.");
  await act(async () =>
    publish({
      pending: null,
      activity: null,
      commandStates: { chat: "accepted" },
      store: storeWith([
        {
          ...conversation,
          revision: 5,
          messages: [
            ...conversation.messages,
            {
              id: "m-2",
              role: "assistant",
              text: "V září bylo 340 objednávek.",
              replyToCommandId: "c-2",
            },
          ],
        },
      ]),
    }),
  );
  expect(
    root.findAll((node) => node.props["data-testid"] === "generated-ui"),
  ).toHaveLength(0);
  expect(text(root)).toContain("V září bylo 340 objednávek.");
  expect(text(root)).not.toContain("Za září");
});

test("a write the stream announced is shown to review at once, once, and the stored card takes it over", async () => {
  const conversation: Conversation = {
    id: "conv-1",
    revision: 4,
    messages: [user("m-1", "Vytvoř schůzku s Janou")],
  };
  const { session, sent, publish } = fakeSession(storeWith([conversation]), {
    "conv-1": { conversation: summary("conv-1") },
  });
  const root = (await render(session, "conv-1")).root;
  const cards = () =>
    root.findAll(
      (node) => node.props["data-testid"] === "service-action-op-1",
      { deep: false },
    );
  await act(async () =>
    publish({
      pending: {
        type: "message.send",
        commandId: "c-2",
        idempotencyKey: "c-2",
        conversationId: "conv-1",
        text: "Vytvoř schůzku s Janou",
        language: "cs",
      },
      commandStates: { chat: "sending" },
      activity: {
        commandId: "c-2",
        conversationId: "conv-1",
        status: "running",
        steps: [
          { id: "understanding", status: "running" },
          { id: "preparing", status: "pending" },
        ],
      },
      activityConnection: "live",
      activityApproval: {
        toolCallId: "c1",
        operationId: "op-1",
        toolName: "Create meeting",
        service: "Microsoft 365",
        effect: "write",
        input: { fields: [{ label: "attendee", value: "jana@example.test" }] },
        reviewTruncated: false,
      },
    }),
  );
  expect(cards()).toHaveLength(1);
  expect(text(cards()[0]!)).toContain("jana@example.test");
  expect(button(cards()[0]!, tr("serviceApprove")).props.disabled).toBe(true);
  const stored: Message = {
    id: "m-2",
    role: "assistant",
    text: "Připraveno k potvrzení.",
    replyToCommandId: "c-2",
    result: {
      ...approval,
      title: "Create meeting",
      service: "Microsoft 365",
      fields: [{ label: "attendee", value: "jana@example.test" }],
      inputJson: '{"attendee":"jana@example.test"}',
    },
  };
  await act(async () =>
    publish({
      store: storeWith([
        {
          ...conversation,
          revision: 5,
          messages: [...conversation.messages, stored],
        },
      ]),
    }),
  );
  expect(cards()).toHaveLength(1);
  await act(async () =>
    publish({
      pending: null,
      activity: null,
      activityApproval: null,
      commandStates: { chat: "accepted" },
    }),
  );
  expect(cards()).toHaveLength(1);
  const approve = button(cards()[0]!, tr("serviceApprove"));
  expect(approve.props.disabled).toBe(false);
  await act(async () => approve.props.onClick());
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "service.resolve",
    operationId: "op-1",
  });
});

test("an archived chat is read only, shows its words, and can be restored", async () => {
  const conversation: Conversation = {
    id: "archived-1",
    revision: 4,
    messages: [
      user("m-1", "Založ Jana"),
      { id: "m-2", role: "assistant", text: "Hotovo?", result: approval },
    ],
  };
  const { session, sent } = fakeSession(storeWith([conversation]), {
    "archived-1": { conversation: summary("archived-1", { readOnly: true }) },
  });
  const root = (await render(session, "archived-1")).root;
  expect(root.findAllByType("textarea")).toHaveLength(0);
  const bar = byTestId(root, "read-only-composer");
  expect(text(bar)).toContain("Jen ke čtení");
  expect(bar.findByType("a").props.href).toBe("/chat");
  expect(
    root.findAll((node) => node.props["data-testid"] === "service-action-op-1"),
  ).toHaveLength(0);
  expect(text(root)).toContain("Hotovo?");
  expect(sent).toEqual([]);
  await act(async () => button(root, "Obnovit").props.onClick());
  await act(async () => {});
  expect(session.restoreConversation).toHaveBeenCalledWith(
    "archived-1",
    expect.any(String),
  );
  expect(root.findAllByType("textarea")).toHaveLength(1);
});

test("more than 4,000 characters is counted, named and not sent", async () => {
  const { session, sent } = fakeSession(storeWith([]));
  const root = (await render(session)).root;
  await act(async () =>
    root.findByType("textarea").props.onChange({
      target: { value: "a".repeat(4001) },
    }),
  );
  expect(text(byTestId(root, "composer-count"))).toMatch(/^4\s001 \/ 4\s000$/);
  expect(byTestId(root, "composer-count").props["data-over"]).toBe(true);
  expect(text(root)).toContain("Moc dlouhé");
  await act(async () =>
    root.findByType("textarea").props.onKeyDown({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => {},
    }),
  );
  expect(sent).toEqual([]);
  expect(root.findByType("textarea").props.value).toHaveLength(4001);
});

test("'@' opens the picker; a pick becomes a tag the message carries", async () => {
  const conversation: Conversation = {
    id: "conv-1",
    revision: 1,
    messages: [],
  };
  const { session, sent } = fakeSession(storeWith([conversation]), {
    "conv-1": { conversation: summary("conv-1") },
  });
  const root = (await render(session, "conv-1")).root;
  const input = () => root.findByType("textarea");
  await act(async () =>
    input().props.onChange({
      target: { value: "Najdi v @CR", selectionStart: 11 },
    }),
  );
  const picker = root.find((node) => node.props.role === "listbox");
  expect(text(picker)).toContain("CRM");
  await act(async () =>
    input().props.onKeyDown({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => {},
    }),
  );
  expect(input().props.value).toBe("Najdi v @CRM ");
  await act(async () =>
    input().props.onChange({
      target: { value: "Najdi v @CRM Jana", selectionStart: 17 },
    }),
  );
  await act(async () =>
    input().props.onKeyDown({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => {},
    }),
  );
  await act(async () => {});
  expect(sent[0]).toMatchObject({
    type: "message.send",
    text: "Najdi v @CRM Jana",
    mentions: [{ kind: "service", id: "svc-crm" }],
  });
});
