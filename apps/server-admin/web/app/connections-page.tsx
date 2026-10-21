import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChevronRight,
  KeyRound,
  LogIn,
  PlugZap,
  RefreshCw,
  Unplug,
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
} from "@admin/components/ui/alert";
import {
  Empty,
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
import { PageHeader } from "@admin/components/console/page";
import { StatusDot, type Tone } from "@admin/components/console/status";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { ConfirmAction, MoreActions } from "@admin/components/console/forms";
import type { ClientSession } from "../../../../packages/client-core/session";
import {
  PersonalSignInList,
  type PersonalSignIn,
} from "../../../../packages/protocol/service-oauth";
import { ServiceIconResponse } from "../../../../packages/protocol/service-catalog";
import { api } from "../lib/api";
import { ServiceGlyph } from "../catalog-shared";
import { useApp, useAppSession, type AppWorkspace } from "./context";
import { useAppCopy } from "./copy";
import { useMenuCopy, type MenuCopy } from "./menu-copy";
import { MenuPage } from "./menu-page";

/** A sign-in in another tab is given ten minutes, like the server's attempt. */
const ATTEMPT_MS = 10 * 60_000;

/** The state a row shows: connected, expired, not connected or not set up. */
export function signInState(
  service: PersonalSignIn,
  copy: MenuCopy,
): { tone: Tone; label: string } {
  if (service.status === "connected")
    return { tone: "success", label: copy.connectionConnected };
  if (!service.ready)
    return { tone: "neutral", label: copy.connectionNotReady };
  if (service.status === "expired")
    return { tone: "warning", label: copy.connectionExpired };
  return { tone: "neutral", label: copy.connectionDisconnected };
}

export function listKey(workspace: AppWorkspace) {
  return [
    "app",
    "sign-ins",
    workspace.organizationId,
    workspace.workspaceId,
  ] as const;
}

/** The person's own sign-ins to services that act under their account. */
export function ConnectionsPage() {
  const session = useAppSession();
  const { workspace } = useApp();
  return (
    <SignIns
      key={`${session.identityKey}:${workspace.workspaceId}`}
      session={session}
      workspace={workspace}
    />
  );
}

/**
 * The person's sign-ins with connect and disconnect. A sign-in opens the
 * provider in another tab and the list polls until it lands or times out.
 */
export function useSignIns(session: ClientSession, workspace: AppWorkspace) {
  const client = useQueryClient();
  const target = {
    organizationId: workspace.organizationId,
    workspaceId: workspace.workspaceId,
  };
  // Services whose sign-in runs in another tab, until it lands or times out.
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());
  const stopWaiting = (serviceId: string) =>
    setWaiting((current) => {
      const next = new Set(current);
      next.delete(serviceId);
      return next;
    });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<keyof MenuCopy | null>(null);
  const query = useQuery({
    queryKey: listKey(workspace),
    queryFn: async ({ signal }) =>
      PersonalSignInList.parse(
        await api("identity/catalog/oauth/list", target, signal),
      ),
    retry: false,
    refetchInterval: (current) =>
      [...waiting].some(
        (id) =>
          current.state.data?.services.find((s) => s.serviceId === id)
            ?.status !== "connected",
      )
        ? 2000
        : false,
  });
  const services = query.data?.services ?? [];

  async function connect(service: PersonalSignIn) {
    if (busy) return;
    // Open the tab inside the click so the browser allows it; the address
    // follows once the server has started the attempt.
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      setError("connectionPopupBlocked");
      return;
    }
    tab.opener = null;
    setBusy(service.serviceId);
    setError(null);
    try {
      const started = await session.serviceConnection(
        "start",
        service.serviceId,
        AbortSignal.timeout(10_000),
      );
      if (!("authorizationUrl" in started)) throw new Error("unexpected");
      tab.location.href = started.authorizationUrl;
      setWaiting((current) => new Set(current).add(service.serviceId));
      setTimeout(() => stopWaiting(service.serviceId), ATTEMPT_MS);
    } catch {
      tab.close();
      setError("connectionFailed");
    } finally {
      setBusy(null);
    }
  }
  async function disconnect(service: PersonalSignIn) {
    if (busy) return;
    setBusy(service.serviceId);
    setError(null);
    stopWaiting(service.serviceId);
    try {
      await api("identity/catalog/oauth/disconnect", {
        ...target,
        serviceId: service.serviceId,
        connectionRevision: service.connectionRevision,
      });
    } catch {
      setError("connectionFailed");
    } finally {
      setBusy(null);
      await client.invalidateQueries({ queryKey: listKey(workspace) });
    }
  }
  return {
    query,
    services,
    busy,
    waiting,
    error,
    connect: (service: PersonalSignIn) => void connect(service),
    disconnect: (service: PersonalSignIn) => void disconnect(service),
  };
}

function SignIns({
  session,
  workspace,
}: {
  session: ClientSession;
  workspace: AppWorkspace;
}) {
  const copy = useMenuCopy();
  const appCopy = useAppCopy();
  const { query, services, busy, waiting, error, connect } = useSignIns(
    session,
    workspace,
  );
  return (
    <MenuPage>
      <PageHeader
        title={appCopy.connections}
        count={services.length || undefined}
      />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{copy[error]}</AlertDescription>
        </Alert>
      )}
      {query.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{copy.connectionLoadFailed}</AlertDescription>
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
      ) : query.isPending ? (
        <div role="status" aria-label={appCopy.loading}>
          <Skeleton className="h-32 w-full" />
        </div>
      ) : services.length ? (
        <Card variant="list">
          {services.map((service) => (
            <SignInRow
              key={service.serviceId}
              service={service}
              workspace={workspace}
              copy={copy}
              busy={busy === service.serviceId}
              disabled={!!busy}
              waiting={
                waiting.has(service.serviceId) && service.status !== "connected"
              }
              onConnect={() => connect(service)}
            />
          ))}
        </Card>
      ) : (
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PlugZap />
            </EmptyMedia>
            <EmptyTitle>{copy.connectionsEmpty}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </MenuPage>
  );
}

function SignInRow({
  service,
  workspace,
  copy,
  busy,
  disabled,
  waiting,
  onConnect,
}: {
  service: PersonalSignIn;
  workspace: AppWorkspace;
  copy: MenuCopy;
  busy: boolean;
  disabled: boolean;
  waiting: boolean;
  onConnect(): void;
}) {
  const state = signInState(service, copy);
  const details = [
    service.account,
    service.requiredFor === "all" ? copy.connectionAll : copy.connectionWrites,
    service.provider ? `${copy.connectionVia} ${service.provider.name}` : null,
  ].filter(Boolean);
  // A missing sign-in is the next step, so it stays on the row; everything
  // else (permissions, disconnect) is in the service's detail.
  const signIn = service.ready && service.status !== "connected";
  return (
    <Item variant="row" size="row">
      <Link
        to="/connections/$serviceId"
        params={{ serviceId: service.serviceId }}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-sm outline-offset-4 focus-visible:outline-2"
      >
        <ItemMedia>
          <ServiceMark service={service} workspace={workspace} />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{service.name}</ItemTitle>
          <ItemDescription>
            <span className="flex flex-wrap items-center gap-x-2">
              <StatusDot tone={state.tone} size="sm">
                {waiting ? copy.connectionWaiting : state.label}
              </StatusDot>
              {details.length > 0 && <span>{details.join(" · ")}</span>}
            </span>
          </ItemDescription>
        </ItemContent>
        {!signIn && (
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}
      </Link>
      {signIn && (
        <ItemActions>
          <SignInButton
            service={service}
            copy={copy}
            busy={busy || waiting}
            disabled={disabled}
            onConnect={onConnect}
          />
        </ItemActions>
      )}
    </Item>
  );
}

/** Connect, or reconnect an expired account. */
export function SignInButton({
  service,
  copy,
  busy,
  disabled,
  onConnect,
}: {
  service: PersonalSignIn;
  copy: MenuCopy;
  busy: boolean;
  disabled: boolean;
  onConnect(): void;
}) {
  return (
    <Button size="sm" disabled={disabled} onClick={onConnect}>
      {busy ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <LogIn data-icon="inline-start" aria-hidden="true" />
      )}
      {service.status === "expired"
        ? copy.connectionReconnect
        : copy.connectionConnect}
    </Button>
  );
}

/** The "…" menu of a service: disconnect, behind a confirmation. Choices for
 * the assistant are kept. */
export function DisconnectMenu({
  copy,
  disabled,
  onDisconnect,
}: {
  copy: MenuCopy;
  disabled: boolean;
  onDisconnect(): void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <MoreActions label={copy.more}>
        <DropdownMenuItem
          variant="destructive"
          disabled={disabled}
          onSelect={() => setConfirm(true)}
        >
          <Unplug aria-hidden="true" />
          {copy.connectionDisconnect}
        </DropdownMenuItem>
      </MoreActions>
      <ConfirmAction
        open={confirm}
        onOpenChange={setConfirm}
        title={copy.connectionDisconnectTitle}
        description={copy.connectionDisconnectHint}
        confirmLabel={copy.connectionDisconnect}
        cancelLabel={copy.cancel}
        onConfirm={onDisconnect}
      />
    </>
  );
}

/** The service's favicon when it has one, its glyph otherwise. */
export function ServiceMark({
  service,
  workspace,
  size = "sm",
}: {
  service: PersonalSignIn;
  workspace: AppWorkspace;
  size?: "sm" | "lg";
}) {
  const icon = useQuery({
    queryKey: [
      "app",
      "service-icon",
      workspace.organizationId,
      workspace.workspaceId,
      service.serviceId,
    ],
    queryFn: async ({ signal }) =>
      ServiceIconResponse.parse(
        await api(
          "identity/catalog/icon",
          {
            organizationId: workspace.organizationId,
            workspaceId: workspace.workspaceId,
            serviceId: service.serviceId,
          },
          signal,
        ),
      ),
    enabled: service.iconSource === "favicon",
    staleTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const source = icon.data?.dataUrl;
  if (source)
    return (
      <EntityIcon size={size} tone="image">
        <img src={source} alt="" />
      </EntityIcon>
    );
  return service.icon ? (
    <ServiceGlyph icon={service.icon} size={size} />
  ) : (
    <EntityIcon size={size} tone="muted">
      <KeyRound />
    </EntityIcon>
  );
}
