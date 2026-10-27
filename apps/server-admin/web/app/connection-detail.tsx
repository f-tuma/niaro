import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Pencil, Plus, RefreshCw, Search } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Card } from "@admin/components/ui/card";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Switch } from "@admin/components/ui/switch";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@admin/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@admin/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@admin/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import { PageHeader, Section } from "@admin/components/console/page";
import { StatusDot } from "@admin/components/console/status";
import type { ClientSession } from "../../../../packages/client-core/session";
import {
  PersonalServicePermissions,
  type PersonalActionPermission,
} from "../../../../packages/protocol/service-oauth";
import { api, ApiError } from "../lib/api";
import { useApp, useAppSession, type AppWorkspace } from "./context";
import { useAppCopy } from "./copy";
import { useMenuCopy, type MenuCopy } from "./menu-copy";
import { MenuPage } from "./menu-page";
import {
  OwnServiceMenu,
  OwnSignInButton,
  ownServiceState,
  ownServiceTools,
  useOwnServices,
} from "./own-services";
import type { PersonalServiceSummaryValue } from "../../../../packages/protocol/service-catalog";
import { EditActionSheet, FindActionsSheet } from "./own-service-actions";
import {
  DisconnectMenu,
  ServiceMark,
  SignInButton,
  signInState,
  useSignIns,
} from "./connections-page";

/** Search appears once a list is long enough to need it. */
const SEARCH_FROM = 8;

/** One personal service: the account, and what the assistant may do with it. */
export function ConnectionDetailPage() {
  const session = useAppSession();
  const { workspace } = useApp();
  const { serviceId } = useParams({ strict: false }) as { serviceId?: string };
  return (
    <ConnectionDetail
      key={`${session.identityKey}:${workspace.workspaceId}:${serviceId}`}
      session={session}
      workspace={workspace}
      serviceId={serviceId ?? ""}
    />
  );
}

function ConnectionDetail({
  session,
  workspace,
  serviceId,
}: {
  session: ClientSession;
  workspace: AppWorkspace;
  serviceId: string;
}) {
  const copy = useMenuCopy();
  const appCopy = useAppCopy();
  const signIns = useSignIns(session, workspace);
  const service = signIns.services.find((s) => s.serviceId === serviceId);
  const own = useOwnServices(workspace);
  const mine = own.services.find((s) => s.id === serviceId);
  const back = { to: "/connections" as const, label: appCopy.connections };
  if (!service && mine)
    return (
      <OwnServiceDetail
        service={mine}
        own={own}
        workspace={workspace}
        back={back}
      />
    );
  if (signIns.query.isError)
    return (
      <MenuPage>
        <PageHeader title={appCopy.connections} back={back} />
        <Alert variant="destructive">
          <AlertDescription>{copy.connectionLoadFailed}</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void signIns.query.refetch()}
            >
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              {copy.retry}
            </Button>
          </AlertAction>
        </Alert>
      </MenuPage>
    );
  if (signIns.query.isPending || own.query.isPending)
    return (
      <MenuPage>
        <div role="status" aria-label={appCopy.loading}>
          <Skeleton className="h-64 w-full" />
        </div>
      </MenuPage>
    );
  if (!service)
    return (
      <MenuPage>
        <PageHeader title={appCopy.connections} back={back} />
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyTitle>{copy.connectionNotFound}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </MenuPage>
    );
  const state = signInState(service, copy);
  const waiting =
    signIns.waiting.has(service.serviceId) && service.status !== "connected";
  const details = [
    service.account,
    service.provider ? `${copy.connectionVia} ${service.provider.name}` : null,
  ].filter(Boolean);
  return (
    <MenuPage>
      <PageHeader
        title={service.name}
        back={back}
        media={
          <ServiceMark service={service} workspace={workspace} size="lg" />
        }
        meta={
          <>
            <StatusDot tone={state.tone} size="sm">
              {waiting ? copy.connectionWaiting : state.label}
            </StatusDot>
            {details.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {details.join(" · ")}
              </span>
            )}
          </>
        }
        actions={
          <>
            {service.ready && service.status !== "connected" && (
              <SignInButton
                service={service}
                copy={copy}
                busy={signIns.busy === service.serviceId || waiting}
                disabled={!!signIns.busy}
                onConnect={() => signIns.connect(service)}
              />
            )}
            {service.status !== "disconnected" && (
              <DisconnectMenu
                copy={copy}
                disabled={!!signIns.busy}
                onDisconnect={() => signIns.disconnect(service)}
              />
            )}
          </>
        }
      />
      {signIns.error && (
        <Alert variant="destructive">
          <AlertDescription>{copy[signIns.error]}</AlertDescription>
        </Alert>
      )}
      {!service.ready && (
        <Alert>
          <AlertDescription>{copy.connectionNotReadyHint}</AlertDescription>
        </Alert>
      )}
      <PersonalPermissions
        workspace={workspace}
        serviceId={service.serviceId}
      />
    </MenuPage>
  );
}

/** A service the person connected themselves: its state, its menu and the
 * assistant's permissions once an administrator let it through. */
function OwnServiceDetail({
  service,
  own,
  workspace,
  back,
}: {
  service: PersonalServiceSummaryValue;
  own: ReturnType<typeof useOwnServices>;
  workspace: AppWorkspace;
  back: { to: "/connections"; label: string };
}) {
  const copy = useMenuCopy();
  const navigate = useNavigate();
  const state = ownServiceState(service, copy);
  return (
    <MenuPage>
      <PageHeader
        title={service.name}
        back={back}
        media={
          <ServiceMark
            service={{
              serviceId: service.id,
              icon: service.icon,
              iconSource: service.iconSource,
            }}
            workspace={workspace}
            size="lg"
          />
        }
        meta={
          <>
            <StatusDot tone={state.tone} size="sm">
              {state.label}
            </StatusDot>
            <span className="text-xs text-muted-foreground">
              {ownServiceTools(service, copy)} · {new URL(service.url).host}
            </span>
          </>
        }
        actions={
          <>
            {service.signIn === "needed" && service.status !== "rejected" && (
              <OwnSignInButton service={service} own={own} copy={copy} />
            )}
            <OwnServiceMenu
              service={service}
              own={own}
              copy={copy}
              onRemoved={() => void navigate({ to: "/connections" })}
            />
          </>
        }
      />
      {own.error && (
        <Alert variant="destructive">
          <AlertDescription>{copy[own.error]}</AlertDescription>
        </Alert>
      )}
      {state.hint && (
        <Alert>
          <AlertDescription>{state.hint}</AlertDescription>
        </Alert>
      )}
      {service.status === "active" && service.signIn !== "needed" && (
        <PersonalPermissions
          workspace={workspace}
          serviceId={service.id}
          owner={{ service, own }}
        />
      )}
    </MenuPage>
  );
}

function permissionsKey(workspace: AppWorkspace, serviceId: string) {
  return [
    "app",
    "personal-permissions",
    workspace.organizationId,
    workspace.workspaceId,
    serviceId,
  ] as const;
}

type Change = {
  actionId: string;
  enabled: boolean;
  approval: "always" | "never";
};

/**
 * The person's own switches for the service's actions: reads and changes
 * apart, approval per change. Each change saves at once against the person's
 * revision; while one saves, the list waits.
 */
export function PersonalPermissions({
  workspace,
  serviceId,
  owner,
}: {
  workspace: AppWorkspace;
  serviceId: string;
  /** The person's own service: they find, describe and remove its actions
   * too, where the server says they manage it. */
  owner?: {
    service: PersonalServiceSummaryValue;
    own: ReturnType<typeof useOwnServices>;
  };
}) {
  const copy = useMenuCopy();
  const client = useQueryClient();
  const key = permissionsKey(workspace, serviceId);
  const target = {
    organizationId: workspace.organizationId,
    workspaceId: workspace.workspaceId,
    serviceId,
  };
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      PersonalServicePermissions.parse(
        await api("identity/catalog/oauth/permissions", target, signal),
      ),
    retry: false,
  });
  const [search, setSearch] = useState("");
  const [finding, setFinding] = useState(false);
  const [editing, setEditing] = useState<PersonalActionPermission | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<
    "permissionsSaveFailed" | "permissionsChanged" | null
  >(null);

  async function save(changes: Change[]) {
    const current = query.data;
    if (!current || saving || !changes.length) return;
    setSaving(true);
    setNotice(null);
    // Shown right away; the saved answer (or a reload) replaces it.
    client.setQueryData(key, {
      ...current,
      actions: current.actions.map((action) => {
        const change = changes.find((c) => c.actionId === action.id);
        return change
          ? { ...action, enabled: change.enabled, approval: change.approval }
          : action;
      }),
    });
    try {
      client.setQueryData(
        key,
        PersonalServicePermissions.parse(
          await api("identity/catalog/oauth/permissions/save", {
            ...target,
            revision: current.revision,
            actions: changes,
          }),
        ),
      );
    } catch (error) {
      setNotice(
        error instanceof ApiError && error.status === 409
          ? "permissionsChanged"
          : "permissionsSaveFailed",
      );
      await client.invalidateQueries({ queryKey: key });
    } finally {
      setSaving(false);
    }
  }

  if (query.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{copy.permissionsLoadFailed}</AlertDescription>
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
    );
  if (query.isPending)
    return (
      <div role="status" aria-label={copy.permissionsTitle}>
        <Skeleton className="h-48 w-full" />
      </div>
    );
  const data = query.data;
  const manage = data.manage && owner ? owner : undefined;
  const term = search.trim().toLocaleLowerCase();
  const matches = (action: PersonalActionPermission) =>
    `${action.name} ${action.description}`.toLocaleLowerCase().includes(term);
  const groups = (["read", "write"] as const)
    .map((effect) => ({
      effect,
      all: data.actions.filter((action) => action.effect === effect),
    }))
    .filter((group) => group.all.length > 0);
  return (
    <Section
      id="personal-permissions"
      title={copy.permissionsTitle}
      toolbar={
        data.actions.length >= SEARCH_FROM && (
          <InputGroup className="w-full sm:max-w-xs">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label={copy.permissionsSearch}
              placeholder={copy.permissionsSearch}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </InputGroup>
        )
      }
      actions={
        manage && (
          <Button variant="outline" size="sm" onClick={() => setFinding(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            {copy.actionsFind}
          </Button>
        )
      }
    >
      {manage && (
        <FindActionsSheet
          service={manage.service}
          own={manage.own}
          workspace={workspace}
          copy={copy}
          open={finding}
          onOpenChange={setFinding}
        />
      )}
      {manage && editing && (
        <EditActionSheet
          key={editing.id}
          service={manage.service}
          action={editing}
          own={manage.own}
          copy={copy}
          onClose={() => setEditing(null)}
        />
      )}
      <div className="flex flex-col gap-6">
        {notice && (
          <Alert
            variant={
              notice === "permissionsChanged" ? "default" : "destructive"
            }
          >
            <AlertDescription>{copy[notice]}</AlertDescription>
          </Alert>
        )}
        {owner && !data.manage && (
          <p className="text-sm text-muted-foreground">
            {copy.ownServiceManagedByAdmins}
          </p>
        )}
        {data.requiredFor === "writes" && (
          <p className="text-sm text-muted-foreground">
            {copy.permissionsReadsShared}
          </p>
        )}
        {!groups.length ? (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyTitle>{copy.permissionsEmpty}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          groups.map((group) => (
            <PermissionGroup
              key={group.effect}
              copy={copy}
              title={
                group.effect === "read"
                  ? copy.permissionsReads
                  : copy.permissionsWrites
              }
              actions={group.all.filter(matches)}
              disabled={saving}
              onChange={(changes) => void save(changes)}
              onEdit={manage ? setEditing : undefined}
            />
          ))
        )}
        {groups.length > 0 && term && !data.actions.some(matches) && (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyDescription>{copy.permissionsNoMatch}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </Section>
  );
}

function PermissionGroup({
  copy,
  title,
  actions,
  disabled,
  onChange,
  onEdit,
}: {
  copy: MenuCopy;
  title: string;
  actions: PersonalActionPermission[];
  disabled: boolean;
  onChange(changes: Change[]): void;
  /** The owner of the service edits the action itself. */
  onEdit?: (action: PersonalActionPermission) => void;
}) {
  if (!actions.length) return null;
  const allOn = actions.every((action) => action.enabled);
  const change = (
    action: PersonalActionPermission,
    patch: Partial<Change>,
  ): Change => ({
    actionId: action.id,
    enabled: action.enabled,
    approval: action.approval,
    ...patch,
  });
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h3 className="flex items-baseline gap-2 text-sm font-medium">
          {title}
          <span className="font-normal text-muted-foreground tabular-nums">
            {actions.filter((action) => action.enabled).length}/{actions.length}
          </span>
        </h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() =>
            onChange(
              actions
                .filter((action) => action.enabled === allOn)
                .map((action) => change(action, { enabled: !allOn })),
            )
          }
        >
          {allOn ? copy.permissionsAllOff : copy.permissionsAllOn}
        </Button>
      </div>
      <Card variant="list">
        {actions.map((action) => (
          <Item key={action.id} variant="row" size="row">
            <ItemContent>
              <ItemTitle>{action.name}</ItemTitle>
              {action.description && (
                <ItemDescription>{action.description}</ItemDescription>
              )}
            </ItemContent>
            <ItemActions>
              {action.effect === "write" && (
                <Select
                  value={action.approval}
                  disabled={disabled || !action.enabled}
                  onValueChange={(approval) =>
                    onChange([
                      change(action, {
                        approval: approval === "never" ? "never" : "always",
                      }),
                    ])
                  }
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={`${copy.permissionsApproval}: ${action.name}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="always">
                      {copy.permissionsAsk}
                    </SelectItem>
                    <SelectItem value="never">
                      {copy.permissionsNoAsk}
                    </SelectItem>
                  </SelectContent>
                </Select>
              )}
              {onEdit && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={copy.actionEdit.replace("{name}", action.name)}
                  disabled={disabled}
                  onClick={() => onEdit(action)}
                >
                  <Pencil aria-hidden="true" />
                </Button>
              )}
              <Switch
                aria-label={action.name}
                checked={action.enabled}
                disabled={disabled}
                onCheckedChange={(enabled) =>
                  onChange([change(action, { enabled })])
                }
              />
            </ItemActions>
          </Item>
        ))}
      </Card>
    </section>
  );
}
