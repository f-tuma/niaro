/**
 * The quiet line under an answer and the model preset picker on the web
 * chat (NIAR-296), in a browser-like DOM with the page's real components.
 * Roles, names and expanded states come from Testing Library's queries, as
 * the accessibility tree computes them; no screen reader is needed.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { webcrypto } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, getRoles, within } from "@testing-library/dom";
import type {
  ClientSession,
  SessionState,
} from "../packages/client-core/session";
import type { Store } from "../packages/client-core/store";
import type { Conversation, ConversationSummary } from "../packages/protocol";
import type { AnswerReceiptPage } from "../packages/protocol/answer-receipts";
import { ChatNextConversation } from "../apps/server-admin/web/app/chat-next/chat-next-page";
import { clearDrafts } from "../apps/server-admin/web/app/chat-store";
import { SidebarProvider } from "@admin/components/ui/sidebar";
import { ToastProvider } from "@admin/components/ui/toast";
import { TooltipProvider } from "@admin/components/ui/tooltip";

if (!globalThis.crypto?.randomUUID)
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, {
  ResizeObserver: Observer,
  IntersectionObserver: Observer,
});
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  onchange: null,
  dispatchEvent: () => false,
})) as typeof window.matchMedia;
Element.prototype.scrollTo ??= function () {};
Element.prototype.scrollIntoView ??= function () {};

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
    useRouterState: (options?: { select?: (state: unknown) => unknown }) =>
      options?.select
        ? options.select({ location: { pathname: "/", searchStr: "" } })
        : "/",
  };
});
jest.mock("../apps/server-admin/web/app/pet-memory", () => ({
  ...jest.requireActual("../apps/server-admin/web/app/pet-memory"),
  usePetProfile: () => ({ data: undefined }),
  usePetMemory: () => ({ page: { items: [] }, read: async () => {} }),
}));
jest.mock("../apps/server-admin/web/app/generative-ui/charts", () => ({}));
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({ language: "en" }),
  useAppSession: () => {
    throw new Error("Pass the session directly");
  },
}));

const scope = {
  connectionId: "connection-1",
  serverId: "server-1",
  userId: "user-1",
  workspaceId: "workspace-1",
};
const summary = (id: string): ConversationSummary => ({
  id,
  revision: 2,
  title: "Acme offer",
  createdAt: "2026-11-05T08:00:00.000Z",
  updatedAt: "2026-11-05T09:00:00.000Z",
  messageCount: 2,
  readOnly: false,
});
const conversation: Conversation = {
  id: "conv-1",
  revision: 2,
  messages: [
    { id: "m-1", role: "user", text: "Who is Jan at Acme?" },
    {
      id: "m-2",
      role: "assistant",
      text: "Jan Novák is the buyer at Acme.",
      replyToCommandId: "command-1",
    },
  ],
};
const receipts: AnswerReceiptPage = {
  profile: "agent-answer-receipts/1",
  conversationId: "conv-1",
  receipts: [
    {
      commandId: "command-1",
      read: [
        {
          kind: "service",
          id: "find",
          title: "find_contacts",
          detail: "Acme CRM",
        },
      ],
      changed: [],
      memories: [{ kind: "memory", id: "mem-1", title: "Prefers mornings" }],
      skills: [],
      meetings: [],
      files: [],
      sources: [],
      model: { name: "Thorough model", reason: "fallback" },
      preset: { id: "thorough", name: "Thorough" },
    },
  ],
};
function store(): Store {
  return {
    connectionKey: "https://aa.example/v1/a",
    scope,
    cursor: 1,
    conversations: { "conv-1": conversation },
    workItems: {},
    inputRequests: {},
    actionProposals: {},
    operations: {},
    seen: [],
    stale: false,
    needsSnapshot: false,
  };
}
function fakeSession(
  options: {
    presets?: { id: string; name: string }[];
    receipts?: AnswerReceiptPage | null;
  } = {},
) {
  const state: SessionState = {
    store: store(),
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
  const session = {
    identityKey: "identity-receipts",
    subscribe: () => () => {},
    getSnapshot: () => state,
    start: jest.fn(async () => {}),
    refresh: jest.fn(async () => {}),
    selectConversation: jest.fn(),
    retry: jest.fn(async () => {}),
    interruptPending: jest.fn(async () => true),
    canRetryNativeWork: () => false,
    getRetrySource: () => undefined,
    discardProcessAnswerAttempt: jest.fn(async () => true),
    readMentions: jest.fn(async () => ({
      profile: "niaro-mentions/1",
      items: [],
    })),
    readChatSetup: jest.fn(async () => null),
    readChatPresets: jest.fn(async () => options.presets ?? []),
    readAnswerReceipts: jest.fn(async () =>
      options.receipts === undefined ? receipts : options.receipts,
    ),
    readConversations: jest.fn(async () => ({
      conversations: [],
      nextAfter: null,
    })),
    readConversation: jest.fn(async (id: string) => ({
      profile: "agent-conversations/1",
      scope,
      conversation: summary(id),
      messages: conversation.messages,
      nextAfter: null,
    })),
    send: jest.fn(async () => {}),
  };
  return session as unknown as ClientSession & {
    readAnswerReceipts: jest.Mock;
  };
}

let root: Root | undefined;
let container: HTMLElement;
async function renderChat(session: ClientSession) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ToastProvider labels={{ copied: "Copied", undo: "Undo" }}>
            <SidebarProvider>
              <ChatNextConversation
                session={session}
                routeId="conv-1"
                onSaved={() => {}}
              />
            </SidebarProvider>
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  return within(container);
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  clearDrafts();
  try {
    localStorage.clear();
  } catch {
    // Nothing remembered.
  }
});

test("an answer shows one quiet, named line that opens to what it used and which model wrote it", async () => {
  const session = fakeSession();
  const page = await renderChat(session);
  expect(session.readAnswerReceipts).toHaveBeenCalledWith(
    "conv-1",
    expect.anything(),
  );
  const line = page.getByRole("button", { name: /What this answer used/ });
  expect(line.textContent).toContain(
    "Read 1 · Memories 1 · Answered by Thorough · Thorough model, fallback model",
  );
  // Collapsed until asked; the details are named and tied to the line.
  expect(line.getAttribute("aria-expanded")).toBe("false");
  expect(page.queryByText("Find contacts (Acme CRM)")).toBeNull();
  await act(async () => line.click());
  expect(line.getAttribute("aria-expanded")).toBe("true");
  const details = page.getByTestId("answer-receipt-details");
  expect(line.getAttribute("aria-controls")).toBe(details.closest("[id]")!.id);
  expect(details.getAttribute("aria-label")).toBe("What this answer used");
  expect(within(details).getByText("Find contacts (Acme CRM)")).toBeTruthy();
  expect(within(details).getByText("Prefers mornings")).toBeTruthy();
  // It never speaks of delivery: no "sent", "confirmed" or "failed".
  expect(line.textContent).not.toMatch(/sent|confirm|fail|deliver/i);
  // Every control still has a name.
  const roles = getRoles(container);
  expect(page.queryAllByRole("button", { name: /\S/ }).length).toBe(
    roles.button?.length ?? 0,
  );
});

test("knowledge sources open under the answer with the passage it was given", async () => {
  const page = await renderChat(
    fakeSession({
      receipts: {
        ...receipts,
        receipts: [
          {
            commandId: "command-1",
            read: [],
            changed: [],
            memories: [],
            skills: [],
            meetings: [],
            files: [],
            sources: [
              {
                kind: "file",
                id: "a".repeat(32),
                title: "price-list.pdf",
                passage: "Installation costs 12,000 CZK.",
              },
              {
                kind: "service",
                id: "b".repeat(32),
                title: "Wiki · Procedures",
                passage: "Petra handles complaints.",
              },
            ],
          },
        ],
      },
    }),
  );
  const line = page.getByRole("button", { name: /What this answer used/ });
  expect(line.textContent).toContain("Sources 2");
  await act(async () => line.click());
  const details = page.getByTestId("answer-receipt-details");
  expect(within(details).getByText("Sources")).toBeTruthy();
  expect(within(details).getByText("price-list.pdf")).toBeTruthy();
  expect(within(details).getByText("Wiki · Procedures")).toBeTruthy();
  expect(
    within(details)
      .getAllByTestId("answer-receipt-passage")
      .map((node) => node.textContent),
  ).toEqual(["Installation costs 12,000 CZK.", "Petra handles complaints."]);
});

test("without a receipt, or with an empty one, the answer has no line", async () => {
  await renderChat(fakeSession({ receipts: null }));
  expect(
    within(container).queryByRole("button", { name: /What this answer used/ }),
  ).toBeNull();
  await act(async () => root?.unmount());
  container.remove();
  await renderChat(
    fakeSession({
      receipts: {
        ...receipts,
        receipts: [
          {
            commandId: "command-1",
            read: [],
            changed: [],
            memories: [],
            skills: [],
            meetings: [],
            files: [],
            sources: [],
          },
        ],
      },
    }),
  );
  expect(within(container).queryByTestId("answer-receipt")).toBeNull();
});

test("the preset picker is a named select with Default and the offered presets, only when offered", async () => {
  const none = await renderChat(fakeSession());
  expect(none.queryByRole("combobox", { name: "Model preset" })).toBeNull();
  await act(async () => root?.unmount());
  container.remove();
  const page = await renderChat(
    fakeSession({
      presets: [
        { id: "fast", name: "Fast" },
        { id: "thorough", name: "Thorough" },
      ],
    }),
  );
  const picker = page.getByRole("combobox", {
    name: "Model preset",
  }) as HTMLSelectElement;
  expect(
    within(picker)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["Default", "Fast", "Thorough"]);
  expect(picker.value).toBe("");
  await act(async () => {
    fireEvent.change(picker, { target: { value: "thorough" } });
  });
  expect(picker.value).toBe("thorough");
});
