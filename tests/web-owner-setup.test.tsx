import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../apps/server-admin/web/App";
import { en } from "../apps/server-admin/web/i18n";

const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/console/auth-layout", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });
jest.mock("@tanstack/react-router", () => ({
  Outlet: () => null,
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: "/admin/" } }),
}));
jest.mock("../apps/server-admin/web/console-shell", () => ({
  ConsoleShell: () => "TEST console",
}));
jest.mock("../apps/server-admin/web/device-login", () => ({
  DeviceLogin: () => null,
}));
jest.mock("../apps/server-admin/web/service-auth", () => ({
  ServiceConnect: () => null,
}));
jest.mock("../apps/server-admin/web/mcp-consent", () => ({
  McpConsent: () => null,
}));
jest.mock("../apps/server-admin/web/lib/mcp-oauth-query", () => ({
  readMcpOAuthQuery: () => "",
}));
jest.mock("../apps/server-admin/web/provider-sign-in", () => ({
  ProviderSignIn: () => null,
}));
const mockApi = jest.fn();
const mockOverview = jest.fn();
jest.mock("../apps/server-admin/web/lib/api", () => {
  class ApiError extends Error {
    status: number;
    code?: string;
    constructor(mockStatus: number, mockCode?: string) {
      super(String(mockStatus));
      this.status = mockStatus;
      this.code = mockCode;
    }
  }
  return {
    ApiError,
    api: (...args: unknown[]) => mockApi(...args),
    authApi: jest.fn(),
    loadOverview: () => mockOverview(),
    overviewKey: ["admin", "overview"],
    mcpLoginRedirect: () => null,
    errorMessage: (error: unknown) =>
      error instanceof ApiError && error.status === 401
        ? "authError"
        : "networkError",
  };
});

const owner = {
  authentication: {
    current: "better-auth",
    identityEnabled: true,
    principalId: "TEST-owner",
    console: true,
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  },
};
const text = (node: ReactTestInstance): string =>
  node.children
    .map((child) => (typeof child === "string" ? child : text(child)))
    .join("");

async function render(setup: boolean) {
  mockApi.mockImplementation(async (path: string) => {
    if (path === "auth-methods") return { identity: true, setup };
    if (path === "identity/bootstrap") return { ok: true };
    throw new Error(`unexpected ${path}`);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    root: renderer.root,
    close: () => {
      act(() => renderer.unmount());
      client.clear();
    },
  };
}

const globals = globalThis as unknown as Record<string, unknown>;
const saved = ["document", "localStorage", "FormData", "HTMLInputElement"].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globals, key)] as const,
);
beforeEach(() => {
  mockApi.mockReset();
  mockOverview.mockReset();
  for (const [key, value] of Object.entries({
    document: { documentElement: {} },
    localStorage: { getItem: () => null, setItem: () => undefined },
    // The form's fields, as the browser would read them.
    FormData: function (form: { values: Record<string, string> }) {
      return Object.entries(form.values);
    },
    HTMLInputElement: class {},
  }))
    Object.defineProperty(globals, key, {
      value,
      configurable: true,
      writable: true,
    });
});
afterAll(() => {
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globals, key, descriptor);
    else delete globals[key];
});

test("a fresh server's login page creates the owner and opens the console signed in", async () => {
  mockOverview.mockResolvedValueOnce(null).mockResolvedValue(owner);
  const { root, close } = await render(true);
  try {
    const layout = root.find(
      (node) => node.props["data-host"] === "AuthLayout",
    );
    expect(layout.props.title).toBe(en.setupTitle);
    expect(layout.props.description).toBe(en.setupDescription);
    expect(
      root
        .findAll((node) => node.type === "input")
        .map((node) => node.props.name),
    ).toEqual(["organizationName", "name", "email", "password"]);
    // The recovery key stays available as the secondary link.
    expect(layout.props.footer.props.children).toBe(en.useRecovery);
    expect(text(root)).toContain(en.setupAction);
    const values = {
      organizationName: "TEST Org",
      name: "TEST Owner",
      email: "owner@example.test",
      password: "TEST-owner-password",
    };
    await act(async () => {
      root.findByType("form").props.onSubmit({
        preventDefault: () => undefined,
        currentTarget: { values, elements: { namedItem: () => null } },
      });
    });
    expect(mockApi).toHaveBeenCalledWith(
      "identity/bootstrap",
      values,
      expect.anything(),
    );
    expect(text(root)).toContain("TEST console");
  } finally {
    close();
  }
});

test("once an owner exists the login page signs in", async () => {
  mockOverview.mockResolvedValue(null);
  const { root, close } = await render(false);
  try {
    expect(
      root.find((node) => node.props["data-host"] === "AuthLayout").props.title,
    ).toBe(en.loginTitle);
    expect(
      root
        .findAll((node) => node.type === "input")
        .map((node) => node.props.id),
    ).toEqual(["admin-email", "admin-key"]);
  } finally {
    close();
  }
});
