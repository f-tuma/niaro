import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, Workflow } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@admin/components/ui/empty";
import { PageHeader } from "@admin/components/console/page";
import { useAdmin } from "./context";
import { useCatalog, CatalogBoundary } from "./catalog-shared";
import {
  DesignSessions,
  ProcessRows,
  processAuthority,
} from "./service-process-overview";
import { loadOwnedProcesses } from "./lib/owned-processes";
import { storedDesignSessions } from "./lib/process-design-client";
import { designEn, designCs } from "./process-design-copy";

export { loadOwnedProcesses };

export function WorkspaceProcessesPage() {
  const admin = useAdmin(),
    state = useCatalog(),
    copy = admin.language === "cs" ? designCs : designEn,
    authority = processAuthority(state, admin);
  const allowed =
    state.scope.ready &&
    !!state.query.data?.canManage &&
    admin.data.authentication.current === "better-auth" &&
    !state.query.isError &&
    !state.scope.identity.isError &&
    !state.scope.detail.isError;
  const query = useQuery({
    queryKey: [
      "admin",
      "workspace-processes",
      authority,
      state.target.organizationId,
      state.target.workspaceId,
    ],
    enabled: allowed,
    queryFn: ({ signal }) => loadOwnedProcesses(state.target, signal),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const { refetch } = query;
  useEffect(() => {
    if (allowed) void refetch();
  }, [admin.refreshGeneration, allowed, refetch]);
  const processes = allowed && !query.isError ? query.data : undefined;
  const sessions = allowed
    ? storedDesignSessions(
        { ...state.target, authority, serviceId: "" },
        sessionStorage,
      )
    : [];
  const design = (
    <Button asChild>
      <Link to="/processes/design" search={{}}>
        <Plus data-icon="inline-start" aria-hidden="true" />
        {copy.designProcess}
      </Link>
    </Button>
  );
  return (
    <CatalogBoundary state={state}>
      <div className="flex flex-col gap-8">
        <PageHeader
          title={copy.processes}
          actions={allowed && processes?.length ? design : undefined}
        />
        {!allowed ? (
          <Alert variant="destructive">
            <AlertDescription>{copy.processAccessLost}</AlertDescription>
          </Alert>
        ) : query.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{copy.processLoadFailed}</AlertDescription>
          </Alert>
        ) : query.isPending ? (
          <Skeleton className="h-32" />
        ) : processes?.length ? (
          <ProcessRows
            processes={processes}
            serviceId=""
            copy={copy}
            serviceNames={Object.fromEntries(
              (state.query.data?.services ?? []).map((service) => [
                service.id,
                service.name,
              ]),
            )}
          />
        ) : (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Workflow aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{copy.noWorkspaceProcesses}</EmptyTitle>
              <EmptyDescription>{copy.noProcessesHint}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>{design}</EmptyContent>
          </Empty>
        )}
        <DesignSessions sessions={sessions} serviceId="" copy={copy} />
      </div>
    </CatalogBoundary>
  );
}
