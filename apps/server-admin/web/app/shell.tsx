import { useEffect } from "react";
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import {
  Archive,
  AudioLines,
  LayoutDashboard,
  Check,
  ChevronsUpDown,
  ClipboardList,
  Languages,
  LogOut,
  Monitor,
  Moon,
  PlugZap,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  SquarePen,
  Sun,
  UserRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Skeleton } from "@admin/components/ui/skeleton";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
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
import { EntityIcon, initials } from "@admin/components/console/entity-icon";
import { setTheme, useTheme } from "../lib/theme";
import {
  ProcessEditsGuard,
  useProcessEditsGuard,
} from "../process-edits-guard";
import { designCs, designEn } from "../process-design-copy";
import { useApp } from "./context";
import { useAppCopy, type AppCopy } from "./copy";
import { MeetingRecordingBadge } from "./meeting-recorder";
import { ChatHistoryNav } from "./chat-history";
import { useSearchCopy } from "./search-copy";

/** The information views, after Overview, New chat and Search. */
const navigation: {
  to: "/tasks" | "/meetings" | "/processes" | "/skills" | "/connections";
  key: keyof AppCopy;
  icon: LucideIcon;
}[] = [
  { to: "/tasks", key: "tasks", icon: ClipboardList },
  { to: "/meetings", key: "meetings", icon: AudioLines },
  { to: "/processes", key: "processes", icon: Workflow },
  { to: "/skills", key: "skills", icon: Sparkles },
  { to: "/connections", key: "connections", icon: PlugZap },
];
const isActive = (path: string, to: string) => path.startsWith(to);
/** A new, empty chat; it gets its address with its first message. */
export const NEW_CHAT_PATH = "/chat";
/** Search in the person's chats. */
export const SEARCH_PATH = "/search";

/** Chat first; the personal menu beside it and administration for admins. */
export function AppShell() {
  const { language } = useApp();
  return (
    // Unsaved designer edits ask before switching workspace or signing out.
    <ProcessEditsGuard copy={language === "cs" ? designCs : designEn}>
      <SidebarProvider className="h-svh">
        <Layout />
      </SidebarProvider>
    </ProcessEditsGuard>
  );
}

function Layout() {
  const copy = useAppCopy();
  const { session, sessionError, reconnect } = useApp();
  const { setOpenMobile } = useSidebar();
  const path = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => setOpenMobile(false), [path, setOpenMobile]);
  // As in ChatGPT: Ctrl/Cmd+K searches chats, Ctrl/Cmd+Shift+O starts a
  // new chat, from anywhere in the app.
  const navigate = useNavigate();
  const search = useSearchCopy().copy;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (!event.shiftKey && key === "k") {
        event.preventDefault();
        void navigate({ to: SEARCH_PATH });
      } else if (event.shiftKey && key === "o") {
        event.preventDefault();
        void navigate({ to: NEW_CHAT_PATH });
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [navigate]);
  return (
    <>
      <Sidebar collapsible="icon" variant="inset">
        <SidebarHeader>
          <WorkspaceSwitcher />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={path === "/"}
                    tooltip={copy.home}
                  >
                    <Link
                      to="/"
                      aria-current={path === "/" ? "page" : undefined}
                    >
                      <LayoutDashboard aria-hidden="true" />
                      <span>{copy.home}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={path === NEW_CHAT_PATH}
                    tooltip={copy.newChat}
                  >
                    <Link to={NEW_CHAT_PATH}>
                      <SquarePen aria-hidden="true" />
                      <span>{copy.newChat}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    isActive={path === SEARCH_PATH}
                    tooltip={search.shortcut}
                  >
                    <Link to={SEARCH_PATH}>
                      <Search aria-hidden="true" />
                      <span>{search.search}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <nav aria-label={copy.navigation} className="contents">
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {navigation.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive(path, item.to)}
                        tooltip={copy[item.key]}
                      >
                        <Link
                          to={item.to}
                          aria-current={
                            isActive(path, item.to) ? "page" : undefined
                          }
                        >
                          <item.icon aria-hidden="true" />
                          <span>{copy[item.key]}</span>
                        </Link>
                      </SidebarMenuButton>
                      {item.to === "/meetings" && <MeetingRecordingBadge />}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </nav>
          <ChatHistoryNav />
        </SidebarContent>
        <SidebarFooter>
          <UserMenu />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-h-0 min-w-0">
        <header className="flex h-12 shrink-0 items-center gap-2 px-3 md:hidden">
          <SidebarTrigger aria-label={copy.toggleSidebar} />
        </header>
        <main
          id="app-content"
          tabIndex={-1}
          className="flex min-h-0 flex-1 flex-col outline-none"
        >
          {/* The account page works without chat, e.g. to free a device slot. */}
          {session || path === "/me" ? (
            <Outlet />
          ) : sessionError ? (
            <div className="p-4 md:p-8">
              <Alert variant="destructive">
                <AlertDescription>{copy[sessionError]}</AlertDescription>
                <AlertAction>
                  {sessionError === "deviceLimit" ? (
                    <Button variant="outline" size="sm" asChild>
                      <Link to="/me">{copy.openAccount}</Link>
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={reconnect}>
                      <RefreshCw data-icon="inline-start" aria-hidden="true" />
                      {copy.retry}
                    </Button>
                  )}
                </AlertAction>
              </Alert>
            </div>
          ) : (
            <div
              role="status"
              aria-label={copy.connecting}
              className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-8"
            >
              <Skeleton className="h-6 w-1/3" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-2/3" />
            </div>
          )}
        </main>
      </SidebarInset>
    </>
  );
}

function WorkspaceSwitcher() {
  const copy = useAppCopy();
  const { workspace, workspaces, selectWorkspace } = useApp();
  const { isMobile } = useSidebar();
  const edits = useProcessEditsGuard();
  const label = (
    <>
      <EntityIcon size="sm">{initials(workspace.name)}</EntityIcon>
      <span className="grid flex-1 text-left leading-tight">
        <span className="truncate font-medium">{workspace.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {workspace.organizationName}
        </span>
      </span>
    </>
  );
  if (workspaces.length < 2)
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" asChild>
            <div>{label}</div>
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
              {label}
              <ChevronsUpDown className="ml-auto" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-60"
            side={isMobile ? "bottom" : "right"}
            align="start"
            sideOffset={4}
          >
            <DropdownMenuLabel>{copy.workspace}</DropdownMenuLabel>
            <DropdownMenuGroup>
              {workspaces.map((value) => (
                <DropdownMenuItem
                  key={value.workspaceId}
                  onSelect={() =>
                    edits.request(() => selectWorkspace(value.workspaceId), {
                      organizationId: workspace.organizationId,
                      workspaceId: workspace.workspaceId,
                    })
                  }
                >
                  <EntityIcon size="sm">{initials(value.name)}</EntityIcon>
                  <span className="grid flex-1 leading-tight">
                    <span className="truncate">{value.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {value.organizationName}
                    </span>
                  </span>
                  {value.workspaceId === workspace.workspaceId && (
                    <Check aria-hidden="true" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function UserMenu() {
  const copy = useAppCopy();
  const { identity, language, setLanguage, signOut, isAdmin } = useApp();
  const { isMobile } = useSidebar();
  const edits = useProcessEditsGuard();
  const theme = useTheme();
  const name = identity.user?.name ?? copy.account;
  const email = identity.user?.email ?? "";
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
                  {email}
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
            {isAdmin && (
              <DropdownMenuItem asChild>
                <a href="/admin/">
                  <Settings2 aria-hidden="true" />
                  {copy.administration}
                </a>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem asChild>
              <Link to="/me">
                <UserRound aria-hidden="true" />
                {copy.accountSettings}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/me" hash="archived-chats">
                <Archive aria-hidden="true" />
                {copy.archivedChats}
              </Link>
            </DropdownMenuItem>
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
            <DropdownMenuItem onSelect={() => edits.request(signOut)}>
              <LogOut aria-hidden="true" />
              {copy.signOut}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
