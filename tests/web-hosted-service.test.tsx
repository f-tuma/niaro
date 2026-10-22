import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HostedDefinition } from "../packages/protocol/hosted";
import { HostedPage } from "../apps/server-admin/web/hosted-page";

const mockApi = jest.fn();
const mockNavigate = jest.fn();
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
jest.mock("../apps/server-admin/web/lib/download", () => ({
  downloadFile: jest.fn(),
}));
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => ({
    language: "en",
    data: { authentication: { principalId: "usr_TEST" } },
  }),
}));
jest.mock("../apps/server-admin/web/console-scope", () => ({
  useConsoleScope: () => ({
    organization: { id: "org_TEST", name: "TEST", role: "owner" },
    workspace: { id: "wsp_TEST", name: "TEST" },
  }),
}));
jest.mock("@tanstack/react-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    useNavigate: () => mockNavigate,
    Link: ({
      children,
      params,
    }: {
      children: React.ReactNode;
      params: { serviceId: string };
    }) =>
      React.createElement(
        "a",
        { "data-host": "Link", "data-service": params.serviceId },
        children,
      ),
  };
});
const host = (overrides?: Record<string, unknown>) =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule(overrides);
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/textarea", () => host(), { virtual: true });
jest.mock("@admin/components/ui/checkbox", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/badge", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/ui/dropdown-menu", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/ui/tooltip", () => host(), { virtual: true });
jest.mock("@admin/components/ui/empty", () => host(), { virtual: true });
jest.mock("@admin/components/ui/item", () => host(), { virtual: true });
jest.mock("@admin/components/ui/sheet", () => host(), { virtual: true });
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/toggle-group", () => host(), { virtual: true });
jest.mock("@admin/components/ui/select", () => host(), { virtual: true });
jest.mock("@admin/components/console/page", () => host(), { virtual: true });
jest.mock("@admin/components/console/status", () => host(), { virtual: true });
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });
jest.mock("@admin/components/console/entity-icon", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/disclosure", () => host(), {
  virtual: true,
});

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const buttons = (root: ReactTestInstance, label: string) =>
  root.findAll(
    (node) => node.props["data-host"] === "Button" && text(node) === label,
  );
const flush = async () => {
  for (let i = 0; i < 10; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
};
const microsoft: HostedDefinition = {
  version: 1,
  name: "Microsoft 365",
  source: {
    npm: "@softeria/ms-365-mcp-server",
    version: "0.156.2",
    bin: "ms-365-mcp-server",
  },
  args: ["--http", "0.0.0.0:{port}"],
  env: {},
  secrets: [],
  memoryMb: 512,
  path: "/mcp",
  onboarding: {
    icon: "mail",
    description: "TEST mail and calendar",
    signIn: {
      provider: "microsoft",
      requiredFor: "all",
      scopes: ["Mail.ReadWrite"],
    },
  },
};
const url = "http://127.0.0.1:39100/mcp";
const running = (status = "running", definition = microsoft) => ({
  id: `hs_${"a".repeat(24)}`,
  builtin: "microsoft-365",
  definition,
  secretsSet: [],
  enabled: true,
  status,
  url,
  revision: 2,
  restarts: 0,
});
const service = {
  id: "svc_TEST",
  revision: 1,
  name: "Microsoft 365",
  url,
  protocol: "mcp",
  icon: "mail",
  iconSource: "custom",
  auth: { type: "none" },
  enabled: true,
  hasCredential: false,
  modelId: null,
  actions: [],
};
const provider = {
  id: `ap_${"b".repeat(32)}`,
  organizationId: "org_TEST",
  kind: "microsoft",
  name: "TEST Entra",
  enabled: true,
  revision: 1,
  clientId: "TEST-client",
  hasClientSecret: true,
  tenantId: "11111111-1111-4111-8111-111111111111",
  hostedDomain: null,
  callbackURL: "https://niaro.example.test/admin/auth/callback/ap_x",
};
const oauthStatus = {
  config: {
    revision: 3,
    settings: { requiredFor: "none" },
    hasClientId: false,
    hasClientSecret: false,
    discovery: null,
    lastProbe: null,
  },
  connection: {
    status: "disconnected",
    revision: 0,
    identity: null,
    expiresAt: null,
  },
  redirectUri: "https://niaro.example.test/admin/service-connect",
};
const mounted: { unmount(): void }[] = [];
async function render(
  servers: unknown[],
  options: { services?: unknown[]; providers?: unknown[] } = {},
) {
  mockApi.mockImplementation(async (path: string) => {
    if (path === "identity/hosted/list")
      return {
        organizationId: "org_TEST",
        canManage: true,
        allowCustom: true,
        sandbox: "process",
        builtins: [{ id: "microsoft-365", definition: microsoft }],
        servers,
      };
    if (path.startsWith("identity/catalog?"))
      return {
        organizationId: "org_TEST",
        workspaceId: "wsp_TEST",
        canManage: true,
        services: options.services ?? [],
        providers: [],
        models: [],
        routing: { revision: 0, modelId: null, services: [] },
      };
    if (path === "identity/catalog/command") return { id: "svc_NEW" };
    if (path === "identity/auth-providers/list")
      return {
        organizationId: "org_TEST",
        canManage: true,
        providers: options.providers ?? [],
      };
    if (path === "identity/catalog/oauth/status") return oauthStatus;
    return { ok: true };
  });
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <HostedPage />
      </QueryClientProvider>,
    );
  });
  await flush();
  mounted.push({
    unmount: () => {
      renderer.unmount();
      client.clear();
    },
  });
  return renderer.root;
}
const calls = (path: string) =>
  mockApi.mock.calls.filter(([p]) => p === path).map(([, body]) => body);
afterEach(() => {
  for (const entry of mounted.splice(0)) act(() => entry.unmount());
  mockApi.mockReset();
  mockNavigate.mockReset();
});

test("a running server creates its MCP service from the definition and prefills personal sign-in", async () => {
  const root = await render([running()], { providers: [provider] });
  const [create] = buttons(root, "Create service");
  expect(create).toBeDefined();
  await act(async () => create!.props.onClick());
  await flush();
  expect(calls("identity/catalog/command")).toEqual([
    {
      organizationId: "org_TEST",
      workspaceId: "wsp_TEST",
      type: "saveService",
      revision: 0,
      settings: {
        name: "Microsoft 365",
        url,
        protocol: "mcp",
        icon: "mail",
        iconSource: "custom",
        auth: { type: "none" },
        enabled: true,
        description: "TEST mail and calendar",
      },
    },
  ]);
  expect(calls("identity/catalog/oauth/save")).toEqual([
    {
      organizationId: "org_TEST",
      workspaceId: "wsp_TEST",
      serviceId: "svc_NEW",
      revision: 3,
      settings: {
        requiredFor: "all",
        source: "provider",
        authProviderId: provider.id,
        scopes: ["Mail.ReadWrite"],
      },
      client: {},
    },
  ]);
  expect(mockNavigate).toHaveBeenCalledWith({
    to: "/services/$serviceId",
    params: { serviceId: "svc_NEW" },
  });
});

test("without a Microsoft sign-in method the service is created and sign-in is left to its page", async () => {
  // A stored built-in without onboarding takes it from the shipped definition.
  const { onboarding: _onboarding, ...stored } = microsoft;
  const root = await render([running("running", stored)], {
    providers: [{ ...provider, kind: "google" }],
  });
  await act(async () => buttons(root, "Create service")[0]!.props.onClick());
  await flush();
  expect(calls("identity/catalog/command")).toHaveLength(1);
  expect(
    (calls("identity/catalog/command")[0] as { settings: { icon: string } })
      .settings.icon,
  ).toBe("mail");
  expect(calls("identity/catalog/oauth/save")).toEqual([]);
  expect(mockNavigate).toHaveBeenCalledTimes(1);
});

test("a server whose address is already a service links to it instead", async () => {
  const root = await render([running()], { services: [service] });
  expect(buttons(root, "Create service")).toEqual([]);
  const link = root.find((node) => node.props["data-host"] === "Link");
  expect(text(link)).toBe("Open service");
  expect(link.props["data-service"]).toBe("svc_TEST");
});

test("a server that is not running offers no service yet", async () => {
  for (const status of ["installing", "starting", "failed", "stopped"]) {
    const root = await render([running(status)]);
    expect(buttons(root, "Create service")).toEqual([]);
    expect(text(root)).not.toContain("Open service");
  }
});

test("a failed creation shows one line on the page", async () => {
  const root = await render([running()]);
  mockApi.mockImplementationOnce(async () => {
    throw new Error("network");
  });
  await act(async () => buttons(root, "Create service")[0]!.props.onClick());
  await flush();
  expect(text(root)).toContain("The service couldn't be created. Try again.");
  expect(mockNavigate).not.toHaveBeenCalled();
});
