import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  SERVER_SETTINGS_PROFILE,
  type ServerSettings,
} from "../packages/protocol/server-settings";
import { Settings } from "../apps/server-admin/web/pages";

const mockApi = jest.fn();
jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
  overviewKey: ["admin", "overview"],
  ApiError: class ApiError extends Error {
    status: number;
    constructor(mockStatus: number) {
      super(String(mockStatus));
      this.status = mockStatus;
    }
  },
}));
let mockRole = "owner";
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => ({
    language: "en",
    data: {
      server: {
        name: "TEST Server",
        startedAt: "2026-10-21T08:00:00.000Z",
        sessionSeconds: 1800,
        workflowProfile: "agent-workflow/1",
      },
      authentication: {
        current: "better-auth",
        expiresAt: "2026-10-22T08:00:00.000Z",
      },
    },
  }),
}));
jest.mock("../apps/server-admin/web/console-scope", () => ({
  useConsoleScope: () => ({
    organization: { id: "org_TEST", name: "TEST", role: mockRole },
  }),
}));
jest.mock("@tanstack/react-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Link: ({ to, children }: { to: string; children: React.ReactNode }) =>
      React.createElement("a", { href: to }, children),
  };
});
const host = (overrides?: Record<string, unknown>) =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule(overrides);
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/textarea", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/ui/spinner", () => host(), { virtual: true });
jest.mock("@admin/components/ui/switch", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert-dialog", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock(
  "@admin/components/console/setting-row",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return host({
      // A row's meta (a range, a state) is shown under its label.
      SettingRow: ({
        label,
        meta,
        children,
      }: Record<string, React.ReactNode>) =>
        React.createElement(
          "div",
          { "data-host": "SettingRow" },
          label,
          meta,
          children,
        ),
    });
  },
  { virtual: true },
);
jest.mock("@admin/components/console/time", () => host(), { virtual: true });
jest.mock(
  "@admin/components/console/forms",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return host({
      // The import confirmation lists its changes as label/value pairs.
      DetailList: ({
        items,
      }: {
        items: { label: string; value: React.ReactNode }[];
      }) =>
        React.createElement(
          "dl",
          { "data-host": "DetailList" },
          items.map((item) =>
            React.createElement(
              "div",
              { key: item.label },
              React.createElement("dt", null, item.label),
              React.createElement("dd", null, item.value),
            ),
          ),
        ),
    });
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/console/page",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const slots =
      (name: string) =>
      // eslint-disable-next-line react/display-name -- test stand-in
      ({
        title,
        description,
        actions,
        children,
      }: Record<string, React.ReactNode>) =>
        React.createElement(
          "section",
          { "data-host": name, title },
          title,
          description,
          actions,
          children,
        );
    return { PageHeader: slots("PageHeader"), Section: slots("Section") };
  },
  { virtual: true },
);

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const button = (root: ReactTestInstance, label: string) => {
  const found = root.findAll(
    (node) => node.type === "button" && text(node) === label,
  );
  if (!found.length) throw new Error(`No button "${label}"`);
  return found[0]!;
};
const flush = async () => {
  for (let i = 0; i < 10; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
};
const settings: ServerSettings = {
  name: "TEST Server",
  timeZone: "Europe/Prague",
  meetings: {
    audioRetentionDays: 30,
    glossary: [],
    chunkSeconds: 300,
    diarization: { enabled: false, url: "http://diarizer:8000" },
  },
  hubScheduler: { intervalSeconds: 300, maxPerTick: 10, idleDays: 14 },
  integrationOrigins: [],
  allowedOrigins: [],
};
const view = (revision: number, value: ServerSettings) => ({
  profile: SERVER_SETTINGS_PROFILE,
  organizationId: "org_TEST",
  revision,
  settings: value,
  defaults: settings,
  restartPending: [],
  operatorOrigins: [] as string[],
});
const mounted: { unmount(): void }[] = [];
async function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Settings />
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
afterEach(() => {
  for (const entry of mounted.splice(0)) act(() => entry.unmount());
  mockApi.mockReset();
  mockRole = "owner";
});

test("a member's console shows the server read-only", async () => {
  mockRole = "member";
  const root = await render();
  expect(mockApi).not.toHaveBeenCalled();
  expect(root.findAll((node) => node.type === "input")).toHaveLength(0);
  expect(text(root)).toContain("TEST Server");
  // Moving the configuration is for owners and administrators.
  expect(root.findAll((node) => node.type === "a")).toHaveLength(0);
});

test("owners reach the configuration export and import from Settings", async () => {
  mockApi.mockImplementation(async () => view(3, settings));
  const root = await render();
  const link = root.find(
    (node) =>
      node.type === "a" && node.props.href === "/settings/configuration",
  );
  expect(link.props.href).toBe("/settings/configuration");
  expect(text(link)).toBe("Configuration");
});

test("settings are grouped with a hint each; export and import live on Configuration only", async () => {
  mockApi.mockImplementation(async () => ({
    ...view(3, settings),
    operatorOrigins: ["http://searxng:8080"],
  }));
  const root = await render();
  expect(mockApi).toHaveBeenCalledWith(
    "identity/server-settings?organizationId=org_TEST",
    undefined,
    expect.anything(),
  );
  const all = text(root);
  for (const heading of [
    "Server",
    "Meetings",
    "Overview refresh",
    "Allowed addresses",
    "Your session",
  ])
    expect(
      root.findAll(
        (node) =>
          node.props["data-host"] === "Section" && node.props.title === heading,
      ),
    ).toHaveLength(1);
  expect(all).toContain("Both lists apply after the server restarts.");
  expect(all).toContain("a local Ollama");
  expect(all).toContain("(CORS)");
  // The operator's origins are trusted too and shown read-only.
  expect(all).toContain("Set by the operator");
  expect(all).toContain("http://searxng:8080");
  expect(all).toContain("NIARO_INTEGRATION_ORIGINS");
  // No second export/import and no copy of the sign-in methods page.
  expect(root.findAll((node) => node.props.type === "file")).toHaveLength(0);
  expect(
    root.findAll(
      (node) =>
        node.type === "button" && ["Export", "Import"].includes(text(node)),
    ),
  ).toHaveLength(0);
  const signIn = root.find(
    (node) => node.type === "a" && node.props.href === "/auth-providers",
  );
  expect(text(signIn)).toBe("Open");
  // The protocol is a quiet line about the server, not a setting.
  expect(all).toContain("About this server");
  expect(all).toContain("agent-workflow/1");
});

test("an edited field is validated and saved with the revision", async () => {
  mockApi.mockImplementation(async (path: string, body?: unknown) =>
    body ? view(4, { ...settings, name: "TEST Renamed" }) : view(3, settings),
  );
  const root = await render();
  const field = root.find(
    (node) =>
      node.type === "input" && node.props.id === "server-meetings-chunkSeconds",
  );
  await act(async () => field.props.onChange({ target: { value: "60" } }));
  expect(
    root.find(
      (node) =>
        node.type === "input" &&
        node.props.id === "server-meetings-chunkSeconds",
    ).props["aria-invalid"],
  ).toBe(true);
  expect(button(root, "Save changes").props.disabled).toBe(true);
  await act(async () => field.props.onChange({ target: { value: "300" } }));
  const name = root.find(
    (node) => node.type === "input" && node.props.id === "server-name",
  );
  await act(async () =>
    name.props.onChange({ target: { value: "TEST Renamed" } }),
  );
  await act(async () => button(root, "Save changes").props.onClick());
  await flush();
  expect(mockApi).toHaveBeenCalledWith("identity/server-settings", {
    organizationId: "org_TEST",
    revision: 3,
    settings: { ...settings, name: "TEST Renamed" },
  });
});

test("diarization: the switch shows the service's state and saves with its address", async () => {
  const on = {
    ...settings,
    meetings: {
      ...settings.meetings,
      diarization: { enabled: true, url: "http://diarizer:8000" },
    },
  };
  mockApi.mockImplementation(async (path: string, body?: unknown) =>
    path.startsWith("identity/server-settings/diarizer")
      ? { reachable: true, ready: true, model: "TEST/model", error: null }
      : body
        ? view(4, settings)
        : view(3, on),
  );
  const root = await render();
  expect(mockApi).toHaveBeenCalledWith(
    "identity/server-settings/diarizer?organizationId=org_TEST",
    undefined,
    expect.anything(),
  );
  expect(text(root)).toContain("Diarizer ready");
  const toggle = root.find(
    (node) =>
      node.props["data-host"] === "Switch" &&
      node.props.id === "server-meetings-diarization-enabled",
  );
  expect(toggle.props.checked).toBe(true);
  await act(async () => toggle.props.onCheckedChange(false));
  await act(async () => button(root, "Save changes").props.onClick());
  await flush();
  expect(mockApi).toHaveBeenLastCalledWith("identity/server-settings", {
    organizationId: "org_TEST",
    revision: 3,
    settings: {
      ...on,
      meetings: {
        ...on.meetings,
        diarization: { enabled: false, url: "http://diarizer:8000" },
      },
    },
  });
});
