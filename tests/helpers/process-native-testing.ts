import assert from "node:assert/strict";
import {
  NativeTestSuiteSchema,
  NativeTestModelStepSchema,
  type NativeTestCase,
} from "../../packages/protocol/process-native-testing";
import { runProcessNativeComparison } from "../../apps/server-identity/process-native-testing";
import { fixture, admin } from "./service-process-runtime";
import { processAgent } from "./service-process-agent";
const signal = () => new AbortController().signal;
const usage = { inputTokens: 10, outputTokens: 5 };
export function buildNativeTestFixture(h: ReturnType<typeof fixture>) {
  const definition = processAgent(h);
  const draft = h.registry.saveDraft(admin, {
    serviceId: h.ids.serviceId,
    revision: 0,
    definition,
  });
  const artifact = h.registry.freezeDraft(admin, draft.id, draft.revision);
  assert(definition.kind === "agent");
  const modelId = definition.modelId;
  const catalog = h.catalog.processTestCatalog(
    admin.organizationId,
    admin.workspaceId,
    admin,
    artifact.sources,
    modelId,
  );
  const tool = (name: string, input: object, callId: string) =>
    NativeTestModelStepSchema.parse({
      modelId,
      requiredTools: [name],
      reply: { type: "tool", name, input, callId },
      usage,
    });
  const text = (output: object) =>
    NativeTestModelStepSchema.parse({
      modelId,
      requiredTools: [],
      reply: { type: "text", text: JSON.stringify(output) },
      usage,
    });
  const service = catalog.services.find((s) => s.id === h.ids.serviceId)!;
  const actionName = (id: string) => "action_" + id.replaceAll("-", "_");
  const read: NativeTestCase = NativeTestSuiteSchema.parse({
    genericModelId: modelId,
    cases: [
      {
        id: "read",
        scenario: "success",
        input: { name: "TEST-input" },
        actions: [
          {
            serviceId: h.ids.serviceId,
            actionId: h.ids.readId,
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
              "TEST-call-configured",
            ),
            text({ result: "TEST-result" }),
          ],
          generic: [
            tool(
              "find_actions",
              { service: service.name, need: "TEST read" },
              "TEST-find",
            ),
            tool(
              actionName(h.ids.readId),
              { name: "TEST-input" },
              "TEST-call-generic",
            ),
            text({ result: "TEST-result" }),
          ],
        },
        expected: {
          outcome: "succeeded",
          output: { result: "TEST-result" },
          receipts: [
            {
              serviceId: h.ids.serviceId,
              actionId: h.ids.readId,
              serviceRevision: service.revision,
              actionRevision: service.actions.find(
                (a) => a.id === h.ids.readId,
              )!.revision,
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
  const run = (
    cases: NativeTestCase[],
    authorize = async () => {},
    abortSignal = signal(),
  ) =>
    runProcessNativeComparison(
      artifact,
      catalog,
      NativeTestSuiteSchema.parse({ genericModelId: modelId, cases }),
      abortSignal,
      authorize,
    );
  return {
    h,
    draft,
    artifact,
    catalog,
    modelId,
    read,
    run,
    tool,
    text,
    actionName,
  };
}
