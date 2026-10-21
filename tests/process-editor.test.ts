import type { DesignCapabilities } from "../packages/protocol/process-design";
import type { ProcessStep } from "../packages/protocol/service-processes";
import {
  addStep,
  attachStep,
  connectStep,
  createWorkflow,
  disconnectStep,
  insertStep,
  openPorts,
  parseDraftWorkflow,
  parseEditorDefinition,
  removeStep,
  setEntry,
  UNCONNECTED,
  renameStep,
  structuralProblems,
  workflowEdges,
  type Workflow,
} from "../apps/server-admin/web/lib/process-editor";
import {
  designUiCandidate,
  designUiCapabilities,
} from "./admin-design-fixtures";

function branched(): Workflow {
  const value = structuredClone(designUiCandidate);
  if (value.kind !== "workflow") throw Error("TEST workflow expected");
  return value;
}

test("manual initial workflow needs no provider and supports strict incomplete-form validation", () => {
  const definition = createWorkflow({
    ...designUiCapabilities,
    services: [],
    models: [],
  });
  expect(definition.trigger).toBe("manual");
  expect(definition.entry).toBe("finish");
  expect(definition.outputSchema).toEqual({
    type: "object",
    properties: { result: { type: "string" } },
    required: ["result"],
    additionalProperties: false,
  });
  expect(definition.steps[0]).toEqual({
    id: "finish",
    type: "return",
    output: { result: { source: "literal", value: "" } },
  });
  expect(structuralProblems(definition)).toEqual([]);
  expect(parseEditorDefinition(definition).success).toBe(true);
  expect(
    parseEditorDefinition({
      ...definition,
      limits: { ...definition.limits, maxTokens: "100" },
    }).success,
  ).toBe(false);
  expect(
    parseEditorDefinition({ ...definition, name: "", expression: "run()" })
      .success,
  ).toBe(false);
});

test("adding typed nodes retains the graph and surfaces an unconnected return", () => {
  const initial = createWorkflow(designUiCapabilities);
  const action = addStep(initial, "action", designUiCapabilities);
  const agent = addStep(action, "agent", designUiCapabilities);
  const branch = addStep(agent, "branch", designUiCapabilities);
  expect(initial.steps).toHaveLength(1);
  expect(branch.entry).toBe("branch_1");
  expect(workflowEdges(branch)).toEqual([
    { from: "action_1", to: "finish" },
    { from: "agent_1", to: "action_1" },
    { from: "branch_1", to: "agent_1", label: "true" },
    { from: "branch_1", to: "agent_1", label: "false" },
  ]);
  expect(structuralProblems(branch)).toEqual([]);
  const extraReturn = addStep(branch, "return", designUiCapabilities);
  expect(extraReturn.entry).toBe(branch.entry);
  expect(structuralProblems(extraReturn)).toEqual([
    "process_editor_unreachable_step",
  ]);
  expect(removeStep(extraReturn, "return_1")).toEqual(branch);
});

test.each(["action", "agent", "branch"] as const)(
  "inserting %s into a next port preserves the entry and subsequent path",
  (type) => {
    const original = branched();
    const before = structuredClone(original);
    const updated = insertStep(
      original,
      "lookup",
      "next",
      type,
      designUiCapabilities,
    );
    const inserted = updated.steps.find(
      (step) => !original.steps.some((prior) => prior.id === step.id),
    )!;
    expect(updated.entry).toBe(original.entry);
    expect(updated.steps.find((step) => step.id === "lookup")).toEqual({
      ...original.steps[0],
      next: inserted.id,
    });
    expect(
      workflowEdges(updated).filter((edge) => edge.from === inserted.id),
    ).toEqual(
      type === "branch"
        ? [
            { from: inserted.id, to: "check", label: "true" },
            { from: inserted.id, to: "check", label: "false" },
          ]
        : [{ from: inserted.id, to: "check" }],
    );
    expect(
      updated.steps.filter(
        (step) => step.id !== "lookup" && step.id !== inserted.id,
      ),
    ).toEqual(original.steps.slice(1));
    expect(structuralProblems(updated)).toEqual([]);
    expect(original).toEqual(before);
  },
);

test.each(["whenTrue", "whenFalse"] as const)(
  "inserting into branch %s retains the other edge and source condition",
  (port) => {
    const original = branched();
    const source = original.steps.find((step) => step.id === "check");
    if (!source || source.type !== "branch")
      throw Error("TEST branch expected");
    const updated = insertStep(
      original,
      "check",
      port,
      "action",
      designUiCapabilities,
    );
    const inserted = updated.steps[updated.steps.length - 1]!;
    const branch = updated.steps.find((step) => step.id === "check");
    const other = port === "whenTrue" ? "whenFalse" : "whenTrue";
    expect(branch).toEqual({ ...source, [port]: inserted.id });
    expect(branch).toMatchObject({
      [other]: source[other],
      condition: source.condition,
    });
    expect(inserted).toMatchObject({ type: "action", next: source[port] });
    expect(updated.entry).toBe("lookup");
    expect(updated.steps.find((step) => step.id === "finish")).toEqual(
      original.steps.find((step) => step.id === "finish"),
    );
    expect(structuralProblems(updated)).toEqual([]);
  },
);

test("inserting a terminal return keeps displaced downstream nodes for explicit cleanup", () => {
  const original = branched();
  const updated = insertStep(
    original,
    "lookup",
    "next",
    "return",
    designUiCapabilities,
  );
  const terminal = updated.steps[updated.steps.length - 1]!;
  expect(terminal).toEqual({ id: "return_1", type: "return", output: {} });
  expect(updated.entry).toBe("lookup");
  expect(updated.steps.find((step) => step.id === "lookup")).toMatchObject({
    next: terminal.id,
  });
  expect(updated.steps.slice(1, original.steps.length)).toEqual(
    original.steps.slice(1),
  );
  expect(updated.steps).toHaveLength(original.steps.length + 1);
  expect(structuralProblems(updated)).toEqual([
    "process_editor_unreachable_step",
  ]);
});

test("insertion rejects missing sources, impossible ports and dangling or ambiguous targets", () => {
  const original = branched();
  expect(() =>
    insertStep(original, "missing", "next", "action", designUiCapabilities),
  ).toThrow("process_editor_step_not_found");
  for (const [id, port] of [
    ["finish", "next"],
    ["lookup", "whenTrue"],
    ["check", "next"],
  ] as const)
    expect(() =>
      insertStep(original, id, port, "action", designUiCapabilities),
    ).toThrow("process_editor_invalid");
  const dangling = branched();
  const source = dangling.steps[0]!;
  if (source.type !== "action") throw Error("TEST action expected");
  source.next = "absent";
  expect(() =>
    insertStep(dangling, "lookup", "next", "branch", designUiCapabilities),
  ).toThrow("process_editor_invalid");
  const duplicate = branched();
  duplicate.steps.push(structuredClone(duplicate.steps[1]!));
  expect(() =>
    insertStep(duplicate, "lookup", "next", "action", designUiCapabilities),
  ).toThrow("process_editor_invalid");
  expect(original).toEqual(branched());
});

test("insertion cannot widen node limits or substitute unavailable action/model capabilities", () => {
  const original = branched();
  expect(() =>
    insertStep(original, "check", "whenTrue", "action", {
      ...designUiCapabilities,
      services: [],
    }),
  ).toThrow("process_editor_capability_unavailable");
  expect(() =>
    insertStep(original, "lookup", "next", "agent", {
      ...designUiCapabilities,
      models: [],
    }),
  ).toThrow("process_editor_capability_unavailable");
  const bounded = branched();
  bounded.limits.maxSteps = bounded.steps.length;
  expect(() =>
    insertStep(bounded, "lookup", "next", "return", designUiCapabilities),
  ).toThrow("process_editor_limit_exceeded");
  expect(original).toEqual(branched());
});

test("rename preserves both branch exits, agent/return bindings, paths and literal values", () => {
  const original = branched();
  const agent = original.steps.find((step) => step.type === "agent");
  if (!agent || agent.type !== "agent") throw Error("TEST agent expected");
  agent.input = {
    found: { source: "step", stepId: "lookup", path: ["found"] },
    label: { source: "literal", value: "lookup" },
    input: { source: "input", path: ["lookup"] },
  };
  const renamed = renameStep(original, "lookup", "search");
  expect(renamed.entry).toBe("search");
  expect(original.entry).toBe("lookup");
  expect(renamed.steps.find((step) => step.id === "check")).toMatchObject({
    condition: { left: { source: "step", stepId: "search", path: ["found"] } },
    whenTrue: "explain",
    whenFalse: "finish",
  });
  expect(renamed.steps.find((step) => step.id === "explain")).toMatchObject({
    input: {
      found: { source: "step", stepId: "search", path: ["found"] },
      label: { source: "literal", value: "lookup" },
      input: { source: "input", path: ["lookup"] },
    },
  });
  expect(renamed.steps.find((step) => step.id === "finish")).toMatchObject({
    output: { found: { source: "step", stepId: "search", path: ["found"] } },
  });
  const terminal = renameStep(renamed, "finish", "done");
  expect(workflowEdges(terminal)).toEqual([
    { from: "search", to: "check" },
    { from: "check", to: "explain", label: "true" },
    { from: "check", to: "done", label: "false" },
    { from: "explain", to: "done" },
  ]);
  expect(structuralProblems(terminal)).toEqual([]);
});

test("rename and deletion refuse identity collisions, missing nodes and existing references", () => {
  const definition = branched();
  expect(() => renameStep(definition, "lookup", "finish")).toThrow(
    "process_editor_step_id_exists",
  );
  expect(() => renameStep(definition, "lookup", "constructor")).toThrow(
    "process_editor_step_id_invalid",
  );
  expect(() => renameStep(definition, "missing", "valid")).toThrow(
    "process_editor_step_not_found",
  );
  expect(() => removeStep(definition, "lookup")).toThrow(
    "process_editor_step_referenced",
  );
  const isolatedSource: ProcessStep = {
    id: "source",
    type: "action",
    serviceId: "unavailable_service",
    actionId: "unavailable_action",
    input: {},
    outputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    next: "finish",
  };
  const withBinding = createWorkflow(designUiCapabilities);
  withBinding.steps.push(isolatedSource);
  withBinding.steps[0] = {
    id: "finish",
    type: "return",
    output: { result: { source: "step", stepId: "source", path: [] } },
  };
  expect(() => removeStep(withBinding, "source")).toThrow(
    "process_editor_step_referenced",
  );
});

test("topology diagnostics distinguish duplicate, missing, dangling and unreachable nodes", () => {
  const definition = branched();
  definition.entry = "absent";
  definition.steps.push(structuredClone(definition.steps[0]!));
  const branch = definition.steps.find((step) => step.type === "branch");
  if (!branch || branch.type !== "branch") throw Error("TEST branch expected");
  branch.whenFalse = "missing";
  branch.condition.left = { source: "step", stepId: "ghost", path: [] };
  expect(new Set(structuralProblems(definition))).toEqual(
    new Set([
      "process_editor_duplicate_step",
      "process_editor_missing_entry",
      "process_editor_dangling_edge",
      "process_editor_dangling_binding",
      "process_editor_unreachable_step",
    ]),
  );
});

test("cycles are found on selected and disconnected paths without flagging branch convergence", () => {
  expect(structuralProblems(branched())).toEqual([]);
  const connected = branched();
  const agent = connected.steps.find((step) => step.type === "agent");
  if (!agent || agent.type !== "agent") throw Error("TEST agent expected");
  agent.next = "check";
  expect(structuralProblems(connected)).toContain("process_editor_cycle");
  const disconnected = createWorkflow(designUiCapabilities);
  disconnected.steps.push({
    id: "loop",
    type: "branch",
    condition: { operator: "exists", left: { source: "literal", value: null } },
    whenTrue: "loop",
    whenFalse: "finish",
  });
  expect(new Set(structuralProblems(disconnected))).toEqual(
    new Set(["process_editor_unreachable_step", "process_editor_cycle"]),
  );
});

test("new nodes require supported capabilities while old missing references stay unchanged", () => {
  const unavailable: DesignCapabilities = {
    ...designUiCapabilities,
    services: designUiCapabilities.services.map((service) => ({
      ...service,
      enabled: false,
    })),
    models: [],
  };
  const definition = createWorkflow(designUiCapabilities);
  expect(() => addStep(definition, "action", unavailable)).toThrow(
    "process_editor_capability_unavailable",
  );
  expect(() => addStep(definition, "agent", unavailable)).toThrow(
    "process_editor_capability_unavailable",
  );
  expect(() =>
    addStep(definition, "agent", {
      ...designUiCapabilities,
      memoryModes: [],
    }),
  ).toThrow("process_editor_capability_unavailable");
  const existing = branched();
  const action = existing.steps.find((step) => step.type === "action");
  if (!action || action.type !== "action") throw Error("TEST action expected");
  action.serviceId = "missing_service";
  action.actionId = "missing_action";
  const modified = addStep(existing, "branch", unavailable);
  expect(modified.steps.find((step) => step.id === action.id)).toEqual(action);
});

test("node and model limits refuse additions rather than silently raising frozen limits", () => {
  const definition = createWorkflow(designUiCapabilities);
  definition.limits.maxSteps = 1;
  expect(() => addStep(definition, "branch", designUiCapabilities)).toThrow(
    "process_editor_limit_exceeded",
  );
  const modelBound = createWorkflow(designUiCapabilities);
  modelBound.limits.maxModelCalls = 0;
  expect(() => addStep(modelBound, "agent", designUiCapabilities)).toThrow(
    "process_editor_limit_exceeded",
  );
  const capBound = {
    ...designUiCapabilities,
    limits: { ...designUiCapabilities.limits, maxSteps: 1 },
  };
  expect(() =>
    addStep(createWorkflow(designUiCapabilities), "action", capBound),
  ).toThrow("process_editor_limit_exceeded");
  const oneAgent = addStep(
    createWorkflow(designUiCapabilities),
    "agent",
    designUiCapabilities,
  );
  oneAgent.limits.maxModelCalls = 1;
  expect(() => addStep(oneAgent, "agent", designUiCapabilities)).toThrow(
    "process_editor_limit_exceeded",
  );
});

test("removing a step reconnects its single successor; a split or terminal leaves outputs open", () => {
  const healed = removeStep(branched(), "explain");
  expect(healed.steps.find((step) => step.id === "check")).toMatchObject({
    whenTrue: "finish",
    whenFalse: "finish",
  });
  expect(structuralProblems(healed)).toEqual([]);
  const open = removeStep(branched(), "finish");
  expect(openPorts(open)).toEqual([
    { from: "check", port: "whenFalse" },
    { from: "explain", port: "next" },
  ]);
  expect(structuralProblems(open)).toContain("process_editor_open_output");
  // A draft with open outputs never passes the strict process schema.
  expect(parseEditorDefinition(open).success).toBe(false);
  expect(parseDraftWorkflow(open)).toEqual(open);
  const lone = createWorkflow(designUiCapabilities);
  const first = addStep(lone, "action", designUiCapabilities);
  expect(first.entry).toBe("action_1");
  expect(removeStep(first, "action_1").entry).toBe("finish");
  expect(() => removeStep(lone, "finish")).toThrow(
    "process_editor_entry_required",
  );
  const detached = attachStep(
    lone,
    null,
    "next",
    "branch",
    designUiCapabilities,
  );
  expect(() => removeStep(setEntry(detached, "branch_1"), "branch_1")).toThrow(
    "process_editor_entry_required",
  );
});

test("outputs disconnect, attach new steps and reconnect without cycles", () => {
  const open = disconnectStep(branched(), "explain", "next");
  expect(open.steps.find((step) => step.id === "explain")).toMatchObject({
    next: UNCONNECTED,
  });
  const attached = attachStep(
    open,
    "explain",
    "next",
    "action",
    designUiCapabilities,
  );
  const added = attached.steps.find((step) => step.id === "action_1")!;
  expect(attached.entry).toBe("lookup");
  expect(added).toMatchObject({ type: "action", next: UNCONNECTED });
  expect(attached.steps.find((step) => step.id === "explain")).toMatchObject({
    next: "action_1",
  });
  // Inserting into an open output attaches instead of failing.
  expect(
    insertStep(
      open,
      "explain",
      "next",
      "return",
      designUiCapabilities,
    ).steps.find((step) => step.id === "explain"),
  ).toMatchObject({ next: "return_1" });
  const closed = connectStep(attached, "action_1", "next", "finish");
  expect(structuralProblems(closed)).toEqual([]);
  expect(parseEditorDefinition(closed).success).toBe(true);
  expect(() => connectStep(closed, "action_1", "next", "lookup")).toThrow(
    "process_editor_cycle",
  );
  expect(() => connectStep(closed, "finish", "next", "lookup")).toThrow(
    "process_editor_invalid",
  );
  expect(() => connectStep(closed, "check", "next", "finish")).toThrow(
    "process_editor_invalid",
  );
  expect(setEntry(closed, "check").entry).toBe("check");
  expect(() => setEntry(closed, "missing")).toThrow(
    "process_editor_step_not_found",
  );
});
