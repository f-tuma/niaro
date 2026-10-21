import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import { IdentityId } from "../../../../packages/protocol/identity";
import { CatalogSchema } from "../../../../packages/protocol/service-catalog";
import { api } from "../lib/api";
import type { DesignClientScope } from "../lib/process-design-client";
import type { ProcessConsoleScope } from "../lib/process-console-client";
import { ProcessHostContext, type ProcessHost } from "../process-host";
import {
  ProcessDesignRuntime,
  designSearchSchema,
} from "../process-design-page";
import { ProcessConsoleRuntime } from "../process-console-page";
import { designCs, designEn } from "../process-design-copy";
import { consoleCs, consoleEn } from "../process-console-copy";
import { useApp } from "./context";
import { MenuPage } from "./menu-page";
import { personalProcessAuthority } from "./personal-processes";

/**
 * The console's designer and process page, mounted for the person's own
 * processes: links into administration only for administrators, and only
 * personal processes are managed here.
 */
function PersonalProcessHost({ children }: { children: ReactNode }) {
  const { isAdmin } = useApp();
  const host = useMemo<ProcessHost>(
    () => ({ adminLinks: isAdmin ? "page" : "none", personalOnly: true }),
    [isAdmin],
  );
  return (
    <ProcessHostContext.Provider value={host}>
      {children}
    </ProcessHostContext.Provider>
  );
}

/** Full width: the designer's conversation sits beside a tall canvas. */
function DesignerFrame({ children }: { children: ReactNode }) {
  return (
    <div
      data-designer-page
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <div className="flex w-full min-w-0 flex-col gap-8 px-4 pt-6 pb-12 md:px-8 md:pt-8">
        {children}
      </div>
    </div>
  );
}

/** A new personal process, or changes to one ("Edit"). */
export function PersonalDesignPage() {
  const app = useApp();
  const { workspace, isAdmin, language } = app;
  const userId = app.identity.user?.id;
  const search = designSearchSchema.parse(useSearch({ strict: false }));
  const { view, edit, ...designScope } = search;
  const base = language === "cs" ? designCs : designEn;
  // Members can't set limits themselves; budget refusals send them to an admin.
  const copy = isAdmin ? base : { ...base, budget: base.budgetMember };
  const target = {
    organizationId: workspace.organizationId,
    workspaceId: workspace.workspaceId,
  };
  // Administrators start with the workspace's routed model, as in the console.
  const catalog = useQuery({
    queryKey: ["app", "catalog", target.organizationId, target.workspaceId],
    enabled: isAdmin,
    queryFn: async ({ signal }) =>
      CatalogSchema.parse(
        await api(
          `identity/catalog?${new URLSearchParams(target)}`,
          undefined,
          signal,
        ),
      ),
    retry: false,
  });
  if (!userId)
    return (
      <DesignerFrame>
        <Alert variant="destructive">
          <AlertDescription>{copy.authorityLost}</AlertDescription>
        </Alert>
      </DesignerFrame>
    );
  const scope: DesignClientScope = {
    ...target,
    authority: personalProcessAuthority(userId, workspace),
    serviceId: "",
    owner: "user",
    ...designScope,
  };
  return (
    <PersonalProcessHost>
      <DesignerFrame>
        {isAdmin && catalog.isPending ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <ProcessDesignRuntime
            key={JSON.stringify(scope)}
            scopeJson={JSON.stringify(scope)}
            copy={copy}
            language={language}
            refreshGeneration={0}
            budgetReadable={isAdmin}
            preferredModelId={catalog.data?.routing.modelId ?? undefined}
            initialView={view}
            autoStart={edit === "canvas"}
          />
        )}
      </DesignerFrame>
    </PersonalProcessHost>
  );
}

/** A personal process: overview, version → test → activate. */
export function PersonalProcessPage() {
  const app = useApp();
  const { workspace, language } = app;
  const { processId } = useParams({ strict: false });
  const userId = app.identity.user?.id;
  const copy = language === "cs" ? consoleCs : consoleEn;
  const valid = !!userId && IdentityId.safeParse(processId).success;
  const scope: ProcessConsoleScope | null =
    valid && userId && processId
      ? {
          organizationId: workspace.organizationId,
          workspaceId: workspace.workspaceId,
          serviceId: "",
          processId,
          userId,
          authority: personalProcessAuthority(userId, workspace),
        }
      : null;
  return (
    <PersonalProcessHost>
      <MenuPage wide>
        {scope ? (
          <ProcessConsoleRuntime
            key={JSON.stringify(scope)}
            scopeJson={JSON.stringify(scope)}
            language={language}
            refreshGeneration={0}
          />
        ) : (
          <Alert variant="destructive">
            <AlertDescription>{copy.authority}</AlertDescription>
          </Alert>
        )}
      </MenuPage>
    </PersonalProcessHost>
  );
}
