/* eslint-disable @typescript-eslint/no-redeclare -- Each schema deliberately shares its inferred TypeScript type name. */
import { z } from "zod";
import {
  IdentityName,
  OrganizationRole,
} from "../../../../packages/protocol/identity";
import { InferenceBudgetSettingsSchema } from "../../../../packages/protocol/inference-budget";
import {
  ActionSettings,
  PersonalServicesManagement,
  PersonalServicesPolicy,
  ServiceSettings,
} from "../../../../packages/protocol/service-catalog";
import {
  SKILLS_PROFILE,
  SkillContentSchema,
} from "../../../../packages/protocol/skills";
import { PluginPreferencesSchema } from "../../../../packages/protocol/workspace-plugins";
import {
  modelLabel,
  ModelRef,
  modelRefs,
  roleRefs,
  serviceRefs,
} from "../refs";
import {
  ConfigConflict,
  lower,
  same,
  workspaceSection,
  type WorkspaceContext,
} from "../registry";
import { uniqueBy } from "./organization";

/** Workspace roles by name. An import adds missing roles without members. */
export const rolesSection = workspaceSection({
  key: "roles",
  schema: z.strictObject({
    version: z.literal(1),
    items: z
      .array(z.strictObject({ name: IdentityName }))
      .max(50)
      .refine(uniqueBy((r: { name: string }) => r.name)),
  }),
  export: (ctx) => ({
    version: 1 as const,
    items: roleRefs(ctx).roles.map((role) => ({ name: role.name })),
  }),
  apply: (ctx, data, outcome) => {
    for (const item of data.items)
      outcome.item(item.name, () => {
        if (roleRefs(ctx).roles.some((r) => lower(r.name) === lower(item.name)))
          return "unchanged";
        ctx.catalog.workspaceRoles.save(ctx.workspaceId, {
          revision: 0,
          name: item.name,
          memberIds: [],
        });
        return "added";
      });
  },
});

/**
 * Shared services and their actions, with grants by organization role and
 * workspace role name. Never a key or a sign-in, never a member's own
 * service and never a grant to one person: those stay on each server.
 */
const RoleGrant = z.strictObject({
  roles: z.array(OrganizationRole).max(3),
  workspaceRoles: z.array(IdentityName).max(50),
});
const ActionItem = ActionSettings.omit({ policy: true }).extend({
  policy: RoleGrant,
  sourceKey: z.string().max(1200).nullable(),
});
const ServiceItem = ServiceSettings.omit({ personal: true, access: true })
  .extend({
    access: RoleGrant.optional(),
    /** A key (or token) must be entered here before it works. */
    keyRequired: z.boolean(),
    actions: z.array(ActionItem).max(1000),
  })
  .refine((item) => item.keyRequired === (item.auth.type !== "none"));
type ServiceItem = z.infer<typeof ServiceItem>;
const ServicesSchema = z.strictObject({
  version: z.literal(1),
  personalServices: PersonalServicesPolicy,
  personalManagement: PersonalServicesManagement,
  items: z
    .array(ServiceItem)
    .max(100)
    .refine(uniqueBy((s: { name: string }) => s.name)),
});
const actionLabel = (service: string, action: string) =>
  `${service} / ${action}`;

function applyService(
  ctx: WorkspaceContext,
  item: ServiceItem,
  outcome: Parameters<typeof servicesSection.apply>[2],
) {
  const roles = roleRefs(ctx);
  const done = outcome.item(item.name, () => {
    const existing = serviceRefs(ctx).services.find(
      (s) => lower(s.name) === lower(item.name),
    );
    const settings = {
      name: item.name,
      ...(item.description !== undefined
        ? { description: item.description }
        : {}),
      url: item.url,
      protocol: item.protocol,
      icon: item.icon,
      iconSource: item.iconSource,
      auth: item.auth,
      enabled: item.enabled,
      ...(item.access
        ? {
            access: {
              roles: item.access.roles,
              workspaceRoles: roles.ids(item.access.workspaceRoles),
            },
          }
        : {}),
    };
    if (!existing) {
      ctx.catalog.saveImportedService(ctx.workspaceId, undefined, 0, settings);
      return "added";
    }
    const current = {
      name: existing.name,
      description: existing.description,
      url: existing.url,
      protocol: existing.protocol,
      icon: existing.icon,
      iconSource: existing.iconSource,
      auth: existing.auth,
      enabled: existing.enabled,
      access: existing.access,
    };
    // Left out, the access stays as it is, as in the console.
    const desired = { ...settings, access: settings.access ?? existing.access };
    if (same(current, desired)) return "unchanged";
    // The stored key or sign-in must never go to an address it was not given for.
    if (existing.hasCredential && existing.url !== item.url)
      throw new ConfigConflict("address_changed");
    ctx.catalog.saveImportedService(
      ctx.workspaceId,
      existing.id,
      existing.revision,
      desired,
    );
    return "changed";
  });
  if (!done) return;
  for (const action of item.actions)
    outcome.item(actionLabel(item.name, action.name), () => {
      const service = serviceRefs(ctx).find(item.name);
      const existing =
        (action.sourceKey &&
          service.actions.find((a) => a.sourceKey === action.sourceKey)) ||
        service.actions.find((a) => lower(a.name) === lower(action.name));
      const { sourceKey, policy, ...rest } = action;
      const settings = {
        ...rest,
        policy: {
          roles: policy.roles,
          workspaceRoles: roles.ids(policy.workspaceRoles),
          // Grants to one person stay as they are here.
          users: existing?.policy.users ?? [],
        },
      };
      if (existing) {
        const { id: _id, revision: _r, sourceKey: _s, ...current } = existing;
        if (
          same(
            {
              ...current,
              policy: {
                ...current.policy,
                workspaceRoles: current.policy.workspaceRoles ?? [],
              },
            },
            settings,
          )
        )
          return "unchanged";
      }
      ctx.catalog.saveImportedAction(ctx.organizationId, ctx.workspaceId, {
        serviceId: service.id,
        serviceRevision: service.revision,
        ...(existing ? { id: existing.id } : {}),
        revision: existing?.revision ?? 0,
        settings,
        sourceKey,
      });
      return existing ? "changed" : "added";
    });
  const stored = serviceRefs(ctx).services.find(
    (s) => lower(s.name) === lower(item.name),
  );
  if (stored && stored.auth.type !== "none" && !stored.hasCredential)
    outcome.needsKey.push(item.name);
}

export const servicesSection = workspaceSection({
  key: "services",
  schema: ServicesSchema,
  export: (ctx) => {
    const roles = roleRefs(ctx);
    return {
      version: 1 as const,
      personalServices: ctx.catalog.personalServicesPolicy(ctx.workspaceId),
      personalManagement: ctx.catalog.personalManagement(ctx.workspaceId),
      items: serviceRefs(ctx).services.map((service) => ({
        name: service.name,
        ...(service.description !== undefined
          ? { description: service.description }
          : {}),
        url: service.url,
        protocol: service.protocol,
        icon: service.icon,
        iconSource: service.iconSource,
        auth: service.auth,
        enabled: service.enabled,
        ...(service.access
          ? {
              access: {
                roles: service.access.roles,
                workspaceRoles: roles.names(service.access.workspaceRoles),
              },
            }
          : {}),
        keyRequired: service.auth.type !== "none",
        actions: service.actions.map((action) => ({
          name: action.name,
          description: action.description,
          inputSchema: action.inputSchema,
          binding: action.binding,
          effect: action.effect,
          approval: action.approval,
          enabled: action.enabled,
          policy: {
            roles: action.policy.roles,
            workspaceRoles: roles.names(action.policy.workspaceRoles),
          },
          sourceKey: action.sourceKey,
        })),
      })),
    };
  },
  apply: (ctx, data, outcome) => {
    outcome.item("Members' own services", () => {
      if (
        ctx.catalog.personalServicesPolicy(ctx.workspaceId) ===
          data.personalServices &&
        ctx.catalog.personalManagement(ctx.workspaceId) ===
          data.personalManagement
      )
        return "unchanged";
      ctx.catalog.command({
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
        type: "savePersonalServicesPolicy",
        policy: data.personalServices,
        management: data.personalManagement,
      });
      return "changed";
    });
    for (const item of data.items) applyService(ctx, item, outcome);
  },
});

/** Usage limits with model prices, models named by provider and model. */
const PriceItem = InferenceBudgetSettingsSchema.shape.prices.element
  .omit({ modelId: true, modelRevision: true, providerRevision: true })
  .extend({ model: ModelRef });
export const usageSection = workspaceSection({
  key: "usage",
  schema: InferenceBudgetSettingsSchema.omit({ prices: true }).extend({
    version: z.literal(1),
    prices: z
      .array(PriceItem)
      .max(500)
      .refine(uniqueBy((p: { model: ModelRef }) => modelLabel(p.model))),
  }),
  export: (ctx) => {
    // Only the saved prices; a free provider's zero prices come with it.
    const { settings } = ctx.catalog.inferenceBudget.storedPolicy(
      ctx.organizationId,
      ctx.workspaceId,
    );
    const models = modelRefs(ctx);
    return {
      version: 1 as const,
      mode: settings.mode,
      maxTokens: settings.maxTokens,
      maxCostMicros: settings.maxCostMicros,
      prices: settings.prices.flatMap(
        ({ modelId, modelRevision: _m, providerRevision: _p, ...price }) => {
          const model = models.ref(modelId);
          return model ? [{ ...price, model }] : [];
        },
      ),
    };
  },
  apply: (ctx, data, outcome) => {
    const models = modelRefs(ctx);
    // A price is pinned to the model's and provider's current revisions.
    const prices = data.prices.flatMap(({ model: ref, ...price }) => {
      try {
        const { model, provider } = models.find(ref);
        if (!["chat", "router", "decision"].includes(model.kind))
          throw new ConfigConflict("refused", "catalog_model_unavailable");
        return [
          {
            ...price,
            modelId: model.id,
            modelRevision: model.revision,
            providerRevision: provider.revision,
          },
        ];
      } catch (error) {
        if (!(error instanceof ConfigConflict)) throw error;
        outcome.conflict(modelLabel(ref), error.reason, error.code);
        return [];
      }
    });
    outcome.item("Usage limits", () => {
      const current = ctx.catalog.inferenceBudget.storedPolicy(
        ctx.organizationId,
        ctx.workspaceId,
      );
      const { version: _v, ...rest } = data;
      const settings = { ...rest, prices };
      const order = (values: typeof prices) =>
        [...values].sort((a, b) => (a.modelId < b.modelId ? -1 : 1));
      if (
        same(
          { ...current.settings, prices: order(current.settings.prices) },
          { ...settings, prices: order(settings.prices) },
        )
      )
        return "unchanged";
      ctx.catalog.inferenceBudget.savePolicy(
        ctx.organizationId,
        ctx.workspaceId,
        current.revision,
        settings,
      );
      return "changed";
    });
  },
});

/** Plugin settings of the workspace; null follows the server's settings. */
export const pluginsSection = workspaceSection({
  key: "plugins",
  schema: z.strictObject({
    version: z.literal(1),
    settings: PluginPreferencesSchema.nullable(),
  }),
  export: (ctx) => {
    const current = ctx.plugins.read(ctx.workspaceId);
    return {
      version: 1 as const,
      settings: current.source === "server" ? null : current.settings,
    };
  },
  apply: (ctx, data, outcome) => {
    outcome.item("Plugin settings", () => {
      const current = ctx.plugins.read(ctx.workspaceId);
      if (
        same(
          current.source === "server" ? null : current.settings,
          data.settings,
        )
      )
        return "unchanged";
      ctx.plugins.update(ctx.workspaceId, current.revision, data.settings);
      return "changed";
    });
  },
});

/** Company skills with their files; personal skills stay with their owners. */
const SkillItem = z.strictObject({
  ...SkillContentSchema.shape,
  enabled: z.boolean(),
});
export const skillsSection = workspaceSection({
  key: "skills",
  schema: z.strictObject({
    version: z.literal(1),
    items: z
      .array(SkillItem)
      .max(200)
      .refine(uniqueBy((s: { name: string }) => s.name)),
  }),
  export: (ctx) => {
    const actor = ctx.workspaceActor;
    return {
      version: 1 as const,
      items: ctx.skills.list(actor).workspace.map((summary) => {
        const skill = ctx.skills.get(actor, summary.id);
        return {
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
          files: skill.files,
          enabled: skill.enabled,
        };
      }),
    };
  },
  apply: (ctx, data, outcome) => {
    const actor = ctx.workspaceActor;
    for (const item of data.items)
      outcome.item(item.name, () => {
        const { enabled, ...raw } = item;
        const content = SkillContentSchema.parse(raw);
        const summary = ctx.skills
          .list(actor)
          .workspace.find((s) => lower(s.name) === lower(item.name));
        if (summary) {
          const skill = ctx.skills.get(actor, summary.id);
          if (
            same(
              {
                name: skill.name,
                description: skill.description,
                instructions: skill.instructions,
                files: skill.files,
                enabled: skill.enabled,
              },
              { ...content, enabled },
            )
          )
            return "unchanged";
        }
        ctx.skills.command(actor, {
          profile: SKILLS_PROFILE,
          type: "save",
          ...(summary ? { id: summary.id } : { owner: "workspace" }),
          revision: summary?.revision ?? 0,
          content,
          enabled,
        });
        return summary ? "changed" : "added";
      });
  },
});
