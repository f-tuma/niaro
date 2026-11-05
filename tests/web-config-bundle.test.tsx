import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import {
  CONFIG_BUNDLE_PREVIEW_PROFILE,
  type ConfigBundle,
  type ConfigSectionResult,
} from "../packages/protocol/config-bundle";
import { ConfigBundlePage } from "../apps/server-admin/web/config-bundle-page";

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
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => ({ language: "en" }),
}));
let mockRole = "owner";
jest.mock("../apps/server-admin/web/console-scope", () => ({
  useConsoleScope: () => ({
    organization: { id: "org_TEST", name: "TEST", role: mockRole },
    workspace: { id: "ws_TEST", name: "TEST Workspace" },
  }),
}));
const host = (overrides?: Record<string, unknown>) =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule(overrides);
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock("@admin/components/ui/badge", () => host(), { virtual: true });
jest.mock("@admin/components/ui/spinner", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert-dialog", () => host(), { virtual: true });
jest.mock("@admin/components/ui/dropdown-menu", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/ui/empty", () => host(), { virtual: true });
jest.mock("@admin/components/ui/item", () => host(), { virtual: true });
jest.mock("@admin/components/console/disclosure", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/status", () => host(), {
  virtual: true,
});
jest.mock(
  "@admin/components/console/page",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const slots =
      (name: string) =>
      // eslint-disable-next-line react/display-name -- test stand-in
      ({ title, actions, children }: Record<string, React.ReactNode>) =>
        React.createElement(
          "section",
          { "data-host": name },
          title,
          actions,
          children,
        );
    return { PageHeader: slots("PageHeader"), Section: slots("Section") };
  },
  { virtual: true },
);

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const buttons = (root: ReactTestInstance, label: string) =>
  root.findAll(
    (node) =>
      (node.type === "button" ||
        node.props["data-host"] === "AlertDialogAction") &&
      text(node) === label,
  );
const flush = async () => {
  for (let i = 0; i < 10; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
};
const bundle: ConfigBundle = {
  profile: "niaro-config-bundle",
  version: 1,
  exportedAt: "2026-11-05T10:00:00.000Z",
  source: { server: "TEST Source" },
  organization: { providers: { version: 1, items: [] } },
  workspaces: [{ name: "TEST Workspace", sections: {} }],
};
const result = (
  key: string,
  workspace: string | null,
  value: Partial<ConfigSectionResult>,
): ConfigSectionResult => ({
  key,
  workspace,
  added: [],
  changed: [],
  unchanged: [],
  conflicts: [],
  needsKey: [],
  ...value,
});
const preview = {
  profile: CONFIG_BUNDLE_PREVIEW_PROFILE,
  revision: "a".repeat(64),
  changes: true,
  sections: [
    result("providers", null, {
      added: ["TEST Models"],
      needsKey: ["TEST Models"],
    }),
    result("skills", "TEST Workspace", {
      changed: ["TEST Offer letter"],
      unchanged: ["TEST Notes"],
      conflicts: [{ name: "TEST Other", reason: "reference_missing" }],
    }),
  ],
};
const mounted: TestRenderer.ReactTestRenderer[] = [];
async function render() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ConfigBundlePage />);
  });
  mounted.push(renderer);
  return renderer.root;
}
const choose = async (root: ReactTestInstance, content: string) => {
  const input = root.find(
    (node) => node.type === "input" && node.props.type === "file",
  );
  await act(async () =>
    input.props.onChange({
      target: { files: [{ size: content.length, text: async () => content }] },
    }),
  );
  await flush();
};
afterEach(() => {
  for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
  mockApi.mockReset();
  mockRole = "owner";
});

test("export links download the organization or the selected workspace", async () => {
  const root = await render();
  const links = root.findAll((node) => node.type === "a");
  expect(links.map((link) => [text(link), link.props.href])).toEqual([
    [
      "Whole organization",
      "/admin/api/identity/config-bundle/export?organizationId=org_TEST",
    ],
    [
      "This workspace",
      "/admin/api/identity/config-bundle/export?organizationId=org_TEST&workspaceId=ws_TEST",
    ],
  ]);
  expect(links.every((link) => link.props.download !== undefined)).toBe(true);
});

test("an import is checked first, confirmed, then applied with the preview's revision", async () => {
  mockApi.mockImplementation(async (path: string) =>
    path.endsWith("/import") ? { ...preview, imported: true } : preview,
  );
  const root = await render();
  await choose(root, '{"version":1}');
  expect(text(root)).toContain("Not a configuration file.");
  expect(mockApi).not.toHaveBeenCalled();

  await choose(root, JSON.stringify(bundle));
  expect(mockApi).toHaveBeenCalledWith("identity/config-bundle/preview", {
    organizationId: "org_TEST",
    workspaceId: "ws_TEST",
    bundle,
  });
  const page = text(root);
  expect(page).toContain("Needs a key");
  expect(page).toContain("AI providers");
  expect(page).toContain("Added 1");
  expect(page).toContain("Changed 1");
  expect(page).toContain("Unchanged 1");
  expect(page).toContain("Not imported 1");
  expect(page).toContain("Refers to something missing");
  // Nothing is imported before the confirmation.
  expect(mockApi).toHaveBeenCalledTimes(1);

  await act(async () => buttons(root, "Import")[0]!.props.onClick());
  const confirm = root.find(
    (node) =>
      node.props["data-host"] === "AlertDialogAction" &&
      text(node) === "Import",
  );
  await act(async () => confirm.props.onClick({ preventDefault() {} }));
  await flush();
  expect(mockApi).toHaveBeenLastCalledWith("identity/config-bundle/import", {
    organizationId: "org_TEST",
    workspaceId: "ws_TEST",
    bundle,
    revision: "a".repeat(64),
  });
  expect(text(root)).toContain("Imported");
});

test("a configuration changed meanwhile asks to check the file again", async () => {
  const { ApiError } = jest.requireMock("../apps/server-admin/web/lib/api");
  mockApi.mockImplementation(async (path: string) => {
    if (path.endsWith("/import")) throw new ApiError(409);
    return preview;
  });
  const root = await render();
  await choose(root, JSON.stringify(bundle));
  await act(async () => buttons(root, "Import")[0]!.props.onClick());
  const confirm = root.find(
    (node) =>
      node.props["data-host"] === "AlertDialogAction" &&
      text(node) === "Import",
  );
  await act(async () => confirm.props.onClick({ preventDefault() {} }));
  await flush();
  expect(text(root)).toContain(
    "The configuration changed meanwhile. Check the file again.",
  );
  await act(async () => buttons(root, "Check again")[0]!.props.onClick());
  await flush();
  expect(mockApi).toHaveBeenLastCalledWith(
    "identity/config-bundle/preview",
    expect.objectContaining({ bundle }),
  );
});

test("a member sees no export or import", async () => {
  mockRole = "member";
  const root = await render();
  expect(root.findAll((node) => node.type === "a")).toHaveLength(0);
  expect(
    root.findAll((node) => node.type === "button" && text(node) === "Import"),
  ).toHaveLength(0);
});
