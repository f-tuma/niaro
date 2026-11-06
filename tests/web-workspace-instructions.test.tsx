import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  INSTRUCTIONS_PROFILE,
  type InstructionsAdminView,
} from "../packages/protocol/workspace-instructions";
import { WorkspaceInstructions } from "../apps/server-admin/web/workspace-instructions";

const mockApi = jest.fn();
jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(mockStatus: number, mockCode?: string) {
      super(String(mockStatus));
      this.status = mockStatus;
      this.code = mockCode;
    }
  },
}));
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => ({ language: "cs" }),
}));
const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/ui/textarea", () => host(), { virtual: true });
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/item", () => host(), { virtual: true });
jest.mock("@admin/components/ui/sheet", () => host(), { virtual: true });
jest.mock("@admin/components/console/disclosure", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });
jest.mock("@admin/components/console/time", () => host(), { virtual: true });

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const buttons = (root: ReactTestInstance, label: string) =>
  root.findAll(
    (node) =>
      node.type === "button" &&
      (text(node).includes(label) || node.props["aria-label"] === label),
  );
const view: InstructionsAdminView = {
  profile: INSTRUCTIONS_PROFILE,
  organizationId: "org-1",
  scope: { type: "workspace", workspaceId: "ws-1" },
  revision: 2,
  content: { text: "Tykej.", starters: ["Co mám dnes?"] },
  updatedAt: "2026-11-05T09:00:00.000Z",
  updatedByName: "Olga",
  organizationDefault: { text: "Výchozí tón", starters: [] },
  history: [
    {
      revision: 2,
      content: { text: "Tykej.", starters: ["Co mám dnes?"] },
      event: "saved",
      authorName: "Olga",
      createdAt: "2026-11-05T09:00:00.000Z",
    },
    {
      revision: 1,
      content: { text: "Vykej.", starters: [] },
      event: "saved",
      authorName: "Adam",
      createdAt: "2026-11-04T09:00:00.000Z",
    },
  ],
};

async function render(onOpenChange = jest.fn()) {
  let renderer!: TestRenderer.ReactTestRenderer;
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <WorkspaceInstructions
          organizationId="org-1"
          scope={{ type: "workspace", workspaceId: "ws-1" }}
          name="Obchod"
          open
          onOpenChange={onOpenChange}
        />
      </QueryClientProvider>,
    );
  });
  for (
    let i = 0;
    i < 20 && !renderer.root.findAllByType("textarea").length;
    i++
  )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  return { root: renderer.root, renderer, client, onOpenChange };
}

beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockImplementation(async (path: string) =>
    path === "identity/instructions/get" ? view : { revision: 3 },
  );
});

test("administrators edit a workspace's instructions and starters and save them from the revision they read", async () => {
  const { root, renderer, client, onOpenChange } = await render();
  expect(mockApi).toHaveBeenCalledWith(
    "identity/instructions/get",
    {
      organizationId: "org-1",
      scope: { type: "workspace", workspaceId: "ws-1" },
    },
    expect.anything(),
  );
  const sheetTitle = root.find(
    (node) => node.props["data-host"] === "SheetTitle",
  );
  expect(text(sheetTitle)).toBe("Pokyny");
  const textarea = root.findByType("textarea");
  expect(textarea.props.value).toBe("Tykej.");
  expect(textarea.props.maxLength).toBe(8000);
  // The organization default shows where the workspace has no text.
  expect(textarea.props.placeholder).toBe("Výchozí tón");
  await act(async () =>
    textarea.props.onChange({ target: { value: "Tykej, {person.name}." } }),
  );
  const starters = () =>
    root.findAll(
      (node) =>
        node.type === "input" &&
        String(node.props["aria-label"]).startsWith("Úvodní dotaz"),
    );
  expect(starters().map((input) => input.props.value)).toEqual([
    "Co mám dnes?",
  ]);
  await act(async () => buttons(root, "Přidat dotaz")[0]!.props.onClick());
  await act(async () =>
    starters()[1]!.props.onChange({
      target: { value: "Co čeká na schválení?" },
    }),
  );
  await act(async () =>
    root.findByType("form").props.onSubmit({ preventDefault: () => {} }),
  );
  expect(mockApi).toHaveBeenCalledWith("identity/instructions/command", {
    organizationId: "org-1",
    type: "save",
    scope: { type: "workspace", workspaceId: "ws-1" },
    revision: 2,
    content: {
      text: "Tykej, {person.name}.",
      starters: ["Co mám dnes?", "Co čeká na schválení?"],
    },
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
  // The variables are listed for the writer.
  expect(text(root)).toContain("{person.name}");
  expect(text(root)).toContain("{today}");
  renderer.unmount();
  client.clear();
});

test("history shows each version's author and restores an older one; a stale save says so in the sheet", async () => {
  const { root, renderer, client, onOpenChange } = await render();
  const history = root.find(
    (node) =>
      node.props.role === "list" && node.props["aria-label"] === "Historie",
  );
  expect(text(history)).toContain("Olga");
  expect(text(history)).toContain("Adam");
  // The current version has no Restore; the older one has.
  expect(buttons(history, "Obnovit #2")).toHaveLength(0);
  await act(async () => buttons(history, "Obnovit #1")[0]!.props.onClick());
  expect(mockApi).toHaveBeenCalledWith("identity/instructions/command", {
    organizationId: "org-1",
    type: "restore",
    scope: { type: "workspace", workspaceId: "ws-1" },
    revision: 2,
    version: 1,
  });
  const { ApiError } = jest.requireMock<
    typeof import("../apps/server-admin/web/lib/api")
  >("../apps/server-admin/web/lib/api");
  mockApi.mockImplementation(async (path: string) => {
    if (path === "identity/instructions/get") return view;
    throw new ApiError(409, "instructions_conflict");
  });
  await act(async () =>
    root.findByType("form").props.onSubmit({ preventDefault: () => {} }),
  );
  expect(text(root)).toContain("Mezitím se změnily. Otevři je znovu.");
  expect(onOpenChange).not.toHaveBeenCalled();
  renderer.unmount();
  client.clear();
});

test("on the workspace page the instructions are a section: saving keeps them open and Cancel puts the saved text back", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <WorkspaceInstructions
          inline
          organizationId="org-1"
          scope={{ type: "workspace", workspaceId: "ws-1" }}
          name="Obchod"
        />
      </QueryClientProvider>,
    );
  });
  const root = renderer.root;
  for (let i = 0; i < 20 && !root.findAllByType("textarea").length; i++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  // No sheet around it: the page names the workspace.
  expect(
    root.findAll((node) => String(node.props["data-host"]).startsWith("Sheet")),
  ).toHaveLength(0);
  const textarea = () => root.findByType("textarea");
  await act(async () =>
    textarea().props.onChange({ target: { value: "Vykej." } }),
  );
  await act(async () => buttons(root, "Zrušit")[0]!.props.onClick());
  expect(textarea().props.value).toBe("Tykej.");
  await act(async () =>
    textarea().props.onChange({ target: { value: "Vykej." } }),
  );
  await act(async () =>
    root.findByType("form").props.onSubmit({ preventDefault: () => {} }),
  );
  expect(mockApi).toHaveBeenCalledWith(
    "identity/instructions/command",
    expect.objectContaining({ type: "save", content: expect.anything() }),
  );
  expect(text(root)).toContain("Uloženo");
  renderer.unmount();
  client.clear();
});
