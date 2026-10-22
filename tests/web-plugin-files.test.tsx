import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PLUGIN_FILES_PROFILE,
  type PluginFiles,
} from "../packages/protocol/workspace-plugins";
import { PluginFilesPage } from "../apps/server-admin/web/plugin-files-page";

const mockApi = jest.fn();
jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
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
  useAdmin: () => ({ language: "en", data: {} }),
}));
jest.mock("../apps/server-admin/web/console-scope", () => ({
  useConsoleScope: () => ({
    organization: { id: "org_TEST", name: "TEST", role: mockRole },
    identity: { isPending: false, error: null },
  }),
}));
const mockNavigate = jest.fn();
jest.mock("@tanstack/react-router", () => ({
  useParams: () => ({ pluginId: "datetime" }),
  useNavigate: () => mockNavigate,
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
const host = (overrides?: Record<string, unknown>) =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule(overrides);
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/textarea", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/ui/tabs", () => host(), { virtual: true });
jest.mock("@admin/components/ui/dropdown-menu", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/sheet", () => host(), { virtual: true });
jest.mock(
  "@admin/components/console/page",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      PageHeader: ({ title, meta, actions }: Record<string, React.ReactNode>) =>
        React.createElement(
          "header",
          { "data-host": "PageHeader" },
          title,
          meta,
          actions,
        ),
    };
  },
  { virtual: true },
);
jest.mock("@admin/components/console/entity-icon", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/status", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const hosts = (root: ReactTestInstance, name: string) =>
  root.findAll((node) => node.props["data-host"] === name);
const flush = async () => {
  for (let i = 0; i < 10; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
};
const files = {
  "plugin.json": '{ "id": "datetime" }\n',
  "index.ts": "export default (sdk) => sdk.definePlugin({ tools: [] });\n",
};
const view = (patch: Partial<PluginFiles> = {}): PluginFiles => ({
  profile: PLUGIN_FILES_PROFILE,
  organizationId: "org_TEST",
  pluginId: "datetime",
  source: "built-in",
  builtIn: true,
  readOnly: false,
  directory: "/app/plugins/datetime",
  files,
  problem: null,
  ...patch,
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
        <PluginFilesPage />
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
const editor = (root: ReactTestInstance, name: string) =>
  root.find(
    (node) => node.type === "textarea" && node.props["aria-label"] === name,
  );
const submit = (root: ReactTestInstance) =>
  act(async () =>
    root
      .find((node) => node.type === "form")
      .props.onSubmit({ preventDefault() {} }),
  );
afterEach(() => {
  for (const entry of mounted.splice(0)) act(() => entry.unmount());
  mockApi.mockReset();
  mockNavigate.mockReset();
  mockRole = "owner";
});

test("only an owner opens a plugin's files", async () => {
  mockRole = "admin";
  const root = await render();
  expect(mockApi).not.toHaveBeenCalled();
  expect(root.findAll((node) => node.type === "textarea")).toHaveLength(0);
  expect(text(root)).toContain("no longer have permission");
});

test("the owner edits index.ts, sees why it was refused, then saves", async () => {
  const edited = { ...files, "index.ts": "export default 1;\n" };
  let saved = false;
  mockApi.mockImplementation(async (path: string, body?: unknown) => {
    if (!body) return view();
    const action = (body as { action: string }).action;
    if (action === "save" && !saved) {
      saved = true;
      return {
        profile: PLUGIN_FILES_PROFILE,
        outcome: "invalid",
        rejected: "index.ts must default-export a function",
        current: view(),
      };
    }
    return {
      profile: PLUGIN_FILES_PROFILE,
      outcome: action === "check" ? "valid" : "saved",
      rejected: null,
      current: view({ source: "override", files: edited }),
    };
  });
  const root = await render();
  expect(mockApi).toHaveBeenCalledWith(
    "identity/plugin-files?organizationId=org_TEST&pluginId=datetime",
    undefined,
    expect.anything(),
  );
  expect(editor(root, "index.ts").props.value).toBe(files["index.ts"]);
  expect(editor(root, "plugin.json").props.value).toBe(files["plugin.json"]);
  expect(text(root)).toContain("Saving runs this code in the server process");
  expect(hosts(root, "SaveBar")).toHaveLength(0);
  // A built-in has nothing to reset.
  expect(hosts(root, "MoreActions")).toHaveLength(0);

  await act(async () =>
    editor(root, "index.ts").props.onChange({
      target: { value: edited["index.ts"] },
    }),
  );
  expect(hosts(root, "SaveBar")).toHaveLength(1);
  await submit(root);
  await flush();
  expect(mockApi).toHaveBeenLastCalledWith(
    "identity/plugin-files",
    {
      organizationId: "org_TEST",
      pluginId: "datetime",
      action: "save",
      files: edited,
    },
    expect.anything(),
  );
  expect(text(root)).toContain("Not saved");
  expect(text(root)).toContain("index.ts must default-export a function");
  expect(editor(root, "index.ts").props.value).toBe(edited["index.ts"]);

  const check = root.find(
    (node) => node.type === "button" && text(node) === "Check",
  );
  await act(async () => check.props.onClick());
  await flush();
  expect(text(root)).toContain("The plugin loads.");

  await submit(root);
  await flush();
  expect(hosts(root, "SaveBar")).toHaveLength(0);
  expect(editor(root, "index.ts").props.value).toBe(edited["index.ts"]);
  expect(text(root)).toContain("Edited");
  // The saved override can go back to the built-in.
  expect(hosts(root, "MoreActions")).toHaveLength(1);
  const confirm = hosts(root, "ConfirmAction")[0]!;
  expect(confirm.props.title).toBe("Reset to built-in");
  mockApi.mockResolvedValueOnce({
    profile: PLUGIN_FILES_PROFILE,
    outcome: "reset",
    rejected: null,
    current: view(),
  });
  await act(async () => confirm.props.onConfirm());
  await flush();
  expect(mockApi).toHaveBeenLastCalledWith(
    "identity/plugin-files",
    { organizationId: "org_TEST", pluginId: "datetime", action: "reset" },
    expect.anything(),
  );
  expect(text(root)).toContain("Built-in");
});

test("with editing turned off the files are read-only", async () => {
  mockApi.mockResolvedValue(
    view({ readOnly: true, source: "operator", builtIn: false }),
  );
  const root = await render();
  expect(text(root)).toContain("Plugin editing is turned off on this server.");
  expect(editor(root, "index.ts").props.readOnly).toBe(true);
  expect(hosts(root, "MoreActions")).toHaveLength(0);
  await submit(root);
  expect(mockApi).toHaveBeenCalledTimes(1);
});

test("a plugin whose files did not load shows why", async () => {
  mockApi.mockResolvedValue(
    view({
      source: null,
      builtIn: false,
      problem: "index.ts does not load: Expected }",
    }),
  );
  const root = await render();
  expect(text(root)).toContain("Did not load");
  expect(text(root)).toContain("index.ts does not load: Expected }");
  const confirm = hosts(root, "ConfirmAction")[0]!;
  expect(confirm.props.title).toBe("Delete plugin");
  mockApi.mockResolvedValueOnce({
    profile: PLUGIN_FILES_PROFILE,
    outcome: "deleted",
    rejected: null,
    current: null,
  });
  await act(async () => confirm.props.onConfirm());
  await flush();
  expect(mockNavigate).toHaveBeenCalledWith({ to: "/plugins" });
});
