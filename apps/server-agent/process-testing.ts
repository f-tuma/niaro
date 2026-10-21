import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import {
  PROCESS_TEST_PROFILE,
  ProcessTestSuiteSchema,
  ProcessTestReportSchema,
  TestJsonSchema,
  type ProcessTestCase,
  type ProcessTestObservation,
  type ProcessTestReport,
  type ProcessTestSuite,
} from "../../packages/protocol/process-testing";
import {
  ProcessVersionSchema,
  type ProcessVersion,
} from "../../packages/protocol/service-processes";
import {
  executeNativeWorkflow,
  type NativeWorkflowResult,
} from "./process-runtime";
import {
  processCompilerVersion,
  processValueSchema,
  type NativeWorkflowBoundary,
  type ProcessResume,
} from "./process-workflow";

export const PROCESS_CONTRACT_RUNNER_VERSION =
  "niaro-isolated-compiler-contract/1";
const require = createRequire(import.meta.url);
export const PROCESS_CONTRACT_RUNTIME_VERSION = `mastra/core@${require("@mastra/core/package.json").version};libsql@${require("@mastra/libsql/package.json").version};zod@${require("zod/package.json").version}`;
/** Kept local to the native package: canonical JSON binds the exact static fixture suite. */
function digest(value: unknown): string {
  const canonical = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : v && typeof v === "object"
        ? `{${Object.keys(v)
            .sort()
            .map(
              (k) =>
                `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
            )
            .join(",")}}`
        : JSON.stringify(v);
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function processContractStamp(
  artifact: ProcessVersion,
  suite: ProcessTestSuite,
) {
  return {
    artifactDigest: artifact.digest,
    sourcesDigest: digest(artifact.sources),
    suiteDigest: digest(suite),
    compilerVersion: processCompilerVersion(artifact.definition),
    runtimeVersion: PROCESS_CONTRACT_RUNTIME_VERSION,
    runnerVersion: PROCESS_CONTRACT_RUNNER_VERSION,
  };
}
class FixtureFailure extends Error {
  constructor(
    readonly code: NonNullable<ProcessTestObservation["code"]>,
    readonly outcome: ProcessTestObservation["observed"] = "failed",
  ) {
    super(code);
  }
}
function store(path: string) {
  const storage = new LibSQLStore({
    id: `niaro-contract-${randomUUID()}`,
    url: `file:${path}`,
  });
  return { storage, mastra: new Mastra({ storage, logger: false }) };
}

/** No catalog, provider, transport, credential or production memory is reachable here. */
async function observe(
  artifact: ProcessVersion,
  item: ProcessTestCase,
  path: string,
  signal: AbortSignal,
  authorize: () => Promise<void>,
): Promise<ProcessTestObservation> {
  const observation: ProcessTestObservation = {
    caseId: item.id,
    scenario: item.scenario,
    runId: randomUUID(),
    observed: "failed",
    visited: [],
    calls: [],
    dispatches: 0,
    approvals: 0,
    reopened: false,
    assertions: [],
    passed: false,
  };
  let owner = store(path),
    consumed = 0;
  let failure: FixtureFailure | undefined;
  let pending:
    | { index: number; operationId: string; nodeId: string }
    | undefined;
  const visited = new Set<string>();
  const fail = (
    code: FixtureFailure["code"],
    outcome?: FixtureFailure["outcome"],
  ): never => {
    failure = new FixtureFailure(code, outcome);
    throw failure;
  };
  const boundary: NativeWorkflowBoundary = {
    authorize: async () => {
      signal.throwIfAborted();
      await authorize();
      signal.throwIfAborted();
    },
    enter: async (node) => {
      if (!visited.has(node.id)) {
        visited.add(node.id);
        observation.visited.push(node.id);
        if (visited.size > artifact.definition.limits.maxSteps)
          fail("test_step_limit");
      }
    },
    leave: async () => {},
    action: async (node, input, resume) =>
      invoke(node.id, "action", input, resume),
    // A static agent output tests the compiler contract only. No LLM quality assertion.
    agent: async (node, input, resume) =>
      invoke(
        node.id,
        "agent",
        input,
        resume && "kind" in resume ? fail("test_fixture_conflict") : resume,
      ),
  };
  async function invoke(
    nodeId: string,
    kind: "action" | "agent",
    input: Record<string, unknown>,
    resume: ProcessResume | undefined,
  ): ReturnType<NativeWorkflowBoundary["action"]> {
    await boundary.authorize();
    const fixture = item.fixtures[consumed] ?? fail("test_fixture_missing");
    if (
      fixture.nodeId !== nodeId ||
      fixture.kind !== kind ||
      digest(fixture.input) !== digest(input)
    )
      fail("test_fixture_conflict");
    if (fixture.approval !== "none") {
      if (!resume) {
        if (!pending) {
          pending = { index: consumed, operationId: randomUUID(), nodeId };
          observation.approvals++;
        }
        return {
          status: "waiting",
          approval: { nodeId, operationId: pending.operationId },
        };
      }
      if (
        !pending ||
        pending.index !== consumed ||
        resume.nodeId !== nodeId ||
        resume.operationId !== pending.operationId
      )
        fail("test_fixture_conflict");
      pending = undefined;
      if (!resume.approved) {
        consumed++;
        observation.calls.push({
          nodeId,
          kind,
          input: fixture.input,
          outcome: "rejected",
        });
        fail("test_rejected", "rejected");
      }
    } else if (resume) fail("test_fixture_conflict");
    consumed++;
    observation.calls.push({
      nodeId,
      kind,
      input: fixture.input,
      outcome: fixture.outcome,
    });
    observation.dispatches++;
    if (fixture.outcome === "failure") fail("test_mock_failure");
    if (fixture.outcome === "unknown") fail("test_mock_unknown", "unknown");
    return { status: "complete", output: structuredClone(fixture.output!) };
  }
  const run = (resume?: ProcessResume) =>
    executeNativeWorkflow(owner.mastra, owner.storage, {
      runId: observation.runId,
      resourceId: "niaro-isolated-contract",
      artifactDigest: artifact.digest,
      compilerVersion: processCompilerVersion(artifact.definition),
      definition: artifact.definition,
      input: item.input,
      ...(resume ? { resume } : {}),
      signal,
      boundary,
    });
  const reopen = async () => {
    await owner.storage.close();
    owner = store(path);
    await owner.storage.init();
    observation.reopened = true;
  };
  try {
    await owner.storage.init();
    if (
      !processValueSchema(artifact.definition.inputSchema).safeParse(item.input)
        .success
    ) {
      observation.observed = "input_invalid";
      observation.code = "test_input_invalid";
    } else {
      let result: NativeWorkflowResult = await run();
      if (result.status === "waiting" && item.reopenAt === "suspended")
        await reopen();
      let resumes = 0;
      while (result.status === "waiting") {
        const approval =
          "approval" in result
            ? result.approval
            : fail("test_fixture_conflict");
        if (++resumes > item.fixtures.length || !pending)
          fail("test_fixture_conflict");
        const fixture =
          item.fixtures[(pending ?? fail("test_fixture_conflict")).index]!;
        result = await run({
          ...approval,
          approved: fixture.approval === "approve",
        });
      }
      if (result.status === "succeeded") {
        observation.observed = "succeeded";
        observation.output = result.output as ProcessTestObservation["output"];
      } else {
        observation.observed = failure?.outcome ?? "failed";
        observation.code =
          failure?.code ??
          (result.code === "process_output_invalid" ||
          result.code === "process_checkpoint_interrupted"
            ? result.code
            : "test_runner_failed");
      }
      if (item.reopenAt === "completed" && result.status === "succeeded") {
        const before = observation.dispatches;
        await reopen();
        const replay = await run();
        if (observation.dispatches !== before)
          observation.assertions.push("replay_dispatched");
        if (
          replay.status !== "succeeded" ||
          digest(replay.output) !== digest(observation.output)
        )
          observation.assertions.push("native_result_unavailable");
      }
    }
  } catch (error) {
    observation.observed = failure?.outcome ?? "failed";
    observation.code = signal.aborted
      ? "test_aborted"
      : error instanceof FixtureFailure
        ? error.code
        : "test_runner_failed";
    if (signal.aborted) throw error;
  } finally {
    await owner.storage.close();
  }
  if (observation.observed !== item.expected.outcome)
    observation.assertions.push("outcome_mismatch");
  if (observation.code !== item.expected.code)
    observation.assertions.push("failure_code_mismatch");
  if (
    [
      "test_fixture_missing",
      "test_fixture_conflict",
      "test_aborted",
      "test_runner_failed",
      "process_checkpoint_interrupted",
    ].includes(observation.code ?? "")
  )
    observation.assertions.push("infrastructure_failure");
  if (
    item.expected.output &&
    (observation.output === undefined ||
      digest(observation.output) !== digest(item.expected.output))
  )
    observation.assertions.push("output_mismatch");
  if (consumed !== item.fixtures.length)
    observation.assertions.push("fixtures_unconsumed");
  if (item.reopenAt && !observation.reopened)
    observation.assertions.push("reopen_not_exercised");
  observation.passed = observation.assertions.length === 0;
  return observation;
}

/** Trusted internal runner. There is no HTTP route or arbitrary task/model injection. */
export async function runProcessContractExperiment(
  rawArtifact: ProcessVersion,
  rawSuite: ProcessTestSuite,
  signal: AbortSignal,
  authorize: () => Promise<void>,
): Promise<ProcessTestReport> {
  TestJsonSchema.parse(rawSuite);
  const artifact = ProcessVersionSchema.parse(rawArtifact),
    suite = ProcessTestSuiteSchema.parse(rawSuite);
  if (
    digest({ definition: artifact.definition, sources: artifact.sources }) !==
    artifact.digest
  )
    throw Error("test_artifact_conflict");
  signal.throwIfAborted();
  await authorize();
  const stamp = processContractStamp(artifact, suite);
  const root = mkdtempSync(join(tmpdir(), "niaro-process-contract-"));
  chmodSync(root, 0o700);
  const owner = store(join(root, "experiments.sqlite"));
  try {
    await owner.storage.init();
    const dataset = await owner.mastra.datasets.create({
      name: "Niaro isolated compiler contract",
      metadata: { ...stamp },
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
      throw Error("test_dataset_incomplete");
    const summary = await dataset.startExperiment<
      ProcessTestCase,
      ProcessTestObservation
    >({
      version,
      name: "Closed static adapter qualification",
      maxConcurrency: 1,
      maxRetries: 0,
      signal,
      // Custom-task toolMocks are not a sandbox. Only our closed boundary executes.
      scorers: [],
      unmockedToolPolicy: "deny",
      task: async ({ input, signal: itemSignal }) => {
        await authorize();
        return observe(
          artifact,
          ProcessTestSuiteSchema.parse({ cases: [input] }).cases[0]!,
          join(root, `${input.id}.sqlite`),
          AbortSignal.any([
            signal,
            ...(itemSignal ? [itemSignal] : []),
            AbortSignal.timeout(
              Math.min(artifact.definition.limits.maxDurationMs, 30000),
            ),
          ]),
          authorize,
        );
      },
    });
    signal.throwIfAborted();
    await authorize();
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
      summary.results.some((r) => r.error || r.persistenceError) ||
      rows.results.length !== suite.cases.length ||
      summary.results.length !== suite.cases.length
    )
      throw Error("test_experiment_incomplete");
    const observations = summary.results.map(
      (r) => r.output as ProcessTestObservation,
    );
    // Experiment terminal callbacks precede persistence. Read and verify the
    // actual rows before copying the report out of this ephemeral test store.
    for (const result of summary.results) {
      const row = rows.results.find((v) => v.itemId === result.itemId);
      if (
        !row ||
        row.error ||
        row.attempt !== 0 ||
        row.retryCount !== 0 ||
        row.itemDatasetVersion !== result.itemVersion ||
        digest(row.input) !== digest(result.input) ||
        digest(row.groundTruth) !== digest(result.groundTruth) ||
        digest(row.output) !== digest(result.output)
      )
        throw Error("test_persisted_result_conflict");
    }
    if (
      digest(observations.map((v) => v.caseId).sort()) !==
      digest(suite.cases.map((v) => v.id).sort())
    )
      throw Error("test_experiment_conflict");
    return ProcessTestReportSchema.parse({
      profile: PROCESS_TEST_PROFILE,
      qualification: "compiler_contract",
      adapterMode: "closed_static_boundaries",
      agentExecution:
        artifact.definition.kind === "agent" ||
        artifact.definition.steps.some((s) => s.type === "agent")
          ? "static_output"
          : "absent",
      activationEligible: false,
      stamp,
      datasetId: dataset.id,
      datasetVersion: version,
      experimentId: summary.experimentId,
      observations,
      status: observations.every((v) => v.passed) ? "passed" : "failed",
    });
  } finally {
    await owner.storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}
