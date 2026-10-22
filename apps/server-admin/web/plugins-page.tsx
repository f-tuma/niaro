import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  CalendarClock,
  Brain,
  FileCode,
  Plus,
  Puzzle,
  RotateCcw,
} from "lucide-react";
import {
  WorkspacePluginsSchema,
  type WorkspacePlugins,
  type PluginPreferences,
} from "../../../packages/protocol/workspace-plugins";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@admin/components/ui/card";
import { FieldError } from "@admin/components/ui/field";
import { Switch } from "@admin/components/ui/switch";
import { Input } from "@admin/components/ui/input";
import { Button } from "@admin/components/ui/button";
import { Badge } from "@admin/components/ui/badge";
import {
  AlertAction,
  Alert,
  AlertDescription,
} from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@admin/components/ui/empty";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@admin/components/ui/tooltip";
import { PageHeader, Section } from "@admin/components/console/page";
import { Disclosure } from "@admin/components/console/disclosure";
import { SettingRow, SettingRows } from "@admin/components/console/setting-row";
import { StatusBadge } from "@admin/components/console/status";
import { EntityIcon } from "@admin/components/console/entity-icon";
import {
  DetailList,
  SaveBar,
  SubmitButton,
} from "@admin/components/console/forms";
import { useAdmin } from "./context";
import { useConsoleScope } from "./console-scope";
import { useCatalogCopy } from "./catalog-copy";
import { catalogIssue } from "./catalog-shared";
import { usePluginsCopy } from "./plugins-copy";
import { api, ApiError } from "./lib/api";
import { publishPluginSettings } from "./lib/plugin-query";
import { PluginPreview } from "./plugin-preview";
import { MemoryPluginPanel } from "./memory-panel";
import { AddPluginSheet } from "./plugin-files-page";
import { PluginSettingsForm } from "./plugin-settings-form";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@admin/components/ui/item";

function PluginIcon({ id }: { id: string }) {
  return id === "datetime" ? (
    <CalendarClock aria-hidden="true" />
  ) : id === "memory" ? (
    <Brain aria-hidden="true" />
  ) : (
    <Puzzle aria-hidden="true" />
  );
}

const zones = (() => {
  try {
    return ["UTC", ...Intl.supportedValuesOf("timeZone")];
  } catch {
    return [
      "UTC",
      "Europe/Prague",
      "Europe/London",
      "America/New_York",
      "Asia/Tokyo",
    ];
  }
})();
/** The workspace plugin settings; the page header and the panel share it. */
function useWorkspacePlugins(
  organizationId: string | undefined,
  workspaceId: string | undefined,
  canManage: boolean,
) {
  const { data } = useAdmin();
  const key = [
    "admin",
    "plugins",
    data.authentication.principalId,
    organizationId,
    workspaceId,
    canManage,
  ];
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      WorkspacePluginsSchema.parse(
        await api(
          `identity/plugins?${new URLSearchParams({ organizationId: organizationId!, workspaceId: workspaceId! })}`,
          undefined,
          signal,
        ),
      ),
    enabled: !!organizationId && !!workspaceId,
    staleTime: 0,
    refetchInterval: 15000,
  });
  return { key, query };
}

function PluginState({
  plugin,
  settings,
}: {
  plugin: WorkspacePlugins["plugins"][number];
  settings: PluginPreferences;
}) {
  const copy = usePluginsCopy();
  const enabled = settings.enabled.includes(plugin.id);
  if (plugin.available && enabled) return null;
  return (
    <StatusBadge tone={!plugin.available ? "warning" : "neutral"}>
      {!plugin.available ? copy.unavailable : copy.disabled}
    </StatusBadge>
  );
}

export function PluginsPage() {
  const { pluginId } = useParams({ strict: false });
  const scope = useConsoleScope();
  const { data, language } = useAdmin();
  const [adding, setAdding] = useState(false);
  const copy = usePluginsCopy(),
    common = useCatalogCopy();
  const errors = [scope.identity.error, scope.detail.error];
  const authorityError = errors.find(
    (e) => e instanceof ApiError && [401, 403, 404].includes(e.status),
  );
  const error = authorityError ?? errors.find(Boolean);
  const { query: plugins } = useWorkspacePlugins(
    scope.organization?.id,
    scope.workspace?.id,
    scope.organization?.role !== "member",
  );
  const plugin = plugins.data?.plugins.find((p) => p.id === pluginId);
  const editing = plugins.data?.editing;
  return (
    <>
      <PageHeader
        title={
          pluginId === "datetime"
            ? copy.dateTime
            : pluginId === "memory"
              ? copy.memory
              : pluginId && plugin
                ? plugin.name[language]
                : pluginId
                  ? pluginId
                  : copy.title
        }
        back={pluginId ? { to: "/plugins", label: copy.title } : undefined}
        media={
          pluginId ? (
            <EntityIcon size="lg">
              <PluginIcon id={pluginId} />
            </EntityIcon>
          ) : undefined
        }
        meta={
          plugin &&
          plugins.data && (
            <PluginState plugin={plugin} settings={plugins.data.settings} />
          )
        }
        actions={
          editing?.allowed &&
          (pluginId ? (
            <Button variant="outline" asChild>
              <Link to="/plugins/$pluginId/files" params={{ pluginId }}>
                <FileCode data-icon="inline-start" aria-hidden="true" />
                {copy.files}
              </Link>
            </Button>
          ) : (
            !editing.disabled && (
              <Button onClick={() => setAdding(true)}>
                <Plus data-icon="inline-start" aria-hidden="true" />
                {copy.addPlugin}
              </Button>
            )
          ))
        }
      />
      {scope.organization && editing?.allowed && !editing.disabled && (
        <AddPluginSheet
          organizationId={scope.organization.id}
          open={adding}
          onOpenChange={setAdding}
        />
      )}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {authorityError ? catalogIssue(error, common) : copy.refreshFailed}
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              onClick={() => {
                void scope.identity.refetch();
                void scope.detail.refetch();
              }}
            >
              {common.refresh}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {authorityError ? null : scope.identity.isPending ||
        (scope.organization && scope.detail.isPending) ? (
        <Skeleton className="h-72 w-full" />
      ) : !scope.organization || !scope.workspace ? (
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Puzzle />
            </EmptyMedia>
            <EmptyTitle>{common.noWorkspace}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link to="/workspaces">{common.workspaces}</Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <WorkspacePluginPanel
          key={`${data.authentication.principalId}:${scope.organization!.id}:${scope.workspace!.id}`}
          organizationId={scope.organization!.id}
          workspaceId={scope.workspace!.id}
          canManage={scope.organization!.role !== "member"}
          refreshFailed={!!error}
        />
      )}
    </>
  );
}
function WorkspacePluginPanel({
  organizationId,
  workspaceId,
  canManage,
  refreshFailed,
}: {
  organizationId: string;
  workspaceId: string;
  canManage: boolean;
  refreshFailed: boolean;
}) {
  const { pluginId } = useParams({ strict: false });
  const common = useCatalogCopy();
  const copy = usePluginsCopy();
  const { language } = useAdmin();
  const client = useQueryClient();
  const { key, query } = useWorkspacePlugins(
    organizationId,
    workspaceId,
    canManage,
  );
  if (query.isPending) return <Skeleton className="h-72 w-full" />;
  const authorityError =
    query.error instanceof ApiError &&
    [401, 403, 404].includes(query.error.status);
  if (!query.data || authorityError)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {authorityError
            ? catalogIssue(query.error, common)
            : copy.refreshFailed}
        </AlertDescription>
        <AlertAction>
          <Button variant="outline" onClick={() => void query.refetch()}>
            {common.refresh}
          </Button>
        </AlertAction>
      </Alert>
    );
  if (query.data.canManage !== canManage)
    return (
      <Button
        variant="outline"
        onClick={() => void client.invalidateQueries({ queryKey: ["admin"] })}
      >
        {common.refresh}
      </Button>
    );
  return (
    <>
      {query.isError && (
        <Alert variant="destructive">
          <AlertDescription>{copy.refreshFailed}</AlertDescription>
          <AlertAction>
            <Button variant="outline" onClick={() => void query.refetch()}>
              {common.refresh}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {pluginId ? (
        query.data.plugins.some((plugin) => plugin.id === pluginId) ? (
          <>
            {pluginId === "memory" ? (
              <MemoryPluginPanel
                current={query.data}
                refreshFailed={refreshFailed || query.isError}
                reload={async () => (await query.refetch()).isSuccess}
                saved={async (value) => {
                  await publishPluginSettings(client, key, value);
                  void client.invalidateQueries({
                    queryKey: ["admin", "memory"],
                  });
                  void client.invalidateQueries({
                    queryKey: ["admin", "audit"],
                  });
                }}
              />
            ) : pluginId === "datetime" ? (
              <PluginForm
                current={query.data}
                refreshFailed={refreshFailed || query.isError}
                reload={async () => (await query.refetch()).isSuccess}
                saved={async (value) => {
                  await publishPluginSettings(client, key, value);
                  void client.invalidateQueries({
                    queryKey: ["admin", "audit"],
                  });
                }}
              />
            ) : (
              <div className="grid items-start gap-8 xl:grid-cols-2">
                <PluginSettingsForm
                  current={query.data}
                  plugin={
                    query.data.plugins.find((plugin) => plugin.id === pluginId)!
                  }
                  refreshFailed={refreshFailed || query.isError}
                  reload={async () => (await query.refetch()).isSuccess}
                  saved={async (value) => {
                    await publishPluginSettings(client, key, value);
                    void client.invalidateQueries({
                      queryKey: ["admin", "audit"],
                    });
                  }}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <Empty variant="outline">
              <EmptyHeader>
                <EmptyTitle>{copy.notFound}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          </>
        )
      ) : query.data.plugins.length ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {query.data.plugins.map((plugin) => (
              <Card key={plugin.id} variant="interactive">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <EntityIcon>
                      <PluginIcon id={plugin.id} />
                    </EntityIcon>
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {plugin.source !== "built-in" && (
                        <Badge variant="outline">
                          {plugin.source === "override"
                            ? copy.override
                            : copy.operator}
                        </Badge>
                      )}
                      <PluginState
                        plugin={plugin}
                        settings={query.data.settings}
                      />
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex min-w-0 flex-col gap-1">
                    <CardTitle>
                      <Link
                        to="/plugins/$pluginId"
                        params={{ pluginId: plugin.id }}
                        className="block truncate outline-none after:absolute after:inset-0"
                      >
                        {plugin.id === "memory"
                          ? copy.memory
                          : plugin.id === "datetime"
                            ? copy.dateTime
                            : plugin.name[language]}
                      </Link>
                    </CardTitle>
                    <span className="truncate text-sm text-muted-foreground">
                      {plugin.id === "datetime"
                        ? query.data.settings.timeZone
                        : plugin.description[language]}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          {query.data.problems.length > 0 && (
            <Section
              title={copy.invalidPlugins}
              count={query.data.problems.length}
            >
              <Card variant="list">
                {query.data.problems.map((problem) => (
                  <Item key={problem.directory} variant="row" size="row">
                    <ItemContent>
                      <ItemTitle>{problem.directory}</ItemTitle>
                      <ItemDescription>{problem.message}</ItemDescription>
                    </ItemContent>
                    {query.data.editing.allowed && problem.id && (
                      <ItemActions>
                        <Button variant="outline" size="sm" asChild>
                          <Link
                            to="/plugins/$pluginId/files"
                            params={{ pluginId: problem.id }}
                          >
                            {copy.files}
                          </Link>
                        </Button>
                      </ItemActions>
                    )}
                  </Item>
                ))}
              </Card>
            </Section>
          )}
        </>
      ) : (
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyTitle>{copy.empty}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </>
  );
}
function PluginForm({
  current,
  saved,
  reload,
  refreshFailed,
}: {
  current: WorkspacePlugins;
  saved: (value: WorkspacePlugins) => Promise<void>;
  reload: () => Promise<boolean>;
  refreshFailed: boolean;
}) {
  const copy = usePluginsCopy(),
    common = useCatalogCopy();
  const id = useId();
  const [draft, setDraft] = useState<{
    revision: number;
    settings: PluginPreferences | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoneError, setZoneError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const settings = draft
    ? (draft.settings ?? current.defaults)
    : current.settings;
  const plugin = current.plugins.find((p) => p.id === "datetime")!;
  const enabled = settings.enabled.includes("datetime");
  const stale = !!draft && draft.revision !== current.revision;
  const locked =
    !current.canManage || busy || stale || conflict || refreshFailed;
  function edit(patch: Partial<PluginPreferences>) {
    setDraft({
      revision: draft?.revision ?? current.revision,
      settings: { ...settings, ...patch },
    });
    setError(null);
    setZoneError(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || locked || request.current) return;
    const timeZone = settings.timeZone.trim();
    try {
      if (
        timeZone !== "UTC" &&
        !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(timeZone)
      )
        throw Error();
      new Intl.DateTimeFormat("en", { timeZone });
    } catch {
      setZoneError(true);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = WorkspacePluginsSchema.parse(
        await api(
          "identity/plugins",
          {
            organizationId: current.organizationId,
            workspaceId: current.workspaceId,
            revision: draft.revision,
            settings:
              draft.settings === null ? null : { ...settings, timeZone },
          },
          controller.signal,
        ),
      );
      if (!controller.signal.aborted) {
        await saved(result);
        if (!controller.signal.aborted) {
          setDraft(null);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(catalogIssue(error, common));
        setConflict(error instanceof ApiError && error.status === 409);
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  const sourceLabel = (
    draft ? draft.settings === null : current.source === "server"
  )
    ? copy.serverDefault
    : copy.workspaceOverride;
  const discard = () => {
    setDraft(null);
    setError(null);
    setZoneError(false);
    setConflict(false);
  };
  return (
    <div className="grid items-start gap-8 xl:grid-cols-2">
      <form onSubmit={(event) => void submit(event)} className="min-w-0">
        <Section title={copy.settings}>
          {(error || stale) && (
            <Alert variant="destructive">
              <AlertDescription>{error ?? common.conflict}</AlertDescription>
              {(conflict || stale) && (
                <AlertAction>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={async () => {
                      if (!(await reload())) return;
                      discard();
                    }}
                  >
                    {common.reloadSaved}
                  </Button>
                </AlertAction>
              )}
            </Alert>
          )}
          {!plugin.available && (
            <Alert>
              <AlertDescription>{copy.blocked}</AlertDescription>
            </Alert>
          )}
          <SettingRows>
            <SettingRow
              label={copy.enabled}
              htmlFor={`${id}-enabled`}
              disabled={locked || !plugin.available}
            >
              <Switch
                id={`${id}-enabled`}
                checked={enabled}
                disabled={locked || !plugin.available}
                onCheckedChange={(value) =>
                  edit({
                    enabled: value
                      ? [
                          ...settings.enabled.filter(
                            (plugin) => plugin !== "datetime",
                          ),
                          "datetime",
                        ]
                      : settings.enabled.filter(
                          (plugin) => plugin !== "datetime",
                        ),
                  })
                }
              />
            </SettingRow>
            <SettingRow
              label={copy.timeZone}
              htmlFor={`${id}-zone`}
              meta={sourceLabel}
              disabled={locked}
              wide
            >
              <div className="flex w-full gap-2">
                <Input
                  id={`${id}-zone`}
                  list={`${id}-zones`}
                  value={settings.timeZone}
                  onChange={(event) => edit({ timeZone: event.target.value })}
                  placeholder="Europe/Prague"
                  maxLength={100}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={locked}
                  aria-invalid={zoneError}
                  aria-describedby={zoneError ? `${id}-zone-error` : undefined}
                />
                {current.canManage && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={copy.restore}
                        disabled={
                          locked || (current.source === "server" && !draft)
                        }
                        onClick={() => {
                          setDraft({
                            revision: current.revision,
                            settings: {
                              ...settings,
                              timeZone: current.defaults.timeZone,
                              enabled: [
                                ...settings.enabled.filter(
                                  (plugin) => plugin !== "datetime",
                                ),
                                ...current.defaults.enabled.filter(
                                  (plugin) => plugin === "datetime",
                                ),
                              ],
                            },
                          });
                          setError(null);
                          setZoneError(false);
                        }}
                      >
                        <RotateCcw aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{copy.restore}</TooltipContent>
                  </Tooltip>
                )}
              </div>
              <datalist id={`${id}-zones`}>
                {Array.from(
                  new Set([
                    current.settings.timeZone,
                    current.defaults.timeZone,
                    ...zones,
                  ]),
                ).map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
              {zoneError && (
                <FieldError id={`${id}-zone-error`}>
                  {copy.zoneInvalid}
                </FieldError>
              )}
            </SettingRow>
          </SettingRows>
          <Disclosure title={copy.details}>
            <DetailList
              items={[
                {
                  label: copy.capabilities,
                  value: (
                    <span className="flex flex-wrap gap-1">
                      {[copy.relative, copy.zones, copy.daylight].map(
                        (label) => (
                          <Badge key={label} variant="outline">
                            {label}
                          </Badge>
                        ),
                      )}
                    </span>
                  ),
                },
                {
                  label: copy.tools,
                  value: (
                    <span className="flex flex-col gap-1">
                      {plugin.tools.map((tool) => (
                        <code
                          key={tool}
                          className="font-mono text-xs break-all"
                        >
                          {tool}
                        </code>
                      ))}
                    </span>
                  ),
                },
                { label: copy.execution, value: copy.pure },
                { label: copy.formatLabel, value: copy.format },
                { label: copy.rangeLabel, value: copy.range },
                { label: copy.version, value: plugin.version },
              ]}
            />
          </Disclosure>
        </Section>
        {current.canManage && (draft || busy) && (
          <SaveBar status={common.unsavedChanges}>
            {draft && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={discard}
              >
                {common.discardChanges}
              </Button>
            )}
            <SubmitButton pending={busy} disabled={!draft || locked}>
              {common.save}
            </SubmitButton>
          </SaveBar>
        )}
      </form>
      <PluginPreview
        key={`${current.revision}:${current.settings.timeZone}:${current.settings.enabled.join(",")}`}
        current={current}
        blocked={!!draft || busy || stale || conflict || refreshFailed}
        unsaved={!!draft}
      />
    </div>
  );
}
