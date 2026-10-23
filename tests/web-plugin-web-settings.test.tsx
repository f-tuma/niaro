import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { WorkspacePluginsSchema } from "../packages/protocol/workspace-plugins";
import { PluginManifestSchema } from "../packages/plugin-sdk/manifest";
import webManifest from "../plugins/web/plugin.json";
import { PluginSettingsForm } from "../apps/server-admin/web/plugin-settings-form";

const mockApi = jest.fn();
jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
  ApiError: class ApiError extends Error {},
}));
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => ({ language: "en", data: {} }),
}));
jest.mock("../apps/server-admin/web/catalog-shared", () => ({
  catalogIssue: () => "TEST issue",
}));
const host = (overrides?: Record<string, unknown>) =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule(overrides);
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/badge", () => host(), { virtual: true });
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/switch", () => host(), { virtual: true });
jest.mock("@admin/components/ui/select", () => host(), { virtual: true });
jest.mock("@admin/components/console/page", () => host(), { virtual: true });
jest.mock("@admin/components/console/disclosure", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/setting-row", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });

const manifest = PluginManifestSchema.parse(webManifest);
const current = WorkspacePluginsSchema.parse({
  profile: "agent-workspace-plugins/1",
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  revision: 4,
  canManage: true,
  source: "server",
  defaults: { enabled: ["datetime"], timeZone: "UTC" },
  settings: { enabled: ["datetime"], timeZone: "UTC" },
  plugins: [
    {
      id: "web",
      version: manifest.version,
      effect: manifest.effect,
      tools: manifest.tools.map((tool) => tool.name),
      available: true,
      name: manifest.name,
      description: manifest.description,
      source: "built-in",
      toolDetails: manifest.tools,
      settingFields: manifest.settings,
    },
  ],
  problems: [],
  editing: { allowed: false, disabled: false },
});
const hosts = (root: ReactTestInstance, name: string) =>
  root.findAll((node) => node.props["data-host"] === name);

test("the web plugin page shows its settings and saves them for the workspace", async () => {
  mockApi.mockResolvedValue(current);
  const saved = jest.fn(async () => {});
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PluginSettingsForm
        current={current}
        plugin={current.plugins[0]!}
        saved={saved}
        reload={async () => true}
        refreshFailed={false}
      />,
    );
  });
  const root = renderer.root;
  const rows = () => hosts(root, "SettingRow");
  expect(rows().map((row) => row.props.label)).toEqual([
    "Enabled",
    "Search model (model ID from AI models; empty: the chat model)",
    "Search engine",
    "Results per search",
    "Page text (characters)",
    "Zero data retention providers only",
  ]);
  // Off until the workspace turns it on; the details name the network effect.
  const enabled = hosts(rows()[0]!, "Switch")[0]!;
  expect(enabled.props.checked).toBe(false);
  const details = hosts(root, "DetailList")[0]!.props.items as {
    label: string;
    value: unknown;
  }[];
  expect(details.find((item) => item.label === "Calculation")?.value).toBe(
    "Public web, through the server",
  );
  const input = (index: number) =>
    rows()[index]!.findAll((node) => node.type === "input")[0]!;
  expect(input(3).props.max).toBe(8);
  expect(input(4).props.max).toBe(40000);
  await act(async () => {
    enabled.props.onCheckedChange(true);
  });
  await act(async () => {
    input(1).props.onChange({ target: { value: "openai/gpt-4o-mini" } });
  });
  await act(async () => {
    input(3).props.onChange({ target: { value: "3" } });
  });
  await act(async () => {
    root
      .findByType("form")
      .props.onSubmit({ preventDefault: () => {} } as React.FormEvent);
  });
  expect(mockApi).toHaveBeenCalledTimes(1);
  const [path, body] = mockApi.mock.calls[0]!;
  expect(path).toBe("identity/plugins");
  expect(body.revision).toBe(4);
  expect(body.settings.enabled).toEqual(["datetime", "web"]);
  expect(body.settings.settings.web).toEqual({
    searchModel: "openai/gpt-4o-mini",
    engine: "exa",
    results: 3,
    readChars: 12000,
    zeroDataRetention: true,
  });
  expect(saved).toHaveBeenCalled();
});

test("an out-of-range result count is refused before saving", async () => {
  mockApi.mockClear();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PluginSettingsForm
        current={current}
        plugin={current.plugins[0]!}
        saved={async () => {}}
        reload={async () => true}
        refreshFailed={false}
      />,
    );
  });
  const root = renderer.root;
  const row = hosts(root, "SettingRow")[3]!;
  await act(async () => {
    row
      .findAll((node) => node.type === "input")[0]!
      .props.onChange({ target: { value: "9" } });
  });
  await act(async () => {
    root
      .findByType("form")
      .props.onSubmit({ preventDefault: () => {} } as React.FormEvent);
  });
  expect(mockApi).not.toHaveBeenCalled();
  expect(
    hosts(root, "AlertDescription").map((node) => node.children.join("")),
  ).toContain("Check the highlighted values.");
});
