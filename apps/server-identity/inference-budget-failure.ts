/** Server-owned causes; never interpret arbitrary provider text as a diagnosis. */
export const INFERENCE_BUDGET_FAILURE_CODES = [
  "catalog_budget_exhausted",
  "catalog_budget_overrun",
  "catalog_budget_usage_unknown",
  "catalog_budget_policy_changed",
  "catalog_budget_price_required",
  "catalog_budget_request_too_large",
  // The provider's daily request limit is a server-owned request cap, not a ledger result.
  "catalog_provider_limit",
] as const;
export type InferenceBudgetFailureCode =
  (typeof INFERENCE_BUDGET_FAILURE_CODES)[number];
export function isInferenceBudgetFailureCode(
  code: string,
): code is InferenceBudgetFailureCode {
  return INFERENCE_BUDGET_FAILURE_CODES.some((known) => known === code);
}
