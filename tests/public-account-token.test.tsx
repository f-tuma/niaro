import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { providerRedirect } from "../apps/server-admin/web/lib/provider-redirect";
import { PublicAccount } from "../apps/server-admin/web/public-account";

const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/input", () => host(), { virtual: true });
jest.mock("@admin/components/ui/field", () => host(), { virtual: true });
jest.mock("@admin/components/ui/skeleton", () => host(), { virtual: true });
jest.mock("@admin/components/ui/select", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/ui/spinner", () => host(), { virtual: true });
jest.mock("@admin/components/console/auth-layout", () => host(), {
  virtual: true,
});
jest.mock("@admin/components/console/forms", () => host(), { virtual: true });
jest.mock("../apps/server-admin/web/account-providers", () => ({
  AccountProviderLinks: () => null,
}));
jest.mock("../apps/server-admin/web/provider-sign-in", () => ({
  ProviderSignIn: () => null,
}));
const mockApi = jest.fn(async (..._args: unknown[]) => ({
  email: "person@example.test",
}));
jest.mock("../apps/server-admin/web/lib/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
  authApi: jest.fn(),
  ApiError: class ApiError extends Error {},
}));

test("a reset link's token leaves the address bar once read", async () => {
  const token = "a".repeat(43);
  const location = {
    pathname: "/account/reset",
    search: "",
    hash: `#${token}`,
  };
  const replaceState = jest.fn(
    (_state: unknown, _title: string, url: string) => {
      location.hash = "";
      expect(url).toBe("/account/reset");
    },
  );
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = [
    "location",
    "history",
    "document",
    "navigator",
    "localStorage",
  ].map((key) => [key, Object.getOwnPropertyDescriptor(globals, key)] as const);
  for (const [key, value] of Object.entries({
    location,
    history: { replaceState },
    document: { documentElement: {} },
    navigator: { language: "en" },
    localStorage: { getItem: () => null },
  }))
    Object.defineProperty(globals, key, { value, configurable: true });
  (globals.window as Record<string, unknown>) ??= globals;
  try {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <PublicAccount />
        </QueryClientProvider>,
      );
    });
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe("");
    // The page still uses the token it read.
    expect(mockApi).toHaveBeenCalledWith("identity/account/reset", { token });
    act(() => renderer.unmount());
    client.clear();
  } finally {
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globals, key, descriptor);
      else delete globals[key];
  }
});

test("account links follow only HTTPS (or loopback HTTP) provider addresses", () => {
  expect(providerRedirect("https://id.example.test/authorize?x=1")).toBe(
    "https://id.example.test/authorize?x=1",
  );
  expect(providerRedirect("http://localhost:8080/auth")).toBe(
    "http://localhost:8080/auth",
  );
  for (const bad of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "http://id.example.test/authorize",
    "https://user:pw@id.example.test/",
    "not a url",
  ])
    expect(() => providerRedirect(bad)).toThrow();
});
