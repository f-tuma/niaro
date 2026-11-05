import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Plus, Trash2, X } from "lucide-react";
import {
  MODEL_ROLES,
  ROLE_DEFAULTS,
  budgetedReach,
  effectiveOptions,
  effectiveRole,
  effectiveRoute,
  policyView,
  type EffectiveRouteValue,
  type ModelRoleValue,
  type ModelTierValue,
  type OrganizationModelPolicyValue,
  type RoleRouteValue,
  type StoredModelPolicies,
  type WorkspaceModelPolicyValue,
} from "../../../packages/protocol/model-policy";
import type {
  Catalog,
  CatalogModel,
} from "../../../packages/protocol/service-catalog";
import { InferenceBudgetPolicySchema } from "../../../packages/protocol/inference-budget";
import { Button } from "@admin/components/ui/button";
import { Badge } from "@admin/components/ui/badge";
import { Input } from "@admin/components/ui/input";
import { Switch } from "@admin/components/ui/switch";
import { Spinner } from "@admin/components/ui/spinner";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Tabs, TabsList, TabsTrigger } from "@admin/components/ui/tabs";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@admin/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@admin/components/ui/input-group";
import { Empty, EmptyHeader, EmptyTitle } from "@admin/components/ui/empty";
import { PageHeader, Section } from "@admin/components/console/page";
import {
  SettingRow,
  SettingRows,
  SettingValue,
} from "@admin/components/console/setting-row";
import { SaveBar } from "@admin/components/console/forms";
import { StatusBadge } from "@admin/components/console/status";
import { ModelChoicePicker, type ModelChoice } from "./model-choice-picker";
import { useAdmin } from "./context";
import { api } from "./lib/api";
import {
  CatalogBoundary,
  useCatalog,
  type CatalogState,
} from "./catalog-shared";
import { useModelPolicyCopy, type ModelPolicyCopy } from "./model-policy-copy";

const OPENROUTER = "https://openrouter.ai/api/v1";
type RouteKey = ModelRoleValue | "service" | "escalation";

/**
 * Whether a catalog model can serve a role, as the server checks it: tool
 * models for chat work, decision or tool models for the checker and the
 * selector, OpenRouter models for audio and web search. Reserved roles take
 * any enabled model.
 */
export function modelFits(
  key: RouteKey,
  model: CatalogModel,
  providerUrl: string,
) {
  const openRouter = providerUrl.replace(/\/$/, "") === OPENROUTER;
  const tools =
    (model.kind === "chat" || model.kind === "router") && model.tools;
  switch (key) {
    case "checker":
    case "selector":
      return tools || (model.kind === "decision" && openRouter);
    case "web_search":
      return openRouter && (model.kind === "chat" || model.kind === "router");
    case "voice_input":
      return (
        openRouter &&
        ((model.kind === "chat" && model.audioInput) ||
          model.kind === "transcription")
      );
    case "meeting_transcription":
      return openRouter && model.kind === "transcription";
    case "speech":
      return (
        openRouter &&
        ((model.kind === "chat" && model.audioOutput) ||
          model.kind === "speech")
      );
    case "embedding":
    case "vision":
      return true;
    default:
      return tools;
  }
}

export function ModelPolicyPage() {
  const state = useCatalog();
  const copy = useModelPolicyCopy();
  return (
    <>
      <PageHeader title={copy.title} description={copy.description} />
      <CatalogBoundary state={state}>
        {state.query.data &&
          (state.query.data.canManage ? (
            <ModelPolicyForm key={state.target.workspaceId} state={state} />
          ) : (
            <Alert>
              <AlertDescription>{copy.notManager}</AlertDescription>
            </Alert>
          ))}
      </CatalogBoundary>
    </>
  );
}

function ModelPolicyForm({ state }: { state: CatalogState }) {
  const copy = useModelPolicyCopy();
  const { data } = useAdmin();
  const catalog = state.query.data!;
  const saved = catalog.policy;
  const [tab, setTab] = useState<"organization" | "workspace">("organization");
  const [organization, setOrganization] =
    useState<OrganizationModelPolicyValue | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceModelPolicyValue | null>(
    null,
  );
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
  });
  const draft: StoredModelPolicies = {
    organization: {
      revision: saved.organization.revision,
      policy: organization ?? saved.organization.policy,
    },
    workspace: {
      revision: saved.workspace.revision,
      policy: workspace ?? saved.workspace.policy,
    },
  };
  const view = policyView(
    draft,
    catalog.services.map((service) => service.id),
  );
  const enforce = budget.data?.settings.mode === "enforce";
  const priced = new Set(
    budget.data?.settings.prices.map((price) => price.modelId) ?? [],
  );
  const unpriced = enforce
    ? [...budgetedReach(view.effective).keys()].filter((id) => !priced.has(id))
    : [];
  const name = (id: string) =>
    catalog.models.find((model) => model.id === id)?.name ?? id;
  const dirty = organization !== null || workspace !== null;
  const tiers = draft.organization.policy.tiers;
  async function save() {
    if (organization) {
      const result = await state.mutate("command", {
        type: "saveOrganizationModelPolicy",
        revision: saved.organization.revision,
        policy: organization,
      });
      if (!result) return;
      setOrganization(null);
    }
    if (workspace) {
      const result = await state.mutate("command", {
        type: "saveWorkspaceModelPolicy",
        revision: saved.workspace.revision,
        policy: workspace,
      });
      if (!result) return;
      setWorkspace(null);
    }
  }
  const editor = {
    catalog,
    copy,
    tiers,
    disabled: state.busy,
    priced: enforce ? priced : null,
  };
  const orgPolicy = draft.organization.policy;
  const wsPolicy = draft.workspace.policy;
  const setOrgRole = (role: ModelRoleValue, route?: RoleRouteValue) => {
    const roles = { ...orgPolicy.roles };
    if (route) roles[role] = route;
    else delete roles[role];
    setOrganization({ ...orgPolicy, roles });
  };
  const setWsRole = (role: ModelRoleValue, route?: RoleRouteValue) => {
    const roles = { ...wsPolicy.roles };
    if (route) roles[role] = route;
    else delete roles[role];
    setWorkspace({ ...wsPolicy, roles });
  };
  const effective = effectiveOptions(draft);
  // The organization always has an escalation setting; a workspace shows
  // what it inherits until it sets its own.
  const escalation =
    tab === "organization"
      ? orgPolicy.options.escalation
      : (wsPolicy.options.escalation ?? effective.escalation);
  const setEscalation = (next: typeof escalation | undefined) => {
    if (tab === "organization") {
      if (next)
        setOrganization({
          ...orgPolicy,
          options: { ...orgPolicy.options, escalation: next },
        });
      return;
    }
    const { escalation: _inherited, ...rest } = wsPolicy.options;
    setWorkspace({
      ...wsPolicy,
      options: next ? { ...rest, escalation: next } : rest,
    });
  };
  // Tiers need a name and a model; an escalation needs models to go to.
  const invalid =
    tiers.some((tier) => !tier.name.trim() || !tier.models.length) ||
    (escalation.mode === "escalate" &&
      !escalation.tier &&
      !escalation.models.length);
  return (
    <>
      <Tabs
        value={tab}
        onValueChange={(value) =>
          setTab(value === "workspace" ? "workspace" : "organization")
        }
      >
        <TabsList variant="line" aria-label={copy.title}>
          <TabsTrigger value="organization">{copy.organization}</TabsTrigger>
          <TabsTrigger value="workspace">{copy.workspace}</TabsTrigger>
        </TabsList>
      </Tabs>
      {unpriced.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            {copy.unpriced(unpriced.map(name).join(", "))}
          </AlertDescription>
        </Alert>
      )}
      <Section title={copy.roles}>
        <SettingRows>
          {MODEL_ROLES.map((role) => {
            const own =
              tab === "organization"
                ? orgPolicy.roles[role]
                : wsPolicy.roles[role];
            const resolved = effectiveRole(
              tab === "organization"
                ? {
                    ...draft,
                    workspace: {
                      revision: 0,
                      policy: { roles: {}, services: [], options: {} },
                    },
                  }
                : draft,
              role,
            );
            return (
              <SettingRow
                key={role}
                wide
                label={
                  <>
                    {copy.roleNames[role]}
                    {role === "voice_input" && !catalog.voiceAvailable && (
                      <StatusBadge tone="warning">
                        {copy.voiceSetup}
                      </StatusBadge>
                    )}
                  </>
                }
                meta={copy.roleMeta[role]}
              >
                <RouteEditor
                  {...editor}
                  id={`role-${role}`}
                  routeKey={role}
                  label={copy.roleNames[role]}
                  route={own}
                  resolved={resolved}
                  inheritable={tab === "workspace" || !!ROLE_DEFAULTS[role]}
                  onChange={(route) =>
                    tab === "organization"
                      ? setOrgRole(role, route)
                      : setWsRole(role, route)
                  }
                />
              </SettingRow>
            );
          })}
        </SettingRows>
      </Section>
      {tab === "workspace" && (
        <Section title={copy.services} count={catalog.services.length}>
          {catalog.services.length ? (
            <SettingRows>
              {catalog.services.map((service) => {
                const own = wsPolicy.services.find(
                  (item) => item.serviceId === service.id,
                )?.route;
                return (
                  <SettingRow key={service.id} wide label={service.name}>
                    <RouteEditor
                      {...editor}
                      id={`service-${service.id}`}
                      routeKey="service"
                      label={service.name}
                      route={own}
                      resolved={effectiveRoute(draft, `service:${service.id}`)}
                      inheritable
                      onChange={(route) =>
                        setWorkspace({
                          ...wsPolicy,
                          services: [
                            ...wsPolicy.services.filter(
                              (item) => item.serviceId !== service.id,
                            ),
                            ...(route
                              ? [{ serviceId: service.id, route }]
                              : []),
                          ],
                        })
                      }
                    />
                  </SettingRow>
                );
              })}
            </SettingRows>
          ) : (
            <Empty variant="outline">
              <EmptyHeader>
                <EmptyTitle>{copy.noServices}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </Section>
      )}
      {tab === "organization" && (
        <TierEditor
          {...editor}
          onChange={(next) => setOrganization({ ...orgPolicy, tiers: next })}
        />
      )}
      <Section title={copy.escalation}>
        <SettingRows>
          <SettingRow
            label={copy.escalationMode}
            labelId="escalation-mode"
            meta={copy.escalationMeta}
            wide
          >
            <ToggleGroup
              type="single"
              variant="outline"
              className="w-full"
              aria-labelledby="escalation-mode"
              disabled={state.busy}
              value={escalation.mode}
              onValueChange={(mode) => {
                if (mode !== "stop" && mode !== "escalate") return;
                const lastTier = tiers[tiers.length - 1];
                setEscalation(
                  mode === "stop"
                    ? { mode, models: [], tier: null }
                    : escalation.tier || escalation.models.length
                      ? { ...escalation, mode }
                      : { mode, models: [], tier: lastTier?.id ?? null },
                );
              }}
            >
              <ToggleGroupItem value="stop" className="flex-1">
                {copy.escalationStop}
              </ToggleGroupItem>
              <ToggleGroupItem value="escalate" className="flex-1">
                {copy.escalationEscalate}
              </ToggleGroupItem>
            </ToggleGroup>
            {tab === "workspace" && wsPolicy.options.escalation && (
              <Button
                variant="ghost"
                size="sm"
                disabled={state.busy}
                onClick={() => setEscalation(undefined)}
              >
                {copy.useDefault}
              </Button>
            )}
          </SettingRow>
          {escalation.mode === "escalate" && (
            <SettingRow label={copy.ownModels} wide>
              <RouteEditor
                {...editor}
                id="escalation-route"
                routeKey="escalation"
                label={copy.escalation}
                route={{
                  models: escalation.models,
                  tier: escalation.tier,
                  fallback: false,
                }}
                resolved={view.effective.escalation}
                inheritable={false}
                hideFallback
                onChange={(route) =>
                  setEscalation({
                    mode: "escalate",
                    models: route?.models ?? [],
                    tier: route?.tier ?? null,
                  })
                }
              />
            </SettingRow>
          )}
        </SettingRows>
      </Section>
      <Section title={copy.options}>
        <SettingRows>
          <SettingRow
            label={copy.serverVoice}
            meta={copy.serverVoiceMeta}
            htmlFor="server-voice"
          >
            <Switch
              id="server-voice"
              disabled={state.busy}
              checked={
                tab === "organization"
                  ? orgPolicy.options.serverVoice
                  : effective.serverVoice
              }
              onCheckedChange={(serverVoice) =>
                tab === "organization"
                  ? setOrganization({
                      ...orgPolicy,
                      options: { ...orgPolicy.options, serverVoice },
                    })
                  : setWorkspace({
                      ...wsPolicy,
                      options: { ...wsPolicy.options, serverVoice },
                    })
              }
            />
          </SettingRow>
          <SettingRow label={copy.speechVoice} htmlFor="speech-voice" wide>
            <Input
              id="speech-voice"
              disabled={state.busy}
              placeholder={copy.speechVoiceDefault}
              maxLength={200}
              value={
                (tab === "organization"
                  ? orgPolicy.options.speech.voice
                  : effective.speech.voice) ?? ""
              }
              onChange={(event) => {
                const speech = {
                  ...(tab === "organization"
                    ? orgPolicy.options.speech
                    : effective.speech),
                  voice: event.target.value.trim() || null,
                };
                if (tab === "organization")
                  setOrganization({
                    ...orgPolicy,
                    options: { ...orgPolicy.options, speech },
                  });
                else
                  setWorkspace({
                    ...wsPolicy,
                    options: { ...wsPolicy.options, speech },
                  });
              }}
            />
          </SettingRow>
          <SettingRow
            label={copy.speechRetention}
            meta={copy.speechRetentionMeta}
            htmlFor="speech-retention"
          >
            <Switch
              id="speech-retention"
              disabled={state.busy}
              checked={
                tab === "organization"
                  ? orgPolicy.options.speech.zeroDataRetention
                  : effective.speech.zeroDataRetention
              }
              onCheckedChange={(zeroDataRetention) => {
                const speech = {
                  ...(tab === "organization"
                    ? orgPolicy.options.speech
                    : effective.speech),
                  zeroDataRetention,
                };
                if (tab === "organization")
                  setOrganization({
                    ...orgPolicy,
                    options: { ...orgPolicy.options, speech },
                  });
                else
                  setWorkspace({
                    ...wsPolicy,
                    options: { ...wsPolicy.options, speech },
                  });
              }}
            />
          </SettingRow>
          <SettingRow label={copy.minConfidence} htmlFor="min-confidence">
            <InputGroup className="w-28">
              <InputGroupInput
                id="min-confidence"
                type="number"
                min={50}
                max={100}
                step={1}
                disabled={state.busy}
                value={Math.round(
                  (tab === "organization"
                    ? orgPolicy.options.selector.minConfidence
                    : effective.selector.minConfidence) * 100,
                )}
                onChange={(event) => {
                  const value = Number(event.target.value) / 100;
                  if (!(value >= 0.5 && value <= 1)) return;
                  const selector = { minConfidence: value };
                  if (tab === "organization")
                    setOrganization({
                      ...orgPolicy,
                      options: { ...orgPolicy.options, selector },
                    });
                  else
                    setWorkspace({
                      ...wsPolicy,
                      options: { ...wsPolicy.options, selector },
                    });
                }}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText>%</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
          </SettingRow>
        </SettingRows>
      </Section>
      {(dirty || state.busy || state.error) && (
        <SaveBar
          status={state.error ?? copy.unsavedChanges}
          tone={state.error ? "error" : "muted"}
        >
          <Button
            variant="ghost"
            disabled={state.busy || !dirty}
            onClick={() => {
              setOrganization(null);
              setWorkspace(null);
              state.setError(null);
            }}
          >
            {copy.discardChanges}
          </Button>
          <Button
            disabled={state.busy || !dirty || invalid || unpriced.length > 0}
            onClick={() => void save()}
          >
            {state.busy && <Spinner data-icon="inline-start" />}
            {copy.save}
          </Button>
        </SaveBar>
      )}
    </>
  );
}

type EditorProps = {
  catalog: Catalog;
  copy: ModelPolicyCopy;
  tiers: ModelTierValue[];
  disabled: boolean;
  /** In enforce mode: the models with a price; null in observe mode. */
  priced: Set<string> | null;
};

/**
 * One route: its ordered models as chips (the first is the primary), or a
 * tier, with fallback. A route that is not set shows what it inherits and
 * offers to override it.
 */
function RouteEditor({
  catalog,
  copy,
  tiers,
  disabled,
  priced,
  id,
  routeKey,
  label,
  route,
  resolved,
  inheritable,
  hideFallback = false,
  onChange,
}: EditorProps & {
  id: string;
  routeKey: RouteKey;
  label: string;
  route: RoleRouteValue | undefined;
  resolved: EffectiveRouteValue;
  inheritable: boolean;
  hideFallback?: boolean;
  onChange: (route: RoleRouteValue | undefined) => void;
}) {
  const name = (modelId: string) =>
    catalog.models.find((model) => model.id === modelId)?.name ?? modelId;
  if (!route)
    return (
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <SettingValue>
          {resolved.models.length
            ? resolved.via
              ? copy.followsRole(copy.roleNames[resolved.via])
              : copy.inherited(resolved.models.map(name).join(", "))
            : copy.off}
        </SettingValue>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`${copy.override}: ${label}`}
          onClick={() =>
            onChange({
              models: resolved.tier ? [] : resolved.models,
              tier: resolved.tier,
              fallback: resolved.fallback,
            })
          }
        >
          {copy.override}
        </Button>
      </div>
    );
  const usable = (model: CatalogModel) => {
    const provider = catalog.providers.find((p) => p.id === model.providerId);
    return (
      !!provider &&
      provider.enabled &&
      model.enabled &&
      modelFits(routeKey, model, provider.url)
    );
  };
  const choices: ModelChoice[] = catalog.providers.flatMap((provider) =>
    catalog.models
      .filter(
        (model) =>
          model.providerId === provider.id &&
          usable(model) &&
          !route.models.includes(model.id),
      )
      .map((model) => ({
        value: model.id,
        label: model.name,
        detail: model.model,
        mono: true,
        group: provider.name,
      })),
  );
  const shown = route.tier
    ? (tiers.find((tier) => tier.id === route.tier)?.models ?? [])
    : route.models;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {tiers.length > 0 && (
        <Select
          value={route.tier ?? "models"}
          disabled={disabled}
          onValueChange={(value) =>
            onChange(
              value === "models"
                ? { ...route, tier: null, models: [] }
                : { ...route, tier: value, models: [] },
            )
          }
        >
          <SelectTrigger
            id={`${id}-source`}
            aria-label={`${copy.source}: ${label}`}
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="models">{copy.ownModels}</SelectItem>
            {tiers.map((tier) => (
              <SelectItem key={tier.id} value={tier.id}>
                {copy.tierLabel(tier.name)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <ol
        aria-label={label}
        className="flex min-w-0 flex-wrap items-center gap-1.5"
      >
        {shown.length === 0 && (
          <li>
            <SettingValue>{copy.noModels}</SettingValue>
          </li>
        )}
        {shown.map((modelId, index) => {
          const model = catalog.models.find((item) => item.id === modelId);
          const missing = !model || !usable(model);
          return (
            <li key={modelId} className="flex min-w-0 items-center gap-0.5">
              <Badge variant={index === 0 ? "secondary" : "outline"}>
                {name(modelId)}
                {index === 0 && shown.length > 1 ? ` · ${copy.primary}` : ""}
              </Badge>
              {missing && (
                <Badge variant="destructive">{copy.unavailable}</Badge>
              )}
              {priced && !priced.has(modelId) && (
                <Badge variant="warning">{copy.noPrice}</Badge>
              )}
              {!route.tier && index > 0 && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={disabled}
                  aria-label={copy.moveUp(name(modelId))}
                  onClick={() => {
                    const models = [...route.models];
                    [models[index - 1], models[index]] = [
                      models[index]!,
                      models[index - 1]!,
                    ];
                    onChange({ ...route, models });
                  }}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
              )}
              {!route.tier && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={disabled}
                  aria-label={copy.removeModel(name(modelId))}
                  onClick={() =>
                    onChange({
                      ...route,
                      models: route.models.filter((item) => item !== modelId),
                    })
                  }
                >
                  <X aria-hidden="true" />
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      {!route.tier && route.models.length < 8 && (
        <ModelChoicePicker
          id={`${id}-add`}
          label={`${copy.addModel}: ${label}`}
          value=""
          choices={[{ value: "", label: copy.addModel }, ...choices]}
          disabled={disabled}
          searchLabel={copy.addModel}
          emptyLabel={copy.noModels}
          onChange={(modelId) =>
            modelId &&
            onChange({ ...route, models: [...route.models, modelId] })
          }
        />
      )}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        {!hideFallback && (
          <label
            htmlFor={`${id}-fallback`}
            className="flex items-center gap-2 text-xs text-muted-foreground"
            title={copy.fallbackMeta}
          >
            <Switch
              id={`${id}-fallback`}
              size="sm"
              disabled={disabled}
              checked={route.fallback}
              aria-label={`${copy.fallback}: ${label}`}
              onCheckedChange={(fallback) => onChange({ ...route, fallback })}
            />
            {copy.fallback}
          </label>
        )}
        {inheritable && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={`${copy.useDefault}: ${label}`}
            onClick={() => onChange(undefined)}
          >
            {copy.useDefault}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Named model lists roles can point to; editing one moves every role on it. */
function TierEditor({
  catalog,
  copy,
  tiers,
  disabled,
  priced,
  onChange,
}: EditorProps & { onChange: (tiers: ModelTierValue[]) => void }) {
  const newId = () => {
    for (let index = 1; ; index++) {
      const id = `tier-${index}`;
      if (!tiers.some((tier) => tier.id === id)) return id;
    }
  };
  return (
    <Section
      title={copy.tiers}
      count={tiers.length}
      actions={
        tiers.length < 8 && (
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onChange([
                ...tiers,
                { id: newId(), name: copy.newTier, models: [] },
              ])
            }
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            {copy.addTier}
          </Button>
        )
      }
    >
      {tiers.length ? (
        <SettingRows>
          {tiers.map((tier, index) => (
            <SettingRow
              key={tier.id}
              wide
              label={
                <Input
                  aria-label={copy.tierName}
                  disabled={disabled}
                  maxLength={40}
                  value={tier.name}
                  onChange={(event) =>
                    onChange(
                      tiers.map((item, at) =>
                        at === index
                          ? { ...item, name: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
              }
            >
              <RouteEditor
                catalog={catalog}
                copy={copy}
                tiers={[]}
                disabled={disabled}
                priced={priced}
                id={`tier-${tier.id}`}
                routeKey="chat"
                label={tier.name}
                route={{ models: tier.models, tier: null, fallback: false }}
                resolved={{
                  models: tier.models,
                  fallback: false,
                  tier: null,
                  source: "organization",
                  via: null,
                }}
                inheritable={false}
                hideFallback
                onChange={(route) =>
                  onChange(
                    tiers.map((item, at) =>
                      at === index
                        ? { ...item, models: route?.models ?? [] }
                        : item,
                    ),
                  )
                }
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                aria-label={copy.removeTier(tier.name)}
                onClick={() => onChange(tiers.filter((_, at) => at !== index))}
              >
                <Trash2 data-icon="inline-start" aria-hidden="true" />
              </Button>
            </SettingRow>
          ))}
        </SettingRows>
      ) : (
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyTitle>{copy.noTiers}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </Section>
  );
}
