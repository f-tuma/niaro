import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  AudioLines,
  CalendarClock,
  Check,
  ChevronRight,
  ClipboardList,
  MessageSquare,
  MessagesSquare,
  RefreshCw,
  RotateCcw,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { DropdownMenuItem } from "@admin/components/ui/dropdown-menu";
import { Button } from "@admin/components/ui/button";
import { Card } from "@admin/components/ui/card";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Spinner } from "@admin/components/ui/spinner";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@admin/components/ui/alert";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@admin/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@admin/components/ui/tabs";
import { PageHeader } from "@admin/components/console/page";
import { StatusBadge } from "@admin/components/console/status";
import { EntityIcon } from "@admin/components/console/entity-icon";
import {
  ConfirmAction,
  DetailList,
  MoreActions,
} from "@admin/components/console/forms";
import type { ClientSession } from "../../../../packages/client-core/session";
import { HumanTaskCommandQueue } from "../../../../packages/client-core/human-task-command";
import type { KeyValueStorage } from "../../../../packages/client-core/preferences";
import { sameScope, type Scope } from "../../../../packages/protocol";
import type {
  HumanTask,
  HumanTaskCommand,
  HumanTaskTab,
} from "../../../../packages/protocol/human-tasks";
import { en, translate, type TranslationKey } from "../../../../packages/i18n";
import { useApp, useAppSession } from "./context";
import { useAppCopy } from "./copy";
import { useMenuCopy, type MenuCopy } from "./menu-copy";
import { MenuPage, When } from "./menu-page";
import { handOffHumanTask } from "./task-handoff";

/**
 * Saved decisions live for this page only, like the chat caches: nothing
 * private stays in the browser. Shared across visits so leaving Tasks never
 * drops an unconfirmed decision.
 */
const decisions = new Map<string, string>();
const decisionStorage: KeyValueStorage = {
  getItem: async (key) => decisions.get(key) ?? null,
  setItem: async (key, value) => {
    decisions.set(key, value);
  },
};

/** The scope the server confirmed for this person's lists. */
class ConfirmedScope {
  private value: Scope | null = null;
  confirm(scope: Scope) {
    this.value = scope;
  }
  owns(scope: Scope) {
    return !!this.value && sameScope(scope, this.value);
  }
}

/** A server or queue error as copy; unknown codes fall back to a generic one. */
export function taskFailure(error: unknown, fallback: TranslationKey) {
  const code = error instanceof Error ? error.message : error;
  return typeof code === "string" &&
    /^human_task_[a-z_]+$/.test(code) &&
    code in en
    ? (code as TranslationKey)
    : fallback;
}

/** Due, assignee and source on one line: what a row needs at a glance. */
export function taskMeta(task: HumanTask, copy: MenuCopy) {
  return [
    task.assignee,
    task.origin.kind === "meeting"
      ? task.origin.meetingTitle || copy.taskFromMeeting
      : copy.taskFromChat,
  ]
    .filter(Boolean)
    .join(" · ");
}

const decisionCopy = {
  complete: "taskDecisionComplete",
  remove: "taskDecisionRemove",
  reopen: "taskDecisionReopen",
} as const satisfies Record<HumanTaskCommand["decision"], keyof MenuCopy>;

/** Open items to resolve and what is done, like Tasks in the mobile app. */
export function TasksPage() {
  const session = useAppSession();
  return <TaskLibrary key={session.identityKey} session={session} />;
}

function TaskLibrary({ session }: { session: ClientSession }) {
  const { language } = useApp();
  const copy = useMenuCopy();
  const appCopy = useAppCopy();
  const tr = translate(language);
  const navigate = useNavigate();
  const client = useQueryClient();
  const [tab, setTab] = useState<HumanTaskTab>("open");
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<HumanTask | null>(null);
  const [actionError, setActionError] = useState<TranslationKey | null>(null);
  const after = cursors.at(-1);
  // The scope the server confirmed for this person; decisions stay inside it.
  const [scope] = useState(() => new ConfirmedScope());
  const base = ["app", "human-tasks", session.identityKey];
  const query = useQuery({
    queryKey: [...base, tab, after ?? null],
    queryFn: async () => {
      const page = await session.readHumanTasks(tab, after);
      scope.confirm(page.scope);
      return page;
    },
    refetchInterval: 5000,
    retry: false,
    // Counts stay while another list loads; its rows don't.
    placeholderData: (previous) =>
      previous && { ...previous, tasks: [], next: null },
  });
  const [queue] = useState(
    () =>
      new HumanTaskCommandQueue({
        identityKey: session.identityKey,
        storage: decisionStorage,
        uuid: () => crypto.randomUUID(),
        owns: (task) => scope.owns(task.scope),
        submit: (id, command) => session.submitHumanTask(id, command),
        read: (id) => session.readHumanTask(id),
      }),
  );
  useEffect(() => {
    void queue.restore();
  }, [queue]);
  const command = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getSnapshot,
  );
  const refresh = async () => {
    await client.refetchQueries(
      { queryKey: ["app", "human-tasks", session.identityKey] },
      { throwOnError: true },
    );
  };
  const decide = (task: HumanTask, decision: HumanTaskCommand["decision"]) => {
    setSelected(null);
    setActionError(null);
    queue
      .decide(task, decision, refresh)
      .catch((error) =>
        setActionError(taskFailure(error, "human_task_delivery_uncertain")),
      );
  };
  const sending = command.phase === "sending";
  const blocked = command.phase !== "idle" || query.isError;
  const pending = command.pending;
  const loading = query.isPending || query.isPlaceholderData;
  const tasks = loading ? [] : (query.data?.tasks ?? []);
  const counts = query.data?.counts;
  const changeTab = (value: string) => {
    if (value !== "open" && value !== "done") return;
    setTab(value);
    setCursors([]);
  };

  return (
    <MenuPage>
      <PageHeader title={appCopy.tasks} />
      <Tabs value={tab} onValueChange={changeTab}>
        <TabsList variant="line" aria-label={copy.tasksTabs}>
          <TabsTrigger value="open">
            {copy.tasksOpen}
            {counts ? <Count value={counts.open} /> : null}
          </TabsTrigger>
          <TabsTrigger value="done">
            {copy.tasksDone}
            {counts ? <Count value={counts.done} /> : null}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {pending ? (
        <Alert variant={command.error ? "destructive" : "default"}>
          <AlertTitle>
            {copy.taskSavedDecision}:{" "}
            {copy[decisionCopy[pending.command.decision]]}
          </AlertTitle>
          <AlertDescription>
            <span className="line-clamp-2">{pending.task.title}</span>
            {command.error
              ? tr(taskFailure(command.error, "human_task_delivery_uncertain"))
              : tr(sending ? "humanTaskSending" : "humanTaskRetryHint")}
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              disabled={sending}
              onClick={() => void queue.retry(refresh)}
            >
              {sending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
              )}
              {copy.taskRetryDecision}
            </Button>
          </AlertAction>
        </Alert>
      ) : command.legacyPending ? (
        <Alert variant="destructive">
          <AlertDescription>
            {tr("human_task_legacy_decision")}
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void queue.acknowledgeLegacyDecision()}
            >
              {copy.taskReviewLegacy}
            </Button>
          </AlertAction>
        </Alert>
      ) : command.error || actionError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {tr(
              actionError ??
                taskFailure(command.error, "human_task_delivery_uncertain"),
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {query.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {tr(taskFailure(query.error, "human_task_load_failed"))}
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
            >
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              {copy.retry}
            </Button>
          </AlertAction>
        </Alert>
      ) : loading ? (
        <div role="status" aria-label={tr("humanTaskLoading")}>
          <Skeleton className="h-40 w-full" />
        </div>
      ) : tasks.length ? (
        <Card
          variant="list"
          aria-label={tab === "open" ? copy.tasksOpen : copy.tasksDone}
        >
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              copy={copy}
              disabled={sending}
              saving={
                sending && pending?.task.id === task.id
                  ? pending.command.decision
                  : undefined
              }
              onOpen={() => setSelected(task)}
            />
          ))}
        </Card>
      ) : (
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {tab === "open" ? <ClipboardList /> : <Check />}
            </EmptyMedia>
            <EmptyTitle>
              {tab === "open" ? copy.tasksEmptyOpen : copy.tasksEmptyDone}
            </EmptyTitle>
          </EmptyHeader>
          {tab === "open" && (
            <EmptyContent>
              <Button variant="outline" asChild>
                <Link to="/chat">
                  <MessagesSquare data-icon="inline-start" aria-hidden="true" />
                  {copy.openChat}
                </Link>
              </Button>
            </EmptyContent>
          )}
        </Empty>
      )}
      {cursors.length || query.data?.next ? (
        <div className="flex justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!cursors.length || loading}
            onClick={() => setCursors(cursors.slice(0, -1))}
          >
            {copy.previous}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!query.data?.next || loading}
            onClick={() =>
              query.data?.next && setCursors([...cursors, query.data.next])
            }
          >
            {copy.next}
          </Button>
        </div>
      ) : null}
      <TaskSheet
        task={selected}
        copy={copy}
        language={language}
        disabled={blocked}
        onClose={() => setSelected(null)}
        onDecide={decide}
        onResolve={(task) => {
          handOffHumanTask(task);
          setSelected(null);
          void navigate({ to: "/chat" });
        }}
      />
    </MenuPage>
  );
}

function Count({ value }: { value: number }) {
  return <span className="text-muted-foreground tabular-nums">{value}</span>;
}

function SourceIcon({ task }: { task: HumanTask }) {
  if (task.status === "done") return <Check />;
  if (task.status === "removed") return <X />;
  return task.origin.kind === "meeting" ? <AudioLines /> : <MessageSquare />;
}

/** One item: what is to be resolved, where it came from, when it's due. */
function TaskRow({
  task,
  copy,
  disabled,
  saving,
  onOpen,
}: {
  task: HumanTask;
  copy: MenuCopy;
  disabled: boolean;
  saving?: HumanTaskCommand["decision"];
  onOpen(): void;
}) {
  const closedByAgent =
    task.resolution?.by === "agent" ? copy.taskClosedByAgent : null;
  return (
    <Item asChild variant="row" size="row">
      <button
        type="button"
        className="text-left"
        disabled={disabled}
        onClick={onOpen}
      >
        <ItemMedia>
          <EntityIcon size="sm" tone="muted">
            <SourceIcon task={task} />
          </EntityIcon>
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{task.title}</ItemTitle>
          <ItemDescription>
            {[taskMeta(task, copy), closedByAgent].filter(Boolean).join(" · ")}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          {saving ? (
            <StatusBadge tone="neutral">{copy.taskSaving}</StatusBadge>
          ) : task.status === "done" ? (
            <StatusBadge tone="success">{copy.taskStatusDone}</StatusBadge>
          ) : task.status === "removed" ? (
            <StatusBadge tone="neutral">{copy.taskStatusRemoved}</StatusBadge>
          ) : task.due ? (
            <span className="flex max-w-32 items-center gap-1 text-xs text-muted-foreground">
              <CalendarClock aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="sr-only">{copy.taskDue}: </span>
              <span className="truncate">{task.due}</span>
            </span>
          ) : null}
          <ChevronRight
            aria-hidden="true"
            className="size-4 text-muted-foreground"
          />
        </ItemActions>
      </button>
    </Item>
  );
}

/** The task with its facts and the same actions as the mobile task sheet. */
function TaskSheet({
  task,
  copy,
  language,
  disabled,
  onClose,
  onDecide,
  onResolve,
}: {
  task: HumanTask | null;
  copy: MenuCopy;
  language: "en" | "cs";
  disabled: boolean;
  onClose(): void;
  onDecide(task: HumanTask, decision: HumanTaskCommand["decision"]): void;
  onResolve(task: HumanTask): void;
}) {
  const origin = task?.origin;
  const quote = origin?.kind === "meeting" ? origin.sources[0] : undefined;
  const [removing, setRemoving] = useState(false);
  return (
    <Sheet
      open={!!task}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent size="lg">
        {task && origin && (
          <>
            <SheetHeader>
              {/* The sheet's close button sits top right; the menu stays left of it. */}
              <div className="flex items-start gap-2 pr-8">
                <SheetTitle className="min-w-0 flex-1">{task.title}</SheetTitle>
                {task.status === "open" && (
                  <MoreActions label={copy.more} size="sm">
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={disabled}
                      onSelect={() => setRemoving(true)}
                    >
                      <Trash2 aria-hidden="true" />
                      {copy.taskRemove}
                    </DropdownMenuItem>
                  </MoreActions>
                )}
              </div>
              <SheetDescription>
                {origin.kind === "meeting" ? (
                  <>
                    {copy.taskFromMeeting}:{" "}
                    <Link
                      to="/meetings/$meetingId"
                      params={{ meetingId: origin.meetingId }}
                      className="underline-offset-4 hover:underline"
                    >
                      {origin.meetingTitle}
                    </Link>
                  </>
                ) : (
                  copy.taskFromChat
                )}
              </SheetDescription>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4">
              {task.status !== "open" && (
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge
                    tone={task.status === "done" ? "success" : "neutral"}
                  >
                    {task.status === "done"
                      ? copy.taskStatusDone
                      : copy.taskStatusRemoved}
                  </StatusBadge>
                </div>
              )}
              {task.detail && (
                <p className="text-sm whitespace-pre-wrap">{task.detail}</p>
              )}
              {task.resolution?.by === "agent" && (
                <p className="text-sm text-muted-foreground">
                  {task.resolution.reason
                    ? `${copy.taskClosedByAgent}: ${task.resolution.reason}`
                    : copy.taskClosedByAgent}
                </p>
              )}
              {quote && (
                <figure className="flex flex-col gap-1 border-l-2 pl-3">
                  <blockquote className="text-sm text-muted-foreground italic">
                    “{quote.quote}”
                  </blockquote>
                  {origin.kind === "meeting" && origin.sources.length > 1 && (
                    <figcaption className="text-xs text-muted-foreground">
                      {copy.taskMoreQuotes}
                    </figcaption>
                  )}
                </figure>
              )}
              <DetailList
                items={[
                  ...(task.due
                    ? [
                        {
                          label: copy.taskDue,
                          value: (
                            <span className="inline-flex items-center gap-1.5">
                              <CalendarClock
                                aria-hidden="true"
                                className="size-3.5 text-muted-foreground"
                              />
                              {task.due}
                            </span>
                          ),
                        },
                      ]
                    : []),
                  ...(task.assignee
                    ? [
                        {
                          label: copy.taskAssignee,
                          value: (
                            <span className="inline-flex items-center gap-1.5">
                              <UserRound
                                aria-hidden="true"
                                className="size-3.5 text-muted-foreground"
                              />
                              {task.assignee}
                            </span>
                          ),
                        },
                      ]
                    : []),
                  {
                    label: copy.taskCreated,
                    value: <When value={task.createdAt} language={language} />,
                  },
                  ...(task.resolution
                    ? [
                        {
                          label: copy.taskClosed,
                          value: (
                            <When
                              value={task.resolution.at}
                              language={language}
                            />
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            </div>
            <ConfirmAction
              open={removing}
              onOpenChange={setRemoving}
              title={copy.taskRemoveTitle}
              confirmLabel={copy.taskRemove}
              cancelLabel={copy.cancel}
              onConfirm={() => onDecide(task, "remove")}
            />
            <SheetFooter>
              {task.status === "open" ? (
                <>
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() => onDecide(task, "complete")}
                  >
                    <Check data-icon="inline-start" aria-hidden="true" />
                    {copy.taskComplete}
                  </Button>
                  <Button disabled={disabled} onClick={() => onResolve(task)}>
                    <MessageSquare
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    {copy.taskResolve}
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onDecide(task, "reopen")}
                >
                  <RotateCcw data-icon="inline-start" aria-hidden="true" />
                  {copy.taskReopen}
                </Button>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
