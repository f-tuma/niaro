/**
 * The identity server's side of the Pi agent core: each model request a
 * Pi conversation makes resolves its route under the workspace's model
 * policy to a catalog model, goes through the server's integration transport
 * (SSRF guard, trusted origins) wrapped by the inference budget ledger
 * (reserve before, settle after, unknown usage keeps its hold) and counts
 * against the provider's daily limit right before dispatch.
 */
import type { PiCallPlan, ScopedModelHost } from "@niaro/server-agent/pi";
import type { RouteKey } from "../../packages/protocol/model-policy";
import type { NiaroModelSelection } from "../server-integrations/mastra-model";
import type { IntegrationTransport } from "../server-integrations/transport";
import { IdentityError } from "./error";
import {
  budgetedInferenceTransport,
  type InferenceBudgetStore,
  type InferenceRunCaps,
} from "./inference-budget";

/** What the agent core needs of the service catalog (`ServiceCatalogStore`). */
export type AgentCoreCatalog = {
  readonly inferenceBudget: InferenceBudgetStore;
  selectRoute(
    orgId: string,
    workspaceId: string,
    key: RouteKey,
  ): NiaroModelSelection | undefined;
  fallbackAfter(
    orgId: string,
    workspaceId: string,
    selected: NiaroModelSelection,
    error: unknown,
  ): NiaroModelSelection | undefined;
  useProvider(orgId: string, id: string, revision: number): unknown;
};

export type AgentCoreModelDeps = {
  catalog: AgentCoreCatalog;
  transport: IntegrationTransport;
  /** The identity queue; every catalog and ledger access runs under it. */
  serial: <T>(run: () => Promise<T>) => Promise<T>;
  /**
   * The current authority of the scope, checked under the queue before the
   * reservation and again right before dispatch. Throws to refuse.
   */
  authorize?: (scope: {
    organizationId: string;
    workspaceId: string;
    userId: string;
  }) => void | Promise<void>;
  /** Frozen caps of a run, for processes; chat runs use the workspace's limits. */
  caps?: (runKey: string) => InferenceRunCaps | undefined;
};

/** The micro-USD price the ledger would apply, as USD per million tokens for Pi's display. */
function displayPrice(
  catalog: AgentCoreCatalog,
  organizationId: string,
  workspaceId: string,
  selected: NiaroModelSelection,
) {
  try {
    const price = catalog.inferenceBudget
      .policy(organizationId, workspaceId)
      .settings.prices.find(
        (p) =>
          p.modelId === selected.model.id &&
          p.modelRevision === selected.model.revision &&
          p.providerRevision === selected.provider.revision,
      );
    return price
      ? {
          input: price.inputMicrosPerMillion / 1e6,
          output: price.outputMicrosPerMillion / 1e6,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export function agentCoreModelHost(deps: AgentCoreModelDeps): ScopedModelHost {
  const { catalog, serial } = deps;
  return {
    async plan({ route, binding }) {
      const { scope, runKey } = binding;
      const { organizationId, workspaceId } = scope;
      const authorizeHeld = async () => {
        await deps.authorize?.(scope);
      };
      const build = (selected: NiaroModelSelection): PiCallPlan => ({
        selection: selected,
        transport: budgetedInferenceTransport(
          deps.transport,
          catalog.inferenceBudget,
          runKey,
          scope,
          selected,
          "model",
          serial,
          authorizeHeld,
          () => 0,
          deps.caps?.(runKey),
        ),
        beforeDispatch: (start) =>
          serial(async () => {
            await authorizeHeld();
            catalog.useProvider(
              organizationId,
              selected.provider.id,
              selected.provider.revision,
            );
            start();
          }),
        price: displayPrice(catalog, organizationId, workspaceId, selected),
        next: async (error) => {
          const next = await serial(async () =>
            catalog.fallbackAfter(organizationId, workspaceId, selected, error),
          );
          return next && build(next);
        },
      });
      const selected = await serial(async () => {
        await authorizeHeld();
        return catalog.selectRoute(
          organizationId,
          workspaceId,
          route as RouteKey,
        );
      });
      if (!selected) throw new IdentityError(409, "catalog_model_required");
      return build(selected);
    },
  };
}
