import { z } from "zod";
import { IdentityId } from "./identity";
import { ProcessKey } from "./service-processes";
import {
  ProcessTestScenarioSchema,
  ProcessTestStampSchema,
} from "./process-testing";

export const PROCESS_NATIVE_QUALIFICATION_POLICY =
  "native-scripted-runtime/2" as const;
export const NativeQualificationReasonSchema = z.enum([
  "missing_scenario",
  "scenario_not_exercised",
  "report_failed",
  "invalid_observation",
  "invalid_input_case",
  "invalid_output_case",
  "budget_invalid",
]);
export type NativeQualificationReason = z.infer<
  typeof NativeQualificationReasonSchema
>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reasons = z
  .array(NativeQualificationReasonSchema)
  .max(NativeQualificationReasonSchema.options.length)
  .refine(
    (values) =>
      values.every(
        (value, index) =>
          index === 0 ||
          NativeQualificationReasonSchema.options.indexOf(values[index - 1]!) <
            NativeQualificationReasonSchema.options.indexOf(value),
      ),
    "Qualification reasons must be unique and in policy order",
  );
const coverage = z.strictObject({
  scenario: ProcessTestScenarioSchema,
  // No default: reading historical evidence must preserve its exact digest.
  // Only the historical six-family policy omits applicability.
  applicable: z.boolean().optional(),
  caseIds: z
    .array(ProcessKey)
    .max(16)
    .refine(
      (values) =>
        values.every(
          (value, index) => index === 0 || values[index - 1]! < value,
        ),
      "Qualification case IDs must be unique and sorted",
    ),
  passed: z.boolean(),
  reasons,
});

/** Runtime evidence only. A separate freshness and human decision gate owns activation. */
export const NativeQualificationVerdictSchema = z
  .strictObject({
    policy: z.enum([
      "native-scripted-runtime/1",
      PROCESS_NATIVE_QUALIFICATION_POLICY,
    ]),
    scope: z.literal("native_scripted_runtime"),
    liveAcceptance: z.literal(false),
    status: z.enum(["qualified", "failed"]),
    reasons,
    coverage: z
      .array(coverage)
      .length(ProcessTestScenarioSchema.options.length),
  })
  .refine((value) => {
    const caseIds = value.coverage.flatMap((item) => item.caseIds);
    const aggregate = NativeQualificationReasonSchema.options.filter((reason) =>
      value.coverage.some((item) => item.reasons.includes(reason)),
    );
    return (
      value.coverage.every(
        (item, index) =>
          item.scenario === ProcessTestScenarioSchema.options[index] &&
          item.passed === (item.reasons.length === 0) &&
          (value.policy === "native-scripted-runtime/1"
            ? item.applicable === undefined
            : item.applicable !== undefined) &&
          (item.applicable === false
            ? !item.reasons.includes("missing_scenario")
            : item.caseIds.length === 0
              ? item.reasons.includes("missing_scenario")
              : !item.reasons.includes("missing_scenario")),
      ) &&
      caseIds.length <= 16 &&
      new Set(caseIds).size === caseIds.length &&
      aggregate.length === value.reasons.length &&
      aggregate.every((reason, index) => value.reasons[index] === reason) &&
      (value.status === "qualified") ===
        value.coverage.every((item) => item.passed)
    );
  });
export type NativeQualificationVerdict = z.infer<
  typeof NativeQualificationVerdictSchema
>;

// Keep this module independent of process-native-testing: its jobs embed records.
export const NativeQualificationRecordSchema =
  NativeQualificationVerdictSchema.safeExtend({
    serverId: IdentityId,
    organizationId: IdentityId,
    workspaceId: IdentityId,
    creatorUserId: IdentityId,
    testId: IdentityId,
    processId: IdentityId,
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    stamp: ProcessTestStampSchema.extend({ catalogDigest: digest }),
    reportDigest: digest,
    environmentDigest: digest,
    qualificationDigest: digest,
  });
export type NativeQualificationRecord = z.infer<
  typeof NativeQualificationRecordSchema
>;

/** History reveals the bounded verdict and its immutable identity, not provenance. */
export const NativeQualificationSummarySchema =
  NativeQualificationVerdictSchema.safeExtend({ qualificationDigest: digest });
export type NativeQualificationSummary = z.infer<
  typeof NativeQualificationSummarySchema
>;
