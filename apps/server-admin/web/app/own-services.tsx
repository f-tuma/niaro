import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChevronRight,
  LogIn,
  Pencil,
  Plus,
  PlugZap,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Card } from "@admin/components/ui/card";
import { DropdownMenuItem } from "@admin/components/ui/dropdown-menu";
import { Input } from "@admin/components/ui/input";
import { Spinner } from "@admin/components/ui/spinner";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@admin/components/ui/field";
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
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";
import { Section } from "@admin/components/console/page";
import { StatusDot, type Tone } from "@admin/components/console/status";
import { ConfirmAction, MoreActions } from "@admin/components/console/forms";
import {
  PersonalServiceList,
  PersonalServiceSummary,
  type PersonalServiceSummaryValue,
} from "../../../../packages/protocol/service-catalog";
import { api, ApiError } from "../lib/api";
import { useAppSession, type AppWorkspace } from "./context";
import { useMenuCopy, type MenuCopy } from "./menu-copy";
import { ServiceMark } from "./connections-page";

export function ownServicesKey(workspace: AppWorkspace) {
  return [
    "app",
    "own-services",
    workspace.organizationId,
    workspace.workspaceId,
  ] as const;
}

/** What a failed command says, in the person's words. */
function failureKey(error: unknown): keyof MenuCopy {
  if (error instanceof ApiError) {
    if (error.code === "catalog_personal_unreachable")
      return "ownServiceUnreachable";
    if (error.code === "catalog_personal_services_off") return "ownServicesOff";
    if (error.code === "identity_limit") return "ownServiceLimit";
    if (error.code === "catalog_conflict") return "ownServiceConflict";
    if (error.code === "integration_origin_denied") return "ownServiceUrlHint";
  }
  return "ownServiceFailed";
}

/** The person's own services, with the commands their owner may run. */
export function useOwnServices(workspace: AppWorkspace) {
  const client = useQueryClient();
  const session = useAppSession();
  const key = ownServicesKey(workspace);
  // Services whose sign-in tab is open; the list is read again until it lands.
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const target = {
    organizationId: workspace.organizationId,
    workspaceId: workspace.workspaceId,
  };
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      PersonalServiceList.parse(
        await api("identity/catalog/personal/list", target, signal),
      ),
    retry: false,
    refetchInterval: (current) =>
      signingIn &&
      current.state.data?.services.find((s) => s.id === signingIn)?.signIn !==
        "connected"
        ? 2000
        : false,
  });
  // Once the sign-in landed, the service's tools are read with it.
  const landed = query.data?.services.find(
    (s) => s.id === signingIn && s.signIn === "connected",
  );
  useEffect(() => {
    if (!landed) return;
    // After this render: the list that showed the sign-in is settled first.
    const next = setTimeout(() => {
      setSigningIn(null);
      if (landed.reads + landed.writes === 0)
        void command(landed.id, {
          type: "rediscover",
          id: landed.id,
          revision: landed.revision,
        });
    }, 0);
    return () => clearTimeout(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landed?.id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<keyof MenuCopy | null>(null);
  async function command(
    id: string,
    body: Record<string, unknown>,
  ): Promise<PersonalServiceSummaryValue | undefined> {
    if (busy) return undefined;
    setBusy(id);
    setError(null);
    try {
      const result = await api("identity/catalog/personal/command", {
        ...target,
        ...body,
      });
      await client.invalidateQueries({ queryKey: key });
      // The chat's catalog and the permissions change with the service.
      await client.invalidateQueries({ queryKey: ["app", "catalog"] });
      await client.invalidateQueries({
        queryKey: ["app", "personal-permissions"],
      });
      return body.type === "remove"
        ? undefined
        : PersonalServiceSummary.parse(result);
    } catch (e) {
      setError(failureKey(e));
      await client.invalidateQueries({ queryKey: key });
      return undefined;
    } finally {
      setBusy(null);
    }
  }
  /** Opens the service's own sign-in in a new tab (inside the click, so the
   * browser allows it); the address follows once the server started it. */
  async function signIn(service: PersonalServiceSummaryValue) {
    if (busy) return;
    const tab = window.open("about:blank", "_blank");
    if (!tab) {
      setError("connectionPopupBlocked");
      return;
    }
    tab.opener = null;
    setBusy(service.id);
    setError(null);
    try {
      const started = await session.serviceConnection(
        "start",
        service.id,
        AbortSignal.timeout(10_000),
      );
      if (!("authorizationUrl" in started)) throw new Error("unexpected");
      tab.location.href = started.authorizationUrl;
      setSigningIn(service.id);
      setTimeout(
        () =>
          setSigningIn((current) => (current === service.id ? null : current)),
        10 * 60_000,
      );
    } catch {
      tab.close();
      setError("ownServiceFailed");
    } finally {
      setBusy(null);
    }
  }
  return {
    query,
    signingIn,
    signIn: (service: PersonalServiceSummaryValue) => void signIn(service),
    services: query.data?.services ?? [],
    policy: query.data?.policy ?? "review",
    limit: query.data?.limit ?? 0,
    busy,
    error,
    setError,
    add: (input: { url: string; apiKey?: string; name?: string }) =>
      command("new", { type: "add", ...input }),
    rename: (service: PersonalServiceSummaryValue, name: string) =>
      command(service.id, {
        type: "rename",
        id: service.id,
        revision: service.revision,
        name,
      }),
    rediscover: (service: PersonalServiceSummaryValue) =>
      command(service.id, {
        type: "rediscover",
        id: service.id,
        revision: service.revision,
      }),
    remove: (service: PersonalServiceSummaryValue) =>
      command(service.id, {
        type: "remove",
        id: service.id,
        revision: service.revision,
      }),
  };
}

export function ownServiceState(
  service: PersonalServiceSummaryValue,
  copy: MenuCopy,
): { tone: Tone; label: string; hint?: string } {
  if (service.status === "rejected")
    return {
      tone: "danger",
      label: copy.ownServiceRejected,
      hint: service.reason
        ? copy.ownServiceRejectedHint.replace("{reason}", service.reason)
        : copy.ownServiceRejectedNoReason,
    };
  if (service.signIn === "needed")
    return {
      tone: "warning",
      label: copy.ownServiceSignInNeeded,
      hint: copy.ownServiceSignInHint,
    };
  if (service.status === "pending")
    return {
      tone: "warning",
      label: copy.ownServicePending,
      hint: copy.ownServicePendingHint,
    };
  return { tone: "success", label: copy.ownServiceActive };
}

export const ownServiceTools = (
  service: PersonalServiceSummaryValue,
  copy: MenuCopy,
) =>
  copy.ownServiceTools
    .replace("{reads}", String(service.reads))
    .replace("{writes}", String(service.writes));

/** The "My services" section of Connections: the list and "Add service". */
export function OwnServices({ workspace }: { workspace: AppWorkspace }) {
  const copy = useMenuCopy();
  const own = useOwnServices(workspace);
  const [adding, setAdding] = useState(false);
  if (own.query.isError || own.query.isPending) return null;
  const off = own.policy === "off";
  const full = own.services.length >= own.limit;
  return (
    <Section
      title={copy.ownServices}
      actions={
        !off && (
          <Button
            size="sm"
            variant="outline"
            disabled={full || !!own.busy}
            onClick={() => {
              own.setError(null);
              setAdding(true);
            }}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            {copy.ownServiceAdd}
          </Button>
        )
      }
    >
      {own.error && (
        <Alert variant="destructive">
          <AlertDescription>{copy[own.error]}</AlertDescription>
        </Alert>
      )}
      {own.services.length ? (
        <Card variant="list">
          {own.services.map((service) => (
            <OwnServiceRow
              key={service.id}
              service={service}
              workspace={workspace}
              copy={copy}
              own={own}
            />
          ))}
        </Card>
      ) : (
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PlugZap />
            </EmptyMedia>
            <EmptyTitle>
              {off ? copy.ownServicesOff : copy.ownServicesEmpty}
            </EmptyTitle>
          </EmptyHeader>
          {!off && (
            <p className="max-w-md text-sm text-muted-foreground">
              {copy.ownServicesHint}
            </p>
          )}
        </Empty>
      )}
      <AddOwnServiceSheet
        open={adding}
        busy={own.busy === "new"}
        copy={copy}
        onClose={() => setAdding(false)}
        onAdd={async (input) => {
          const added = await own.add(input);
          if (added) setAdding(false);
          return !!added;
        }}
      />
    </Section>
  );
}

function OwnServiceRow({
  service,
  workspace,
  copy,
  own,
}: {
  service: PersonalServiceSummaryValue;
  workspace: AppWorkspace;
  copy: MenuCopy;
  own: ReturnType<typeof useOwnServices>;
}) {
  const state = ownServiceState(service, copy);
  const needsSignIn =
    service.signIn === "needed" && service.status !== "rejected";
  return (
    <Item variant="row" size="row" data-testid="own-service">
      <Link
        to="/connections/$serviceId"
        params={{ serviceId: service.id }}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-sm outline-offset-4 focus-visible:outline-2"
      >
        <ItemMedia>
          <ServiceMark
            service={{
              serviceId: service.id,
              icon: service.icon,
              iconSource: service.iconSource,
            }}
            workspace={workspace}
          />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{service.name}</ItemTitle>
          <ItemDescription>
            <span className="flex flex-wrap items-center gap-x-2">
              <StatusDot tone={state.tone} size="sm">
                {own.signingIn === service.id
                  ? copy.ownServiceSigningIn
                  : state.label}
              </StatusDot>
              <span>{ownServiceTools(service, copy)}</span>
            </span>
          </ItemDescription>
        </ItemContent>
        {!needsSignIn && (
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}
      </Link>
      {needsSignIn && (
        <ItemActions>
          <OwnSignInButton service={service} own={own} copy={copy} />
        </ItemActions>
      )}
    </Item>
  );
}

/** Sign in to an own service with the person's account. */
export function OwnSignInButton({
  service,
  own,
  copy,
}: {
  service: PersonalServiceSummaryValue;
  own: ReturnType<typeof useOwnServices>;
  copy: MenuCopy;
}) {
  return (
    <Button size="sm" disabled={!!own.busy} onClick={() => own.signIn(service)}>
      {own.busy === service.id || own.signingIn === service.id ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <LogIn data-icon="inline-start" aria-hidden="true" />
      )}
      {copy.ownServiceSignIn}
    </Button>
  );
}

/** Address and key; the server reads the tools and tells what it found. */
function AddOwnServiceSheet({
  open,
  busy,
  copy,
  onClose,
  onAdd,
}: {
  open: boolean;
  busy: boolean;
  copy: MenuCopy;
  onClose: () => void;
  onAdd: (input: {
    url: string;
    apiKey?: string;
    name?: string;
  }) => Promise<boolean>;
}) {
  const formId = useId();
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("");
  const valid = /^https:\/\/\S+$/.test(url.trim());
  const reset = () => {
    setUrl("");
    setApiKey("");
    setName("");
  };
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) {
          reset();
          onClose();
        }
      }}
    >
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <form
          data-testid="own-service-form"
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || busy) return;
            void onAdd({
              url: url.trim(),
              ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
              ...(name.trim() ? { name: name.trim() } : {}),
            }).then((added) => {
              if (added) reset();
            });
          }}
        >
          <SheetHeader>
            <SheetTitle>{copy.ownServiceAddTitle}</SheetTitle>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
            <p className="text-sm text-muted-foreground">
              {copy.ownServicesHint}
            </p>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-url`}>
                  {copy.ownServiceUrl}
                </FieldLabel>
                <Input
                  id={`${formId}-url`}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="https://"
                  value={url}
                  disabled={busy}
                  onChange={(event) => setUrl(event.target.value)}
                />
                <FieldDescription>{copy.ownServiceUrlHint}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-key`}>
                  {copy.ownServiceKey}
                </FieldLabel>
                <Input
                  id={`${formId}-key`}
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  disabled={busy}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <FieldDescription>{copy.ownServiceKeyHint}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-name`}>
                  {copy.ownServiceName}
                </FieldLabel>
                <Input
                  id={`${formId}-name`}
                  autoComplete="off"
                  maxLength={100}
                  value={name}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
                <FieldDescription>{copy.ownServiceNameHint}</FieldDescription>
              </Field>
            </FieldGroup>
          </div>
          <SheetFooter>
            <Button type="submit" disabled={!valid || busy}>
              {busy ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Plus data-icon="inline-start" aria-hidden="true" />
              )}
              {busy ? copy.ownServiceAdding : copy.ownServiceAdd}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** The "…" menu of an own service: rename, read tools again, remove. */
export function OwnServiceMenu({
  service,
  own,
  copy,
  onRemoved,
}: {
  service: PersonalServiceSummaryValue;
  own: ReturnType<typeof useOwnServices>;
  copy: MenuCopy;
  onRemoved?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [name, setName] = useState(service.name);
  const formId = useId();
  const disabled = !!own.busy;
  return (
    <>
      <MoreActions label={copy.more}>
        <DropdownMenuItem
          disabled={disabled}
          onSelect={() => {
            setName(service.name);
            setRenaming(true);
          }}
        >
          <Pencil aria-hidden="true" />
          {copy.ownServiceRename}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          onSelect={() => void own.rediscover(service)}
        >
          <RefreshCw aria-hidden="true" />
          {copy.ownServiceRediscover}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={disabled}
          onSelect={() => setConfirmRemove(true)}
        >
          <Trash2 aria-hidden="true" />
          {copy.ownServiceRemove}
        </DropdownMenuItem>
      </MoreActions>
      <ConfirmAction
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={copy.ownServiceRemoveTitle}
        description={copy.ownServiceRemoveHint}
        confirmLabel={copy.ownServiceRemove}
        cancelLabel={copy.cancel}
        onConfirm={() => {
          void own.remove(service).then(() => onRemoved?.());
        }}
      />
      <Sheet
        open={renaming}
        onOpenChange={(value) => !value && setRenaming(false)}
      >
        <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim() || disabled) return;
              void own.rename(service, name.trim()).then((saved) => {
                if (saved) setRenaming(false);
              });
            }}
          >
            <SheetHeader>
              <SheetTitle>{copy.ownServiceRenameTitle}</SheetTitle>
            </SheetHeader>
            <div className="flex flex-col gap-6 px-4 pb-4">
              <Field>
                <FieldLabel htmlFor={`${formId}-rename`}>
                  {copy.ownServiceName}
                </FieldLabel>
                <Input
                  id={`${formId}-rename`}
                  maxLength={100}
                  value={name}
                  disabled={disabled}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
            </div>
            <SheetFooter>
              <Button type="submit" disabled={!name.trim() || disabled}>
                {copy.ownServiceSave}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
