import { PublicAccount } from "./public-account";
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { TooltipProvider } from "@admin/components/ui/tooltip";
import { router } from "./router";
import { WebApp } from "./app/app-root";
import { applyTheme } from "./lib/theme";
import { setNonce } from "get-nonce";
import "./font.css";
import "./style.css";
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
const styleNonce = document.querySelector<HTMLMetaElement>(
  'meta[name="agent-style-nonce"]',
)?.content;
if (styleNonce) setNonce(styleNonce);
applyTheme();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {window.location.pathname.startsWith("/account/") ? (
          <PublicAccount />
        ) : window.location.pathname === "/admin" ||
          window.location.pathname.startsWith("/admin/") ? (
          <RouterProvider router={router} />
        ) : (
          <WebApp />
        )}
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
