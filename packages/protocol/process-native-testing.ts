import { z } from "zod";
import { IdentityId } from "./identity";
import { CatalogTarget, Revision } from "./service-catalog";
import { ProcessKey, ProcessLimitsSchema } from "./service-processes";
import {
  ProcessTestScenarioSchema,
  ProcessTestStampSchema,
  TestObjectSchema,
} from "./process-testing";
import {
  NativeQualificationRecordSchema,
  NativeQualificationSummarySchema,
} from "./process-native-qualification";

export const PROCESS_NATIVE_TEST_PROFILE =
  "agent-process-native-tests/1" as const;
export const NativeTestStrategySchema = z.enum(["configured", "generic"]);
const code = z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/);
const outcome = z.enum([
  "succeeded",
  "rejected",
  "input_invalid",
  "failed",
  "unknown",
]);
const receiptStatus = z.enum(["succeeded", "failed", "unknown", "rejected"]);
export const NativeTestModelStepSchema = z.strictObject({
  modelId: IdentityId,
  requiredTools: z.array(z.string().min(1).max(160)).max(20),
  reply: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("text"), text: z.string().max(8000) }),
    z.strictObject({
      type: z.literal("tool"),
      name: z.string().min(1).max(160),
      callId: IdentityId,
      input: TestObjectSchema,
    }),
  ]),
  usage: z.strictObject({
    inputTokens: z.number().int().min(0).max(1000000),
    outputTokens: z.number().int().min(0).max(128000),
  }),
});
export const NativeTestActionFixtureSchema = z
  .strictObject({
    serviceId: IdentityId,
    actionId: IdentityId,
    input: TestObjectSchema,
    decision: z.enum(["none", "approve", "reject"]),
    outcome: z.enum(["complete", "failure", "unknown"]),
    output: TestObjectSchema.optional(),
  })
  .refine((v) => v.outcome !== "complete" || !!v.output);
const questionText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0);
export const NativeTestQuestionFixtureSchema = z.strictObject({
  question: questionText(2000),
  answer: questionText(4000),
});
// Optional and without defaults: historical suites retain their exact digest.
export const NativeTestQuestionFixturesSchema = z
  .strictObject({
    configured: z.array(NativeTestQuestionFixtureSchema).max(16),
    generic: z.array(NativeTestQuestionFixtureSchema).max(16),
  })
  .refine(
    (v) =>
      v.configured.length === v.generic.length &&
      v.configured.every(
        (fixture, index) => fixture.answer === v.generic[index]?.answer,
      ),
  );
export const NativeTestReceiptSchema = z.strictObject({
  serviceId: IdentityId,
  actionId: IdentityId,
  serviceRevision: z.number().int().nonnegative(),
  actionRevision: z.number().int().nonnegative(),
  input: TestObjectSchema,
  effect: z.enum(["read", "write"]),
  status: receiptStatus,
  output: TestObjectSchema.optional(),
  code: code.optional(),
  dispatches: z.number().int().min(0).max(1),
});
export const NativeTestCaseSchema = z
  .strictObject({
    id: ProcessKey,
    scenario: ProcessTestScenarioSchema,
    input: TestObjectSchema,
    actions: z.array(NativeTestActionFixtureSchema).max(32),
    questions: NativeTestQuestionFixturesSchema.optional(),
    models: z.strictObject({
      configured: z.array(NativeTestModelStepSchema).max(32),
      generic: z.array(NativeTestModelStepSchema).max(32),
    }),
    expected: z.strictObject({
      outcome,
      output: TestObjectSchema.optional(),
      // Strategies may report different domain codes; each must be explicit.
      codes: z
        .strictObject({ configured: code, generic: code.optional() })
        .optional(),
      receipts: z.array(NativeTestReceiptSchema).max(32),
    }),
    reopenAt: z.enum(["completed", "suspended"]).optional(),
  })
  .refine((v) => {
    const wanted = {
      success: "succeeded",
      rejection: "rejected",
      missing_input: "input_invalid",
      failure: "failed",
      unknown: "unknown",
      restart: "succeeded",
    };
    return (
      v.expected.outcome === wanted[v.scenario] &&
      (v.expected.outcome === "succeeded"
        ? !!v.expected.output && !v.expected.codes
        : !!v.expected.codes) &&
      (v.scenario === "restart") === !!v.reopenAt
    );
  });
export const NativeTestSuiteSchema = z
  .strictObject({
    // Historical comparisons omit this field and retain their original digest.
    comparisonMode: z.literal("configured_only").optional(),
    genericModelId: IdentityId.optional(),
    cases: z.array(NativeTestCaseSchema).min(1).max(16),
  })
  .refine(
    (v) =>
      new Set(v.cases.map((c) => c.id)).size === v.cases.length &&
      (v.comparisonMode === "configured_only"
        ? v.genericModelId === undefined &&
          v.cases.every(
            (c) =>
              c.models.configured.length === 0 &&
              c.models.generic.length === 0 &&
              (c.questions?.configured.length ?? 0) === 0 &&
              (c.questions?.generic.length ?? 0) === 0,
          )
        : v.genericModelId !== undefined &&
          v.cases.every(
            (c) =>
              c.expected.outcome === "succeeded" ||
              c.expected.codes?.generic !== undefined,
          )),
  );
export type NativeTestSuite = z.infer<typeof NativeTestSuiteSchema>;
export type NativeTestCase = z.infer<typeof NativeTestCaseSchema>;
export type NativeTestReceipt = z.infer<typeof NativeTestReceiptSchema>;
export const NativeTestObservationSchema = z
  .strictObject({
    caseId: ProcessKey,
    scenario: ProcessTestScenarioSchema,
    strategy: NativeTestStrategySchema,
    runId: IdentityId,
    observed: outcome,
    output: TestObjectSchema.optional(),
    code: code.optional(),
    receipts: z.array(NativeTestReceiptSchema).max(32),
    modelCalls: z.number().int().nonnegative().max(32),
    businessDispatches: z.number().int().nonnegative().max(32),
    approvals: z.number().int().nonnegative().max(32),
    reopened: z.boolean(),
    infrastructureCodes: z.array(code).max(8),
    budget: z.strictObject({
      accountedTokens: z.number().int().nonnegative(),
      accountedCostMicros: z.number().int().nonnegative(),
      unknownCalls: z.number().int().nonnegative(),
      overrun: z.boolean(),
    }),
    assertions: z
      .array(
        z.enum([
          "outcome_mismatch",
          "output_mismatch",
          "failure_code_mismatch",
          "receipt_ledger_mismatch",
          "approval_ledger_mismatch",
          "model_script_unconsumed",
          "action_fixtures_unconsumed",
          "question_fixtures_unconsumed",
          "infrastructure_failure",
          "reopen_not_exercised",
          "replay_dispatched",
          "native_result_unavailable",
        ]),
      )
      .max(12),
    passed: z.boolean(),
  })
  .refine(
    (v) =>
      v.passed === (v.assertions.length === 0) &&
      v.businessDispatches ===
        v.receipts.reduce((n, r) => n + r.dispatches, 0) &&
      (!v.infrastructureCodes.length ||
        v.assertions.includes("infrastructure_failure")),
  );
export type NativeTestObservation = z.infer<typeof NativeTestObservationSchema>;
export const NativeTestStampSchema = ProcessTestStampSchema.extend({
  catalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const NativeTestRequestSchema = CatalogTarget.extend({
  profile: z.literal(PROCESS_NATIVE_TEST_PROFILE),
  requestId: IdentityId,
  processId: IdentityId,
  revision: Revision,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  suite: NativeTestSuiteSchema,
  retestActive: z.literal(true).optional(),
});
export type NativeTestRequest = z.infer<typeof NativeTestRequestSchema>;
export const NativeTestReadQuerySchema = CatalogTarget.extend({
  profile: z.literal(PROCESS_NATIVE_TEST_PROFILE),
  testId: IdentityId,
});
export type NativeTestReadQuery = z.infer<typeof NativeTestReadQuerySchema>;
export const NativeTestListQuerySchema = CatalogTarget.extend({
  profile: z.literal(PROCESS_NATIVE_TEST_PROFILE),
  processId: IdentityId,
  version: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  after: IdentityId.optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});
export type NativeTestListQuery = z.infer<typeof NativeTestListQuerySchema>;
export const NativeTestReportSchema = z
  .strictObject({
    profile: z.literal(PROCESS_NATIVE_TEST_PROFILE),
    qualification: z.literal("native_scripted"),
    agentExecution: z.literal("native_agent_scripted_provider"),
    adapterMode: z.literal("isolated_catalog_receipts"),
    activationEligible: z.literal(false),
    executionSettings: z.strictObject({
      transport: z.literal("scripted_only"),
      serviceAuth: z.literal("synthetic_none"),
      savedMemory: z.literal("empty_read_only"),
      optionalPlugins: z.literal("disabled"),
      genericDecision: z.literal("disabled"),
      usage: z.literal("scripted_tokens_tariff"),
      declaredLimits: ProcessLimitsSchema,
      effectiveBudgetLimits: z.strictObject({
        maxDurationMs: z.number().int().positive().max(30000),
        maxTokens: z.number().int().positive(),
        maxCostMicros: z.number().int().positive(),
        maxModelCalls: z.number().int().nonnegative(),
      }),
      nativeAgentMaxStepsPerInvocation: z.number().int().positive(),
      genericSafetyLimits: z.strictObject({
        maxModelCalls: z.number().int().positive(),
        maxInference: z.number().int().positive(),
        maxActionCalls: z.number().int().positive(),
        maxExposed: z.number().int().positive(),
      }),
    }),
    stamp: NativeTestStampSchema,
    datasetId: IdentityId,
    datasetVersion: z.number().int().positive(),
    experiments: z.strictObject({
      configured: IdentityId,
      generic: IdentityId.optional(),
    }),
    observations: z.array(NativeTestObservationSchema).min(1).max(32),
    comparison: z.strictObject({
      mode: z.literal("configured_only").optional(),
      cases: z.number().int().min(1).max(16),
      configuredPassed: z.number().int().nonnegative().max(16),
      genericPassed: z.number().int().nonnegative().max(16),
      configuredModelCalls: z.number().int().nonnegative(),
      genericModelCalls: z.number().int().nonnegative(),
    }),
    status: z.enum(["passed", "failed"]),
  })
  .refine((v) => {
    const configured = v.observations.filter(
      (o) => o.strategy === "configured",
    );
    const generic = v.observations.filter((o) => o.strategy === "generic");
    const configuredOnly = v.comparison.mode === "configured_only";
    const ids = (a: typeof configured) =>
      a
        .map((o) => o.caseId)
        .sort()
        .join(",");
    return (
      configured.length === v.comparison.cases &&
      (configuredOnly
        ? generic.length === 0 && v.experiments.generic === undefined
        : generic.length === configured.length &&
          v.experiments.generic !== undefined) &&
      new Set(configured.map((o) => o.caseId)).size === configured.length &&
      (configuredOnly ||
        (ids(configured) === ids(generic) &&
          configured.every((o) =>
            generic.some(
              (g) => g.caseId === o.caseId && g.scenario === o.scenario,
            ),
          ))) &&
      configured.filter((o) => o.passed).length ===
        v.comparison.configuredPassed &&
      generic.filter((o) => o.passed).length === v.comparison.genericPassed &&
      configured.reduce((n, o) => n + o.modelCalls, 0) ===
        v.comparison.configuredModelCalls &&
      generic.reduce((n, o) => n + o.modelCalls, 0) ===
        v.comparison.genericModelCalls &&
      (v.status === "passed") === v.observations.every((o) => o.passed)
    );
  });
export const NativeTestExecutionSettingsSchema =
  NativeTestReportSchema.shape.executionSettings;
export type NativeTestExecutionSettings = z.infer<
  typeof NativeTestExecutionSettingsSchema
>;
export type NativeTestReport = z.infer<typeof NativeTestReportSchema>;
export const NativeTestJobSchema = CatalogTarget.extend({
  profile: z.literal(PROCESS_NATIVE_TEST_PROFILE),
  testId: IdentityId,
  requestId: IdentityId,
  processId: IdentityId,
  version: z.number().int().positive(),
  stamp: NativeTestStampSchema,
  status: z.enum(["running", "completed", "failed", "interrupted"]),
  report: NativeTestReportSchema.nullable(),
  // Absent on historical jobs; only the server derives this separate verdict.
  qualification: NativeQualificationRecordSchema.optional(),
  failure: z
    .enum([
      "test_server_restarted",
      "test_authority_changed",
      "test_source_changed",
      "test_aborted",
      "test_runner_failed",
    ])
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).refine((v) => {
  const q = v.qualification;
  if (
    q &&
    (!v.report ||
      q.testId !== v.testId ||
      q.processId !== v.processId ||
      q.version !== v.version ||
      q.organizationId !== v.organizationId ||
      q.workspaceId !== v.workspaceId ||
      JSON.stringify(q.stamp) !== JSON.stringify(v.stamp) ||
      JSON.stringify(q.stamp) !== JSON.stringify(v.report.stamp) ||
      (q.status === "qualified" && v.report.status !== "passed"))
  )
    return false;
  return v.status === "completed"
    ? v.report?.status === "passed" && v.failure === null
    : v.status === "failed"
      ? v.report?.status === "failed" && v.failure === null
      : v.status === "interrupted"
        ? v.report === null && v.failure !== null
        : v.report === null && v.failure === null;
});
export type NativeTestJob = z.infer<typeof NativeTestJobSchema>;
export const NativeTestDetailQuerySchema = CatalogTarget.extend({
  profile: z.literal(PROCESS_NATIVE_TEST_PROFILE),
  testId: IdentityId.optional(),
  requestId: IdentityId.optional(),
}).refine((v) => (v.testId === undefined) !== (v.requestId === undefined));
export type NativeTestDetailQuery = z.infer<typeof NativeTestDetailQuerySchema>;
export const NativeTestDetailSchema = z
  .strictObject({
    job: NativeTestJobSchema,
    request: NativeTestRequestSchema,
  })
  .refine(
    ({ job, request }) =>
      job.profile === request.profile &&
      job.organizationId === request.organizationId &&
      job.workspaceId === request.workspaceId &&
      job.requestId === request.requestId &&
      job.processId === request.processId &&
      job.version === request.version &&
      job.stamp.artifactDigest === request.artifactDigest,
  );
export type NativeTestDetail = z.infer<typeof NativeTestDetailSchema>;
// Detail negotiation is independent of the unchanged execution/report profile.
export const PROCESS_NATIVE_TEST_DETAIL_PROFILE =
  "agent-process-native-test-detail/2" as const;
export const NATIVE_TEST_DIAGNOSTIC_CODES = {
  native_test_approval_unexpected: ["native_checkpoint", "native_boundary"],
  native_test_question_fixture_conflict: [
    "native_checkpoint",
    "native_boundary",
  ],
  native_test_question_storage_missing: ["infrastructure", "native_boundary"],
  native_test_question_answer_unconsumed: [
    "native_checkpoint",
    "native_boundary",
  ],
  native_test_generic_question_missing: [
    "native_checkpoint",
    "native_boundary",
  ],
  native_test_pending_missing: ["native_checkpoint", "native_boundary"],
  native_test_process_nonterminal: ["native_checkpoint", "native_boundary"],
  native_test_generic_nonterminal: ["native_checkpoint", "native_boundary"],
  native_test_observation_invalid: ["infrastructure", "observation"],
  native_test_receipt_unavailable: ["infrastructure", "observation"],
  native_test_budget_unavailable: ["infrastructure", "observation"],
  native_test_cleanup_failed: ["infrastructure", "cleanup"],
  native_test_storage_unavailable: ["persistence", "dataset"],
  native_test_dataset_incomplete: ["infrastructure", "dataset"],
  native_test_experiment_incomplete: ["infrastructure", "experiment"],
  native_test_result_persistence_failed: ["persistence", "result_persistence"],
  native_test_experiment_result_invalid: [
    "infrastructure",
    "result_validation",
  ],
  native_test_persisted_result_conflict: ["persistence", "result_validation"],
  native_test_experiment_conflict: ["infrastructure", "result_validation"],
} as const;
export const NativeTestDiagnosticCodeSchema = z.enum(
  Object.keys(NATIVE_TEST_DIAGNOSTIC_CODES) as [
    keyof typeof NATIVE_TEST_DIAGNOSTIC_CODES,
    ...(keyof typeof NATIVE_TEST_DIAGNOSTIC_CODES)[],
  ],
);
export type NativeTestDiagnosticCode = z.infer<
  typeof NativeTestDiagnosticCodeSchema
>;
export const NativeTestDiagnosticReceiptSchema = z
  .strictObject({
    serviceId: IdentityId,
    actionId: IdentityId,
    serviceRevision: Revision,
    actionRevision: Revision,
    effect: z.enum(["read", "write"]),
    status: z.enum([
      "awaiting_approval",
      "running",
      "succeeded",
      "failed",
      "unknown",
      "rejected",
    ]),
    dispatches: z.number().int().min(0).max(1),
  })
  .refine(
    (v) =>
      !["awaiting_approval", "rejected"].includes(v.status) ||
      v.dispatches === 0,
  );
export const NativeTestDiagnosticEvidenceSchema = z
  .strictObject({
    caseId: ProcessKey,
    scenario: ProcessTestScenarioSchema,
    strategy: NativeTestStrategySchema,
    runId: IdentityId,
    checkpoint: z
      .strictObject({
        status: z.enum([
          "running",
          "waiting",
          "succeeded",
          "failed",
          "unknown",
          "cancelled",
        ]),
        pending: z.enum(["approval", "question"]).optional(),
      })
      .optional(),
    receipts: z.array(NativeTestDiagnosticReceiptSchema).max(32).optional(),
    modelCalls: z.number().int().min(0).max(32).optional(),
    businessDispatches: z.number().int().min(0).max(32).optional(),
    approvals: z.number().int().min(0).max(32).optional(),
  })
  .refine(
    (v) =>
      (!v.checkpoint?.pending || v.checkpoint.status === "waiting") &&
      (v.businessDispatches === undefined ||
        v.receipts === undefined ||
        v.businessDispatches ===
          v.receipts.reduce((n, r) => n + r.dispatches, 0)),
  );
export type NativeTestDiagnosticEvidence = z.infer<
  typeof NativeTestDiagnosticEvidenceSchema
>;
export const NativeTestDiagnosticSchema = z
  .strictObject({
    category: z.enum(["native_checkpoint", "infrastructure", "persistence"]),
    code: NativeTestDiagnosticCodeSchema,
    phase: z.enum([
      "native_boundary",
      "observation",
      "dataset",
      "experiment",
      "result_persistence",
      "result_validation",
      "cleanup",
    ]),
    evidence: NativeTestDiagnosticEvidenceSchema.optional(),
    secondaryCodes: z.array(NativeTestDiagnosticCodeSchema).max(4),
  })
  .refine((v) => {
    const [category, phase] = NATIVE_TEST_DIAGNOSTIC_CODES[v.code];
    return (
      v.category === category &&
      v.phase === phase &&
      new Set(v.secondaryCodes).size === v.secondaryCodes.length &&
      !v.secondaryCodes.includes(v.code)
    );
  });
export type NativeTestDiagnostic = z.infer<typeof NativeTestDiagnosticSchema>;
export const NativeTestDetailV2QuerySchema = CatalogTarget.extend({
  profile: z.literal(PROCESS_NATIVE_TEST_DETAIL_PROFILE),
  testId: IdentityId.optional(),
  requestId: IdentityId.optional(),
}).refine((v) => (v.testId === undefined) !== (v.requestId === undefined));
export type NativeTestDetailV2Query = z.infer<
  typeof NativeTestDetailV2QuerySchema
>;
export const NativeTestDetailV2Schema = z
  .strictObject({
    profile: z.literal(PROCESS_NATIVE_TEST_DETAIL_PROFILE),
    job: NativeTestJobSchema,
    request: NativeTestRequestSchema,
    diagnostic: NativeTestDiagnosticSchema.nullable(),
  })
  .refine(
    (v) =>
      NativeTestDetailSchema.safeParse({ job: v.job, request: v.request })
        .success &&
      (!v.diagnostic ||
        (v.job.status === "interrupted" &&
          v.job.failure === "test_runner_failed" &&
          v.job.report === null &&
          !v.job.qualification &&
          (!v.diagnostic.evidence ||
            v.request.suite.cases.some(
              (c) =>
                c.id === v.diagnostic!.evidence!.caseId &&
                c.scenario === v.diagnostic!.evidence!.scenario,
            )))),
  );
export type NativeTestDetailV2 = z.infer<typeof NativeTestDetailV2Schema>;
export const NativeTestToolsQuerySchema = CatalogTarget.extend({
  profile: z.literal(PROCESS_NATIVE_TEST_PROFILE),
  processId: IdentityId,
  version: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  genericModelId: IdentityId,
});
export type NativeTestToolsQuery = z.infer<typeof NativeTestToolsQuerySchema>;
const toolName = z.string().min(1).max(160);
export const NativeTestToolsSchema = CatalogTarget.extend({
  profile: z.literal(PROCESS_NATIVE_TEST_PROFILE),
  processId: IdentityId,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  genericModelId: IdentityId,
  configured: z
    .array(
      z.strictObject({
        nodeId: ProcessKey,
        modelId: IdentityId,
        tools: z
          .array(
            z.union([
              z.strictObject({
                name: toolName,
                serviceId: IdentityId,
                actionId: IdentityId,
              }),
              z.strictObject({ name: z.literal("ask_user") }),
            ]),
          )
          .max(17),
      }),
    )
    .max(64),
  generic: z
    .array(
      z
        .strictObject({
          name: toolName,
          serviceId: IdentityId.optional(),
          actionId: IdentityId.optional(),
        })
        .refine(
          (v) => (v.serviceId === undefined) === (v.actionId === undefined),
        ),
    )
    .max(264),
});
export type NativeTestTools = z.infer<typeof NativeTestToolsSchema>;
export const NativeTestSummarySchema = CatalogTarget.extend({
  profile: NativeTestJobSchema.shape.profile,
  testId: NativeTestJobSchema.shape.testId,
  requestId: NativeTestJobSchema.shape.requestId,
  processId: NativeTestJobSchema.shape.processId,
  version: NativeTestJobSchema.shape.version,
  stamp: NativeTestJobSchema.shape.stamp,
  status: NativeTestJobSchema.shape.status,
  failure: NativeTestJobSchema.shape.failure,
  createdAt: NativeTestJobSchema.shape.createdAt,
  updatedAt: NativeTestJobSchema.shape.updatedAt,
  reportStatus: NativeTestReportSchema.shape.status.nullable(),
  comparison: NativeTestReportSchema.shape.comparison.nullable(),
  qualification: NativeQualificationSummarySchema.optional(),
}).refine(
  (v) =>
    (v.comparison === null) === (v.reportStatus === null) &&
    (!v.qualification ||
      (v.reportStatus !== null &&
        (v.qualification.status !== "qualified" ||
          v.reportStatus === "passed"))) &&
    (v.status === "completed"
      ? v.reportStatus === "passed" && v.failure === null
      : v.status === "failed"
        ? v.reportStatus === "failed" && v.failure === null
        : v.status === "interrupted"
          ? v.reportStatus === null && v.failure !== null
          : v.reportStatus === null && v.failure === null),
);
export type NativeTestSummary = z.infer<typeof NativeTestSummarySchema>;
export const NativeTestListSchema = CatalogTarget.extend({
  profile: z.literal(PROCESS_NATIVE_TEST_PROFILE),
  summaries: z.array(NativeTestSummarySchema).max(20),
  nextAfter: IdentityId.nullable(),
});
export type NativeTestList = z.infer<typeof NativeTestListSchema>;
