import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MembersMcp } from "../apps/server-admin/web/mcp-page";
import { McpConsent } from "../apps/server-admin/web/mcp-consent";
import { McpOAuthClient } from "../apps/server-admin/web/mcp-oauth-client";
import { mcpCopy } from "../apps/server-admin/web/mcp-copy";
import { ApiError } from "../apps/server-admin/web/lib/api";

const mockApi = jest.fn();
const mockAuthApi = jest.fn();
jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
  authApi: (...args: unknown[]) => mockAuthApi(...args),
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
let mockLanguage: "en" | "cs" = "en";
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => ({
    language: mockLanguage,
    data: {
      authentication: { principalId: "TEST-admin", current: "better-auth" },
    },
    setSelectedOrganization: () => {},
  }),
}));
const mockScope = {
  ready: true,
  organization: { id: "TEST-org", name: "TEST org" },
  identity: {
    isPending: false,
    isFetching: false,
    isError: false,
    data: { organizations: [{ id: "TEST-org", name: "TEST org" }] },
  },
  detail: {
    isPending: false,
    isFetching: false,
    isError: false,
    data: {
      workspaces: ["available", "request", "pending", "rejected", "off"].map(
        (state) => ({ id: `TEST-ws-${state}`, name: `TEST ${state}` }),
      ),
    },
  },
};
jest.mock("../apps/server-admin/web/console-scope", () => ({
  useConsoleScope: () => mockScope,
}));
jest.mock("../apps/server-admin/web/lib/mcp-oauth-query", () => ({
  readMcpOAuthQuery: () => "TEST-signed-query",
}));
jest.mock("@tanstack/react-router", () => ({
  Link: () => null,
  useSearch: () => ({}),
}));
const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock("@admin/components/ui/empty", () => host(), { virtual: true });
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/ui/spinner", () => host(), { virtual: true });
jest.mock("@admin/components/ui/item", () => host(), { virtual: true });
jest.mock("@admin/components/ui/checkbox", () => host(), { virtual: true });
jest.mock("@admin/components/ui/sheet", () => host(), { virtual: true });
jest.mock("@admin/components/ui/toggle-group", () => host(), { virtual: true });
jest.mock("@admin/components/ui/select", () => host(), { virtual: true });
jest.mock("@admin/components/ui/dropdown-menu", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });
jest.mock("@admin/components/console/disclosure", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/status", () => host(), { virtual: true });
jest.mock("@admin/components/console/setting-row", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/auth-layout", () => host(), {
  virtual: true,
});
// Section titles are what these tests read.
jest.mock(
  "@admin/components/console/page",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      PageHeader: ({ title }: { title: string }) =>
        React.createElement("header", null, title),
      Section: ({
        title,
        children,
      }: {
        title: string;
        children: React.ReactNode;
      }) => React.createElement("section", null, title, children),
    };
  },
  { virtual: true },
);

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const byHost = (root: ReactTestInstance, name: string) =>
  root.findAll((node) => node.props["data-host"] === name);
const first = (root: ReactTestInstance, name: string) => byHost(root, name)[0]!;
const button = (root: ReactTestInstance, label: string) =>
  byHost(root, "Button").find((node) => text(node) === label)!;
const requestRows = (root: ReactTestInstance) =>
  byHost(root, "Item").filter(
    (node) => node.props["data-testid"] === "mcp-request",
  ) as [ReactTestInstance, ReactTestInstance];
const settle = async () => {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
};
const mounted: (() => void)[] = [];
async function render(element: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>{element}</QueryClientProvider>,
    );
  });
  await settle();
  mounted.push(() => {
    renderer.unmount();
    client.clear();
  });
  return renderer.root;
}
afterEach(() => {
  for (const unmount of mounted.splice(0)) act(unmount);
  mockApi.mockReset();
  mockAuthApi.mockReset();
  mockLanguage = "en";
});

describe("External AI apps: members' policy, requests and access", () => {
  const target = { organizationId: "TEST-org", workspaceId: "TEST-ws" };
  const at = "2026-11-20T10:00:00.000Z";
  const person = { name: "TEST Member", email: "member@example.test" };
  const grant = (id: string, status: "active" | "pending") => ({
    id,
    person,
    label: `TEST ${id}`,
    scopes: ["data.read"],
    createdAt: at,
    expiresAt: "2026-12-20T10:00:00.000Z",
    lastUsedAt: null,
    status,
    revision: 2,
    kind: "manual" as const,
    appName: null,
  });
  const app = (clientId: string, state: "approved" | "pending" | null) => ({
    clientId,
    name: `TEST ${clientId}`,
    host: null,
    redirectUris: ["https://client.example.test/callback"],
    state,
    revision: 4,
    requestedBy: state === "pending" ? person : null,
    requestedAt: state === "pending" ? at : null,
  });
  const state = {
    profile: "agent-mcp-admin/1",
    policy: "review",
    revision: 3,
    requests: {
      grants: [grant("waiting", "pending")],
      apps: [app("TEST-requested", "pending")],
    },
    access: [grant("linked", "active")],
    apps: [app("TEST-approved", "approved"), app("TEST-requested", "pending")],
  };
  const sent = (path: string) =>
    mockApi.mock.calls
      .filter(([called]) => called === `identity/mcp/admin/${path}`)
      .map(([, body]) => body);
  beforeEach(() =>
    mockApi.mockImplementation(async (path: string) =>
      path === "identity/mcp/admin/list" ? state : {},
    ),
  );

  test("shows the policy, the waiting requests, members' access and apps", async () => {
    const root = await render(<MembersMcp {...target} />);
    const copy = mcpCopy.en;
    const page = text(root);
    for (const title of [
      copy.membersApps,
      copy.requests,
      copy.membersAccess,
      copy.apps,
    ])
      expect(page).toContain(title);
    expect(first(root, "Select").props.value).toBe("review");
    expect(byHost(root, "SelectItem").map(text)).toEqual([
      copy.policyOff,
      copy.policyReview,
      copy.policyFree,
    ]);
    expect(requestRows(root)).toHaveLength(2);
    expect(page).toContain("Requested by TEST Member (member@example.test)");
    expect(page).toContain(copy.appApproved);
    expect(page).toContain(copy.neverUsed);
  });

  test("policy changes are revision-checked and off asks first", async () => {
    const root = await render(<MembersMcp {...target} />);
    const select = () => first(root, "Select");
    await act(async () => select().props.onValueChange("free"));
    expect(sent("policy")).toEqual([
      { ...target, policy: "free", revision: 3 },
    ]);
    await act(async () => select().props.onValueChange("off"));
    expect(sent("policy")).toHaveLength(1);
    const confirm = first(root, "ConfirmAction");
    expect(confirm.props.open).toBe(true);
    expect(confirm.props.description).toBe(mcpCopy.en.policyOffHint);
    await act(async () => confirm.props.onConfirm());
    expect(sent("policy")[1]).toEqual({
      ...target,
      policy: "off",
      revision: 3,
    });
  });

  test("requests are approved or rejected with a reason; access is revoked, approvals withdrawn", async () => {
    const root = await render(<MembersMcp {...target} />);
    const copy = mcpCopy.en;
    const [grantRow, appRow] = requestRows(root);
    const reason = first(grantRow, "Input");
    expect(reason.props.maxLength).toBe(500);
    await act(async () =>
      reason.props.onChange({
        target: { value: " Use the shared assistant " },
      }),
    );
    await act(async () => button(grantRow, copy.decline).props.onClick());
    await act(async () => button(appRow, copy.approve).props.onClick());
    expect(sent("review")).toEqual([
      {
        ...target,
        kind: "grant",
        id: "waiting",
        revision: 2,
        decision: "reject",
        reason: "Use the shared assistant",
      },
      {
        ...target,
        kind: "app",
        clientId: "TEST-requested",
        revision: 4,
        decision: "approve",
      },
    ]);
    // Revoking and withdrawing go through the confirmation.
    const revoke = first(root, "DropdownMenuItem");
    await act(async () => revoke.props.onSelect());
    await act(async () => first(root, "ConfirmAction").props.onConfirm());
    expect(sent("revoke")).toEqual([{ ...target, grantId: "linked" }]);
    await act(async () => button(root, copy.withdraw).props.onClick());
    expect(first(root, "ConfirmAction").props.title).toBe(copy.withdrawTitle);
    await act(async () => first(root, "ConfirmAction").props.onConfirm());
    expect(sent("review").at(-1)).toEqual({
      ...target,
      kind: "app",
      clientId: "TEST-approved",
      revision: 4,
      decision: "withdraw",
    });
  });

  test("a stale decision shows the conflict and reloads", async () => {
    const root = await render(<MembersMcp {...target} />);
    mockApi.mockImplementation(async (path: string) => {
      if (path === "identity/mcp/admin/list") return state;
      throw new ApiError(409, "mcp_review_conflict");
    });
    const lists = sent("list").length;
    await act(async () => button(root, mcpCopy.en.approve).props.onClick());
    await settle();
    expect(text(root)).toContain(mcpCopy.en.conflict);
    expect(sent("list").length).toBeGreaterThan(lists);
  });

  test("Czech", async () => {
    mockLanguage = "cs";
    const root = await render(<MembersMcp {...target} />);
    const page = text(root);
    expect(page).toContain("AI aplikace členů");
    expect(page).toContain("Žádosti");
    expect(byHost(root, "SelectItem").map(text)).toEqual([
      "Vypnuto",
      "Schvaluje správce",
      "Povoleno",
    ]);
  });
});

test("OAuth registration names the workspace and says when the app waits", async () => {
  const root = await render(<McpOAuthClient workspaceId="TEST-ws" />);
  const [name, callback] = byHost(root, "Input") as [
    ReactTestInstance,
    ReactTestInstance,
  ];
  await act(async () => name.props.onChange({ target: { value: "TEST app" } }));
  await act(async () =>
    callback.props.onChange({
      target: { value: "https://client.example.test/callback" },
    }),
  );
  mockApi.mockResolvedValueOnce({
    clientId: "TEST-client",
    name: "TEST app",
    redirectUris: ["https://client.example.test/callback"],
    state: "pending",
  });
  await act(async () =>
    root.findByType("form").props.onSubmit({ preventDefault: () => {} }),
  );
  await settle();
  expect(mockApi).toHaveBeenCalledWith(
    "identity/mcp/oauth/client/register",
    {
      workspaceId: "TEST-ws",
      name: "TEST app",
      redirectUris: ["https://client.example.test/callback"],
    },
    expect.anything(),
  );
  expect(text(root)).toContain(mcpCopy.en.registeredPending);
});

describe("Consent: availability per workspace", () => {
  const info = {
    clientName: "TEST app",
    clientId: "TEST-client",
    clientHost: null,
    scopes: ["data.read"],
    connectionDays: null,
    resource: "https://niaro.example.test/mcp",
    redirectUri: "https://client.example.test/callback",
    requiresSignIn: false,
    workspaces: ["available", "request", "pending", "rejected", "off"].map(
      (state) => ({ id: `TEST-ws-${state}`, state }),
    ),
  };
  beforeEach(() =>
    mockAuthApi.mockImplementation(async (path: string) =>
      path === "mcp/oauth/consent-info" ? info : {},
    ),
  );
  const choose = async (root: ReactTestInstance, workspace: string) => {
    const select = byHost(root, "Select").find(
      (node) => node.props.value !== undefined,
    )!;
    await act(async () => select.props.onValueChange(`TEST-ws-${workspace}`));
  };
  const accept = (root: ReactTestInstance) =>
    byHost(root, "Button").find(
      (node) =>
        node.props.variant === undefined &&
        typeof node.props.onClick === "function",
    )!;

  test("each state is explained and only available or request may be accepted", async () => {
    const root = await render(<McpConsent />);
    const copy = mcpCopy.en;
    await choose(root, "available");
    expect(text(accept(root))).toBe(copy.allowClient);
    for (const [workspace, explanation] of [
      ["pending", copy.statePending],
      ["rejected", copy.stateRejected],
      ["off", copy.stateOff],
    ] as const) {
      await choose(root, workspace);
      expect(text(root)).toContain(explanation);
      expect(accept(root).props.disabled).toBe(true);
    }
    await choose(root, "request");
    expect(text(root)).toContain(copy.stateRequest);
    expect(text(accept(root))).toBe(copy.requestAccess);
  });

  test.each([
    ["mcp_app_pending", "requestSent", "statePending"],
    ["mcp_app_rejected", "stateRejected", "stateRejected"],
    ["mcp_external_apps_off", "stateOff", "stateOff"],
  ] as const)(
    "a refusal with %s explains it and blocks the workspace",
    async (code, error, state) => {
      const root = await render(<McpConsent />);
      const copy = mcpCopy.en;
      await choose(root, "request");
      await act(async () =>
        first(root, "Checkbox").props.onCheckedChange(true),
      );
      mockAuthApi.mockRejectedValueOnce(new ApiError(403, code));
      await act(async () => accept(root).props.onClick());
      await settle();
      expect(mockAuthApi).toHaveBeenLastCalledWith(
        "mcp/oauth/consent",
        {
          oauth_query: "TEST-signed-query",
          accept: true,
          workspaceId: "TEST-ws-request",
          scopes: ["data.read"],
        },
        expect.anything(),
      );
      expect(text(root)).toContain(copy[error]);
      expect(text(root)).toContain(copy[state]);
      expect(accept(root).props.disabled).toBe(true);
    },
  );

  test("Czech", async () => {
    mockLanguage = "cs";
    const root = await render(<McpConsent />);
    await choose(root, "pending");
    expect(text(root)).toContain(
      "Tato aplikace v tomto prostoru čeká na schválení správcem.",
    );
    await choose(root, "request");
    expect(text(accept(root))).toBe("Požádat o přístup");
  });
});
