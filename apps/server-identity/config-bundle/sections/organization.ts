import { z } from "zod";
import { IdentityName } from "../../../../packages/protocol/identity";
import { ServerSettingsSchema } from "../../../../packages/protocol/server-settings";
import {
  CatalogModelSettings,
  ProviderSettings,
} from "../../../../packages/protocol/service-catalog";
import {
  HostedBuiltinId,
  HostedDefinition,
} from "../../../../packages/protocol/hosted";
import { HostedError } from "../../../server-hosting/manager";
import { IdentityError } from "../../error";
import { modelLabel, modelRefs } from "../refs";
import {
  ConfigConflict,
  lower,
  organizationSection,
  same,
  type OrganizationContext,
} from "../registry";

/** Names must be unique ignoring case, as the console requires. */
export function uniqueBy<T>(key: (item: T) => string) {
  return (items: T[]) =>
    new Set(items.map((item) => lower(key(item)))).size === items.length;
}
/** Org-wide catalog commands carry a workspace only for their shape. */
const orgTarget = (ctx: OrganizationContext) => ({
  organizationId: ctx.organizationId,
  workspaceId: ctx.organizationId,
});

/** Server-wide settings, the same values as `niaro-server-settings`. */
export const serverSettingsSection = organizationSection({
  key: "serverSettings",
  schema: z.strictObject({
    version: z.literal(1),
    settings: ServerSettingsSchema,
  }),
  export: (ctx) =>
    ctx.serverSettings
      ? { version: 1 as const, settings: ctx.serverSettings.read().settings }
      : undefined,
  apply: (ctx, data, outcome) => {
    const store = ctx.serverSettings;
    outcome.item("Server settings", () => {
      if (!store)
        throw new ConfigConflict("refused", "server_settings_unavailable");
      const current = store.read();
      if (same(current.settings, data.settings)) return "unchanged";
      const previous = store.update(current.revision, data.settings);
      ctx.afterCommit(() =>
        ctx.applyServerSettings?.(store.read().settings, previous.settings),
      );
      return "changed";
    });
  },
});

/** AI providers: address and limits; never the key, which stays required. */
const ProviderItem = ProviderSettings.extend({
  /** Always true: a provider's key is entered on the server it runs on. */
  keyRequired: z.literal(true),
});
export const providersSection = organizationSection({
  key: "providers",
  schema: z.strictObject({
    version: z.literal(1),
    items: z
      .array(ProviderItem)
      .max(50)
      .refine(uniqueBy((p: { name: string }) => p.name)),
  }),
  export: (ctx) => ({
    version: 1 as const,
    items: modelRefs(ctx).providers.map((p) => ({
      name: p.name,
      url: p.url,
      enabled: p.enabled,
      dailyRequestLimit: p.dailyRequestLimit,
      keyRequired: true as const,
    })),
  }),
  apply: (ctx, data, outcome) => {
    for (const item of data.items) {
      const { keyRequired: _key, ...settings } = item;
      const done = outcome.item(item.name, () => {
        const existing = modelRefs(ctx).providers.find(
          (p) => lower(p.name) === lower(item.name),
        );
        if (!existing) {
          ctx.catalog.command({
            ...orgTarget(ctx),
            type: "saveProvider",
            revision: 0,
            settings,
          });
          return "added";
        }
        const current = {
          name: existing.name,
          url: existing.url,
          enabled: existing.enabled,
          dailyRequestLimit: existing.dailyRequestLimit,
        };
        if (same(current, settings)) return "unchanged";
        // A stored key must never be sent to an address it was not given for.
        if (existing.hasCredential && existing.url !== settings.url)
          throw new ConfigConflict("address_changed");
        ctx.catalog.command({
          ...orgTarget(ctx),
          type: "saveProvider",
          id: existing.id,
          revision: existing.revision,
          settings,
        });
        return "changed";
      });
      const stored = modelRefs(ctx).providers.find(
        (p) => lower(p.name) === lower(item.name),
      );
      if (done && stored && !stored.hasCredential)
        outcome.needsKey.push(item.name);
    }
  },
});

/** Models by provider name and model id. */
const ModelItem = CatalogModelSettings.omit({ providerId: true }).extend({
  provider: IdentityName,
});
export const modelsSection = organizationSection({
  key: "models",
  schema: z.strictObject({
    version: z.literal(1),
    items: z
      .array(ModelItem)
      .max(500)
      .refine(
        uniqueBy(
          (m: { provider: string; model: string }) =>
            `${m.provider}\n${m.model}`,
        ),
      ),
  }),
  export: (ctx) => {
    const refs = modelRefs(ctx);
    return {
      version: 1 as const,
      items: refs.models.flatMap((model) => {
        const ref = refs.ref(model.id);
        if (!ref) return [];
        const { providerId: _p, id: _id, revision: _r, ...settings } = model;
        return [{ ...settings, provider: ref.provider }];
      }),
    };
  },
  apply: (ctx, data, outcome) => {
    for (const item of data.items) {
      const { provider: providerName, ...rest } = item;
      outcome.item(
        modelLabel({ provider: providerName, model: item.model }),
        () => {
          const refs = modelRefs(ctx);
          const provider = refs.providers.find(
            (p) => lower(p.name) === lower(providerName),
          );
          if (!provider) throw new ConfigConflict("reference_missing");
          const settings = { ...rest, providerId: provider.id };
          const existing = refs.models.find(
            (m) => m.providerId === provider.id && m.model === item.model,
          );
          if (existing) {
            const { id: _id, revision: _r, ...current } = existing;
            if (same(current, settings)) return "unchanged";
          }
          ctx.catalog.command({
            ...orgTarget(ctx),
            type: "saveModel",
            ...(existing ? { id: existing.id } : {}),
            revision: existing?.revision ?? 0,
            settings,
          });
          return existing ? "changed" : "added";
        },
      );
    }
  },
});

/**
 * Installed connectors (hosted MCP servers): the same definitions as their
 * "Export definition", secret names only. An import adds the ones that are
 * missing and starts them after the commit; it never changes or removes one.
 */
const HostedItem = z.strictObject({
  builtin: HostedBuiltinId.optional(),
  definition: HostedDefinition,
});
const hostedName = (item: z.infer<typeof HostedItem>) =>
  item.builtin ?? item.definition.name;
export const hostedSection = organizationSection({
  key: "hosted",
  schema: z.strictObject({
    version: z.literal(1),
    items: z.array(HostedItem).max(20).refine(uniqueBy(hostedName)),
  }),
  export: (ctx) =>
    ctx.hosted
      ? {
          version: 1 as const,
          items: ctx.hosted.list(ctx.organizationId).map((server) => ({
            ...(server.builtin ? { builtin: server.builtin } : {}),
            definition: server.definition,
          })),
        }
      : undefined,
  apply: (ctx, data, outcome) => {
    const hosted = ctx.hosted;
    for (const item of data.items) {
      const name = hostedName(item);
      outcome.item(name, () => {
        if (!hosted) throw new ConfigConflict("refused", "hosted_unavailable");
        const existing = hosted
          .list(ctx.organizationId)
          .find((server) =>
            item.builtin
              ? server.builtin === item.builtin
              : !server.builtin &&
                lower(server.definition.name) === lower(item.definition.name),
          );
        if (existing) {
          if (!same(existing.definition, item.definition))
            throw new ConfigConflict("managed_elsewhere");
          if (existing.secretsSet.length < existing.definition.secrets.length)
            outcome.needsKey.push(name);
          return "unchanged";
        }
        if (
          item.builtin &&
          !hosted.builtins().some((b) => b.id === item.builtin)
        )
          throw new ConfigConflict("refused", "hosted_template_unknown");
        if (!item.builtin && !hosted.allowCustom)
          throw new ConfigConflict("refused", "hosted_custom_disabled");
        if (item.definition.secrets.length) outcome.needsKey.push(name);
        ctx.afterCommit(async () => {
          try {
            const server = item.builtin
              ? await hosted.create(ctx.organizationId, item.builtin)
              : await hosted.createCustom(ctx.organizationId, item.definition);
            ctx.audit({
              organizationId: ctx.organizationId,
              workspaceId: null,
              actorId: ctx.actor.userId,
              source: "console",
              action: "hosted.server_changed",
              targetId: server.id,
              outcome: "succeeded",
              details: {},
            });
          } catch (error) {
            // Reported with the import's result instead of as added.
            const index = outcome.added.indexOf(name);
            if (index >= 0) outcome.added.splice(index, 1);
            outcome.conflict(
              name,
              "refused",
              error instanceof HostedError || error instanceof IdentityError
                ? error.code
                : "hosted_failed",
            );
          }
        });
        return "added";
      });
    }
  },
});
