import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryViewSchema } from "../packages/protocol/memory";
import { WorkspacePluginsSchema } from "../packages/protocol/workspace-plugins";
import { PluginManifestSchema } from "../packages/plugin-sdk/manifest";
import memoryManifest from "../plugins/memory/plugin.json";
import { MemoryPluginPanel } from "../apps/server-admin/web/memory-panel";

let mockLanguage = "en";
const mockApi = jest.fn();
jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
  ApiError: class ApiError extends Error {},
}));
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => ({
    language: mockLanguage,
    data: { authentication: { principalId: "TEST-owner" } },
  }),
}));
jest.mock("../apps/server-admin/web/catalog-shared", () => ({
  catalogIssue: () => "TEST issue",
}));
const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/textarea", () => host(), { virtual: true });
jest.mock("@admin/components/ui/switch", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/ui/sheet", () => host(), { virtual: true });
jest.mock("@admin/components/ui/toggle-group", () => host(), { virtual: true });
jest.mock("@admin/components/ui/item", () => host(), { virtual: true });
jest.mock("@admin/components/ui/dropdown-menu", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/page", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/empty", () => host(), { virtual: true });
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });
jest.mock("@admin/components/console/status", () => host(), { virtual: true });
jest.mock("@admin/components/console/setting-row", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/time", () => host(), { virtual: true });
jest.mock("@admin/components/ui/tooltip", () => host(), { virtual: true });

const manifest = PluginManifestSchema.parse(memoryManifest);
const current = WorkspacePluginsSchema.parse({
  profile: "agent-workspace-plugins/1",
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  revision: 1,
  canManage: true,
  source: "server",
  defaults: { enabled: ["datetime", "memory"], timeZone: "UTC" },
  settings: { enabled: ["datetime", "memory"], timeZone: "UTC" },
  plugins: [
    {
      id: "memory",
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
const view = MemoryViewSchema.parse({
  profile: "agent-memory/1",
  organizationId: current.organizationId,
  workspaceId: current.workspaceId,
  version: 1,
  enabled: true,
  canManageShared: true,
  optOut: false,
  personalThings: "keep",
  total: 1,
  items: [
    {
      id: "TEST-observed",
      origin: "observed",
      seenAt: "2026-10-30T10:00:00.000Z",
      scope: "private",
      kind: "fact",
      status: "active",
      revision: 1,
      content: "TEST works on Mikulov",
      trust: "model_inference",
      createdAt: "2026-10-30T10:00:00.000Z",
      updatedAt: "2026-10-30T10:00:00.000Z",
      expiresAt: "2027-10-30T10:00:00.000Z",
      supersedesId: null,
      source: {
        type: "observed",
        section: "projects",
        personal: false,
        sources: [
          {
            type: "chat",
            sourceId: "33333333-3333-4333-8333-333333333333",
            messageId: "TEST-message",
            at: "2026-10-30T10:00:00.000Z",
            digest: "a".repeat(64),
            removed: false,
            href: "/chat/TEST-conversation",
          },
        ],
      },
    },
  ],
});

test.each([
  ["en", "Observed", "Model suggestion"],
  ["cs", "Vypozorováno", "Návrh modelu"],
])(
  "existing admin panel parses an observed API record and filters the real row in %s",
  async (language, label, generic) => {
    mockLanguage = language;
    mockApi.mockReset().mockResolvedValue(view);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(
          <QueryClientProvider client={client}>
            <MemoryPluginPanel
              current={current}
              saved={async () => {}}
              reload={async () => true}
              refreshFailed={false}
            />
          </QueryClientProvider>,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(mockApi).toHaveBeenCalled();
      const labels = () =>
        renderer.root
          .findAllByType("span")
          .flatMap((node) =>
            node.children.filter(
              (child): child is string => typeof child === "string",
            ),
          );
      expect(labels()).toContain(label);
      expect(labels()).not.toContain(generic);
      const search = renderer.root.find(
        (node) => node.props["data-host"] === "SearchField",
      );
      await act(async () => search.props.onChange("TEST impossible match"));
      expect(labels()).not.toContain(label);
      await act(async () => search.props.onChange("Mikulov"));
      expect(labels()).toContain(label);
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      client.clear();
    }
  },
);
