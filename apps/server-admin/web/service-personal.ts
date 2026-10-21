import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type {
  Service,
  ServiceAction,
} from "../../../packages/protocol/service-catalog";
import { useAdmin } from "./context";
import { api } from "./lib/api";
import type { CatalogState } from "./catalog-shared";

/** The part of the sign-in status the action and access tabs need. */
const Mode = z.object({
  config: z.object({
    settings: z.object({ requiredFor: z.enum(["none", "writes", "all"]) }),
  }),
});
export type PersonalMode = "all" | "writes" | null;

/**
 * Whether people use this service with their own account: "all" for every
 * action, "writes" for changes, null for the shared connection. Under the
 * "admin"/"catalog" key, so saving sign-in settings refreshes it.
 */
export function usePersonalMode(
  state: CatalogState,
  service: Service,
): PersonalMode {
  const { data } = useAdmin();
  const query = useQuery({
    queryKey: [
      "admin",
      "catalog",
      "personal-mode",
      data.authentication.principalId,
      state.target.organizationId,
      state.target.workspaceId,
      service.id,
    ],
    queryFn: async ({ signal }) =>
      Mode.parse(
        await api(
          "identity/catalog/oauth/status",
          { ...state.target, serviceId: service.id },
          signal,
        ),
      ).config.settings.requiredFor,
    retry: false,
    staleTime: 30_000,
  });
  return query.data === "all" || query.data === "writes" ? query.data : null;
}

/** People manage this action themselves (on/off, approval) under their account. */
export function personallyManaged(
  mode: PersonalMode,
  action: Pick<ServiceAction, "effect">,
) {
  return mode === "all" || (mode === "writes" && action.effect === "write");
}
