import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, mcpLoginRedirect } from "../apps/server-admin/web/lib/api";

const origin = "https://niaro.example.test";
test("MCP signed query survives router normalization without crossing requests", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const location = {
    pathname: "/admin/mcp/consent",
    search: "?state=00042%2Bencoded%20space&sig=first-sig",
  };
  Object.defineProperty(globalThis, "window", {
    value: { location },
    configurable: true,
  });
  try {
    const moduleUrl = new URL(
      "../apps/server-admin/web/lib/mcp-oauth-query.ts",
      import.meta.url,
    );
    moduleUrl.searchParams.set("test", "raw-query");
    const { readMcpOAuthQuery } = await import(moduleUrl.href);
    location.search = "?state=00042%2Bencoded+space&sig=first-sig";
    assert.equal(
      readMcpOAuthQuery(),
      "state=00042%2Bencoded%20space&sig=first-sig",
    );
    location.search = "?state=fresh+request&sig=second-sig";
    assert.equal(readMcpOAuthQuery(), "state=fresh+request&sig=second-sig");
    location.pathname = "/admin/mcp";
    location.search = "?taskId=task&sig=first-sig";
    assert.equal(readMcpOAuthQuery(), "taskId=task&sig=first-sig");
    location.pathname = "/admin/mcp/consent";
    location.search = "?state=new&sig=first-sig&sig=second-sig";
    assert.equal(readMcpOAuthQuery(), "state=new&sig=first-sig&sig=second-sig");
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("MCP login accepts only its official consent resume destination", () => {
  const path =
    "/admin/mcp/consent?client_id=client&state=a%2Bb%20c&sig=new-sig";
  assert.equal(
    mcpLoginRedirect({ ok: true, redirect: path }, origin),
    origin + path,
  );
  assert.equal(
    mcpLoginRedirect({ ok: true, redirect: origin + path }, origin),
    origin + path,
  );
  assert.equal(mcpLoginRedirect({ ok: true }, origin), null);
  assert.equal(
    mcpLoginRedirect(
      { ok: true, redirect: "/admin/mcp/consent?sig=dev" },
      "http://localhost:8793",
    ),
    "http://localhost:8793/admin/mcp/consent?sig=dev",
  );
});

test("MCP email login rejects external callbacks and malformed resume responses", () => {
  const redirects = [
    "https://client.example.test/callback?code=secret",
    "//client.example.test/admin/mcp/consent?sig=secret",
    origin + "/admin/auth/oauth2/authorize",
    origin + "/admin/mcp",
    origin + "/admin/mcp/consent/",
    origin + "/admin/mcp/consent#callback",
    "https://user:password@niaro.example.test/admin/mcp/consent",
    "/admin/mcp/consent?sig=new\n",
    "/admin\\mcp\\consent?sig=new",
    "javascript:location.href='https://client.example.test'",
    "",
    "/admin/mcp/consent?sig=" + "x".repeat(20_480),
  ];
  for (const redirect of redirects)
    assert.throws(
      () => mcpLoginRedirect({ ok: true, redirect }, origin),
      (error) => error instanceof ApiError && error.status === 422,
    );
  for (const value of [
    null,
    {},
    { ok: false },
    { ok: true, redirect: true },
    { redirect: true, url: "/admin/mcp/consent" },
  ])
    assert.throws(() => mcpLoginRedirect(value, origin), ApiError);
});
