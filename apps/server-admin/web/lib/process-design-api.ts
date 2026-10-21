import { z } from "zod";
import { CatalogTarget } from "../../../../packages/protocol/service-catalog";
import {
  WORKSPACE_DESIGN_PROFILE,
  WorkspaceDesignReviewSchema,
  DESIGN_PROFILE,
  DesignCapabilitiesSchema,
  DesignReviewSchema,
  DesignTurnSchema,
  DesignReceiptSchema,
  type DesignCapabilities,
  type DesignCapabilityService,
} from "../../../../packages/protocol/process-design";
import { api, ApiError } from "./api";

export const designApiPath = "identity/catalog/processes/design";
export const designReviewResponse = z.union([
  z.strictObject({
    profile: z.literal(DESIGN_PROFILE),
    review: DesignReviewSchema,
  }),
  z.strictObject({
    profile: z.literal(WORKSPACE_DESIGN_PROFILE),
    review: WorkspaceDesignReviewSchema,
  }),
]);
export const designTurnResponse = z.strictObject({
  profile: z.enum([DESIGN_PROFILE, WORKSPACE_DESIGN_PROFILE]),
  turn: DesignTurnSchema,
});
export const designTurnsResponse = z.strictObject({
  profile: z.enum([DESIGN_PROFILE, WORKSPACE_DESIGN_PROFILE]),
  turns: z.array(DesignTurnSchema).max(128),
});
export const designMutationResponse = z.union([
  z.strictObject({
    profile: z.literal(DESIGN_PROFILE),
    receipt: DesignReceiptSchema,
    review: DesignReviewSchema,
  }),
  z.strictObject({
    profile: z.literal(WORKSPACE_DESIGN_PROFILE),
    receipt: DesignReceiptSchema,
    review: WorkspaceDesignReviewSchema,
  }),
]);
const capabilitiesResponse = z.strictObject({
  profile: z.literal(DESIGN_PROFILE),
  capabilities: DesignCapabilitiesSchema,
});
/** Fetch a complete, single authorized snapshot before exposing any partial inventory. */
export async function loadDesignCapabilities(
  rawTarget: z.infer<typeof CatalogTarget>,
  signal: AbortSignal,
): Promise<DesignCapabilities> {
  const target = CatalogTarget.parse(rawTarget);
  for (let attempt = 0; ; attempt++) {
    try {
      let snapshot: DesignCapabilities | undefined;
      let after: string | undefined;
      const services = new Map<string, DesignCapabilityService>();
      const models = new Map<string, DesignCapabilities["models"][number]>();
      const cursors = new Set<string>();
      do {
        signal.throwIfAborted();
        const query = new URLSearchParams({
          ...target,
          ...(after ? { after } : {}),
        });
        const page = capabilitiesResponse.parse(
          await api(
            `${designApiPath}/capabilities?${query}`,
            undefined,
            signal,
          ),
        ).capabilities;
        if (
          page.organizationId !== target.organizationId ||
          page.workspaceId !== target.workspaceId
        )
          throw new SyntaxError("Designer capability scope mismatch");
        if (
          snapshot &&
          (page.fingerprint !== snapshot.fingerprint ||
            page.totalItems !== snapshot.totalItems)
        )
          throw new ApiError(409, "process_design_capabilities_changed");
        snapshot ??= page;
        for (const service of page.services) {
          const prior = services.get(service.id);
          const actions = new Map(
            prior?.actions.map((action) => [action.id, action]),
          );
          for (const action of service.actions) actions.set(action.id, action);
          services.set(service.id, {
            ...service,
            actions: [...actions.values()],
          });
        }
        for (const model of page.models) models.set(model.id, model);
        after = page.nextAfter ?? undefined;
        if (after) {
          if (cursors.has(after) || cursors.size >= page.totalItems)
            throw new SyntaxError("Designer capability cursor did not advance");
          cursors.add(after);
        }
      } while (after);
      const itemCount =
        services.size +
        models.size +
        [...services.values()].reduce(
          (count, service) => count + service.actions.length,
          0,
        );
      if (itemCount !== snapshot.totalItems)
        throw new SyntaxError("Designer capability snapshot is incomplete");
      signal.throwIfAborted();
      return {
        ...snapshot,
        services: [...services.values()],
        models: [...models.values()],
        nextAfter: null,
      };
    } catch (error) {
      // Restart once, from an empty local inventory. Never merge old and new pages.
      if (
        attempt === 0 &&
        error instanceof ApiError &&
        error.code === "process_design_capabilities_changed"
      )
        continue;
      throw error;
    }
  }
}
