import type { ProcessVersion } from "../../packages/protocol/service-processes";
import {
  NativeTestExecutionSettingsSchema,
  type NativeTestSuite,
} from "../../packages/protocol/process-native-testing";
import type { ProcessTestCatalog } from "./process-test-catalog";
import { processDigest } from "./process-validation";
import { processCompilerVersion } from "../server-agent/process-workflow";
import { PROCESS_NATIVE_TEST_RUNTIME_VERSION } from "../server-agent/process-native-experiment";
import { NATIVE_AGENT_MAX_STEPS } from "../server-agent/runtime";
import { NATIVE_DOMAIN_SAFETY_LIMITS } from "./mastra-domain";

/** Passive authoritative environment shared by comparison and qualification. */
export const PROCESS_NATIVE_TEST_RUNNER_VERSION =
  "niaro-native-scripted-comparison/1";
export function processNativeStamp(
  artifact: ProcessVersion,
  catalog: ProcessTestCatalog,
  suite: NativeTestSuite,
) {
  return {
    artifactDigest: artifact.digest,
    sourcesDigest: processDigest(artifact.sources),
    suiteDigest: processDigest(suite),
    compilerVersion: processCompilerVersion(artifact.definition),
    runtimeVersion: PROCESS_NATIVE_TEST_RUNTIME_VERSION,
    runnerVersion: PROCESS_NATIVE_TEST_RUNNER_VERSION,
    catalogDigest: processDigest(catalog),
  };
}
export function processNativeExecutionSettings(
  artifact: ProcessVersion,
  catalog: ProcessTestCatalog,
) {
  return NativeTestExecutionSettingsSchema.parse({
    transport: "scripted_only",
    serviceAuth: "synthetic_none",
    savedMemory: "empty_read_only",
    optionalPlugins: "disabled",
    genericDecision: "disabled",
    usage: "scripted_tokens_tariff",
    declaredLimits: artifact.definition.limits,
    effectiveBudgetLimits: {
      maxDurationMs: Math.min(artifact.definition.limits.maxDurationMs, 30000),
      maxTokens: Math.min(
        artifact.definition.limits.maxTokens,
        catalog.budget.maxTokens,
      ),
      maxCostMicros: Math.min(
        artifact.definition.limits.maxCostMicros,
        catalog.budget.maxCostMicros,
      ),
      maxModelCalls: artifact.definition.limits.maxModelCalls,
    },
    nativeAgentMaxStepsPerInvocation: NATIVE_AGENT_MAX_STEPS,
    genericSafetyLimits: NATIVE_DOMAIN_SAFETY_LIMITS,
  });
}
