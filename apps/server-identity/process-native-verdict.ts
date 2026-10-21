import type {
  NativeTestCase,
  NativeTestObservation,
  NativeTestExecutionSettings,
} from "../../packages/protocol/process-native-testing";
import { processDigest } from "./process-validation";
import { callReservation, tariffMicros } from "./inference-budget";
import type { ProcessTestCatalog } from "./process-test-catalog";

/** A passing scripted run consumes every declared response and its pinned tariff. */
export function nativePassedBudget(
  item: NativeTestCase,
  strategy: NativeTestObservation["strategy"],
  catalog: ProcessTestCatalog,
  limits: NativeTestExecutionSettings["effectiveBudgetLimits"],
) {
  let accountedTokens = 0,
    accountedCostMicros = 0;
  if (item.models[strategy].length > limits.maxModelCalls) return;
  for (const step of item.models[strategy]) {
    const model = catalog.models.find((m) => m.id === step.modelId);
    const provider = catalog.providers.find((p) => p.id === model?.providerId);
    const price = catalog.budget.prices.find(
      (p) =>
        p.modelId === model?.id &&
        p.modelRevision === model.revision &&
        p.providerRevision === provider?.revision,
    );
    if (!model || !provider || !price) return;
    // A call reserves its own estimated input (at least the floor, at most
    // the price ceiling) plus the full output ceiling. The scripted input
    // stands for the request's size, so the call reserves at least that.
    const { tokens: reservedTokens, cost: reservedCost } = callReservation(
      price,
      step.usage.inputTokens,
    );
    const tokens = step.usage.inputTokens + step.usage.outputTokens;
    const cost = tariffMicros(
      step.usage.inputTokens,
      step.usage.outputTokens,
      price,
    );
    // Mirror the enforced ledger's sequential reserve/settle bounds.
    if (
      accountedTokens + reservedTokens > limits.maxTokens ||
      accountedCostMicros + reservedCost > limits.maxCostMicros ||
      tokens > reservedTokens ||
      cost > reservedCost
    )
      return;
    accountedTokens += tokens;
    accountedCostMicros += cost;
  }
  return {
    accountedTokens,
    accountedCostMicros,
    unknownCalls: 0,
    overrun: false,
  };
}

/** Observable oracle shared by execution and durable publication; no runtime imports. */
export function nativeObservableAssertions(
  item: NativeTestCase,
  observation: NativeTestObservation,
) {
  const assertions: NativeTestObservation["assertions"] = [];
  if (observation.observed !== item.expected.outcome)
    assertions.push("outcome_mismatch");
  if (observation.code !== item.expected.codes?.[observation.strategy])
    assertions.push("failure_code_mismatch");
  if (
    item.expected.output &&
    (!observation.output ||
      processDigest(observation.output) !== processDigest(item.expected.output))
  )
    assertions.push("output_mismatch");
  if (
    processDigest(observation.receipts) !==
    processDigest(item.expected.receipts)
  )
    assertions.push("receipt_ledger_mismatch");
  if (
    observation.approvals !==
    item.actions.filter((f) => f.decision !== "none").length
  )
    assertions.push("approval_ledger_mismatch");
  if (observation.infrastructureCodes.length)
    assertions.push("infrastructure_failure");
  if (item.reopenAt && !observation.reopened)
    assertions.push("reopen_not_exercised");
  return assertions;
}
