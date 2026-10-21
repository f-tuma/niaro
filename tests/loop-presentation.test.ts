import {
  loopNodeRole,
  loopNodeToolName,
  loopNodeDuration,
  loopRoleLanes,
  loopNodeEvidence,
} from "../apps/server-admin/web/lib/loop-presentation";
import { loopPresentationStatus } from "../apps/server-admin/web/lib/loop-summary";
import { loopsFixtureDetail } from "./loops-admin-fixtures";

test("roles and identifiers use recorded evidence rather than friendly-name guesses", () => {
  const action = loopsFixtureDetail.nodes.find((node) => node.action)!;
  expect(loopNodeRole(action)).toBe("serviceAction");
  const unknown = {
    ...action,
    action: undefined,
    tool: undefined,
    details: [],
    label: "Friendly guessed label",
  };
  expect(loopNodeToolName(unknown)).toBeUndefined();
  expect(
    loopNodeToolName({
      ...unknown,
      details: [{ label: "Tool", value: "unknown" }],
    }),
  ).toBeUndefined();
  expect(loopNodeRole(unknown)).toBe("internalTool");
  expect(
    loopNodeToolName({
      ...unknown,
      details: [{ label: "Tool", value: "TEST_exact_tool" }],
    }),
  ).toBe("TEST_exact_tool");
});

test("card previews select meaningful inputs/results and never advertise stale output on failure or proposal", () => {
  const discovery = loopsFixtureDetail.nodes.find(
    (node) => node.id === "discovery",
  )!;
  const action = loopsFixtureDetail.nodes.find((node) => node.action)!;
  expect(loopNodeEvidence(discovery).input?.label).toBe("Need");
  expect(loopNodeEvidence(discovery).output?.label).toBe("Returned services");
  expect(loopNodeEvidence(action)).toMatchObject({
    identifier: "action_TEST_crm_search_people",
    input: { label: "Query", value: "Demo contact" },
    output: { label: "Contacts returned", value: "2" },
  });
  const failed = {
    ...action,
    action: {
      ...action.action!,
      status: "unknown" as const,
      failure: {
        code: "TEST_UNKNOWN",
        kind: "connection" as const,
        stage: "dispatch" as const,
        retry: "verify_first" as const,
        fields: [],
      },
    },
  };
  expect(loopNodeEvidence(failed).output).toBeUndefined();
  expect(loopNodeEvidence(failed).failure?.code).toBe("TEST_UNKNOWN");
  expect(
    loopNodeEvidence({
      ...action,
      action: {
        ...action.action!,
        phase: "proposal",
        status: "awaiting_approval",
      },
    }).output,
  ).toBeUndefined();
});

test("missing, withheld and truncated evidence stays distinguishable without inventing identifiers or payloads", () => {
  const node = loopsFixtureDetail.nodes.find(
    (node) => node.id === "discovery",
  )!;
  const missing = {
    ...node,
    tool: undefined,
    details: [],
    label: "find_service",
  };
  expect(loopNodeEvidence(missing)).toMatchObject({
    identifier: undefined,
    input: undefined,
    output: undefined,
  });
  expect(
    loopNodeEvidence({
      ...node,
      tool: {
        ...node.tool!,
        inputRecorded: false,
        outputRecorded: false,
        inputTruncated: true,
        outputTruncated: true,
      },
    }),
  ).toMatchObject({
    input: undefined,
    output: undefined,
    inputTruncated: true,
    outputTruncated: true,
  });
  const invalid = {
    ...node,
    tool: { ...node.tool!, outcome: "invalid_arguments" as const },
  };
  expect(loopPresentationStatus(invalid)).toBe("failed");
  expect(loopNodeEvidence(invalid).output).toBeUndefined();
  expect(
    loopPresentationStatus({
      ...node,
      status: "interrupted",
      tool: { ...node.tool!, outcome: "cancelled" },
    }),
  ).toBe("interrupted");
});

test("workflow scaffolding and actual model calls are distinct roles; wide layouts separate service actions", () => {
  const model = loopsFixtureDetail.nodes.find((node) => node.kind === "model")!;
  expect(
    loopNodeRole({
      ...model,
      details: [
        { label: "Process version", value: "1" },
        { label: "Step", value: "agent" },
      ],
    }),
  ).toBe("processStep");
  expect(loopNodeRole(model)).toBe("model");
  const lanes = loopRoleLanes(loopsFixtureDetail.nodes, true);
  expect(lanes.get("discovery")).not.toBe(lanes.get("tool_1"));
});
test("durations are measured only when both valid ordered timestamps exist", () => {
  const node = loopsFixtureDetail.nodes[0]!;
  expect(loopNodeDuration({ ...node, startedAt: null })).toBeUndefined();
  expect(
    loopNodeDuration({ ...node, finishedAt: "2000-01-01T00:00:00Z" }),
  ).toBeUndefined();
  expect(
    loopNodeDuration({
      ...node,
      startedAt: "2026-10-01T08:00:00Z",
      finishedAt: "2026-10-01T08:00:01.250Z",
    }),
  ).toBe("1.3 s");
  const lanes = loopRoleLanes(loopsFixtureDetail.nodes);
  expect(lanes.get("request")).toBe(lanes.get("reply"));
  expect(lanes.get("model_1")).not.toBe(lanes.get("tool_1"));
});
