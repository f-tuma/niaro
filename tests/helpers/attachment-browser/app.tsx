import { TooltipProvider } from "../../../apps/server-admin/web/components/ui/tooltip";
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { ChatNextConversation } from "../../../apps/server-admin/web/app/chat-next/chat-next-page";
import {
  AppContext,
  type AppContextValue,
} from "../../../apps/server-admin/web/app/context";
import { ClientSession } from "../../../packages/client-core/session";
import type { Credential } from "../../../packages/protocol";
import "../../../apps/server-admin/web/style.css";
const bootstrap = (await fetch("/bootstrap").then((response) =>
  response.json(),
)) as { actor: Credential };
const map = new Map<string, string>();
const session = new ClientSession(
  location.origin + "/v1/a",
  {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value);
    },
  },
  bootstrap.actor,
  (url, init) => fetch(url, init),
  undefined,
  undefined,
  false,
  { attachments: true, messageTimes: true },
);
await session.start(false);
Object.assign(window, { niaroAttachmentClient: session });
const language =
  new URLSearchParams(location.search).get("lang") === "cs" ? "cs" : "en";
document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") !== "light",
);
const workspace = {
  organizationId: "TEST-organization",
  organizationName: "TEST organization",
  role: "member",
  workspaceId: "a",
  name: "TEST workspace",
};
const value = {
  language,
  workspace,
  session,
  setLanguage() {},
  selectWorkspace() {},
  reconnect() {},
  signOut() {},
  isAdmin: false,
  workspaces: [workspace],
  sessionError: null,
  identity: {},
} as unknown as AppContextValue;
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
function BrowserHarness() {
  const [routeId, selectConversation] = React.useState<string | undefined>(
    "conversation-1",
  );
  React.useEffect(() => {
    Object.assign(window, {
      niaroAttachmentSelectConversation: selectConversation,
    });
  }, []);
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <AppContext.Provider value={value}>
          <div
            className="bg-background text-foreground"
            style={{
              height: "100dvh",
              display: "flex",
              minHeight: 0,
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <ChatNextConversation
              key={routeId ?? "unsaved"}
              session={session}
              routeId={routeId}
              onSaved={() => {}}
            />
          </div>
        </AppContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
const route = createRootRoute({
  component: BrowserHarness,
});
const router = createRouter({ routeTree: route });
if (new URLSearchParams(location.search).get("large") === "1")
  document.documentElement.style.fontSize = "200%";
createRoot(document.getElementById("root")!).render(
  <RouterProvider router={router} />,
);
