import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Cable,
  Database,
  Users,
  CalendarDays,
  Mail,
  Code2,
  Folder,
  Search,
  Trash2,
} from "lucide-react";
import {
  CatalogSchema,
  type Service,
} from "../../../packages/protocol/service-catalog";
import { useAdmin } from "./context";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { ConfirmAction, MoreActions } from "@admin/components/console/forms";
import { DropdownMenuItem } from "@admin/components/ui/dropdown-menu";
import type { Tone } from "@admin/components/console/status";
import { useConsoleScope } from "./console-scope";
import { useCatalogCopy, type CatalogCopy } from "./catalog-copy";
import { api, ApiError } from "./lib/api";
import { Button } from "@admin/components/ui/button";
import {
  AlertAction,
  Alert,
  AlertDescription,
} from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@admin/components/ui/empty";
export function catalogIssue(error: unknown, copy: CatalogCopy) {
  if (error instanceof SyntaxError) return copy.invalid;
  if (error instanceof ApiError) {
    if (error.code === "integration_openapi_required")
      return copy.openapiRequired;
    if (error.code === "integration_origin_denied") return copy.originDenied;
    if (error.code === "integration_schema_unsupported")
      return copy.schemaUnsupported;
    if (error.code === "integration_model_response_invalid")
      return copy.enrichmentFailed;
    if (error.code === "catalog_model_required") return copy.modelRequired;
    if (error.code === "catalog_key_required") return copy.keyRequired;
    if (error.code === "catalog_model_exists") return copy.modelExists;
    if (error.code === "catalog_model_unavailable")
      return copy.unavailableModel;
    if (error.code === "identity_limit") return copy.catalogLimit;
    if (error.code === "catalog_provider_limit") return copy.budgetReached;
    if (error.code?.startsWith("catalog_budget_")) return copy.usageLimits;
    if (error.code === "catalog_service_in_use") return copy.serviceInUse;
    if (error.code?.endsWith("_in_use")) return copy.inUse;
    if (error.status === 409) return copy.conflict;
    if (error.status === 403 || error.status === 401) return copy.forbidden;
    if (error.status === 400) return copy.invalid;
    if (error.status >= 500) return copy.unavailable;
  }
  return copy.error;
}
export function useCatalog() {
  const scope = useConsoleScope(),
    { data } = useAdmin();
  const copy = useCatalogCopy();
  const client = useQueryClient();
  const target = {
    organizationId: scope.organization?.id ?? "",
    workspaceId: scope.workspace?.id ?? "",
  };
  const query = useQuery({
    queryKey: [
      "admin",
      "catalog",
      data.authentication.principalId,
      target.organizationId,
      target.workspaceId,
      scope.organization?.role,
    ],
    queryFn: async ({ signal }) =>
      CatalogSchema.parse(
        await api(
          `identity/catalog?${new URLSearchParams(target)}`,
          undefined,
          signal,
        ),
      ),
    enabled: scope.ready,
    staleTime: 0,
    refetchInterval: 20000,
  });
  const request = useRef<AbortController | null>(null);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  useEffect(
    () => () => request.current?.abort(),
    [target.organizationId, target.workspaceId],
  );
  async function mutate(path: string, body: Record<string, unknown>) {
    if (request.current || !scope.ready || query.isError) return undefined;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    setConflict(false);
    setNotice(null);
    try {
      const result = await api(
        `identity/catalog/${path}`,
        { ...target, ...body },
        controller.signal,
      );
      await client.invalidateQueries({ queryKey: ["admin", "catalog"] });
      await client.invalidateQueries({ queryKey: ["admin", "audit"] });
      if (!controller.signal.aborted && path !== "discover")
        setNotice(copy.saved);
      return controller.signal.aborted ? undefined : result;
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(catalogIssue(e, copy));
        setConflict(e instanceof ApiError && e.code === "catalog_conflict");
      }
      return undefined;
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  return {
    draftEpoch,
    conflict,
    resetDrafts: async () => {
      const latest = await query.refetch();
      if (latest.isSuccess) {
        setDraftEpoch((v) => v + 1);
        setError(null);
        setConflict(false);
      }
    },
    scope,
    target,
    query,
    busy,
    error,
    notice,
    setNotice,
    setError,
    mutate,
    copy,
  };
}
export type CatalogState = ReturnType<typeof useCatalog>;
export function CatalogBoundary({
  state,
  children,
}: {
  state: CatalogState;
  children: ReactNode;
}) {
  const { scope, query, copy } = state;
  if (
    scope.identity.isPending ||
    (scope.detail.isPending && !!scope.organization)
  )
    return <Skeleton className="h-48 w-full" />;
  const loadErrors = [query.error, scope.identity.error, scope.detail.error];
  const authorityError = loadErrors.find(
    (e) => e instanceof ApiError && [401, 403, 404].includes(e.status),
  );
  const loadError = authorityError ?? loadErrors.find(Boolean);
  const errorBanner =
    scope.identity.isError || scope.detail.isError || query.isError ? (
      <Alert variant="destructive">
        <AlertDescription>{catalogIssue(loadError, copy)}</AlertDescription>
        <AlertAction>
          <Button
            variant="outline"
            onClick={() => {
              void scope.identity.refetch();
              void scope.detail.refetch();
              void query.refetch();
            }}
          >
            {copy.refresh}
          </Button>
        </AlertAction>
      </Alert>
    ) : null;
  if (
    errorBanner &&
    (!query.data ||
      (loadError instanceof ApiError &&
        [401, 403, 404].includes(loadError.status)))
  )
    return errorBanner;
  if (!scope.workspace)
    return (
      <Empty variant="outline">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Folder />
          </EmptyMedia>
          <EmptyTitle>{copy.noWorkspace}</EmptyTitle>
          <EmptyDescription>{copy.workspaceHint}</EmptyDescription>
        </EmptyHeader>
        <Button asChild>
          <Link to="/workspaces">{copy.workspaces}</Link>
        </Button>
      </Empty>
    );
  if (!query.data) return <Skeleton className="h-48 w-full" />;
  return (
    <>
      {errorBanner}
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
          {state.conflict && (
            <AlertAction>
              <Button
                variant="outline"
                onClick={() => void state.resetDrafts()}
              >
                {copy.reloadSaved}
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      {/* Saving is visible as the save bar closing; the notice is for screen readers. */}
      {state.notice && (
        <p role="status" className="sr-only">
          {state.notice}
        </p>
      )}
      <Fragment key={state.draftEpoch}>{children}</Fragment>
    </>
  );
}
const icons = {
  plug: Cable,
  database: Database,
  users: Users,
  calendar: CalendarDays,
  mail: Mail,
  code: Code2,
  folder: Folder,
  search: Search,
};
export function ServiceGlyph({
  icon,
  size = "md",
}: {
  icon: Service["icon"];
  size?: "sm" | "md" | "lg";
}) {
  const Icon = icons[icon];
  return (
    <EntityIcon size={size}>
      <Icon />
    </EntityIcon>
  );
}
/** Destructive remove behind a `…` menu, always confirmed. */
export function DeleteButton({
  onDelete,
  disabled,
  label,
  title,
}: {
  onDelete: () => void;
  disabled?: boolean;
  label?: string;
  title?: string;
}) {
  const copy = useCatalogCopy();
  const [open, setOpen] = useState(false);
  return (
    <>
      <MoreActions label={copy.moreActions} size="sm">
        <DropdownMenuItem
          variant="destructive"
          disabled={disabled}
          onSelect={() => setOpen(true)}
        >
          <Trash2 aria-hidden="true" />
          {label ?? copy.remove}
        </DropdownMenuItem>
      </MoreActions>
      <ConfirmAction
        open={open}
        onOpenChange={setOpen}
        title={title ?? copy.confirmRemove}
        confirmLabel={label ?? copy.remove}
        cancelLabel={copy.cancel}
        onConfirm={onDelete}
      />
    </>
  );
}

/** One presentation of who may run an action, used by cards and tables. */
export function actionAccess(
  action: Service["actions"][number],
  copy: CatalogCopy,
): { tone: Tone; label: string } {
  const roles = action.policy.roles;
  if (roles.length === 3) return { tone: "neutral", label: copy.everyone };
  if (roles.length)
    return { tone: "neutral", label: roles.map((r) => copy[r]).join(", ") };
  if (action.policy.workspaceRoles?.length)
    return { tone: "neutral", label: copy.access };
  if (action.policy.users.some((u) => u.access === "allow"))
    return { tone: "neutral", label: copy.people };
  return { tone: "warning", label: copy.noAccess };
}
/** The editable settings of a saved service, for commands that change one field. */
export function serviceSettings(service: Service) {
  const {
    id: _id,
    revision: _revision,
    hasCredential: _credential,
    actions: _actions,
    modelId: _model,
    ...settings
  } = service;
  return settings;
}
export const hasAccess = (action: Service["actions"][number]) =>
  action.enabled &&
  (action.policy.roles.length > 0 ||
    !!action.policy.workspaceRoles?.length ||
    action.policy.users.some((u) => u.access === "allow"));
