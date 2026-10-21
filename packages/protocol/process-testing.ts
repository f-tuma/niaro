import { z } from "zod";
import { IdentityId } from "./identity";
import { CatalogTarget, Revision } from "./service-catalog";
import { ProcessKey } from "./service-processes";

export const PROCESS_TEST_PROFILE = "agent-process-contract-tests/1" as const;
export const ProcessTestScenarioSchema = z.enum([
  "success",
  "rejection",
  "missing_input",
  "failure",
  "unknown",
  "restart",
]);
export type TestJson =
  | null
  | boolean
  | number
  | string
  | TestJson[]
  | { [key: string]: TestJson };
/** Check bounds before recursive parsing; fixtures contain data, never executable code. */
export const TestJsonSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    const queue: [unknown, number][] = [[value, 0]];
    let values = 0,
      chars = 0;
    while (queue.length) {
      const [item, depth] = queue.pop()!;
      if (++values > 6000 || depth > 16 || chars > 65536) {
        values = 6001;
        break;
      }
      if (item === null || typeof item === "boolean") continue;
      if (typeof item === "string") {
        chars += item.length;
        continue;
      }
      if (typeof item === "number" && Number.isFinite(item)) continue;
      if (
        item &&
        typeof item === "object" &&
        (Array.isArray(item) ||
          Object.getPrototypeOf(item) === Object.prototype ||
          Object.getPrototypeOf(item) === null) &&
        (!Array.isArray(item) ||
          (Object.keys(item).length === item.length &&
            Object.keys(item).every(
              (key) =>
                String(Number(key)) === key &&
                Number.isInteger(Number(key)) &&
                Number(key) >= 0 &&
                Number(key) < item.length,
            )))
      ) {
        for (const [key, child] of Object.entries(item)) {
          chars += key.length;
          if (["__proto__", "prototype", "constructor"].includes(key)) {
            values = 6001;
            break;
          }
          queue.push([child, depth + 1]);
        }
        continue;
      }
      values = 6001;
      break;
    }
    if (queue.length || values > 6000 || chars > 65536)
      ctx.addIssue({
        code: "custom",
        message: "Invalid or oversized JSON fixture",
      });
  })
  .transform((v) => v as TestJson);
export const TestObjectSchema = TestJsonSchema.refine(
  (v) => !!v && typeof v === "object" && !Array.isArray(v),
).transform((v) => v as Record<string, TestJson>);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const outcome = z.enum([
  "succeeded",
  "rejected",
  "input_invalid",
  "failed",
  "unknown",
]);
export const ProcessTestFixtureSchema = z
  .strictObject({
    nodeId: ProcessKey,
    kind: z.enum(["action", "agent"]),
    input: TestObjectSchema,
    output: TestObjectSchema.optional(),
    outcome: z.enum(["complete", "failure", "unknown"]),
    approval: z.enum(["none", "approve", "reject"]),
  })
  .refine((v) => v.outcome !== "complete" || !!v.output);
export const ProcessTestCaseSchema = z
  .strictObject({
    id: ProcessKey,
    scenario: ProcessTestScenarioSchema,
    input: TestObjectSchema,
    fixtures: z.array(ProcessTestFixtureSchema).max(64),
    expected: z.strictObject({
      outcome,
      output: TestObjectSchema.optional(),
      code: z
        .enum([
          "test_input_invalid",
          "test_rejected",
          "test_mock_failure",
          "test_mock_unknown",
          "test_step_limit",
          "process_output_invalid",
        ])
        .optional(),
    }),
    reopenAt: z.enum(["completed", "suspended"]).optional(),
  })
  .refine((v) => {
    const expected = {
      success: "succeeded",
      rejection: "rejected",
      missing_input: "input_invalid",
      failure: "failed",
      unknown: "unknown",
      restart: "succeeded",
    };
    return (
      v.expected.outcome === expected[v.scenario] &&
      (v.expected.outcome === "succeeded"
        ? !v.expected.code
        : v.scenario === "failure"
          ? [
              "test_mock_failure",
              "test_step_limit",
              "process_output_invalid",
            ].includes(v.expected.code ?? "")
          : v.expected.code ===
            {
              missing_input: "test_input_invalid",
              rejection: "test_rejected",
              unknown: "test_mock_unknown",
            }[v.scenario as "missing_input" | "rejection" | "unknown"]) &&
      (v.scenario === "restart") === !!v.reopenAt &&
      (v.expected.outcome !== "succeeded" || !!v.expected.output)
    );
  });
export const ProcessTestSuiteSchema = z
  .strictObject({ cases: z.array(ProcessTestCaseSchema).min(1).max(24) })
  .refine((v) => new Set(v.cases.map((c) => c.id)).size === v.cases.length);
export type ProcessTestSuite = z.infer<typeof ProcessTestSuiteSchema>;
export type ProcessTestCase = z.infer<typeof ProcessTestCaseSchema>;
export const ProcessTestRequestSchema = CatalogTarget.extend({
  requestId: IdentityId,
  processId: IdentityId,
  revision: Revision,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  artifactDigest: digest,
  suite: ProcessTestSuiteSchema,
});
export type ProcessTestRequest = z.infer<typeof ProcessTestRequestSchema>;
export const ProcessTestObservationSchema = z
  .strictObject({
    caseId: ProcessKey,
    scenario: ProcessTestScenarioSchema,
    runId: IdentityId,
    observed: outcome,
    output: TestObjectSchema.optional(),
    code: z
      .enum([
        "test_input_invalid",
        "test_rejected",
        "test_mock_failure",
        "test_mock_unknown",
        "test_fixture_missing",
        "test_fixture_conflict",
        "test_step_limit",
        "test_aborted",
        "test_runner_failed",
        "process_output_invalid",
        "process_checkpoint_interrupted",
      ])
      .optional(),
    visited: z.array(ProcessKey).max(128),
    calls: z
      .array(
        z.strictObject({
          nodeId: ProcessKey,
          kind: z.enum(["action", "agent"]),
          input: TestObjectSchema,
          outcome: z.enum(["complete", "failure", "unknown", "rejected"]),
        }),
      )
      .max(64),
    dispatches: z.number().int().nonnegative().max(64),
    approvals: z.number().int().nonnegative().max(64),
    reopened: z.boolean(),
    assertions: z
      .array(
        z.enum([
          "outcome_mismatch",
          "output_mismatch",
          "fixtures_unconsumed",
          "reopen_not_exercised",
          "replay_dispatched",
          "native_result_unavailable",
          "failure_code_mismatch",
          "infrastructure_failure",
        ]),
      )
      .max(8),
    passed: z.boolean(),
  })
  .refine((v) => v.passed === (v.assertions.length === 0));
export type ProcessTestObservation = z.infer<
  typeof ProcessTestObservationSchema
>;
export const ProcessTestStampSchema = z.strictObject({
  artifactDigest: digest,
  sourcesDigest: digest,
  suiteDigest: digest,
  compilerVersion: z.string().min(1).max(160),
  runtimeVersion: z.string().min(1).max(160),
  runnerVersion: z.string().min(1).max(160),
});
export const ProcessTestReportSchema = z
  .strictObject({
    profile: z.literal(PROCESS_TEST_PROFILE),
    qualification: z.literal("compiler_contract"),
    adapterMode: z.literal("closed_static_boundaries"),
    agentExecution: z.enum(["absent", "static_output"]),
    /** These reports deliberately cannot qualify production activation. */
    activationEligible: z.literal(false),
    stamp: ProcessTestStampSchema,
    datasetId: IdentityId,
    datasetVersion: z.number().int().positive(),
    experimentId: IdentityId,
    observations: z.array(ProcessTestObservationSchema).min(1).max(24),
    status: z.enum(["passed", "failed"]),
  })
  .refine(
    (v) =>
      new Set(v.observations.map((c) => c.caseId)).size ===
        v.observations.length &&
      (v.status === "passed") ===
        v.observations.every((c) => c.passed && c.assertions.length === 0),
  );
export type ProcessTestReport = z.infer<typeof ProcessTestReportSchema>;
export const ProcessTestJobSchema = CatalogTarget.extend({
  profile: z.literal(PROCESS_TEST_PROFILE),
  testId: IdentityId,
  requestId: IdentityId,
  processId: IdentityId,
  version: z.number().int().positive(),
  stamp: ProcessTestStampSchema,
  status: z.enum(["running", "completed", "failed", "interrupted"]),
  report: ProcessTestReportSchema.nullable(),
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
}).refine((v) =>
  v.status === "completed"
    ? v.report?.status === "passed" && v.failure === null
    : v.status === "failed"
      ? v.report?.status === "failed" && v.failure === null
      : v.status === "interrupted"
        ? v.report === null && v.failure !== null
        : v.report === null && v.failure === null,
);
export type ProcessTestJob = z.infer<typeof ProcessTestJobSchema>;
