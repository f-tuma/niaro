import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  KNOWLEDGE_PROFILE,
  type KnowledgeAdminViewValue,
} from "../packages/protocol/knowledge";
import { WorkspaceKnowledge } from "../apps/server-admin/web/workspace-knowledge";

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
  useAdmin: () => ({ language: "en" }),
}));
const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/checkbox", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/progress", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/ui/switch", () => host(), { virtual: true });
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/sheet", () => host(), { virtual: true });
jest.mock("@admin/components/console/disclosure", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });
jest.mock("@admin/components/console/time", () => host(), { virtual: true });

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const byHost = (root: ReactTestInstance, name: string) =>
  root.findAll((node) => node.props["data-host"] === name);
const button = (root: ReactTestInstance, label: string) =>
  root.find((node) => node.type === "button" && text(node).includes(label));

const view = (
  extra: Partial<KnowledgeAdminViewValue> = {},
): KnowledgeAdminViewValue => ({
  profile: KNOWLEDGE_PROFILE,
  organizationId: "org-1",
  workspaceId: "ws-1",
  revision: 2,
  settings: {
    files: true,
    sources: [],
    chunking: { size: 1200, overlap: 150 },
  },
  status: {
    state: "idle",
    model: "Small embeddings",
    documents: 3,
    chunks: 42,
    stale: 0,
    lastSync: "2026-11-05T09:00:00.000Z",
    progress: null,
    errors: [
      {
        source: "scan.png",
        error: "knowledge_empty",
        at: "2026-11-05T09:00:00.000Z",
      },
    ],
  },
  candidates: [
    {
      serviceId: "wiki",
      serviceName: "Wiki",
      actions: [
        { id: "procedures", name: "List procedures" },
        { id: "faq", name: "FAQ" },
      ],
    },
  ],
  filesReadable: true,
  ...extra,
});

async function render(current: KnowledgeAdminViewValue) {
  mockApi.mockImplementation(async (path: string, body: { type?: string }) =>
    path === "identity/knowledge/get"
      ? current
      : body.type === "rebuild"
        ? view({
            status: {
              ...current.status,
              state: "running",
              progress: { done: 1, total: 4 },
            },
          })
        : view({ revision: 3 }),
  );
  let renderer!: TestRenderer.ReactTestRenderer;
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  const onOpenChange = jest.fn();
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <WorkspaceKnowledge
          organizationId="org-1"
          workspaceId="ws-1"
          name="Sales"
          open
          onOpenChange={onOpenChange}
        />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 20 && !renderer.root.findAllByType("form").length; i++)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  return { root: renderer.root, renderer, onOpenChange, client };
}

beforeEach(() => mockApi.mockReset());

test("administrators see where the index stands and pick sources, off by default", async () => {
  const { root, renderer, onOpenChange, client } = await render(view());
  expect(mockApi).toHaveBeenCalledWith(
    "identity/knowledge/get",
    { organizationId: "org-1", workspaceId: "ws-1" },
    expect.anything(),
  );
  const status = root.find(
    (node) => node.props["data-testid"] === "knowledge-status",
  );
  const shown = text(status);
  expect(shown).toContain("Small embeddings");
  expect(shown).toContain("42");
  expect(shown).toContain("scan.png");
  expect(shown).toContain("knowledge_empty");
  // No source is picked until the administrator picks one.
  const boxes = byHost(root, "Checkbox");
  expect(boxes.map((box) => box.props.checked)).toEqual([false, false]);
  expect(
    root
      .findAll(
        (node) =>
          node.type === "label" || node.props["data-host"] === "FieldLabel",
      )
      .map(text),
  ).toEqual(expect.arrayContaining(["List procedures", "FAQ"]));
  await act(async () => boxes[0]!.props.onCheckedChange(true));
  const files = byHost(root, "Switch")[0]!;
  expect(files.props.checked).toBe(true);
  await act(async () => files.props.onCheckedChange(false));
  await act(async () =>
    root.findByType("form").props.onSubmit({ preventDefault: () => {} }),
  );
  expect(mockApi).toHaveBeenLastCalledWith("identity/knowledge/command", {
    organizationId: "org-1",
    workspaceId: "ws-1",
    type: "save",
    revision: 2,
    settings: {
      files: false,
      sources: [{ serviceId: "wiki", actionId: "procedures" }],
      chunking: { size: 1200, overlap: 150 },
    },
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
  act(() => renderer.unmount());
  client.clear();
});

test("a rebuild starts from the sheet and shows its progress", async () => {
  const { root, renderer, client } = await render(view());
  await act(async () => button(root, "Rebuild index").props.onClick());
  expect(mockApi).toHaveBeenLastCalledWith("identity/knowledge/command", {
    organizationId: "org-1",
    workspaceId: "ws-1",
    type: "rebuild",
  });
  const status = root.find(
    (node) => node.props["data-testid"] === "knowledge-status",
  );
  expect(text(status)).toContain("Indexing 1 / 4");
  expect(byHost(root, "Progress")[0]!.props.value).toBe(25);
  // A pass is running: the button waits for it.
  expect(button(root, "Rebuild index").props.disabled).toBe(true);
  act(() => renderer.unmount());
  client.clear();
});

test("without an embedding model the sheet says knowledge is off and offers no rebuild", async () => {
  const { root, renderer, client } = await render(
    view({
      status: {
        state: "off",
        model: null,
        documents: 0,
        chunks: 0,
        stale: 0,
        lastSync: null,
        progress: null,
        errors: [],
      },
      filesReadable: false,
    }),
  );
  const off = root.find(
    (node) => node.props["data-testid"] === "knowledge-off",
  );
  expect(text(off)).toContain("embedding model");
  expect(
    root.findAll(
      (node) => node.type === "button" && text(node).includes("Rebuild"),
    ),
  ).toEqual([]);
  // Files are not read on this server: the sheet says so.
  expect(text(root)).toContain("no document converter");
  act(() => renderer.unmount());
  client.clear();
});

test("an invalid overlap is refused before anything is sent", async () => {
  const { root, renderer, client } = await render(view());
  const overlap = root.find(
    (node) =>
      node.type === "input" && String(node.props.id).endsWith("-overlap"),
  );
  await act(async () => overlap.props.onChange({ target: { value: "900" } }));
  mockApi.mockClear();
  await act(async () =>
    root.findByType("form").props.onSubmit({ preventDefault: () => {} }),
  );
  expect(mockApi).not.toHaveBeenCalled();
  expect(text(root)).toContain("Check the passage length and the overlap.");
  act(() => renderer.unmount());
  client.clear();
});
