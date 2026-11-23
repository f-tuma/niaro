/**
 * External AI apps in a browser-like DOM with its real components (NIAR-237):
 * the members' section and the workspace section are siblings, so switching
 * the console language must update both in place and never leave a copy.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { McpPage } from "../apps/server-admin/web/mcp-page";

jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: async (path: string) => {
    if (path === "identity/mcp/admin/list") return mockState;
    throw new Error("TEST not served");
  },
  ApiError: class ApiError extends Error {},
}));
let mockLanguage: "en" | "cs" = "en";
jest.mock("../apps/server-admin/web/context", () => ({
  useAdmin: () => ({
    language: mockLanguage,
    authorityGeneration: "TEST-generation",
    data: {
      authentication: { principalId: "TEST-admin", current: "better-auth" },
    },
    setSelectedWorkspace: () => {},
  }),
}));
jest.mock("../apps/server-admin/web/console-scope", () => ({
  useConsoleScope: () => ({
    organization: { id: "TEST-org", name: "TEST org" },
    workspace: { id: "TEST-ws", name: "TEST ws" },
    identity: { isPending: false, error: null },
    detail: {
      isPending: false,
      error: null,
      data: { canManageWorkspaces: true, workspaces: [] },
    },
  }),
}));
jest.mock("@tanstack/react-router", () => ({
  Link: () => null,
  useSearch: () => ({}),
}));
const mockState = {
  profile: "agent-mcp-admin/1",
  policy: "review",
  revision: 1,
  requests: { grants: [], apps: [] },
  access: [],
  apps: [],
};

test("switching the language keeps one members' section", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const client = new QueryClient();
  let root!: Root;
  const render = () =>
    root.render(
      <QueryClientProvider client={client}>
        <McpPage />
      </QueryClientProvider>,
    );
  await act(async () => {
    root = createRoot(host);
    render();
  });
  // The sections render once the members' state is loaded.
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });
  const members = () =>
    [...host.querySelectorAll("h2")]
      .map((h) => h.firstChild?.textContent)
      .filter(
        (title) =>
          title === "Members' AI apps" || title === "AI aplikace členů",
      );
  expect(members()).toEqual(["Members' AI apps"]);
  for (const language of ["cs", "en"] as const) {
    mockLanguage = language;
    await act(async () => render());
  }
  expect(members()).toEqual(["Members' AI apps"]);
  await act(async () => root.unmount());
  client.clear();
});
