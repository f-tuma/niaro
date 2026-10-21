import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, type LinkProps } from "@tanstack/react-router";
import {
  ArrowRight,
  AudioLines,
  Check,
  Boxes,
  BrainCircuit,
  MessageSquare,
  Scale,
  Volume2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { AuditPage as AuditPageSchema } from "../../../packages/protocol/audit";
import { WorkspacePluginsSchema } from "../../../packages/protocol/workspace-plugins";
import type {
  CatalogModelSchema,
  ServiceSchema,
} from "../../../packages/protocol/service-catalog";
import { z } from "zod";
import { InferenceBudgetPolicySchema } from "../../../packages/protocol/inference-budget";
import { useAdmin } from "./context";
import { useShellCopy } from "./shell-copy";
import {
  setupChecklist,
  type SetupStep,
  type SetupStepKey,
} from "./lib/setup-checklist";
import { useCatalog, type CatalogState } from "./catalog-shared";
import { ServiceAvatar } from "./service-avatar";
import { auditOutcomes, outcomeTone, useAuditEvent } from "./audit-page";
import { api } from "./lib/api";
import { RelativeTime } from "@admin/components/console/time";
import { PageHeader, Section } from "@admin/components/console/page";
import { StatusBadge } from "@admin/components/console/status";
import { Button } from "@admin/components/ui/button";
import { Card } from "@admin/components/ui/card";
import { Progress } from "@admin/components/ui/progress";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import { plural } from "@admin/lib/plural";
import { Skeleton } from "@admin/components/ui/skeleton";
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

type Model = z.infer<typeof CatalogModelSchema>;
type Service = z.infer<typeof ServiceSchema>;

export function OverviewPage() {
  const { data } = useAdmin();
  // The recovery key manages accounts only; it has no workspace to summarize.
  if (data.authentication.current !== "better-auth")
    return <Navigate to="/people" replace />;
  return <WorkspaceOverview />;
}

function LoadError({ retry }: { retry: () => void }) {
  const copy = useShellCopy();
  return (
    <Alert variant="destructive">
      <AlertDescription>{copy.loadFailed}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={retry}>
          {copy.retry}
        </Button>
      </AlertAction>
    </Alert>
  );
}

function WorkspaceOverview() {
  const copy = useShellCopy();
  const state = useCatalog();
  const { scope, query } = state;
  const retry = () => {
    void scope.identity.refetch();
    void scope.detail.refetch();
    void query.refetch();
  };
  if (scope.identity.isError || scope.detail.isError)
    return <LoadError retry={retry} />;
  if (
    scope.identity.isPending ||
    (scope.organization && scope.detail.isPending)
  )
    return <OverviewSkeleton />;
  if (!scope.organization || !scope.workspace)
    return (
      <Empty variant="outline">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Boxes />
          </EmptyMedia>
          <EmptyTitle>{copy.noScope}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link to="/workspaces">{copy.addWorkspace}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  return (
    <>
      <PageHeader title={scope.workspace.name} />
      {query.data ? (
        <Dashboard state={state} />
      ) : query.isError ? (
        <LoadError retry={retry} />
      ) : (
        <OverviewSkeleton />
      )}
    </>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-40 w-full" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

function Dashboard({ state }: { state: CatalogState }) {
  const copy = useShellCopy();
  const { data, language } = useAdmin();
  const catalog = state.query.data!;
  const { organization, workspace, detail } = state.scope;
  const plugins = useQuery({
    queryKey: [
      "admin",
      "plugins",
      data.authentication.principalId,
      organization!.id,
      workspace!.id,
      organization!.role !== "member",
    ],
    queryFn: async ({ signal }) =>
      WorkspacePluginsSchema.parse(
        await api(
          `identity/plugins?${new URLSearchParams({ organizationId: organization!.id, workspaceId: workspace!.id })}`,
          undefined,
          signal,
        ),
      ),
    staleTime: 15_000,
  });
  const models = new Map(catalog.models.map((model) => [model.id, model]));
  const model = (id: string | null) => (id ? models.get(id) : undefined);
  const routing = catalog.routing;
  const enabledServices = catalog.services.filter((s) => s.enabled);
  const granted = (service: Service) =>
    service.actions.filter(
      (a) =>
        a.enabled &&
        (a.policy.roles.length > 0 ||
          a.policy.users.some((u) => u.access === "allow")),
    ).length;
  const grantedActions = enabledServices.reduce((n, s) => n + granted(s), 0);
  const enabledPlugins = plugins.data?.settings.enabled.length ?? 0;
  const enabledModels = catalog.models.filter((m) => m.enabled).length;
  const requests = catalog.providers.reduce((n, p) => n + p.requestsToday, 0);
  const limit = catalog.providers.reduce((n, p) => n + p.dailyRequestLimit, 0);

  const voiceIn: StageValue =
    routing.voiceMode === "disabled"
      ? { off: true }
      : routing.voiceMode === "legacy"
        ? { primary: copy.serverDefault }
        : {
            primary: modelName(model(routing.voiceModelId)),
            secondary:
              routing.voiceMethod === "transcription"
                ? copy.direct
                : copy.interpreter,
            missing: !model(routing.voiceModelId),
          };
  const speechModel = model(routing.speech.modelId);
  // Same rows, order and terms as the Routing page: model first, mode second.
  const stages: Stage[] = [
    {
      key: "model",
      label: copy.stageModel,
      icon: BrainCircuit,
      to: "/routing",
      value: {
        primary: modelName(model(routing.modelId)),
        missing: !model(routing.modelId),
      },
    },
    {
      key: "tools",
      label: copy.stageTools,
      icon: Wrench,
      to: "/services",
      value: {
        primary: plural(language, enabledServices.length, copy.servicesCount),
        secondary: plural(language, enabledPlugins, copy.pluginsCount),
      },
    },
    {
      key: "decision",
      label: copy.stageDecision,
      icon: Scale,
      to: "/routing",
      value: routing.decision.enabled
        ? {
            primary: modelName(model(routing.decision.modelId)),
            secondary: `≥ ${Math.round(routing.decision.minConfidence * 100)} %`,
            missing: !model(routing.decision.modelId),
          }
        : { off: true },
    },
    {
      key: "voice-in",
      label: copy.stageVoiceIn,
      icon: AudioLines,
      to: "/routing",
      value: voiceIn,
    },
    {
      key: "voice-out",
      label: copy.stageVoiceOut,
      icon: Volume2,
      to: "/routing",
      value:
        routing.speech.method === "reader"
          ? speechModel
            ? { primary: speechModel.name, secondary: copy.reader }
            : { primary: copy.reader }
          : {
              primary: modelName(speechModel),
              secondary: copy.speech,
              missing: !speechModel,
            },
    },
  ];
  function modelName(value: Model | undefined) {
    return value?.name ?? copy.notAssigned;
  }

  const checklist = useSetupChecklist(state);

  return (
    <>
      {checklist && <SetupSteps steps={checklist} />}
      <Card variant="flush" className="grid grid-cols-2 lg:grid-cols-4">
        <Metric
          label={copy.enabledServices}
          value={enabledServices.length}
          total={catalog.services.length}
        />
        <Metric label={copy.actionsGranted} value={grantedActions} />
        <Metric
          label={copy.availableModels}
          value={enabledModels}
          total={catalog.models.length}
        />
        <Metric
          label={copy.requestsToday}
          value={requests}
          total={limit || undefined}
        />
      </Card>
      <div className="grid items-start gap-8 lg:grid-cols-2">
        <Section title={copy.pipeline}>
          <Pipeline stages={stages} />
        </Section>
        <div className="flex min-w-0 flex-col gap-8">
          <Section
            title={copy.services}
            count={catalog.services.length}
            actions={
              <Button variant="ghost" size="sm" asChild>
                <Link to="/services">
                  {copy.viewAll}
                  <ArrowRight data-icon="inline-end" aria-hidden="true" />
                </Link>
              </Button>
            }
          >
            <ServiceSummary
              state={state}
              granted={granted}
              canManage={catalog.canManage}
            />
          </Section>
          {detail.data?.canManageWorkspaces && (
            <RecentActivity organizationId={organization!.id} />
          )}
        </div>
      </div>
    </>
  );
}

type StageValue = {
  primary?: string;
  secondary?: string;
  missing?: boolean;
  off?: boolean;
};
type Stage = {
  key: string;
  label: string;
  icon: LucideIcon;
  to: LinkProps["to"];
  value: StageValue;
};

/** What each part of the assistant runs, in the Routing page's order. */
function Pipeline({ stages }: { stages: Stage[] }) {
  const copy = useShellCopy();
  return (
    <Card variant="list">
      {stages.map((stage) => (
        <Item key={stage.key} asChild variant="row" size="row">
          <Link to={stage.to}>
            <ItemMedia>
              <stage.icon
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{stage.label}</ItemTitle>
            </ItemContent>
            <ItemActions>
              {stage.value.off ? (
                <span className="text-sm text-muted-foreground">
                  {copy.off}
                </span>
              ) : stage.value.missing ? (
                <StatusBadge tone="warning">{copy.notAssigned}</StatusBadge>
              ) : (
                <span className="flex min-w-0 items-baseline gap-2 text-sm">
                  <span className="truncate">{stage.value.primary}</span>
                  {stage.value.secondary && (
                    <span className="hidden truncate text-muted-foreground sm:inline">
                      {stage.value.secondary}
                    </span>
                  )}
                </span>
              )}
            </ItemActions>
          </Link>
        </Item>
      ))}
    </Card>
  );
}

function Metric({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total?: number;
}) {
  const copy = useShellCopy();
  const { language } = useAdmin();
  const format = (n: number) => n.toLocaleString(language);
  return (
    <div className="flex flex-col gap-1 border-b px-4 py-3 odd:border-r lg:border-b-0 lg:border-r lg:last:border-r-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-1.5">
        <span className="text-xl font-semibold tracking-tight tabular-nums">
          {format(value)}
        </span>
        {total !== undefined && (
          <span className="text-sm text-muted-foreground tabular-nums">
            {copy.of} {format(total)}
          </span>
        )}
      </span>
    </div>
  );
}

const setupLabels = {
  provider: "setupProvider",
  model: "setupModel",
  routing: "setupRouting",
  budget: "setupBudget",
  service: "setupActions",
  people: "setupPeople",
} as const satisfies Record<
  SetupStepKey,
  keyof ReturnType<typeof useShellCopy>
>;

/**
 * The first-run checklist for managers, from the catalog, usage limits,
 * people and pending invitations the console already reads. Null while
 * something is still loading, for members, and once every step is done.
 */
function useSetupChecklist(state: CatalogState) {
  const { data } = useAdmin();
  const catalog = state.query.data!;
  const { detail } = state.scope;
  const manage = catalog.canManage;
  const budget = useQuery({
    queryKey: [
      "admin",
      "budget",
      data.authentication.principalId,
      state.target.organizationId,
      state.target.workspaceId,
    ],
    queryFn: async ({ signal }) =>
      InferenceBudgetPolicySchema.parse(
        await api(
          `identity/catalog/budget?${new URLSearchParams(state.target)}`,
          undefined,
          signal,
        ),
      ),
    enabled: manage,
    staleTime: 15_000,
  });
  const invitations = useQuery({
    // Its own key: the invitation sheet caches the full list under another.
    queryKey: [
      "admin",
      "pending-invitations",
      data.authentication.principalId,
      state.target.workspaceId,
    ],
    queryFn: async () =>
      PendingInvitations.parse(
        await api("identity/invitations", { ...state.target, action: "list" }),
      ).invitations.length,
    enabled: manage,
    staleTime: 15_000,
  });
  if (!manage || budget.isPending || invitations.isPending || !detail.data)
    return null;
  const steps = setupChecklist({
    catalog,
    budget: budget.data?.settings ?? null,
    members: detail.data.members.length,
    invitations: invitations.data ?? 0,
  });
  return steps.every((step) => step.done) ? null : steps;
}
const PendingInvitations = z.object({ invitations: z.array(z.unknown()) });

/** Every step with its state; the next open one is numbered in color. */
function SetupSteps({ steps }: { steps: readonly SetupStep[] }) {
  const copy = useShellCopy();
  const done = steps.filter((s) => s.done).length;
  const next = steps.findIndex((s) => !s.done);
  return (
    <Section
      title={copy.setup}
      actions={
        <span className="flex items-center gap-3 text-sm text-muted-foreground tabular-nums">
          <Progress
            value={(done / steps.length) * 100}
            className="w-24"
            aria-label={copy.setup}
          />
          {done} {copy.of} {steps.length}
        </span>
      }
    >
      <Card variant="list">
        {steps.map((step, index) => (
          <Item key={step.key} asChild variant="row" size="row">
            <Link to={step.to}>
              <ItemMedia>
                <span
                  aria-hidden="true"
                  data-next={index === next}
                  className="flex size-6 items-center justify-center rounded-full border text-xs font-medium tabular-nums data-[next=true]:border-transparent data-[next=true]:bg-primary data-[next=true]:text-primary-foreground"
                >
                  {step.done ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : (
                    index + 1
                  )}
                </span>
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{copy[setupLabels[step.key]]}</ItemTitle>
              </ItemContent>
            </Link>
          </Item>
        ))}
      </Card>
    </Section>
  );
}

function ServiceSummary({
  state,
  granted,
  canManage,
}: {
  state: CatalogState;
  granted: (service: Service) => number;
  canManage: boolean;
}) {
  const copy = useShellCopy();
  const { language } = useAdmin();
  const services = state.query.data!.services.slice(0, 6);
  if (!services.length)
    return (
      <Empty variant="outline">
        <EmptyHeader>
          <EmptyTitle>{copy.noServices}</EmptyTitle>
        </EmptyHeader>
        {canManage && (
          <EmptyContent>
            <Button asChild>
              <Link to="/services/new">{copy.setupService}</Link>
            </Button>
          </EmptyContent>
        )}
      </Empty>
    );
  return (
    <Card variant="list">
      {services.map((service) => (
        <Item key={service.id} asChild variant="row" size="row">
          <Link to="/services/$serviceId" params={{ serviceId: service.id }}>
            <ItemMedia>
              <ServiceAvatar service={service} state={state} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{service.name}</ItemTitle>
              <ItemDescription>
                {granted(service)} {copy.of}{" "}
                {plural(language, service.actions.length, copy.actionsCount)}{" "}
                {copy.withAccess}
              </ItemDescription>
            </ItemContent>
            {!service.enabled && (
              <ItemActions>
                <StatusBadge tone="neutral">{copy.off}</StatusBadge>
              </ItemActions>
            )}
          </Link>
        </Item>
      ))}
    </Card>
  );
}

function RecentActivity({ organizationId }: { organizationId: string }) {
  const copy = useShellCopy();
  const { copy: adminCopy, data } = useAdmin();
  const audit = useQuery({
    queryKey: [
      "admin",
      "audit",
      data.authentication.principalId,
      organizationId,
      "recent",
    ],
    queryFn: async ({ signal }) =>
      AuditPageSchema.parse(
        await api(
          `identity/audit?${new URLSearchParams({ organizationId })}`,
          undefined,
          signal,
        ),
      ),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const [now] = useState(Date.now);
  const event = useAuditEvent();
  const entries = audit.data?.entries.slice(0, 6) ?? [];
  return (
    <Section
      title={copy.recentActivity}
      actions={
        <Button variant="ghost" size="sm" asChild>
          <Link to="/audit">
            {copy.viewAll}
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Link>
        </Button>
      }
    >
      {audit.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : !entries.length ? (
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessageSquare />
            </EmptyMedia>
            <EmptyTitle>{copy.noActivity}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card variant="list">
          {entries.map((entry) => {
            const { title, service } = event(entry);
            return (
              <Item key={entry.id} variant="row" size="row">
                <ItemContent>
                  <ItemTitle>
                    <span className="truncate">{title}</span>
                    {/* Like the audit log, only exceptions carry a state. */}
                    {entry.outcome !== "succeeded" && (
                      <StatusBadge tone={outcomeTone(entry.outcome)}>
                        {adminCopy[auditOutcomes[entry.outcome]]}
                      </StatusBadge>
                    )}
                  </ItemTitle>
                </ItemContent>
                <ItemActions>
                  <span className="hidden max-w-48 truncate text-xs text-muted-foreground sm:block">
                    {service ?? entry.actorName ?? adminCopy.auditRecovery}
                  </span>
                  <span className="w-24 text-right text-xs text-muted-foreground">
                    <RelativeTime value={entry.createdAt} now={now} />
                  </span>
                </ItemActions>
              </Item>
            );
          })}
        </Card>
      )}
    </Section>
  );
}
