import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ScrollText, Server } from "lucide-react";
import { z } from "zod";
import {
  HostedServersSchema,
  type HostedDefinitionInput,
  type HostedServer,
  type HostedTemplateId,
} from "../../../packages/protocol/hosted";
import { CustomServer } from "./hosted-custom";
import { useAdmin } from "./context";
import { useConsoleScope } from "./console-scope";
import { api, ApiError } from "./lib/api";
import { PageHeader } from "@admin/components/console/page";
import { StatusBadge, type Tone } from "@admin/components/console/status";
import { ConfirmAction, MoreActions } from "@admin/components/console/forms";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { Card } from "@admin/components/ui/card";
import { Button } from "@admin/components/ui/button";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import { DropdownMenuItem } from "@admin/components/ui/dropdown-menu";
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
  add: "Run",
  empty: "No hosted servers",
  emptyHint: "Run one, then add it as a service.",
  installing: "Installing",
  starting: "Starting",
  running: "Running",
  stopped: "Stopped",
  failed: "Failed",
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  remove: "Remove",
  removeTitle: "Remove the hosted server?",
  removeHint:
    "The process stops and its files are deleted. Services using its address stop working.",
  cancel: "Cancel",
  logs: "Log",
  logsHint: "Last 200 lines, tokens redacted",
  noLogs: "No output yet.",
  more: "More actions",
  restarts: "restarts",
  version: "Version",
  notManager: "Only organization owners and admins manage hosted servers.",
  error: "The request failed. Reload and try again.",
  exists: "This server is already running for the organization.",
  noSandbox:
    "Docker is not available to this server, so hosted servers cannot run.",
  limit: "The server limit has been reached.",
  errors: {
    install_failed: "Installation failed. Check the log.",
    sandbox_unavailable: "Docker is not available.",
    bin_required: "Choose the package's executable.",
    crashed: "It crashed repeatedly and was stopped.",
    not_ready: "It did not start listening in time.",
    start_failed: "It could not be started.",
  } as Record<string, string>,
};
const cs: typeof en = {
  title: "Hostované servery",
  add: "Spustit",
  empty: "Žádné hostované servery",
  emptyHint: "Spusť ho a pak ho přidej jako službu.",
  installing: "Instaluje se",
  starting: "Spouští se",
  running: "Běží",
  stopped: "Zastaveno",
  failed: "Selhalo",
  start: "Spustit",
  stop: "Zastavit",
  restart: "Restartovat",
  remove: "Odstranit",
  removeTitle: "Odstranit hostovaný server?",
  removeHint:
    "Proces se zastaví a jeho soubory se smažou. Služby s jeho adresou přestanou fungovat.",
  cancel: "Zrušit",
  logs: "Log",
  logsHint: "Posledních 200 řádků, tokeny skryté",
  noLogs: "Zatím žádný výstup.",
  more: "Další akce",
  restarts: "restartů",
  version: "Verze",
  notManager: "Hostované servery spravují vlastníci a správci organizace.",
  error: "Požadavek selhal. Načti stránku znovu a zkus to znovu.",
  exists: "Tento server pro organizaci už běží.",
  noSandbox:
    "Tento server nemá přístup k Dockeru, hostované servery proto nemohou běžet.",
  limit: "Byl dosažen limit počtu serverů.",
  errors: {
    install_failed: "Instalace selhala. Podívej se do logu.",
    sandbox_unavailable: "Docker není dostupný.",
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
export function useHostedCommand(organizationId?: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (
      input:
        | { type: "create"; template: HostedTemplateId }
        | {
            type: "createCustom";
            name: string;
            definition: HostedDefinitionInput;
          }
        | {
            type: "start" | "stop" | "restart" | "remove";
            id: string;
            revision: number;
          },
    ) => api("identity/hosted/command", { organizationId, ...input }),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["admin", "hosted"] }),
        client.invalidateQueries({ queryKey: ["admin", "audit"] }),
      ]),
  });
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

export function HostedPage() {
  const copy = useHostedCopy();
  const scope = useConsoleScope();
  const organizationId = scope.organization?.id;
  const query = useHostedServers(organizationId);
  const command = useHostedCommand(organizationId);
  const [logs, setLogs] = useState<HostedServer | null>(null);
  const failure =
    command.error instanceof ApiError
      ? command.error.code === "hosted_exists"
        ? copy.exists
        : command.error.code === "hosted_limit"
          ? copy.limit
          : copy.error
      : command.error
        ? copy.error
        : null;
  const value = query.data;
  const available =
    value?.templates.filter(
      (t) => !value.servers.some((s) => s.template === t.id),
    ) ?? [];
  const actions = value?.canManage ? (
    <>
      {value.allowCustom && organizationId && (
        <CustomServer organizationId={organizationId} />
      )}
      {available.map((template) => (
        <Button
          key={template.id}
          variant="outline"
          disabled={command.isPending}
          onClick={() =>
            command.mutate({ type: "create", template: template.id })
          }
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          {copy.add} {template.name}
        </Button>
      ))}
    </>
  ) : null;
  return (
    <>
      <PageHeader
        title={copy.title}
        count={value?.servers.length || undefined}
        actions={value?.servers.length ? actions : undefined}
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
          {actions && <EmptyContent>{actions}</EmptyContent>}
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
                <ItemTitle>{server.name}</ItemTitle>
                <ItemDescription>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-3">
                    <code className="truncate font-mono" title={server.url}>
                      {server.url}
                    </code>
                    <span>
                      {server.source === "template"
                        ? `${copy.version} ${server.version}`
                        : `${server.artifact} ${server.version.slice(0, 19)}`}
                    </span>
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
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${copy.logs}: ${server.name}`}
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
      <HostedLogs
        server={logs}
        organizationId={organizationId}
        onClose={() => setLogs(null)}
      />
    </>
  );
}
function ServerActions({
  server,
  busy,
  run,
}: {
  server: HostedServer;
  busy: boolean;
  run: (type: "start" | "stop" | "restart" | "remove") => void;
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
          <SheetTitle>{server?.name}</SheetTitle>
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
