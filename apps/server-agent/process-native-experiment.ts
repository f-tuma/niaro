import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import {
  NativeTestObservationSchema,
  NativeTestCaseSchema,
  type NativeTestDiagnosticEvidence,
  type NativeTestDiagnosticCode,
  type NativeTestCase,
  type NativeTestObservation,
  type NativeTestSuite,
} from "../../packages/protocol/process-native-testing";
import { NativeTestDiagnosticError } from "./process-native-diagnostic";

const require = createRequire(import.meta.url);
export const PROCESS_NATIVE_TEST_RUNTIME_VERSION = [
  "@mastra/core",
  "@mastra/libsql",
  "@mastra/memory",
  "@ai-sdk/provider",
  "ai",
  "zod",
]
  .map((p) => `${p}@${require(`${p}/package.json`).version}`)
  .join(";");

/** The caller owns the private directory and removes it after copying its report. */
export async function runNativeComparisonDataset(
  root: string,
  suite: NativeTestSuite,
  metadata: Record<string, string>,
  signal: AbortSignal,
  digest: (value: unknown) => string,
  task: (
    strategy: "configured" | "generic",
    item: NativeTestCase,
    signal: AbortSignal,
    capture: (evidence: NativeTestDiagnosticEvidence) => void,
  ) => Promise<NativeTestObservation>,
) {
  const storage = new LibSQLStore({
    id: `niaro-native-test-${randomUUID()}`,
    url: `file:${join(root, "experiment.sqlite")}`,
  });
  const mastra = new Mastra({ storage, logger: false });
  let primary: unknown;
  let phase: NativeTestDiagnosticCode = "native_test_storage_unavailable";
  let captured: NativeTestDiagnosticEvidence | undefined;
  let stagedFailure: NativeTestDiagnosticError | undefined;
  let completed:
    | {
        datasetId: string;
        datasetVersion: number;
        experiments: { configured: string; generic?: string };
        observations: NativeTestObservation[];
      }
    | undefined;
  try {
    await storage.init();
    const dataset = await mastra.datasets.create({
      name: "Niaro native domain comparison",
      metadata,
      scorerIds: [],
    });
    const items = await dataset.addItems({
      items: suite.cases.map((item) => ({
        externalId: item.id,
        input: item,
        groundTruth: item.expected,
        scorerIds: [],
      })),
    });
    const version = (await dataset.getDetails()).version;
    const snapshot = await dataset.listItems({ version });
    if (
      !Array.isArray(snapshot) ||
      snapshot.length !== suite.cases.length ||
      items.length !== snapshot.length
    )
      throw new NativeTestDiagnosticError("native_test_dataset_incomplete");
    const observations: NativeTestObservation[] = [];
    const experiments = {} as { configured: string; generic?: string };
    const strategies =
      suite.comparisonMode === "configured_only"
        ? (["configured"] as const)
        : (["configured", "generic"] as const);
    for (const strategy of strategies) {
      signal.throwIfAborted();
      phase = "native_test_experiment_incomplete";
      captured = undefined;
      stagedFailure = undefined;
      const captures = new Map<string, NativeTestDiagnosticEvidence>();
      const failures = new Map<string, NativeTestDiagnosticError>();
      let unattributedFailure: NativeTestDiagnosticError | undefined;
      const summary = await dataset.startExperiment<
        NativeTestCase,
        NativeTestObservation
      >({
        version,
        name: strategy,
        maxConcurrency: 1,
        maxRetries: 0,
        scorers: [],
        unmockedToolPolicy: "deny",
        signal,
        task: async ({ input, signal: itemSignal }) => {
          const parsed = NativeTestCaseSchema.safeParse(input);
          const original = suite.cases.find((c) => c.id === parsed.data?.id);
          try {
            if (
              !parsed.success ||
              !original ||
              digest(parsed.data) !== digest(original)
            )
              throw new NativeTestDiagnosticError(
                "native_test_experiment_conflict",
              );
            return await task(
              strategy,
              original,
              AbortSignal.any([signal, ...(itemSignal ? [itemSignal] : [])]),
              (facts) => {
                captures.set(original.id, facts);
                captured = suite.cases
                  .map((c) => captures.get(c.id))
                  .find(Boolean);
              },
            );
          } catch (error) {
            if (error instanceof NativeTestDiagnosticError) {
              if (original) {
                if (!failures.has(original.id))
                  failures.set(original.id, error);
              } else unattributedFailure ??= error;
            }
            stagedFailure =
              suite.cases.map((c) => failures.get(c.id)).find(Boolean) ??
              unattributedFailure;
            throw error;
          }
        },
      });
      signal.throwIfAborted();
      // Mastra continues subsequent items after a failed task. Suite order owns
      // the primary cause, never the last mutable task callback.
      const first =
        suite.cases.map((c) => failures.get(c.id)).find(Boolean) ??
        unattributedFailure;
      if (first) {
        if (summary.persistenceFailures)
          first.secondary("native_test_result_persistence_failed");
        throw first;
      }
      const firstFacts = suite.cases
        .map((c) => captures.get(c.id))
        .find(Boolean);
      captured = firstFacts;
      if (
        summary.persistenceFailures ||
        summary.results.some((r) => r.persistenceError)
      )
        throw new NativeTestDiagnosticError(
          "native_test_result_persistence_failed",
          firstFacts,
        );
      if (
        summary.status !== "completed" ||
        summary.skippedCount ||
        summary.failedCount ||
        summary.results.length !== suite.cases.length
      )
        throw new NativeTestDiagnosticError(
          "native_test_experiment_incomplete",
          firstFacts,
        );
      phase = "native_test_result_persistence_failed";
      const persisted = await dataset.getExperiment({
        experimentId: summary.experimentId,
      });
      const rows = await dataset.listExperimentResults({
        experimentId: summary.experimentId,
        perPage: 100,
      });
      if (
        !persisted ||
        persisted.status !== "completed" ||
        summary.status !== "completed" ||
        summary.skippedCount ||
        summary.failedCount ||
        summary.persistenceFailures ||
        summary.results.length !== suite.cases.length ||
        rows.results.length !== suite.cases.length
      )
        throw new NativeTestDiagnosticError(
          "native_test_experiment_incomplete",
          firstFacts,
        );
      phase = "native_test_persisted_result_conflict";
      const output: NativeTestObservation[] = [];
      for (const result of summary.results) {
        const row = rows.results.find((r) => r.itemId === result.itemId);
        const item = snapshot.find((i) => i.id === result.itemId);
        const actual = NativeTestObservationSchema.safeParse(result.output);
        const persistedOutput = NativeTestObservationSchema.safeParse(
          row?.output,
        );
        const caseId = (item?.input as NativeTestCase | undefined)?.id;
        const facts = caseId ? captures.get(caseId) : undefined;
        if (!actual.success || !persistedOutput.success)
          throw new NativeTestDiagnosticError(
            "native_test_experiment_result_invalid",
            facts,
          );
        if (
          result.error ||
          result.persistenceError ||
          !row ||
          !item ||
          row.error ||
          row.attempt !== 0 ||
          row.retryCount !== 0 ||
          row.itemDatasetVersion !== result.itemVersion ||
          digest(row.input) !== digest(result.input) ||
          digest(row.groundTruth) !== digest(result.groundTruth) ||
          digest(row.output) !== digest(result.output) ||
          digest(item.input) !== digest(result.input) ||
          digest(item.groundTruth) !== digest(result.groundTruth)
        )
          throw new NativeTestDiagnosticError(
            "native_test_persisted_result_conflict",
            facts,
          );
        output.push(actual.data);
      }
      if (
        digest(output.map((o) => o.caseId).sort()) !==
          digest(suite.cases.map((c) => c.id).sort()) ||
        output.some((o) => o.strategy !== strategy)
      )
        throw new NativeTestDiagnosticError(
          "native_test_experiment_conflict",
          firstFacts,
        );
      observations.push(...output);
      experiments[strategy] = summary.experimentId;
    }
    completed = {
      datasetId: dataset.id,
      datasetVersion: version,
      experiments,
      observations,
    };
  } catch (error) {
    primary = signal.aborted
      ? error
      : (stagedFailure ??
        (error instanceof NativeTestDiagnosticError
          ? error
          : new NativeTestDiagnosticError(phase, captured)));
  } finally {
    try {
      await storage.close();
    } catch {
      if (primary instanceof NativeTestDiagnosticError)
        primary.secondary("native_test_cleanup_failed");
      else if (!primary)
        primary = new NativeTestDiagnosticError(
          "native_test_cleanup_failed",
          captured,
        );
    }
  }
  if (primary) throw primary;
  return completed!;
}
