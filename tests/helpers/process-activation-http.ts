import assert from "node:assert/strict";
import {
  PROCESS_ACTIVATION_PROFILE,
  ProcessActivationCommandSchema,
  ProcessActivationReceiptSchema,
  ProcessActivationReviewSchema,
} from "../../packages/protocol/process-activation";
import {
  NativeTestJobSchema,
  NativeTestModelStepSchema,
  NativeTestRequestSchema,
  NativeTestSuiteSchema,
  PROCESS_NATIVE_TEST_PROFILE,
} from "../../packages/protocol/process-native-testing";
import {
  ProcessDefinitionSchema,
  ProcessRecordSchema,
  ProcessVersionSchema,
  type ProcessVersion,
} from "../../packages/protocol/service-processes";
import { IdentityStateSchema } from "../../packages/protocol/identity";
import { DEFAULT_PROCESS_LIMITS } from "../../apps/server-identity/process-validation";
import { processObject } from "./service-process";
import { designHttpFixture } from "./process-design-http";
import { buildNativeQualificationSuite } from "./process-native-qualification";
import { nativeHttpPath } from "./process-native-http";

export const activationHttpPath = "api/identity/catalog/processes/activation";

/** Real account HTTP and persisted registry; only native model/action scripts are synthetic. */
export async function activationHttpFixture() {
  const h = await designHttpFixture(activationHttpPath);
  const ownerId = IdentityStateSchema.parse(
    (await h.request("owner", "api/identity")).data,
  ).user!.id;
  const service = h.identity["catalog"].store.service(
    h.target.workspaceId,
    h.serviceId,
  );
  const writeId = await h.catalog({
    type: "saveAction",
    serviceId: h.serviceId,
    serviceRevision: service.revision,
    revision: 0,
    settings: {
      name: "TEST isolated write",
      description: "TEST native script only",
      inputSchema: processObject({ name: { type: "string" } }),
      binding: {
        type: "http",
        method: "POST",
        path: "/items",
        parameters: [],
        body: true,
      },
      effect: "write",
      approval: "always",
      enabled: true,
      policy: { roles: ["owner", "admin"], users: [] },
    },
  });
  let sequence = 0;
  const query = (input: Record<string, string | number>) =>
    new URLSearchParams({
      ...h.target,
      profile: PROCESS_ACTIVATION_PROFILE,
      ...Object.fromEntries(
        Object.entries(input).map(([key, value]) => [key, String(value)]),
      ),
    }).toString();
  const nativeQuery = (input: Record<string, string | number>) =>
    new URLSearchParams({
      ...h.target,
      profile: PROCESS_NATIVE_TEST_PROFILE,
      ...Object.fromEntries(
        Object.entries(input).map(([key, value]) => [key, String(value)]),
      ),
    }).toString();
  const request: typeof h.request = (role, path, input, settings = {}) =>
    h.request(
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
  const process = async (id: string) => {
    const response = await request(
      "owner",
      "api/identity/catalog/processes?" +
        new URLSearchParams({ ...h.target, id }).toString(),
    );
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return ProcessRecordSchema.parse(h.record(response.data).process);
  };
  const nativeRequest = (artifact: ProcessVersion, revision: number) => {
    const catalog = h.identity["catalog"].store.processTestCatalog(
      h.target.organizationId,
      h.target.workspaceId,
      { userId: ownerId, role: "owner" },
      artifact.sources,
      h.modelId,
    );
    const selectedService = catalog.services.find(
      (item) => item.id === h.serviceId,
    )!;
    const readAction = selectedService.actions.find(
      (item) => item.id === h.actionId,
    )!;
    const usage = { inputTokens: 10, outputTokens: 5 };
    const tool = (name: string, input: object, callId: string) =>
      NativeTestModelStepSchema.parse({
        modelId: h.modelId,
        requiredTools: [name],
        reply: { type: "tool", name, input, callId },
        usage,
      });
    const text = (output: object) =>
      NativeTestModelStepSchema.parse({
        modelId: h.modelId,
        requiredTools: [],
        reply: { type: "text", text: JSON.stringify(output) },
        usage,
      });
    const actionName = (id: string) => "action_" + id.replaceAll("-", "_");
    const read = NativeTestSuiteSchema.parse({
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
                "action_process_1",
                { name: "TEST-input" },
                "TEST-read-configured",
              ),
              text({ result: "TEST-result" }),
            ],
            generic: [
              tool(
                "find_actions",
                { service: selectedService.name, need: "TEST read" },
                "TEST-read-find",
              ),
              tool(
                actionName(h.actionId),
                { name: "TEST-input" },
                "TEST-read-generic",
              ),
              text({ result: "TEST-result" }),
            ],
          },
          expected: {
            outcome: "succeeded",
            output: { result: "TEST-result" },
            receipts: [
              {
                serviceId: h.serviceId,
                actionId: h.actionId,
                serviceRevision: selectedService.revision,
                actionRevision: readAction.revision,
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
    }).cases[0]!;
    return NativeTestRequestSchema.parse({
      ...h.target,
      profile: PROCESS_NATIVE_TEST_PROFILE,
      requestId: "TEST-activation-native-" + ++sequence,
      processId: artifact.processId,
      revision,
      version: artifact.version,
      artifactDigest: artifact.digest,
      suite: buildNativeQualificationSuite({
        h: { ids: { serviceId: h.serviceId, writeId } },
        catalog,
        modelId: h.modelId,
        read,
        tool,
        text,
        actionName,
      }),
    });
  };
  const fresh = async (id?: string) => {
    const store = h.identity["catalog"].store;
    const selected = store.processModelMetadata(
      h.target.organizationId,
      h.modelId,
    );
    h.budgetSettings.prices[0]!.maxInputTokens = 50000;
    h.budgetSettings.prices[0]!.maxOutputTokens = 1000;
    h.budgetSettings.prices[0]!.modelRevision = selected.model.revision;
    h.budgetSettings.prices[0]!.providerRevision = selected.provider.revision;
    const budget = await request("owner", "api/identity/catalog/budget", {
      ...h.target,
      revision: store.inferenceBudget.policy(
        h.target.organizationId,
        h.target.workspaceId,
      ).revision,
      settings: h.budgetSettings,
    });
    assert.equal(budget.status, 200, JSON.stringify(budget.data));
    const current = id ? await process(id) : undefined;
    const definition = ProcessDefinitionSchema.parse({
      schemaVersion: 1,
      kind: "agent",
      name: "TEST activation HTTP " + (sequence + 1),
      description: "TEST scripted native qualification",
      trigger: "manual",
      inputSchema: processObject({ name: { type: "string" } }),
      outputSchema: processObject({ result: { type: "string" } }),
      limits: DEFAULT_PROCESS_LIMITS,
      modelId: h.modelId,
      instructions: "TEST return JSON using the assigned lookup.",
      memory: "none",
      capabilities: [
        { serviceId: h.serviceId, actionId: writeId },
        { serviceId: h.serviceId, actionId: h.actionId },
      ],
    });
    const saved = await request(
      "owner",
      "api/identity/catalog/processes/command",
      {
        ...h.target,
        type: "saveDraft",
        ...(id ? { id } : {}),
        serviceId: h.serviceId,
        revision: current?.revision ?? 0,
        definition,
      },
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const draft = ProcessRecordSchema.parse(h.record(saved.data).process);
    const frozen = await request(
      "owner",
      "api/identity/catalog/processes/command",
      {
        ...h.target,
        type: "freezeDraft",
        id: draft.id,
        revision: draft.revision,
      },
    );
    assert.equal(frozen.status, 200, JSON.stringify(frozen.data));
    return nativeRequest(
      ProcessVersionSchema.parse(h.record(frozen.data).version),
      ProcessRecordSchema.parse(h.record(frozen.data).process).revision,
    );
  };
  const job = (data: unknown) => NativeTestJobSchema.parse(h.record(data).job);
  const receipt = (data: unknown) =>
    ProcessActivationReceiptSchema.parse(h.record(data).receipt);
  const review = (data: unknown) =>
    ProcessActivationReviewSchema.parse(h.record(data).review);
  const runNative = async (
    input: ReturnType<typeof nativeRequest>,
    role: "owner" | "admin" = "owner",
  ) => {
    const response = await request(role, nativeHttpPath, input);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const result = job(response.data);
    assert.equal(result.status, "completed");
    assert.equal(
      result.report?.status,
      "passed",
      JSON.stringify(result.report),
    );
    return result;
  };
  const command = (
    input: ReturnType<typeof nativeRequest>,
    result: ReturnType<typeof job>,
    requestId = "TEST-decision-" + sequence,
  ) =>
    ProcessActivationCommandSchema.parse({
      ...h.target,
      profile: PROCESS_ACTIVATION_PROFILE,
      requestId,
      type: "activate",
      processId: input.processId,
      revision: input.revision,
      expectedActiveVersion: null,
      version: input.version,
      artifactDigest: input.artifactDigest,
      testId: result.testId,
      qualificationDigest: result.qualification!.qualificationDigest,
      acknowledgement: "controlled_native_test_only",
    });
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
    request,
    writeId,
    query,
    nativeQuery,
    fresh,
    nativeRequest,
    process,
    job,
    receipt,
    review,
    runNative,
    command,
    production,
    get identity() {
      return h.identity;
    },
  };
}
