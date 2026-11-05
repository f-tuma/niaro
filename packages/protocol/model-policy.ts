import { z } from "zod";
import { IdentityId } from "./identity";

/**
 * The jobs Niaro does with models. Each maps to an ordered list of catalog
 * models (the first is the primary) or to a named tier. `service:<id>`
 * overrides live in a workspace's `services` list. `embedding` and `vision`
 * are reserved: they can be configured but nothing uses them yet.
 */
export const MODEL_ROLES = [
  "chat",
  "checker",
  "selector",
  "background",
  "designer",
  "web_search",
  "voice_input",
  "meeting_transcription",
  "speech",
  "embedding",
  "vision",
] as const;
export const ModelRole = z.enum(MODEL_ROLES);
export type ModelRoleValue = z.infer<typeof ModelRole>;
export const RESERVED_MODEL_ROLES: readonly ModelRoleValue[] = [
  "embedding",
  "vision",
];
/** Roles whose calls go through the inference ledger and need prices in enforce mode. */
export const BUDGETED_MODEL_ROLES: readonly ModelRoleValue[] = [
  "chat",
  "checker",
  "selector",
  "background",
  "designer",
  "web_search",
];
/**
 * A role nobody configured follows another one: background work, process
 * design and web search use the chat models, the checker uses the selector.
 */
export const ROLE_DEFAULTS: Partial<Record<ModelRoleValue, ModelRoleValue>> = {
  background: "chat",
  designer: "chat",
  web_search: "chat",
  checker: "selector",
};
export const MAX_ROLE_MODELS = 8;
export const MAX_MODEL_TIERS = 8;
export const TierId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const unique = (ids: string[]) => new Set(ids).size === ids.length;
export const ModelList = z
  .array(IdentityId)
  .max(MAX_ROLE_MODELS)
  .refine(unique, "A model appears once in a list");
/**
 * Where a role's models come from: its own ordered list, or a tier. An
 * empty list without a tier turns the role off. `fallback` lets a call move
 * to the next model only when the earlier one provably never reached its
 * provider.
 */
export const RoleRoute = z
  .strictObject({
    models: ModelList.default([]),
    tier: TierId.nullable().default(null),
    fallback: z.boolean().default(false),
  })
  .refine(
    (route) => !(route.tier && route.models.length),
    "Choose a tier or models, not both",
  );
export type RoleRouteValue = z.infer<typeof RoleRoute>;
export const ModelTier = z.strictObject({
  id: TierId,
  name: z.string().trim().min(1).max(40),
  models: ModelList.min(1),
});
export type ModelTierValue = z.infer<typeof ModelTier>;
export const SpeechVoiceId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9._:/-]+$/);
export const SpeechOptions = z.strictObject({
  /** Null: the first voice listed on the speech model. */
  voice: SpeechVoiceId.nullable().default(null),
  zeroDataRetention: z.boolean().default(true),
});
export const SelectorOptions = z.strictObject({
  /** Certainty the selector and the checker need before their answer counts. */
  minConfidence: z.number().min(0.5).max(1).default(0.8),
});
/**
 * What happens when the write checker or the answer checker rejects a step:
 * stop (the chat model handles the rejection, as before) or repeat that
 * step once with the escalation models.
 */
export const EscalationOptions = z
  .strictObject({
    mode: z.enum(["stop", "escalate"]).default("stop"),
    models: ModelList.default([]),
    tier: TierId.nullable().default(null),
  })
  .refine(
    (value) => !(value.tier && value.models.length),
    "Choose a tier or models, not both",
  )
  .refine(
    (value) => value.mode === "stop" || !!value.tier || value.models.length > 0,
    "Escalation needs a tier or models",
  );
/**
 * Where web searches go: a search backend of the organization, or (null)
 * the provider's own search with the web search role's models.
 */
export const WebSearchOptions = z.strictObject({
  backendId: IdentityId.nullable().default(null),
});
export const PolicyOptions = z.strictObject({
  /** Use the server's own speech recognition when voice input has no models. */
  serverVoice: z.boolean().default(true),
  speech: SpeechOptions.default({ voice: null, zeroDataRetention: true }),
  selector: SelectorOptions.default({ minConfidence: 0.8 }),
  escalation: EscalationOptions.default({
    mode: "stop",
    models: [],
    tier: null,
  }),
  webSearch: WebSearchOptions.default({ backendId: null }),
});
export type PolicyOptionsValue = z.infer<typeof PolicyOptions>;
const roleRecord = z.partialRecord(ModelRole, RoleRoute).default({});
/** The organization's default policy: every workspace inherits it. */
export const OrganizationModelPolicy = z
  .strictObject({
    roles: roleRecord,
    tiers: z.array(ModelTier).max(MAX_MODEL_TIERS).default([]),
    options: PolicyOptions.default({
      serverVoice: true,
      speech: { voice: null, zeroDataRetention: true },
      selector: { minConfidence: 0.8 },
      escalation: { mode: "stop", models: [], tier: null },
      webSearch: { backendId: null },
    }),
  })
  .refine(
    (policy) => unique(policy.tiers.map((tier) => tier.id)),
    "A tier ID appears once",
  );
export type OrganizationModelPolicyValue = z.infer<
  typeof OrganizationModelPolicy
>;
/** A workspace's overrides: a role or option it leaves out is inherited. */
export const WorkspaceModelPolicy = z
  .strictObject({
    roles: roleRecord,
    services: z
      .array(z.strictObject({ serviceId: IdentityId, route: RoleRoute }))
      .max(100)
      .default([]),
    options: z
      .strictObject({
        serverVoice: z.boolean().optional(),
        speech: SpeechOptions.optional(),
        selector: SelectorOptions.optional(),
        escalation: EscalationOptions.optional(),
        webSearch: WebSearchOptions.optional(),
      })
      .default({}),
  })
  .refine(
    (policy) => unique(policy.services.map((service) => service.serviceId)),
    "A service appears once",
  );
export type WorkspaceModelPolicyValue = z.infer<typeof WorkspaceModelPolicy>;
export const PolicySource = z.enum([
  "workspace",
  "organization",
  "inherited",
  "none",
]);
/** One role as it applies to the workspace, after inheritance and tiers. */
export const EffectiveRoute = z.strictObject({
  models: z.array(IdentityId).max(MAX_ROLE_MODELS),
  fallback: z.boolean(),
  tier: TierId.nullable(),
  /** Set by the workspace, the organization, followed from another role, or nowhere. */
  source: PolicySource,
  /** The role it follows when its source is `inherited`. */
  via: ModelRole.nullable(),
});
export type EffectiveRouteValue = z.infer<typeof EffectiveRoute>;
export const ModelPolicyView = z.strictObject({
  organization: z.strictObject({
    revision: z.number().int().nonnegative(),
    policy: OrganizationModelPolicy,
  }),
  workspace: z.strictObject({
    revision: z.number().int().nonnegative(),
    policy: WorkspaceModelPolicy,
  }),
  effective: z.strictObject({
    roles: z.partialRecord(ModelRole, EffectiveRoute),
    services: z
      .array(z.strictObject({ serviceId: IdentityId, route: EffectiveRoute }))
      .max(100),
    /** The models a checker rejection repeats its step with; none when escalation is off. */
    escalation: EffectiveRoute,
    options: PolicyOptions,
  }),
});
export type ModelPolicyViewValue = z.infer<typeof ModelPolicyView>;
/**
 * The models budgeted calls may reach in a workspace, with the routes that
 * reach each: the first model of every budgeted role and service route, the
 * others only where fallback is on, and the escalation models when
 * escalation is on. In enforce mode each of them needs a price.
 */
export function budgetedReach(effective: ModelPolicyViewValue["effective"]) {
  const reach = new Map<string, string[]>();
  const add = (key: string, route: EffectiveRouteValue | undefined) => {
    if (!route) return;
    for (const id of route.fallback ? route.models : route.models.slice(0, 1))
      reach.set(id, [...(reach.get(id) ?? []), key]);
  };
  // Searches sent to a search backend use no model.
  for (const role of BUDGETED_MODEL_ROLES)
    if (role !== "web_search" || !effective.options.webSearch.backendId)
      add(role, effective.roles[role]);
  for (const service of effective.services)
    add(`service:${service.serviceId}`, service.route);
  add("escalation", effective.escalation);
  return reach;
}

/**
 * The model policy, resolved without storage: which catalog models serve a
 * role in a workspace after the workspace's overrides, the organization's
 * default, tiers and the role defaults. Pure and synchronous.
 */
export type StoredModelPolicies = {
  organization: { revision: number; policy: OrganizationModelPolicyValue };
  workspace: { revision: number; policy: WorkspaceModelPolicyValue };
};
/** `service:<id>` and `escalation` are routes too, beside the roles. */
export type RouteKey = ModelRoleValue | `service:${string}` | "escalation";

export const emptyOrganizationPolicy = () => OrganizationModelPolicy.parse({});
export const emptyWorkspacePolicy = () => WorkspaceModelPolicy.parse({});

function routeModels(
  route: { models: string[]; tier: string | null },
  tiers: ModelTierValue[],
) {
  return route.tier
    ? [...(tiers.find((tier) => tier.id === route.tier)?.models ?? [])]
    : [...route.models];
}
const none = (): EffectiveRouteValue => ({
  models: [],
  fallback: false,
  tier: null,
  source: "none",
  via: null,
});
function own(
  route: RoleRouteValue,
  tiers: ModelTierValue[],
  source: "workspace" | "organization",
): EffectiveRouteValue {
  return {
    models: routeModels(route, tiers),
    fallback: route.fallback,
    tier: route.tier,
    source,
    via: null,
  };
}
export function effectiveRole(
  policies: StoredModelPolicies,
  role: ModelRoleValue,
  seen: ModelRoleValue[] = [],
): EffectiveRouteValue {
  const { organization, workspace } = policies;
  const tiers = organization.policy.tiers;
  const local = workspace.policy.roles[role];
  if (local) return own(local, tiers, "workspace");
  const shared = organization.policy.roles[role];
  if (shared) return own(shared, tiers, "organization");
  const follows = ROLE_DEFAULTS[role];
  if (!follows || seen.includes(follows)) return none();
  const followed = effectiveRole(policies, follows, [...seen, role]);
  return followed.source === "none"
    ? none()
    : { ...followed, source: "inherited", via: follows };
}
export function effectiveOptions(
  policies: StoredModelPolicies,
): PolicyOptionsValue {
  const base = policies.organization.policy.options;
  const local = policies.workspace.policy.options;
  return PolicyOptions.parse({
    serverVoice: local.serverVoice ?? base.serverVoice,
    speech: local.speech ?? base.speech,
    selector: local.selector ?? base.selector,
    escalation: local.escalation ?? base.escalation,
    webSearch: local.webSearch ?? base.webSearch,
  });
}
export function effectiveRoute(
  policies: StoredModelPolicies,
  key: RouteKey,
): EffectiveRouteValue {
  if (key === "escalation") {
    const escalation = effectiveOptions(policies).escalation;
    if (escalation.mode !== "escalate") return none();
    return {
      models: routeModels(escalation, policies.organization.policy.tiers),
      // The stronger models move on like the chat models do.
      fallback: effectiveRole(policies, "chat").fallback,
      tier: escalation.tier,
      source: policies.workspace.policy.options.escalation
        ? "workspace"
        : "organization",
      via: null,
    };
  }
  if (key.startsWith("service:")) {
    const serviceId = key.slice("service:".length);
    const local = policies.workspace.policy.services.find(
      (service) => service.serviceId === serviceId,
    );
    if (local)
      return own(local.route, policies.organization.policy.tiers, "workspace");
    const chat = effectiveRole(policies, "chat");
    return chat.source === "none"
      ? none()
      : { ...chat, source: "inherited", via: "chat" };
  }
  return effectiveRole(policies, key as ModelRoleValue);
}
export function policyView(
  policies: StoredModelPolicies,
  serviceIds: string[],
): ModelPolicyViewValue {
  return {
    organization: policies.organization,
    workspace: policies.workspace,
    effective: {
      roles: Object.fromEntries(
        MODEL_ROLES.map((role) => [role, effectiveRole(policies, role)]),
      ),
      services: serviceIds.map((serviceId) => ({
        serviceId,
        route: effectiveRoute(policies, `service:${serviceId}`),
      })),
      escalation: effectiveRoute(policies, "escalation"),
      options: effectiveOptions(policies),
    },
  };
}
