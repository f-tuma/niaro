/**
 * The Models page in a browser-like DOM (jsdom) with its real components
 * (NIAR-300): every reference an element makes with aria-controls must name
 * an element on the page, as axe's aria-valid-attr-value checks.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  emptyOrganizationPolicy,
  emptyWorkspacePolicy,
  policyView,
} from "../packages/protocol/model-policy";
import type { Catalog } from "../packages/protocol/service-catalog";
import { ModelPolicyPage } from "../apps/server-admin/web/model-policy-page";
import { TooltipProvider } from "@admin/components/ui/tooltip";

jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: async () => ({
    organizationId: "TEST-org",
    workspaceId: "TEST-ws",
    revision: 1,
    settings: {
      mode: "observe",
      maxTokens: 100_000,
      maxCostMicros: 1_000_000,
      prices: [],
    },
  }),
}));
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => ({
    language: "en",
    data: { authentication: { principalId: "TEST-admin" } },
  }),
}));
jest.mock("@tanstack/react-router", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Link: ({ to, children, ...props }: Record<string, unknown>) =>
      React.createElement(
        "a",
        { ...props, href: to as string },
        children as React.ReactNode,
      ),
  };
});
const mockCatalog = {
  organizationId: "TEST-org",
  workspaceId: "TEST-ws",
  canManage: true,
  voiceAvailable: true,
  legacyVoiceAvailable: false,
  services: [],
  providers: [],
  models: [],
  searchBackends: [],
  policy: policyView(
    {
      organization: { revision: 0, policy: emptyOrganizationPolicy() },
      workspace: { revision: 0, policy: emptyWorkspacePolicy() },
    },
    [],
  ),
} as unknown as Catalog;
jest.mock("../apps/server-admin/web/catalog-shared", () => ({
  useCatalog: () => ({
    query: { data: mockCatalog },
    target: { organizationId: "TEST-org", workspaceId: "TEST-ws" },
    busy: false,
    error: null,
    copy: {},
    mutate: jest.fn(),
    setError: () => {},
  }),
  CatalogBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ModelPolicyPage />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

test("each organization and workspace tab controls a panel on the page", async () => {
  const page = await render();
  const tabs = [...page.querySelectorAll('[role="tab"]')];
  expect(tabs).toHaveLength(2);
  for (const tab of tabs) {
    const id = tab.getAttribute("aria-controls");
    expect(id).toBeTruthy();
    const panel = document.getElementById(id!);
    expect(panel?.getAttribute("role")).toBe("tabpanel");
  }
  const [open, closed] = tabs.map((tab) =>
    document.getElementById(tab.getAttribute("aria-controls")!),
  );
  expect(open!.hidden).toBe(false);
  expect(closed!.hidden).toBe(true);
  for (const element of page.querySelectorAll("[aria-controls]"))
    for (const id of element.getAttribute("aria-controls")!.split(" "))
      expect(document.getElementById(id)).not.toBeNull();
});
