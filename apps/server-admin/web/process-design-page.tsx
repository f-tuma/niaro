import { processDesignRoute, processConsoleRoute } from "./lib/process-routes";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  InferenceBudgetPolicySchema,
  type InferenceBudgetPolicy,
} from "../../../packages/protocol/inference-budget";
import { api } from "./lib/api";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
  useBlocker,
} from "@tanstack/react-router";
import { z } from "zod";
import { FlaskConical, Plus, SendHorizontal, Workflow } from "lucide-react";
import { IdentityId } from "../../../packages/protocol/identity";
import type { OwnedDesignReview as DesignReview } from "../../../packages/protocol/process-design";
import { Button } from "@admin/components/ui/button";
import { Textarea } from "@admin/components/ui/textarea";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@admin/components/ui/tabs";
import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
} from "@admin/components/ui/card";
import { Field, FieldLabel } from "@admin/components/ui/field";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@admin/components/ui/empty";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@admin/components/ui/select";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Spinner } from "@admin/components/ui/spinner";
import { Markdown } from "@admin/components/ui/markdown";
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
import { PageHeader } from "@admin/components/console/page";
import { StatusBadge, type Tone } from "@admin/components/console/status";
import { ProcessVisualEditor } from "./process-visual-editor";
import { useProcessEditsGuard } from "./process-edits-guard";
import { useIsWide } from "./hooks/use-mobile";
import { useAdmin } from "./context";
import { AdminLink, useProcessHost } from "./process-host";
import {
  useCatalog,
  CatalogBoundary,
  type CatalogState,
} from "./catalog-shared";
import {
  ProcessDesignClient,
  type DesignClientScope,
} from "./lib/process-design-client";
import {
  designEn,
  designCs,
  designProblem,
  type DesignCopy,
} from "./process-design-copy";
import {
  ProcessDesignReview,
  Disclosure,
  JsonDetail,
} from "./process-design-review";

import {
  ServiceProcessOverview,
  processAuthority,
} from "./service-process-overview";

export const designSearchSchema = z
  .object({
    sessionId: IdentityId.optional(),
    processId: IdentityId.optional(),
    baselineVersion: z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    view: z.enum(["conversation", "canvas", "review"]).optional(),
    /** Open an existing process straight on the canvas. */
    edit: z.literal("canvas").optional(),
  })
  .refine(
    (s) =>
      (!s.baselineVersion || !!s.processId) &&
      (!s.view || !!s.sessionId) &&
      (!s.edit || (!!s.processId && !s.sessionId)),
  );
type DesignView = "conversation" | "canvas" | "review";
function useDesignCopy() {
  return useAdmin().language === "cs" ? designCs : designEn;
}
/** Service integration shares one passive workspace inventory. */
export function ServiceProcesses(props: {
  state: CatalogState;
  serviceId: string;
}) {
  return <ServiceProcessOverview {...props} />;
}

export function ProcessDesignPage() {
  const admin = useAdmin();
  const state = useCatalog();
  const { serviceId } = useParams({ strict: false });
  const search = designSearchSchema.parse(useSearch({ strict: false }));
  const { view, edit, ...designScope } = search;
  const copy = useDesignCopy();
  const service = state.query.data?.services.find((s) => s.id === serviceId);
  const auth = processAuthority(state, admin);
  const scope: DesignClientScope = {
    ...state.target,
    authority: auth,
    serviceId: serviceId ?? "",
    ...designScope,
  };
  return (
    <CatalogBoundary state={state}>
      {(serviceId ? service : true) &&
      state.query.data?.canManage &&
      admin.data.authentication.current === "better-auth" ? (
        <ProcessDesignRuntime
          key={JSON.stringify(scope)}
          scopeJson={JSON.stringify(scope)}
          serviceName={service?.name}
          copy={copy}
          language={admin.language}
          refreshGeneration={admin.refreshGeneration}
          budgetReadable
          preferredModelId={state.query.data?.routing.modelId ?? undefined}
          initialView={view}
          autoStart={edit === "canvas"}
        />
      ) : (
        <Alert variant="destructive">
          <AlertDescription>{copy.authorityLost}</AlertDescription>
        </Alert>
      )}
    </CatalogBoundary>
  );
}
/** One designer conversation for a fixed scope; the console and the web app
 * mount it with their own scope (workspace or personal owner). */
export function ProcessDesignRuntime({
  scopeJson,
  serviceName,
  copy,
  language,
  refreshGeneration,
  budgetReadable,
  preferredModelId,
  initialView,
  autoStart,
}: {
  scopeJson: string;
  serviceName?: string;
  copy: DesignCopy;
  language: "en" | "cs";
  /** Bumps when the surrounding page asks for fresh data. */
  refreshGeneration: number;
  /** Administrators can read the budget policy and see a blocked designer
   * before writing; members learn it from the server's answer. */
  budgetReadable?: boolean;
  preferredModelId?: string;
  initialView?: DesignView;
  autoStart?: boolean;
}) {
  const [client] = useState(
    () => new ProcessDesignClient(JSON.parse(scopeJson), sessionStorage),
  );
  const scope = client.scope;
  // The server refuses designer turns without enforced limits and a model
  // price; say so before the person writes a message.
  const budget = useQuery({
    queryKey: [
      "admin",
      "budget",
      scope.authority,
      scope.organizationId,
      scope.workspaceId,
    ],
    enabled: !!budgetReadable,
    queryFn: async ({ signal }) =>
      InferenceBudgetPolicySchema.parse(
        await api(
          `identity/catalog/budget?${new URLSearchParams({
            organizationId: scope.organizationId,
            workspaceId: scope.workspaceId,
          })}`,
          undefined,
          signal,
        ),
      ),
  });

  useEffect(() => {
    client.attach();
    return () => client.dispose();
  }, [client]);
  useEffect(() => {
    void client.refresh();
  }, [client, refreshGeneration]);
  return (
    <DesignWorkspace
      client={client}
      budget={budget.data}
      serviceName={serviceName}
      copy={copy}
      language={language}
      preferredModelId={preferredModelId}
      initialView={initialView}
      autoStart={autoStart}
    />
  );
}
export function DesignWorkspace({
  client,
  budget,
  serviceName,
  copy,
  language,
  preferredModelId,
  initialView,
  autoStart = false,
}: {
  client: ProcessDesignClient;
  budget?: InferenceBudgetPolicy;
  serviceName?: string;
  copy: DesignCopy;
  language: "en" | "cs";
  preferredModelId?: string;
  initialView?: DesignView;
  /** Open the saved process on the canvas without an extra click. */
  autoStart?: boolean;
}) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const navigate = useNavigate();
  const [acceptReview, setAcceptReview] = useState<Pick<
    DesignReview,
    "revision" | "reviewDigest"
  > | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const scopeGuard = useProcessEditsGuard();
  const { adminLinks } = useProcessHost();
  const wide = useIsWide();
  useEffect(
    () =>
      scopeGuard.register(
        {
          organizationId: client.scope.organizationId,
          workspaceId: client.scope.workspaceId,
        },
        editorDirty,
      ),
    [client, scopeGuard, editorDirty],
  );
  const leave = useBlocker({
    shouldBlockFn: useCallback(() => editorDirty, [editorDirty]),
    enableBeforeUnload: editorDirty,
    withResolver: true,
  });
  const [selectedTab, setSelectedTab] = useState<DesignView | null>(null);
  // "Edit on canvas" issues the same start the empty canvas offers, once.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (
      !autoStart ||
      autoStarted.current ||
      !client.scope.processId ||
      state.sessionId ||
      !state.fresh ||
      !state.capabilities ||
      client.blocked
    )
      return;
    autoStarted.current = true;
    void client.start();
  }, [autoStart, client, state]);
  const review = state.review;
  const hasCandidate = !!review?.candidate;
  // A carried view belongs to a verified session in this client scope. It is
  // never restored from browser storage or applied to a fresh/foreign session.
  const restoredView =
    state.sessionId === client.scope.sessionId &&
    review?.id === client.scope.sessionId &&
    review.organizationId === client.scope.organizationId &&
    review.workspaceId === client.scope.workspaceId &&
    (review.serviceId ?? "") === client.scope.serviceId
      ? initialView
      : undefined;
  const tab =
    selectedTab ??
    restoredView ??
    (!hasCandidate &&
    (state.initializing || state.firstMessage || state.turns.length)
      ? "conversation"
      : "canvas");
  // Wide screens keep the conversation beside the canvas instead of in a tab.
  const shown = wide && tab === "conversation" ? "canvas" : tab;
  const pin = state.turns[0]?.model;
  const modelId = pin?.id ?? state.modelId;
  const defaultModelId =
    state.capabilities?.models.find((item) => item.id === preferredModelId)
      ?.id ?? state.capabilities?.models[0]?.id;
  useEffect(() => {
    if (
      state.fresh &&
      !pin &&
      !state.modelId &&
      !state.pending &&
      !state.firstMessage &&
      !state.initializing &&
      defaultModelId
    )
      client.setModel(defaultModelId);
  }, [
    client,
    state.fresh,
    pin,
    state.modelId,
    state.pending,
    state.firstMessage,
    state.initializing,
    defaultModelId,
  ]);
  const model = state.capabilities?.models.find((m) => m.id === modelId);
  // The server refuses designer turns without enforced limits and a model
  // price; say so before the person writes a message.
  // Members can't read the budget; the capabilities say whether it is ready.
  const budgetBlocked = budget
    ? !!model &&
      (budget.settings.mode !== "enforce" ||
        !budget.settings.prices.some(
          (p) =>
            p.modelId === model.id &&
            p.modelRevision === model.revision &&
            p.providerRevision === model.providerRevision,
        ))
    : state.capabilities?.budgetReady === false;
  const pinUnavailable =
    !!pin &&
    (!model ||
      model.revision !== pin.revision ||
      model.providerId !== pin.providerId ||
      model.providerRevision !== pin.providerRevision);
  const canAccept =
    !client.blocked &&
    !editorDirty &&
    !!review?.candidate &&
    review.validation.valid &&
    !review.blockers.length &&
    !review.acceptedProcessId;
  const isRunning = state.turns.some((t) => t.status === "running");
  const needsPoll =
    !!state.sessionId &&
    !state.denied &&
    (isRunning || state.pending?.kind === "turns");
  useEffect(() => {
    if (
      state.sessionId &&
      state.sessionId !== client.scope.sessionId &&
      !editorDirty &&
      !state.initializing &&
      !state.dispatching &&
      !state.pending
    )
      void navigate({
        ...processDesignRoute(client.scope.serviceId),
        search: { sessionId: state.sessionId, view: tab },
        replace: true,
      });
  }, [
    client,
    navigate,
    state.sessionId,
    editorDirty,
    state.initializing,
    state.dispatching,
    state.pending,
    tab,
  ]);
  useEffect(() => {
    if (!needsPoll || state.loading || state.dispatching) return;
    // A bounded passive read loop. It cannot issue or resend a command.
    const timer = setTimeout(
      () => void client.refresh({ reuseCapabilities: true }),
      state.error ? 10000 : 3000,
    );
    return () => clearTimeout(timer);
  }, [
    client,
    needsPoll,
    state.loading,
    state.dispatching,
    state.error,
    state.turns,
  ]);
  const pendingTurn =
    state.pending?.kind === "turns" ? state.pending.body : null;
  const unrecorded =
    pendingTurn &&
    !state.turns.some((t) => t.requestId === pendingTurn.requestId);
  const tone: Record<string, Tone> = {
    running: "info",
    completed: "success",
    failed: "danger",
    interrupted: "warning",
  };
  const composerDisabled =
    !!review?.acceptedProcessId || state.error === "recovery_storage_invalid";
  const canSend = !editorDirty && !budgetBlocked && client.canSend;
  // One chronological list: recorded turns, then attempts the server refused,
  // then the message still awaiting its result.
  const entries: {
    key: string;
    text: string;
    status: "running" | "completed" | "failed" | "interrupted" | "pending";
    reply: string | null;
    failure: string | null;
    tools: unknown[];
  }[] = [
    ...state.turns.map((turn) => ({
      key: turn.requestId,
      text: turn.userText,
      status: turn.status,
      reply: turn.reply,
      failure: turn.failure,
      tools: turn.toolReceipts,
    })),
    ...state.rejectedTurns.map(({ command, code }) => ({
      key: command.requestId,
      text: command.text,
      status: "failed" as const,
      reply: null,
      failure: code,
      tools: [],
    })),
    ...(unrecorded && pendingTurn
      ? [
          {
            key: pendingTurn.requestId,
            text: pendingTurn.text,
            status: state.dispatching
              ? ("running" as const)
              : ("pending" as const),
            reply: null,
            failure: null,
            tools: [],
          },
        ]
      : []),
  ];
  // Only the latest failure explains itself; earlier ones keep their badge.
  const last = entries.at(-1);
  const lastFailure =
    last && (last.status === "failed" || last.status === "interrupted")
      ? last
      : null;
  const retryable =
    !editorDirty &&
    !budgetBlocked &&
    !composerDisabled &&
    !client.blocked &&
    !state.composer.trim();
  const noModel = !!state.capabilities && !state.capabilities.models.length;
  const conversation = (
    <Card>
      <CardHeader>
        <CardTitle>{copy.conversation}</CardTitle>
        <CardAction>
          {pin ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="text-sm break-words text-muted-foreground">
                {model?.name ?? pin.id}
              </span>
              {pinUnavailable && (
                <StatusBadge tone="warning">{copy.unavailable}</StatusBadge>
              )}
            </div>
          ) : (
            <Select
              value={modelId}
              onValueChange={(id) => client.setModel(id)}
              disabled={
                noModel ||
                !!state.pending ||
                state.dispatching ||
                state.initializing ||
                !state.fresh
              }
            >
              <SelectTrigger
                id="design-model"
                aria-label={copy.model}
                className="w-48"
              >
                <SelectValue placeholder={copy.selectModel} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {state.capabilities?.models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {noModel && (
            <Alert>
              <AlertDescription>
                {copy.noDesignerModel}{" "}
                {adminLinks === "none" ? (
                  copy.askAdmin
                ) : (
                  <AdminLink to="/routing" className="underline">
                    {copy.configureModel}
                  </AdminLink>
                )}
              </AlertDescription>
            </Alert>
          )}
          {budgetBlocked && (
            <Alert>
              <AlertDescription>{copy.budget}</AlertDescription>
              {adminLinks !== "none" && (
                <AlertAction>
                  <Button asChild size="sm" variant="outline">
                    <AdminLink to="/usage">{copy.setUpLimits}</AdminLink>
                  </Button>
                </AlertAction>
              )}
            </Alert>
          )}
          {state.initializing && (
            <StatusBadge tone="info">{copy.starting}</StatusBadge>
          )}

          {!pin && state.modelId && !model && !noModel && (
            <Alert>
              <AlertDescription>{copy.chooseAvailableModel}</AlertDescription>
            </Alert>
          )}
          {pinUnavailable && (
            <Alert>
              <AlertDescription>{copy.modelUnavailable}</AlertDescription>
            </Alert>
          )}
          {entries.length ? (
            <div
              role="log"
              aria-label={copy.conversation}
              className="flex max-h-128 flex-col gap-4 overflow-y-auto"
              data-design-history
            >
              {entries.map((entry) => (
                <article key={entry.key} className="flex flex-col gap-2">
                  <div className="ml-8 self-end rounded-lg bg-muted px-3 py-2">
                    <h3 className="sr-only">{copy.you}</h3>
                    <p
                      className="text-sm whitespace-pre-wrap break-words"
                      data-design-user
                    >
                      {entry.text}
                    </p>
                  </div>
                  {(entry.reply || entry.status !== "completed") && (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <h3 className="text-xs font-medium text-muted-foreground">
                          {copy.designer}
                        </h3>
                        {entry.status === "running" ? (
                          <StatusBadge tone="info">{copy.running}</StatusBadge>
                        ) : entry.status === "pending" ? (
                          <StatusBadge tone="warning">
                            {copy.pending}
                          </StatusBadge>
                        ) : (
                          entry.status !== "completed" && (
                            <StatusBadge tone={tone[entry.status]!}>
                              {copy[entry.status]}
                            </StatusBadge>
                          )
                        )}
                      </div>
                      {entry.reply && <Markdown text={entry.reply} />}
                    </div>
                  )}
                  {entry === lastFailure && (
                    <Alert variant="destructive">
                      <AlertDescription>
                        {designProblem(entry.failure ?? entry.status, copy)}
                      </AlertDescription>
                      <AlertAction>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!retryable}
                          onClick={() => {
                            client.setComposer(entry.text);
                            void client.send(language);
                          }}
                        >
                          {copy.retryTurn}
                        </Button>
                      </AlertAction>
                    </Alert>
                  )}
                  {entry.tools.length > 0 && (
                    <Disclosure title={copy.tools}>
                      <JsonDetail value={entry.tools} />
                    </Disclosure>
                  )}
                </article>
              ))}
            </div>
          ) : (
            // Keeps the composer at the bottom of the panel.
            <div data-design-history />
          )}
          {editorDirty && (
            <p className="text-sm text-muted-foreground" role="status">
              {copy.unsavedConversation}
            </p>
          )}
          <Field>
            <FieldLabel htmlFor="design-message" className="sr-only">
              {copy.message}
            </FieldLabel>
            <Textarea
              id="design-message"
              rows={4}
              maxLength={4000}
              placeholder={copy.messagePlaceholder}
              value={state.composer}
              disabled={composerDisabled}
              onChange={(e) => client.setComposer(e.target.value)}
            />
          </Field>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground tabular-nums">
              {state.composer.length}/4000
            </span>
            <Button
              variant={canSend && !canAccept ? "default" : "outline"}
              disabled={!canSend}
              onClick={() => void client.send(language)}
            >
              <SendHorizontal data-icon="inline-start" aria-hidden="true" />
              {state.initializing ? copy.starting : copy.send}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
  return (
    <>
      <PageHeader
        title={
          review?.candidate?.name ||
          review?.baseline?.definition.name ||
          (client.scope.processId ? copy.title : copy.newProcess)
        }
        description={serviceName}
        back={
          client.scope.serviceId
            ? undefined
            : { to: "/processes", label: copy.processes }
        }
        meta={
          (state.loading ||
            (!state.fresh && !state.dispatching && !state.initializing) ||
            review?.candidate) && (
            <>
              {!review?.acceptedProcessId && review?.candidate && (
                <StatusBadge tone="neutral">{copy.draft}</StatusBadge>
              )}
              {!state.loading &&
                !state.fresh &&
                !state.dispatching &&
                !state.initializing && (
                  <StatusBadge tone="warning">{copy.stale}</StatusBadge>
                )}
            </>
          )
        }
        actions={
          state.denied ? undefined : state.sessionId ? (
            <>
              {state.initializing ||
              state.handoff ||
              state.dispatching ||
              state.pending ? (
                <Button variant="outline" disabled title={copy.pendingHint}>
                  <Plus data-icon="inline-start" aria-hidden="true" />
                  {copy.newConversation}
                </Button>
              ) : (
                <Button asChild variant="outline">
                  <Link
                    {...processDesignRoute(client.scope.serviceId)}
                    search={
                      review?.baseline
                        ? { processId: review.baseline.processId }
                        : {}
                    }
                  >
                    <Plus data-icon="inline-start" aria-hidden="true" />
                    {copy.newConversation}
                  </Link>
                </Button>
              )}
              {review?.acceptedProcessId ? (
                <Button asChild>
                  <Link
                    {...processConsoleRoute(
                      client.scope.serviceId,
                      review.acceptedProcessId,
                    )}
                    state={(previous) => ({ ...previous, processTab: "tests" })}
                  >
                    <FlaskConical data-icon="inline-start" aria-hidden="true" />
                    {copy.testsVersions}
                  </Link>
                </Button>
              ) : (
                canAccept && (
                  <Button
                    onClick={() =>
                      review &&
                      setAcceptReview({
                        revision: review.revision,
                        reviewDigest: review.reviewDigest,
                      })
                    }
                  >
                    {copy.save}
                  </Button>
                )
              )}
            </>
          ) : undefined
        }
      />
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{designProblem(state.error, copy)}</p>
            <Disclosure title={copy.technical}>
              <JsonDetail
                value={{
                  code: state.error,
                  requestId: state.pending?.body.requestId,
                }}
              />
            </Disclosure>
          </AlertDescription>
        </Alert>
      )}
      {state.denied ? null : (
        <>
          {state.pending && !state.dispatching && !state.initializing && (
            <Alert>
              <AlertTitle>{copy.pending}</AlertTitle>
              <AlertDescription>{copy.pendingHint}</AlertDescription>
              <AlertAction>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.loading || state.dispatching}
                  onClick={() => void client.refresh()}
                >
                  {copy.check}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.dispatching || state.loading || !state.fresh}
                  onClick={() => void client.retry()}
                >
                  {copy.retry}
                </Button>
              </AlertAction>
            </Alert>
          )}
          <div data-designer-layout>
            {wide && (
              <aside data-designer-chat aria-label={copy.conversation}>
                {conversation}
              </aside>
            )}
            <Tabs
              value={shown}
              onValueChange={(value) => setSelectedTab(value as DesignView)}
              className="min-w-0"
              data-designer-main
            >
              {(!wide || review) && (
                <div className="-mx-4 shrink-0 overflow-x-auto overflow-y-hidden border-b px-4 pb-px md:mx-0 md:px-0">
                  <TabsList variant="line" aria-label={copy.title}>
                    {!wide && (
                      <TabsTrigger value="conversation">
                        {copy.conversation}
                      </TabsTrigger>
                    )}
                    <TabsTrigger value="canvas">{copy.canvas}</TabsTrigger>
                    {review && (
                      <TabsTrigger value="review">{copy.review}</TabsTrigger>
                    )}
                  </TabsList>
                </div>
              )}
              {!wide && (
                <TabsContent value="conversation" className="mt-2 first:mt-0">
                  {conversation}
                </TabsContent>
              )}
              <TabsContent
                value="review"
                className="mt-2 first:mt-0"
                data-review
              >
                {review && state.capabilities ? (
                  <ProcessDesignReview
                    key={`${review.id}/${review.revision}/${review.reviewDigest}`}
                    review={review}
                    capabilities={state.capabilities}
                    copy={copy}
                    blocked={client.blocked || editorDirty}
                    onAcknowledge={(ids, confirmation) =>
                      client.acknowledge(
                        review,
                        review.assumptions
                          .filter((a) => ids.includes(a.id))
                          .map(({ id, digest }) => ({ id, digest })),
                        confirmation,
                      )
                    }
                  />
                ) : state.loading ? (
                  <Skeleton className="h-48 w-full" />
                ) : (
                  <Empty variant="outline">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Workflow aria-hidden="true" />
                      </EmptyMedia>
                      <EmptyTitle>{copy.proposal}</EmptyTitle>
                      <EmptyDescription>
                        {copy.missingCandidate}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </TabsContent>
              <TabsContent
                value="canvas"
                className="mt-2 first:mt-0"
                forceMount
                hidden={shown !== "canvas"}
              >
                {review && state.capabilities ? (
                  <ProcessVisualEditor
                    key={review.id}
                    client={client}
                    review={review}
                    capabilities={state.capabilities}
                    language={language}
                    blocked={client.blocked}
                    active={shown === "canvas"}
                    onDirty={setEditorDirty}
                  />
                ) : state.loading ? (
                  <Skeleton className="h-48 w-full" />
                ) : (
                  <Empty variant="outline" className="min-h-96">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Workflow aria-hidden="true" />
                      </EmptyMedia>
                      <EmptyTitle>{copy.emptyCanvas}</EmptyTitle>
                      <EmptyDescription>
                        {copy.emptyCanvasHint}
                      </EmptyDescription>
                    </EmptyHeader>
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button
                        disabled={client.blocked}
                        onClick={() => void client.start()}
                      >
                        {state.dispatching ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <Plus aria-hidden="true" data-icon="inline-start" />
                        )}
                        {client.scope.processId
                          ? copy.editOnCanvas
                          : copy.startBlank}
                      </Button>
                      {!wide && (
                        <Button
                          variant="outline"
                          onClick={() => setSelectedTab("conversation")}
                        >
                          {copy.designWithAgent}
                        </Button>
                      )}
                    </div>
                  </Empty>
                )}
              </TabsContent>
            </Tabs>
          </div>
          <AlertDialog
            open={leave.status === "blocked"}
            onOpenChange={(open) => {
              if (!open) leave.reset?.();
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{copy.leaveTitle}</AlertDialogTitle>
                <AlertDialogDescription>
                  {copy.leaveHint}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => leave.reset?.()}>
                  {copy.stayAction}
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => leave.proceed?.()}
                >
                  {copy.leaveAction}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <AlertDialog
            open={
              !!acceptReview &&
              canAccept &&
              acceptReview.revision === review?.revision &&
              acceptReview.reviewDigest === review?.reviewDigest
            }
            onOpenChange={(open) => {
              if (!open) setAcceptReview(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{copy.saveDescription}</AlertDialogTitle>
                <AlertDialogDescription>{copy.saveHint}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
                <AlertDialogAction
                  disabled={!canAccept}
                  onClick={() => {
                    if (acceptReview) void client.accept(acceptReview);
                    setAcceptReview(null);
                  }}
                >
                  {copy.save}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </>
  );
}
