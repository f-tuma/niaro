import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowUp,
  Circle,
  ClipboardList,
  LayoutDashboard,
  Maximize2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@admin/components/ui/card";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@admin/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@admin/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@admin/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@admin/components/ui/input-group";
import { Markdown } from "@admin/components/ui/markdown";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Spinner } from "@admin/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@admin/components/ui/table";
import { DetailList } from "@admin/components/console/forms";
import { StatusBadge } from "@admin/components/console/status";
import { RelativeTime } from "@admin/components/console/time";
import type { ClientSession } from "../../../../packages/client-core/session";
import {
  HUB_ITEM_LIMIT,
  HUB_PROFILE_V3,
  type HubCard,
  type HubDashboardV3,
  type HubDashboardV3Command,
  type HubOutput,
  type HubWidgetData,
  type HubWidgetView,
} from "../../../../packages/protocol/hub";
import {
  hubItemSize,
  hubResolveView,
  type HubPlaced,
} from "../../../../packages/protocol/hub-dashboard";
import {
  hubWidgetConfig,
  hubWidgetDefinition,
} from "../../../../packages/protocol/widgets";
import { plural } from "../lib/plural";
import { useApp, useAppSession } from "./context";
import { UNSAVED_DRAFT, draftKey, saveDraft } from "./chat-store";
import {
  hubErrorText,
  hubWidgetProblem,
  useHubCopy,
  type HubCopy,
  type HubFix,
} from "./hub-copy";
import HubChart from "./hub-chart";
import {
  HubGallery,
  HubWidgetEditSheet,
  type HubAddChoice,
} from "./hub-gallery";
import { HubGrid, type HubGridControls } from "./hub-grid";
import { HubWidgetSheet, type HubWidgetChange } from "./hub-widget-sheet";
import { useSessionState } from "./menu-page";
import { widgetRenderer } from "./widgets";
import {
  WidgetRowContent,
  WidgetRows,
  WidgetToolbarSlot,
  widgetRowClass,
} from "./widgets/shared";

/** Distributes Omit over the command union. */
type HubChange = HubDashboardV3Command extends infer C
  ? C extends HubDashboardV3Command
    ? Omit<C, "profile">
    : never
  : never;

export const hubQueryKey = (identityKey: string, language: string) =>
  ["app", "hub", identityKey, language] as const;

const DEFAULT_TASK_TITLES = new Set(["Tasks", "Úkoly"]);

/** "Good morning" by the local hour. */
export function hubGreeting(copy: HubCopy, hour: number) {
  return hour < 11 ? copy.morning : hour < 18 ? copy.afternoon : copy.evening;
}

/** "/": the person's dashboard, the page the app opens on. */
export function HubPage() {
  const session = useAppSession();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="flex w-full min-w-0 flex-col gap-6 px-4 pt-6 pb-12 md:px-8 md:pt-8">
        <HubDashboardView key={session.identityKey} session={session} />
      </div>
    </div>
  );
}

/**
 * A calm, personal dashboard: widgets the person chose, each showing its
 * latest data. Typed widgets are filled on the server (by the assistant over
 * the person's read-only access, or from the server's own data); process
 * widgets show a process's latest result. Opening it refreshes what is due.
 * Every widget hands questions about it to a new chat. Editing adds, moves,
 * resizes and sets up widgets.
 */
export function HubDashboardView({ session }: { session: ClientSession }) {
  const { language, isAdmin } = useApp();
  const copy = useHubCopy();
  const client = useQueryClient();
  const navigate = useNavigate();
  const state = useSessionState(session);
  const online = state.status === "online";
  const key = hubQueryKey(session.identityKey, language);
  const hub = useQuery({
    queryKey: key,
    enabled: online,
    retry: 1,
    queryFn: ({ signal }) => session.readHub(language, signal),
    // Follow refreshes while they run; everything else is read on open.
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.result?.status === "running")
        ? 3000
        : false,
  });
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [configuring, setConfiguring] = useState<{
    id: string;
    focus: "name" | "view";
  } | null>(null);
  /** A refused change, with the sources it named (for the fix's link). */
  const [changeError, setChangeError] = useState<{
    code: string;
    sources: { id: string }[];
  } | null>(null);
  /** The widget shown large in a dialog, by id. */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: (command: HubChange) =>
      session.sendHubCommand(language, {
        ...command,
        profile: HUB_PROFILE_V3,
      } as HubDashboardV3Command),
    // Someone else changed the overview at the same moment: once more on the new state.
    retry: (count, error) =>
      count < 1 && /^hub_(?:conflict|changed)$/.test(error.message),
    retryDelay: 0,
    onMutate: () => setChangeError(null),
    onSuccess: (view) => client.setQueryData(key, view),
    onError: (error, command) => {
      const sources =
        command.type === "add" && "widget" in command
          ? (command.widget?.sources ?? [])
          : command.type === "setWidget"
            ? (command.sources ?? [])
            : [];
      setChangeError({
        code: error instanceof Error ? error.message : "hub_failed",
        sources: sources.map((id) => ({ id })),
      });
      // A refused layout or view shows the stored one again.
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const { mutate, mutateAsync } = change;
  // What is due refreshes once per visit, after the first read.
  const dueChecked = useRef(false);
  const data = hub.data;
  useEffect(() => {
    if (dueChecked.current || !data || !online) return;
    dueChecked.current = true;
    if (data.items.some((item) => item.stale))
      mutate({ type: "refresh", stale: true });
  }, [data, online, mutate]);

  /** A new chat with this text ready to send. */
  const ask = (text: string) => {
    if (text.trim())
      saveDraft(draftKey(session.identityKey, UNSAVED_DRAFT), {
        text: text.trim(),
        revision: 0,
      });
    void navigate({ to: "/chat" });
  };
  /** A new chat that starts with the widget as context; the person finishes it. */
  const askAbout = (name: string, detail = "") => {
    saveDraft(draftKey(session.identityKey, UNSAVED_DRAFT), {
      text: copy.askAbout(name, detail),
      revision: 0,
    });
    void navigate({ to: "/chat" });
  };

  const now = new Date();
  const date = now.toLocaleDateString(language, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const today = date.charAt(0).toUpperCase() + date.slice(1);
  const pending = change.isPending || !online;
  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <h1 className="text-2xl font-semibold tracking-tight">
          {hubGreeting(copy, now.getHours())}
        </h1>
        <p className="text-sm text-muted-foreground">{today}</p>
      </div>
      <div className="flex w-full items-center gap-2 sm:w-auto">
        {editing ? (
          <>
            {data && data.items.length < HUB_ITEM_LIMIT && (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => setAdding(true)}
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                {copy.add}
              </Button>
            )}
            <Button size="sm" onClick={() => setEditing(false)}>
              {copy.done}
            </Button>
          </>
        ) : (
          <>
            <AskBox copy={copy} onAsk={ask} />
            {data && data.items.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(true)}
              >
                <Pencil data-icon="inline-start" aria-hidden="true" />
                {copy.edit}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
  if (!data)
    return (
      <section aria-label={copy.overview} className="flex flex-col gap-6">
        {header}
        {hub.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{copy.loadFailed}</AlertDescription>
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                disabled={!online}
                onClick={() => void hub.refetch()}
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {copy.retry}
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          <div
            role="status"
            aria-label={copy.overview}
            className="grid gap-4 md:grid-cols-12"
          >
            <Skeleton className="h-40 w-full md:col-span-4" />
            <Skeleton className="h-40 w-full md:col-span-8" />
          </div>
        )}
      </section>
    );

  const items = data.items;
  const waiting = Object.values(state.store?.workItems ?? {}).filter(
    (work) =>
      work.status === "waiting_approval" || work.status === "waiting_input",
  ).length;
  const configured = items.find((item) => item.id === configuring?.id);
  const add = (choice: HubAddChoice) => {
    setAdding(false);
    if (choice.kind === "tasks") return mutate({ type: "add", kind: "tasks" });
    if (choice.kind === "process")
      return mutate({
        type: "add",
        kind: "process",
        processId: choice.processId,
      });
    mutate({
      type: "add",
      kind: "widget",
      ...(choice.title ? { title: choice.title } : {}),
      widget: {
        type: choice.type,
        ...(choice.brief ? { brief: choice.brief } : {}),
        config: choice.config,
        ...(choice.sources.length ? { sources: choice.sources } : {}),
      },
    });
  };
  return (
    <section aria-label={copy.overview} className="flex flex-col gap-6">
      {header}
      {changeError && (
        <ChangeProblem copy={copy} error={changeError} isAdmin={isAdmin} />
      )}
      {!items.length && !editing ? (
        <Empty data-testid="hub-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutDashboard aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{copy.emptyTitle}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => setEditing(true)}>
              <Pencil data-icon="inline-start" aria-hidden="true" />
              {copy.editOverview}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <HubGrid
          items={items.map((item) => ({
            id: item.id,
            layout: item.layout,
            size: hubItemSize(item),
          }))}
          editing={editing}
          disabled={pending}
          copy={copy}
          onLayout={(next: HubPlaced[]) => {
            // Shown at once; the server's answer replaces it.
            client.setQueryData<HubDashboardV3>(key, (current) =>
              current
                ? {
                    ...current,
                    items: current.items.map((item) => ({
                      ...item,
                      layout:
                        next.find((value) => value.id === item.id)?.layout ??
                        item.layout,
                    })),
                  }
                : current,
            );
            mutate({
              type: "layout",
              items: next.map((item) => ({
                itemId: item.id,
                layout: item.layout,
              })),
            });
          }}
          onReorder={(ids) => mutate({ type: "reorder", itemIds: ids })}
          render={(id, controls) => {
            const item = items.find((value) => value.id === id)!;
            const menu = (
              <WidgetMenu
                copy={copy}
                item={item}
                disabled={pending}
                onAsk={() =>
                  askAbout(...widgetAskSubject(item, copy, language))
                }
                onConfigure={(focus) => setConfiguring({ id, focus })}
                onExpand={() => setExpandedId(id)}
                onRefresh={() => mutate({ type: "refresh", itemIds: [id] })}
                onRemove={() => mutate({ type: "remove", itemId: id })}
              />
            );
            const frame = {
              controls,
              menu,
              expanded: expandedId === id,
              onExpand: () => setExpandedId(id),
              onCollapse: () => setExpandedId(null),
            };
            if (item.kind === "tasks")
              return (
                <TasksWidget
                  item={item}
                  tasks={data.tasks}
                  waiting={waiting}
                  frame={frame}
                  onAsk={() =>
                    askAbout(
                      DEFAULT_TASK_TITLES.has(item.title)
                        ? copy.tasks
                        : item.title,
                    )
                  }
                />
              );
            if (item.kind === "widget")
              return (
                <TypedWidget
                  item={item}
                  session={session}
                  frame={frame}
                  disabled={pending}
                  onRefresh={() => mutate({ type: "refresh", itemIds: [id] })}
                  onAsk={ask}
                  onAskAbout={askAbout}
                />
              );
            return (
              <ProcessWidget
                item={item}
                frame={frame}
                disabled={pending}
                onRefresh={() => mutate({ type: "refresh", itemIds: [id] })}
                onConfigure={() => setConfiguring({ id, focus: "view" })}
                onAsk={() => askAbout(item.title)}
              />
            );
          }}
        />
      )}
      <HubGallery
        open={adding}
        session={session}
        hub={data}
        disabled={pending}
        onClose={() => setAdding(false)}
        onAdd={add}
      />
      <HubWidgetSheet
        item={configured && configured.kind !== "widget" ? configured : null}
        focus={configuring?.focus ?? "view"}
        disabled={pending}
        onClose={() => setConfiguring(null)}
        onSave={async (changes: HubWidgetChange) => {
          if (!configured) return;
          const itemId = configured.id;
          try {
            if (changes.title !== undefined)
              await mutateAsync({
                type: "rename",
                itemId,
                title: changes.title,
              });
            if (changes.refresh)
              await mutateAsync({
                type: "setRefresh",
                itemId,
                refresh: changes.refresh,
              });
            if (changes.view)
              await mutateAsync({
                type: "setView",
                itemId,
                view: changes.view,
              });
            setConfiguring(null);
          } catch {
            // The error shows above the grid.
            setConfiguring(null);
          }
        }}
      />
      <HubWidgetEditSheet
        item={configured?.kind === "widget" ? configured : null}
        session={session}
        disabled={pending}
        onClose={() => setConfiguring(null)}
        onSave={async (changes) => {
          if (!configured) return;
          const itemId = configured.id;
          try {
            if (changes.title !== undefined)
              await mutateAsync({
                type: "rename",
                itemId,
                title: changes.title,
              });
            if (changes.refresh)
              await mutateAsync({
                type: "setRefresh",
                itemId,
                refresh: changes.refresh,
              });
            if (changes.brief || changes.config || changes.sources)
              await mutateAsync({
                type: "setWidget",
                itemId,
                ...(changes.brief ? { brief: changes.brief } : {}),
                ...(changes.config ? { config: changes.config } : {}),
                ...(changes.sources ? { sources: changes.sources } : {}),
              });
            setConfiguring(null);
          } catch {
            setConfiguring(null);
          }
        }}
      />
    </section>
  );
}

/** Hands a question to a new chat; the dashboard has no composer of its own. */
function AskBox({
  copy,
  onAsk,
}: {
  copy: HubCopy;
  onAsk: (text: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <form
      role="search"
      className="min-w-0 flex-1 sm:w-72 sm:flex-none"
      onSubmit={(event) => {
        event.preventDefault();
        onAsk(text);
      }}
    >
      <InputGroup>
        <InputGroupAddon>
          <SquarePen aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          value={text}
          aria-label={copy.ask}
          placeholder={copy.ask}
          maxLength={4000}
          onChange={(event) => setText(event.target.value)}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            type="submit"
            size="icon-xs"
            aria-label={text.trim() ? copy.askSend : copy.newChat}
          >
            <ArrowUp aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}

function WidgetMenu({
  copy,
  item,
  disabled,
  onAsk,
  onConfigure,
  onExpand,
  onRefresh,
  onRemove,
}: {
  copy: HubCopy;
  item: HubCard;
  disabled: boolean;
  onAsk: () => void;
  onConfigure: (focus: "name" | "view") => void;
  onExpand: () => void;
  onRefresh: () => void;
  onRemove: () => void;
}) {
  const fill = item.widget
    ? hubWidgetDefinition(item.widget.type)?.fill
    : undefined;
  const refreshable =
    item.kind === "process" || (item.kind === "widget" && fill === "ai");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={copy.actions}
          disabled={disabled}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem data-testid="widget-ask-menu" onSelect={onAsk}>
          <Sparkles aria-hidden="true" />
          {copy.askWidget}
        </DropdownMenuItem>
        {item.kind === "process" && (
          <DropdownMenuItem onSelect={() => onConfigure("view")}>
            <Settings2 aria-hidden="true" />
            {copy.configure}
          </DropdownMenuItem>
        )}
        {item.kind === "widget" && fill && (
          <DropdownMenuItem onSelect={() => onConfigure("view")}>
            <Settings2 aria-hidden="true" />
            {fill === "ai" ? copy.editBrief : copy.editWidget}
          </DropdownMenuItem>
        )}
        {item.kind !== "widget" && (
          <DropdownMenuItem onSelect={() => onConfigure("name")}>
            <Pencil aria-hidden="true" />
            {copy.rename}
          </DropdownMenuItem>
        )}
        {refreshable && (
          <DropdownMenuItem
            disabled={item.result?.status === "running"}
            onSelect={onRefresh}
          >
            <RefreshCw aria-hidden="true" />
            {copy.refresh}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onExpand}>
          <Maximize2 aria-hidden="true" />
          {copy.expand}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onRemove}>
          <Trash2 aria-hidden="true" />
          {copy.remove}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What a chat about a widget starts from: its name and its settings in a few words. */
function widgetAskSubject(
  item: HubCard,
  copy: HubCopy,
  language: "en" | "cs",
): [string, string] {
  if (item.kind === "tasks")
    return [DEFAULT_TASK_TITLES.has(item.title) ? copy.tasks : item.title, ""];
  const widget = item.widget;
  const definition = widget ? hubWidgetDefinition(widget.type) : undefined;
  const renderer = widget ? widgetRenderer(widget.type) : undefined;
  if (
    !widget ||
    !definition ||
    !renderer ||
    definition.version !== widget.version
  )
    return [item.title, ""];
  const config =
    hubWidgetConfig(widget.type, widget.config) ??
    (definition.defaultConfig as Record<string, unknown>);
  return [item.title, renderer.describe?.(config, language) ?? ""];
}

/** What the grid hands every widget: its edit controls, its menu and whether it is shown large. */
type WidgetFrameState = {
  controls: HubGridControls | null;
  menu: ReactNode;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
};

/** The card every widget shares: title, freshness, actions, then its body. */
function WidgetFrame({
  testId,
  status,
  type,
  title,
  description,
  action,
  onAsk,
  frame,
  large,
  tall,
  children,
}: {
  testId: string;
  status?: string;
  type?: string;
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
  /** "Ask": a new chat about this widget. */
  onAsk: () => void;
  frame: WidgetFrameState;
  /** The body shown large in the dialog; the card's body when missing. */
  large?: ReactNode;
  /** The dialog takes its full height (a tool), else fits its content. */
  tall?: boolean;
  children?: ReactNode;
}) {
  const copy = useHubCopy();
  const { controls, menu, expanded, onExpand, onCollapse } = frame;
  // The header's status line lends its right end to the widget's toolbar.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [largeSlot, setLargeSlot] = useState<HTMLElement | null>(null);
  return (
    <Card
      data-testid={testId}
      data-status={status}
      data-type={type}
      className="min-h-0 md:h-full"
    >
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="col-span-2">
          <span className="flex min-h-6 items-center gap-3">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
              {description}
            </span>
            <span
              ref={setSlot}
              data-testid="widget-toolbar-slot"
              className="flex shrink-0 items-center gap-2"
            />
          </span>
        </CardDescription>
        <CardAction className="row-span-1">
          <div className="flex items-center gap-0.5">
            {controls?.move ?? (
              <>
                {action}
                {children && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={copy.expand}
                    data-testid="widget-expand"
                    onClick={onExpand}
                  >
                    <Maximize2 aria-hidden="true" />
                  </Button>
                )}
              </>
            )}
            {menu}
          </div>
        </CardAction>
      </CardHeader>
      {children && (
        <CardContent className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <WidgetToolbarSlot.Provider value={slot}>
            {children}
          </WidgetToolbarSlot.Provider>
        </CardContent>
      )}
      {expanded && children && (
        <Dialog open onOpenChange={(open) => !open && onCollapse()}>
          <DialogContent
            data-testid="widget-dialog"
            data-type={type}
            data-tall={tall === true}
            showCloseButton={false}
            className="flex max-h-5/6 flex-col data-[tall=true]:h-5/6 sm:max-w-5xl"
          >
            <DialogHeader>
              {/* One line: name and status left, the tools and refresh right. */}
              <div className="flex min-h-8 items-center gap-3">
                <DialogTitle className="shrink-0">{title}</DialogTitle>
                <DialogDescription className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {description}
                  </span>
                </DialogDescription>
                <span
                  ref={setLargeSlot}
                  data-testid="widget-toolbar-slot"
                  className="flex shrink-0 items-center gap-2"
                />
                <div className="flex shrink-0 items-center gap-0.5">
                  {action}
                  <DialogClose asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={copy.close}
                      data-testid="widget-dialog-close"
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </DialogClose>
                </div>
              </div>
            </DialogHeader>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <WidgetToolbarSlot.Provider value={largeSlot}>
                {large ?? children}
              </WidgetToolbarSlot.Provider>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}

function TasksWidget({
  item,
  tasks,
  waiting,
  frame,
  onAsk,
}: {
  item: HubCard;
  tasks: HubDashboardV3["tasks"];
  waiting: number;
  frame: WidgetFrameState;
  onAsk: () => void;
}) {
  const copy = useHubCopy();
  const { language } = useApp();
  return (
    <WidgetFrame
      testId="hub-tasks"
      // The built-in title follows the language until it is renamed.
      title={DEFAULT_TASK_TITLES.has(item.title) ? copy.tasks : item.title}
      description={
        tasks.open
          ? plural(language, tasks.open, copy.tasksCount)
          : copy.tasksNone
      }
      action={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={copy.showAll}
          asChild
        >
          <Link to="/tasks">
            <ClipboardList aria-hidden="true" />
          </Link>
        </Button>
      }
      frame={frame}
      onAsk={onAsk}
    >
      {(waiting > 0 || tasks.top.length > 0) && (
        <WidgetRows>
          {waiting > 0 && (
            <li>
              <Link to="/tasks" className={widgetRowClass}>
                <WidgetRowContent
                  leading={
                    <MessageSquare
                      aria-hidden="true"
                      className="size-4 text-warning"
                    />
                  }
                  title={copy.tasksWaiting}
                  emphasis
                  badge={<StatusBadge tone="warning">{waiting}</StatusBadge>}
                />
              </Link>
            </li>
          )}
          {tasks.top.map((task) => (
            <li key={task.id}>
              <Link to="/tasks" className={widgetRowClass}>
                <WidgetRowContent
                  leading={
                    <Circle
                      aria-hidden="true"
                      className="size-4 text-muted-foreground"
                    />
                  }
                  title={task.title}
                />
              </Link>
            </li>
          ))}
        </WidgetRows>
      )}
    </WidgetFrame>
  );
}

/** When it was refreshed, or that it is running, waiting, failed or new. */
function ResultState({
  item,
  copy,
  detail,
}: {
  item: HubCard;
  copy: HubCopy;
  detail?: string;
}) {
  const result = item.result;
  const status = result?.status;
  if (status === "running")
    return (
      <span className="flex items-center gap-1.5">
        <Spinner aria-hidden="true" />
        {copy.refreshing}
      </span>
    );
  if (status === "waiting")
    return <StatusBadge tone="warning">{copy.waiting}</StatusBadge>;
  // The badge says it failed; the reason, when known, is in the body.
  if (status === "failed")
    return <StatusBadge tone="danger">{copy.failed}</StatusBadge>;
  if (result?.producedAt)
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <RelativeTime value={result.producedAt} />
        {detail && <span className="truncate">· {detail}</span>}
      </span>
    );
  if (!result && item.refresh === "manual")
    return <StatusBadge tone="warning">{copy.confirm}</StatusBadge>;
  return <>{copy.never}</>;
}

function RefreshButton({
  copy,
  disabled,
  onRefresh,
}: {
  copy: HubCopy;
  disabled: boolean;
  onRefresh: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={copy.refresh}
      disabled={disabled}
      onClick={onRefresh}
    >
      <RefreshCw aria-hidden="true" />
    </Button>
  );
}

/** The step that fixes a failed widget: the app's connect flow, or the
 * administration page (another app, so a plain link). */
function FixAction({ fix, copy }: { fix: HubFix; copy: HubCopy }) {
  return (
    <Button variant="outline" size="sm" className="self-start" asChild>
      {fix.kind === "connect" ? (
        fix.serviceId ? (
          <Link
            to="/connections/$serviceId"
            params={{ serviceId: fix.serviceId }}
          >
            <PlugZap data-icon="inline-start" aria-hidden="true" />
            {copy.fix.connectAction}
          </Link>
        ) : (
          <Link to="/connections">
            <PlugZap data-icon="inline-start" aria-hidden="true" />
            {copy.fix.connectAction}
          </Link>
        )
      ) : (
        <a href={fix.href}>{copy.fix[fix.label]}</a>
      )}
    </Button>
  );
}

/** Why a widget couldn't fill, in one muted line, and the fix beside it. */
function WidgetProblem({
  problem,
  copy,
}: {
  problem: ReturnType<typeof hubWidgetProblem>;
  copy: HubCopy;
}) {
  if (!problem.fix && problem.text === copy.errors.other) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="widget-error">
      <p className="text-sm text-muted-foreground">{problem.text}</p>
      {problem.fix && <FixAction fix={problem.fix} copy={copy} />}
    </div>
  );
}

/** A refused overview change; widget sources get the same fix as a fill. */
function ChangeProblem({
  copy,
  error,
  isAdmin,
}: {
  copy: HubCopy;
  error: { code: string; sources: { id: string }[] };
  isAdmin: boolean;
}) {
  const problem = hubWidgetProblem(copy, error.code, {
    sources: error.sources,
    isAdmin,
  });
  return (
    <Alert variant="destructive" data-testid="hub-error">
      <AlertDescription>
        {problem.fix || error.code in copy.errors
          ? problem.text
          : copy.changeFailed}
      </AlertDescription>
      {problem.fix && (
        <AlertAction>
          <FixAction fix={problem.fix} copy={copy} />
        </AlertAction>
      )}
    </Alert>
  );
}

/** A widget of a registered type: its renderer shows the data the server filled. */
function TypedWidget({
  item,
  session,
  frame,
  disabled,
  onRefresh,
  onAsk,
  onAskAbout,
}: {
  item: HubCard;
  session: ClientSession;
  frame: WidgetFrameState;
  disabled: boolean;
  onRefresh: () => void;
  onAsk: (text: string) => void;
  onAskAbout: (name: string, detail?: string) => void;
}) {
  const copy = useHubCopy();
  const { language, isAdmin } = useApp();
  const widget = item.widget!;
  const definition = hubWidgetDefinition(widget.type);
  const renderer = widgetRenderer(widget.type);
  const known =
    !!definition && !!renderer && definition.version === widget.version;
  const config = known
    ? (hubWidgetConfig(widget.type, widget.config) ??
      (definition.defaultConfig as Record<string, unknown>))
    : {};
  const detail = known ? (renderer.describe?.(config, language) ?? "") : "";
  const ai = definition?.fill === "ai";
  const result = item.result;
  const status = result?.status;
  const running = status === "running";
  const confirm = ai && !result && item.refresh === "manual";
  const data = widget.data ?? (definition?.fill === "client" ? {} : null);
  const Body = renderer?.Body;
  const body = (expanded: boolean) => (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {!known ? (
        <p className="text-sm text-muted-foreground">{copy.unknownType}</p>
      ) : (
        <>
          {status === "failed" && (
            <WidgetProblem
              problem={hubWidgetProblem(copy, result?.error, {
                sources: widget.sources,
                isAdmin,
              })}
              copy={copy}
            />
          )}
          {data !== null && Body ? (
            <Body
              data={data}
              config={config}
              item={item}
              language={language}
              ask={onAsk}
              session={session}
              expanded={expanded}
              onExpand={frame.onExpand}
            />
          ) : running ? (
            <Skeleton className="min-h-10 w-full flex-1" />
          ) : null}
          {confirm && !running && (
            <Button
              size="sm"
              className="self-start"
              disabled={disabled}
              onClick={onRefresh}
            >
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              {copy.refresh}
            </Button>
          )}
        </>
      )}
    </div>
  );
  return (
    <WidgetFrame
      testId="hub-widget"
      type={widget.type}
      status={ai ? (status ?? "never") : undefined}
      title={item.title}
      description={
        ai ? (
          <ResultState
            item={item}
            copy={copy}
            detail={
              widget.recipe?.services.length
                ? copy.from(widget.recipe.services.join(", "))
                : undefined
            }
          />
        ) : (
          detail
        )
      }
      action={
        ai ? (
          <RefreshButton
            copy={copy}
            disabled={disabled || running}
            onRefresh={onRefresh}
          />
        ) : undefined
      }
      onAsk={() => onAskAbout(item.title, detail)}
      frame={frame}
      tall={renderer?.tall === true}
      large={frame.expanded ? body(true) : undefined}
    >
      {body(false)}
    </WidgetFrame>
  );
}

function ProcessWidget({
  item,
  frame,
  disabled,
  onRefresh,
  onConfigure,
  onAsk,
}: {
  item: HubCard;
  frame: WidgetFrameState;
  disabled: boolean;
  onRefresh: () => void;
  onConfigure: () => void;
  onAsk: () => void;
}) {
  const copy = useHubCopy();
  const result = item.result;
  const status = result?.status;
  const running = status === "running";
  // Added by the assistant: nothing runs until the person refreshes it.
  const confirm = !result && item.refresh === "manual";
  const mismatch =
    !!item.fields &&
    "error" in hubResolveView(item.view, "process", item.fields);
  return (
    <WidgetFrame
      testId="hub-item"
      status={status ?? "never"}
      title={item.title}
      description={<ResultState item={item} copy={copy} />}
      action={
        <RefreshButton
          copy={copy}
          disabled={disabled || running}
          onRefresh={onRefresh}
        />
      }
      onAsk={onAsk}
      frame={frame}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {status === "failed" &&
          hubErrorText(copy, result?.error) !== copy.errors.other && (
            <p className="text-sm text-muted-foreground">
              {hubErrorText(copy, result?.error)}
            </p>
          )}
        {(status === "waiting" || status === "failed") &&
          result?.conversationId && (
            <Button variant="outline" size="sm" className="self-start" asChild>
              <Link
                to="/chat/$conversationId"
                params={{ conversationId: result.conversationId }}
              >
                <MessageSquare data-icon="inline-start" aria-hidden="true" />
                {copy.openChat}
              </Link>
            </Button>
          )}
        {mismatch ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">{copy.mismatch}</p>
            <Button variant="outline" size="sm" onClick={onConfigure}>
              {copy.configure}
            </Button>
          </div>
        ) : item.view.type === "summary" ? (
          result?.output ? (
            <HubOutputView output={result.output} copy={copy} />
          ) : running ? (
            <Skeleton className="h-10 w-full" />
          ) : status === "succeeded" ? (
            <p className="text-sm text-muted-foreground">{copy.empty}</p>
          ) : null
        ) : item.data ? (
          <WidgetData view={item.view} data={item.data} copy={copy} />
        ) : running ? (
          <Skeleton className="min-h-10 w-full flex-1" />
        ) : result?.producedAt ? (
          <p className="text-sm text-muted-foreground">{copy.empty}</p>
        ) : null}
        {confirm && !running && (
          <Button
            size="sm"
            className="self-start"
            disabled={disabled}
            onClick={onRefresh}
          >
            <RefreshCw data-icon="inline-start" aria-hidden="true" />
            {copy.refresh}
          </Button>
        )}
      </div>
    </WidgetFrame>
  );
}

/** One view's data: a number, a list, a table, a chart or text. */
export function WidgetData({
  view,
  data,
  copy,
}: {
  view: HubWidgetView;
  data: HubWidgetData;
  copy: HubCopy;
}) {
  const { language } = useApp();
  const format = (value: number) =>
    new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value);
  const more = (count: number) =>
    count > 0 ? (
      <p className="text-xs text-muted-foreground">
        +{count} {copy.more}
      </p>
    ) : null;
  switch (data.type) {
    case "number": {
      const number = view.type === "number" ? view : null;
      const compare = data.compare?.value;
      const delta =
        compare !== undefined && data.value !== null
          ? data.value - compare
          : undefined;
      return (
        <div className="flex flex-1 flex-col justify-end gap-1">
          <p
            data-testid="hub-number"
            className="text-3xl font-semibold tracking-tight tabular-nums"
          >
            {data.value === null ? "–" : format(data.value)}
            {number?.unit && (
              <span className="ml-1 text-base font-normal text-muted-foreground">
                {number.unit}
              </span>
            )}
          </p>
          {number?.label && (
            <p className="text-sm text-muted-foreground">{number.label}</p>
          )}
          {compare !== undefined &&
            (number?.compare === "previous" ? (
              <p className="text-xs text-muted-foreground tabular-nums">
                {delta !== undefined && (delta > 0 ? "+" : "")}
                {delta !== undefined ? format(delta) : ""} {copy.sincePrevious}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground tabular-nums">
                {copy.of} {format(compare)}
                {typeof number?.compare === "object" &&
                  number.compare.label &&
                  ` ${number.compare.label}`}
              </p>
            ))}
        </div>
      );
    }
    case "text":
      return <Markdown text={data.text} />;
    case "list":
      return (
        <div className="flex flex-col gap-2">
          <ul className="flex flex-col divide-y">
            {data.rows.map((row, index) => (
              <li key={index} className="flex min-w-0 flex-col py-1.5">
                <span className="truncate text-sm">{row.title}</span>
                {row.subtitle && (
                  <span className="truncate text-xs text-muted-foreground">
                    {row.subtitle}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {more(data.more)}
        </div>
      );
    case "table":
      return (
        <div className="flex flex-col gap-2">
          <Table>
            <TableHeader>
              <TableRow>
                {data.columns.map((column) => (
                  <TableHead key={column.key}>{column.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((row, index) => (
                <TableRow key={index}>
                  {row.map((value, column) => (
                    <TableCell key={column}>
                      {typeof value === "number"
                        ? format(value)
                        : typeof value === "boolean"
                          ? value
                            ? "✓"
                            : "✗"
                          : (value ?? "")}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {more(data.more)}
        </div>
      );
    case "chart":
      return (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <HubChart
            kind={view.type === "chart" ? view.chart : "bar"}
            points={data.points}
            label={copy.yLabel}
            other={copy.other}
            language={language}
          />
          {more(data.more)}
        </div>
      );
  }
}

/** Text first, then labelled values; lists stay short with a count of the rest. */
export function HubOutputView({
  output,
  copy,
}: {
  output: HubOutput;
  copy: HubCopy;
}) {
  if (!output.text && !output.fields.length)
    return <p className="text-sm text-muted-foreground">{copy.empty}</p>;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {output.text && <Markdown text={output.text} />}
      {output.fields.length > 0 && (
        <DetailList
          stacked
          items={output.fields.map((field) => ({
            label: field.label,
            value: field.items ? (
              <ul className="flex flex-col gap-1">
                {field.items.map((entry, index) => (
                  <li key={index}>{entry}</li>
                ))}
                {!!field.more && (
                  <li className="text-muted-foreground">
                    +{field.more} {copy.more}
                  </li>
                )}
              </ul>
            ) : (
              field.value
            ),
          }))}
        />
      )}
    </div>
  );
}
