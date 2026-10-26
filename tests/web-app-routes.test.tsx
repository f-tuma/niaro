import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from "@tanstack/react-router";

// The app's router is built at import with the browser's history; under
// Jest it gets a memory history instead.
jest.mock("@tanstack/react-router", () => {
  const actual = jest.requireActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    createRouter: (options: Parameters<typeof actual.createRouter>[0]) =>
      actual.createRouter({
        history: actual.createMemoryHistory(),
        ...options,
      }),
  };
});
// Pages are stand-ins: these tests are about which page an address opens.
// eslint-disable-next-line react/display-name -- test stand-in
const mockPage = (name: string) => () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return React.createElement("section", { "data-page": name });
};
jest.mock("../apps/server-admin/web/app/hub-page", () => ({
  HubPage: mockPage("dashboard"),
}));
jest.mock("../apps/server-admin/web/app/chat-next/chat-next-page", () => ({
  ChatNextPage: mockPage("chat"),
}));
jest.mock("../apps/server-admin/web/app/tasks-page", () => ({
  TasksPage: mockPage("tasks"),
}));
jest.mock("../apps/server-admin/web/app/processes-page", () => ({
  ProcessesPage: mockPage("processes"),
}));
jest.mock("../apps/server-admin/web/app/connections-page", () => ({
  ConnectionsPage: mockPage("connections"),
}));
jest.mock("../apps/server-admin/web/app/connection-detail", () => ({
  ConnectionDetailPage: mockPage("connection"),
}));
jest.mock("../apps/server-admin/web/app/search-page", () => ({
  SearchPage: mockPage("search"),
}));
jest.mock("../apps/server-admin/web/app/account-page", () => ({
  AccountPage: mockPage("account"),
}));
jest.mock("../apps/server-admin/web/app/process-pages", () => ({
  PersonalDesignPage: mockPage("design"),
  PersonalProcessPage: mockPage("process"),
}));
jest.mock("../apps/server-admin/web/app/skills-page", () => ({
  SkillPage: mockPage("skill"),
  SkillsPage: mockPage("skills"),
}));
jest.mock("../apps/server-admin/web/process-design-page", () => ({
  designSearchSchema: { parse: (value: unknown) => value },
}));
jest.mock("../apps/server-admin/web/app/chat-history", () => ({
  ChatHistoryNav: () => null,
}));
jest.mock("../apps/server-admin/web/process-edits-guard", () => ({
  ProcessEditsGuard: ({ children }: { children: React.ReactNode }) => children,
  useProcessEditsGuard: () => ({ request: (run: () => void) => run() }),
}));
jest.mock("../apps/server-admin/web/process-design-copy", () => ({
  designCs: {},
  designEn: {},
}));
jest.mock("../apps/server-admin/web/lib/theme", () => ({
  setTheme: () => {},
  useTheme: () => "system",
}));
jest.mock("../apps/server-admin/web/app/context", () => ({
  useApp: () => ({
    language: "cs",
    session: {},
    sessionError: null,
    reconnect: () => {},
    isAdmin: false,
    identity: { user: { name: "TEST Anna", email: "anna@example.test" } },
    setLanguage: () => {},
    signOut: () => {},
    workspace: {
      workspaceId: "workspace-1",
      organizationId: "org-1",
      name: "TEST",
      organizationName: "TEST org",
    },
    workspaces: [],
    selectWorkspace: () => {},
  }),
}));
const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock(
  "@admin/components/ui/sidebar",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule({
        useSidebar: () => ({ setOpenMobile: () => {}, isMobile: false }),
      }),
  { virtual: true },
);
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/avatar", () => host(), { virtual: true });
jest.mock("@admin/components/ui/dropdown-menu", () => host(), {
  virtual: true,
});
jest.mock(
  "@admin/components/console/entity-icon",
  () =>
    jest
      .requireActual<
        typeof import("./helpers/web-hosts")
      >("./helpers/web-hosts")
      .hostModule({ initials: (name: string) => name.slice(0, 2) }),
  { virtual: true },
);

// The router core reads `self` like a browser does; the shell listens for
// keys on the window.
const keyListeners = new Set<(event: KeyboardEvent) => void>();
Object.assign(globalThis, {
  self: globalThis,
  scrollTo: () => {},
  addEventListener: (
    type: string,
    listener: (event: KeyboardEvent) => void,
  ) => {
    if (type === "keydown") keyListeners.add(listener);
  },
  removeEventListener: (
    type: string,
    listener: (event: KeyboardEvent) => void,
  ) => keyListeners.delete(listener),
});
const { appRouter } = jest.requireActual<
  typeof import("../apps/server-admin/web/app/router")
>("../apps/server-admin/web/app/router");

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");

async function open(path: string) {
  const router = createRouter({
    routeTree: appRouter.options.routeTree!,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<RouterProvider router={router} />);
  });
  await act(async () => {
    await router.load();
  });
  return { router, root: renderer.root, unmount: () => renderer.unmount() };
}
const shown = (root: ReactTestInstance) =>
  root.find(
    (node) => typeof node.type === "string" && !!node.props["data-page"],
  ).props["data-page"];

test("the app opens on the dashboard; a new chat has its own address", async () => {
  // Signing in happens in place, so the person lands on "/".
  const home = await open("/");
  expect(shown(home.root)).toBe("dashboard");
  const link = (label: string) =>
    home.root.find(
      (node) =>
        node.type === "a" &&
        text(node).includes(label) &&
        typeof node.props.href === "string",
    );
  // "New chat" opens an empty chat, "Overview" the dashboard.
  expect(link("Nový chat").props.href).toBe("/chat");
  expect(link("Přehled").props.href).toBe("/");
  expect(link("Přehled").props["aria-current"]).toBe("page");
  // The sidebar order of docs/ui-system.md; Administrace is in the account menu.
  expect(
    home.root
      .findAll(
        (node) => node.type === "a" && typeof node.props.href === "string",
      )
      .map((node) => text(node))
      .slice(0, 8),
  ).toEqual([
    "Přehled",
    "Nový chat",
    "Hledat",
    "Úkoly",
    "Schůzky",
    "Procesy",
    "Skilly",
    "Připojení",
  ]);
  expect(text(home.root)).not.toContain("Administrace");
  act(() => home.unmount());

  const fresh = await open("/chat");
  expect(shown(fresh.root)).toBe("chat");
  expect(fresh.router.state.matches.at(-1)?.routeId).toBe("/chat/chat");
  act(() => fresh.unmount());

  const saved = await open("/chat/chat-123");
  expect(shown(saved.root)).toBe("chat");
  expect(saved.router.state.matches.at(-1)?.params).toEqual({
    conversationId: "chat-123",
  });
  act(() => saved.unmount());
});

test("a personal service opens its own page under Connections", async () => {
  const detail = await open("/connections/svc-mail");
  expect(shown(detail.root)).toBe("connection");
  expect(detail.router.state.matches.at(-1)?.params).toEqual({
    serviceId: "svc-mail",
  });
  act(() => detail.unmount());
  const list = await open("/connections");
  expect(shown(list.root)).toBe("connections");
  act(() => list.unmount());
});

const press = async (key: string, shiftKey: boolean) =>
  act(async () => {
    for (const listener of keyListeners)
      listener({
        key,
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey,
        preventDefault: () => {},
      } as KeyboardEvent);
  });

test("Ctrl+K searches chats and Ctrl+Shift+O starts a new chat, from anywhere", async () => {
  const tasks = await open("/tasks");
  expect(shown(tasks.root)).toBe("tasks");
  await press("k", false);
  await act(async () => {
    await tasks.router.load();
  });
  expect(tasks.router.state.location.pathname).toBe("/search");
  expect(shown(tasks.root)).toBe("search");
  await press("O", true);
  await act(async () => {
    await tasks.router.load();
  });
  expect(tasks.router.state.location.pathname).toBe("/chat");
  expect(shown(tasks.root)).toBe("chat");
  act(() => tasks.unmount());
});
