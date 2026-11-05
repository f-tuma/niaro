/* eslint-disable @typescript-eslint/no-redeclare -- Each schema deliberately shares its inferred TypeScript type name. */
import { z } from "zod";
import { IdentityName } from "../../../packages/protocol/identity";
import {
  ConfigConflict,
  lower,
  type OrganizationContext,
  type WorkspaceContext,
} from "./registry";

/**
 * A bundle never carries this server's ids: a model is named by its provider
 * and model, a service and its actions by their names, a workspace role by
 * its name. These read the current state each time, so a section sees what
 * the sections before it added in the same import.
 */
export const ModelRef = z.strictObject({
  provider: IdentityName,
  model: z.string().trim().min(1).max(200),
});
export type ModelRef = z.infer<typeof ModelRef>;
export const modelLabel = (ref: ModelRef) => `${ref.provider} / ${ref.model}`;

export function modelRefs(ctx: OrganizationContext) {
  const { providers, models } = ctx.catalog.organizationModels(
    ctx.organizationId,
  );
  const providerOf = (id: string) => providers.find((p) => p.id === id);
  return {
    providers,
    models,
    ref(id: string | null): ModelRef | null {
      if (!id) return null;
      const model = models.find((m) => m.id === id);
      const provider = model && providerOf(model.providerId);
      return model && provider
        ? { provider: provider.name, model: model.model }
        : null;
    },
    /** Throws `reference_missing` when the model is not here. */
    id(ref: ModelRef | null): string | null {
      if (!ref) return null;
      return this.find(ref).model.id;
    },
    find(ref: ModelRef) {
      const provider = providers.find(
        (p) => lower(p.name) === lower(ref.provider),
      );
      const model =
        provider &&
        models.find(
          (m) => m.providerId === provider.id && m.model === ref.model,
        );
      if (!provider || !model) throw new ConfigConflict("reference_missing");
      return { provider, model };
    },
  };
}

/** Shared services of a workspace; a member's own services never take part. */
export function serviceRefs(ctx: WorkspaceContext) {
  const services = ctx.catalog
    .workspaceServices(ctx.workspaceId)
    .filter((service) => !service.personal);
  return {
    services,
    name(id: string) {
      const service = services.find((s) => s.id === id);
      if (!service) throw new ConfigConflict("reference_missing");
      return service.name;
    },
    find(name: string) {
      const service = services.find((s) => lower(s.name) === lower(name));
      if (!service) throw new ConfigConflict("reference_missing");
      return service;
    },
    actionName(serviceId: string, actionId: string) {
      const action = services
        .find((s) => s.id === serviceId)
        ?.actions.find((a) => a.id === actionId);
      if (!action) throw new ConfigConflict("reference_missing");
      return action.name;
    },
    action(serviceName: string, actionName: string) {
      const service = this.find(serviceName);
      const action = service.actions.find(
        (a) => lower(a.name) === lower(actionName),
      );
      if (!action) throw new ConfigConflict("reference_missing");
      return { service, action };
    },
  };
}

export function roleRefs(ctx: WorkspaceContext) {
  const roles = ctx.catalog.workspaceRoles.list(ctx.workspaceId);
  return {
    roles,
    names(ids: readonly string[] | undefined) {
      return (ids ?? []).flatMap((id) => {
        const role = roles.find((r) => r.id === id);
        return role ? [role.name] : [];
      });
    },
    ids(names: readonly string[]) {
      return names.map((name) => {
        const role = roles.find((r) => lower(r.name) === lower(name));
        if (!role) throw new ConfigConflict("reference_missing");
        return role.id;
      });
    },
  };
}
