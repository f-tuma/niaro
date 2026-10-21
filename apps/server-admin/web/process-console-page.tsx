import { processDesignRoute } from "./lib/process-routes";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  FlaskConical,
  GitCommitVertical,
  History,
  MessageSquare,
  Power,
  Trash2,
  Workflow,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Badge } from "@admin/components/ui/badge";
import { Card, CardContent } from "@admin/components/ui/card";
import { Spinner } from "@admin/components/ui/spinner";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Checkbox } from "@admin/components/ui/checkbox";
import { Textarea } from "@admin/components/ui/textarea";
import { Field, FieldGroup, FieldLabel } from "@admin/components/ui/field";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@admin/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@admin/components/ui/table";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@admin/components/ui/empty";
import { DropdownMenuItem } from "@admin/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@admin/components/ui/alert-dialog";
import { PageHeader, Section } from "@admin/components/console/page";
import {
  ConfirmAction,
  DetailList,
  MoreActions,
} from "@admin/components/console/forms";
import { archivePersonalProcess } from "./lib/process-archive";
import { EntityIcon } from "@admin/components/console/entity-icon";
import {
  StatusBadge,
  StatusDot,
  type Tone,
} from "@admin/components/console/status";
import { RelativeTime } from "@admin/components/console/time";
import { useAdmin } from "./context";
import { useCatalog, CatalogBoundary } from "./catalog-shared";
import { useProcessHost } from "./process-host";
import {
  ProcessConsoleClient,
  type ProcessConsoleScope,
  type ProcessConsoleState,
} from "./lib/process-console-client";
import {
  readSuiteDraft,
  parseSuiteDraft,
  suiteToDraft,
} from "./lib/process-test-suite";
import { sameProcessDefinition } from "./lib/service-process-overview";
import {
  NativeTestSuiteSchema,
  type NativeTestRequest,
} from "../../../packages/protocol/process-native-testing";
import { TestJsonSchema } from "../../../packages/protocol/process-testing";
import { SuiteEditor, SuiteChoice } from "./process-test-suite";
import { testEn, testCs } from "./process-test-copy";
import { NativeTestReportView } from "./process-test-report";
import {
  Disclosure,
  JsonDetail,
  ProcessDefinitionSummary,
} from "./process-design-review";
import { designEn, designCs } from "./process-design-copy";
import { consoleEn, consoleCs, consoleProblem } from "./process-console-copy";

export function ProcessConsolePage() {
  const admin = useAdmin(),
    state = useCatalog(),
    { serviceId, processId } = useParams({ strict: false });
  const copy = admin.language === "cs" ? consoleCs : consoleEn;
  const service = state.query.data?.services.find((s) => s.id === serviceId),
    userId = state.scope.identity.data?.user?.id;
  const scope: ProcessConsoleScope = {
    ...state.target,
    serviceId: serviceId ?? "",
    processId: processId ?? "",
    userId: userId ?? "",
    authority: [
      admin.authorityGeneration,
      admin.data.authentication.current,
      admin.data.authentication.principalId,
      admin.data.authentication.expiresAt,
      userId,
      state.scope.organization?.role,
    ].join(":"),
  };
  return (
    <CatalogBoundary state={state}>
      {(serviceId ? service : true) &&
      processId &&
      userId &&
      state.query.data?.canManage &&
      admin.data.authentication.current === "better-auth" ? (
        <ProcessConsoleRuntime
          key={JSON.stringify(scope)}
          scopeJson={JSON.stringify(scope)}
          serviceName={service?.name}
          language={admin.language}
          refreshGeneration={admin.refreshGeneration}
        />
      ) : (
        <Alert variant="destructive">
          <AlertDescription>{copy.authority}</AlertDescription>
        </Alert>
      )}
    </CatalogBoundary>
  );
}
/** One process's overview, tests, versions and activation for a fixed scope;
 * the console and the web app (personal processes) mount it. */
export function ProcessConsoleRuntime({
  scopeJson,
  serviceName,
  language,
  refreshGeneration,
}: {
  scopeJson: string;
  serviceName?: string;
  language: "en" | "cs";
  /** Bumps when the surrounding page asks for fresh data. */
  refreshGeneration: number;
}) {
  const [client] = useState(
    () => new ProcessConsoleClient(JSON.parse(scopeJson), sessionStorage),
  );
  useEffect(() => {
    client.attach();
    return () => client.dispose();
  }, [client]);
  useEffect(() => {
    void client.refresh();
  }, [client, refreshGeneration]);
  return (
    <Workspace client={client} serviceName={serviceName} language={language} />
  );
}
type Dialog =
  | { kind: "freeze"; revision: number }
  | { kind: "freezeTest"; revision: number }
  | {
      kind: "test";
      request: NativeTestRequest;
      suite: string;
      fingerprint: string;
      retest: boolean;
    }
  | {
      kind: "decision";
      type: "activate" | "rollback";
      review: NonNullable<ProcessConsoleState["review"]>;
    };
const testTone: Record<string, Tone> = {
  running: "info",
  completed: "success",
  failed: "danger",
  interrupted: "warning",
};
function Workspace({
  client,
  serviceName,
  language,
}: {
  client: ProcessConsoleClient;
  serviceName?: string;
  language: "en" | "cs";
}) {
  const { adminLinks, personalOnly } = useProcessHost(),
    baseCopy = language === "cs" ? consoleCs : consoleEn,
    // Members can't change limits; the budget message sends them to an admin.
    copy =
      adminLinks === "none"
        ? { ...baseCopy, budget: baseCopy.budgetMember }
        : baseCopy,
    testCopy = language === "cs" ? testCs : testEn,
    designCopy = language === "cs" ? designCs : designEn,
    state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [dialog, setDialog] = useState<Dialog | null>(null),
    [ack, setAck] = useState(false),
    // A hand-off (e.g. "Test it" after saving in the designer) picks the tab.
    [tab, setTab] = useState<string>(
      useRouterState({ select: (s) => s.location.state.processTab }) ??
        "overview",
    ),
    [importText, setImportText] = useState(""),
    [suiteError, setSuiteError] = useState(false),
    [deleting, setDeleting] = useState(false),
    [deleteFailed, setDeleteFailed] = useState(false);
  const navigate = useNavigate();
  const queries = useQueryClient();
  const p = state.process,
    artifact = client.artifact;
  let baseline = "",
    configuredOnly = false,
    suiteValid = false;
  try {
    const draft = readSuiteDraft(state.suite);
    baseline =
      draft.comparisonMode === "configured_only" ? "" : draft.genericModelId;
    configuredOnly =
      parseSuiteDraft(state.suite).comparisonMode === "configured_only" &&
      artifact?.definition.kind === "workflow" &&
      !artifact.definition.steps.some((step) => step.type === "agent");
    suiteValid = true;
  } catch {
    /* Fields remain editable. */
  }
  useEffect(() => {
    if (baseline && state.selectedVersion) void client.refresh();
  }, [client, baseline, state.selectedVersion]);
  const running =
    state.job?.status === "running" || state.pending?.kind === "test";
  useEffect(() => {
    if (!running || state.loading || state.denied) return;
    const timer = setTimeout(
      () => void client.refresh(),
      state.error ? 10000 : 3000,
    );
    return () => clearTimeout(timer);
  }, [client, running, state.loading, state.denied, state.error, state.job]);
  useEffect(
    () =>
      client.subscribe(() => {
        const next = client.getSnapshot();
        const current = next.process;
        setDialog((previous) => {
          if (!previous) return previous;
          const stale =
            client.blocked ||
            !current ||
            ((previous.kind === "freeze" || previous.kind === "freezeTest") &&
              previous.revision !== current.revision) ||
            (previous.kind === "test" &&
              (previous.request.revision !== current.revision ||
                previous.request.version !== next.selectedVersion ||
                previous.request.artifactDigest !== client.artifact?.digest ||
                previous.suite !== next.suite ||
                previous.fingerprint !== next.capabilities?.fingerprint)) ||
            (previous.kind === "decision" &&
              JSON.stringify(previous.review) !== JSON.stringify(next.review));
          return stale ? null : previous;
        });
        if (next.denied) {
          setAck(false);
          setImportText("");
          setSuiteError(false);
        }
      }),
    [client],
  );
  const open = (next: Dialog) => {
    setAck(false);
    setDialog(next);
  };
  const decisionLabel = (type: "activate" | "rollback") =>
    type === "rollback"
      ? copy.rollback
      : state.review?.activeVersion === state.review?.version
        ? copy.reaccept
        : copy.activate;
  const versionLabel = (version: number) =>
    `v${version}${p?.activeVersion === version ? ` · ${copy.activeTag}` : ""}`;
  // The draft is frozen when it matches the latest version exactly.
  const latest = p
    ? state.versions.find((v) => v.version === p.latestVersion)
    : undefined;
  const unfrozen =
    !!p &&
    (p.latestVersion === 0 ||
      (!!latest && !sameProcessDefinition(p.draft, latest.definition)));
  const next: "freeze" | "activate" | "test" = unfrozen
    ? "freeze"
    : state.review?.canActivate
      ? "activate"
      : "test";
  // Tests refuse to start without the workspace's AI budget; say so first.
  const budgetMissing = state.capabilities?.budgetReady === false;
  const runnable =
    !client.blocked &&
    !budgetMissing &&
    suiteValid &&
    (configuredOnly || !!state.tools);
  // A changed draft is tested as a new version: "Run test" freezes it first,
  // unless the person deliberately selected an older version.
  const freezeFirst =
    unfrozen && !!artifact && artifact.version === p?.latestVersion;
  const isRetest =
    !freezeFirst && !!artifact && p?.activeVersion === artifact.version;
  const runTest = () => {
    if (freezeFirst && p) {
      open({ kind: "freezeTest", revision: p.revision });
      return;
    }
    try {
      const request = client.prepareTest(isRetest);
      if (request)
        open({
          kind: "test",
          request,
          suite: state.suite,
          fingerprint: state.capabilities?.fingerprint ?? "",
          retest: isRetest,
        });
      else setSuiteError(true);
    } catch {
      setSuiteError(true);
    }
  };
  // The owner deletes (archives) their personal process, then returns to the list.
  const remove = async () => {
    if (!p) return;
    setDeleteFailed(false);
    try {
      await archivePersonalProcess(client.scope, p);
      await queries.invalidateQueries({
        queryKey: ["app", "personal-processes"],
      });
      void navigate({ to: "/processes" });
    } catch {
      setDeleteFailed(true);
      void client.refresh();
    }
  };
  const decide = (type: "activate" | "rollback") =>
    state.review && open({ kind: "decision", type, review: state.review });
  const reviewTest = state.review
    ? state.history.find((t) => t.testId === state.review!.testId)
    : undefined;
  const KindIcon = p?.kind === "agent" ? Bot : Workflow;
  const hasVersions = state.versions.length > 0;
  const freeze = () => p && open({ kind: "freeze", revision: p.revision });
  // The one next step of the flow: version → test → activate. On the tests
  // tab the section's own buttons carry it, so the header stays quiet there.
  const primary = !p ? null : next === "freeze" && !hasVersions ? (
    <Button disabled={client.blocked} onClick={freeze}>
      <GitCommitVertical data-icon="inline-start" aria-hidden="true" />
      {copy.freeze}
    </Button>
  ) : tab === "tests" ? null : next === "activate" ? (
    <Button disabled={client.blocked} onClick={() => decide("activate")}>
      <Power data-icon="inline-start" aria-hidden="true" />
      {decisionLabel("activate")}
    </Button>
  ) : hasVersions && (unfrozen || p.activeVersion !== p.latestVersion) ? (
    <Button onClick={() => setTab("tests")}>
      <FlaskConical data-icon="inline-start" aria-hidden="true" />
      {copy.goTest}
    </Button>
  ) : null;
  // A new version is created to be tested: go there.
  const frozenVersion = state.freezeReceipt?.version;
  const [seenFrozen, setSeenFrozen] = useState(frozenVersion);
  if (frozenVersion !== seenFrozen) {
    setSeenFrozen(frozenVersion);
    if (frozenVersion) setTab("tests");
  }
  const shownTab = tab === "tests" && !hasVersions ? "overview" : tab;
  // Someone else's or a workspace process is managed in administration.
  const foreign =
    !!personalOnly &&
    !!p &&
    !(
      "owner" in p &&
      p.owner.type === "user" &&
      p.owner.userId === client.scope.userId
    );
  const noVersions = (
    <Empty variant="outline">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <History aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{copy.noVersions}</EmptyTitle>
      </EmptyHeader>
      {p && !state.denied && (
        <EmptyContent>
          <Button variant="outline" disabled={client.blocked} onClick={freeze}>
            <GitCommitVertical data-icon="inline-start" aria-hidden="true" />
            {copy.freeze}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  );
  if (foreign)
    return (
      <div className="flex flex-col gap-6" data-process-console>
        <PageHeader
          title={p.name}
          back={{ to: "/processes", label: copy.processes }}
        />
        <Alert>
          <AlertDescription>{copy.notPersonal}</AlertDescription>
        </Alert>
      </div>
    );
  return (
    <div className="flex flex-col gap-6" data-process-console>
      <PageHeader
        title={p?.name ?? copy.title}
        description={serviceName}
        back={
          client.scope.serviceId
            ? undefined
            : { to: "/processes", label: copy.processes }
        }
        media={
          <EntityIcon size="lg">
            <KindIcon />
          </EntityIcon>
        }
        meta={
          p && (
            <>
              {p.latestVersion === 0 ? (
                <StatusBadge tone="neutral">{copy.draft}</StatusBadge>
              ) : p.activeVersion ? (
                <span className="text-xs text-muted-foreground">
                  {copy.activeTag} v{p.activeVersion}
                </span>
              ) : (
                <StatusBadge tone="neutral">{copy.noActive}</StatusBadge>
              )}
              {unfrozen && p.latestVersion > 0 && (
                <StatusBadge tone="warning">{copy.draftChanged}</StatusBadge>
              )}
              <span className="text-xs text-muted-foreground">
                {copy.updated} <RelativeTime value={p.updatedAt} />
              </span>
            </>
          )
        }
        actions={
          !state.denied && (
            <>
              <Button asChild variant="outline">
                <Link
                  {...processDesignRoute(client.scope.serviceId)}
                  search={{ processId: client.scope.processId, edit: "canvas" }}
                >
                  <Workflow data-icon="inline-start" aria-hidden="true" />
                  {copy.editOnCanvas}
                </Link>
              </Button>
              {primary}
              <MoreActions label={copy.moreActions}>
                <DropdownMenuItem asChild>
                  <Link
                    {...processDesignRoute(client.scope.serviceId)}
                    search={{ processId: client.scope.processId }}
                  >
                    <MessageSquare aria-hidden="true" />
                    {copy.designer}
                  </Link>
                </DropdownMenuItem>
                {p && !(next === "freeze" && !hasVersions) && (
                  <DropdownMenuItem
                    disabled={client.blocked}
                    onSelect={() =>
                      open({ kind: "freeze", revision: p.revision })
                    }
                  >
                    <GitCommitVertical aria-hidden="true" />
                    {copy.freeze}
                  </DropdownMenuItem>
                )}
                {personalOnly && p && (
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={client.blocked}
                    onSelect={() => setDeleting(true)}
                  >
                    <Trash2 aria-hidden="true" />
                    {copy.delete}
                  </DropdownMenuItem>
                )}
              </MoreActions>
            </>
          )
        }
      />
      {personalOnly && (
        <ConfirmAction
          open={deleting}
          onOpenChange={setDeleting}
          title={copy.deleteTitle}
          description={copy.deleteHint}
          confirmLabel={copy.delete}
          cancelLabel={copy.cancel}
          onConfirm={remove}
        />
      )}
      {deleteFailed && (
        <Alert variant="destructive">
          <AlertDescription>{copy.deleteFailed}</AlertDescription>
        </Alert>
      )}
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>
            {consoleProblem(state.error, copy)}
          </AlertDescription>
        </Alert>
      )}
      {state.rejected && (
        <Alert variant="destructive">
          <AlertTitle>{copy.rejected}</AlertTitle>
          <AlertDescription>
            <p>{consoleProblem(state.rejected.code, copy)}</p>
            <Disclosure title={copy.technical}>
              <JsonDetail
                value={{
                  code: state.rejected.code,
                  command: state.rejected.command,
                }}
              />
            </Disclosure>
          </AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              onClick={() => client.clearRejection()}
            >
              {copy.dismiss}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {state.pending && (
        <Alert>
          <AlertTitle>{copy.pending}</AlertTitle>
          <AlertDescription>
            <p>{copy.pendingHint}</p>
            <Disclosure title={copy.technical}>
              <JsonDetail
                value={{
                  kind: state.pending.kind,
                  requestId: state.pending.body.requestId,
                  processId: state.pending.body.processId,
                  revision: state.pending.body.revision,
                  ...("version" in state.pending.body
                    ? { version: state.pending.body.version }
                    : {}),
                }}
              />
            </Disclosure>
          </AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              disabled={state.loading}
              onClick={() => void client.refresh()}
            >
              {copy.check}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                state.dispatching ||
                state.loading ||
                !state.fresh ||
                state.job?.status === "running"
              }
              onClick={() => void client.retry()}
            >
              {copy.retry}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {!state.denied && !state.fresh && !state.loading && (
        <Alert>
          <AlertDescription>{copy.stale}</AlertDescription>
        </Alert>
      )}
      {state.freezeReceipt && (
        <Alert>
          <AlertTitle>
            {copy.frozen} v{state.freezeReceipt.version}
          </AlertTitle>
          <AlertDescription>
            <Disclosure title={copy.technical}>
              <JsonDetail value={state.freezeReceipt} />
            </Disclosure>
          </AlertDescription>
        </Alert>
      )}
      {state.decisionReceipt && (
        <Alert>
          <AlertTitle>
            {copy.activated} v{state.decisionReceipt.activeVersion}
          </AlertTitle>
          <AlertDescription>
            <Disclosure title={copy.technical}>
              <JsonDetail value={state.decisionReceipt} />
            </Disclosure>
          </AlertDescription>
        </Alert>
      )}
      {!p && state.loading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        p && (
          <Tabs value={shownTab} onValueChange={setTab}>
            <div className="-mx-4 overflow-x-auto overflow-y-hidden border-b px-4 pt-1 pb-px md:mx-0 md:px-0">
              <TabsList variant="line">
                <TabsTrigger value="overview">{copy.overview}</TabsTrigger>
                <TabsTrigger value="tests" disabled={!hasVersions}>
                  {copy.tests}
                </TabsTrigger>
                <TabsTrigger value="versions">
                  {copy.versions}
                  {state.versions.length > 0 && (
                    <Badge variant="secondary">{p.latestVersion}</Badge>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="overview" className="mt-4">
              {state.capabilities ? (
                <ProcessDefinitionSummary
                  definition={p.draft}
                  capabilities={state.capabilities}
                  copy={designCopy}
                  hideName
                  hideKind
                />
              ) : (
                <Disclosure title={copy.technical}>
                  <JsonDetail value={p.draft} />
                </Disclosure>
              )}
            </TabsContent>
            <TabsContent value="tests" className="mt-4">
              {!artifact ? (
                hasVersions ? (
                  <div className="flex justify-center py-12">
                    <Spinner />
                  </div>
                ) : (
                  noVersions
                )
              ) : (
                <div className="flex flex-col gap-8">
                  <Section
                    title={testCopy.title}
                    toolbar={
                      <div className="w-40">
                        <SuiteChoice
                          label={copy.selected}
                          hideLabel
                          value={String(state.selectedVersion ?? "")}
                          options={state.versions.map((v) => ({
                            value: String(v.version),
                            label: versionLabel(v.version),
                          }))}
                          disabled={state.dispatching || !!state.pending}
                          onChange={(v) => void client.selectVersion(Number(v))}
                        />
                      </div>
                    }
                    actions={
                      <Button
                        variant={
                          (next === "test" || freezeFirst) && runnable
                            ? "default"
                            : "outline"
                        }
                        disabled={!runnable}
                        onClick={runTest}
                      >
                        {copy.run}
                      </Button>
                    }
                  >
                    <div className="flex flex-col gap-4">
                      {budgetMissing && (
                        <Alert>
                          <AlertDescription>{copy.budget}</AlertDescription>
                        </Alert>
                      )}
                      {state.toolsError && (
                        <Alert variant="destructive">
                          <AlertDescription>
                            {consoleProblem(state.toolsError, copy)}
                          </AlertDescription>
                        </Alert>
                      )}
                      {suiteError && (
                        <Alert variant="destructive">
                          <AlertDescription>
                            {copy.invalidSuite}
                          </AlertDescription>
                        </Alert>
                      )}
                      <SuiteEditor
                        value={state.suite}
                        onChange={(v) => client.setSuite(v)}
                        capabilities={state.capabilities}
                        version={artifact}
                        tools={state.tools}
                        disabled={
                          state.dispatching || !!state.pending || state.denied
                        }
                        language={language}
                      />
                      <div className="flex flex-col gap-1">
                        <Disclosure title={copy.import}>
                          <FieldGroup>
                            <Field>
                              <FieldLabel htmlFor="process-suite-import">
                                {copy.import}
                              </FieldLabel>
                              <Textarea
                                id="process-suite-import"
                                value={importText}
                                onChange={(e) => setImportText(e.target.value)}
                                disabled={state.dispatching || !!state.pending}
                                rows={5}
                                spellCheck={false}
                              />
                            </Field>
                            <div>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={state.dispatching || !!state.pending}
                                onClick={() => {
                                  try {
                                    const raw = JSON.parse(importText);
                                    TestJsonSchema.parse(raw);
                                    client.setSuite(
                                      suiteToDraft(
                                        NativeTestSuiteSchema.parse(raw),
                                      ),
                                    );
                                    setSuiteError(false);
                                  } catch {
                                    setSuiteError(true);
                                  }
                                }}
                              >
                                {copy.apply}
                              </Button>
                            </div>
                          </FieldGroup>
                        </Disclosure>
                        {state.tools && (
                          <Disclosure title={copy.tools}>
                            <JsonDetail value={state.tools} />
                          </Disclosure>
                        )}
                      </div>
                    </div>
                  </Section>
                  <Section
                    title={copy.history}
                    count={state.history.length || undefined}
                  >
                    {state.history.length ? (
                      <div className="flex flex-col items-start gap-2">
                        <Card variant="flush" className="w-full">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>{copy.when}</TableHead>
                                <TableHead>{copy.status}</TableHead>
                                <TableHead className="hidden md:table-cell">
                                  {copy.result}
                                </TableHead>
                                <TableHead className="hidden md:table-cell">
                                  {copy.qualification}
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {state.history.map((t) => {
                                const selected =
                                  state.selectedTestId === t.testId;
                                const locked =
                                  state.dispatching || !!state.pending;
                                return (
                                  <TableRow
                                    key={t.testId}
                                    data-state={
                                      selected ? "selected" : undefined
                                    }
                                    aria-selected={selected}
                                    onClick={() =>
                                      !locked &&
                                      void client.selectTest(t.testId)
                                    }
                                  >
                                    <TableCell>
                                      <Button
                                        variant="link"
                                        size="sm"
                                        disabled={locked}
                                        className="-ml-2.5"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          void client.selectTest(t.testId);
                                        }}
                                      >
                                        <RelativeTime value={t.createdAt} />
                                      </Button>
                                    </TableCell>
                                    <TableCell>
                                      <StatusDot tone={testTone[t.status]!}>
                                        {testCopy[`status_${t.status}`]}
                                      </StatusDot>
                                    </TableCell>
                                    <TableCell className="hidden md:table-cell">
                                      {t.reportStatus
                                        ? t.reportStatus === "passed"
                                          ? testCopy.passed
                                          : testCopy.mismatch
                                        : "—"}
                                    </TableCell>
                                    <TableCell className="hidden md:table-cell">
                                      {t.qualification
                                        ? t.qualification.status === "qualified"
                                          ? testCopy.qualified
                                          : testCopy.unqualified
                                        : "—"}
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </Card>
                        {state.nextAfter && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={client.blocked}
                            onClick={() => void client.more("history")}
                          >
                            {copy.more}
                          </Button>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {copy.noTests}
                      </p>
                    )}
                  </Section>
                  {state.job && (
                    <div className="flex flex-col gap-2">
                      <NativeTestReportView
                        job={state.job}
                        diagnostic={state.diagnostic}
                        language={language}
                        actions={
                          state.original && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={client.blocked}
                              onClick={() => client.useOriginalSuite()}
                            >
                              {copy.restore}
                            </Button>
                          )
                        }
                      />
                      {state.original && (
                        <Disclosure title={copy.original}>
                          <JsonDetail value={state.original} />
                        </Disclosure>
                      )}
                    </div>
                  )}
                  <Section
                    title={copy.activation}
                    actions={
                      state.review &&
                      (state.review.canActivate ||
                        state.review.canRollback) && (
                        <>
                          {state.review.canRollback && (
                            <Button
                              variant="outline"
                              disabled={client.blocked}
                              onClick={() => decide("rollback")}
                            >
                              {copy.rollback} v{state.review.version}
                            </Button>
                          )}
                          {state.review.canActivate && (
                            <Button
                              variant={
                                next === "activate" ? "default" : "outline"
                              }
                              disabled={client.blocked}
                              onClick={() => decide("activate")}
                            >
                              {decisionLabel("activate")}
                            </Button>
                          )}
                        </>
                      )
                    }
                  >
                    {state.review ? (
                      <Card>
                        <CardContent>
                          <div className="flex flex-col gap-3">
                            {!state.review.canActivate &&
                              !state.review.canRollback && (
                                <div>
                                  <StatusBadge tone="neutral">
                                    {copy.decisionUnavailable}
                                  </StatusBadge>
                                </div>
                              )}
                            <DetailList
                              items={[
                                {
                                  label: copy.version,
                                  value: `v${state.review.version}`,
                                },
                                {
                                  label: copy.active,
                                  value: state.review.activeVersion
                                    ? `v${state.review.activeVersion}`
                                    : copy.none,
                                },
                                {
                                  label: copy.test,
                                  value: reviewTest ? (
                                    <RelativeTime
                                      value={reviewTest.createdAt}
                                    />
                                  ) : (
                                    "—"
                                  ),
                                },
                                {
                                  label: copy.qualification,
                                  value:
                                    state.review.qualification.status ===
                                    "qualified"
                                      ? testCopy.qualified
                                      : testCopy.unqualified,
                                },
                              ]}
                            />

                            <Disclosure title={copy.technical}>
                              <DetailList
                                items={[
                                  {
                                    label: copy.revision,
                                    value: state.review.revision,
                                  },
                                  {
                                    label: copy.testId,
                                    value: (
                                      <span className="font-mono text-xs">
                                        {state.review.testId}
                                      </span>
                                    ),
                                  },
                                  {
                                    label: copy.digest,
                                    value: (
                                      <span className="font-mono text-xs break-all">
                                        {state.review.artifactDigest}
                                      </span>
                                    ),
                                  },
                                ]}
                              />
                            </Disclosure>
                          </div>
                        </CardContent>
                      </Card>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {state.reviewError
                          ? consoleProblem(state.reviewError, copy)
                          : state.selectedTestId
                            ? copy.qualificationMissing
                            : copy.selectTest}
                      </p>
                    )}
                  </Section>
                </div>
              )}
            </TabsContent>
            <TabsContent value="versions" className="mt-4">
              {state.versions.length ? (
                <div className="flex flex-col gap-8">
                  <div className="flex flex-col items-start gap-2">
                    <Card variant="flush" className="w-full">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{copy.version}</TableHead>
                            <TableHead>{copy.created}</TableHead>
                            <TableHead>{copy.test}</TableHead>
                            <TableHead className="text-right">
                              <span className="sr-only">{copy.active}</span>
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {state.versions.map((v) => {
                            const selected =
                              v.version === state.selectedVersion;
                            const locked = state.dispatching || !!state.pending;
                            return (
                              <TableRow
                                key={v.version}
                                data-state={selected ? "selected" : undefined}
                                aria-selected={selected}
                                onClick={() =>
                                  !locked &&
                                  void client.selectVersion(v.version)
                                }
                              >
                                <TableCell>
                                  <Button
                                    variant="link"
                                    size="sm"
                                    disabled={locked}
                                    className="-ml-2.5"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void client.selectVersion(v.version);
                                    }}
                                  >
                                    v{v.version}
                                  </Button>
                                </TableCell>
                                <TableCell>
                                  <RelativeTime value={v.createdAt} />
                                </TableCell>
                                <TableCell>
                                  <StatusDot
                                    tone={
                                      v.testStatus === "passed"
                                        ? "success"
                                        : v.testStatus === "failed"
                                          ? "danger"
                                          : "neutral"
                                    }
                                  >
                                    {v.testStatus === "passed"
                                      ? designCopy.testPassed
                                      : v.testStatus === "failed"
                                        ? designCopy.testFailed
                                        : designCopy.testUntested}
                                  </StatusDot>
                                </TableCell>
                                <TableCell className="text-right">
                                  {p.activeVersion === v.version && (
                                    <span className="text-xs text-muted-foreground">
                                      {copy.activeTag}
                                    </span>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </Card>
                    {state.nextBefore && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={client.blocked}
                        onClick={() => void client.more("versions")}
                      >
                        {copy.older}
                      </Button>
                    )}
                  </div>
                  {artifact && (
                    <Section title={`${copy.version} ${artifact.version}`}>
                      <div className="flex flex-col gap-2">
                        {state.capabilities && (
                          <ProcessDefinitionSummary
                            definition={artifact.definition}
                            capabilities={state.capabilities}
                            copy={designCopy}
                            hideName
                            hideKind
                            hideTechnical
                          />
                        )}
                        <Disclosure title={copy.technical}>
                          <div className="flex flex-col gap-3">
                            <DetailList
                              items={[
                                {
                                  label: copy.digest,
                                  value: (
                                    <span className="font-mono text-xs break-all">
                                      {artifact.digest}
                                    </span>
                                  ),
                                },
                              ]}
                            />
                            <JsonDetail value={artifact} />
                          </div>
                        </Disclosure>
                      </div>
                    </Section>
                  )}
                </div>
              ) : (
                noVersions
              )}
            </TabsContent>
          </Tabs>
        )
      )}
      <AlertDialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
            setAck(false);
          }
        }}
      >
        <AlertDialogContent className="max-h-dvh overflow-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dialog?.kind === "freeze"
                ? copy.freezeConfirm
                : dialog?.kind === "freezeTest"
                  ? copy.runConfirm
                  : dialog?.kind === "test"
                    ? dialog.retest
                      ? copy.retestConfirm
                      : copy.runConfirm
                    : copy.decisionConfirm}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dialog?.kind === "freeze"
                ? copy.freezeHint
                : dialog?.kind === "freezeTest"
                  ? copy.freezeRunHint
                  : dialog?.kind === "test"
                    ? dialog.retest
                      ? copy.retestHint
                      : copy.runHint
                    : dialog
                      ? `${decisionLabel(dialog.type)} v${dialog.review.version}`
                      : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dialog?.kind === "test" && (
            <>
              <DetailList
                items={[
                  {
                    label: copy.version,
                    value: `v${dialog.request.version}`,
                  },
                  {
                    label: copy.caseCount,
                    value: dialog.request.suite.cases.length,
                  },
                ]}
              />
              <Disclosure title={copy.technical}>
                <JsonDetail value={dialog.request} />
              </Disclosure>
            </>
          )}
          {dialog?.kind === "decision" && (
            <FieldGroup>
              <DetailList
                items={[
                  {
                    label: copy.previous,
                    value: dialog.review.activeVersion
                      ? `v${dialog.review.activeVersion}`
                      : copy.none,
                  },
                  {
                    label: copy.version,
                    value: `v${dialog.review.version}`,
                  },
                ]}
              />
              <Disclosure title={copy.technical}>
                <DetailList
                  items={[
                    { label: copy.revision, value: dialog.review.revision },
                    {
                      label: copy.testId,
                      value: (
                        <span className="font-mono text-xs">
                          {dialog.review.testId}
                        </span>
                      ),
                    },
                    {
                      label: copy.digest,
                      value: (
                        <span className="font-mono text-xs break-all">
                          {dialog.review.artifactDigest}
                        </span>
                      ),
                    },
                    {
                      label: copy.qualificationDigest,
                      value: (
                        <span className="font-mono text-xs break-all">
                          {dialog.review.qualification.qualificationDigest}
                        </span>
                      ),
                    },
                  ]}
                />
              </Disclosure>
              <Field orientation="horizontal">
                <Checkbox
                  id="process-ack"
                  checked={ack}
                  onCheckedChange={(v) => setAck(v === true)}
                />
                <FieldLabel htmlFor="process-ack">
                  {copy.acknowledge}
                </FieldLabel>
              </Field>
            </FieldGroup>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction
              variant={
                dialog?.kind === "decision" && dialog.type === "rollback"
                  ? "destructive"
                  : "default"
              }
              disabled={client.blocked || (dialog?.kind === "decision" && !ack)}
              onClick={() => {
                if (!dialog) return;
                const current = dialog;
                setDialog(null);
                setAck(false);
                if (current.kind === "freeze")
                  void client.freeze(current.revision);
                else if (current.kind === "freezeTest")
                  void client
                    .freezeAndTest(current.revision)
                    .then((tested) => setSuiteError(!tested));
                else if (current.kind === "test")
                  void client.test(current.request);
                else if (ack) void client.decide(current.review, current.type);
              }}
            >
              {dialog?.kind === "freeze"
                ? copy.freeze
                : dialog?.kind === "test" || dialog?.kind === "freezeTest"
                  ? copy.run
                  : dialog
                    ? decisionLabel(dialog.type)
                    : copy.activate}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
