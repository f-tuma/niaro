import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Plus, ScrollText, Server } from "lucide-react";
import { z } from "zod";
import {
  HostedServersSchema,
  type HostedDefinition,
  type HostedOnboarding,
  type HostedServer,
} from "../../../packages/protocol/hosted";
import { CatalogSchema } from "../../../packages/protocol/service-catalog";
import { AuthProvidersSchema } from "../../../packages/protocol/auth-providers";
import { IdentityId } from "../../../packages/protocol/identity";
import {
  applySignIn,
  hostedOnboarding,
  onboardingSettings,
  signInProvider,
} from "./service-onboarding";
import { AddServerSheet, SecretsSheet, type AddChoice } from "./hosted-custom";
import { useAdmin } from "./context";
import { useConsoleScope } from "./console-scope";
import { api, ApiError } from "./lib/api";
import { downloadFile } from "./lib/download";
import { PageHeader } from "@admin/components/console/page";
import { StatusBadge, type Tone } from "@admin/components/console/status";
import { ConfirmAction, MoreActions } from "@admin/components/console/forms";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { Card } from "@admin/components/ui/card";
import { Badge } from "@admin/components/ui/badge";
import { Button } from "@admin/components/ui/button";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@admin/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@admin/components/ui/tooltip";
import {
  Empty,
  EmptyContent,
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
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";

const en = {
  title: "Hosted servers",
  add: "Add server",
  custom: "Custom",
  needsDocker: "Needs Docker",
  empty: "No hosted servers",
  installing: "Installing",
  starting: "Starting",
  running: "Running",
  stopped: "Stopped",
  failed: "Failed",
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  secrets: "Secrets",
  export: "Export",
  remove: "Remove",
  removeTitle: "Remove the hosted server?",
  removeHint:
    "The process stops and its files are deleted. Services using its address stop working.",
  cancel: "Cancel",
  createService: "Create service",
  openService: "Open service",
  serviceFailed: "The service couldn't be created. Try again.",
  logs: "Log",
  logsHint: "Last 200 lines, tokens redacted",
  noLogs: "No output yet.",
  more: "More actions",
  restarts: "restarts",
  image: "Image",
  notManager: "Only organization owners and admins manage hosted servers.",
  error: "The request failed. Reload and try again.",
  exists: "This server is already running for the organization.",
  noSandbox:
    "Docker is not available to this server, so hosted servers cannot run.",
  processRuntime: "Without Docker: npm servers run as processes of this server",
  limit: "The server limit has been reached.",
  errors: {
    install_failed: "Installation failed. Check the log.",
    sandbox_unavailable: "Docker is not available.",
    docker_required: "Images need Docker, which this server doesn't have.",
    bin_required: "Choose the package's executable.",
    crashed: "It crashed repeatedly and was stopped.",
    not_ready: "It did not start listening in time.",
    start_failed: "It could not be started.",
  } as Record<string, string>,
};
const cs: typeof en = {
  title: "Hostované servery",
  add: "Přidat server",
  custom: "Vlastní",
  needsDocker: "Potřebuje Docker",
  empty: "Žádné hostované servery",
  installing: "Instaluje se",
  starting: "Spouští se",
  running: "Běží",
  stopped: "Zastaveno",
  failed: "Selhalo",
  start: "Spustit",
  stop: "Zastavit",
  restart: "Restartovat",
  secrets: "Tajné hodnoty",
  export: "Exportovat",
  remove: "Odstranit",
  removeTitle: "Odstranit hostovaný server?",
  removeHint:
    "Proces se zastaví a jeho soubory se smažou. Služby s jeho adresou přestanou fungovat.",
  cancel: "Zrušit",
  createService: "Vytvořit službu",
  openService: "Otevřít službu",
  serviceFailed: "Službu se nepodařilo vytvořit. Zkus to znovu.",
  logs: "Log",
  logsHint: "Posledních 200 řádků, tokeny skryté",
  noLogs: "Zatím žádný výstup.",
  more: "Další akce",
  restarts: "restartů",
  image: "Image",
  notManager: "Hostované servery spravují vlastníci a správci organizace.",
  error: "Požadavek selhal. Načti stránku znovu a zkus to znovu.",
  exists: "Tento server pro organizaci už běží.",
  noSandbox:
    "Tento server nemá přístup k Dockeru, hostované servery proto nemohou běžet.",
  processRuntime: "Bez Dockeru: npm servery běží jako procesy serveru",
  limit: "Byl dosažen limit počtu serverů.",
  errors: {
    install_failed: "Instalace selhala. Podívej se do logu.",
    sandbox_unavailable: "Docker není dostupný.",
    docker_required: "Image potřebuje Docker, který tento server nemá.",
    bin_required: "Vyber spustitelný soubor balíčku.",
    crashed: "Opakovaně padal, a proto byl zastaven.",
    not_ready: "Nezačal včas naslouchat.",
    start_failed: "Nepodařilo se ho spustit.",
  },
};
const tones: Record<HostedServer["status"], Tone> = {
  installing: "info",
  starting: "info",
  running: "success",
  stopped: "neutral",
  failed: "danger",
};

export function useHostedServers(organizationId?: string) {
  const { data } = useAdmin();
  return useQuery({
    queryKey: [
      "admin",
      "hosted",
      data.authentication.principalId,
      organizationId,
    ],
    queryFn: async ({ signal }) =>
      HostedServersSchema.parse(
        await api("identity/hosted/list", { organizationId }, signal),
      ),
    enabled: !!organizationId,
    // Installation and start-up progress without a manual reload.
    refetchInterval: (query) =>
      query.state.data?.servers.some((s) =>
        ["installing", "starting"].includes(s.status),
      )
        ? 1500
        : false,
  });
}
export type HostedCommandInput =
  | { type: "create"; builtin: string; secrets: Record<string, string> }
  | {
      type: "createCustom";
      definition: HostedDefinition;
      secrets: Record<string, string>;
    }
  | {
      type: "secrets";
      id: string;
      revision: number;
      secrets: Record<string, string>;
    }
  | {
      type: "start" | "stop" | "restart" | "remove";
      id: string;
      revision: number;
    };
export function useHostedCommand(organizationId?: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: HostedCommandInput) =>
      api("identity/hosted/command", { organizationId, ...input }),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["admin", "hosted"] }),
        client.invalidateQueries({ queryKey: ["admin", "audit"] }),
      ]),
  });
}
/** The current workspace's services, on the catalog page's own cache entry. */
function useWorkspaceServices(enabled: boolean) {
  const scope = useConsoleScope(),
    { data } = useAdmin();
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
    enabled: enabled && !!target.organizationId && !!target.workspaceId,
  });
  return { target, services: query.data?.services };
}
/**
 * Adds the catalog MCP service for a running hosted server: its name, URL
 * and the definition's onboarding (icon, purpose and, when the organization
 * has the sign-in method it names, personal sign-in). Resolves to its id.
 */
async function createHostedService(
  target: { organizationId: string; workspaceId: string },
  server: HostedServer,
  onboarding: HostedOnboarding | undefined,
) {
  const saved = await api("identity/catalog/command", {
    ...target,
    type: "saveService",
    revision: 0,
    settings: {
      name: server.definition.name,
      url: server.url,
      protocol: "mcp",
      icon: onboarding?.icon ?? "plug",
      iconSource: onboarding?.icon ? "custom" : "favicon",
      auth: { type: "none" },
      enabled: true,
      ...(onboarding?.description
        ? { description: onboarding.description }
        : {}),
    },
  });
  const id = IdentityId.parse(z.object({ id: z.unknown() }).parse(saved).id);
  const signIn = onboarding?.signIn;
  if (signIn) {
    const providers = AuthProvidersSchema.parse(
      await api("identity/auth-providers/list", {
        organizationId: target.organizationId,
      }),
    ).providers;
    const provider = signInProvider(signIn, providers);
    // Without the sign-in method the service page says what is missing.
    if (provider) {
      // The address's own OAuth probe runs after saving; join it first so
      // the sign-in saves on the configuration it leaves.
      await api("identity/catalog/oauth/auto", {
        ...target,
        serviceId: id,
      }).catch(() => undefined);
      const settings = onboardingSettings(signIn, provider);
      const result = await applySignIn(target, id, settings);
      if (!result.ok && result.code === "service_oauth_conflict")
        await applySignIn(target, id, settings);
    }
  }
  return id;
}
export function useHostedCopy() {
  return useAdmin().language === "cs" ? cs : en;
}
export function HostedStatus({ server }: { server: HostedServer }) {
  const copy = useHostedCopy();
  if (server.status === "running") return null;
  return (
    <StatusBadge tone={tones[server.status]}>{copy[server.status]}</StatusBadge>
  );
}
/** The package and version, or the image and the start of its digest. */
export function sourceLabel(definition: HostedDefinition) {
  const source = definition.source;
  if ("npm" in source) return `${source.npm}@${source.version}`;
  const [image, digest] = source.image.split("@");
  return `${image}@${digest!.slice(0, 19)}`;
}
/** The definition as a file another server can import; it holds no secret values. */
export function exportDefinition(definition: HostedDefinition) {
  const slug =
    definition.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "server";
  downloadFile(`${slug}.mcp.json`, `${JSON.stringify(definition, null, 2)}\n`);
}

export function HostedPage() {
  const copy = useHostedCopy();
  const scope = useConsoleScope();
  const organizationId = scope.organization?.id;
  const query = useHostedServers(organizationId);
  const command = useHostedCommand(organizationId);
  const [logs, setLogs] = useState<HostedServer | null>(null);
  const [adding, setAdding] = useState<AddChoice | null>(null);
  const [secrets, setSecrets] = useState<HostedServer | null>(null);
  const client = useQueryClient();
  const navigate = useNavigate();
  const workspace = useWorkspaceServices(!!query.data?.canManage);
  const create = useMutation({
    mutationFn: (server: HostedServer) =>
      createHostedService(
        workspace.target,
        server,
        hostedOnboarding(server, query.data?.builtins ?? []),
      ),
    // A service saved before a later step failed still shows on the row.
    onSettled: () =>
      client.invalidateQueries({ queryKey: ["admin", "catalog"] }),
    onSuccess: (serviceId) =>
      void navigate({ to: "/services/$serviceId", params: { serviceId } }),
  });
  const failure = create.error
    ? copy.serviceFailed
    : command.error instanceof ApiError
      ? command.error.code === "hosted_exists"
        ? copy.exists
        : command.error.code === "hosted_limit"
          ? copy.limit
          : copy.error
      : command.error
        ? copy.error
        : null;
  const value = query.data;
  const docker = value?.sandbox !== "process";
  const available =
    value?.builtins.filter(
      (b) => !value.servers.some((s) => s.builtin === b.id),
    ) ?? [];
  const actions =
    value?.canManage && organizationId ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>
            <Plus data-icon="inline-start" aria-hidden="true" />
            {copy.add}
            <ChevronDown data-icon="inline-end" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {available.map((builtin) => {
            const image = !("npm" in builtin.definition.source);
            return (
              <DropdownMenuItem
                key={builtin.id}
                disabled={image && !docker}
                onSelect={() => setAdding({ builtin })}
              >
                {builtin.definition.name}
                {image && !docker && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {copy.needsDocker}
                  </span>
                )}
              </DropdownMenuItem>
            );
          })}
          {value.allowCustom && (
            <>
              {available.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => setAdding("custom")}>
                {copy.custom}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;
  const addable = available.length > 0 || !!value?.allowCustom;
  return (
    <>
      <PageHeader
        title={copy.title}
        count={value?.servers.length || undefined}
        description={
          value?.canManage && value.sandbox === "process"
            ? copy.processRuntime
            : undefined
        }
        actions={value?.servers.length && addable ? actions : undefined}
      />
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {value?.canManage && value.sandbox === "unavailable" && (
        <Alert variant="destructive">
          <AlertDescription>{copy.noSandbox}</AlertDescription>
        </Alert>
      )}
      {!value ? (
        query.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{copy.error}</AlertDescription>
          </Alert>
        ) : (
          <Skeleton className="h-32 w-full" />
        )
      ) : !value.canManage ? (
        <Alert>
          <AlertDescription>{copy.notManager}</AlertDescription>
        </Alert>
      ) : !value.servers.length ? (
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Server />
            </EmptyMedia>
            <EmptyTitle>{copy.empty}</EmptyTitle>
          </EmptyHeader>
          {addable && actions && <EmptyContent>{actions}</EmptyContent>}
        </Empty>
      ) : (
        <Card variant="list">
          {value.servers.map((server) => (
            <Item key={server.id} variant="row" size="row">
              <ItemMedia>
                <EntityIcon size="sm">
                  <Server aria-hidden="true" />
                </EntityIcon>
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {server.definition.name}
                  {!("npm" in server.definition.source) && (
                    <Badge variant="outline">{copy.image}</Badge>
                  )}
                </ItemTitle>
                <ItemDescription>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-3">
                    <code className="truncate font-mono" title={server.url}>
                      {server.url}
                    </code>
                    <span>{sourceLabel(server.definition)}</span>
                    {server.restarts > 0 && (
                      <span>
                        {server.restarts} {copy.restarts}
                      </span>
                    )}
                    {server.error && (
                      <span className="text-destructive">
                        {copy.errors[server.error] ?? server.error}
                      </span>
                    )}
                  </span>
                </ItemDescription>
              </ItemContent>
              {/* Phones give status and actions their own line so the URL keeps the width. */}
              <ItemActions className="max-sm:ml-10 max-sm:basis-full">
                <HostedStatus server={server} />
                <span className="flex-1 sm:hidden" />
                {server.status === "running" && workspace.services && (
                  <ServiceLink
                    service={workspace.services.find(
                      (s) => s.url === server.url,
                    )}
                    busy={create.isPending}
                    onCreate={() => create.mutate(server)}
                  />
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${copy.logs}: ${server.definition.name}`}
                      onClick={() => setLogs(server)}
                    >
                      <ScrollText aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{copy.logs}</TooltipContent>
                </Tooltip>
                <ServerActions
                  server={server}
                  busy={command.isPending}
                  onSecrets={() => setSecrets(server)}
                  run={(type) =>
                    command.mutate({
                      type,
                      id: server.id,
                      revision: server.revision,
                    })
                  }
                />
              </ItemActions>
            </Item>
          ))}
        </Card>
      )}
      {organizationId && value && (
        <>
          <AddServerSheet
            choice={adding}
            organizationId={organizationId}
            docker={docker}
            onClose={() => setAdding(null)}
          />
          <SecretsSheet
            server={secrets}
            organizationId={organizationId}
            onClose={() => setSecrets(null)}
          />
        </>
      )}
      <HostedLogs
        server={logs}
        organizationId={organizationId}
        onClose={() => setLogs(null)}
      />
    </>
  );
}
/** The catalog service for a running server: open it, or create it. */
function ServiceLink({
  service,
  busy,
  onCreate,
}: {
  service?: { id: string };
  busy: boolean;
  onCreate: () => void;
}) {
  const copy = useHostedCopy();
  return service ? (
    <Button variant="outline" size="sm" asChild>
      <Link to="/services/$serviceId" params={{ serviceId: service.id }}>
        {copy.openService}
      </Link>
    </Button>
  ) : (
    <Button variant="outline" size="sm" disabled={busy} onClick={onCreate}>
      {copy.createService}
    </Button>
  );
}
function ServerActions({
  server,
  busy,
  run,
  onSecrets,
}: {
  server: HostedServer;
  busy: boolean;
  run: (type: "start" | "stop" | "restart" | "remove") => void;
  onSecrets: () => void;
}) {
  const copy = useHostedCopy();
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <MoreActions label={copy.more} size="sm">
        {server.enabled ? (
          <>
            <DropdownMenuItem disabled={busy} onSelect={() => run("restart")}>
              {copy.restart}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={() => run("stop")}>
              {copy.stop}
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem disabled={busy} onSelect={() => run("start")}>
            {copy.start}
          </DropdownMenuItem>
        )}
        {server.definition.secrets.length > 0 && (
          <DropdownMenuItem disabled={busy} onSelect={onSecrets}>
            {copy.secrets}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => exportDefinition(server.definition)}>
          {copy.export}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={busy}
          onSelect={() => setConfirm(true)}
        >
          {copy.remove}
        </DropdownMenuItem>
      </MoreActions>
      <ConfirmAction
        open={confirm}
        onOpenChange={setConfirm}
        title={copy.removeTitle}
        description={copy.removeHint}
        confirmLabel={copy.remove}
        cancelLabel={copy.cancel}
        onConfirm={() => run("remove")}
      />
    </>
  );
}
function HostedLogs({
  server,
  organizationId,
  onClose,
}: {
  server: HostedServer | null;
  organizationId?: string;
  onClose: () => void;
}) {
  const copy = useHostedCopy();
  const { data } = useAdmin();
  const lines = useQuery({
    queryKey: [
      "admin",
      "hosted-logs",
      data.authentication.principalId,
      organizationId,
      server?.id,
    ],
    queryFn: async ({ signal }) =>
      z
        .object({ lines: z.array(z.string()).max(500) })
        .parse(
          await api(
            "identity/hosted/logs",
            { organizationId, id: server!.id },
            signal,
          ),
        ).lines,
    enabled: !!server && !!organizationId,
    refetchInterval: 3000,
  });
  return (
    <Sheet open={!!server} onOpenChange={(open) => !open && onClose()}>
      <SheetContent size="lg">
        <SheetHeader>
          <SheetTitle>{server?.definition.name}</SheetTitle>
          <SheetDescription>{copy.logsHint}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          {lines.data?.length ? (
            <pre className="font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground">
              {lines.data.join("\n")}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">{copy.noLogs}</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
