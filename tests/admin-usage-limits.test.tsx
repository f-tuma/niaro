import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  emptyOrganizationPolicy,
  emptyWorkspacePolicy,
  policyView,
} from "../packages/protocol/model-policy";
import type { Catalog } from "../packages/protocol/service-catalog";
import { UsageLimitsPage } from "../apps/server-admin/web/usage-limits-page";

const mockApi = jest.fn();
jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
}));
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => ({
    language: "en",
    data: { authentication: { principalId: "TEST-admin" } },
  }),
}));
let mockWide = false;
jest.mock("../apps/server-admin/web/hooks/use-mobile", () => ({
  useIsExtraWide: () => mockWide,
}));
let mockCatalog: Catalog;
jest.mock("../apps/server-admin/web/catalog-shared", () => ({
  useCatalog: () => ({
    query: { data: mockCatalog },
    target: { organizationId: "TEST-org", workspaceId: "TEST-ws" },
    busy: false,
    error: null,
    mutate: jest.fn(),
    setError: () => {},
  }),
  CatalogBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/card", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/ui/spinner", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input-group", () => host(), { virtual: true });
jest.mock("@admin/components/ui/toggle-group", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/ui/table", () => host(), { virtual: true });
jest.mock("@admin/components/ui/empty", () => host(), { virtual: true });
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });
jest.mock("@admin/components/console/setting-row", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/page", () => host(), { virtual: true });

const provider = {
  id: "TEST-provider",
  revision: 3,
  name: "TEST provider",
  url: "https://llm.example.test/v1",
  enabled: true,
  dailyRequestLimit: 100,
  hasCredential: true,
  requestsToday: 0,
};
const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  revision: 2,
  providerId: provider.id,
  name: "TEST " + id,
  model: "test/" + id,
  enabled: true,
  tools: true,
  audioInput: false,
  audioOutput: false,
  kind: "chat" as const,
  ...extra,
});
function catalog(): Catalog {
  return {
    organizationId: "TEST-org",
    workspaceId: "TEST-ws",
    canManage: true,
    services: [],
    providers: [provider],
    models: [model("chat"), model("off", { enabled: false })],
    policy: policyView(
      {
        organization: { revision: 0, policy: emptyOrganizationPolicy() },
        workspace: { revision: 0, policy: emptyWorkspacePolicy() },
      },
      [],
    ),
  } as unknown as Catalog;
}
const price = (modelId: string, modelRevision: number) => ({
  modelId,
  modelRevision,
  providerRevision: 3,
  maxInputTokens: 4096,
  maxOutputTokens: 1000,
  inputMicrosPerMillion: 1_000_000,
  outputMicrosPerMillion: 2_000_000,
});
const budget = (prices: ReturnType<typeof price>[]) => ({
  organizationId: "TEST-org",
  workspaceId: "TEST-ws",
  revision: 4,
  settings: {
    mode: "observe",
    maxTokens: 100_000,
    maxCostMicros: 1_000_000,
    prices,
  },
});
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const mounted: (() => void)[] = [];
async function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <UsageLimitsPage />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  mounted.push(() => {
    renderer.unmount();
    client.clear();
  });
  return renderer.root;
}
const saveBar = (root: ReactTestInstance) =>
  root.findAll((node) => node.props["data-host"] === "SaveBar");
afterEach(() => {
  for (const unmount of mounted.splice(0)) act(unmount);
  mockApi.mockReset();
  mockWide = false;
});

test("a disabled model's older price is not shown as unsaved changes", async () => {
  mockCatalog = catalog();
  mockApi.mockResolvedValue(budget([price("chat", 2), price("off", 1)]));
  const root = await render();
  expect(saveBar(root)).toHaveLength(0);
  expect(text(root)).not.toContain("confirm");
});

test("a listed model's changed price asks to be confirmed and keeps other prices", async () => {
  mockCatalog = catalog();
  mockApi.mockResolvedValue(budget([price("chat", 1), price("off", 1)]));
  const root = await render();
  expect(saveBar(root)).toHaveLength(0);
  expect(text(root)).toContain(
    "One price was set before its model or provider changed. It is not used until you confirm it.",
  );
  expect(text(root)).toContain("Model or provider changed; check this price.");
  mockApi.mockResolvedValue(budget([price("chat", 2), price("off", 1)]));
  await act(async () => {
    root
      .find((node) => node.type === "button" && text(node) === "Confirm prices")
      .props.onClick();
  });
  expect(mockApi).toHaveBeenCalledWith("identity/catalog/budget", {
    organizationId: "TEST-org",
    workspaceId: "TEST-ws",
    revision: 4,
    settings: expect.objectContaining({
      // Re-pinned to the listed model; the disabled model's price waits.
      prices: [price("chat", 2), price("off", 1)],
    }),
  });
});

test("on a narrow screen each model is a card with all four fields labelled", async () => {
  mockCatalog = catalog();
  mockApi.mockResolvedValue(budget([price("chat", 2)]));
  const root = await render();
  expect(
    root.findAll((node) => node.props["data-host"] === "Table"),
  ).toHaveLength(0);
  const card = root.find(
    (node) => node.type === "li" && text(node).includes("TEST chat"),
  );
  for (const label of [
    "Input ($/1M tok.)",
    "Output ($/1M tok.)",
    "Max request",
    "Max reply",
  ])
    expect(text(card)).toContain(label);
  expect(
    card
      .findAll(
        (node) =>
          typeof node.type === "string" &&
          typeof node.props["aria-label"] === "string",
      )
      .map((node) => node.props["aria-label"]),
  ).toEqual([
    "TEST chat: Input (USD per million tokens)",
    "TEST chat: Output (USD per million tokens)",
    "TEST chat: Max request",
    "TEST chat: Max reply",
  ]);
});

test("on a wide screen the prices are one table with all four columns", async () => {
  mockWide = true;
  mockCatalog = catalog();
  mockApi.mockResolvedValue(budget([price("chat", 2)]));
  const root = await render();
  const heads = root.findAll((node) => node.props["data-host"] === "TableHead");
  expect(heads.map(text)).toEqual([
    "Model",
    "Input ($/1M tok.)",
    "Output ($/1M tok.)",
    "Max request",
    "Max reply",
  ]);
});
