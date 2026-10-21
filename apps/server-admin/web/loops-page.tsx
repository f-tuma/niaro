import { useEffect, useMemo, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft, ChevronRight, Workflow } from "lucide-react";
import {
  LoopPageSchema,
  LoopDetailSchema,
  LoopStatus,
  type LoopSummary,
  type LoopNode,
  type LoopActionDetails,
} from "../../../packages/protocol/loops";
import type { OrganizationDetail } from "../../../packages/protocol/identity";
import type { ActionFailure } from "../../../packages/protocol/action-failure";
import { PageHeader } from "@admin/components/console/page";
import { DetailList } from "@admin/components/console/forms";
import { LoopTimeline } from "@admin/components/console/loop-timeline";
import {
  StatusBadge,
  StatusDot,
  type Tone,
} from "@admin/components/console/status";
import { RelativeTime } from "@admin/components/console/time";
import { Button } from "@admin/components/ui/button";
import { Badge } from "@admin/components/ui/badge";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@admin/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@admin/components/ui/collapsible";
import { Card } from "@admin/components/ui/card";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@admin/components/ui/empty";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
} from "@admin/components/ui/item";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import { Skeleton } from "@admin/components/ui/skeleton";
import { useAdmin } from "./context";
import { useIsWide } from "./hooks/use-mobile";
import { IdentityPage } from "./identity-pages";
import {
  useLoopsCopy,
  loopDecisionChoiceLabel,
  loopDetailLabel,
  loopNodeStatusLabel,
  loopFieldValue,
  loopFailureLabel,
} from "./loops-copy";
import { LoopEvidenceBadges } from "./loop-evidence";
import { loopNodeDuration, loopNodeToolName } from "./lib/loop-presentation";
import { readableName } from "../../../packages/protocol/display-name";
import { api, ApiError, errorMessage } from "./lib/api";
import {
  loopDetailSections,
  projectLoop,
  type LoopViewMode,
  loopPresentationStatus,
} from "./lib/loop-summary";

const actionStatuses = {
  awaiting_approval: "awaitingApproval",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  unknown: "unknown",
  rejected: "rejected",
} as const;

function actionTone(status: LoopActionDetails["status"]): Tone {
  return status === "awaiting_approval" || status === "rejected"
    ? "warning"
    : statusTone(status);
}

function runDuration(run: LoopSummary) {
  if (!run.finishedAt) return undefined;
  const seconds = Math.round(
    (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000,
  );
  return Number.isFinite(seconds) && seconds >= 0
    ? seconds < 60
      ? `${seconds} s`
      : `${Math.floor(seconds / 60)} min ${seconds % 60} s`
    : undefined;
}

function statusTone(status: LoopSummary["status"]): Tone {
  return status === "succeeded"
    ? "success"
    : status === "running"
      ? "info"
      : status === "failed"
        ? "danger"
        : status === "waiting" || status === "unknown"
          ? "warning"
          : "neutral";
}

export function LoopsPage() {
  const copy = useLoopsCopy();
  const { data } = useAdmin();
  return (
    <IdentityPage
      page="workspaces"
      title={copy.loops}
      content={(detail) => (
        <LoopsFeed
          key={`${data.authentication.principalId}:${detail.organizationId}`}
          detail={detail}
        />
      )}
    />
  );
}

function LoopsFeed({ detail }: { detail: OrganizationDetail }) {
  const { copy: common, data, selectedWorkspace } = useAdmin();
  const copy = useLoopsCopy();
  const [workspaceId, setWorkspaceId] = useState(
    detail.workspaces.some((workspace) => workspace.id === selectedWorkspace)
      ? selectedWorkspace!
      : "",
  );
  const [status, setStatus] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const before = cursors.at(-1);
  const query = useQuery({
    queryKey: [
      "admin",
      "loops",
      data.authentication.principalId,
      detail.organizationId,
      { workspaceId, status, before },
    ],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        organizationId: detail.organizationId,
      });
      if (workspaceId) params.set("workspaceId", workspaceId);
      if (status) params.set("status", status);
      if (before) params.set("before", before);
      return LoopPageSchema.parse(
        await api(`identity/loops?${params}`, undefined, signal),
      );
    },
    enabled: detail.canManageWorkspaces,
    staleTime: 0,
    // While a run is in progress the list follows it closely.
    refetchInterval: (current) =>
      before
        ? false
        : current.state.data?.entries.some(
              (entry) => entry.status === "running",
            )
          ? 2_000
          : 10_000,
  });
  const entries = query.data?.entries ?? [];
  // Side by side the first run opens by default; on narrower screens the list
  // comes first and a tapped run replaces it (master → detail).
  const wide = useIsWide();
  const picked = entries.find((entry) => entry.id === selectedId);
  const selected = picked ?? (wide ? entries[0] : undefined);
  const showList = wide || !picked;
  const open = (id: string | null) => {
    setSelectedId(id);
    if (!wide) document.getElementById("console-content")?.scrollTo(0, 0);
  };
  const change = (update: () => void) => {
    update();
    setSelectedId(null);
    setCursors([]);
  };
  const denied = !detail.canManageWorkspaces;
  // A single person's runs don't need their name on every row.
  const manyActors = new Set(entries.map((entry) => entry.actorName)).size > 1;
  return (
    <>
      <PageHeader
        title={copy.loops}
        toolbar={
          !denied && (
            <>
              {detail.workspaces.length > 1 && (
                <LoopFilter
                  label={common.workspace}
                  value={workspaceId}
                  onChange={(value) => change(() => setWorkspaceId(value))}
                  options={[
                    { value: "", label: common.auditAllWorkspaces },
                    ...detail.workspaces.map((workspace) => ({
                      value: workspace.id,
                      label: workspace.name,
                    })),
                  ]}
                />
              )}
              <LoopFilter
                label={copy.status}
                value={status}
                onChange={(value) => change(() => setStatus(value))}
                options={[
                  { value: "", label: copy.allStatuses },
                  ...LoopStatus.options.map((value) => ({
                    value,
                    label: copy[value],
                  })),
                ]}
              />
            </>
          )
        }
      />
      {denied ? (
        <LoopEmpty title={copy.managersOnly} description={copy.managersHint} />
      ) : query.isPending ? (
        <div role="status" className="grid gap-6 lg:grid-cols-3">
          <span className="sr-only">{common.loading}</span>
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full lg:col-span-2" />
        </div>
      ) : query.isError ? (
        <LoopError error={query.error} retry={() => void query.refetch()} />
      ) : !entries.length ? (
        <LoopEmpty title={copy.empty} description={copy.emptyHint} />
      ) : (
        <div data-loops-layout>
          {!showList && (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 self-start"
              onClick={() => open(null)}
            >
              <ArrowLeft data-icon="inline-start" aria-hidden="true" />
              {copy.allRuns}
            </Button>
          )}
          <section
            aria-label={copy.runs}
            hidden={!showList}
            className="flex min-h-0 min-w-0 flex-col gap-3"
          >
            <Card
              variant="list"
              data-loop-run-list
              className="max-h-96 min-h-0 overflow-y-auto overscroll-contain lg:max-h-none lg:flex-1 [&>button]:shrink-0"
            >
              {entries.map((entry) => (
                <Item key={entry.id} variant="row" size="row" asChild>
                  <button
                    type="button"
                    onClick={() => open(entry.id)}
                    aria-current={
                      entry.id === selected?.id ? "true" : undefined
                    }
                    className="text-left"
                  >
                    <ItemContent className="min-w-0">
                      <ItemTitle>
                        <span className="line-clamp-2">
                          {entry.request || copy.request}
                        </span>
                      </ItemTitle>
                      <ItemDescription>
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          {entry.status !== "succeeded" && (
                            <StatusDot
                              size="sm"
                              tone={statusTone(entry.status)}
                            >
                              {copy[entry.status]}
                            </StatusDot>
                          )}
                          <span className="truncate">
                            <RelativeTime value={entry.startedAt} />
                            {[
                              manyActors && entry.actorName,
                              !workspaceId &&
                                detail.workspaces.length > 1 &&
                                (entry.workspaceName ?? entry.workspaceId),
                            ]
                              .filter(Boolean)
                              .map((part) => `, ${part}`)
                              .join("")}
                          </span>
                        </span>
                      </ItemDescription>
                      {(entry.statusEvidence || entry.unconfirmedFailure) && (
                        <span className="flex flex-wrap gap-1 pt-1">
                          <LoopEvidenceBadges
                            statusEvidence={entry.statusEvidence}
                            unconfirmedFailure={entry.unconfirmedFailure}
                            copy={copy}
                          />
                        </span>
                      )}
                    </ItemContent>
                  </button>
                </Item>
              ))}
            </Card>
            {(before || query.data?.nextBefore) && (
              <div className="flex shrink-0 items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!before || query.isFetching}
                  onClick={() => {
                    setSelectedId(null);
                    setCursors((values) => values.slice(0, -1));
                  }}
                >
                  <ChevronLeft data-icon="inline-start" aria-hidden="true" />
                  {common.auditNewer}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!query.data?.nextBefore || query.isFetching}
                  onClick={() => {
                    const cursor = query.data?.nextBefore;
                    if (cursor) {
                      setSelectedId(null);
                      setCursors((values) => [...values, cursor]);
                    }
                  }}
                >
                  {common.auditOlder}
                  <ChevronRight data-icon="inline-end" aria-hidden="true" />
                </Button>
              </div>
            )}
          </section>
          {selected && (
            <LoopRun
              key={selected.id}
              organizationId={detail.organizationId}
              run={selected}
            />
          )}
        </div>
      )}
    </>
  );
}

function LoopRun({
  organizationId,
  run,
}: {
  organizationId: string;
  run: LoopSummary;
}) {
  const { data, copy: common } = useAdmin();
  const copy = useLoopsCopy();
  const [viewMode, setViewMode] = useState<LoopViewMode>("summary");
  const query = useQuery({
    queryKey: [
      "admin",
      "loops",
      data.authentication.principalId,
      organizationId,
      "detail",
      run.id,
    ],
    queryFn: async ({ signal }) =>
      LoopDetailSchema.parse(
        await api(
          `identity/loops/${encodeURIComponent(run.id)}?${new URLSearchParams({ organizationId })}`,
          undefined,
          signal,
        ),
      ),
    staleTime: 0,
    // Refreshes keep the drawn graph instead of flashing a skeleton.
    placeholderData: keepPreviousData,
    refetchInterval: (current) => {
      const status = current.state.data?.run.status ?? run.status;
      return status === "running"
        ? 1_500
        : status === "waiting"
          ? 5_000
          : false;
    },
  });
  const trace = query.data;
  const { refetch } = query;
  const recorded = trace?.run.status;
  // The list can see a run continue (an approval, an answer) before this view does.
  useEffect(() => {
    if (recorded && recorded !== run.status) void refetch();
  }, [run.status, recorded, refetch]);
  const current = trace?.run ?? run;
  const graph = useMemo(() => {
    if (!trace) return null;
    const projected = projectLoop(trace.nodes, trace.edges, viewMode);
    // The run header already quotes the request; the steps start after it.
    return {
      ...projected,
      nodes: projected.nodes.filter(
        (node) =>
          !(
            node.kind === "request" &&
            node.details.find((detail) => detail.label === "Message")?.value ===
              trace.run.request
          ),
      ),
    };
  }, [trace, viewMode]);
  return (
    <section
      aria-label={copy.graph}
      className="min-h-0 min-w-0 lg:flex lg:flex-col"
      data-loops-graph
    >
      {query.isPending ? (
        <div role="status" className="min-h-0 lg:flex-1">
          <span className="sr-only">{common.loading}</span>
          <Skeleton className="h-96 w-full lg:h-full" />
        </div>
      ) : query.isError ? (
        <LoopError error={query.error} retry={() => void query.refetch()} />
      ) : trace ? (
        <Card variant="flush" className="min-h-0 lg:flex-1">
          <Tabs
            value={viewMode}
            onValueChange={(value) => {
              if (value === "summary" || value === "all") setViewMode(value);
            }}
            className="min-h-0 lg:flex-1"
          >
            <div className="flex shrink-0 flex-col gap-3 border-b px-4 pt-4 pb-px">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <h2 className="line-clamp-2 text-md font-semibold">
                    {current.request || copy.request}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    <RelativeTime value={current.startedAt} />
                    {[current.actorName, runDuration(current)]
                      .filter(Boolean)
                      .map((part) => `, ${part}`)
                      .join("")}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  {current.status !== "succeeded" && (
                    <StatusBadge tone={statusTone(current.status)}>
                      {copy[current.status]}
                    </StatusBadge>
                  )}
                  <LoopEvidenceBadges
                    statusEvidence={current.statusEvidence}
                    unconfirmedFailure={current.unconfirmedFailure}
                    copy={copy}
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-2">
                <TabsList variant="line" aria-label={copy.stepsView}>
                  <TabsTrigger value="summary">{copy.summary}</TabsTrigger>
                  <TabsTrigger value="all">{copy.allSteps}</TabsTrigger>
                </TabsList>
                {current.process ? (
                  <span
                    className="text-xs text-muted-foreground"
                    data-loop-process
                  >
                    {copy.pinnedProcess}, {copy.processVersion.toLowerCase()}{" "}
                    {current.process.version}
                  </span>
                ) : null}
              </div>
            </div>
            <TabsContent
              value={viewMode}
              data-loop-steps
              className="min-h-0 overflow-y-auto overscroll-contain lg:flex-1"
            >
              {/* Tabs already put a gap under the tab line. */}
              <div className="px-4 pt-2 pb-4">
                {graph!.nodes.length ? (
                  <LoopTimeline
                    key={viewMode}
                    nodes={graph!.nodes}
                    edges={graph!.edges}
                    copy={copy}
                    renderDetails={(node) => <NodeDetails node={node} />}
                  />
                ) : (
                  <LoopEmpty title={copy.noSteps} />
                )}
                <RunDetails run={current} />
              </div>
            </TabsContent>
          </Tabs>
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-3 text-xs text-muted-foreground">
            <dl className="flex flex-wrap gap-x-4 gap-y-1">
              {[
                [copy.modelCalls, current.modelCalls],
                [copy.toolCalls, current.toolCalls],
              ].map(([label, value]) => (
                <div key={label} className="flex items-baseline gap-1">
                  <dt>{label}</dt>
                  <dd className="font-medium text-foreground tabular-nums">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            {(current.traceMode === "reconstructed" || trace.truncated) && (
              <p>{trace.truncated ? copy.truncated : copy.reconstructedHint}</p>
            )}
          </div>
        </Card>
      ) : null}
    </section>
  );
}

/** Full recorded request and immutable run provenance remain available locally. */
function RunDetails({ run }: { run: LoopSummary }) {
  const copy = useLoopsCopy();
  const process = run.process;
  const ids: [string, string | undefined][] = [
    [copy.runId, process?.runId ?? run.id],
    [copy.actorId, process?.actorId ?? run.actorId],
    [copy.processId, process?.processId],
    [copy.artifactDigest, process?.artifactDigest],
    [copy.conversation, process?.conversationId],
    [copy.commandId, process?.commandId],
    [copy.admissionId, process?.admissionId],
  ];
  return (
    <div className="mt-4 border-t pt-3" data-loop-run-details>
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm">
            <ChevronRight data-icon="inline-start" aria-hidden="true" />
            {copy.runDetails}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pt-3">
            <DetailList
              items={[
                {
                  label: copy.request,
                  value: (
                    <span className="whitespace-pre-wrap break-words">
                      {run.request}
                    </span>
                  ),
                },
                ...(process
                  ? [
                      {
                        label: copy.processVersion,
                        value: String(process.version),
                      },
                    ]
                  : []),
                ...ids
                  .filter(
                    (entry): entry is [string, string] =>
                      entry[1] !== undefined,
                  )
                  .map(([label, value]) => ({
                    label,
                    value: (
                      <code className="font-mono text-xs break-all">
                        {value}
                      </code>
                    ),
                  })),
              ]}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function NodeDetails({ node }: { node: LoopNode }) {
  const { language } = useAdmin();
  const copy = useLoopsCopy();
  const sections = loopDetailSections(node);
  const items: { label: string; value: ReactNode }[] = [];
  if (node.startedAt)
    items.push({
      label: copy.started,
      value: new Date(node.startedAt).toLocaleString(language),
    });
  if (node.startedAt && node.finishedAt)
    items.push({
      label: copy.duration,
      value: loopNodeDuration(node) ?? "",
    });
  const content = sections.content.map((detail) => ({
    label: loopDetailLabel(detail.label, copy),
    value: (
      <span className="whitespace-pre-wrap break-words">
        {detail.label === "Choice"
          ? (loopDecisionChoiceLabel(
              detail.value,
              copy,
              sections.content.find(
                (field) => field.label === "Selected criterion",
              )?.value,
            ) ?? detail.value)
          : detail.value}
      </span>
    ),
  }));
  items.push(
    ...sections.technical
      .filter(
        (detail) =>
          !node.action ||
          !["Service", "Action", "Effect", "Receipt status"].includes(
            detail.label,
          ),
      )
      .map((detail) => ({
        label: loopDetailLabel(detail.label, copy),
        value: (
          <span className="whitespace-pre-wrap break-words">
            {detail.value}
          </span>
        ),
      })),
  );
  if (
    node.action &&
    !sections.technical.some((detail) => detail.label === "Operation")
  )
    items.push({
      label: copy.operation,
      value: (
        <code className="font-mono text-xs break-all">
          {node.action.operationId}
        </code>
      ),
    });
  const action = node.action;
  const tool = node.tool;
  const name = action?.actionName ?? loopNodeToolName(node);
  const isTool = node.kind === "tool" || node.kind === "result";
  // Exact identifiers stay available for debugging, behind the disclosure.
  if (name)
    items.unshift({
      label: action ? copy.action : copy.tool,
      value: <code className="font-mono text-xs break-all">{name}</code>,
    });
  const failure = action?.failure ?? tool?.failure;
  if (failure) {
    items.push({ label: copy.failureCode, value: failure.code });
    if (failure.httpStatus)
      items.push({
        label: copy.httpStatus,
        value: String(failure.httpStatus),
      });
    items.push({ label: copy.failureStage, value: failure.stage });
  }
  return (
    <>
      {action ? (
        <>
          {action.phase === "proposal" && (
            <div>
              <Badge variant="outline">{copy.proposal}</Badge>
            </div>
          )}
          <DetailBlock title={copy.input}>
            {action.input.length > 0 ? (
              <DetailList
                items={action.input.map((field) => ({
                  label: fieldPath(field.label, copy),
                  value: (
                    <span className="whitespace-pre-wrap break-words">
                      {loopFieldValue(field.label, field.value, copy)}
                    </span>
                  ),
                }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{copy.noInput}</p>
            )}
            {action.inputTruncated && (
              <p className="text-xs text-muted-foreground">
                {copy.inputTruncated}
              </p>
            )}
          </DetailBlock>
          <DetailBlock title={copy.output}>
            <div>
              <StatusBadge tone={actionTone(action.status)}>
                {copy[actionStatuses[action.status]]}
              </StatusBadge>
            </div>
            {action.phase === "proposal" && (
              <p className="text-sm text-muted-foreground">
                {copy.proposalOutcome}
              </p>
            )}
            {action.output.length > 0 ? (
              <DetailList
                items={action.output.map((field) => ({
                  label: fieldPath(field.label, copy),
                  value: (
                    <span className="whitespace-pre-wrap break-words">
                      {loopFieldValue(field.label, field.value, copy)}
                    </span>
                  ),
                }))}
              />
            ) : action.phase === "execution" ? (
              <p className="text-sm text-muted-foreground">{copy.noOutput}</p>
            ) : null}
            {action.outputTruncated && (
              <p className="text-xs text-muted-foreground">
                {copy.outputTruncated}
              </p>
            )}
          </DetailBlock>
          {action.phase === "execution" &&
            ["failed", "unknown"].includes(action.status) && (
              <FailureDetails action={action} />
            )}
        </>
      ) : tool ? (
        <>
          <DetailBlock title={copy.input}>
            {tool.inputRecorded && tool.input.length > 0 ? (
              <DetailList
                items={tool.input.map((field) => ({
                  label: fieldPath(field.label, copy),
                  value: (
                    <span className="whitespace-pre-wrap break-words">
                      {loopFieldValue(field.label, field.value, copy)}
                    </span>
                  ),
                }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {tool.inputRecorded ? copy.noInput : copy.inputMissing}
              </p>
            )}
            {tool.inputTruncated && (
              <p className="text-xs text-muted-foreground">
                {copy.inputTruncated}
              </p>
            )}
          </DetailBlock>
          <DetailBlock title={copy.output}>
            <div>
              <StatusBadge tone={statusTone(loopPresentationStatus(node))}>
                {loopNodeStatusLabel(node, copy)}
              </StatusBadge>
            </div>
            {tool.outputRecorded && tool.output.length > 0 ? (
              <DetailList
                items={tool.output.map((field) => ({
                  label: fieldPath(field.label, copy),
                  value: (
                    <span className="whitespace-pre-wrap break-words">
                      {loopFieldValue(field.label, field.value, copy)}
                    </span>
                  ),
                }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {tool.outputRecorded ? copy.noOutput : copy.outputMissing}
              </p>
            )}
            {tool.outputTruncated && (
              <p className="text-xs text-muted-foreground">
                {copy.outputTruncated}
              </p>
            )}
          </DetailBlock>
          {tool.failure && (
            <FailureDetails
              action={{
                failure: tool.failure,
                status: loopPresentationStatus(node),
                effect: "read",
              }}
            />
          )}
        </>
      ) : content.length > 0 ? (
        <DetailList items={content} />
      ) : null}
      {isTool && !tool && !action && (
        <p className="text-sm text-muted-foreground">{copy.outputMissing}</p>
      )}
      {items.length > 0 && (
        <Collapsible>
          <div className="flex flex-col gap-3">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="self-start">
                <ChevronRight data-icon="inline-start" aria-hidden="true" />
                {copy.technical}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <DetailList items={items} />
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}
    </>
  );
}

/** A compact, labelled group inside an expanded step. */
function DetailBlock({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** "name · first Name · ilike" reads "Name · First name · Ilike". */
function fieldPath(label: string, copy: ReturnType<typeof useLoopsCopy>) {
  return label
    .split(" · ")
    .map((part) => {
      const known = loopDetailLabel(part, copy);
      return known === part
        ? readableName(part.trim().replace(/\s+/g, "_"))
        : known;
    })
    .join(" · ");
}

function FailureDetails({
  action,
}: {
  action: { failure?: ActionFailure; status: string; effect: "read" | "write" };
}) {
  const copy = useLoopsCopy();
  const guidance: Record<ActionFailure["retry"], string> = {
    correct_input: copy.retryCorrectInput,
    reconnect: copy.retryReconnect,
    later: copy.retryLater,
    verify_first: copy.retryVerifyFirst,
    none: copy.retryNone,
  };
  const failure = action.failure;
  const retry =
    action.status === "unknown" && action.effect === "write"
      ? "verify_first"
      : (failure?.retry ?? "none");
  return (
    <DetailBlock title={copy.failureReason}>
      <p className="text-sm">
        {failure ? loopFailureLabel(failure.kind, copy) : copy.failureMissing}
      </p>
      {failure?.message && (
        <DetailList
          items={[
            {
              label: copy.failureReport,
              value: (
                <span className="whitespace-pre-wrap break-words">
                  {failure.message}
                </span>
              ),
            },
          ]}
        />
      )}
      {failure?.fields.length ? (
        <DetailList
          items={failure.fields.map((field) => ({
            label: field.path,
            value: (
              <span className="whitespace-pre-wrap break-words">
                {field.issue}
              </span>
            ),
          }))}
        />
      ) : null}
      <p className="text-sm text-muted-foreground">{guidance[retry]}</p>
    </DetailBlock>
  );
}

function LoopFilter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select
      value={value || "all"}
      onValueChange={(next) => onChange(next === "all" ? "" : next)}
    >
      <SelectTrigger className="w-full sm:w-44" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value || "all"}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function LoopEmpty({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <Empty variant="outline">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Workflow />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  );
}

function LoopError({ error, retry }: { error: unknown; retry: () => void }) {
  const { copy } = useAdmin();
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {
          copy[
            error instanceof ApiError && [403, 404].includes(error.status)
              ? "forbiddenError"
              : errorMessage(error)
          ]
        }
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" onClick={retry}>
          {copy.retry}
        </Button>
      </AlertAction>
    </Alert>
  );
}
