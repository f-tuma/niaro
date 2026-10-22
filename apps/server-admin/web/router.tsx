import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import {
  ServicesPage,
  AddServicePage,
  ServiceDetailPage,
} from "./catalog-services";
import {
  ProvidersPage,
  ProviderDetailPage,
  RoutingPage,
} from "./catalog-providers";
import { PluginsPage } from "./plugins-page";
import { PluginFilesPage } from "./plugin-files-page";
import { AuthProvidersPage } from "./auth-providers";
import { Accounts, Workspaces } from "./identity-pages";
import { AuditPage } from "./audit-page";
import { McpPage, mcpSearchSchema } from "./mcp-page";
import { UsageLimitsPage } from "./usage-limits-page";
import { McpConsent } from "./mcp-consent";
import { LoopsPage } from "./loops-page";
import { HostedPage } from "./hosted-page";
import { OverviewPage } from "./overview-page";
import { App } from "./App";
import { Settings } from "./pages";
import { ProcessDesignPage, designSearchSchema } from "./process-design-page";
import { WorkspaceProcessesPage } from "./workspace-processes-page";
import { ProcessConsolePage } from "./process-console-page";
import { SkillAdminPage, SkillsAdminPage } from "./skills-page";
import {
  addServiceSearchSchema,
  serviceDetailSearchSchema,
} from "./service-setup-copy";

const rootRoute = createRootRoute({ component: App });
// Generic helpers keep literal paths so links stay type-checked.
function page<const P extends string>(
  path: P,
  component: () => React.ReactNode,
) {
  return createRoute({ getParentRoute: () => rootRoute, path, component });
}
function moved<const P extends string>(path: P, to: string) {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: () => {
      throw redirect({ href: `/admin${to}`, replace: true });
    },
  });
}

const settings = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  // Earlier console versions kept people, workspaces and audit as tabs here.
  validateSearch: (search: Record<string, unknown>): { tab?: string } =>
    typeof search.tab === "string" ? { tab: search.tab } : {},
  beforeLoad: ({ search }) => {
    const target = {
      people: "/people",
      workspaces: "/workspaces",
      audit: "/audit",
    }[search.tab ?? ""];
    if (target) throw redirect({ href: `/admin${target}`, replace: true });
  },
  component: Settings,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    page("/device", () => null),
    page("/service-connect", () => null),
    page("/mcp/consent", McpConsent),

    page("/", OverviewPage),
    page("/processes", WorkspaceProcessesPage),
    page("/processes/$processId", ProcessConsolePage),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/processes/design",
      validateSearch: (search) => designSearchSchema.parse(search),
      component: ProcessDesignPage,
    }),
    page("/services", ServicesPage),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/services/new",
      component: AddServicePage,
      validateSearch: (search) => addServiceSearchSchema.parse(search),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/services/$serviceId",
      component: ServiceDetailPage,
      validateSearch: (search) => serviceDetailSearchSchema.parse(search),
    }),
    page("/services/$serviceId/processes/$processId", ProcessConsolePage),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/services/$serviceId/processes/design",
      validateSearch: (search) => designSearchSchema.parse(search),
      component: ProcessDesignPage,
    }),
    page("/skills", SkillsAdminPage),
    page("/skills/$skillId", SkillAdminPage),
    page("/plugins", PluginsPage),
    page("/plugins/$pluginId", PluginsPage),
    page("/plugins/$pluginId/files", PluginFilesPage),
    page("/routing", RoutingPage),
    page("/usage", UsageLimitsPage),
    page("/providers", ProvidersPage),
    page("/providers/$providerId", ProviderDetailPage),
    page("/people", () => <Accounts />),
    page("/workspaces", () => <Workspaces />),
    page("/hosted", HostedPage),
    page("/auth-providers", AuthProvidersPage),
    page("/auth-providers/$authProviderId", AuthProvidersPage),
    page("/audit", () => <AuditPage />),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/mcp",
      validateSearch: (search) => mcpSearchSchema.parse(search),
      component: McpPage,
    }),
    page("/loops", LoopsPage),
    settings,
    moved("/access", "/settings"),
    moved("/accounts", "/people"),
    moved("/ai", "/routing"),
    moved("/tools", "/services"),
    moved("/built-in", "/services"),
    moved("/connections/$serviceId", "/services"),
  ]),
  basepath: "/admin",
  scrollRestoration: true,
  scrollToTopSelectors: ["#console-content"],
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
