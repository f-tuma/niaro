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
import type { ProcessOfferResult } from "../packages/protocol/process-offer";
import { ChatConversation } from "../apps/server-admin/web/app/chat-page";
import { takeProcessOffer } from "../apps/server-admin/web/app/offer-handoff";
import { groupChatsByDay } from "../apps/server-admin/web/app/chat-history";
import { translate } from "../packages/i18n";

if (!globalThis.crypto?.randomUUID)
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });

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
        <ChatConversation
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
const offer: ProcessOfferResult = {
  type: "process.offer",
  version: 1,
  processId: "process-1",
  processVersion: 2,
  artifactDigest: "a".repeat(64),
  name: "Onboarding klienta",
  description: "",
  kind: "workflow",
  reason: "Na tohle máš uložený postup.",
  input: { name: "Jan Novák" },
};
const user = (id: string, text: string): Message => ({
  id,
  role: "user",
  text,
});

beforeEach(() => {
  mockNavigate.mockReset();
});

test("a new chat is created on the server before its first message, then gets its address", async () => {
  const { session, sent } = fakeSession(storeWith([]));
  const onSaved = jest.fn();
  const root = (await render(session, undefined, onSaved)).root;
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
  // The chat's own key makes a retried creation the same command.
  expect(create.commandId).toBe(create.conversationId.slice("chat-".length));
  expect(create.idempotencyKey).toBe(create.commandId);
  expect(message).toMatchObject({
    conversationId: create.conversationId,
    text: "Ahoj, najdi Jana",
    language: "cs",
  });
  expect(message.session).toBeUndefined();
  expect(onSaved).toHaveBeenCalledWith(create.conversationId);
  // An accepted message clears the composer.
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
  // While the assistant works, the text is in the chat, not in the composer.
  expect(root.findByType("textarea").props.value).toBe("");
  await act(async () => {
    publish({ commandStates: { chat: "rejected" } });
    finish();
  });
  expect(root.findByType("textarea").props.value).toBe("Najdi Jana");
});

test("Shift+Enter keeps writing and an empty draft sends nothing", async () => {
  const { session, sent } = fakeSession(storeWith([]));
  const root = (await render(session)).root;
  await act(async () =>
    root.findByType("textarea").props.onChange({ target: { value: "  " } }),
  );
  await act(async () =>
    root.findByType("textarea").props.onKeyDown({
      key: "Enter",
      shiftKey: true,
      nativeEvent: { isComposing: false },
      preventDefault: () => {},
    }),
  );
  await act(async () =>
    root.findByType("textarea").props.onKeyDown({
      key: "Enter",
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => {},
    }),
  );
  expect(sent).toEqual([]);
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
  expect(sent[0]!.commandId).toBe(sent[0]!.idempotencyKey);
});

test("a finished action shows only the answer's words, no receipt card", async () => {
  const conversation: Conversation = {
    id: "conv-1",
    revision: 4,
    messages: [
      user("m-1", "Jak jsou na tom weby?"),
      {
        id: "m-2",
        role: "assistant",
        text: "Návštěvnost za týden vzrostla o 12 %.",
        result: {
          ...approval,
          title: "Get Session Breakdown",
          status: "succeeded",
          effect: "read",
          fields: [],
          inputJson: "",
        },
      },
      {
        id: "m-3",
        role: "assistant",
        text: "",
        result: { ...approval, operationId: "op-2", status: "failed" },
      },
    ],
  };
  const { session } = fakeSession(storeWith([conversation]), {
    "conv-1": { conversation: summary("conv-1") },
  });
  const root = (await render(session, "conv-1")).root;
  expect(text(root)).toContain("Návštěvnost za týden vzrostla o 12 %.");
  for (const id of ["service-action-op-1", "service-action-op-2"])
    expect(
      root.findAll((node) => node.props["data-testid"] === id),
    ).toHaveLength(0);
  expect(text(root)).not.toContain("Get Session Breakdown");
});

test("a task's native approval carries the work item and the revision it was shown at", async () => {
  const conversation: Conversation = {
    id: "conv-1",
    revision: 4,
    messages: [user("m-1", "Pošli e-mail Janovi")],
  };
  const work = {
    id: "work-1",
    conversationId: "conv-1",
    revision: 7,
    title: "E-mail Janovi",
    context: "",
    status: "waiting_approval",
    inputRequestIds: [],
    actionProposalIds: [],
    operationIds: [],
    native: {
      revision: 3,
      action: { ...approval, operationId: "op-native", title: "Send email" },
    },
  } as unknown as WorkItem;
  const { session, sent } = fakeSession(storeWith([conversation], [work]), {
    "conv-1": { conversation: summary("conv-1") },
  });
  const root = (await render(session, "conv-1")).root;
  const card = byTestId(root, "work-work-1");
  await act(async () => button(card, tr("serviceReject")).props.onClick());
  expect(sent[0]).toMatchObject({
    type: "service.resolve",
    conversationId: "conv-1",
    operationId: "op-native",
    workItemId: "work-1",
    expectedWorkRevision: 7,
    approved: false,
  });
});

test("an archived chat is read only: no composer, no live cards, a way to a new chat", async () => {
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
  // History text only: an archived approval can never be decided here.
  expect(
    root.findAll((node) => node.props["data-testid"] === "service-action-op-1"),
  ).toHaveLength(0);
  expect(text(root)).toContain("Hotovo?");
  expect(sent).toEqual([]);
  expect(session.refresh).not.toHaveBeenCalled();
});

test("an archived chat opened by its address can be restored and then continues", async () => {
  const conversation: Conversation = {
    id: "chat-old",
    revision: 4,
    messages: [user("m-1", "Založ Jana")],
  };
  const { session } = fakeSession(storeWith([conversation]), {
    "chat-old": { conversation: summary("chat-old", { readOnly: true }) },
  });
  const root = (await render(session, "chat-old")).root;
  const bar = byTestId(root, "read-only-composer");
  expect(text(bar)).toContain("Nový chat");
  expect(root.findAllByType("textarea")).toHaveLength(0);
  await act(async () => button(root, "Obnovit").props.onClick());
  await act(async () => {});
  expect(session.restoreConversation).toHaveBeenCalledWith(
    "chat-old",
    expect.any(String),
  );
  expect(session.refresh).toHaveBeenCalled();
  expect(
    root.findAll((node) => node.props["data-testid"] === "read-only-composer"),
  ).toHaveLength(0);
  expect(root.findAllByType("textarea")).toHaveLength(1);
  expect(text(root)).toContain("Založ Jana");
});

test("an answer's generated part follows its text and fills the composer, never sends", async () => {
  const program = [
    "root = Stack([t, b])",
    't = Text("Mám dva termíny.")',
    'b = Buttons([Button("Úterý", @ToAssistant("Potvrzuji úterý"), "primary")])',
  ].join("\n");
  const conversation: Conversation = {
    id: "conv-1",
    revision: 4,
    messages: [
      user("m-1", "Kdy se sejdeme?"),
      {
        id: "m-2",
        role: "assistant",
        text: "Termíny:",
        ui: {
          type: "openui.program",
          version: 1,
          library: "niaro-ui@1",
          program,
        },
      },
    ],
  };
  const { session, sent } = fakeSession(storeWith([conversation]), {
    "conv-1": { conversation: summary("conv-1") },
  });
  const root = (await render(session, "conv-1")).root;
  const answer = root.find(
    (node) => node.type === "article" && text(node).includes("Termíny:"),
  );
  // Depth-first order: the text, then the generated part.
  const parts = answer.findAll(
    (node) =>
      typeof node.type === "string" &&
      (node.props["data-host"] === "Markdown" ||
        node.props["data-testid"] === "generated-ui"),
  );
  expect(
    parts.map((part) => part.props["data-host"] ?? part.props["data-testid"]),
  ).toEqual(["Markdown", "generated-ui"]);
  expect(text(parts[1]!)).toContain("Mám dva termíny.");
  await act(async () => button(answer, "Úterý").props.onClick());
  expect(root.findByType("textarea").props.value).toBe("Potvrzuji úterý");
  expect(sent).toEqual([]);
});

test("a generated answer in an archived chat is shown but does nothing", async () => {
  const conversation: Conversation = {
    id: "archived-1",
    revision: 4,
    messages: [
      {
        id: "m-1",
        role: "assistant",
        text: "Hotovo.",
        ui: {
          type: "openui.program",
          version: 1,
          library: "niaro-ui@1",
          program: 'root = Stack([Button("Další krok")])',
        },
      },
    ],
  };
  const { session, sent } = fakeSession(storeWith([conversation]), {
    "archived-1": { conversation: summary("archived-1", { readOnly: true }) },
  });
  const root = (await render(session, "archived-1")).root;
  const next = button(root, "Další krok");
  expect(next.props.disabled).toBe(true);
  await act(async () => next.props.onClick());
  expect(root.findAllByType("textarea")).toHaveLength(0);
  expect(sent).toEqual([]);
});

test("a card composed by an earlier model reads as its text, with nothing to answer", async () => {
  const conversation: Conversation = {
    id: "conv-1",
    revision: 4,
    messages: [
      {
        id: "m-1",
        role: "assistant",
        text: "Termíny:",
        result: {
          type: "card.document",
          version: 1,
          document: {
            id: "pick",
            revision: 2,
            title: "Vyber termín",
            nodes: [
              {
                id: "when",
                type: "field",
                label: "Úterý",
                value: "10:00",
              },
              { id: "go", type: "button", actionId: "confirm" },
            ],
            root: ["when", "go"],
            actions: [
              {
                id: "confirm",
                label: "Potvrdit termín",
                kind: "reply",
                variant: "primary",
              },
            ],
          },
        },
      },
    ],
  };
  const { session, sent } = fakeSession(storeWith([conversation]), {
    "conv-1": { conversation: summary("conv-1") },
  });
  const root = (await render(session, "conv-1")).root;
  expect(text(root)).toContain("Termíny:");
  expect(text(root)).toContain("Vyber termín\nÚterý: 10:00");
  expect(() => button(root, "Potvrdit termín")).toThrow();
  expect(
    root.findAll((node) => node.props["data-testid"] === "card-pick"),
  ).toHaveLength(0);
  expect(sent).toEqual([]);
});

test("a process offer opens the process or resends the request without one", async () => {
  const conversation: Conversation = {
    id: "conv-1",
    revision: 4,
    messages: [
      user("m-1", "Založ klienta Jana Nováka"),
      { id: "m-2", role: "assistant", text: "Mám proces.", result: offer },
    ],
  };
  const { session, sent } = fakeSession(storeWith([conversation]), {
    "conv-1": { conversation: summary("conv-1") },
  });
  const root = (await render(session, "conv-1")).root;
  const card = byTestId(root, "process-offer");
  await act(async () => button(card, "Otevřít proces").props.onClick());
  expect(takeProcessOffer()).toEqual(offer);
  expect(mockNavigate).toHaveBeenCalledWith({ to: "/processes" });
  expect(sent).toEqual([]);

  await act(async () => button(card, "Bez procesu").props.onClick());
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "message.send",
    conversationId: "conv-1",
    text: "Založ klienta Jana Nováka",
    withoutProcess: true,
  });
});

test("an offer from an earlier answer can no longer be used", async () => {
  const conversation: Conversation = {
    id: "conv-1",
    revision: 4,
    messages: [
      user("m-1", "Založ klienta"),
      { id: "m-2", role: "assistant", text: "Mám proces.", result: offer },
      user("m-3", "Udělej to sám"),
    ],
  };
  const { session } = fakeSession(storeWith([conversation]), {
    "conv-1": { conversation: summary("conv-1") },
  });
  const root = (await render(session, "conv-1")).root;
  const card = byTestId(root, "process-offer");
  expect(button(card, "Otevřít proces").props.disabled).toBe(true);
  expect(button(card, "Bez procesu").props.disabled).toBe(true);
});

test("while the assistant works, the composer offers stop and progress is shown", async () => {
  const conversation: Conversation = {
    id: "conv-1",
    revision: 4,
    messages: [user("m-1", "Ahoj")],
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
        text: "Najdi Jana",
        language: "cs",
      },
      commandStates: { chat: "sending" },
    }),
  );
  expect(text(byTestId(root, "pending-message"))).toContain("Najdi Jana");
  expect(byTestId(root, "request-progress")).toBeTruthy();
  await act(async () => button(root, "Zastavit").props.onClick());
  expect(session.interruptPending).toHaveBeenCalled();
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
  const pending = {
    type: "message.send" as const,
    commandId: "c-2",
    idempotencyKey: "c-2",
    conversationId: "conv-1",
    text: "Kolik máme objednávek?",
    language: "cs" as const,
  };
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
      pending,
      commandStates: { chat: "sending" },
      activity: {
        ...running,
        // The opening fence is still being typed.
        draft: "Za září **340** objednávek.\n``",
      },
    }),
  );
  const draft = byTestId(root, "answer-draft");
  expect(text(draft)).toContain("340");
  expect(text(draft)).not.toContain("``");
  expect(
    draft.findAll((node) => node.props["data-testid"] === "generated-ui"),
  ).toHaveLength(0);
  await act(async () =>
    publish({
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
  const ui = byTestId(byTestId(root, "answer-draft"), "generated-ui");
  // Nothing in a draft can be acted on.
  expect(button(ui, "Detail").props.disabled).toBe(true);
  // The stored message replaces the draft; a draft is never part of the chat.
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
    root.findAll((node) => node.props["data-testid"] === "answer-draft"),
  ).toHaveLength(0);
  expect(text(root)).toContain("V září bylo 340 objednávek.");
  expect(text(root)).not.toContain("Za září");
});

test("a finished turn stays in an opened chat while its history is read again", async () => {
  const conversation: Conversation = {
    id: "conv-1",
    revision: 4,
    messages: [user("m-1", "Ahoj")],
  };
  const { session, publish } = fakeSession(storeWith([conversation]), {
    "conv-1": { conversation: summary("conv-1", { revision: 4 }) },
  });
  const root = (await render(session, "conv-1")).root;
  // The next history read is still on its way.
  (session.readConversation as jest.Mock).mockImplementation(
    () => new Promise(() => {}),
  );
  await act(async () =>
    publish({
      pending: null,
      activity: null,
      store: storeWith([
        {
          ...conversation,
          revision: 6,
          messages: [
            ...conversation.messages,
            user("m-2", "Kolik máme objednávek?"),
            {
              id: "m-3",
              role: "assistant",
              text: "V září bylo 340 objednávek.",
              replyToCommandId: "c-2",
            },
          ],
        },
      ]),
    }),
  );
  expect(session.readConversation).toHaveBeenCalledTimes(2);
  const shown = text(root);
  expect(shown).toContain("Ahoj");
  expect(shown).toContain("Kolik máme objednávek?");
  expect(shown).toContain("V září bylo 340 objednávek.");
  expect(shown.indexOf("Ahoj")).toBeLessThan(
    shown.indexOf("Kolik máme objednávek?"),
  );
});

test("chats group by day like the app menu", () => {
  const now = new Date("2026-10-16T12:00:00");
  const labels = { today: "Dnes", yesterday: "Včera", lastWeek: "Týden" };
  const groups = groupChatsByDay(
    [
      summary("a", {
        updatedAt: new Date("2026-10-16T09:00:00").toISOString(),
      }),
      summary("b", {
        updatedAt: new Date("2026-10-15T09:00:00").toISOString(),
      }),
      summary("c", {
        updatedAt: new Date("2026-10-12T09:00:00").toISOString(),
      }),
    ],
    "cs",
    labels,
    now,
  );
  expect(groups.map((group) => group.label)).toEqual([
    "Dnes",
    "Včera",
    "Týden",
  ]);
});
