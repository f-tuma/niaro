import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
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
import type { PiAgentCore } from "./pi/core";
import type { NativeWorkflowResult } from "./pi/process-engine";
import {
  processCompilerVersion,
  processValueSchema,
  type NativeWorkflowBoundary,
  type ProcessResume,
} from "./process-workflow";

export const PROCESS_CONTRACT_RUNNER_VERSION =
  "niaro-isolated-compiler-contract/1";
const require = createRequire(import.meta.url);
export const PROCESS_CONTRACT_RUNTIME_VERSION = `pi-durable@${require("@earendil-works/pi-durable/package.json").version};zod@${require("zod/package.json").version}`;
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
  // Each case runs on its own agent core file; no model is reachable.
  // Pi is ESM-only; callers may load this module from CommonJS.
  const { PiAgentCore: Core } = await import("./pi/core");
  const openCore = () =>
    Core.open({
      file: path,
      host: {
        plan: async () => {
          throw new Error("test_models_unavailable");
        },
      },
    });
  let core: PiAgentCore | undefined;
  let consumed = 0;
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
  const run = async (resume?: ProcessResume) =>
    (core ??= await openCore()).executeProcess({
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
    await core?.close();
    core = await openCore();
    observation.reopened = true;
  };
  try {
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
    await core?.close();
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
  try {
    // Cases run one at a time in suite order; a case that cannot be
    // observed fails the whole run, after authorization is checked again.
    const observations: ProcessTestObservation[] = [];
    for (const item of suite.cases) {
      await authorize();
      try {
        observations.push(
          await observe(
            artifact,
            item,
            join(root, `${item.id}.sqlite`),
            AbortSignal.any([
              signal,
              AbortSignal.timeout(
                Math.min(artifact.definition.limits.maxDurationMs, 30000),
              ),
            ]),
            authorize,
          ),
        );
      } catch (error) {
        signal.throwIfAborted();
        await authorize();
        throw Error("test_experiment_incomplete", { cause: error });
      }
    }
    signal.throwIfAborted();
    await authorize();
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
      datasetId: randomUUID(),
      datasetVersion: 1,
      experimentId: randomUUID(),
      observations,
      status: observations.every((v) => v.passed) ? "passed" : "failed",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
