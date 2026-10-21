import { providerReturnPath } from "../apps/server-admin/web/lib/provider-return-path";

test("a provider sign-in returns to the web app page it started on", () => {
  for (const path of [
    "/",
    "/chat/chat-1",
    "/tasks",
    "/processes/abc",
    "/skills",
    "/search",
    "/me",
    "/meetings/m-1",
    "/connections/svc-1",
  ])
    expect(providerReturnPath(path)).toBe(path);
  for (const path of [
    "/admin/device",
    "/account/invite#token",
    "/admin/mcp/consent?x=1",
  ])
    expect(providerReturnPath(path)).toBe(path);
  for (const path of [
    "//evil.example",
    "/unknown",
    "/chat/a/b",
    "/search/x",
    "/admin/catalog",
  ])
    expect(providerReturnPath(path)).toBe("/admin/");
});
