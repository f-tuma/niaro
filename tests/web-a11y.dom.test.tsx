/**
 * Accessibility of the web chat, checked in a browser-like DOM (jsdom) with
 * the page's real components (NIAR-278). Roles and accessible names come
 * from Testing Library's queries, which compute them as the accessibility
 * tree does. This stands in for a manual screen-reader pass of wave 1; what
 * only a real screen reader can tell (speech order, verbosity, focus
 * announcements, browser differences) is not covered here.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { webcrypto } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getRoles, within } from "@testing-library/dom";
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
import { meetingProposal } from "../packages/test-fixtures";
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
// What jsdom lacks and the page only uses for layout.
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
// The owner's pet profile has its own suite (web-pet-page.test.tsx).
jest.mock("../apps/server-admin/web/app/pet-memory", () => ({
  ...jest.requireActual("../apps/server-admin/web/app/pet-memory"),
  usePetProfile: () => ({ data: undefined }),
}));
// Generated charts draw with recharts, which Jest cannot parse.
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
  revision: 4,
  title: "Acme offer",
  createdAt: "2026-10-16T08:00:00.000Z",
  updatedAt: "2026-10-16T09:00:00.000Z",
  messageCount: 3,
  readOnly: false,
});
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
const proposal = { ...meetingProposal("en"), conversationId: "conv-1" };
const meeting = {
  id: proposal.workItemId,
  conversationId: "conv-1",
  revision: 2,
  title: "Meeting with Peter",
  context: "",
  status: "waiting_approval",
  inputRequestIds: [],
  actionProposalIds: [proposal.id],
  operationIds: [],
} as unknown as WorkItem;
const conversation: Conversation = {
  id: "conv-1",
  revision: 4,
  messages: [
    { id: "m-1", role: "user", text: "Show me the script" },
    {
      id: "m-2",
      role: "assistant",
      text: "Here it is:\n\n```sh\nnpm test\n```",
    },
    { id: "m-3", role: "user", text: "Add Jan to the CRM" },
    {
      id: "m-4",
      role: "assistant",
      text: "Approve the write",
      result: approval,
    },
  ],
};
function storeWith(conversations: Conversation[]): Store {
  return {
    connectionKey: "https://aa.example/v1/a",
    scope,
    cursor: 1,
    conversations: Object.fromEntries(conversations.map((c) => [c.id, c])),
    workItems: { [meeting.id]: meeting },
    inputRequests: {},
    actionProposals: { [proposal.id]: proposal },
    operations: {},
    seen: [],
    stale: false,
    needsSnapshot: false,
  };
}
/** A session double: commands are accepted and recorded, nothing is sent. */
function fakeSession(store: Store) {
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
    readMentions: jest.fn(async () => ({
      profile: "niaro-mentions/1",
      items: [],
    })),
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

let root: Root | undefined;
let container: HTMLElement;
async function renderChat(session: ClientSession) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        {/* As the app and its shell mount it. */}
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
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return within(container);
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  clearDrafts();
});

test("every control on the chat page has an accessible name and form fields are labelled", async () => {
  const { session } = fakeSession(storeWith([conversation]));
  const page = await renderChat(session);
  const roles = getRoles(container);
  const named = (role: string) =>
    page.queryAllByRole(role, { name: /\S/ }).length;
  for (const role of ["button", "link", "textbox", "combobox", "checkbox"])
    expect(`${role}: ${named(role)}`).toBe(
      `${role}: ${roles[role]?.length ?? 0}`,
    );
  expect(roles.button?.length).toBeGreaterThan(5);
  // The chat's name is the page's one heading of the first level.
  expect(
    page.getAllByRole("heading", { level: 1 }).map((h) => h.textContent),
  ).toEqual(["Acme offer"]);
  // Ids that labels and descriptions point at are unique.
  const ids = Array.from(container.querySelectorAll("[id]")).map((e) => e.id);
  expect(ids.length).toBe(new Set(ids).size);
});

test("the chat header's menu, the code copy and the composer are named for a screen reader", async () => {
  const { session } = fakeSession(storeWith([conversation]));
  const page = await renderChat(session);
  const menu = page.getByRole("button", { name: "Chat options" });
  expect(menu.getAttribute("aria-haspopup")).toBe("menu");
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(page.getByRole("button", { name: "Copy code" })).toBeTruthy();
  expect(
    page.getByRole("textbox", { name: "Message the assistant" }),
  ).toBeTruthy();
  expect(page.getByRole("button", { name: "Send" })).toBeTruthy();
  // Decorative icons are hidden from the accessibility tree.
  for (const icon of Array.from(container.querySelectorAll("svg")))
    expect(
      icon.getAttribute("aria-hidden") === "true" ||
        !!icon.getAttribute("aria-label") ||
        !!icon.closest("[aria-hidden='true']"),
    ).toBe(true);
});

test("approval and meeting decisions read Decline then Approve, by name", async () => {
  const { session, sent } = fakeSession(storeWith([conversation]));
  const page = await renderChat(session);
  const service = within(page.getByTestId("service-action-decisions"));
  expect(service.getAllByRole("button").map((b) => b.textContent)).toEqual([
    "Decline",
    "Approve",
  ]);
  const meetingFooter = within(page.getByTestId("meeting-decisions"));
  expect(
    meetingFooter.getAllByRole("button").map((b) => b.textContent),
  ).toEqual(["Decline", "Approve"]);
  await act(async () =>
    meetingFooter.getByRole("button", { name: "Decline" }).click(),
  );
  expect(sent.at(-1)).toMatchObject({
    type: "proposal.decide",
    decision: "reject",
  });
});

test("a new answer is announced in the one polite status region", async () => {
  const { session, publish } = fakeSession(storeWith([conversation]));
  const page = await renderChat(session);
  const regions = page
    .getAllByRole("status")
    .filter((region) => region.dataset.testid === "answer-announcement");
  expect(regions).toHaveLength(1);
  const region = regions[0]!;
  expect(region.getAttribute("aria-live")).toBe("polite");
  expect(region.getAttribute("aria-atomic")).toBe("true");
  expect(region.textContent).toBe("");
  await act(async () =>
    publish({
      store: storeWith([
        {
          ...conversation,
          revision: 5,
          messages: [
            ...conversation.messages,
            { id: "m-5", role: "user", text: "How many orders?" },
            {
              id: "m-6",
              role: "assistant",
              text: "## October\n\n**120** orders in October.",
            },
          ],
        },
      ]),
    }),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
  expect(region.textContent).toBe("Answer ready. 120 orders in October.");
});
