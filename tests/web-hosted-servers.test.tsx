import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HostedDefinition } from "../packages/protocol/hosted";
import { HostedPage } from "../apps/server-admin/web/hosted-page";

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
const mockDownload = jest.fn();
jest.mock("../apps/server-admin/web/lib/download", () => ({
  downloadFile: (...args: unknown[]) => mockDownload(...args),
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
  }),
}));
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
jest.mock("@admin/components/console/page", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/status", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/forms", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/entity-icon", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/disclosure", () => host(), {
  virtual: true,
});

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const byHost = (root: ReactTestInstance, name: string, label?: string) =>
  root.findAll(
    (node) =>
      node.props["data-host"] === name &&
      (label === undefined || text(node) === label),
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
  env: { MS365_MCP_BODY_FORMAT: "html" },
  secrets: [],
  memoryMb: 512,
  path: "/mcp",
};
const own: HostedDefinition = {
  version: 1,
  name: "TEST tracker",
  source: { npm: "@example/tracker-mcp", version: "2.0.1" },
  args: ["--port", "{port}"],
  env: { REGION: "eu" },
  secrets: ["TRACKER_TOKEN"],
  memoryMb: 256,
  path: "/mcp",
};
const list = (
  servers: unknown[] = [],
  sandbox: "docker" | "process" = "docker",
) => ({
  organizationId: "org_TEST",
  canManage: true,
  allowCustom: true,
  sandbox,
  builtins: [{ id: "microsoft-365", definition: microsoft }],
  servers,
});
const server = {
  id: `hs_${"a".repeat(24)}`,
  definition: own,
  secretsSet: ["TRACKER_TOKEN"],
  enabled: true,
  status: "running",
  url: "http://127.0.0.1:39100/mcp",
  revision: 2,
  restarts: 0,
};
const mounted: { unmount(): void }[] = [];
async function render(response: ReturnType<typeof list>) {
  mockApi.mockImplementation(async (path: string) =>
    path === "identity/hosted/list" ? response : { ok: true },
  );
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
const commands = () =>
  mockApi.mock.calls
    .filter(([path]) => path === "identity/hosted/command")
    .map(([, body]) => body);
const submit = async (root: ReactTestInstance) => {
  await act(async () =>
    root.findByType("form").props.onSubmit({ preventDefault() {} }),
  );
  await flush();
};
afterEach(() => {
  for (const entry of mounted.splice(0)) act(() => entry.unmount());
  mockApi.mockReset();
  mockDownload.mockReset();
});

test("Add server offers the built-in definitions and Custom; a built-in is added as itself", async () => {
  const root = await render(list());
  const items = byHost(root, "DropdownMenuItem").map(text);
  expect(items).toEqual(["Microsoft 365", "Custom"]);
  await act(async () =>
    byHost(root, "DropdownMenuItem", "Microsoft 365")[0]!.props.onSelect(),
  );
  const [shown] = byHost(root, "DetailList");
  expect(
    shown!.props.items.map(
      (item: { value: React.ReactElement<{ children: string }> }) =>
        item.value.props.children,
    ),
  ).toEqual(["@softeria/ms-365-mcp-server@0.156.2", "--http 0.0.0.0:{port}"]);
  await submit(root);
  expect(commands()).toEqual([
    {
      organizationId: "org_TEST",
      type: "create",
      builtin: "microsoft-365",
      secrets: {},
    },
  ]);
});

test("a custom server from the form becomes a validated definition with its secret values", async () => {
  const root = await render(list());
  await act(async () =>
    byHost(root, "DropdownMenuItem", "Custom")[0]!.props.onSelect(),
  );
  const input = (id: string) =>
    root.find((node) => node.props.id === id && node.type !== "label");
  for (const [id, value] of [
    ["custom-name", "TEST tracker"],
    ["custom-package", "@example/tracker-mcp"],
    ["custom-version", "^2.0.1"],
  ] as const)
    await act(async () => input(id).props.onChange({ target: { value } }));
  await act(async () =>
    byHost(root, "Button", "Add variable")[0]!.props.onClick(),
  );
  const [nameField, valueField] = root.findAll(
    (node) =>
      node.type === "input" &&
      ["Name", "Value"].includes(node.props["aria-label"]),
  );
  await act(async () =>
    nameField!.props.onChange({ target: { value: "tracker_token" } }),
  );
  await act(async () =>
    valueField!.props.onChange({ target: { value: "TEST-token-value" } }),
  );
  // A range is not an exact version: nothing is sent.
  await submit(root);
  expect(commands()).toEqual([]);
  expect(text(root)).toContain("Check the definition: source");
  await act(async () =>
    input("custom-version").props.onChange({ target: { value: "2.0.1" } }),
  );
  await submit(root);
  expect(commands()).toEqual([
    {
      organizationId: "org_TEST",
      type: "createCustom",
      definition: {
        version: 1,
        name: "TEST tracker",
        source: { npm: "@example/tracker-mcp", version: "2.0.1" },
        args: ["--port", "{port}"],
        env: {},
        secrets: ["TRACKER_TOKEN"],
        memoryMb: 512,
        path: "/mcp",
      },
      secrets: { TRACKER_TOKEN: "TEST-token-value" },
    },
  ]);
});

test("an uploaded definition asks for its secrets; images need Docker without it", async () => {
  const root = await render(list([], "process"));
  expect(byHost(root, "PageHeader")[0]!.props.description).toContain(
    "Without Docker",
  );
  await act(async () =>
    byHost(root, "DropdownMenuItem", "Custom")[0]!.props.onSelect(),
  );
  const upload = root.find(
    (node) => node.type === "input" && node.props.type === "file",
  );
  const pick = (content: string) =>
    act(async () =>
      upload.props.onChange({
        target: {
          files: [{ size: content.length, text: async () => content }],
        },
      }),
    );
  await pick("not json");
  await flush();
  await submit(root);
  expect(text(root)).toContain("Not a definition file.");
  const image = {
    ...own,
    source: { image: `example/tracker@sha256:${"a".repeat(64)}`, port: 8080 },
    args: [],
  };
  await pick(JSON.stringify(image));
  await flush();
  await submit(root);
  expect(text(root)).toContain("Images need Docker");
  expect(commands()).toEqual([]);
  await pick(JSON.stringify({ ...own, memoryMb: undefined }));
  await flush();
  const secret = root.find(
    (node) =>
      node.type === "input" && node.props.id === "hosted-secret-TRACKER_TOKEN",
  );
  await act(async () =>
    secret.props.onChange({ target: { value: "TEST-uploaded-secret" } }),
  );
  await submit(root);
  expect(commands()).toEqual([
    {
      organizationId: "org_TEST",
      type: "createCustom",
      definition: { ...own, memoryMb: 512 },
      secrets: { TRACKER_TOKEN: "TEST-uploaded-secret" },
    },
  ]);
});

test("a server exports its definition without secret values and takes new ones", async () => {
  const root = await render(list([server]));
  expect(text(root)).toContain("@example/tracker-mcp@2.0.1");
  await act(async () =>
    byHost(root, "DropdownMenuItem", "Export")[0]!.props.onSelect(),
  );
  expect(mockDownload).toHaveBeenCalledTimes(1);
  const [name, body] = mockDownload.mock.calls[0]!;
  expect(name).toBe("test-tracker.mcp.json");
  expect(JSON.parse(body)).toEqual(own);
  await act(async () =>
    byHost(root, "DropdownMenuItem", "Secrets")[0]!.props.onSelect(),
  );
  const field = root.find(
    (node) =>
      node.type === "input" && node.props.id === "hosted-secret-TRACKER_TOKEN",
  );
  expect(field.props.placeholder).toBe("Stored, leave empty to keep");
  await act(async () =>
    field.props.onChange({ target: { value: "TEST-rotated" } }),
  );
  await submit(root);
  expect(commands()).toEqual([
    {
      organizationId: "org_TEST",
      type: "secrets",
      id: server.id,
      revision: 2,
      secrets: { TRACKER_TOKEN: "TEST-rotated" },
    },
  ]);
});
