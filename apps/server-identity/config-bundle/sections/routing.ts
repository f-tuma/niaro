/* eslint-disable @typescript-eslint/no-redeclare -- Each schema deliberately shares its inferred TypeScript type name. */
import { z } from "zod";
import { IdentityName } from "../../../../packages/protocol/identity";
import {
  MAX_MODEL_TIERS,
  MAX_ROLE_MODELS,
  ModelRole,
  OrganizationModelPolicy,
  SelectorOptions,
  SpeechOptions,
  TierId,
  WorkspaceModelPolicy,
  type OrganizationModelPolicyValue,
  type PolicyOptionsValue,
  type RoleRouteValue,
  type WorkspaceModelPolicyValue,
} from "../../../../packages/protocol/model-policy";
import { ModelRef, modelRefs, serviceRefs } from "../refs";
import {
  ConfigConflict,
  lower,
  organizationSection,
  same,
  workspaceSection,
  type OrganizationContext,
} from "../registry";

/**
 * The model policy in a bundle: the same roles, tiers and options the Models
 * page edits, with catalog models named by provider and model instead of ids.
 * The organization's default and each workspace's overrides travel apart,
 * so a workspace imported into another organization keeps only what it
 * changed.
 */
const RefList = z.array(ModelRef).max(MAX_ROLE_MODELS);
const RouteRef = z.strictObject({
  models: RefList,
  tier: TierId.nullable(),
  fallback: z.boolean(),
});
type RouteRef = z.infer<typeof RouteRef>;
const EscalationRef = z.strictObject({
  mode: z.enum(["stop", "escalate"]),
  models: RefList,
  tier: TierId.nullable(),
});
const RolesRef = z.partialRecord(ModelRole, RouteRef);
/** The search backend by name; null is the provider's own search. */
const WebSearchRef = z.strictObject({ backend: IdentityName.nullable() });

const OrganizationPolicySection = z.strictObject({
  version: z.literal(1),
  roles: RolesRef,
  tiers: z
    .array(
      z.strictObject({
        id: TierId,
        name: z.string().trim().min(1).max(40),
        models: RefList.min(1),
      }),
    )
    .max(MAX_MODEL_TIERS),
  options: z.strictObject({
    serverVoice: z.boolean(),
    speech: SpeechOptions,
    selector: SelectorOptions,
    escalation: EscalationRef,
    webSearch: WebSearchRef.optional(),
  }),
});
type OrganizationPolicySection = z.infer<typeof OrganizationPolicySection>;

const WorkspacePolicySection = z.strictObject({
  version: z.literal(2),
  roles: RolesRef,
  services: z
    .array(z.strictObject({ service: IdentityName, route: RouteRef }))
    .max(100),
  options: z.strictObject({
    serverVoice: z.boolean().optional(),
    speech: SpeechOptions.optional(),
    selector: SelectorOptions.optional(),
    escalation: EscalationRef.optional(),
    webSearch: WebSearchRef.optional(),
  }),
});
type WorkspacePolicySection = z.infer<typeof WorkspacePolicySection>;

type Refs = ReturnType<typeof modelRefs>;
/** A model the catalog no longer has drops out of the exported list. */
const toRefs = (refs: Refs, ids: readonly string[]) =>
  ids.flatMap((id) => {
    const ref = refs.ref(id);
    return ref ? [ref] : [];
  });
const toIds = (refs: Refs, list: readonly ModelRef[]) =>
  list.map((ref) => refs.find(ref).model.id);
const routeOut = (refs: Refs, route: RoleRouteValue): RouteRef => ({
  models: toRefs(refs, route.models),
  tier: route.tier,
  fallback: route.fallback,
});
const routeIn = (refs: Refs, route: RouteRef): RoleRouteValue => ({
  models: toIds(refs, route.models),
  tier: route.tier,
  fallback: route.fallback,
});
function rolesOut(refs: Refs, roles: Partial<Record<string, RoleRouteValue>>) {
  const out: z.infer<typeof RolesRef> = {};
  for (const role of ModelRole.options) {
    const route = roles[role];
    if (route) out[role] = routeOut(refs, route);
  }
  return out;
}
function rolesIn(refs: Refs, roles: z.infer<typeof RolesRef>) {
  const out: Partial<Record<z.infer<typeof ModelRole>, RoleRouteValue>> = {};
  for (const role of ModelRole.options) {
    const route = roles[role];
    if (route) out[role] = routeIn(refs, route);
  }
  return out;
}
const escalationOut = (
  refs: Refs,
  value: PolicyOptionsValue["escalation"],
) => ({
  mode: value.mode,
  models: toRefs(refs, value.models),
  tier: value.tier,
});
const escalationIn = (
  refs: Refs,
  value: z.infer<typeof EscalationRef>,
): PolicyOptionsValue["escalation"] => ({
  mode: value.mode,
  models: toIds(refs, value.models),
  tier: value.tier,
});
const webSearchOut = (
  ctx: OrganizationContext,
  value: PolicyOptionsValue["webSearch"],
) => {
  const backend = value.backendId
    ? ctx.catalog
        .searchBackends(ctx.organizationId)
        .find((b) => b.id === value.backendId)
    : undefined;
  return { backend: backend?.name ?? null };
};
const webSearchIn = (
  ctx: OrganizationContext,
  value: z.infer<typeof WebSearchRef>,
): PolicyOptionsValue["webSearch"] => {
  if (!value.backend) return { backendId: null };
  const backend = ctx.catalog
    .searchBackends(ctx.organizationId)
    .find((b) => lower(b.name) === lower(value.backend!));
  if (!backend) throw new ConfigConflict("reference_missing");
  return { backendId: backend.id };
};
/** The organization's stored default; it does not depend on a workspace. */
const organizationPolicy = (ctx: OrganizationContext) =>
  ctx.catalog.modelPolicies(ctx.organizationId, ctx.organizationId)
    .organization;
/** A policy that fails the protocol's own rules is a conflict, not a crash. */
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ConfigConflict("invalid");
  return result.data;
}

/** The organization's default model policy, after the models it names. */
export const modelPolicySection =
  organizationSection<OrganizationPolicySection>({
    key: "modelPolicy",
    schema: OrganizationPolicySection,
    export: (ctx) => {
      const refs = modelRefs(ctx);
      const { policy } = organizationPolicy(ctx);
      return {
        version: 1,
        roles: rolesOut(refs, policy.roles),
        tiers: policy.tiers.map((tier) => ({
          id: tier.id,
          name: tier.name,
          models: toRefs(refs, tier.models),
        })),
        options: {
          serverVoice: policy.options.serverVoice,
          speech: policy.options.speech,
          selector: policy.options.selector,
          escalation: escalationOut(refs, policy.options.escalation),
          webSearch: webSearchOut(ctx, policy.options.webSearch),
        },
      };
    },
    apply: (ctx, data, outcome) => {
      outcome.item("Organization model policy", () => {
        const refs = modelRefs(ctx);
        const current = organizationPolicy(ctx);
        const desired: OrganizationModelPolicyValue = parsed(
          OrganizationModelPolicy,
          {
            roles: rolesIn(refs, data.roles),
            tiers: data.tiers.map((tier) => ({
              id: tier.id,
              name: tier.name,
              models: toIds(refs, tier.models),
            })),
            options: {
              serverVoice: data.options.serverVoice,
              speech: data.options.speech,
              selector: data.options.selector,
              escalation: escalationIn(refs, data.options.escalation),
              webSearch: data.options.webSearch
                ? webSearchIn(ctx, data.options.webSearch)
                : { backendId: null },
            },
          },
        );
        if (same(current.policy, desired)) return "unchanged";
        ctx.catalog.command({
          organizationId: ctx.organizationId,
          workspaceId: ctx.organizationId,
          type: "saveOrganizationModelPolicy",
          revision: current.revision,
          policy: desired,
        });
        return "changed";
      });
    },
  });

/** A workspace's overrides of the organization's model policy. */
export const routingSection = workspaceSection<WorkspacePolicySection>({
  key: "routing",
  schema: WorkspacePolicySection,
  export: (ctx) => {
    const refs = modelRefs(ctx),
      services = serviceRefs(ctx);
    const { policy } = ctx.catalog.modelPolicies(
      ctx.organizationId,
      ctx.workspaceId,
    ).workspace;
    const { escalation, webSearch, ...options } = policy.options;
    return {
      version: 2,
      roles: rolesOut(refs, policy.roles),
      // A member's own service has no shared model choice.
      services: policy.services.flatMap((entry) => {
        const service = services.services.find((s) => s.id === entry.serviceId);
        return service
          ? [{ service: service.name, route: routeOut(refs, entry.route) }]
          : [];
      }),
      options: {
        ...options,
        ...(escalation ? { escalation: escalationOut(refs, escalation) } : {}),
        ...(webSearch ? { webSearch: webSearchOut(ctx, webSearch) } : {}),
      },
    };
  },
  apply: (ctx, data, outcome) => {
    outcome.item("Workspace model policy", () => {
      const refs = modelRefs(ctx),
        services = serviceRefs(ctx);
      const current = ctx.catalog.modelPolicies(
        ctx.organizationId,
        ctx.workspaceId,
      ).workspace;
      const { escalation, webSearch, ...options } = data.options;
      const desired: WorkspaceModelPolicyValue = parsed(WorkspaceModelPolicy, {
        roles: rolesIn(refs, data.roles),
        services: data.services.map((entry) => ({
          serviceId: services.find(entry.service).id,
          route: routeIn(refs, entry.route),
        })),
        options: {
          ...options,
          ...(escalation ? { escalation: escalationIn(refs, escalation) } : {}),
          ...(webSearch ? { webSearch: webSearchIn(ctx, webSearch) } : {}),
        },
      });
      if (same(current.policy, desired)) return "unchanged";
      ctx.catalog.command({
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        type: "saveWorkspaceModelPolicy",
        revision: current.revision,
        policy: desired,
      });
      return "changed";
    });
  },
});
