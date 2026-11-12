import { randomUUID } from "node:crypto";
import {
  NativeTestObservationSchema,
  type NativeTestDiagnosticEvidence,
  type NativeTestCase,
  type NativeTestObservation,
  type NativeTestSuite,
} from "../../packages/protocol/process-native-testing";
import { NativeTestDiagnosticError } from "./process-native-diagnostic";

// The Pi packages ship as one pinned release, so the pi-durable version names them all.
export { PROCESS_CONTRACT_RUNTIME_VERSION as PROCESS_NATIVE_TEST_RUNTIME_VERSION } from "./process-testing";

/**
 * Runs every case once per strategy (configured, then generic unless the
 * suite compares the configured model only), one at a time in suite order.
 * The first case that throws ends the run with its diagnostic; nothing is
 * persisted, the caller copies the result into its report.
 */
export async function runNativeComparisonDataset(
  suite: NativeTestSuite,
  signal: AbortSignal,
  digest: (value: unknown) => string,
  task: (
    strategy: "configured" | "generic",
    item: NativeTestCase,
    signal: AbortSignal,
    capture: (evidence: NativeTestDiagnosticEvidence) => void,
  ) => Promise<NativeTestObservation>,
) {
  const observations: NativeTestObservation[] = [];
  const experiments = {} as { configured: string; generic?: string };
  const strategies =
    suite.comparisonMode === "configured_only"
      ? (["configured"] as const)
      : (["configured", "generic"] as const);
  for (const strategy of strategies) {
    const captures = new Map<string, NativeTestDiagnosticEvidence>();
    // Evidence of the earliest case in suite order that captured any.
    const firstFacts = () =>
      suite.cases.map((c) => captures.get(c.id)).find(Boolean);
    const output: NativeTestObservation[] = [];
    for (const item of suite.cases) {
      signal.throwIfAborted();
      let observed: unknown;
      try {
        observed = await task(strategy, item, signal, (facts) =>
          captures.set(item.id, facts),
        );
      } catch (error) {
        if (signal.aborted) throw error;
        throw error instanceof NativeTestDiagnosticError
          ? error
          : new NativeTestDiagnosticError(
              "native_test_experiment_incomplete",
              firstFacts(),
            );
      }
      const actual = NativeTestObservationSchema.safeParse(observed);
      if (!actual.success)
        throw new NativeTestDiagnosticError(
          "native_test_experiment_result_invalid",
          captures.get(item.id),
        );
      output.push(actual.data);
    }
    signal.throwIfAborted();
    if (
      digest(output.map((o) => o.caseId)) !==
        digest(suite.cases.map((c) => c.id)) ||
      output.some((o) => o.strategy !== strategy)
    )
      throw new NativeTestDiagnosticError(
        "native_test_experiment_conflict",
        firstFacts(),
      );
    observations.push(...output);
    experiments[strategy] = randomUUID();
  }
  return {
    datasetId: randomUUID(),
    datasetVersion: 1,
    experiments,
    observations,
  };
}

/** The native testing service runs comparisons through this object, so tests can observe each run. */
export const nativeComparison = { run: runNativeComparisonDataset };
