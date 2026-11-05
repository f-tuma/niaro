import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClientSession } from "../packages/client-core/session";
import { ConversationOpenWorkError } from "../packages/client-core/conversation-directory";
import { ChatHeader } from "../apps/server-admin/web/app/chat-next/chat-header";

const mockNavigate = jest.fn();
const mockPath = { current: "/chat/conv-1" };
jest.mock("@tanstack/react-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Link: ({ to, ...props }: React.ComponentProps<"a"> & { to: string }) =>
      React.createElement("a", { ...props, href: to }),
    useNavigate: () => mockNavigate,
    useRouterState: (options: { select: (state: unknown) => unknown }) =>
      options.select({ location: { pathname: mockPath.current } }),
  };
});
const mockApp = {
  language: "cs",
  session: null as ClientSession | null,
  workspace: undefined as
    | { organizationId: string; workspaceId: string }
    | undefined,
};
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => mockApp,
}));
const mockToast = { copied: jest.fn(), undo: jest.fn() };
jest.mock("@admin/components/ui/toast", () => ({ useToast: () => mockToast }), {
  virtual: true,
});
const hosts = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/button", () => hosts(), { virtual: true });
jest.mock("@admin/components/ui/input", () => hosts(), { virtual: true });
jest.mock("@admin/components/ui/sidebar", () => hosts(), { virtual: true });
jest.mock("@admin/components/ui/spinner", () => hosts(), { virtual: true });
jest.mock("@admin/components/ui/dropdown-menu", () => hosts(), {
  virtual: true,
});
jest.mock("@admin/components/ui/alert-dialog", () => hosts(), {
  virtual: true,
});

const stored = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  },
  configurable: true,
});

function fakeSession() {
  return {
    identityKey: "identity-1",
    renameConversation: jest.fn(async () => {}),
    archiveConversation: jest.fn(async () => {}),
    deleteConversation: jest.fn(async () => {}),
    restoreConversation: jest.fn(async () => {}),
  };
}
type Fake = ReturnType<typeof fakeSession>;

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const host = (root: ReactTestInstance, name: string) =>
  root.findAll((node) => node.props["data-host"] === name);
const item = (root: ReactTestInstance, label: string) => {
  const found = host(root, "DropdownMenuItem").find(
    (node) => text(node) === label,
  );
  if (!found) throw new Error(`No menu item "${label}"`);
  return found;
};

async function render(
  props: Partial<React.ComponentProps<typeof ChatHeader>> = {},
) {
  const fake = fakeSession();
  mockApp.session = fake as unknown as ClientSession;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={new QueryClient()}>
        <ChatHeader
          session={fake as unknown as ClientSession}
          chatId="conv-1"
          title="Nabídka Acme"
          {...props}
        />
      </QueryClientProvider>,
    );
  });
  await act(async () => {});
  return { root: renderer.root, fake, renderer };
}

beforeEach(() => {
  mockNavigate.mockReset();
  mockToast.undo.mockReset();
  mockPath.current = "/chat/conv-1";
  stored.clear();
});

test("one line: the sidebar button on phones, the name, then the chat's menu", async () => {
  const { root } = await render({ pet: <span data-testid="pet" /> });
  const header = root.findByProps({ "data-testid": "chat-header" });
  expect(header.type).toBe("header");
  // DOM nodes only, in document order.
  const order = header
    .findAll((node) => typeof node.type === "string")
    .map((node) =>
      node.type === "h1"
        ? "title"
        : node.props["aria-label"] === "Možnosti chatu"
          ? "menu"
          : node.props["data-host"] === "SidebarTrigger"
            ? "sidebar"
            : node.props["data-testid"] === "pet"
              ? "pet"
              : null,
    )
    .filter(Boolean);
  expect(order).toEqual(["sidebar", "title", "pet", "menu"]);
  expect(text(header.findByType("h1"))).toBe("Nabídka Acme");
  expect(host(root, "DropdownMenuItem").map(text)).toEqual([
    "Přejmenovat",
    "Připnout chat",
    "Archivovat",
    "Smazat",
  ]);
});

test("Rename turns the name into a field; Enter names the chat for all devices", async () => {
  const { root, fake } = await render();
  await act(async () => item(root, "Přejmenovat").props.onSelect());
  const input = root.findByType("input");
  expect(input.props["aria-label"]).toBe("Název chatu");
  expect(input.props.defaultValue).toBe("Nabídka Acme");
  await act(async () =>
    input.props.onKeyDown({
      key: "Enter",
      preventDefault: () => {},
      currentTarget: { value: "Nabídka Beta" },
    }),
  );
  await act(async () => {});
  expect((fake as Fake).renameConversation).toHaveBeenCalledWith(
    "conv-1",
    "Nabídka Beta",
    expect.any(String),
  );
  expect(text(root.findByType("h1"))).toBe("Nabídka Beta");
});

test("Escape keeps the old name and sends nothing", async () => {
  const { root, fake } = await render();
  await act(async () => item(root, "Přejmenovat").props.onSelect());
  await act(async () =>
    root.findByType("input").props.onKeyDown({
      key: "Escape",
      preventDefault: () => {},
      currentTarget: { value: "Jinak" },
    }),
  );
  expect(fake.renameConversation).not.toHaveBeenCalled();
  expect(text(root.findByType("h1"))).toBe("Nabídka Acme");
});

test("Pin keeps the chat on top of the list in this browser", async () => {
  const { root } = await render();
  await act(async () => item(root, "Připnout chat").props.onSelect());
  // The pin is stored at once; the menu re-reads it on a later render, which
  // can come a tick later under a loaded test run.
  await waitFor(() => {
    expect([...stored.values()].join()).toContain("conv-1");
    expect(item(root, "Odepnout chat")).toBeTruthy();
  });
});

test("Archive leaves the open chat and offers Undo, which brings it back", async () => {
  const { root, fake } = await render();
  await act(async () => item(root, "Archivovat").props.onSelect());
  await act(async () => {});
  expect(fake.archiveConversation).toHaveBeenCalledWith(
    "conv-1",
    expect.any(String),
  );
  expect(mockNavigate).toHaveBeenCalledWith({ to: "/" });
  expect(mockToast.undo).toHaveBeenCalledWith(
    "Chat je v archivu",
    expect.any(Function),
  );
  const [, undo] = mockToast.undo.mock.calls[0] as [string, () => void];
  await act(async () => undo());
  await act(async () => {});
  expect(fake.restoreConversation).toHaveBeenCalledWith(
    "conv-1",
    expect.any(String),
  );
  expect(mockNavigate).toHaveBeenLastCalledWith({
    to: "/chat/$conversationId",
    params: { conversationId: "conv-1" },
  });
});

test("work waiting in the chat is named before archiving, and no Undo is offered yet", async () => {
  const { root, fake } = await render();
  fake.archiveConversation.mockRejectedValueOnce(
    new ConversationOpenWorkError([]),
  );
  await act(async () => item(root, "Archivovat").props.onSelect());
  await act(async () => {});
  expect(mockToast.undo).not.toHaveBeenCalled();
  expect(
    host(root, "AlertDialog").some((node) => node.props.open === true),
  ).toBe(true);
});

test("Delete asks first; only the confirmation deletes", async () => {
  const { root, fake } = await render();
  await act(async () => item(root, "Smazat").props.onSelect());
  expect(fake.deleteConversation).not.toHaveBeenCalled();
  const dialog = host(root, "AlertDialog").find(
    (node) => node.props.open === true,
  )!;
  expect(text(dialog)).toContain("Nabídka Acme");
  await act(async () => host(dialog, "AlertDialogAction")[0]!.props.onClick());
  await act(async () => {});
  expect(fake.deleteConversation).toHaveBeenCalledWith(
    "conv-1",
    expect.any(String),
  );
  expect(mockNavigate).toHaveBeenCalledWith({ to: "/" });
});

test("a hub item's chat cannot be archived; a new chat has no menu at all", async () => {
  const hub = await render({ chatId: "chat-hub-inbox" });
  expect(host(hub.root, "DropdownMenuItem").map(text)).not.toContain(
    "Archivovat",
  );
  const fresh = await render({ chatId: undefined, title: "Nový chat" });
  expect(host(fresh.root, "DropdownMenuItem")).toHaveLength(0);
  expect(
    fresh.root.findAll((node) => node.props["aria-label"] === "Možnosti chatu"),
  ).toHaveLength(0);
});

test("a failed archive says so under the header, never in a toast", async () => {
  const { root, fake } = await render();
  fake.archiveConversation.mockRejectedValueOnce(
    new Error("connection_failed"),
  );
  await act(async () => item(root, "Archivovat").props.onSelect());
  await act(async () => {});
  expect(mockToast.undo).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(root.findAllByProps({ role: "alert" })).toHaveLength(1);
});

test("Export downloads the chat as Markdown or JSON with a plain link, before Delete", async () => {
  mockApp.workspace = { organizationId: "org-1", workspaceId: "ws-1" };
  try {
    const { root } = await render();
    const isLink = (node: ReactTestInstance) =>
      node.type === "a" && node.props.download === true;
    const links = root.findAll(isLink);
    expect(links.map(text)).toEqual([
      "Exportovat jako Markdown",
      "Exportovat jako JSON",
    ]);
    expect(links.map((link) => link.props.href)).toEqual([
      "/admin/api/identity/conversations/export?organizationId=org-1&workspaceId=ws-1&conversationId=conv-1&format=md&lang=cs",
      "/admin/api/identity/conversations/export?organizationId=org-1&workspaceId=ws-1&conversationId=conv-1&format=json&lang=cs",
    ]);
    // The destructive item stays last, right after the export.
    const menu = root
      .findAll(
        (node) =>
          isLink(node) || node.props["data-host"] === "DropdownMenuItem",
      )
      .map(text);
    expect(menu.slice(-3)).toEqual([
      "Exportovat jako Markdown",
      "Exportovat jako JSON",
      "Smazat",
    ]);
  } finally {
    mockApp.workspace = undefined;
  }
});
