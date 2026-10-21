import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  NativeTestJobSchema,
  NativeTestReportSchema,
  NativeTestRequestSchema,
  NativeTestSuiteSchema,
  PROCESS_NATIVE_TEST_PROFILE,
} from "../../packages/protocol/process-native-testing";
import {
  NativeQualificationRecordSchema,
  PROCESS_NATIVE_QUALIFICATION_POLICY,
} from "../../packages/protocol/process-native-qualification";
import type { ProcessVersion } from "../../packages/protocol/service-processes";
import {
  PROCESS_TEST_SCENARIOS,
  type ProcessActor,
} from "../../apps/server-identity/service-processes";
import {
  processNativeExecutionSettings,
  processNativeStamp,
} from "../../apps/server-identity/process-native-environment";
import { nativeQualificationDigest } from "../../apps/server-identity/process-native-qualification";
import { processDigest } from "../../apps/server-identity/process-validation";
import type { designHttpFixture } from "./process-design-http";

/** Synthetic metadata fixtures only: these observations are seeded, never run.
 * They pass the actual private gate with persisted namespace, environment and
 * reference proofs. Genuine qualification acceptance must use runNative instead. */
export function seedSyntheticQualification(
  h: Awaited<ReturnType<typeof designHttpFixture>>,
  actor: ProcessActor,
  artifact: ProcessVersion,
) {
  const identity = h.identity;
  const registry = identity["processes"];
  const journal = identity["processTests"];
  const serverId = identity["workflowServerId"];
  assert(journal && serverId);
  const outcomes = {
    success: "succeeded",
    rejection: "rejected",
    missing_input: "input_invalid",
    failure: "failed",
    unknown: "unknown",
    restart: "succeeded",
  } as const;
  const suite = NativeTestSuiteSchema.parse({
    genericModelId: h.modelId,
    cases: PROCESS_TEST_SCENARIOS.map((scenario) => ({
      id: scenario,
      scenario,
      input: {},
      actions: [],
      models: { configured: [], generic: [] },
      expected: {
        outcome: outcomes[scenario],
        ...(outcomes[scenario] === "succeeded"
          ? { output: {} }
          : {
              codes: {
                configured: "TEST-seeded-" + scenario,
                generic: "TEST-seeded-" + scenario,
              },
            }),
        receipts: [],
      },
      ...(scenario === "restart" ? { reopenAt: "completed" } : {}),
    })),
  });
  const catalog = identity["catalog"].store.processTestCatalog(
    actor.organizationId,
    actor.workspaceId,
    actor,
    artifact.sources,
    suite.genericModelId,
  );
  const environment = {
    catalog,
    executionSettings: processNativeExecutionSettings(artifact, catalog),
    authorityEpoch: identity["connections"].policyVersion(actor.organizationId),
  };
  const request = NativeTestRequestSchema.parse({
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    profile: PROCESS_NATIVE_TEST_PROFILE,
    requestId: "TEST-seeded-qualification-" + randomUUID(),
    processId: artifact.processId,
    revision: registry.getOwned(actor, artifact.processId).revision,
    version: artifact.version,
    artifactDigest: artifact.digest,
    suite,
  });
  const stamp = processNativeStamp(artifact, catalog, suite);
  const createdAt = new Date().toISOString();
  const job = {
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    profile: PROCESS_NATIVE_TEST_PROFILE,
    testId: randomUUID(),
    requestId: request.requestId,
    processId: artifact.processId,
    version: artifact.version,
    stamp,
    createdAt,
    updatedAt: createdAt,
  };
  const report = NativeTestReportSchema.parse({
    profile: PROCESS_NATIVE_TEST_PROFILE,
    qualification: "native_scripted",
    agentExecution: "native_agent_scripted_provider",
    adapterMode: "isolated_catalog_receipts",
    activationEligible: false,
    executionSettings: environment.executionSettings,
    stamp,
    datasetId: "TEST-seeded-dataset-" + job.testId,
    datasetVersion: 1,
    experiments: {
      configured: "TEST-seeded-configured-" + job.testId,
      generic: "TEST-seeded-generic-" + job.testId,
    },
    observations: suite.cases.flatMap((item) =>
      ["configured", "generic"].map((strategy) => ({
        caseId: item.id,
        scenario: item.scenario,
        strategy,
        runId: "TEST-seeded-" + strategy + "-" + item.id,
        observed: item.expected.outcome,
        ...(item.expected.output ? { output: item.expected.output } : {}),
        ...(item.expected.codes
          ? { code: item.expected.codes.configured }
          : {}),
        receipts: [],
        modelCalls: 0,
        businessDispatches: 0,
        approvals: 0,
        reopened: item.scenario === "restart",
        infrastructureCodes: [],
        budget: {
          accountedTokens: 0,
          accountedCostMicros: 0,
          unknownCalls: 0,
          overrun: false,
        },
        assertions: [],
        passed: true,
      })),
    ),
    comparison: {
      cases: suite.cases.length,
      configuredPassed: suite.cases.length,
      genericPassed: suite.cases.length,
      configuredModelCalls: 0,
      genericModelCalls: 0,
    },
    status: "passed",
  });
  const base = {
    policy: PROCESS_NATIVE_QUALIFICATION_POLICY,
    scope: "native_scripted_runtime" as const,
    liveAcceptance: false as const,
    status: "qualified" as const,
    reasons: [],
    coverage: PROCESS_TEST_SCENARIOS.map((scenario) => ({
      scenario,
      applicable: true,
      caseIds: [scenario],
      passed: true,
      reasons: [],
    })),
    serverId,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    creatorUserId: actor.userId,
    testId: job.testId,
    processId: artifact.processId,
    version: artifact.version,
    stamp,
    reportDigest: processDigest(report),
    environmentDigest: processDigest(environment),
  };
  const qualification = NativeQualificationRecordSchema.parse({
    ...base,
    qualificationDigest: nativeQualificationDigest(base),
  });
  const completed = NativeTestJobSchema.parse({
    ...job,
    status: "completed",
    failure: null,
    report,
    qualification,
  });
  // Seed terminal metadata directly: there was no native run or started audit.
  // Use the actual namespace function; the private gate checks it and the ordinal.
  identity["db"]
    .prepare(
      `INSERT INTO agent_process_contract_test VALUES (
      niaro_process_test_command_key(?,?,?,?,?),?,?,?)`,
    )
    .run(
      serverId,
      actor.organizationId,
      actor.workspaceId,
      actor.userId,
      request.requestId,
      job.testId,
      artifact.processId,
      JSON.stringify({ creator: actor, request, environment, job: completed }),
    );
  identity["db"]
    .prepare(
      `INSERT INTO agent_process_native_test_admission
      (test_id,server_id,organization_id,workspace_id,process_id,version) VALUES (?,?,?,?,?,?)`,
    )
    .run(
      job.testId,
      serverId,
      actor.organizationId,
      actor.workspaceId,
      artifact.processId,
      artifact.version,
    );
  registry.recordNativeQualification(
    actor,
    artifact.processId,
    artifact.version,
    {
      testId: job.testId,
      digest: artifact.digest,
      runnerVersion: stamp.runnerVersion,
      passed: true,
      scenarios: [...PROCESS_TEST_SCENARIOS],
      reportDigest: qualification.reportDigest,
    },
    {
      serverId,
      creatorUserId: actor.userId,
      testId: job.testId,
      qualificationDigest: qualification.qualificationDigest,
    },
  );
}
