import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { PublicPhonePairing } from "../apps/server-admin/web/public-phone-pairing";

const host = () =>
  jest
    .requireActual<typeof import("./helpers/web-hosts")>("./helpers/web-hosts")
    .hostModule();
jest.mock("@admin/components/ui/button", () => host(), { virtual: true });
jest.mock("@admin/components/ui/alert", () => host(), { virtual: true });
jest.mock("@admin/components/console/auth-layout", () => host(), {
  virtual: true,
});

const code = "0123456789abcdef0123456789abcdef";
function page(hash: string) {
  const location = {
    origin: "https://niaro.example",
    host: "niaro.example",
    pathname: "/account/phone",
    search: "",
    hash,
  };
  const replaceState = jest.fn(() => {
    location.hash = "";
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = ["location", "history", "document"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globals, key)] as const,
  );
  for (const [key, value] of Object.entries({
    location,
    history: { replaceState },
    document: { documentElement: {} },
  }))
    Object.defineProperty(globals, key, { value, configurable: true });
  (globals.window as Record<string, unknown>) ??= globals;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<PublicPhonePairing language="en" />);
  });
  const links = renderer.root
    .findAll((node) => node.type === "a" && typeof node.props.href === "string")
    .map((node) => node.props.href as string);
  act(() => renderer.unmount());
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globals, key, descriptor);
    else delete globals[key];
  return { links, replaceState, location };
}

test("a scanned code opens the app for this server only, and leaves the address bar", () => {
  const { links, replaceState, location } = page(`#w=ws_1&c=${code}`);
  expect(links).toEqual([
    `niaro://pair?address=${encodeURIComponent("https://niaro.example/v1/ws_1")}&code=${code}`,
  ]);
  expect(replaceState).toHaveBeenCalledTimes(1);
  expect(location.hash).toBe("");
});

test("an incomplete link offers nothing to open", () => {
  expect(page("#w=ws_1&c=short").links).toEqual([]);
});
