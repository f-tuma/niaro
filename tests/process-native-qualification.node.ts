import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeQualificationVerdictSchema,
  NativeQualificationRecordSchema,
  NativeQualificationSummarySchema,
  type NativeQualificationReason,
} from "../packages/protocol/process-native-qualification";
import {
  PROCESS_NATIVE_TEST_PROFILE,
  NativeTestRequestSchema,
  NativeTestReportSchema,
  NativeTestSuiteSchema,
  NativeTestListQuerySchema,
  type NativeTestReport,
  type NativeTestSuite,
  type NativeTestCase,
} from "../packages/protocol/process-native-testing";
import { ProcessTestScenarioSchema } from "../packages/protocol/process-testing";
import {
  ProcessDefinitionSchema,
  type ProcessVersion,
} from "../packages/protocol/service-processes";
import {
  deriveNativeQualification,
  nativeQualificationDigest,
} from "../apps/server-identity/process-native-qualification";
import {
  processNativeStamp,
  processNativeExecutionSettings,
} from "../apps/server-identity/process-native-environment";
import { ProcessTestingStore } from "../apps/server-identity/process-testing-store";
import { AuditStore } from "../apps/server-identity/audit";
import { processDigest } from "../apps/server-identity/process-validation";
import type { ProcessTestCatalog } from "../apps/server-identity/process-test-catalog";
import {
  fixture,
  admin,
  target,
  code,
} from "./helpers/service-process-runtime";
import { buildNativeTestFixture } from "./helpers/process-native-testing";
import { buildNativeQualificationSuite } from "./helpers/process-native-qualification";
import { processWorkflow } from "./helpers/service-process";
import { nativePassedBudget } from "../apps/server-identity/process-native-verdict";
import {
  CatalogCommand,
  CatalogModelSettings,
  ActionSettings,
} from "../packages/protocol/service-catalog";
import { rankNativeActions } from "../apps/server-identity/mastra-domain";

test("model-free read-only workflows qualify their actual success, missing input, failure and completed reopen", () =>
  setup(async (x) => {
    const definition = processWorkflow(x.h.ids.serviceId, x.h.ids.readId);
    const draft = x.h.registry.saveDraft(admin, {
      serviceId: x.h.ids.serviceId,
      revision: 0,
      definition,
    });
    const artifact = x.h.registry.freezeDraft(admin, draft.id, draft.revision);
    const catalog = x.h.catalog.processTestCatalog(
      admin.organizationId,
      admin.workspaceId,
      admin,
      artifact.sources,
    );
    assert.deepEqual(catalog.models, []);
    const read = structuredClone(x.read);
    read.models = { configured: [], generic: [] };
    const { output: _output, ...failedReceipt } = read.expected.receipts[0]!;
    const suite = NativeTestSuiteSchema.parse({
      comparisonMode: "configured_only",
      cases: [
        read,
        {
          ...read,
          id: "missing",
          scenario: "missing_input",
          input: {},
          actions: [],
          expected: {
            outcome: "input_invalid",
            codes: { configured: "process_input_invalid" },
            receipts: [],
          },
        },
        {
          ...read,
          id: "failure",
          scenario: "failure",
          actions: [{ ...read.actions[0]!, outcome: "failure" }],
          expected: {
            outcome: "failed",
            codes: { configured: "integration_provider_failed" },
            receipts: [
              {
                ...failedReceipt,
                status: "failed",
                code: "integration_provider_failed",
              },
            ],
          },
        },
        { ...read, id: "restart", scenario: "restart", reopenAt: "completed" },
      ],
    });
    const { runProcessNativeComparison } = await import(
      "../apps/server-identity/process-native-testing"
    );
    const report = await runProcessNativeComparison(
      artifact,
      catalog,
      suite,
      new AbortController().signal,
      async () => {},
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    const verdict = deriveNativeQualification(artifact, suite, report, catalog);
    assert.equal(verdict.status, "qualified", JSON.stringify(verdict));
    assert.deepEqual(
      verdict.coverage.filter((c) => !c.applicable).map((c) => c.scenario),
      ["rejection", "unknown"],
    );
    assert(
      report.observations.every(
        (o) => o.strategy === "configured" && o.modelCalls === 0,
      ),
    );
    const missingFailure = structuredClone(suite);
    missingFailure.cases = missingFailure.cases.filter(
      (c) => c.scenario !== "failure",
    );
    const subset = await runProcessNativeComparison(
      artifact,
      catalog,
      missingFailure,
      new AbortController().signal,
      async () => {},
    );
    const denied = deriveNativeQualification(
      artifact,
      missingFailure,
      subset,
      catalog,
    );
    assert.equal(denied.status, "failed");
    assert.deepEqual(
      denied.coverage.find((c) => c.scenario === "failure")!.reasons,
      ["missing_scenario"],
    );
    noProductionEffects(x);
  }));

test("model-free write workflows still require actual approval rejection, uncertain write and suspended reopen", () =>
  setup(async (x) => {
    const definition = processWorkflow(x.h.ids.serviceId, x.h.ids.writeId);
    const draft = x.h.registry.saveDraft(admin, {
      serviceId: x.h.ids.serviceId,
      revision: 0,
      definition,
    });
    const artifact = x.h.registry.freezeDraft(admin, draft.id, draft.revision);
    const catalog = x.h.catalog.processTestCatalog(
      admin.organizationId,
      admin.workspaceId,
      admin,
      artifact.sources,
    );
    const writeAction = catalog.services[0]!.actions.find(
      (a) => a.id === x.h.ids.writeId,
    )!;
    const read = structuredClone(x.read);
    const write: NativeTestCase = {
      ...read,
      models: { configured: [], generic: [] },
      actions: [
        { ...read.actions[0]!, actionId: writeAction.id, decision: "approve" },
      ],
      expected: {
        ...read.expected,
        receipts: [
          {
            ...read.expected.receipts[0]!,
            actionId: writeAction.id,
            actionRevision: writeAction.revision,
            effect: "write",
          },
        ],
      },
    };
    const { output: _output, ...terminalReceipt } = write.expected.receipts[0]!;
    const terminal = (scenario: "rejection" | "failure" | "unknown") => {
      if (scenario === "failure")
        return {
          ...write,
          id: scenario,
          scenario,
          actions: [{ ...write.actions[0]!, output: { value: 42 } }],
          expected: {
            outcome: "failed",
            codes: { configured: "process_output_invalid" },
            receipts: [
              { ...write.expected.receipts[0]!, output: { value: 42 } },
            ],
          },
        };
      const rejection = scenario === "rejection",
        unknown = scenario === "unknown";
      const code = rejection
        ? "process_action_rejected"
        : unknown
          ? "integration_unavailable"
          : "integration_provider_failed";
      return {
        ...write,
        id: scenario,
        scenario,
        actions: [
          {
            ...write.actions[0]!,
            decision: rejection ? "reject" : "approve",
            outcome: unknown ? "unknown" : rejection ? "complete" : "failure",
          },
        ],
        expected: {
          outcome: rejection ? "rejected" : unknown ? "unknown" : "failed",
          codes: { configured: code },
          receipts: [
            {
              ...terminalReceipt,
              status: rejection ? "rejected" : unknown ? "unknown" : "failed",
              ...(rejection ? {} : { code }),
              dispatches: rejection ? 0 : 1,
            },
          ],
        },
      };
    };
    const suite = NativeTestSuiteSchema.parse({
      comparisonMode: "configured_only",
      cases: [
        write,
        terminal("rejection"),
        {
          ...write,
          id: "missing",
          scenario: "missing_input",
          input: {},
          actions: [],
          expected: {
            outcome: "input_invalid",
            codes: { configured: "process_input_invalid" },
            receipts: [],
          },
        },
        terminal("failure"),
        terminal("unknown"),
        { ...write, id: "restart", scenario: "restart", reopenAt: "suspended" },
      ],
    });
    const { runProcessNativeComparison } = await import(
      "../apps/server-identity/process-native-testing"
    );
    const report = await runProcessNativeComparison(
      artifact,
      catalog,
      suite,
      new AbortController().signal,
      async () => {},
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    const verdict = deriveNativeQualification(artifact, suite, report, catalog);
    assert.equal(verdict.status, "qualified", JSON.stringify(verdict));
    assert(verdict.coverage.every((c) => c.applicable));
    for (const scenario of ["rejection", "unknown", "restart"] as const) {
      const subsetSuite = structuredClone(suite);
      subsetSuite.cases = subsetSuite.cases.filter(
        (c) => c.scenario !== scenario,
      );
      const subsetReport = structuredClone(report);
      subsetReport.observations = subsetReport.observations.filter(
        (o) => o.scenario !== scenario,
      );
      subsetReport.stamp.suiteDigest = processDigest(subsetSuite);
      subsetReport.comparison.cases--;
      subsetReport.comparison.configuredPassed--;
      const denied = deriveNativeQualification(
        artifact,
        subsetSuite,
        subsetReport,
        catalog,
      );
      assert.equal(denied.status, "failed");
      assert(
        denied.coverage
          .find((c) => c.scenario === scenario)!
          .reasons.includes("missing_scenario"),
      );
    }
    const forbidden = NativeTestSuiteSchema.parse({
      comparisonMode: "configured_only",
      cases: [{ ...x.read, models: { configured: [], generic: [] } }],
    });
    await assert.rejects(
      runProcessNativeComparison(
        x.artifact,
        x.catalog,
        forbidden,
        new AbortController().signal,
        async () => {},
      ),
      /native_test_comparison_mode_invalid/,
    );
    noProductionEffects(x);
  }));

type Fixture = ReturnType<typeof buildNativeTestFixture>;
async function setup(run: (x: Fixture, path: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "niaro-native-qualification-"));
  const path = join(root, "identity.sqlite");
  const h = fixture(path);
  try {
    await run(buildNativeTestFixture(h), path);
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
}
function noProductionEffects(x: Fixture) {
  for (const table of [
    "test_dispatch",
    "test_model",
    "agent_service_invocation",
    "agent_inference_run",
    "agent_service_process_test",
    "agent_service_process_run",
  ])
    assert.equal(
      x.h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
      0,
      table,
    );
  assert.equal(x.h.registry.get(admin, x.draft.id).activeVersion, null);
  assert.equal(
    x.h.registry.version(admin, x.draft.id, 1).testStatus,
    "untested",
  );
}
function recomputeComparison(report: NativeTestReport) {
  const configured = report.observations.filter(
    (observation) => observation.strategy === "configured",
  );
  const generic = report.observations.filter(
    (observation) => observation.strategy === "generic",
  );
  report.comparison = {
    cases: configured.length,
    configuredPassed: configured.filter((observation) => observation.passed)
      .length,
    genericPassed: generic.filter((observation) => observation.passed).length,
    configuredModelCalls: configured.reduce(
      (sum, observation) => sum + observation.modelCalls,
      0,
    ),
    genericModelCalls: generic.reduce(
      (sum, observation) => sum + observation.modelCalls,
      0,
    ),
  };
  report.status = report.observations.every((observation) => observation.passed)
    ? "passed"
    : "failed";
}
type Evidence = {
  artifact: ProcessVersion;
  suite: NativeTestSuite;
  report: NativeTestReport;
  catalog: ProcessTestCatalog;
};
function rejectedEvidence(
  evidence: Evidence,
  reason?: NativeQualificationReason,
) {
  const verdict = deriveNativeQualification(
    evidence.artifact,
    evidence.suite,
    evidence.report,
    evidence.catalog,
  );
  assert.equal(verdict.status, "failed", JSON.stringify(verdict));
  if (reason) assert(verdict.reasons.includes(reason), JSON.stringify(verdict));
  assert.equal(verdict.liveAcceptance, false);
  return verdict;
}

test("actual six-family native comparison qualifies runtime evidence with no production effects", () =>
  setup(async (x) => {
    const before = processDigest(
      x.h.catalog.inventory(admin.organizationId, admin.workspaceId, admin),
    );
    const suite = buildNativeQualificationSuite(x);
    const report = await x.run(suite.cases);
    assert.equal(
      report.status,
      "passed",
      JSON.stringify(report.observations, null, 2),
    );
    assert.equal(report.observations.length, 12);
    const evidence = {
      artifact: x.artifact,
      suite,
      report,
      catalog: x.catalog,
    };
    const verdict = deriveNativeQualification(
      x.artifact,
      suite,
      report,
      x.catalog,
    );
    assert.equal(verdict.status, "qualified", JSON.stringify(verdict));
    assert.deepEqual(verdict.reasons, []);
    assert.deepEqual(
      verdict.coverage.map((family) => family.scenario),
      ProcessTestScenarioSchema.options,
    );
    assert(
      verdict.coverage.every(
        (family) =>
          family.passed &&
          family.caseIds.length === 1 &&
          family.reasons.length === 0,
      ),
    );
    assert.equal(report.activationEligible, false);
    assert.equal(report.qualification, "native_scripted");
    assert.equal(verdict.liveAcceptance, false);
    assert.deepEqual(
      deriveNativeQualification(x.artifact, suite, report, x.catalog),
      verdict,
    );
    assert.equal(
      processDigest(evidence),
      processDigest({
        artifact: x.artifact,
        suite,
        report,
        catalog: x.catalog,
      }),
    );
    assert.equal(
      processDigest(
        x.h.catalog.inventory(admin.organizationId, admin.workspaceId, admin),
      ),
      before,
    );
    noProductionEffects(x);
  }));

test("actual passing subset has explicit missing families, including a common read-only definition", () =>
  setup(async (x) => {
    const read = structuredClone(x.read);
    const definition = x.artifact.definition;
    assert(definition.kind === "agent");
    const draft = x.h.registry.saveDraft(admin, {
      serviceId: x.h.ids.serviceId,
      revision: 0,
      definition: ProcessDefinitionSchema.parse({
        ...definition,
        name: "TEST read-only agent",
        capabilities: [
          { serviceId: x.h.ids.serviceId, actionId: x.h.ids.readId },
        ],
      }),
    });
    const artifact = x.h.registry.freezeDraft(admin, draft.id, draft.revision);
    const catalog = x.h.catalog.processTestCatalog(
      admin.organizationId,
      admin.workspaceId,
      admin,
      artifact.sources,
      x.modelId,
    );
    read.models.configured[0] = x.tool(
      "action_process_0",
      { name: "TEST-input" },
      "TEST-read-only",
    );
    const suite = NativeTestSuiteSchema.parse({
      genericModelId: x.modelId,
      cases: [read],
    });
    const { runProcessNativeComparison } = await import(
      "../apps/server-identity/process-native-testing"
    );
    const report = await runProcessNativeComparison(
      artifact,
      catalog,
      suite,
      new AbortController().signal,
      async () => {},
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    const verdict = rejectedEvidence(
      { artifact, suite, report, catalog },
      "missing_scenario",
    );
    assert.equal(verdict.coverage[0]!.passed, true);
    for (const family of verdict.coverage.slice(1)) {
      assert.deepEqual(family.caseIds, []);
      const applicable = !["rejection", "unknown"].includes(family.scenario);
      assert.equal(family.applicable, applicable);
      assert.equal(family.passed, !applicable);
      assert.deepEqual(family.reasons, applicable ? ["missing_scenario"] : []);
    }
    noProductionEffects(x);
  }));

test("actual model-only agent success uses inference; a static workflow may succeed with zero configured inference", () =>
  setup(async (x) => {
    const modelOnly = structuredClone(x.read);
    modelOnly.actions = [];
    modelOnly.expected.receipts = [];
    modelOnly.models = {
      configured: [x.text({ result: "TEST-result" })],
      generic: [x.text({ result: "TEST-result" })],
    };
    const agentSuite = NativeTestSuiteSchema.parse({
      genericModelId: x.modelId,
      cases: [modelOnly],
    });
    const agentReport = await x.run(agentSuite.cases);
    assert.equal(agentReport.status, "passed", JSON.stringify(agentReport));
    assert(
      agentReport.observations.every(
        (observation) => observation.modelCalls === 1,
      ),
    );
    assert.equal(
      deriveNativeQualification(x.artifact, agentSuite, agentReport, x.catalog)
        .coverage[0]!.passed,
      true,
    );
    const definition = processWorkflow(x.h.ids.serviceId, x.h.ids.readId);
    definition.limits.maxModelCalls = 32;
    const draft = x.h.registry.saveDraft(admin, {
      serviceId: x.h.ids.serviceId,
      revision: 0,
      definition,
    });
    const artifact = x.h.registry.freezeDraft(admin, draft.id, draft.revision);
    const catalog = x.h.catalog.processTestCatalog(
      admin.organizationId,
      admin.workspaceId,
      admin,
      artifact.sources,
      x.modelId,
    );
    const read = structuredClone(x.read);
    read.models.configured = [];
    const suite = NativeTestSuiteSchema.parse({
      genericModelId: x.modelId,
      cases: [read],
    });
    const { runProcessNativeComparison } = await import(
      "../apps/server-identity/process-native-testing"
    );
    const report = await runProcessNativeComparison(
      artifact,
      catalog,
      suite,
      new AbortController().signal,
      async () => {},
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(
      report.observations.find(
        (observation) => observation.strategy === "configured",
      )!.modelCalls,
      0,
    );
    assert.equal(
      deriveNativeQualification(artifact, suite, report, catalog).coverage[0]!
        .passed,
      true,
    );
    const completedRead = NativeTestSuiteSchema.parse({
      genericModelId: x.modelId,
      cases: [
        {
          ...x.read,
          id: "restart",
          scenario: "restart",
          reopenAt: "completed",
        },
      ],
    });
    const restarted = await x.run(completedRead.cases);
    assert.equal(restarted.status, "passed", JSON.stringify(restarted));
    assert.equal(
      deriveNativeQualification(
        x.artifact,
        completedRead,
        restarted,
        x.catalog,
      ).coverage.find((family) => family.scenario === "restart")!.passed,
      true,
    );
    noProductionEffects(x);
  }));

test("actual tool-enabled router model uses the same authoritative qualification eligibility as process metadata", () =>
  setup(async (x) => {
    const model = x.catalog.models.find((value) => value.id === x.modelId)!;
    const { id: _id, revision: _revision, ...settings } = model;
    x.h.catalog.command(
      CatalogCommand.parse({
        ...target,
        type: "saveModel",
        id: model.id,
        revision: model.revision,
        settings: CatalogModelSettings.parse({ ...settings, kind: "router" }),
      }),
    );
    const policy = x.h.catalog.inferenceBudget.policy(
      admin.organizationId,
      admin.workspaceId,
    );
    const selected = x.h.catalog.processModelMetadata(
      admin.organizationId,
      model.id,
    );
    x.h.catalog.inferenceBudget.savePolicy(
      admin.organizationId,
      admin.workspaceId,
      policy.revision,
      {
        ...policy.settings,
        prices: policy.settings.prices.map((price) =>
          price.modelId === model.id
            ? {
                ...price,
                modelRevision: selected.model.revision,
                providerRevision: selected.provider.revision,
              }
            : price,
        ),
      },
    );
    const draft = x.h.registry.saveDraft(admin, {
      serviceId: x.h.ids.serviceId,
      revision: 0,
      definition: x.artifact.definition,
    });
    const artifact = x.h.registry.freezeDraft(admin, draft.id, draft.revision);
    const catalog = x.h.catalog.processTestCatalog(
      admin.organizationId,
      admin.workspaceId,
      admin,
      artifact.sources,
      x.modelId,
    );
    const suite = buildNativeQualificationSuite({
      ...x,
      artifact,
      catalog,
      draft,
    });
    const { runProcessNativeComparison } = await import(
      "../apps/server-identity/process-native-testing"
    );
    const report = await runProcessNativeComparison(
      artifact,
      catalog,
      suite,
      new AbortController().signal,
      async () => {},
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(
      deriveNativeQualification(artifact, suite, report, catalog).status,
      "qualified",
    );
    noProductionEffects(x);
  }));

for (const excludedEffect of ["read", "write"] as const)
  test(`actual seven-action catalog uses shared native discovery ranking and rejects its omitted ${excludedEffect} action`, () =>
    setup(async (x) => {
      const service = x.catalog.services.find(
        (value) => value.id === x.h.ids.serviceId,
      )!;
      const base = service.actions.find(
        (action) => action.id === x.h.ids.readId,
      )!;
      const { id: _id, revision: _revision, ...settings } = base;
      const extraIds: string[] = [];
      for (let index = 0; index < 5; index++)
        extraIds.push(
          x.h.catalog.command(
            CatalogCommand.parse({
              ...target,
              type: "saveAction",
              serviceId: service.id,
              serviceRevision: x.h.catalog.service(
                admin.workspaceId,
                service.id,
              ).revision,
              revision: 0,
              settings: ActionSettings.parse({
                ...settings,
                name:
                  excludedEffect === "read" && index === 4
                    ? "Omitted extra"
                    : `TEST read extra ${index}`,
              }),
            }),
          ),
        );
      const definition = x.artifact.definition;
      assert(definition.kind === "agent");
      const draft = x.h.registry.saveDraft(admin, {
        serviceId: service.id,
        revision: 0,
        definition: ProcessDefinitionSchema.parse({
          ...definition,
          capabilities: [
            ...definition.capabilities,
            ...extraIds.map((actionId) => ({
              serviceId: service.id,
              actionId,
            })),
          ],
        }),
      });
      const artifact = x.h.registry.freezeDraft(
        admin,
        draft.id,
        draft.revision,
      );
      const catalog = x.h.catalog.processTestCatalog(
        admin.organizationId,
        admin.workspaceId,
        admin,
        artifact.sources,
        x.modelId,
      );
      const read = structuredClone(x.read);
      const pinned = catalog.services.find((value) => value.id === service.id)!;
      read.expected.receipts[0]!.serviceRevision = pinned.revision;
      const suite = buildNativeQualificationSuite({
        ...x,
        read,
        artifact,
        catalog,
        draft,
      });
      const { runProcessNativeComparison } = await import(
        "../apps/server-identity/process-native-testing"
      );
      const run = (cases: NativeTestSuite["cases"]) =>
        runProcessNativeComparison(
          artifact,
          catalog,
          NativeTestSuiteSchema.parse({ genericModelId: x.modelId, cases }),
          new AbortController().signal,
          async () => {},
        );
      const report = await run(suite.cases);
      assert.equal(report.status, "passed", JSON.stringify(report));
      assert.equal(
        deriveNativeQualification(artifact, suite, report, catalog).status,
        "qualified",
      );
      const excluded = rankNativeActions(pinned.actions, "TEST read")[6]!;
      assert.equal(excluded.effect, excludedEffect);
      const evidence = structuredClone({ artifact, suite, report, catalog });
      const item = evidence.suite.cases.find((value) => value.id === "read")!;
      item.actions[0]!.actionId = excluded.id;
      item.actions[0]!.decision =
        excluded.approval === "always" ? "approve" : "none";
      item.expected.receipts[0]!.actionId = excluded.id;
      item.expected.receipts[0]!.actionRevision = excluded.revision;
      item.expected.receipts[0]!.effect = excluded.effect;
      assert(evidence.artifact.definition.kind === "agent");
      const index = evidence.artifact.definition.capabilities.findIndex(
        (value) => value.actionId === excluded.id,
      );
      item.models.configured[0] = x.tool(
        `action_process_${index}`,
        { name: "TEST-input" },
        "TEST-excluded-configured",
      );
      item.models.generic[1] = x.tool(
        x.actionName(excluded.id),
        { name: "TEST-input" },
        "TEST-excluded-generic",
      );
      for (const observation of evidence.report.observations.filter(
        (value) => value.caseId === item.id,
      ))
        observation.receipts = structuredClone(item.expected.receipts);
      evidence.report.stamp = processNativeStamp(
        artifact,
        catalog,
        evidence.suite,
      );
      assert(NativeTestReportSchema.safeParse(evidence.report).success);
      rejectedEvidence(evidence, "invalid_observation");
      const actual = await run([item]);
      assert.equal(actual.status, "failed");
      assert.equal(
        actual.observations.find(
          (observation) => observation.strategy === "configured",
        )!.passed,
        true,
        JSON.stringify(actual),
      );
      assert(
        actual.observations
          .find((observation) => observation.strategy === "generic")!
          .infrastructureCodes.includes("native_test_model_conflict"),
      );
      noProductionEffects(x);
    }));

test("qualification independently rejects forged observations, budgets, bindings and false family semantics", (t) =>
  setup(async (x) => {
    const suite = buildNativeQualificationSuite(x);
    const report = await x.run(suite.cases);
    assert.equal(report.status, "passed", JSON.stringify(report));
    const baseline: Evidence = {
      artifact: x.artifact,
      suite,
      report,
      catalog: x.catalog,
    };
    const mutated = () => structuredClone(baseline);
    const rebind = (evidence: Evidence) => {
      evidence.report.stamp = processNativeStamp(
        evidence.artifact,
        evidence.catalog,
        evidence.suite,
      );
    };
    const update = (
      evidence: Evidence,
      id: string,
      mutate: (observation: NativeTestReport["observations"][number]) => void,
    ) => {
      for (const observation of evidence.report.observations.filter(
        (value) => value.caseId === id,
      ))
        mutate(observation);
      recomputeComparison(evidence.report);
    };
    await t.test(
      "a standalone configured agent cannot claim success without native inference",
      () => {
        const evidence = mutated();
        const item = evidence.suite.cases.find((value) => value.id === "read")!;
        item.actions = [];
        item.expected.receipts = [];
        item.models.configured = [];
        item.models.generic = [x.text({ result: "TEST-result" })];
        update(evidence, item.id, (observation) => {
          observation.receipts = [];
          observation.businessDispatches = 0;
          observation.modelCalls = item.models[observation.strategy].length;
          observation.budget = nativePassedBudget(
            item,
            observation.strategy,
            evidence.catalog,
            evidence.report.executionSettings.effectiveBudgetLimits,
          )!;
        });
        rebind(evidence);
        assert(NativeTestSuiteSchema.safeParse(evidence.suite).success);
        assert(NativeTestReportSchema.safeParse(evidence.report).success);
        const verdict = rejectedEvidence(evidence, "scenario_not_exercised");
        assert.equal(verdict.coverage[0]!.passed, false);
        assert(verdict.coverage.slice(1).every((family) => family.passed));
      },
    );
    await t.test(
      "impossible required tools fail both actual runner and independent policy",
      async () => {
        const evidence = mutated();
        const item = evidence.suite.cases.find((value) => value.id === "read")!;
        item.models.configured[0]!.requiredTools.push("TEST_impossible_tool");
        rebind(evidence);
        assert(NativeTestReportSchema.safeParse(evidence.report).success);
        rejectedEvidence(evidence, "invalid_observation");
        const actual = await x.run([item]);
        assert.equal(actual.status, "failed");
        assert(
          actual.observations
            .find((observation) => observation.strategy === "configured")!
            .infrastructureCodes.includes("native_test_model_conflict"),
        );
      },
    );
    await t.test(
      "generic action scripts must discover exposure before dispatch",
      async () => {
        const evidence = mutated();
        const item = evidence.suite.cases.find((value) => value.id === "read")!;
        item.models.generic.shift();
        update(evidence, item.id, (observation) => {
          if (observation.strategy === "generic") {
            observation.modelCalls = item.models.generic.length;
            observation.budget = nativePassedBudget(
              item,
              "generic",
              evidence.catalog,
              evidence.report.executionSettings.effectiveBudgetLimits,
            )!;
          }
        });
        rebind(evidence);
        assert(NativeTestReportSchema.safeParse(evidence.report).success);
        rejectedEvidence(evidence, "invalid_observation");
        const actual = await x.run([item]);
        assert.equal(actual.status, "failed");
        assert(
          actual.observations
            .find((observation) => observation.strategy === "generic")!
            .infrastructureCodes.includes("native_test_model_conflict"),
        );
      },
    );
    await t.test(
      "read-only evidence cannot claim a suspended approval reopen",
      () => {
        const evidence = mutated();
        const item = evidence.suite.cases.find(
          (value) => value.id === "restart",
        )!;
        Object.assign(item, structuredClone(x.read), {
          id: "restart",
          scenario: "restart",
          reopenAt: "suspended",
        });
        const source = report.observations.filter(
          (observation) => observation.caseId === "read",
        );
        update(evidence, item.id, (observation) => {
          const read = source.find(
            (value) => value.strategy === observation.strategy,
          )!;
          Object.assign(observation, structuredClone(read), {
            caseId: "restart",
            scenario: "restart",
            reopened: true,
            runId: observation.runId,
          });
        });
        rebind(evidence);
        assert(NativeTestSuiteSchema.safeParse(evidence.suite).success);
        assert(NativeTestReportSchema.safeParse(evidence.report).success);
        rejectedEvidence(evidence, "scenario_not_exercised");
      },
    );
    await t.test(
      "an uncertain write is terminal and cannot gain a second canonical dispatch",
      () => {
        const evidence = mutated();
        const item = evidence.suite.cases.find(
          (value) => value.id === "unknown",
        )!;
        item.actions.push(structuredClone(item.actions[0]!));
        item.expected.receipts.push(
          structuredClone(item.expected.receipts[0]!),
        );
        item.models.configured.push(
          x.tool(
            "action_process_0",
            { name: "TEST-input" },
            "TEST-second-unknown-configured",
          ),
        );
        item.models.generic.splice(
          2,
          0,
          x.tool(
            x.actionName(x.h.ids.writeId),
            { name: "TEST-input" },
            "TEST-second-unknown-generic",
          ),
        );
        update(evidence, item.id, (observation) => {
          observation.receipts = structuredClone(item.expected.receipts);
          observation.approvals = 2;
          observation.businessDispatches = 2;
          observation.modelCalls = item.models[observation.strategy].length;
          observation.budget = nativePassedBudget(
            item,
            observation.strategy,
            evidence.catalog,
            evidence.report.executionSettings.effectiveBudgetLimits,
          )!;
        });
        rebind(evidence);
        assert(NativeTestSuiteSchema.safeParse(evidence.suite).success);
        assert(NativeTestReportSchema.safeParse(evidence.report).success);
        rejectedEvidence(evidence, "invalid_observation");
      },
    );
    await t.test(
      "successful output cannot hide a terminal failed or uncertain receipt",
      () => {
        const evidence = mutated();
        const item = evidence.suite.cases.find((value) => value.id === "read")!;
        item.actions[0]!.outcome = "failure";
        const { output: _output, ...receipt } = item.expected.receipts[0]!;
        item.expected.receipts[0] = {
          ...receipt,
          status: "failed",
          code: "integration_provider_failed",
        };
        update(evidence, item.id, (observation) => {
          observation.receipts = structuredClone(item.expected.receipts);
        });
        rebind(evidence);
        assert(NativeTestReportSchema.safeParse(evidence.report).success);
        rejectedEvidence(evidence, "invalid_observation");
        const text = mutated();
        text.suite.cases[0]!.models.configured.at(-1)!.reply = {
          type: "text",
          text: '{"result":"TEST-different"}',
        };
        rebind(text);
        rejectedEvidence(text, "invalid_observation");
      },
    );
    await t.test(
      "case and strategy pairing must match the frozen suite exactly",
      () => {
        const evidence = mutated();
        update(evidence, "read", (observation) => {
          observation.caseId = "forged_read";
        });
        assert(NativeTestReportSchema.safeParse(evidence.report).success);
        rejectedEvidence(evidence, "invalid_observation");
      },
    );
    await t.test(
      "an agreed case and report label cannot turn a valid input into missing-input coverage",
      () => {
        const evidence = mutated();
        evidence.suite.cases.find((item) => item.id === "missing")!.input = {
          name: "TEST-valid",
        };
        rebind(evidence);
        assert(NativeTestReportSchema.safeParse(evidence.report).success);
        const verdict = rejectedEvidence(evidence, "invalid_input_case");
        assert(
          verdict.coverage
            .find((family) => family.scenario === "missing_input")!
            .reasons.includes("scenario_not_exercised"),
        );
      },
    );
    await t.test(
      "invalid type with no missing required field is not missing-input coverage",
      () => {
        const evidence = mutated();
        evidence.suite.cases.find((item) => item.id === "missing")!.input = {
          name: 42,
        };
        rebind(evidence);
        rejectedEvidence(evidence, "invalid_input_case");
      },
    );
    await t.test(
      "rejection needs actual approved-or-denied ledger evidence",
      () => {
        const evidence = mutated();
        const item = evidence.suite.cases.find(
          (value) => value.id === "rejected",
        )!;
        item.actions = [];
        item.expected.receipts = [];
        item.models.configured = [x.text({ result: "TEST-result" })];
        item.models.generic = [x.text({ result: "TEST-result" })];
        update(evidence, item.id, (observation) => {
          observation.receipts = [];
          observation.approvals = 0;
          observation.modelCalls = 1;
          observation.budget = {
            ...observation.budget,
            accountedTokens: 15,
            accountedCostMicros: report.observations.find(
              (value) =>
                value.caseId === "failure" && value.strategy === "configured",
            )!.budget.accountedCostMicros,
          };
        });
        rebind(evidence);
        assert(NativeTestReportSchema.safeParse(evidence.report).success);
        rejectedEvidence(evidence, "scenario_not_exercised");
      },
    );
    await t.test(
      "unknown requires a dispatched uncertain write, not a relabeled uncertain read",
      () => {
        const evidence = mutated();
        const item = evidence.suite.cases.find(
          (value) => value.id === "unknown",
        )!;
        const readReceipt = x.read.expected.receipts[0]!;
        item.actions[0] = {
          ...item.actions[0]!,
          actionId: readReceipt.actionId,
          decision: "none",
        };
        item.expected.receipts[0] = {
          ...item.expected.receipts[0]!,
          actionId: readReceipt.actionId,
          actionRevision: readReceipt.actionRevision,
          effect: "read",
        };
        item.models.configured[0] = x.tool(
          "action_process_1",
          { name: "TEST-input" },
          "TEST-unknown-read-configured",
        );
        item.models.generic[1] = x.tool(
          x.actionName(readReceipt.actionId),
          { name: "TEST-input" },
          "TEST-unknown-read-generic",
        );
        update(evidence, item.id, (observation) => {
          observation.receipts = structuredClone(item.expected.receipts);
          observation.approvals = 0;
        });
        rebind(evidence);
        assert(NativeTestReportSchema.safeParse(evidence.report).success);
        rejectedEvidence(evidence, "scenario_not_exercised");
      },
    );
    await t.test(
      "failure code declarations cannot impersonate adapter domain evidence",
      () => {
        const evidence = mutated();
        const item = evidence.suite.cases.find(
          (value) => value.id === "failure",
        )!;
        item.actions = [];
        item.expected.receipts = [];
        item.expected.codes = {
          configured: "native_test_runner_failed",
          generic: "native_test_runner_failed",
        };
        update(evidence, item.id, (observation) => {
          observation.receipts = [];
          observation.businessDispatches = 0;
          observation.code = "native_test_runner_failed";
        });
        rebind(evidence);
        assert(NativeTestReportSchema.safeParse(evidence.report).success);
        rejectedEvidence(evidence, "scenario_not_exercised");
      },
    );
    await t.test(
      "restart needs an observed reopen and the replay oracle",
      () => {
        const evidence = mutated();
        update(evidence, "restart", (observation) => {
          observation.reopened = false;
        });
        assert(NativeTestReportSchema.safeParse(evidence.report).success);
        rejectedEvidence(evidence, "scenario_not_exercised");
        const replay = mutated();
        const item = replay.suite.cases.find(
          (value) => value.id === "restart",
        )!;
        item.actions.push(structuredClone(item.actions[0]!));
        item.expected.receipts.push(
          structuredClone(item.expected.receipts[0]!),
        );
        update(replay, item.id, (observation) => {
          observation.receipts = structuredClone(item.expected.receipts);
          observation.businessDispatches = 2;
          observation.approvals = 2;
        });
        rebind(replay);
        assert(NativeTestReportSchema.safeParse(replay.report).success);
        rejectedEvidence(replay, "invalid_observation");
      },
    );
    await t.test(
      "mutually matching expected and observed outputs must still satisfy the artifact schema",
      () => {
        const evidence = mutated();
        const item = evidence.suite.cases.find((value) => value.id === "read")!;
        item.expected.output = { result: 42 };
        update(evidence, item.id, (observation) => {
          observation.output = { result: 42 };
        });
        rebind(evidence);
        assert(NativeTestReportSchema.safeParse(evidence.report).success);
        rejectedEvidence(evidence, "invalid_output_case");
      },
    );
    await t.test(
      "observation outcome and actual receipt ledger cannot be forged behind passed=true",
      () => {
        const wrong = mutated();
        wrong.report.observations.find(
          (value) => value.caseId === "read" && value.strategy === "configured",
        )!.observed = "failed";
        assert(NativeTestReportSchema.safeParse(wrong.report).success);
        rejectedEvidence(wrong, "invalid_observation");
        const receipt = mutated();
        receipt.report.observations.find(
          (value) => value.caseId === "read" && value.strategy === "configured",
        )!.receipts[0]!.input = {
          name: "TEST-forged",
        };
        assert(NativeTestReportSchema.safeParse(receipt.report).success);
        rejectedEvidence(receipt, "invalid_observation");
      },
    );
    await t.test(
      "scripts, approvals and fixtures must all be consumed exactly",
      () => {
        const evidence = mutated();
        evidence.report.observations.find(
          (value) => value.caseId === "read" && value.strategy === "configured",
        )!.modelCalls--;
        recomputeComparison(evidence.report);
        assert(NativeTestReportSchema.safeParse(evidence.report).success);
        rejectedEvidence(evidence, "invalid_observation");
        const approval = mutated();
        update(approval, "rejected", (observation) => {
          observation.approvals = 0;
        });
        rejectedEvidence(approval, "invalid_observation");
        const script = mutated();
        script.suite.cases[0]!.actions.push(
          structuredClone(script.suite.cases[0]!.actions[0]!),
        );
        rebind(script);
        rejectedEvidence(script, "invalid_observation");
      },
    );
    await t.test(
      "usage is independently settled against pinned tariffs and known bounded budgets",
      () => {
        for (const mutate of [
          (value: NativeTestReport["observations"][number]["budget"]) =>
            value.accountedTokens++,
          (value: NativeTestReport["observations"][number]["budget"]) =>
            value.accountedCostMicros++,
          (value: NativeTestReport["observations"][number]["budget"]) =>
            value.unknownCalls++,
          (value: NativeTestReport["observations"][number]["budget"]) => {
            value.overrun = true;
          },
        ]) {
          const evidence = mutated();
          mutate(evidence.report.observations[0]!.budget);
          assert(NativeTestReportSchema.safeParse(evidence.report).success);
          rejectedEvidence(evidence, "budget_invalid");
        }
        const unknownTariff = mutated();
        unknownTariff.catalog.budget.prices = [];
        rebind(unknownTariff);
        rejectedEvidence(unknownTariff, "budget_invalid");
        const observeOnly = mutated();
        observeOnly.catalog.budget.mode = "observe";
        rebind(observeOnly);
        rejectedEvidence(observeOnly, "budget_invalid");
        const fakeUsage = mutated();
        fakeUsage.suite.cases[0]!.models.configured[0]!.usage.inputTokens++;
        rebind(fakeUsage);
        rejectedEvidence(fakeUsage, "budget_invalid");
        const overReserve = mutated();
        overReserve.suite.cases[0]!.models.configured[0]!.usage.inputTokens = 1_000_000;
        rebind(overReserve);
        rejectedEvidence(overReserve, "budget_invalid");
      },
    );
    await t.test(
      "declared limits and runtime safety caps must match the authoritative environment",
      () => {
        for (const mutate of [
          (value: NativeTestReport["executionSettings"]) =>
            value.declaredLimits.maxSteps++,
          (value: NativeTestReport["executionSettings"]) =>
            value.effectiveBudgetLimits.maxTokens++,
          (value: NativeTestReport["executionSettings"]) =>
            value.nativeAgentMaxStepsPerInvocation++,
          (value: NativeTestReport["executionSettings"]) =>
            value.genericSafetyLimits.maxInference++,
          (value: NativeTestReport["executionSettings"]) =>
            value.genericSafetyLimits.maxExposed++,
        ]) {
          const evidence = mutated();
          mutate(evidence.report.executionSettings);
          assert(NativeTestReportSchema.safeParse(evidence.report).success);
          rejectedEvidence(evidence, "budget_invalid");
        }
      },
    );
    await t.test(
      "matching forged counters still cannot exceed actual native invocation and generic safety caps",
      () => {
        for (const strategy of ["configured", "generic"] as const) {
          const evidence = mutated();
          const item = evidence.suite.cases.find(
            (value) => value.id === "read",
          )!;
          item.actions = [];
          item.expected.receipts = [];
          item.models = {
            configured: [x.text({ result: "TEST-result" })],
            generic: [x.text({ result: "TEST-result" })],
          };
          item.models[strategy] = Array.from({ length: 13 }, () =>
            x.text({ result: "TEST-result" }),
          );
          update(evidence, item.id, (observation) => {
            observation.receipts = [];
            observation.businessDispatches = 0;
            observation.modelCalls = item.models[observation.strategy].length;
            observation.budget = nativePassedBudget(
              item,
              observation.strategy,
              evidence.catalog,
              evidence.report.executionSettings.effectiveBudgetLimits,
            )!;
          });
          rebind(evidence);
          assert(NativeTestReportSchema.safeParse(evidence.report).success);
          rejectedEvidence(evidence, "budget_invalid");
        }
      },
    );
    await t.test(
      "all artifact, suite, catalog and software stamp fields are exact bindings",
      () => {
        for (const field of [
          "artifactDigest",
          "sourcesDigest",
          "suiteDigest",
          "catalogDigest",
          "compilerVersion",
          "runtimeVersion",
          "runnerVersion",
        ] as const) {
          const evidence = mutated();
          evidence.report.stamp[field] = field.endsWith("Digest")
            ? "f".repeat(64)
            : "TEST-wrong-version";
          assert(NativeTestReportSchema.safeParse(evidence.report).success);
          rejectedEvidence(evidence, "invalid_observation");
        }
        const artifact = mutated();
        artifact.artifact.digest = "f".repeat(64);
        rebind(artifact);
        rejectedEvidence(artifact, "invalid_observation");
        const catalog = mutated();
        catalog.catalog.services[0]!.revision++;
        rebind(catalog);
        rejectedEvidence(catalog, "invalid_observation");
      },
    );
    await t.test(
      "capabilities and strategy model selection cannot expand despite restamping",
      () => {
        const evidence = mutated();
        assert(evidence.artifact.definition.kind === "agent");
        evidence.artifact.definition.capabilities =
          evidence.artifact.definition.capabilities.filter(
            (capability) => capability.actionId !== x.h.ids.writeId,
          );
        evidence.artifact.digest = processDigest({
          definition: evidence.artifact.definition,
          sources: evidence.artifact.sources,
        });
        rebind(evidence);
        rejectedEvidence(evidence, "invalid_observation");
        const model = mutated();
        model.suite.cases[0]!.models.generic[0]!.modelId =
          "TEST-unpinned-model";
        rebind(model);
        rejectedEvidence(model, "invalid_observation");
        const expanded = mutated();
        expanded.catalog.services[0]!.actions.push({
          ...expanded.catalog.services[0]!.actions[0]!,
          id: "TEST-expanded-action",
        });
        rebind(expanded);
        rejectedEvidence(expanded, "invalid_observation");
      },
    );
    await t.test(
      "failed reports and bounded infrastructure evidence always fail qualification",
      () => {
        const evidence = mutated();
        evidence.report.observations[0]!.assertions = ["replay_dispatched"];
        evidence.report.observations[0]!.passed = false;
        recomputeComparison(evidence.report);
        assert(NativeTestReportSchema.safeParse(evidence.report).success);
        rejectedEvidence(evidence, "report_failed");
        const infrastructure = mutated();
        infrastructure.report.observations[0]!.infrastructureCodes = [
          "native_test_model_missing",
        ];
        rejectedEvidence(infrastructure, "invalid_observation");
        noProductionEffects(x);
      },
    );
  }));

test("qualification protocol is strict, bounded and deterministic, and its digest covers every record field", () =>
  setup(async (x) => {
    const suite = buildNativeQualificationSuite(x);
    const report = await x.run(suite.cases);
    const verdict = deriveNativeQualification(
      x.artifact,
      suite,
      report,
      x.catalog,
    );
    assert.equal(verdict.status, "qualified", JSON.stringify(verdict));
    for (const value of [
      { ...verdict, activationEligible: true },
      { ...verdict, liveAcceptance: true },
      { ...verdict, policy: "TEST-client-policy" },
      { ...verdict, reasons: ["missing_scenario"] },
      { ...verdict, coverage: verdict.coverage.slice(1) },
      { ...verdict, coverage: [...verdict.coverage].reverse() },
      {
        ...verdict,
        coverage: verdict.coverage.map((family) => ({
          ...family,
          caseIds: ["TEST-case", "TEST-case"],
        })),
      },
      {
        ...verdict,
        coverage: verdict.coverage.map((family) => ({
          ...family,
          reasons: ["invalid_observation", "invalid_observation"],
        })),
      },
      {
        ...verdict,
        coverage: verdict.coverage.map((family) => ({
          ...family,
          passed: false,
        })),
      },
    ])
      assert.equal(
        NativeQualificationVerdictSchema.safeParse(value).success,
        false,
      );
    const legacy = {
      ...verdict,
      policy: "native-scripted-runtime/1" as const,
      coverage: verdict.coverage.map(
        ({ applicable: _applicable, ...family }) => family,
      ),
    };
    assert.deepEqual(NativeQualificationVerdictSchema.parse(legacy), legacy);
    assert.equal(
      processDigest(NativeQualificationVerdictSchema.parse(legacy)),
      processDigest(legacy),
    );
    assert.equal(
      NativeQualificationVerdictSchema.safeParse({
        ...legacy,
        coverage: legacy.coverage.map((family) => ({
          ...family,
          applicable: false,
        })),
      }).success,
      false,
    );
    const base = {
      ...verdict,
      serverId: "TEST-server",
      ...target,
      creatorUserId: admin.userId,
      testId: "TEST-qualified-record",
      processId: x.artifact.processId,
      version: x.artifact.version,
      stamp: report.stamp,
      reportDigest: processDigest(report),
      environmentDigest: processDigest(x.catalog),
    };
    const record = NativeQualificationRecordSchema.parse({
      ...base,
      qualificationDigest: nativeQualificationDigest(base),
    });
    assert.equal(nativeQualificationDigest(base), processDigest(base));
    assert.equal(nativeQualificationDigest(record), record.qualificationDigest);
    for (const field of Object.keys(base) as (keyof typeof base)[]) {
      const changed = structuredClone(base) as Record<string, unknown>;
      changed[field] =
        field === "version"
          ? 2
          : field === "coverage"
            ? []
            : field === "stamp"
              ? { ...base.stamp, runnerVersion: "TEST-changed" }
              : "TEST-changed";
      assert.notEqual(
        processDigest(changed),
        record.qualificationDigest,
        field,
      );
    }
    assert(
      NativeQualificationSummarySchema.safeParse({
        ...verdict,
        qualificationDigest: record.qualificationDigest,
      }).success,
    );
    assert.equal(
      NativeQualificationSummarySchema.safeParse(record).success,
      false,
    );
    assert.equal(
      NativeQualificationRecordSchema.safeParse({
        ...record,
        version: Number.MAX_SAFE_INTEGER + 1,
      }).success,
      false,
    );
    assert.equal(
      NativeQualificationRecordSchema.safeParse({
        ...record,
        createdAt: "TEST-time",
      }).success,
      false,
    );
  }));

test("actual full qualification is published atomically, creator-private, immutable, replayable and stable across two reopens", () =>
  setup(async (x, path) => {
    const suite = buildNativeQualificationSuite(x);
    const report = await x.run(suite.cases);
    assert.equal(report.status, "passed", JSON.stringify(report));
    const auditStore = new AuditStore(x.h.db);
    const journal = new ProcessTestingStore(
      x.h.db,
      "TEST-server",
      x.h.registry,
      (record) => {
        auditStore.append(record);
      },
    );
    const request = NativeTestRequestSchema.parse({
      ...target,
      profile: PROCESS_NATIVE_TEST_PROFILE,
      requestId: "TEST-qualified-publication",
      processId: x.draft.id,
      revision: x.h.registry.get(admin, x.draft.id).revision,
      version: x.artifact.version,
      artifactDigest: x.artifact.digest,
      suite,
    });
    const environment = {
      catalog: x.catalog,
      executionSettings: processNativeExecutionSettings(x.artifact, x.catalog),
      authorityEpoch: 0,
    };
    const reservation = journal.reserveNative(
      admin,
      request,
      report.stamp,
      environment,
    );
    const completed = journal.completeNative(
      admin,
      reservation.job.testId,
      report,
      environment,
    );
    assert.equal(completed.status, "completed");
    assert.equal(completed.qualification?.status, "qualified");
    const qualification = completed.qualification!;
    const { qualificationDigest, ...base } = qualification;
    assert.equal(qualificationDigest, nativeQualificationDigest(base));
    assert.equal(qualification.reportDigest, processDigest(report));
    assert.equal(qualification.environmentDigest, processDigest(environment));
    assert.equal(qualification.creatorUserId, admin.userId);
    assert.equal(qualification.serverId, "TEST-server");
    assert.deepEqual(journal.readNative(admin, completed.testId), completed);
    assert.deepEqual(journal.replayNative(admin, request), completed);
    assert.throws(
      () =>
        journal.completeNative(admin, completed.testId, report, environment),
      code("process_test_terminal"),
    );
    assert.throws(
      () =>
        journal.readNative(
          { ...admin, userId: "TEST-other-owner" },
          completed.testId,
        ),
      code("process_test_not_found"),
    );
    const query = NativeTestListQuerySchema.parse({
      ...target,
      profile: PROCESS_NATIVE_TEST_PROFILE,
      processId: x.draft.id,
    });
    const summary = journal.listNative(admin, query).summaries[0]!
      .qualification!;
    assert.equal(summary.status, "qualified");
    assert.equal(summary.qualificationDigest, qualificationDigest);
    assert.deepEqual(
      Object.keys(summary).sort(),
      [
        "policy",
        "scope",
        "liveAcceptance",
        "status",
        "reasons",
        "coverage",
        "qualificationDigest",
      ].sort(),
    );
    assert.equal(
      x.h.db
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_audit WHERE json_extract(details,'$.processEvent')='native_test_qualified'",
        )
        .get()!.n,
      1,
    );
    noProductionEffects(x);
    const raw = x.h.db
      .prepare("SELECT data FROM agent_process_contract_test WHERE test_id=?")
      .get(completed.testId)!.data;
    assert.throws(
      () =>
        x.h.db
          .prepare(
            "UPDATE agent_process_contract_test SET data=? WHERE test_id=?",
          )
          .run(String(raw), completed.testId),
      /process_contract_test_immutable/,
    );
    await x.h.close();
    for (let reopen = 0; reopen < 2; reopen++) {
      const reopened = fixture(path, x.h.ids);
      try {
        const resumed = new ProcessTestingStore(
          reopened.db,
          "TEST-server",
          reopened.registry,
          (record) => {
            new AuditStore(reopened.db).append(record);
          },
        );
        assert.deepEqual(
          resumed.readNative(admin, completed.testId),
          completed,
        );
        assert.deepEqual(resumed.replayNative(admin, request), completed);
        assert.deepEqual(
          resumed.listNative(admin, query).summaries[0]!.qualification,
          summary,
        );
        assert.equal(
          reopened.registry.version(admin, x.draft.id, 1).testStatus,
          "untested",
        );
        assert.equal(
          reopened.registry.get(admin, x.draft.id).activeVersion,
          null,
        );
        assert.equal(
          reopened.db
            .prepare(
              "SELECT COUNT(*) AS n FROM agent_audit WHERE json_extract(details,'$.processEvent')='native_test_qualified'",
            )
            .get()!.n,
          1,
        );
      } finally {
        await reopened.close();
      }
    }
  }));

test("qualified audit failure rolls back report, verdict and audit together while retaining the running reservation", () =>
  setup(async (x) => {
    const suite = buildNativeQualificationSuite(x);
    const report = await x.run(suite.cases);
    assert.equal(report.status, "passed", JSON.stringify(report));
    const auditStore = new AuditStore(x.h.db);
    const journal = new ProcessTestingStore(
      x.h.db,
      "TEST-server",
      x.h.registry,
      (record) => {
        auditStore.append(record);
        if (record.details.processEvent === "native_test_qualified")
          throw Error("TEST qualification audit unavailable");
      },
    );
    const request = NativeTestRequestSchema.parse({
      ...target,
      profile: PROCESS_NATIVE_TEST_PROFILE,
      requestId: "TEST-qualified-rollback",
      processId: x.draft.id,
      revision: x.h.registry.get(admin, x.draft.id).revision,
      version: x.artifact.version,
      artifactDigest: x.artifact.digest,
      suite,
    });
    const environment = {
      catalog: x.catalog,
      executionSettings: processNativeExecutionSettings(x.artifact, x.catalog),
      authorityEpoch: 0,
    };
    const reservation = journal.reserveNative(
      admin,
      request,
      report.stamp,
      environment,
    );
    assert.throws(
      () =>
        journal.completeNative(
          admin,
          reservation.job.testId,
          report,
          environment,
        ),
      /TEST qualification audit unavailable/,
    );
    assert.deepEqual(
      journal.readNative(admin, reservation.job.testId),
      reservation.job,
    );
    assert.equal(
      x.h.db
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_audit WHERE json_extract(details,'$.processEvent') IN ('native_test_completed','native_test_qualified')",
        )
        .get()!.n,
      0,
    );
    noProductionEffects(x);
  }));
