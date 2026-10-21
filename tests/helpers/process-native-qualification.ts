import {
  NativeTestSuiteSchema,
  type NativeTestCase,
} from "../../packages/protocol/process-native-testing";
import type { buildNativeTestFixture } from "./process-native-testing";

type NativeFixture = ReturnType<typeof buildNativeTestFixture>;
type QualificationFixture = Pick<
  NativeFixture,
  "modelId" | "catalog" | "read" | "tool" | "text" | "actionName"
> & {
  h: { ids: Pick<NativeFixture["h"]["ids"], "serviceId" | "writeId"> };
};

function writeCase(
  fixture: QualificationFixture,
  decision: "approve" | "reject" = "approve",
  outcome: "complete" | "unknown" = "complete",
): NativeTestCase {
  const service = fixture.catalog.services.find(
    (item) => item.id === fixture.h.ids.serviceId,
  )!;
  const action = service.actions.find(
    (item) => item.id === fixture.h.ids.writeId,
  )!;
  const rejected = decision === "reject";
  const unknown = !rejected && outcome === "unknown";
  const { output: _output, ...receipt } = fixture.read.expected.receipts[0]!;
  return NativeTestSuiteSchema.parse({
    genericModelId: fixture.modelId,
    cases: [
      {
        ...fixture.read,
        id: rejected ? "rejected" : unknown ? "unknown" : "write",
        scenario: rejected ? "rejection" : unknown ? "unknown" : "success",
        actions: [
          {
            ...fixture.read.actions[0],
            actionId: action.id,
            decision,
            outcome,
          },
        ],
        models: {
          configured: [
            fixture.tool(
              "action_process_0",
              { name: "TEST-input" },
              "TEST-write-configured",
            ),
            ...(!rejected && !unknown
              ? [fixture.text({ result: "TEST-result" })]
              : []),
          ],
          generic: [
            fixture.tool(
              "find_actions",
              { service: service.name, need: "TEST write" },
              "TEST-write-find",
            ),
            fixture.tool(
              fixture.actionName(action.id),
              { name: "TEST-input" },
              "TEST-write-generic",
            ),
            fixture.text({
              result: unknown
                ? "The outcome is unknown; verify before retrying."
                : "TEST-result",
            }),
            ...(unknown
              ? [
                  fixture.text({
                    result: "The outcome is unknown; verify before retrying.",
                  }),
                ]
              : []),
          ],
        },
        expected: {
          outcome: rejected ? "rejected" : unknown ? "unknown" : "succeeded",
          ...(!rejected && !unknown
            ? { output: { result: "TEST-result" } }
            : {
                codes: {
                  configured: rejected
                    ? "process_action_rejected"
                    : "integration_unavailable",
                  generic: rejected
                    ? "process_action_rejected"
                    : "integration_unavailable",
                },
              }),
          receipts: [
            {
              ...receipt,
              actionId: action.id,
              actionRevision: action.revision,
              effect: "write",
              status: rejected ? "rejected" : unknown ? "unknown" : "succeeded",
              ...(!rejected && !unknown
                ? { output: { value: "TEST-result" } }
                : {}),
              ...(unknown ? { code: "integration_unavailable" } : {}),
              dispatches: rejected ? 0 : 1,
            },
          ],
        },
      },
    ],
  }).cases[0]!;
}

/** Actual native scripts: read, denied write, absent field, adapter failure, uncertain write and suspended reopen. */
export function buildNativeQualificationSuite<F extends QualificationFixture>(
  fixture: F,
) {
  const { output: _output, ...failedReceipt } =
    fixture.read.expected.receipts[0]!;
  return NativeTestSuiteSchema.parse({
    genericModelId: fixture.modelId,
    cases: [
      structuredClone(fixture.read),
      writeCase(fixture, "reject"),
      {
        ...fixture.read,
        id: "missing",
        scenario: "missing_input",
        input: {},
        actions: [],
        models: { configured: [], generic: [] },
        expected: {
          outcome: "input_invalid",
          codes: {
            configured: "process_input_invalid",
            generic: "process_input_invalid",
          },
          receipts: [],
        },
      },
      {
        ...fixture.read,
        id: "failure",
        scenario: "failure",
        actions: [{ ...fixture.read.actions[0]!, outcome: "failure" }],
        models: {
          configured: [fixture.read.models.configured[0]!],
          generic: fixture.read.models.generic,
        },
        expected: {
          outcome: "failed",
          codes: {
            configured: "integration_provider_failed",
            generic: "integration_provider_failed",
          },
          receipts: [
            {
              ...failedReceipt,
              status: "failed",
              code: "integration_provider_failed",
            },
          ],
        },
      },
      writeCase(fixture, "approve", "unknown"),
      {
        ...writeCase(fixture),
        id: "restart",
        scenario: "restart",
        reopenAt: "suspended",
      },
    ],
  });
}
