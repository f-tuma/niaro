import { z } from "zod";
import { IdentityId } from "../../packages/protocol/identity";
import {
  emptyOrganizationPolicy,
  OrganizationModelPolicy,
  PolicyOptions,
  WorkspaceModelPolicy,
  type ModelRoleValue,
  type OrganizationModelPolicyValue,
  type PolicyOptionsValue,
  type RoleRouteValue,
  type WorkspaceModelPolicyValue,
} from "../../packages/protocol/model-policy";
import { RequestNotSent } from "../server-integrations/integration-error";
import { IdentityError } from "./error";

export {
  effectiveOptions,
  effectiveRole,
  effectiveRoute,
  emptyOrganizationPolicy,
  emptyWorkspacePolicy,
  policyView,
  type RouteKey,
  type StoredModelPolicies,
} from "../../packages/protocol/model-policy";

type PolicyLike = {
  roles?: Partial<Record<ModelRoleValue, RoleRouteValue>>;
  services?: { route: { models: string[]; tier: string | null } }[];
  tiers?: { models: string[] }[];
  options?: { escalation?: { models: string[]; tier: string | null } };
};
/** Every model a policy names: its roles, services, tiers and escalation. */
export function referencedModels(policy: PolicyLike) {
  const ids = new Set<string>();
  for (const route of Object.values(policy.roles ?? {}))
    for (const id of route?.models ?? []) ids.add(id);
  for (const service of policy.services ?? [])
    for (const id of service.route.models) ids.add(id);
  for (const tier of policy.tiers ?? [])
    for (const id of tier.models) ids.add(id);
  for (const id of policy.options?.escalation?.models ?? []) ids.add(id);
  return ids;
}
/** Tiers a policy points to. */
export function referencedTiers(policy: PolicyLike) {
  const ids = new Set<string>();
  for (const route of Object.values(policy.roles ?? {}))
    if (route?.tier) ids.add(route.tier);
  for (const service of policy.services ?? [])
    if (service.route.tier) ids.add(service.route.tier);
  if (policy.options?.escalation?.tier) ids.add(policy.options.escalation.tier);
  return ids;
}
/**
 * Whether a failed call provably never reached its provider, and why: the
 * provider's daily limit refused it before dispatch, or the connection
 * failed before a byte of the request left. Nothing else may fall back.
 */
export function notDispatchedCause(error: unknown) {
  if (error instanceof IdentityError && error.code === "catalog_provider_limit")
    return "provider_limit";
  if (error instanceof RequestNotSent && error.notSent)
    return "connection_failed";
  return undefined;
}

/** The single per-workspace model choice before NIAR-293. */
const LegacyRouting = z.object({
  modelId: IdentityId.nullable().default(null),
  voiceModelId: IdentityId.nullable().default(null),
  voiceMode: z.enum(["legacy", "disabled", "catalog"]).default("legacy"),
  meetingTranscriptionModelId: IdentityId.nullable().default(null),
  speech: z
    .object({
      modelId: IdentityId.nullable().default(null),
      zeroDataRetention: z.boolean().default(true),
      voice: z.string().default("alloy"),
    })
    .default({ modelId: null, zeroDataRetention: true, voice: "alloy" }),
  decision: z
    .object({
      enabled: z.boolean().default(false),
      modelId: IdentityId.nullable().default(null),
      minConfidence: z.number().min(0.5).max(1).default(0.8),
    })
    .default({ enabled: false, modelId: null, minConfidence: 0.8 }),
  services: z
    .array(z.object({ serviceId: IdentityId, modelId: IdentityId.nullable() }))
    .max(100)
    .default([]),
});
export function isLegacyRouting(data: unknown) {
  return (
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    !("roles" in data)
  );
}
const list = (id: string | null) => ({
  models: id ? [id] : [],
  tier: null,
  fallback: false,
});
/**
 * One stored routing of the old shape as a workspace policy that sets every
 * role it used to decide, so the workspace behaves as before. The planner
 * and the voice and speech methods are gone: a method follows the model's
 * kind now.
 */
export function workspacePolicyFromLegacy(
  data: unknown,
): WorkspaceModelPolicyValue {
  const old = LegacyRouting.parse(data);
  const voice = old.speech.voice.trim();
  return WorkspaceModelPolicy.parse({
    roles: {
      chat: list(old.modelId),
      voice_input: list(old.voiceMode === "catalog" ? old.voiceModelId : null),
      meeting_transcription: list(old.meetingTranscriptionModelId),
      speech: list(old.speech.modelId),
      selector: list(old.decision.enabled ? old.decision.modelId : null),
    },
    services: old.services.flatMap((service) =>
      service.modelId
        ? [{ serviceId: service.serviceId, route: list(service.modelId) }]
        : [],
    ),
    options: {
      serverVoice: old.voiceMode === "legacy",
      speech: {
        voice: /^[a-zA-Z0-9._:/-]{1,200}$/.test(voice) ? voice : null,
        zeroDataRetention: old.speech.zeroDataRetention,
      },
      selector: { minConfidence: old.decision.minConfidence },
    },
  });
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/**
 * The organization default seeded from its first migrated workspace, and
 * each workspace reduced to what differs from it. Web search stays per
 * workspace: it came from each workspace's own web settings.
 */
export function seedOrganizationPolicy(
  workspaces: WorkspaceModelPolicyValue[],
): {
  organization: OrganizationModelPolicyValue;
  workspaces: WorkspaceModelPolicyValue[];
} {
  const first = workspaces[0];
  if (!first)
    return { organization: emptyOrganizationPolicy(), workspaces: [] };
  const { web_search: _web, ...roles } = first.roles;
  const organization = OrganizationModelPolicy.parse({
    roles,
    options: PolicyOptions.parse(first.options),
  });
  return {
    organization,
    workspaces: workspaces.map((workspace) =>
      WorkspaceModelPolicy.parse({
        roles: Object.fromEntries(
          Object.entries(workspace.roles).filter(
            ([role, route]) =>
              !same(organization.roles[role as ModelRoleValue] ?? null, route),
          ),
        ),
        services: workspace.services,
        options: Object.fromEntries(
          Object.entries(workspace.options).filter(
            ([key, value]) =>
              value !== undefined &&
              !same(
                organization.options[key as keyof PolicyOptionsValue],
                value,
              ),
          ),
        ),
      }),
    ),
  };
}
