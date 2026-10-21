import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { ProcessRows } from "../apps/server-admin/web/service-process-overview";
import {
  WorkspaceProcessesPage,
  loadOwnedProcesses,
} from "../apps/server-admin/web/workspace-processes-page";
import { designEn } from "../apps/server-admin/web/process-design-copy";
import { WORKSPACE_PROCESS_PROFILE } from "../packages/protocol/service-processes";
import { designScopeStorageKey } from "../apps/server-admin/web/lib/process-design-client";

const target = { organizationId: "test_org", workspaceId: "test_workspace" };
const rows: React.ComponentProps<typeof ProcessRows>["processes"] = [
  {
    id: "workspace_process",
    name: "Shared workspace process",
    kind: "workflow",
    activeVersion: null,
    updatedAt: "2026-10-04T12:00:00.000Z",
  },
  {
    id: "crm_process",
    serviceId: "test_service",
    name: "CRM process",
    kind: "agent",
    activeVersion: 2,
    updatedAt: "2026-10-04T12:00:00.000Z",
  },
];
const mockRequest = jest.fn();
let mockOptions: { enabled: boolean; queryKey: unknown[] };
const mockRefetch = jest.fn();
let mockQuery = {
  data: rows as typeof rows | undefined,
  isError: false,
  isPending: false,
  refetch: mockRefetch,
};
const mockAdmin = {
  language: "en",
  authorityGeneration: "current_authority",
  refreshGeneration: 0,
  data: {
    authentication: {
      current: "better-auth",
      principalId: "test_user",
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
  },
};
let mockCatalog = {
  target: { ...target },
  scope: {
    ready: true,
    identity: { data: { user: { id: "test_user" } }, isError: false },
    detail: { isError: false },
    organization: { role: "owner" },
  },
  query: {
    data: { canManage: true, services: [{ id: "test_service", name: "CRM" }] },
    isError: false,
  },
};

jest.mock("@tanstack/react-router", () => ({
  Link: (props: React.ComponentProps<"a">) =>
    jest
      .requireActual<typeof import("react")>("react")
      .createElement("a", props),
}));
jest.mock("@tanstack/react-query", () => ({
  useQuery: (options: typeof mockOptions) => {
    mockOptions = options;
    return mockQuery;
  },
}));
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => mockAdmin,
}));
jest.mock("../apps/server-admin/web/catalog-shared", () => ({
  useCatalog: () => mockCatalog,
  CatalogBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: (...args: unknown[]) => mockRequest(...args),
  ApiError: class extends Error {},
}));
function mockHost({ children }: { children?: React.ReactNode }) {
  return jest
    .requireActual<typeof import("react")>("react")
    .createElement("div", null, children);
}
jest.mock(
  "@admin/components/ui/button",
  () => ({
    Button: (props: React.ComponentProps<"button">) =>
      jest
        .requireActual<typeof import("react")>("react")
        .createElement("button", props),
  }),
  { virtual: true },
);
jest.mock("@admin/components/ui/card", () => ({ Card: mockHost }), {
  virtual: true,
});
jest.mock(
  "@admin/components/ui/item",
  () =>
    Object.fromEntries(
      [
        "Item",
        "ItemActions",
        "ItemContent",
        "ItemDescription",
        "ItemMedia",
        "ItemTitle",
      ].map((name) => [name, mockHost]),
    ),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/empty",
  () =>
    Object.fromEntries(
      [
        "Empty",
        "EmptyContent",
        "EmptyDescription",
        "EmptyHeader",
        "EmptyMedia",
        "EmptyTitle",
      ].map((name) => [name, mockHost]),
    ),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/alert",
  () => ({ Alert: mockHost, AlertDescription: mockHost }),
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/skeleton",
  () => ({
    Skeleton: () =>
      jest
        .requireActual<typeof import("react")>("react")
        .createElement("div", null, "Loading"),
  }),
  { virtual: true },
);
jest.mock(
  "@admin/components/console/page",
  () => ({
    Section: mockHost,
    PageHeader: ({ actions }: { actions: React.ReactNode }) =>
      jest
        .requireActual<typeof import("react")>("react")
        .createElement("header", null, actions),
  }),
  { virtual: true },
);
jest.mock(
  "@admin/components/console/entity-icon",
  () => ({ EntityIcon: mockHost }),
  { virtual: true },
);
jest.mock(
  "@admin/components/console/status",
  () => ({ StatusBadge: mockHost }),
  { virtual: true },
);
jest.mock(
  "@admin/components/console/time",
  () => ({ RelativeTime: () => null }),
  { virtual: true },
);

const mounted: TestRenderer.ReactTestRenderer[] = [];
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  mockRefetch.mockClear();
  mockRequest.mockReset();
  mockQuery = {
    data: rows,
    isError: false,
    isPending: false,
    refetch: mockRefetch,
  };
  mockCatalog = {
    ...mockCatalog,
    target: { ...target },
    scope: { ...mockCatalog.scope, ready: true },
    query: {
      data: {
        canManage: true,
        services: [{ id: "test_service", name: "CRM" }],
      },
      isError: false,
    },
  };
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      get length() {
        return storage.size;
      },
      key: (index: number) => [...storage.keys()][index] ?? null,
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
});
afterEach(() => act(() => mounted.splice(0).forEach((tree) => tree.unmount())));
afterAll(() => {
  Reflect.deleteProperty(globalThis, "sessionStorage");
});
const text = (node: ReactTestInstance): string =>
  node.children
    .map((child) => (typeof child === "string" ? child : text(child)))
    .join("");
function mount(element: React.ReactElement) {
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(element);
  });
  mounted.push(tree!);
  return tree!;
}
function summaries() {
  return rows.map((row) => ({
    ...row,
    revision: 1,
    latestVersion: 2,
    ...(!row.serviceId ? { owner: { type: "workspace" } } : {}),
  }));
}

test("mixed workspace and service rows show their scope and route each process to its owner", () => {
  const tree = mount(<WorkspaceProcessesPage />);
  const links = tree.root.findAllByType("a");
  expect(
    links.find((link) => text(link).includes(rows[0]!.name))!.props,
  ).toMatchObject({
    to: "/processes/$processId",
    params: { processId: "workspace_process" },
  });
  expect(
    links.find((link) => text(link).includes(rows[1]!.name))!.props,
  ).toMatchObject({
    to: "/services/$serviceId/processes/$processId",
    params: { serviceId: "test_service", processId: "crm_process" },
  });
  // Only a service owner is worth a subtitle; workspace rows carry no filler.
  expect(text(tree.root)).not.toContain(designEn.workspaceProcess);
  expect(text(tree.root)).toContain("CRM");
});

test("legacy service overview summaries keep their caller-owned route when serviceId is omitted", () => {
  const legacy = { ...rows[1]! };
  delete legacy.serviceId;
  const tree = mount(
    <ProcessRows
      processes={[legacy]}
      serviceId="legacy_service"
      copy={designEn}
    />,
  );
  expect(tree.root.findByType("a").props).toMatchObject({
    to: "/services/$serviceId/processes/$processId",
    params: { serviceId: "legacy_service", processId: "crm_process" },
  });
});

test("access loss and inventory errors hide prior process rows and private recovery data", () => {
  storage.set(
    `${designScopeStorageKey({ ...target, authority: "old_authority", serviceId: "" })}/old_session`,
    JSON.stringify({
      version: 1,
      sessionId: "old_session",
      pending: null,
      composer: "PRIVATE unsent content",
      modelId: "test_model",
    }),
  );
  const tree = mount(<WorkspaceProcessesPage />);
  expect(text(tree.root)).toContain(rows[0]!.name);
  mockCatalog = {
    ...mockCatalog,
    query: {
      ...mockCatalog.query,
      data: { ...mockCatalog.query.data, canManage: false },
    },
  };
  act(() => tree.update(<WorkspaceProcessesPage />));
  expect(mockOptions.enabled).toBe(false);
  expect(tree.root.findAllByType("a")).toHaveLength(0);
  expect(text(tree.root)).not.toContain(rows[0]!.name);
  expect(text(tree.root)).not.toContain(rows[1]!.name);
  expect(text(tree.root)).not.toContain("PRIVATE");
  mockCatalog = {
    ...mockCatalog,
    query: {
      ...mockCatalog.query,
      data: { ...mockCatalog.query.data, canManage: true },
    },
  };
  mockQuery = { ...mockQuery, isError: true };
  act(() => tree.update(<WorkspaceProcessesPage />));
  expect(text(tree.root)).toContain(designEn.processLoadFailed);
  expect(text(tree.root)).not.toContain(rows[0]!.name);
});

test("workspace changes use a separate query key and render loading without old-scope rows", () => {
  const tree = mount(<WorkspaceProcessesPage />);
  const oldKey = mockOptions.queryKey;
  mockCatalog = {
    ...mockCatalog,
    target: { ...target, workspaceId: "next_workspace" },
  };
  mockQuery = { ...mockQuery, data: undefined, isPending: true };
  act(() => tree.update(<WorkspaceProcessesPage />));
  expect(mockOptions.queryKey).not.toEqual(oldKey);
  expect(mockOptions.queryKey).toContain("next_workspace");
  expect(text(tree.root)).toContain("Loading");
  expect(text(tree.root)).not.toContain(rows[0]!.name);
  expect(text(tree.root)).not.toContain(rows[1]!.name);
});

test("owned inventory loader accepts mixed summaries but rejects foreign scope, private additions and late authority results", async () => {
  const response = {
    ...target,
    profile: WORKSPACE_PROCESS_PROFILE,
    processes: summaries().sort((a, b) => a.id.localeCompare(b.id)),
    nextAfter: null,
  };
  mockRequest.mockResolvedValue(response);
  expect(
    await loadOwnedProcesses(target, new AbortController().signal),
  ).toHaveLength(2);
  mockRequest.mockResolvedValue({
    ...response,
    workspaceId: "foreign_workspace",
  });
  await expect(
    loadOwnedProcesses(target, new AbortController().signal),
  ).rejects.toThrow("Workspace process inventory mismatch");
  mockRequest.mockResolvedValue({
    ...response,
    processes: response.processes.map((row) => ({
      ...row,
      privateSuite: "PRIVATE scripts",
    })),
  });
  await expect(
    loadOwnedProcesses(target, new AbortController().signal),
  ).rejects.toThrow();
  const controller = new AbortController();
  mockRequest.mockImplementation(async () => {
    controller.abort(new Error("Authority changed"));
    return response;
  });
  await expect(loadOwnedProcesses(target, controller.signal)).rejects.toThrow(
    "Authority changed",
  );
});
