import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronRight, MessageSquare, Plus, Workflow } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Card } from "@admin/components/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@admin/components/ui/empty";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Section } from "@admin/components/console/page";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { StatusBadge } from "@admin/components/console/status";
import { RelativeTime } from "@admin/components/console/time";
import { useAdmin } from "./context";
import type { CatalogState } from "./catalog-shared";
import { ApiError } from "./lib/api";
import { storedDesignSessions } from "./lib/process-design-client";
import {
  loadWorkspaceProcesses,
  workspaceProcessesKey,
} from "./lib/service-process-overview";
import { processConsoleRoute, processDesignRoute } from "./lib/process-routes";
import { designEn, designCs, type DesignCopy } from "./process-design-copy";

export function processAuthority(
  state: CatalogState,
  admin: ReturnType<typeof useAdmin>,
) {
  return [
    admin.authorityGeneration,
    admin.data.authentication.current,
    admin.data.authentication.principalId,
    admin.data.authentication.expiresAt,
    state.scope.identity.data?.user?.id,
    state.scope.organization?.role,
  ].join(":");
}
function mayRead(state: CatalogState, admin: ReturnType<typeof useAdmin>) {
  return (
    state.scope.ready &&
    admin.data.authentication.current === "better-auth" &&
    !!state.query.data?.canManage &&
    !state.query.isError &&
    !state.scope.identity.isError &&
    !state.scope.detail.isError
  );
}

/** All service cards share this authority/workspace inventory; private data never survives denial. */
export function useWorkspaceProcesses(state: CatalogState) {
  const admin = useAdmin();
  const allowed = mayRead(state, admin);
  const query = useQuery({
    queryKey: workspaceProcessesKey(
      processAuthority(state, admin),
      state.target,
    ),
    enabled: allowed,
    queryFn: ({ signal }) => loadWorkspaceProcesses(state.target, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  return { ...query, data: allowed && !query.isError ? query.data : undefined };
}
function denied(error: unknown) {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

type ProcessSummary = {
  id: string;
  name: string;
  kind: "agent" | "workflow";
  activeVersion: number | null;
  updatedAt: string;
  serviceId?: string | null;
  /** Blocked until it is tested again (a service or model changed). */
  retestNeeded?: true;
};

/** Rows of processes; each row opens the process page. */
export function ProcessRows({
  processes,
  serviceId,
  copy,
  serviceNames,
}: {
  processes: ProcessSummary[];
  serviceId: string;
  copy: DesignCopy;
  serviceNames?: Record<string, string>;
}) {
  return (
    <Card variant="list">
      {processes.map((p) => {
        const Icon = p.kind === "agent" ? Bot : Workflow;
        return (
          <Item key={p.id} asChild variant="row" size="row">
            {/* A blocked process opens on its Tests tab, where the fix is. */}
            <Link
              {...processConsoleRoute(p.serviceId ?? serviceId, p.id)}
              state={
                p.retestNeeded
                  ? (previous) => ({ ...previous, processTab: "tests" })
                  : undefined
              }
            >
              <ItemMedia>
                <EntityIcon size="sm">
                  <Icon />
                </EntityIcon>
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {p.name}
                  <span className="sr-only">, {copy[p.kind]}</span>
                </ItemTitle>
                {/* The icon carries the kind; only a service owner adds information. */}
                {serviceNames && p.serviceId && (
                  <ItemDescription>
                    {serviceNames[p.serviceId] ?? copy.service}
                  </ItemDescription>
                )}
              </ItemContent>
              <ItemActions>
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  <RelativeTime value={p.updatedAt} />
                </span>
                {p.retestNeeded && (
                  <StatusBadge tone="warning">{copy.retestNeeded}</StatusBadge>
                )}
                {p.activeVersion ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    <span className="sr-only">{copy.activeVersion} </span>v
                    {p.activeVersion}
                  </span>
                ) : (
                  <StatusBadge tone="neutral">{copy.draft}</StatusBadge>
                )}
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
              </ItemActions>
            </Link>
          </Item>
        );
      })}
    </Card>
  );
}

/** Unsaved designer conversations kept in this browser tab. */
export function DesignSessions({
  sessions,
  serviceId,
  copy,
}: {
  sessions: string[];
  serviceId: string;
  copy: DesignCopy;
}) {
  if (!sessions.length) return null;
  return (
    <Section title={copy.inProgress} count={sessions.length}>
      <Card variant="list">
        {sessions.map((sessionId, index) => (
          <Item key={sessionId} asChild variant="row" size="row">
            <Link {...processDesignRoute(serviceId)} search={{ sessionId }}>
              <ItemMedia>
                <EntityIcon size="sm" tone="muted">
                  <MessageSquare />
                </EntityIcon>
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {sessions.length > 1
                    ? `${copy.designConversation} ${index + 1}`
                    : copy.designConversation}
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <span className="text-xs text-muted-foreground">
                  {copy.resume}
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
              </ItemActions>
            </Link>
          </Item>
        ))}
      </Card>
    </Section>
  );
}

export function ServiceProcessOverview({
  state,
  serviceId,
}: {
  state: CatalogState;
  serviceId: string;
}) {
  const admin = useAdmin();
  const copy = admin.language === "cs" ? designCs : designEn;
  const query = useWorkspaceProcesses(state);
  const allowed = mayRead(state, admin);
  const serviceEnabled = !!state.query.data?.services.find(
    (s) => s.id === serviceId,
  )?.enabled;
  const auth = processAuthority(state, admin);
  const processes = query.data?.filter((p) => p.serviceId === serviceId) ?? [];
  const sessions = allowed
    ? storedDesignSessions(
        { ...state.target, authority: auth, serviceId },
        sessionStorage,
      )
    : [];
  const add = allowed && !query.isError && serviceEnabled && (
    <Button asChild variant="outline" size="sm">
      <Link
        to="/services/$serviceId/processes/design"
        params={{ serviceId }}
        search={{}}
      >
        <Plus data-icon="inline-start" aria-hidden="true" />
        {copy.add}
      </Link>
    </Button>
  );
  return (
    <div className="flex min-w-0 flex-col gap-8" data-service-process-overview>
      <Section
        title={copy.processes}
        count={query.data && processes.length ? processes.length : undefined}
        actions={processes.length > 0 && add}
      >
        {!allowed ? (
          <p className="text-sm text-muted-foreground">
            {state.query.data?.canManage
              ? copy.processLoadFailed
              : copy.processManagementRequired}
          </p>
        ) : query.isError ? (
          <Alert variant="destructive">
            <AlertDescription>
              {denied(query.error)
                ? copy.processAccessLost
                : copy.processLoadFailed}
            </AlertDescription>
          </Alert>
        ) : query.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="flex flex-col gap-3">
            {!serviceEnabled && (
              <Alert>
                <AlertDescription>{copy.pausedDesigner}</AlertDescription>
              </Alert>
            )}
            {processes.length ? (
              <ProcessRows
                processes={processes}
                serviceId={serviceId}
                copy={copy}
              />
            ) : (
              <Empty variant="outline">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Workflow aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>{copy.noProcesses}</EmptyTitle>
                  <EmptyDescription>{copy.noProcessesHint}</EmptyDescription>
                </EmptyHeader>
                {add && <EmptyContent>{add}</EmptyContent>}
              </Empty>
            )}
          </div>
        )}
      </Section>
      <DesignSessions sessions={sessions} serviceId={serviceId} copy={copy} />
    </div>
  );
}
