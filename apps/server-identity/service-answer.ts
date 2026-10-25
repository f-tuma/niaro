import type { StoredInvocation } from "./service-catalog";
import type { Scope, Language } from "../../packages/protocol";
import { ServiceResultSchema } from "../../packages/protocol/service-result";
import type { CatalogContext, CatalogController } from "./catalog-controller";
import type { ServiceAnswer } from "./catalog-runtime";
import { IdentityError } from "./error";
import {
  presentServiceResult,
  presentationReply,
} from "../server-integrations/result-presentation";
import { presentActionFailure } from "./failure-presentation";
import { serviceCard } from "../server-cards/adapters";

/** Canonical receipt and approval presentation, shared by native execution and historical replay. */
export function createServiceAnswer(
  controller: CatalogController,
  context: CatalogContext,
  scope: Scope,
  organizationId: string,
) {
  const store = controller.store,
    target = { organizationId, workspaceId: scope.workspaceId };
  return async function resultCard(
    id: string,
    language: Language,
  ): Promise<ServiceAnswer> {
    return context.serial(async () => {
      const actor = await context.actor(target);
      if (actor.userId !== scope.userId)
        throw new IdentityError(403, "identity_forbidden");
      const operation = store.invocation(id, scope.workspaceId, scope.userId);
      if (!operation || operation.organizationId !== organizationId)
        throw new IdentityError(404, "catalog_not_found");

      return presentServiceAnswer(operation, language);
    });
  };
}

/** Held, passive receipt presentation. Callers own scope and current-read checks. */
export function presentServiceAnswer(
  operation: StoredInvocation,
  language: Language,
): ServiceAnswer {
  const label = (language: Language, en: string, cs: string) =>
    language === "cs" ? cs : en;
  const replies = {
    awaiting_approval: label(
      language,
      "Ready for your confirmation.",
      "Připraveno k potvrzení.",
    ),
    running: label(language, "The action is running.", "Akce probíhá."),
    succeeded: label(language, "Completed.", "Hotovo."),
    failed: label(language, "The action failed.", "Akce selhala."),
    unknown: label(
      language,
      "The result is unknown. Check the service before retrying.",
      "Výsledek není známý. Před opakováním ověř stav ve službě.",
    ),
    rejected: label(language, "Action cancelled.", "Akce zrušena."),
  };
  const rawSummary =
    operation.result === undefined ? "" : JSON.stringify(operation.result);
  const failurePresentation =
    operation.status === "failed" || operation.status === "unknown"
      ? presentActionFailure(
          operation.failure,
          operation.status,
          language,
          operation.effect,
        )
      : undefined;
  const summary =
    failurePresentation?.summary ??
    (rawSummary.length > 1800 ? rawSummary.slice(0, 1799) + "…" : rawSummary);
  const presentation =
    operation.status === "succeeded"
      ? presentServiceResult(operation.result, language)
      : undefined;
  const result = ServiceResultSchema.parse({
    type: "service.action",
    version: 1,
    operationId: operation.id,
    title: operation.title,
    service: operation.serviceName,
    inputJson:
      operation.status === "awaiting_approval"
        ? JSON.stringify(operation.input)
        : "",
    reviewTruncated:
      Object.entries(operation.input).length > 20 ||
      Object.keys(operation.input).some((name) => name.length > 100) ||
      Object.values(operation.input).some(
        (value) =>
          (typeof value === "string" ? value : JSON.stringify(value)).length >
          1000,
      ),
    status: operation.status,
    effect: operation.effect,
    fields:
      failurePresentation?.fields ??
      Object.entries(
        operation.status === "awaiting_approval" ? operation.input : {},
      )
        .slice(0, 20)
        .map(([name, value]) => ({
          label: name.slice(0, 100),
          value: (typeof value === "string"
            ? value
            : JSON.stringify(value)
          ).slice(0, 1000),
        })),
    summary,
    ...(presentation ? { presentation } : {}),
  });
  return {
    reply:
      failurePresentation?.reply ??
      (presentation && operation.effect === "read"
        ? presentationReply(presentation, language)
        : replies[operation.status]),
    result: { ...result, card: serviceCard(result, language) },
  };
}
