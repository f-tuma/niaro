import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AddServicePage } from "../apps/server-admin/web/catalog-services";

const mockMutate = jest.fn();
const mockNavigate = jest.fn();
let mockMode: string | undefined = "manual";
jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: jest.fn(),
  ApiError: class ApiError extends Error {},
}));
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => ({
    language: "en",
    authorityGeneration: 1,
    data: { authentication: { principalId: "usr_TEST" } },
  }),
}));
jest.mock("../apps/server-admin/web/console-scope", () => ({
  useConsoleScope: () => ({
    organization: { id: "org_TEST", name: "TEST", role: "owner" },
  }),
}));
jest.mock("@tanstack/react-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    useNavigate: () => mockNavigate,
    useSearch: () => (mockMode ? { mode: mockMode } : {}),
    Link: ({ children }: { children: React.ReactNode }) =>
      React.createElement("a", null, children),
  };
});
jest.mock("../apps/server-admin/web/catalog-shared", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { useCatalogCopy } = jest.requireActual<
    typeof import("../apps/server-admin/web/catalog-copy")
  >("../apps/server-admin/web/catalog-copy");
  return {
    useCatalog: () => ({
      copy: useCatalogCopy(),
      scope: { organization: { role: "owner" } },
      target: { organizationId: "org_TEST", workspaceId: "wsp_TEST" },
      query: { data: { canManage: true, services: [] } },
      busy: false,
      error: null,
      setError: jest.fn(),
      mutate: (...args: unknown[]) => mockMutate(...args),
    }),
    CatalogBoundary: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    ServiceGlyph: () => null,
    DeleteButton: () => null,
    catalogIssue: () => "",
    serviceSettings: () => ({}),
  };
});
jest.mock("../apps/server-admin/web/service-access", () => host());
jest.mock("../apps/server-admin/web/service-auth", () => host());
jest.mock("../apps/server-admin/web/workspace-roles", () => host());
jest.mock("../apps/server-admin/web/service-avatar", () => host());
jest.mock("../apps/server-admin/web/service-action-list", () => host());
jest.mock("../apps/server-admin/web/process-design-page", () => host());
jest.mock("../apps/server-admin/web/service-setup-overview", () => host());
jest.mock("../apps/server-admin/web/service-personal", () => ({
  personallyManaged: () => false,
  usePersonalMode: () => null,
}));
const host = (overrides?: Record<string, unknown>) =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule(overrides);
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/textarea", () => host(), { virtual: true });
jest.mock("@admin/components/ui/checkbox", () => host(), { virtual: true });
jest.mock("@admin/components/ui/switch", () => host(), { virtual: true });
jest.mock("@admin/components/ui/toggle-group", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/ui/select", () => host(), { virtual: true });
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock("@admin/components/ui/badge", () => host(), { virtual: true });
jest.mock("@admin/components/ui/empty", () => host(), { virtual: true });
jest.mock("@admin/components/ui/tabs", () => host(), { virtual: true });
jest.mock("@admin/components/ui/sheet", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/dropdown-menu", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/page", () => host(), { virtual: true });
jest.mock("@admin/components/console/entity-icon", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/disclosure", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/status", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/forms", () => host(), {
  virtual: true,
});

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const mounted: { unmount(): void }[] = [];
async function render() {
  const client = new QueryClient();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <AddServicePage />
      </QueryClientProvider>,
    );
  });
  mounted.push({
    unmount: () => {
      renderer.unmount();
      client.clear();
    },
  });
  return renderer.root;
}
afterEach(() => {
  for (const entry of mounted.splice(0)) act(() => entry.unmount());
  mockMutate.mockReset();
  mockNavigate.mockReset();
  mockMode = "manual";
});

test("adding a service opens the plain service form, with no templates to start from", async () => {
  for (const mode of ["manual", "assistant"]) {
    mockMode = mode;
    const root = await render();
    const page = text(root);
    for (const gone of ["Start from", "Twenty CRM", "Microsoft 365"])
      expect(page).not.toContain(gone);
    expect(
      root.findAll(
        (node) => node.type === "input" && node.props.id === "service-url",
      ),
    ).toHaveLength(1);
  }
});

test("the form saves a new service and opens it", async () => {
  mockMutate.mockResolvedValue({ id: "svc_TEST" });
  const root = await render();
  const input = (id: string) =>
    root.find((node) => node.type === "input" && node.props.id === id);
  await act(async () =>
    input("service-name").props.onChange({ target: { value: "TEST API" } }),
  );
  await act(async () =>
    input("service-url").props.onChange({
      target: { value: "https://api.example.test/v1" },
    }),
  );
  await act(async () =>
    root.findByType("form").props.onSubmit({ preventDefault() {} }),
  );
  expect(mockMutate).toHaveBeenCalledWith("command", {
    type: "saveService",
    revision: 0,
    settings: expect.objectContaining({
      name: "TEST API",
      url: "https://api.example.test/v1",
      protocol: "openapi",
    }),
  });
  expect(mockNavigate).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "/services/$serviceId",
      params: { serviceId: "svc_TEST" },
      search: { tab: "actions" },
    }),
  );
});
