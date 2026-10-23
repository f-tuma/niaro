import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Service } from "../packages/protocol/service-catalog";
import {
  ServiceChecklist,
  setupSteps,
  type ChecklistInput,
  type SetupStep,
} from "../apps/server-admin/web/service-checklist";
import { setupEn } from "../apps/server-admin/web/service-setup-copy";

const mockApi = jest.fn();
let mockHosted: unknown = undefined;
jest.mock("../apps/server-admin/web/lib/api", () => {
  class ApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, code?: string) {
      super(String(status));
      this.status = status;
      this.code = code;
    }
  }
  return { api: (...args: unknown[]) => mockApi(...args), ApiError };
});
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => ({
    language: "en",
    data: { authentication: { principalId: "usr_TEST" } },
  }),
}));
jest.mock("../apps/server-admin/web/hosted-page", () => ({
  useHostedServers: () => ({ data: mockHosted }),
}));
jest.mock("../apps/server-admin/web/catalog-shared", () => ({
  catalogIssue: () => "TEST issue",
}));
jest.mock("../apps/server-admin/web/service-auth", () => ({
  oauthIssue: (error: { code?: string }) => `TEST refused ${error.code}`,
  useServiceAuthCopy: () => ({}),
}));
jest.mock("../apps/server-admin/web/copy-link", () => host());
jest.mock("@tanstack/react-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Link: ({ children, to }: { children: React.ReactNode; to: string }) =>
      React.createElement("a", { href: to }, children),
  };
});
const host = (overrides?: Record<string, unknown>) =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule(overrides);
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/item", () => host(), { virtual: true });
jest.mock("@admin/components/console/page", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/status", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/entity-icon", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/disclosure", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/forms", () => host(), {
  virtual: true,
});

const target = { organizationId: "org_TEST", workspaceId: "wsp_TEST" };
const action = (
  id: string,
  effect: "read" | "write",
  enabled = true,
): Service["actions"][number] => ({
  id,
  revision: 1,
  sourceKey: `mcp:${id}`,
  name: `TEST ${id}`,
  description: "",
  inputSchema: { type: "object", properties: {} },
  binding: { type: "mcp", name: id },
  effect,
  approval: "always",
  enabled,
  policy: { roles: [], users: [] },
});
const service = (actions: Service["actions"] = []): Service => ({
  id: "svc_TEST",
  revision: 3,
  name: "TEST Microsoft 365",
  url: "http://127.0.0.1:39100/mcp",
  protocol: "mcp",
  icon: "mail",
  iconSource: "custom",
  auth: { type: "none" },
  enabled: true,
  hasCredential: false,
  modelId: null,
  actions,
});
const provider = {
  id: "ap_00000000000000000000000000000001",
  organizationId: "org_TEST",
  kind: "microsoft" as const,
  name: "TEST Contoso",
  enabled: true,
  revision: 1,
  clientId: "TEST",
  hasClientSecret: true,
  tenantId: null,
  hostedDomain: null,
  callbackURL: "https://niaro.test/admin/auth/callback/ap_1",
};
const oauth = (
  settings: Record<string, unknown> = { requiredFor: "none" },
  status: "connected" | "disconnected" | "expired" = "disconnected",
) =>
  ({
    config: {
      revision: 2,
      settings,
      hasClientId: false,
      hasClientSecret: false,
      discovery: null,
      lastProbe: null,
    },
    connection: {
      status,
      revision: 1,
      identity: status === "connected" ? { subject: "s", label: "Jana" } : null,
      expiresAt: null,
    },
    redirectUri: "https://niaro.test/admin/service-connect",
  }) as ChecklistInput["oauth"];
const signIn = {
  provider: "microsoft" as const,
  requiredFor: "all" as const,
  scopes: ["Calendars.ReadWrite", "Mail.ReadWrite"],
};
const idleJob = {
  running: false,
  enrich: false,
  selection: false,
  progress: null,
  result: null,
  readOnly: [],
  choices: null,
  continuation: null,
  error: null,
};
const input = (over: Partial<ChecklistInput> = {}): ChecklistInput => ({
  service: service(),
  probe: { status: "ok" },
  oauth: oauth(),
  providers: [],
  job: idleJob,
  who: "Everyone",
  test: { status: "idle" },
  jobIssue: "",
  ...over,
});
const byId = (steps: SetupStep[]) =>
  Object.fromEntries(steps.map((step) => [step.id, step])) as Record<
    SetupStep["id"],
    SetupStep
  >;

test("a fresh hosted Microsoft 365 service says what is missing, step by step", () => {
  const steps = byId(setupSteps(input({ signIn }), setupEn));
  expect(steps.address).toMatchObject({ state: "done", reason: "Answers" });
  expect(steps.signIn).toMatchObject({
    state: "action",
    reason: "Needs a Microsoft sign-in method",
    fix: { kind: "providers" },
  });
  expect(steps.actions).toMatchObject({
    state: "action",
    fix: { kind: "discover" },
  });
  expect(steps.access).toMatchObject({ state: "waiting" });
  expect(steps.test).toMatchObject({
    state: "waiting",
    reason: "Needs a read action without inputs",
  });
  // Personal sign-in is not on yet, so there is no account step.
  expect(steps.connected).toBeUndefined();
  // With a Microsoft method the fix is to use it.
  const ready = byId(
    setupSteps(input({ signIn, providers: [provider] }), setupEn),
  );
  expect(ready.signIn).toMatchObject({
    state: "action",
    fix: { kind: "applySignIn", label: "Use TEST Contoso" },
  });
});

test("personal sign-in through a method, connection and overview reads", () => {
  const personal = oauth({
    requiredFor: "all",
    source: "provider",
    authProviderId: provider.id,
  });
  const writes = [action("list-mail", "write"), action("send-mail", "write")];
  let steps = byId(
    setupSteps(
      input({
        oauth: personal,
        providers: [provider],
        service: service(writes),
      }),
      setupEn,
    ),
  );
  expect(steps.signIn).toMatchObject({
    state: "done",
    reason: "Each person's own account, through TEST Contoso",
  });
  expect(steps.access).toMatchObject({
    state: "action",
    reason: "2 on, none readable by overview widgets",
    fix: { kind: "findReads" },
  });
  expect(steps.connected).toMatchObject({
    state: "action",
    reason: "Not connected",
    fix: { kind: "connect" },
  });
  // The server labelled one read-only: the fix marks it.
  steps = byId(
    setupSteps(
      input({
        oauth: personal,
        providers: [provider],
        service: service(writes),
        job: { ...idleJob, readOnly: ["list-mail"] },
      }),
      setupEn,
    ),
  );
  expect(steps.access.fix).toMatchObject({ kind: "markReads" });
  // A read under a person's own account needs no approval for widgets.
  steps = byId(
    setupSteps(
      input({
        oauth: oauth(
          {
            requiredFor: "all",
            source: "provider",
            authProviderId: provider.id,
          },
          "connected",
        ),
        providers: [provider],
        service: service([action("list-mail", "read"), writes[1]!]),
      }),
      setupEn,
    ),
  );
  expect(steps.access).toMatchObject({
    state: "done",
    reason: "2 on, 1 readable by overview widgets; Everyone",
  });
  expect(steps.connected).toMatchObject({
    state: "done",
    reason: "Connected as Jana",
  });
  expect(steps.test).toMatchObject({
    state: "waiting",
    reason: "Runs TEST list-mail",
    fix: { kind: "test" },
  });
  // A method that was turned off.
  steps = byId(
    setupSteps(
      input({ oauth: personal, providers: [{ ...provider, enabled: false }] }),
      setupEn,
    ),
  );
  expect(steps.signIn).toMatchObject({
    state: "action",
    reason: "The sign-in method TEST Contoso is off",
  });
  expect(steps.connected).toMatchObject({ state: "waiting" });
});

test("a sign-in without the definition's permissions, Twenty's reads and reads nobody may use", () => {
  // The service's sign-in uses the method but asks only for the sign-in.
  let steps = byId(
    setupSteps(
      input({
        signIn,
        oauth: oauth({
          requiredFor: "all",
          source: "provider",
          authProviderId: provider.id,
          scopes: ["Calendars.ReadWrite"],
        }),
        providers: [provider],
      }),
      setupEn,
    ),
  );
  expect(steps.signIn).toMatchObject({
    state: "action",
    reason:
      "The sign-in doesn't ask for Mail.ReadWrite, so the service will refuse access",
    fix: { kind: "addScopes" },
  });
  // Twenty's record reads arrive as switched-off writes: one fix turns them on.
  const twenty = (name: string): Service["actions"][number] => ({
    ...action(name, "write", false),
    binding: { type: "mcp", name: "execute_tool", catalogTool: name },
  });
  steps = byId(
    setupSteps(
      input({
        service: service([
          twenty("find_many_people"),
          twenty("group_by_notes"),
          twenty("delete_one_person"),
        ]),
      }),
      setupEn,
    ),
  );
  expect(steps.access).toMatchObject({
    state: "action",
    reason: "No action is on",
    fix: { kind: "markReads", label: "Turn on reads (2)" },
  });
  // Reads that are on but granted to nobody reach neither the agent nor widgets.
  const read = { ...action("list", "read"), approval: "never" as const };
  steps = byId(setupSteps(input({ service: service([read]) }), setupEn));
  expect(steps.access).toMatchObject({
    state: "action",
    reason: "Reads on: 1, but nobody may use them",
    fix: { kind: "actionsTab" },
  });
  steps = byId(
    setupSteps(
      input({
        service: service([
          { ...read, policy: { roles: ["member"], users: [] } },
        ]),
      }),
      setupEn,
    ),
  );
  expect(steps.access).toMatchObject({ state: "done" });
});

test("address failures, a missing key and discovery progress", () => {
  let steps = byId(setupSteps(input({ probe: null }), setupEn));
  expect(steps.address.state).toBe("running");
  steps = byId(
    setupSteps(
      input({
        probe: { status: "failed", error: "integration_origin_denied" },
      }),
      setupEn,
    ),
  );
  expect(steps.address).toMatchObject({
    state: "failed",
    fix: { kind: "settings" },
  });
  steps = byId(
    setupSteps(
      input({ probe: { status: "failed", error: "integration_timeout" } }),
      setupEn,
    ),
  );
  expect(steps.address).toMatchObject({
    state: "failed",
    reason: "No answer (integration_timeout)",
    fix: { kind: "editConnection" },
  });
  steps = byId(
    setupSteps(
      input({
        service: { ...service(), auth: { type: "bearer" } },
        probe: { status: "failed", error: "catalog_key_required" },
      }),
      setupEn,
    ),
  );
  expect(steps.signIn).toMatchObject({
    state: "action",
    reason: "The shared key is missing",
    fix: { kind: "editConnection" },
  });
  steps = byId(
    setupSteps(
      input({
        job: {
          ...idleJob,
          running: true,
          enrich: true,
          progress: { done: 5, total: 12 },
        },
      }),
      setupEn,
    ),
  );
  expect(steps.actions).toMatchObject({
    state: "running",
    reason: "Describing actions: 5 of 12",
  });
  steps = byId(
    setupSteps(
      input({
        job: {
          ...idleJob,
          error: new Error("TEST"),
          continuation: { toolNames: ["x"], revision: 4, policyRevision: 0 },
        },
        jobIssue: "TEST issue",
      }),
      setupEn,
    ),
  );
  expect(steps.actions).toMatchObject({
    state: "failed",
    reason: "TEST issue",
    fix: { kind: "continue" },
  });
});

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
async function render(svc: Service) {
  // No garbage-collection timers: the test run exits when it is done.
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  const state = {
    target,
    busy: false,
    copy: {},
    mutate: jest.fn(),
  } as unknown as Parameters<typeof ServiceChecklist>[0]["state"];
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <ServiceChecklist
          state={state}
          service={svc}
          who="Everyone"
          onEditConnection={jest.fn()}
          onDiscover={jest.fn()}
          onTab={jest.fn()}
        />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    root: renderer.root,
    unmount: () => {
      renderer.unmount();
      client.clear();
    },
  };
}
const button = (root: ReactTestInstance, label: string) =>
  root.find(
    (node) =>
      node.props["data-host"] === "Button" && text(node).includes(label),
  );

test("the checklist uses the hosted definition's sign-in and runs a test read", async () => {
  mockHosted = {
    builtins: [],
    servers: [
      {
        id: "hs_000000000000000000000000",
        url: "http://127.0.0.1:39100/mcp",
        definition: {
          name: "Microsoft 365",
          onboarding: { signIn },
        },
      },
    ],
  };
  const calls: [string, Record<string, unknown>][] = [];
  mockApi.mockImplementation(
    async (path: string, body: Record<string, unknown>) => {
      calls.push([path, body]);
      if (path === "identity/catalog/probe") return { status: "ok" };
      if (path === "identity/catalog/oauth/status") return oauth();
      if (path === "identity/auth-providers/list")
        return {
          organizationId: "org_TEST",
          canManage: true,
          providers: [provider],
        };
      if (path === "identity/catalog/oauth/save") return { ok: true };
      if (path === "identity/catalog/invoke")
        return { status: "succeeded", result: { value: ["TEST mail"] } };
      throw new Error(path);
    },
  );
  const { root, unmount } = await render(
    service([action("list-mail", "read")]),
  );
  try {
    expect(text(root)).toContain("Needs each person's Microsoft account");
    await act(async () => {
      button(root, "Use TEST Contoso").props.onClick();
    });
    const save = calls.find(([path]) => path === "identity/catalog/oauth/save");
    expect(save?.[1]).toMatchObject({
      ...target,
      serviceId: "svc_TEST",
      revision: 2,
      settings: {
        requiredFor: "all",
        source: "provider",
        authProviderId: provider.id,
        scopes: ["Calendars.ReadWrite", "Mail.ReadWrite"],
      },
    });
    await act(async () => {
      button(root, "Test").props.onClick();
    });
    const invoke = calls.find(([path]) => path === "identity/catalog/invoke");
    expect(invoke?.[1]).toMatchObject({
      serviceId: "svc_TEST",
      actionId: "list-mail",
      input: {},
      approve: false,
    });
    expect(text(root)).toContain("TEST list-mail answered");
  } finally {
    act(() => unmount());
  }
});

test("without a Microsoft method the checklist shows what to register", async () => {
  mockHosted = {
    builtins: [],
    servers: [
      {
        url: "http://127.0.0.1:39100/mcp",
        definition: { name: "Microsoft 365", onboarding: { signIn } },
      },
    ],
  };
  mockApi.mockImplementation(async (path: string) => {
    if (path === "identity/catalog/probe") return { status: "ok" };
    if (path === "identity/catalog/oauth/status") return oauth();
    if (path === "identity/auth-providers/list")
      return { organizationId: "org_TEST", canManage: true, providers: [] };
    throw new Error(path);
  });
  const { root, unmount } = await render(service());
  try {
    const needs = root.find(
      (node) => node.props["data-provider-needs"] !== undefined,
    );
    const field = needs.find(
      (node) => node.props["data-host"] === "CopyLinkField",
    );
    expect(field.props.value).toBe("https://niaro.test/admin/service-connect");
    const details = needs.find(
      (node) => node.props["data-host"] === "DetailList",
    );
    const items = details.props.items as { label: string; value: unknown }[];
    expect(items[0]).toEqual({
      label: "The method needs",
      value: "Application (client) ID, client secret, directory (tenant) ID",
    });
    expect(
      (items[1]!.value as React.ReactElement<{ children: string }>).props
        .children,
    ).toBe("Calendars.ReadWrite Mail.ReadWrite");
    // The fix links to the sign-in methods.
    expect(
      root.find(
        (node) => node.type === "a" && text(node) === "Add sign-in method",
      ).props.href,
    ).toBe("/auth-providers");
  } finally {
    act(() => unmount());
  }
});
