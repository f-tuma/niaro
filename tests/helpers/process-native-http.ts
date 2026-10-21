import assert from "node:assert/strict";
import {
  NativeTestRequestSchema,
  NativeTestJobSchema,
  PROCESS_NATIVE_TEST_PROFILE,
} from "../../packages/protocol/process-native-testing";
import {
  ProcessDefinitionSchema,
  ProcessVersionSchema,
} from "../../packages/protocol/service-processes";
import { DEFAULT_PROCESS_LIMITS } from "../../apps/server-identity/process-validation";
import { processObject } from "./service-process";
import { designHttpFixture } from "./process-design-http";

export const nativeHttpPath = "api/identity/catalog/processes/tests/native";
export async function nativeHttpFixture() {
  const h = await designHttpFixture(nativeHttpPath);
  let sequence = 0;
  const job = (data: unknown) => NativeTestJobSchema.parse(h.record(data).job);
  const query = (input: Record<string, string | number> = {}) =>
    new URLSearchParams({
      ...h.target,
      profile: PROCESS_NATIVE_TEST_PROFILE,
      ...Object.fromEntries(
        Object.entries(input).map(([k, v]) => [k, String(v)]),
      ),
    }).toString();
  const fresh = async () => {
    const store = h.identity["catalog"].store;
    const selected = store.processModelMetadata(
      h.target.organizationId,
      h.modelId,
    );
    h.budgetSettings.prices[0]!.maxInputTokens = 50000;
    h.budgetSettings.prices[0]!.maxOutputTokens = 1000;
    h.budgetSettings.prices[0]!.modelRevision = selected.model.revision;
    h.budgetSettings.prices[0]!.providerRevision = selected.provider.revision;
    const policy = store.inferenceBudget.policy(
      h.target.organizationId,
      h.target.workspaceId,
    );
    const budget = await h.request("owner", "api/identity/catalog/budget", {
      ...h.target,
      revision: policy.revision,
      settings: h.budgetSettings,
    });
    assert.equal(budget.status, 200, JSON.stringify(budget.data));
    const definition = ProcessDefinitionSchema.parse({
      schemaVersion: 1,
      kind: "agent",
      name: "TEST HTTP isolated agent " + ++sequence,
      description: "TEST scripted native comparison",
      trigger: "manual",
      inputSchema: processObject({ name: { type: "string" } }),
      outputSchema: processObject({ result: { type: "string" } }),
      limits: DEFAULT_PROCESS_LIMITS,
      modelId: h.modelId,
      instructions: "TEST return JSON using the assigned lookup.",
      memory: "none",
      capabilities: [{ serviceId: h.serviceId, actionId: h.actionId }],
    });
    const response = await h.request(
      "owner",
      "api/identity/catalog/processes/command",
      {
        ...h.target,
        type: "saveDraft",
        serviceId: h.serviceId,
        revision: 0,
        definition,
      },
    );
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const process = h.record(h.record(response.data).process);
    const frozen = await h.request(
      "owner",
      "api/identity/catalog/processes/command",
      {
        ...h.target,
        type: "freezeDraft",
        id: process.id,
        revision: process.revision,
      },
    );
    assert.equal(frozen.status, 200, JSON.stringify(frozen.data));
    const version = ProcessVersionSchema.parse(h.record(frozen.data).version);
    const current = h.record(h.record(frozen.data).process);
    const service = h.identity["catalog"].store.service(
      h.target.workspaceId,
      h.serviceId,
    );
    const action = service.actions.find((a) => a.id === h.actionId)!;
    const usage = { inputTokens: 10, outputTokens: 5 };
    const text = {
      modelId: h.modelId,
      requiredTools: [],
      reply: { type: "text", text: '{"result":"TEST-result"}' },
      usage,
    };
    const tool = (name: string, input: object, callId: string) => ({
      modelId: h.modelId,
      requiredTools: [name],
      reply: { type: "tool", name, input, callId },
      usage,
    });
    return NativeTestRequestSchema.parse({
      ...h.target,
      profile: PROCESS_NATIVE_TEST_PROFILE,
      requestId: "TEST-HTTP-native-" + sequence,
      processId: current.id,
      revision: current.revision,
      version: version.version,
      artifactDigest: version.digest,
      suite: {
        genericModelId: h.modelId,
        cases: [
          {
            id: "read",
            scenario: "success",
            input: { name: "TEST-input" },
            actions: [
              {
                serviceId: h.serviceId,
                actionId: h.actionId,
                input: { name: "TEST-input" },
                decision: "none",
                outcome: "complete",
                output: { value: "TEST-result" },
              },
            ],
            models: {
              configured: [
                tool(
                  "action_process_0",
                  { name: "TEST-input" },
                  "TEST-configured",
                ),
                text,
              ],
              generic: [
                tool(
                  "find_actions",
                  { service: service.name, need: "TEST lookup" },
                  "TEST-find",
                ),
                tool(
                  "action_" + h.actionId.replaceAll("-", "_"),
                  { name: "TEST-input" },
                  "TEST-generic",
                ),
                text,
              ],
            },
            expected: {
              outcome: "succeeded",
              output: { result: "TEST-result" },
              receipts: [
                {
                  serviceId: h.serviceId,
                  actionId: h.actionId,
                  serviceRevision: service.revision,
                  actionRevision: action.revision,
                  input: { name: "TEST-input" },
                  effect: "read",
                  status: "succeeded",
                  output: { value: "TEST-result" },
                  dispatches: 1,
                },
              ],
            },
          },
        ],
      },
    });
  };
  const production = () =>
    Object.fromEntries(
      [
        "agent_service_invocation",
        "agent_service_process_test",
        "agent_service_process_run",
        "agent_inference_run",
        "agent_inference_attempt",
        "agent_memory",
        "agent_memory_request",
      ].map((name) => [
        name,
        h.identity["db"].prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()!.n,
      ]),
    );
  return {
    ...h,
    request: (...args: Parameters<typeof h.request>) => {
      const [role, path, input, settings = {}] = args;
      return h.request(
        role,
        path,
        input,
        path === nativeHttpPath && input !== undefined
          ? {
              ...settings,
              signal: settings.signal ?? AbortSignal.timeout(125000),
            }
          : settings,
      );
    },
    get identity() {
      return h.identity;
    },
    job,
    query,
    fresh,
    production,
    mutateNativeHeader: h.mutateTurnHeader,
    disconnectNextNativeAtBodyEnd: h.disconnectNextTurnAtBodyEnd,
  };
}
