import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Bot,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  Hourglass,
  MessagesSquare,
  Play,
  Plus,
  RefreshCw,
  Workflow,
} from "lucide-react";
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
import { storedDesignSessions } from "../lib/process-design-client";
import { DesignSessions } from "../service-process-overview";
import { designCs, designEn } from "../process-design-copy";
import { PageHeader, Section } from "@admin/components/console/page";
import { StatusBadge, type Tone } from "@admin/components/console/status";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { DetailList } from "@admin/components/console/forms";
import { CodeBlock, Disclosure } from "@admin/components/console/disclosure";
import type { ClientSession } from "../../../../packages/client-core/session";
import type { ProcessExecutionEntry } from "../../../../packages/protocol/process-execution";
import type { WorkItem } from "../../../../packages/protocol";
import { translate, type TranslationKey } from "../../../../packages/i18n";
import { displayFields } from "../../../../packages/ui-catalog/field-format";
import { useApp, useAppSession } from "./context";
import { useAppCopy } from "./copy";
import { useMenuCopy, type MenuCopy } from "./menu-copy";
import { MenuPage, When, useSessionState } from "./menu-page";
import { takeProcessOffer } from "./offer-handoff";
import { ProcessInputForm } from "./process-form";
import {
  loadPersonalProcesses,
  personalProcessAuthority,
  personalProcessRows,
  type PersonalProcess,
  type PersonalProcessState,
} from "./personal-processes";
import {
  ProcessLauncher,
  groupProcesses,
  pendingStart,
  recentRuns,
  sessionFresh,
  type LaunchModel,
} from "./process-launch";
import { processBlockedKey } from "./process-problems";

/** A run's state in a word; a finished run reads "Completed", as in the chat. */
export function runStatusKey(status: WorkItem["status"]): TranslationKey {
  return status === "succeeded"
    ? "nativeSucceeded"
    : (status as TranslationKey);
}

/** Why a failed run stopped, in its result's first line. */
export function runFailure(run: WorkItem) {
  if (run.status !== "failed" || !run.result) return null;
  return run.result.trim().split("\n", 1)[0]?.trim() || null;
}

/** How a run's state reads at a glance. */
export function runTone(status: WorkItem["status"]): Tone {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    case "waiting_input":
    case "waiting_approval":
      return "warning";
    case "queued":
    case "running":
    case "waiting_system":
    case "scheduled":
      return "info";
    default:
      return "neutral";
  }
}

/** Processes the person can start, as in the mobile Processes sheet. */
export function ProcessesPage() {
  const session = useAppSession();
  const { language, workspace } = useApp();
  return (
    <Launcher
      key={`${session.identityKey}:${language}:${workspace.workspaceId}`}
      session={session}
    />
  );
}

function Launcher({ session }: { session: ClientSession }) {
  const { language, workspace, identity, isAdmin } = useApp();
  const copy = useMenuCopy();
  const appCopy = useAppCopy();
  const tr = translate(language);
  const navigate = useNavigate();
  const state = useSessionState(session);
  // A chat offer opens its exact version once; a reload is an ordinary choice.
  const [launcher] = useState(
    () =>
      new ProcessLauncher(
        session,
        language,
        `chat-${crypto.randomUUID()}`,
        takeProcessOffer(),
      ),
  );
  const model = useSyncExternalStore(
    launcher.subscribe,
    launcher.getSnapshot,
    launcher.getSnapshot,
  );
  useEffect(() => () => launcher.dispose(), [launcher]);
  const fresh = sessionFresh(state);
  // Load once the session is live; a later reconnect keeps the loaded list.
  useEffect(() => {
    if (fresh && !model.inventory && !model.loading && !model.error)
      void launcher.load();
  }, [fresh, launcher, model.inventory, model.loading, model.error]);
  const [run, setRun] = useState<WorkItem | null>(null);
  const recovery = pendingStart(state);
  const runs = recentRuns(state);
  const groups = groupProcesses(model.inventory?.processes ?? []);
  // "Mine" lists every personal process, drafts included, from the registry;
  // the start inventory only knows the ones that can start.
  const userId = identity.user?.id ?? "";
  const target = {
    organizationId: workspace.organizationId,
    workspaceId: workspace.workspaceId,
  };
  const authority = personalProcessAuthority(userId, workspace);
  const mine = useQuery({
    queryKey: [
      "app",
      "personal-processes",
      authority,
      target.organizationId,
      target.workspaceId,
    ],
    enabled: !!userId,
    queryFn: ({ signal }) => loadPersonalProcesses(target, userId, signal),
    retry: false,
    staleTime: 0,
  });
  const personal = mine.data
    ? personalProcessRows(mine.data, model.inventory?.processes ?? [])
    : [];
  const sessions = userId
    ? storedDesignSessions(
        { ...target, authority, serviceId: "", owner: "user" },
        sessionStorage,
      )
    : [];
  const designCopy = language === "cs" ? designCs : designEn;
  const notice: TranslationKey | null =
    state.status !== "online" && state.status !== "connecting"
      ? state.status
      : state.answerRecoveryBlocked
        ? "savedProcessAnswerStorageBlocked"
        : state.store?.stale || state.store?.needsSnapshot
          ? "stale"
          : model.notice;
  const sheetOpen = !!model.selected;
  const openChat = (conversationId: string) =>
    void navigate({
      to: "/chat/$conversationId",
      params: { conversationId },
    });

  return (
    <MenuPage>
      <PageHeader
        title={appCopy.processes}
        actions={
          (personal.length > 0 || mine.isError) && (
            <Button asChild>
              <Link to="/processes/design" search={{}}>
                <Plus data-icon="inline-start" aria-hidden="true" />
                {copy.processesNew}
              </Link>
            </Button>
          )
        }
      />
      {notice && (
        <Alert>
          <AlertDescription>{tr(notice)}</AlertDescription>
        </Alert>
      )}
      {recovery && (
        <Alert
          variant={recovery.outcome === "rejected" ? "destructive" : "default"}
        >
          <AlertTitle>
            {recovery.outcome === "unknown"
              ? copy.processUnconfirmed
              : recovery.outcome === "accepted"
                ? copy.processStarted
                : copy.processNotStarted}
            : {recovery.name}
          </AlertTitle>
          <AlertDescription>
            {tr(
              recovery.outcome === "unknown"
                ? "processesUnknown"
                : recovery.outcome === "accepted"
                  ? "processesSavingPending"
                  : "processesRejected",
            )}
            {recovery.error && <span>{tr(recovery.error)}</span>}
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              disabled={
                !recovery.canRetry || recovery.sending || model.retrying
              }
              onClick={() => void launcher.retry(recovery.commandId)}
            >
              {recovery.sending || model.retrying ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
              )}
              {copy.processRetry}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {model.error && !sheetOpen && (
        <Alert variant="destructive">
          <AlertDescription>{tr(model.error)}</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              disabled={!fresh || model.loading}
              onClick={() => void launcher.load()}
            >
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              {copy.retry}
            </Button>
          </AlertAction>
        </Alert>
      )}
      <Section
        id="processes-mine"
        title={copy.processesMine}
        count={personal.length || undefined}
      >
        {mine.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{copy.processesMineFailed}</AlertDescription>
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                disabled={mine.isFetching}
                onClick={() => void mine.refetch()}
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {copy.retry}
              </Button>
            </AlertAction>
          </Alert>
        ) : !mine.data ? (
          <div role="status" aria-label={tr("processesLoading")}>
            <Skeleton className="h-24 w-full" />
          </div>
        ) : personal.length ? (
          <PersonalList
            processes={personal}
            copy={copy}
            language={language}
            disabled={!fresh || model.loading}
            onStart={(entry) => void launcher.open(entry)}
          />
        ) : (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Workflow />
              </EmptyMedia>
              <EmptyTitle>{copy.processesMineEmpty}</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild>
                <Link to="/processes/design" search={{}}>
                  <Plus data-icon="inline-start" aria-hidden="true" />
                  {copy.processesNew}
                </Link>
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </Section>
      <DesignSessions sessions={sessions} serviceId="" copy={designCopy} />
      {!model.inventory
        ? !model.error && (
            <div role="status" aria-label={tr("processesLoading")}>
              <Skeleton className="h-40 w-full" />
            </div>
          )
        : groups.company.length > 0 && (
            <Section
              id="processes-company"
              title={copy.processesCompany}
              count={groups.company.length}
              actions={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={copy.refresh}
                  disabled={!fresh || model.loading}
                  onClick={() => void launcher.load()}
                >
                  {model.loading ? (
                    <Spinner />
                  ) : (
                    <RefreshCw aria-hidden="true" />
                  )}
                </Button>
              }
            >
              <ProcessList
                entries={groups.company}
                copy={copy}
                language={language}
                disabled={!fresh || model.loading}
                isAdmin={isAdmin}
                onOpen={(entry) => void launcher.open(entry)}
              />
            </Section>
          )}
      {runs.length > 0 && (
        <Section
          id="processes-recent"
          title={copy.processesRecent}
          count={runs.length}
        >
          <Card variant="list">
            {runs.slice(0, 10).map((work) => (
              <Item key={work.id} asChild variant="row" size="row">
                <button
                  type="button"
                  className="text-left"
                  onClick={() => setRun(work)}
                >
                  <ItemMedia>
                    <EntityIcon size="sm" tone="muted">
                      <RunIcon status={work.status} />
                    </EntityIcon>
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{work.title}</ItemTitle>
                    {runFailure(work) ? (
                      <ItemDescription>{runFailure(work)}</ItemDescription>
                    ) : (
                      work.native?.process?.startedAt && (
                        <ItemDescription>
                          <When
                            value={work.native.process.startedAt}
                            language={language}
                          />
                        </ItemDescription>
                      )
                    )}
                  </ItemContent>
                  <ItemActions>
                    <StatusBadge tone={runTone(work.status)}>
                      {tr(runStatusKey(work.status))}
                    </StatusBadge>
                  </ItemActions>
                </button>
              </Item>
            ))}
          </Card>
        </Section>
      )}
      <LaunchSheet
        model={model}
        copy={copy}
        language={language}
        disabled={!fresh || model.retrying}
        onClose={() => launcher.close()}
        onReview={(input) => launcher.review(input)}
        onEdit={() => launcher.edit()}
        onStart={() => void launcher.start()}
        onOpenChat={() => {
          const id = model.submission?.conversationId;
          launcher.close();
          if (id) openChat(id);
        }}
      />
      <RunSheet
        run={run}
        copy={copy}
        language={language}
        onClose={() => setRun(null)}
      />
    </MenuPage>
  );
}

function RunIcon({ status }: { status: WorkItem["status"] }) {
  const tone = runTone(status);
  return tone === "success" ? (
    <CircleCheck />
  ) : tone === "danger" ? (
    <CircleX />
  ) : tone === "warning" ? (
    <Hourglass />
  ) : (
    <CircleDashed />
  );
}

export function ProcessList({
  entries,
  copy,
  language,
  disabled,
  isAdmin = false,
  onOpen,
}: {
  entries: readonly ProcessExecutionEntry[];
  copy: MenuCopy;
  language: "en" | "cs";
  disabled: boolean;
  /** An admin's blocked row that needs a new test leads to that test. */
  isAdmin?: boolean;
  onOpen(entry: ProcessExecutionEntry): void;
}) {
  const tr = translate(language);
  return (
    <Card variant="list">
      {entries.map((entry) => {
        const Icon = entry.kind === "agent" ? Bot : Workflow;
        const blocked = entry.availability === "blocked";
        // A missing account is the person's to fix: the row leads there.
        const connect = blocked && entry.reason === "connection_required";
        const retest =
          isAdmin &&
          blocked &&
          (entry.reason === "source_changed" ||
            entry.reason === "qualification_required");
        const content = (
          <>
            <ItemMedia>
              <EntityIcon size="sm" tone={blocked ? "muted" : "glyph"}>
                <Icon />
              </EntityIcon>
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {entry.name}
                <span className="sr-only">
                  ,{" "}
                  {entry.kind === "agent"
                    ? copy.processAgent
                    : copy.processWorkflow}
                </span>
              </ItemTitle>
              {(blocked || entry.description) && (
                <ItemDescription>
                  {blocked
                    ? tr(processBlockedKey(entry.reason))
                    : entry.description}
                </ItemDescription>
              )}
            </ItemContent>
            <ItemActions>
              {blocked && (
                <StatusBadge tone="warning">{copy.processBlocked}</StatusBadge>
              )}
              {(!blocked || connect || retest) && (
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
              )}
            </ItemActions>
          </>
        );
        return (
          <Item key={entry.processId} asChild variant="row" size="row">
            {connect ? (
              <Link to="/connections">{content}</Link>
            ) : retest ? (
              <a href={`/admin/processes/${entry.processId}`}>{content}</a>
            ) : (
              <button
                type="button"
                className="text-left"
                disabled={disabled || blocked}
                onClick={() => onOpen(entry)}
              >
                {content}
              </button>
            )}
          </Item>
        );
      })}
    </Card>
  );
}

const stateTone: Record<PersonalProcessState, Tone> = {
  draft: "neutral",
  tested: "info",
  active: "success",
  blocked: "warning",
};

/**
 * The person's own processes: each row opens the process (versions, tests,
 * activation); one that can start now also gets a start button.
 */
function PersonalList({
  processes,
  copy,
  language,
  disabled,
  onStart,
}: {
  processes: readonly PersonalProcess[];
  copy: MenuCopy;
  language: "en" | "cs";
  disabled: boolean;
  onStart(entry: ProcessExecutionEntry): void;
}) {
  const tr = translate(language);
  const label: Record<PersonalProcessState, string> = {
    draft: copy.processStateDraft,
    tested: copy.processStateTested,
    active: copy.processStateActive,
    blocked: copy.processStateBlocked,
  };
  return (
    <Card variant="list">
      {processes.map((p) => {
        const Icon = p.kind === "agent" ? Bot : Workflow;
        const start = p.start;
        return (
          <Item key={p.id} variant="row" size="row" className="relative">
            <ItemMedia>
              <EntityIcon
                size="sm"
                tone={p.state === "active" ? "glyph" : "muted"}
              >
                <Icon />
              </EntityIcon>
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {/* The whole row opens the process; the start button sits above it. */}
                <Link
                  to="/processes/$processId"
                  params={{ processId: p.id }}
                  className="after:absolute after:inset-0"
                >
                  {p.name}
                  <span className="sr-only">
                    ,{" "}
                    {p.kind === "agent"
                      ? copy.processAgent
                      : copy.processWorkflow}
                  </span>
                </Link>
              </ItemTitle>
              {p.reason && (
                <ItemDescription>
                  {/* Their own process: the person retests it themselves. */}
                  {tr(
                    p.reason === "source_changed"
                      ? "process_source_changed_own"
                      : processBlockedKey(p.reason),
                  )}
                </ItemDescription>
              )}
            </ItemContent>
            <ItemActions>
              <StatusBadge tone={stateTone[p.state]}>
                {label[p.state]}
                {p.state === "active" && ` v${p.activeVersion}`}
              </StatusBadge>
              {start ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="relative"
                  aria-label={`${copy.processStart}: ${p.name}`}
                  disabled={disabled}
                  onClick={() => onStart(start)}
                >
                  <Play aria-hidden="true" />
                </Button>
              ) : (
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
              )}
            </ItemActions>
          </Item>
        );
      })}
    </Card>
  );
}

/** Form → review → start for the chosen process, in a side sheet. */
export function LaunchSheet({
  model,
  copy,
  language,
  disabled,
  onClose,
  onReview,
  onEdit,
  onStart,
  onOpenChat,
}: {
  model: LaunchModel;
  copy: MenuCopy;
  language: "en" | "cs";
  disabled: boolean;
  onClose(): void;
  onReview: Parameters<typeof ProcessInputForm>[0]["onSubmit"];
  onEdit(): void;
  onStart(): void;
  onOpenChat(): void;
}) {
  const tr = translate(language);
  const entry = model.selected;
  const card = model.target?.card ?? null;
  const formId = "process-launch-form";
  const busy = model.phase === "sending" || model.retrying;
  const Icon = entry?.kind === "agent" ? Bot : Workflow;
  return (
    <Sheet
      open={!!entry}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent size="lg">
        {entry && (
          <>
            <SheetHeader>
              <div className="flex items-center gap-3">
                <EntityIcon size="md">
                  <Icon />
                </EntityIcon>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <SheetTitle className="mr-8">{entry.name}</SheetTitle>
                  <SheetDescription>
                    {entry.kind === "agent"
                      ? copy.processAgent
                      : copy.processWorkflow}
                    {" · "}
                    {copy.processVersion} {entry.version}
                  </SheetDescription>
                </div>
              </div>
              {model.offered && (
                <div className="pt-2">
                  <StatusBadge tone="info">{copy.processOffered}</StatusBadge>
                </div>
              )}
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4">
              {entry.description && (
                <p className="text-sm text-muted-foreground">
                  {entry.description}
                </p>
              )}
              {model.error && (
                <Alert variant="destructive">
                  <AlertDescription>{tr(model.error)}</AlertDescription>
                </Alert>
              )}
              {model.phase === "preparing" || !card ? (
                <div
                  role="status"
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <Spinner />
                  {copy.processOpening}
                </div>
              ) : model.phase === "editing" ? (
                <ProcessInputForm
                  key={`${card.formDigest}:${JSON.stringify(model.reviewedInput)}`}
                  id={formId}
                  card={card}
                  language={language}
                  copy={copy}
                  initialInput={model.reviewedInput}
                  disabled={disabled}
                  onSubmit={onReview}
                />
              ) : (
                <ReviewedInput model={model} copy={copy} language={language} />
              )}
            </div>
            <SheetFooter>
              {model.phase === "editing" ? (
                <Button type="submit" form={formId} disabled={disabled}>
                  {copy.processReview}
                </Button>
              ) : model.phase === "review" || model.phase === "sending" ? (
                <>
                  <Button
                    variant="ghost"
                    disabled={disabled || busy}
                    onClick={onEdit}
                  >
                    {copy.processEdit}
                  </Button>
                  <Button disabled={disabled || busy} onClick={onStart}>
                    {busy ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <Play data-icon="inline-start" aria-hidden="true" />
                    )}
                    {busy ? copy.processStarting : copy.processStart}
                  </Button>
                </>
              ) : model.phase === "accepted" ? (
                <>
                  <Button variant="ghost" onClick={onClose}>
                    {copy.close}
                  </Button>
                  <Button onClick={onOpenChat}>
                    <MessagesSquare
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    {copy.openChat}
                  </Button>
                </>
              ) : model.phase === "rejected" ? (
                <Button variant="outline" disabled={disabled} onClick={onEdit}>
                  {copy.processEdit}
                </Button>
              ) : null}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** What will be sent, as readable rows; the exact JSON stays in Details. */
function ReviewedInput({
  model,
  copy,
  language,
}: {
  model: LaunchModel;
  copy: MenuCopy;
  language: "en" | "cs";
}) {
  const tr = translate(language);
  const input = model.reviewedInput ?? {};
  const rows = displayFields(
    Object.entries(input).map(([label, value]) => ({
      label,
      value: typeof value === "string" ? value : JSON.stringify(value),
    })),
    language,
  );
  return (
    <div className="flex flex-col gap-5">
      {model.phase === "accepted" ? (
        <Alert>
          <CircleCheck aria-hidden="true" />
          <AlertTitle>{copy.processStarted}</AlertTitle>
        </Alert>
      ) : model.phase === "rejected" ? (
        <Alert variant="destructive">
          <AlertTitle>{copy.processNotStarted}</AlertTitle>
          <AlertDescription>{tr("processesRejected")}</AlertDescription>
        </Alert>
      ) : null}
      <Section title={copy.processInputs}>
        {rows.length ? (
          <DetailList
            items={rows.map((row) => ({
              label: row.label,
              value: row.items ? row.items.join(", ") : row.value,
            }))}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {copy.processNoInputs}
          </p>
        )}
      </Section>
      <Disclosure title={copy.details}>
        <CodeBlock value={input} />
      </Disclosure>
    </div>
  );
}

/** A recent run: its state and the chat it continues in. */
function RunSheet({
  run,
  copy,
  language,
  onClose,
}: {
  run: WorkItem | null;
  copy: MenuCopy;
  language: "en" | "cs";
  onClose(): void;
}) {
  const tr = translate(language);
  return (
    <Sheet
      open={!!run}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent size="lg">
        {run && (
          <>
            <SheetHeader>
              <SheetTitle className="mr-8">{run.title}</SheetTitle>
              {run.context && (
                <SheetDescription>{run.context}</SheetDescription>
              )}
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4">
              <DetailList
                items={[
                  {
                    label: copy.processRunStatus,
                    value: (
                      <StatusBadge tone={runTone(run.status)}>
                        {tr(runStatusKey(run.status))}
                      </StatusBadge>
                    ),
                  },
                  ...(run.native?.process?.startedAt
                    ? [
                        {
                          label: copy.processRunStarted,
                          value: (
                            <When
                              value={run.native.process.startedAt}
                              language={language}
                            />
                          ),
                        },
                      ]
                    : []),
                ]}
              />
              {run.result && (
                <p className="text-sm whitespace-pre-wrap">{run.result}</p>
              )}
            </div>
            <SheetFooter>
              <Button asChild>
                <Link
                  to="/chat/$conversationId"
                  params={{ conversationId: run.conversationId }}
                  onClick={onClose}
                >
                  <MessagesSquare data-icon="inline-start" aria-hidden="true" />
                  {copy.openChat}
                </Link>
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
