import {
  LoopActionDetailsSchema,
  LoopDetailSchema,
  type LoopNode,
  type LoopEdge,
} from "../packages/protocol/loops";
import { adminLoopsFixture, loopsFixturePage } from "./loops-admin-fixtures";
import {
  loopDetailSections,
  projectLoop,
} from "../apps/server-admin/web/lib/loop-summary";

const node = (
  id: string,
  kind: LoopNode["kind"],
  status: LoopNode["status"] = "succeeded",
): LoopNode => ({
  id,
  kind,
  label: id,
  status,
  startedAt: null,
  finishedAt: null,
  details: [],
});
const chain = (nodes: LoopNode[]): LoopEdge[] =>
  nodes.slice(1).map((target, index) => ({
    id: `e${index}`,
    source: nodes[index]!.id,
    target: target.id,
    kind:
      target.kind === "result" && nodes[index]!.kind === "tool"
        ? "result"
        : "flow",
  }));
const action = LoopActionDetailsSchema.parse({
  operationId: "test_op",
  serviceName: "TEST CRM",
  actionName: "Update contact",
  effect: "write",
  status: "succeeded",
  phase: "execution",
  input: [{ label: "Phone", value: "+420 777 000 111" }],
  output: [{ label: "Result", value: "Updated" }],
  inputTruncated: false,
  outputTruncated: false,
});

test("overview keeps models and every call, merging only an exact result and retaining action fields", () => {
  const nodes = [
    node("request", "request"),
    node("model", "model"),
    node("find_service", "tool"),
    node("discovery_result", "result"),
    { ...node("write", "tool"), action },
    {
      ...node("write_result", "result"),
      action,
      details: [{ label: "Outcome", value: "Updated" }],
    },
    node("compose_card", "tool"),
    node("composer_result", "result"),
    node("reply", "reply"),
  ];
  const result = projectLoop(nodes, chain(nodes), "summary");
  expect(result.nodes.map((step) => step.id)).toEqual([
    "request",
    "model",
    "find_service",
    "write",
    "compose_card",
    "reply",
  ]);
  expect(result.nodes[3]!.action).toEqual(action);
  expect(result.nodes[3]!.details).toEqual([
    { label: "Outcome", value: "Updated" },
  ]);
  expect(result.edges.map((edge) => [edge.source, edge.target])).toEqual([
    ["request", "model"],
    ["model", "find_service"],
    ["find_service", "write"],
    ["write", "compose_card"],
    ["compose_card", "reply"],
  ]);
  expect(result.hiddenCount).toBe(3);
  expect(nodes[4]!.details).toEqual([]);
});

test("proposal and later execution of the same operation remain separate evidence", () => {
  const proposal = {
    ...node("proposal", "tool", "waiting"),
    action: {
      ...action,
      phase: "proposal" as const,
      status: "awaiting_approval" as const,
      output: [],
    },
  };
  const execution = { ...node("executed", "result"), action };
  const nodes = [
    node("request", "request"),
    proposal,
    execution,
    node("reply", "reply"),
  ];
  const result = projectLoop(nodes, chain(nodes), "summary");
  expect(result.nodes.map((step) => step.id)).toEqual([
    "request",
    "proposal",
    "executed",
    "reply",
  ]);
  expect(result.nodes[1]!.action!.status).toBe("awaiting_approval");
  expect(result.nodes[2]!.action!.status).toBe("succeeded");
});

test("important validation repair, runtime work, memory actions and failed outcomes remain", () => {
  const nodes = [
    node("request", "request"),
    {
      ...node("checker", "decision"),
      details: [{ label: "Choice", value: "incomplete" }],
    },
    node("active_model", "model", "running"),
    node("memory_revise", "tool"),
    node("failed_tool", "tool", "failed"),
    node("unknown_check", "decision", "unknown"),
    node("reply", "reply"),
  ];
  const result = projectLoop(nodes, chain(nodes), "summary");
  expect(result.nodes.map((step) => step.id)).toEqual(
    nodes.map((step) => step.id),
  );
});

test("waiting and unknown routine steps or orphan results remain visible", () => {
  const nodes = [
    node("request", "request"),
    node("find_service", "tool", "waiting"),
    node("compose_card", "tool", "unknown"),
    node("orphan_result", "result", "unknown"),
    node("reply", "reply"),
  ];
  const edges = chain(nodes);
  edges[2]!.kind = "flow";
  expect(
    projectLoop(nodes, edges, "summary").nodes.map((step) => step.id),
  ).toEqual(nodes.map((step) => step.id));
});

test("retry edges keep the validation that triggered another attempt", () => {
  const nodes = [
    node("request", "request"),
    node("checker", "decision"),
    node("retry_model", "model"),
    node("reply", "reply"),
  ];
  const edges = chain(nodes);
  edges[1]!.kind = "retry";
  const result = projectLoop(nodes, edges, "summary");
  expect(result.nodes.map((step) => step.id)).toEqual(
    nodes.map((step) => step.id),
  );
  expect(
    result.edges.some(
      (edge) =>
        edge.source === "checker" &&
        edge.target === "retry_model" &&
        edge.kind === "retry",
    ),
  ).toBe(true);
});

test("interleaved results cannot invent backward flow or conflate different operations", () => {
  const a = { ...node("a", "tool"), action };
  const b = {
    ...node("b", "tool"),
    action: { ...action, operationId: "different_op" },
  };
  const ra = { ...node("ra", "result"), action };
  const rb = { ...node("rb", "result"), action: b.action };
  const nodes = [
    node("request", "request"),
    a,
    b,
    ra,
    rb,
    node("reply", "reply"),
  ];
  const edges = [
    ...chain(nodes),
    { id: "a_result", source: "a", target: "ra", kind: "result" as const },
    { id: "b_result", source: "b", target: "rb", kind: "result" as const },
  ];
  const result = projectLoop(nodes, edges, "summary");
  expect(result.nodes.map((step) => step.id)).toEqual([
    "request",
    "a",
    "b",
    "reply",
  ]);
  expect(
    result.edges.some((edge) => edge.source === "b" && edge.target === "a"),
  ).toBe(false);
  expect(result.nodes[1]!.action!.operationId).toBe("test_op");
  expect(result.nodes[2]!.action!.operationId).toBe("different_op");
});

test("cycles and missing evidence are bounded and do not create a fabricated connector", () => {
  const nodes = [
    node("request", "request"),
    node("model", "model"),
    node("reply", "reply"),
  ];
  const edges: LoopEdge[] = [
    { id: "to_model", source: "request", target: "model", kind: "flow" },
    { id: "cycle", source: "model", target: "model", kind: "flow" },
    { id: "dangling", source: "model", target: "absent", kind: "flow" },
  ];
  const result = projectLoop(nodes, edges, "summary");
  expect(result.nodes.map((step) => step.id)).toEqual([
    "request",
    "model",
    "reply",
  ]);
  expect(result.edges.map((edge) => [edge.source, edge.target])).toEqual([
    ["request", "model"],
  ]);
  expect(projectLoop(nodes, edges, "all")).toMatchObject({
    nodes,
    edges,
    hiddenCount: 0,
  });
});

test("inspector puts content first and model identifiers, timing support and checker prompts behind disclosure", () => {
  const checker = {
    ...node("checker", "decision"),
    details: [
      { label: "Choice", value: "incomplete" },
      { label: "Question", value: "TEST validation question" },
      { label: "Confidence", value: "0.9" },
      { label: "Model", value: "TEST model" },
    ],
  };
  const split = loopDetailSections(checker);
  expect(split.content.map((detail) => detail.label)).toEqual(["Choice"]);
  expect(split.technical.map((detail) => detail.label)).toEqual([
    "Question",
    "Confidence",
    "Model",
  ]);
});

test("synthetic read, write, proposal and unavailable result graphs have bound edges", () => {
  for (const run of loopsFixturePage.entries) {
    const trace = LoopDetailSchema.parse(
      adminLoopsFixture(
        new URL(
          `http://test/admin/api/identity/loops/${run.id}?organizationId=test_org`,
        ),
      ).body,
    );
    const ids = new Set(trace.nodes.map((node) => node.id));
    for (const edge of trace.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
  }
});
