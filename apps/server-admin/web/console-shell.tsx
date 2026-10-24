import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  Boxes,
  Check,
  ChevronsUpDown,
  Languages,
  LogOut,
  Monitor,
  Moon,
  RefreshCw,
  Sun,
  Terminal,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Separator } from "@admin/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@admin/components/ui/sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@admin/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@admin/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@admin/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@admin/components/ui/tooltip";
import { useAdmin } from "./context";
import { useConsoleScope } from "./console-scope";
import { useShellCopy } from "./shell-copy";
import { PageTitleProvider } from "@admin/components/console/page";
import { initials } from "@admin/components/console/entity-icon";
import { setTheme, useTheme } from "@admin/lib/theme";
import { ProcessEditsGuard, useProcessEditsGuard } from "./process-edits-guard";
import { designEn, designCs } from "./process-design-copy";
import { navigation } from "./console-navigation";

function usePath() {
  const raw = useRouterState({ select: (s) => s.location.pathname });
  const path = raw.replace(/^\/admin/, "").replace(/\/$/, "");
  return path || "/";
}
function isActive(path: string, to: string) {
  return to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`);
}

type ConsoleShellProps = {
  children: ReactNode;
  logout: () => void;
  refresh: () => void;
  busy: boolean;
  refreshing: boolean;
};

const sidebarKey = "agent-admin-sidebar";
function initialSidebar() {
  try {
    return localStorage.getItem(sidebarKey) !== "collapsed";
  } catch {
    return true;
  }
}

export function ConsoleShell(props: ConsoleShellProps) {
  const [open, setOpen] = useState(initialSidebar);
  const { language } = useAdmin();
  return (
    <SidebarProvider
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        try {
          localStorage.setItem(sidebarKey, value ? "open" : "collapsed");
        } catch {
          /* Session-only preference. */
        }
      }}
      className="h-svh overflow-hidden"
    >
      <ProcessEditsGuard copy={language === "cs" ? designCs : designEn}>
        <ConsoleLayout {...props} />
      </ProcessEditsGuard>
    </SidebarProvider>
  );
}

function ConsoleLayout({
  children,
  logout,
  refresh,
  busy,
  refreshing,
}: ConsoleShellProps) {
  const copy = useShellCopy();
  const { selectedOrganization, selectedWorkspace } = useAdmin();
  const edits = useProcessEditsGuard();
  const { setOpenMobile } = useSidebar();
  const path = usePath();
  useEffect(() => setOpenMobile(false), [path, setOpenMobile]);
  const active = navigation
    .flatMap((group) => group.items)
    .filter((item) => isActive(path, item.to))
    .sort((a, b) => b.to.length - a.to.length)[0];

  return (
    <PageTitleProvider>
      {(pageTitle) => (
        <>
          <Button
            asChild
            className="fixed top-3 left-3 z-50 -translate-y-24 focus:translate-y-0"
          >
            <a href="#console-content">{copy.skipToContent}</a>
          </Button>
          <Sidebar collapsible="icon" variant="inset">
            <SidebarHeader>
              <WorkspaceSwitcher />
            </SidebarHeader>
            <SidebarContent>
              <nav aria-label={copy.navigation} className="contents">
                {navigation.map((group, index) => (
                  <SidebarGroup key={group.label ?? index}>
                    {group.label && (
                      <SidebarGroupLabel>{copy[group.label]}</SidebarGroupLabel>
                    )}
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {group.items.map((item) => (
                          <SidebarMenuItem key={item.to}>
                            <SidebarMenuButton
                              asChild
                              isActive={active?.to === item.to}
                              tooltip={copy[item.key]}
                            >
                              <Link
                                to={item.to}
                                aria-current={
                                  active?.to === item.to ? "page" : undefined
                                }
                              >
                                <item.icon aria-hidden="true" />
                                <span>{copy[item.key]}</span>
                              </Link>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        ))}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </SidebarGroup>
                ))}
              </nav>
              <SidebarGroup className="mt-auto">
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild tooltip={copy.backToApp}>
                        <a href="/">
                          <ArrowLeft aria-hidden="true" />
                          <span>{copy.backToApp}</span>
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
              <UserMenu logout={() => edits.request(logout)} busy={busy} />
            </SidebarFooter>
            <SidebarRail />
          </Sidebar>
          <SidebarInset className="min-h-0 min-w-0">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 md:px-6">
              <SidebarTrigger
                className="-ml-1"
                aria-label={copy.toggleSidebar}
              />
              <Separator
                orientation="vertical"
                className="mr-2 data-vertical:h-4 data-vertical:self-center"
              />
              <Breadcrumb className="min-w-0 flex-1">
                <BreadcrumbList className="flex-nowrap">
                  {active && pageTitle && path !== active.to ? (
                    <>
                      <BreadcrumbItem className="hidden sm:inline-flex">
                        <BreadcrumbLink asChild>
                          <Link to={active.to}>{copy[active.key]}</Link>
                        </BreadcrumbLink>
                      </BreadcrumbItem>
                      <BreadcrumbSeparator className="hidden sm:block" />
                      <BreadcrumbItem className="min-w-0">
                        <BreadcrumbPage>
                          <span className="truncate">{pageTitle}</span>
                        </BreadcrumbPage>
                      </BreadcrumbItem>
                    </>
                  ) : (
                    <BreadcrumbItem>
                      <BreadcrumbPage id="console-section">
                        {active ? copy[active.key] : pageTitle}
                      </BreadcrumbPage>
                    </BreadcrumbItem>
                  )}
                </BreadcrumbList>
              </Breadcrumb>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={refresh}
                    disabled={refreshing || busy}
                    aria-label={copy.refresh}
                    aria-busy={refreshing}
                  >
                    <RefreshCw
                      aria-hidden="true"
                      className={refreshing ? "motion-safe:animate-spin" : ""}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{copy.refresh}</TooltipContent>
              </Tooltip>
            </header>
            <main
              key={`${path}:${selectedOrganization}:${selectedWorkspace}`}
              id="console-content"
              data-page={path}
              tabIndex={-1}
              aria-labelledby="page-title"
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none"
            >
              <div className="flex w-full min-w-0 flex-col gap-8 px-4 pt-6 pb-12 md:px-8 md:pt-7">
                {children}
              </div>
            </main>
          </SidebarInset>
        </>
      )}
    </PageTitleProvider>
  );
}

export function Brand() {
  return (
    <span className="flex items-center gap-2.5 text-base font-semibold tracking-tight">
      <span
        aria-hidden="true"
        className="flex size-8 items-center justify-center rounded-lg bg-foreground text-background"
      >
        <Terminal className="size-4" />
      </span>
      Agent Client
    </span>
  );
}

function WorkspaceSwitcher() {
  const copy = useShellCopy();
  const scope = useConsoleScope();
  const { data, setSelectedOrganization, setSelectedWorkspace } = useAdmin();
  const { isMobile } = useSidebar();
  const edits = useProcessEditsGuard();
  const guardScope =
    scope.organization && scope.workspace
      ? {
          organizationId: scope.organization.id,
          workspaceId: scope.workspace.id,
        }
      : undefined;
  const organizations = scope.identity.data?.organizations ?? [];
  const workspaces = scope.detail.data?.workspaces ?? [];
  const title = scope.workspace?.name ?? scope.organization?.name;
  if (!scope.organization || !title)
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" asChild>
            <Link to="/">
              <span
                aria-hidden="true"
                className="flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground text-background"
              >
                <Terminal className="size-3.5" />
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">Agent Client</span>
                <span className="truncate text-xs text-muted-foreground">
                  {data.server.name}
                </span>
              </span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" aria-label={copy.switchWorkspace}>
              <span
                aria-hidden="true"
                className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground"
              >
                {initials(title)}
              </span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">{title}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {scope.organization.name}
                </span>
              </span>
              <ChevronsUpDown className="ml-auto" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-64"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel>{copy.workspaces}</DropdownMenuLabel>
            <DropdownMenuGroup>
              {workspaces.map((workspace) => (
                <DropdownMenuItem
                  key={workspace.id}
                  onSelect={() => {
                    if (workspace.id !== scope.workspace?.id)
                      edits.request(
                        () => setSelectedWorkspace(workspace.id),
                        guardScope,
                      );
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="flex size-6 items-center justify-center rounded-md border text-xs font-medium"
                  >
                    {initials(workspace.name)}
                  </span>
                  <span className="truncate">{workspace.name}</span>
                  {workspace.id === scope.workspace?.id && (
                    <Check className="ml-auto" aria-hidden="true" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            {organizations.length > 1 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{copy.organizations}</DropdownMenuLabel>
                <DropdownMenuGroup>
                  {organizations.map((organization) => (
                    <DropdownMenuItem
                      key={organization.id}
                      onSelect={() => {
                        if (organization.id !== scope.organization?.id)
                          edits.request(
                            () => setSelectedOrganization(organization.id),
                            guardScope,
                          );
                      }}
                    >
                      <span className="truncate">{organization.name}</span>
                      {organization.id === scope.organization?.id && (
                        <Check className="ml-auto" aria-hidden="true" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/workspaces">
                <Boxes aria-hidden="true" />
                {copy.manageWorkspaces}
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function UserMenu({ logout, busy }: { logout: () => void; busy: boolean }) {
  const copy = useShellCopy();
  const { data, language, setLanguage } = useAdmin();
  const { identity } = useConsoleScope();
  const { isMobile } = useSidebar();
  const theme = useTheme();
  const user = identity.data?.user;
  const name =
    user?.name ??
    (data.authentication.current === "better-auth"
      ? copy.account
      : copy.recoverySession);
  const detail = user?.email ?? data.server.name;
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" aria-label={copy.account}>
              <Avatar size="sm">
                <AvatarFallback>{initials(name)}</AvatarFallback>
              </Avatar>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate font-medium">{name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {detail}
                </span>
              </span>
              <ChevronsUpDown className="ml-auto" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-60"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel>
              <span className="grid leading-tight">
                <span className="truncate font-medium">{name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {detail}
                </span>
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ThemeIcon aria-hidden="true" />
                {copy.theme}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={theme}
                  onValueChange={(value) =>
                    (value === "light" ||
                      value === "dark" ||
                      value === "system") &&
                    setTheme(value)
                  }
                >
                  <DropdownMenuRadioItem value="light">
                    {copy.themeLight}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    {copy.themeDark}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    {copy.themeSystem}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Languages aria-hidden="true" />
                {copy.language}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={language}
                  onValueChange={(value) =>
                    (value === "en" || value === "cs") && setLanguage(value)
                  }
                >
                  <DropdownMenuRadioItem value="en">
                    English
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="cs">
                    Čeština
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={logout} disabled={busy}>
              <LogOut aria-hidden="true" />
              {copy.signOut}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
