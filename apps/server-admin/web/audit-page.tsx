import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { z } from "zod";
import { ChevronLeft, ChevronRight, ScrollText } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Card } from "@admin/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@admin/components/ui/table";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@admin/components/ui/empty";
import {
  AlertAction,
  Alert,
  AlertDescription,
} from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";
import {
  AuditPage as AuditPageSchema,
  AuditOutcome,
  type AuditEntry,
} from "../../../packages/protocol/audit";
import type { OrganizationDetail } from "../../../packages/protocol/identity";
import { PageHeader } from "@admin/components/console/page";
import { DetailList } from "@admin/components/console/forms";
import { StatusBadge, type Tone } from "@admin/components/console/status";
import type { Copy } from "./i18n";
import { useAdmin } from "./context";
import { IdentityPage } from "./identity-pages";
import { api, ApiError, errorMessage } from "./lib/api";
import { useCatalog } from "./catalog-shared";
import { readableName } from "../../../packages/protocol/display-name";

type AuditFilter = { workspaceId: string; category: string; outcome: string };
const all = "all";
/** A link may open the log already filtered, e.g. today's failed actions. */
export const auditSearchSchema = z.object({
  workspaceId: z.string().max(200).optional().catch(undefined),
  category: z.enum(["changes", "tools"]).optional().catch(undefined),
  outcome: AuditOutcome.optional().catch(undefined),
});

export const auditActions: Record<AuditEntry["action"], keyof Copy> = {
  "mcp.access_issued": "auditMcpAccessIssued",
  "mcp.access_revoked": "auditMcpAccessRevoked",
  "auth.provider_changed": "auditAuthProvider",
  "hosted.server_changed": "auditHostedServer",
  "server.settings_changed": "auditServerSettings",
  "server.settings_imported": "auditServerSettingsImported",
  "server.plugin_changed": "auditPluginFiles",
  "catalog.ai_changed": "auditCatalogAi",
  "catalog.routing_changed": "auditCatalogRouting",
  "catalog.service_changed": "auditCatalogService",
  "catalog.process_changed": "auditCatalogProcess",
  "catalog.actions_discovered": "auditCatalogDiscovery",
  "catalog.action_invoked": "auditToolInvoked",
  "catalog.personal_policy_changed": "auditPersonalPolicy",
  "catalog.personal_service_added": "auditPersonalServiceAdded",
  "catalog.personal_service_changed": "auditPersonalServiceChanged",
  "catalog.personal_service_removed": "auditPersonalServiceRemoved",
  "catalog.personal_service_reviewed": "auditPersonalServiceReviewed",
  "organization.created": "auditOrganizationCreated",
  "account.created": "auditAccountCreated",
  "workspace.created": "auditWorkspaceCreated",
  "member.role_changed": "auditRoleChanged",
  "member.removed": "auditMemberRemoved",
  "workspace.member_changed": "auditMembershipChanged",
  "workspace.role_changed": "auditRoleChanged",
  "workspace.ai_changed": "auditAIChanged",
  "workspace.plugins_changed": "auditPluginsChanged",
  "memory.changed": "auditMemoryChanged",
  "memory.preference_changed": "auditMemoryPreference",
  "calendar.created": "auditCalendarCreated",
  "calendar.configured": "auditCalendarConfigured",
  "calendar.key_rotated": "auditCalendarRotated",
  "calendar.removed": "auditCalendarRemoved",
  "calendar.executed": "auditCalendarExecuted",

  "connection.created": "auditConnectionCreated",
  "connection.configured": "auditConnectionConfigured",
  "connection.key_rotated": "auditKeyRotated",
  "connection.removed": "auditConnectionRemoved",
  "connection.chat_selected": "auditChatSelected",
  "tool.invoked": "auditToolInvoked",
  "invitation.created": "auditInvitationCreated",
  "invitation.revoked": "auditInvitationRevoked",
  "password.reset_issued": "auditPasswordResetIssued",
  "password.reset_used": "auditPasswordResetUsed",
  "password.changed": "auditPasswordChanged",
  "session.revoked": "auditSessionRevoked",
  "skill.changed": "auditSkillChanged",
  "work.cancelled": "auditWorkCancelled",
};
export const auditOutcomes: Record<AuditEntry["outcome"], keyof Copy> = {
  succeeded: "auditSucceeded",
  running: "auditRunning",
  failed: "auditFailed",
  denied: "auditDenied",
  cancelled: "auditCancelled",
  interrupted: "auditInterrupted",
  unknown: "auditUnknown",
};
const sources: Record<AuditEntry["source"], keyof Copy> = {
  console: "auditConsole",
  chat: "auditChat",
  recovery: "auditRecovery",
  mcp: "auditMcp",
};
const reasons = {
  access_changed: "auditAccessChanged",
  invalid_input: "inputError",
  provider_failed: "auditProviderFailed",
  cancelled: "auditCancelled",
  server_stopped: "auditServerStopped",
} as const;
/**
 * Action invocations record the action ID; the current workspace catalog turns
 * it into the action and service a person recognizes. Unknown IDs keep the
 * generic event name.
 */
export function useAuditEvent() {
  const { copy } = useAdmin();
  const { query } = useCatalog();
  const actions = useMemo(
    () =>
      new Map(
        (query.data?.services ?? []).flatMap((service) =>
          service.actions.map(
            (action) =>
              [
                action.id,
                { title: readableName(action.name), service: service.name },
              ] as const,
          ),
        ),
      ),
    [query.data],
  );
  return (entry: AuditEntry): { title: string; service?: string } =>
    (entry.action === "catalog.action_invoked" && entry.targetId
      ? actions.get(entry.targetId)
      : undefined) ?? { title: copy[auditActions[entry.action]] };
}
export function AuditPage() {
  const { copy, data } = useAdmin();
  return (
    <IdentityPage
      page="workspaces"
      title={copy.auditLog}
      content={(detail) => (
        <AuditFeed
          key={`${data.authentication.principalId}:${detail.organizationId}`}
          detail={detail}
        />
      )}
    />
  );
}
export function outcomeTone(outcome: AuditEntry["outcome"]): Tone {
  return outcome === "succeeded"
    ? "success"
    : outcome === "running"
      ? "info"
      : outcome === "failed" || outcome === "denied"
        ? "danger"
        : "warning";
}
function AuditFeed({ detail }: { detail: OrganizationDetail }) {
  const { copy, data, language } = useAdmin();
  const search = auditSearchSchema.parse(useSearch({ strict: false }));
  const [filter, setFilter] = useState<AuditFilter>(() => ({
    workspaceId: detail.workspaces.some((w) => w.id === search.workspaceId)
      ? search.workspaceId!
      : "",
    category: search.category ?? "",
    outcome: search.outcome ?? "",
  }));
  const [cursors, setCursors] = useState<number[]>([]);
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const before = cursors.at(-1);
  const query = useQuery({
    queryKey: [
      "admin",
      "audit",
      data.authentication.principalId,
      detail.organizationId,
      filter,
      before,
    ],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        organizationId: detail.organizationId,
      });
      for (const [key, value] of Object.entries(filter))
        if (value) params.set(key, value);
      if (before) params.set("before", String(before));
      return AuditPageSchema.parse(
        await api(`identity/audit?${params}`, undefined, signal),
      );
    },
    enabled: detail.canManageWorkspaces,
    staleTime: 0,
    refetchInterval: before ? false : 15_000,
  });
  const event = useAuditEvent();
  const header = <PageHeader title={copy.auditLog} />;
  if (!detail.canManageWorkspaces)
    return (
      <>
        {header}
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ScrollText />
            </EmptyMedia>
            <EmptyTitle>{copy.auditManagersOnly}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </>
    );
  const change = (key: keyof AuditFilter, value: string) => {
    setFilter({ ...filter, [key]: value === all ? "" : value });
    setCursors([]);
  };
  // With a single workspace the column and filter only repeat its name.
  const multiWorkspace = detail.workspaces.length > 1;
  const actor = (entry: AuditEntry) =>
    entry.actorName ??
    (entry.actorId ? copy.auditFormerAccount : copy.auditRecovery);
  const queryError =
    query.isError || (!query.isPending && !query.data)
      ? copy[
          query.error instanceof ApiError && query.error.status === 403
            ? "forbiddenError"
            : errorMessage(query.error)
        ]
      : null;
  const now = query.dataUpdatedAt;
  const entries = query.data?.entries ?? [];
  const columns = 3 + (multiWorkspace ? 1 : 0);
  return (
    <>
      <PageHeader
        title={copy.auditLog}
        toolbar={
          <>
            {multiWorkspace && (
              <FilterSelect
                label={copy.workspace}
                value={filter.workspaceId}
                onChange={(value) => change("workspaceId", value)}
                options={[
                  { value: all, label: copy.auditAllWorkspaces },
                  ...detail.workspaces.map((w) => ({
                    value: w.id,
                    label: w.name,
                  })),
                ]}
              />
            )}
            <FilterSelect
              label={copy.auditCategory}
              value={filter.category}
              onChange={(value) => change("category", value)}
              options={[
                { value: all, label: copy.auditAllEvents },
                { value: "changes", label: copy.auditChanges },
                { value: "tools", label: copy.tools },
              ]}
            />
            <FilterSelect
              label={copy.auditOutcome}
              value={filter.outcome}
              onChange={(value) => change("outcome", value)}
              options={[
                { value: all, label: copy.auditAllOutcomes },
                ...AuditOutcome.options.map((outcome) => ({
                  value: outcome,
                  label: copy[auditOutcomes[outcome]],
                })),
              ]}
            />
          </>
        }
      />
      <div className="flex flex-col gap-4">
        {query.isPending ? (
          <div role="status">
            <span className="sr-only">{copy.loading}</span>
            <Skeleton className="h-96 w-full" />
          </div>
        ) : queryError ? (
          <Alert variant="destructive">
            <AlertDescription>{queryError}</AlertDescription>
            <AlertAction>
              <Button variant="outline" onClick={() => void query.refetch()}>
                {copy.retry}
              </Button>
            </AlertAction>
          </Alert>
        ) : !entries.length ? (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ScrollText />
              </EmptyMedia>
              <EmptyTitle>{copy.auditEmpty}</EmptyTitle>
              <EmptyDescription>{copy.auditEmptyHint}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card variant="flush">
            <Table aria-label={copy.auditLog}>
              <TableHeader>
                <TableRow>
                  <TableHead>{copy.auditEvent}</TableHead>
                  <TableHead className="hidden md:table-cell">
                    {copy.auditActor}
                  </TableHead>
                  {multiWorkspace && (
                    <TableHead className="hidden lg:table-cell">
                      {copy.workspace}
                    </TableHead>
                  )}
                  <TableHead className="hidden w-32 text-right sm:table-cell">
                    {copy.auditTime}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry, index) => {
                  const { title, service } = event(entry);
                  const day = dayLabel(entry.createdAt, language, now);
                  const previous = entries[index - 1];
                  const newDay =
                    !previous ||
                    dayLabel(previous.createdAt, language, now) !== day;
                  return (
                    <Fragment key={entry.id}>
                      {newDay && (
                        <tr className="border-b bg-muted/40">
                          <th
                            scope="colgroup"
                            colSpan={columns}
                            className="px-4 py-1.5 text-left text-xs font-medium text-muted-foreground"
                          >
                            {day}
                          </th>
                        </tr>
                      )}
                      <TableRow
                        onClick={() => setSelected(entry)}
                        className="cursor-pointer"
                      >
                        <TableCell className="max-w-0 md:w-1/2">
                          <span className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-2">
                            <button
                              type="button"
                              className="truncate text-left font-medium outline-none focus-visible:underline"
                              onClick={(click) => {
                                click.stopPropagation();
                                setSelected(entry);
                              }}
                            >
                              {title}
                            </button>
                            {/* Only exceptions carry a state; success is the norm. */}
                            {entry.outcome !== "succeeded" && (
                              <span className="shrink-0 self-start sm:self-auto">
                                <StatusBadge tone={outcomeTone(entry.outcome)}>
                                  {copy[auditOutcomes[entry.outcome]]}
                                </StatusBadge>
                              </span>
                            )}
                            {service && (
                              <span className="truncate text-xs text-muted-foreground">
                                {service}
                              </span>
                            )}
                            <span className="truncate text-xs text-muted-foreground md:hidden">
                              {actor(entry)}
                              <span className="sm:hidden">
                                , <ClockTime value={entry.createdAt} />
                              </span>
                            </span>
                          </span>
                        </TableCell>
                        <TableCell className="hidden max-w-48 md:table-cell">
                          <span className="block truncate">{actor(entry)}</span>
                        </TableCell>
                        {multiWorkspace && (
                          <TableCell className="hidden max-w-48 lg:table-cell">
                            <span className="block truncate text-muted-foreground">
                              {entry.workspaceName ?? copy.organization}
                            </span>
                          </TableCell>
                        )}
                        <TableCell className="hidden text-right sm:table-cell">
                          <span className="text-muted-foreground">
                            <ClockTime value={entry.createdAt} />
                          </span>
                        </TableCell>
                      </TableRow>
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        )}
        {(before || query.data?.nextBefore) && (
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={!before || query.isFetching}
                onClick={() => setCursors((values) => values.slice(0, -1))}
              >
                <ChevronLeft data-icon="inline-start" aria-hidden="true" />
                {copy.auditNewer}
              </Button>
              {before && (
                <Button
                  variant="ghost"
                  disabled={query.isFetching}
                  onClick={() => setCursors([])}
                >
                  {copy.auditLatest}
                </Button>
              )}
            </div>
            <Button
              variant="outline"
              disabled={
                !query.data?.nextBefore || query.isError || query.isFetching
              }
              onClick={() => {
                if (query.data?.nextBefore)
                  setCursors((values) => [...values, query.data!.nextBefore!]);
              }}
            >
              {copy.auditOlder}
              <ChevronRight data-icon="inline-end" aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>
      <Sheet
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent
          showDismissAction
          className="data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
        >
          <SheetHeader>
            <SheetTitle>
              {selected ? event(selected).title : copy.auditDetails}
            </SheetTitle>
            <SheetDescription>
              {selected &&
                `${actor(selected)}, ${new Date(selected.createdAt).toLocaleString(language)}`}
            </SheetDescription>
          </SheetHeader>
          {selected && (
            <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
              <div className="flex flex-wrap items-center gap-2">
                {selected.outcome !== "succeeded" && (
                  <StatusBadge tone={outcomeTone(selected.outcome)}>
                    {copy[auditOutcomes[selected.outcome]]}
                  </StatusBadge>
                )}
                <span className="text-xs text-muted-foreground">
                  {copy[sources[selected.source]]}
                </span>
              </div>
              <AuditDetail entry={selected} />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select value={value || all} onValueChange={onChange}>
      <SelectTrigger className="w-full sm:w-48" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
function AuditDetail({ entry }: { entry: AuditEntry }) {
  const { copy, language } = useAdmin();
  const d = entry.details;
  const items: [string, ReactNode][] = [
    [copy.auditId, <Mono key="id">{entry.id}</Mono>],
    [copy.auditTime, new Date(entry.createdAt).toLocaleString(language)],
    [
      copy.auditActor,
      entry.actorId ? (
        <span key="actor" className="flex flex-col gap-0.5">
          {entry.actorName ?? copy.auditFormerAccount}
          <Mono>{entry.actorId}</Mono>
        </span>
      ) : (
        copy.auditRecovery
      ),
    ],
  ];
  if (entry.workspaceId)
    items.push([copy.workspace, entry.workspaceName ?? entry.workspaceId]);
  if (entry.targetId)
    items.push([copy.auditTarget, <Mono key="target">{entry.targetId}</Mono>]);
  if (d.toolId) items.push([copy.toolId, <Mono key="tool">{d.toolId}</Mono>]);
  if (d.previousRole)
    items.push([copy.auditPreviousRole, copy[d.previousRole]]);
  if (d.role) items.push([copy.role, copy[d.role]]);
  if (d.modelId !== undefined)
    items.push([
      copy.aiModel,
      `${d.previousModelId ?? copy.disabled} → ${d.modelId ?? copy.disabled}`,
    ]);
  if (d.voiceId !== undefined)
    items.push([
      copy.aiVoice,
      `${d.previousVoiceId ?? copy.disabled} → ${d.voiceId ?? copy.disabled}`,
    ]);
  if (d.allowed !== undefined)
    items.push([
      copy.auditMembership,
      d.allowed ? copy.auditGranted : copy.auditRevoked,
    ]);
  if (d.enabled !== undefined)
    items.push([
      copy.enableConnection,
      d.enabled ? copy.enabled : copy.disabled,
    ]);
  if (d.revision !== undefined)
    items.push([
      copy.auditRevision,
      `${d.previousRevision !== undefined ? `${d.previousRevision} → ` : ""}${d.revision}`,
    ]);
  if (d.expiresAt)
    items.push([
      copy.credentialExpiry,
      new Date(d.expiresAt).toLocaleString(language),
    ]);
  if (d.processEvent)
    items.push([
      copy.auditProcessEvent,
      copy[
        {
          draft_saved: "auditProcessDraft",
          version_frozen: "auditProcessFrozen",
          version_tested: "auditProcessTested",
          version_activated: "auditProcessActivated",
          native_version_activated: "auditProcessNativeActivated",
          native_version_rolled_back: "auditProcessNativeRolledBack",
          contract_test_started: "auditProcessContractStarted",
          contract_test_completed: "auditProcessContractCompleted",
          contract_test_interrupted: "auditProcessContractInterrupted",
          native_test_started: "auditProcessNativeStarted",
          native_test_completed: "auditProcessNativeCompleted",
          native_test_interrupted: "auditProcessNativeInterrupted",
          native_test_qualified: "auditProcessNativeQualified",
          native_test_qualification_failed:
            "auditProcessNativeQualificationFailed",
          archived: "auditProcessArchived",
        }[d.processEvent] as keyof Copy
      ],
    ]);
  if (d.processVersion)
    items.push([copy.auditProcessVersion, String(d.processVersion)]);
  if (d.skillEvent)
    items.push([
      copy.auditSkillEvent,
      copy[
        (
          {
            created: "auditSkillCreated",
            updated: "auditSkillUpdated",
            enabled: "auditSkillEnabled",
            disabled: "auditSkillDisabled",
            archived: "auditSkillArchived",
          } as const
        )[d.skillEvent]
      ],
    ]);
  if (d.pluginEvent)
    items.push([
      copy.auditPluginEvent,
      copy[
        (
          {
            saved: "auditPluginSaved",
            reset: "auditPluginReset",
            deleted: "auditPluginDeleted",
            created: "auditPluginCreated",
            refused: "auditPluginRefused",
          } as const
        )[d.pluginEvent]
      ],
    ]);
  if (d.skillOwner)
    items.push([
      copy.auditSkillKind,
      copy[
        d.skillOwner === "personal"
          ? "auditSkillPersonal"
          : "auditSkillWorkspace"
      ],
    ]);
  if (d.durationMs !== undefined)
    items.push([copy.auditDuration, `${d.durationMs} ms`]);
  if (d.reason) items.push([copy.auditReason, copy[reasons[d.reason]]]);
  // Instant events finish when they start; only show a distinct end time.
  if (
    entry.finishedAt &&
    Math.abs(Date.parse(entry.finishedAt) - Date.parse(entry.createdAt)) >= 1000
  )
    items.push([
      copy.auditFinished,
      new Date(entry.finishedAt).toLocaleString(language),
    ]);
  if (d.grants)
    for (const grant of d.grants)
      items.push([
        grant.toolId,
        grant.roles.map((role) => copy[role]).join(", ") || copy.auditNoRoles,
      ]);
  if (d.calendarRoles)
    items.push([
      copy.calendarCreateRoles,
      d.calendarRoles.map((role) => copy[role]).join(", ") || copy.auditNoRoles,
    ]);
  return (
    <DetailList items={items.map(([label, value]) => ({ label, value }))} />
  );
}
function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-xs break-all">{children}</code>;
}

/** "Today", "Yesterday", then a weekday and date: the audit log's day groups. */
function dayLabel(value: string, language: string, now: number) {
  const date = new Date(value);
  const startOf = (time: number) => new Date(time).setHours(0, 0, 0, 0);
  const days = Math.round(
    (startOf(date.getTime()) - startOf(now)) / 86_400_000,
  );
  const label =
    days > -2 && days <= 0
      ? new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(
          days,
          "day",
        )
      : date.toLocaleDateString(language, {
          weekday: "long",
          day: "numeric",
          month: "long",
          year:
            date.getFullYear() === new Date(now).getFullYear()
              ? undefined
              : "numeric",
        });
  return label.charAt(0).toLocaleUpperCase(language) + label.slice(1);
}
/** Time of day inside a day group; the full date sits in the tooltip. */
function ClockTime({ value }: { value: string }) {
  const { language } = useAdmin();
  const date = new Date(value);
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString(language, {
        dateStyle: "full",
        timeStyle: "short",
      })}
      className="whitespace-nowrap tabular-nums"
    >
      {date.toLocaleTimeString(language, {
        hour: "numeric",
        minute: "2-digit",
      })}
    </time>
  );
}
