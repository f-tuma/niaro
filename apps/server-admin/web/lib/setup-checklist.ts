import type { z } from "zod";
import type { CatalogSchema } from "../../../../packages/protocol/service-catalog";
import type { InferenceBudgetSettings } from "../../../../packages/protocol/inference-budget";

type Catalog = z.infer<typeof CatalogSchema>;

export type SetupStepKey =
  | "provider"
  | "model"
  | "routing"
  | "budget"
  | "service"
  | "people";

export type SetupStep = {
  key: SetupStepKey;
  done: boolean;
  /** Console path that finishes the step. */
  to: "/providers" | "/routing" | "/usage" | "/services" | "/people";
};

/**
 * The minimum an administrator sets up before people can work: a provider
 * with a key, a model from it, the chat model in routing, usage limits that
 * enforce with a current price for that model, a service with actions people
 * may use, and someone besides the administrator. Derived only from what the
 * console already reads; `budget` is null while it is unknown.
 */
export function setupChecklist(input: {
  catalog: Catalog;
  budget: InferenceBudgetSettings | null;
  members: number;
  invitations: number;
}): SetupStep[] {
  const { catalog, budget } = input;
  const providers = catalog.providers.filter(
    (p) => p.enabled && p.hasCredential,
  );
  const usable = catalog.models.filter(
    (m) => m.enabled && providers.some((p) => p.id === m.providerId),
  );
  const chat = usable.find((m) => m.id === catalog.routing.modelId);
  const chatProvider = chat
    ? providers.find((p) => p.id === chat.providerId)
    : undefined;
  // The server's budget gate only accepts a price pinned to the current
  // model and provider revisions.
  const priced =
    !!chat &&
    !!chatProvider &&
    !!budget?.prices.some(
      (p) =>
        p.modelId === chat.id &&
        p.modelRevision === chat.revision &&
        p.providerRevision === chatProvider.revision,
    );
  const actions = catalog.services.some(
    (s) =>
      s.enabled &&
      s.actions.some(
        (a) =>
          a.enabled &&
          (a.policy.roles.length > 0 ||
            a.policy.users.some((u) => u.access === "allow")),
      ),
  );
  return [
    { key: "provider", done: providers.length > 0, to: "/providers" },
    { key: "model", done: usable.length > 0, to: "/providers" },
    { key: "routing", done: !!chat, to: "/routing" },
    {
      key: "budget",
      done: budget?.mode === "enforce" && priced,
      to: "/usage",
    },
    { key: "service", done: actions, to: "/services" },
    {
      key: "people",
      done: input.members > 1 || input.invitations > 0,
      to: "/people",
    },
  ];
}
