import type { DesignCapabilities } from "../../../../packages/protocol/process-design";
import {
  ProcessDefinitionSchema,
  ProcessKey,
  type ProcessBinding,
  type ProcessData,
  type ProcessDefinition,
  type ProcessStep,
} from "../../../../packages/protocol/service-processes";

export type Workflow = Extract<ProcessDefinition, { kind: "workflow" }>;
export type WorkflowEdge = {
  from: string;
  to: string;
  label?: "true" | "false";
};
export type StepPort = "next" | "whenTrue" | "whenFalse";

/** Form drafts may be incomplete; parsing never coerces or repairs their values. */
export function parseEditorDefinition(raw: unknown) {
  return ProcessDefinitionSchema.safeParse(raw);
}
type ObjectData = Extract<ProcessData, { type: "object" }>;
const emptyObject = (): ObjectData => ({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
});
const resultObject = (): ObjectData => ({
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
  additionalProperties: false,
});
function invalid(code = "process_editor_invalid"): never {
  throw new Error(code);
}
/** An output without a following step. It exists only in editor drafts: the
 * process schema requires every output to lead somewhere, so a draft with one
 * cannot be saved until it is connected or removed. */
export const UNCONNECTED = "";
const PORTS = ["next", "whenTrue", "whenFalse"] as const;
const openPortsOf = (step: unknown) =>
  PORTS.filter(
    (port) =>
      !!step &&
      typeof step === "object" &&
      (step as Record<string, unknown>)[port] === UNCONNECTED,
  );
/** Validate everything except open outputs, which a self-reference stands in
 * for during parsing and which are restored afterwards. */
export function parseDraftWorkflow(raw: unknown): Workflow | null {
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray((raw as Workflow).steps)
  )
    return null;
  const source = raw as Workflow;
  const open = source.steps.map(openPortsOf);
  const result = parseEditorDefinition({
    ...source,
    steps: source.steps.map((step, index) =>
      open[index]!.length
        ? {
            ...step,
            ...Object.fromEntries(open[index]!.map((port) => [port, step.id])),
          }
        : step,
    ),
  });
  if (!result.success || result.data.kind !== "workflow") return null;
  return {
    ...result.data,
    steps: result.data.steps.map((step, index) =>
      open[index]!.length
        ? ({
            ...step,
            ...Object.fromEntries(
              open[index]!.map((port) => [port, UNCONNECTED]),
            ),
          } as ProcessStep)
        : step,
    ),
  };
}
function parsedWorkflow(raw: Workflow): Workflow {
  return parseDraftWorkflow(raw) ?? invalid();
}
export function openPorts(definition: Workflow) {
  return definition.steps.flatMap((step) =>
    openPortsOf(step).map((port) => ({ from: step.id, port })),
  );
}
/** The initial return is executable without selecting or invoking any capability. */
export function createWorkflow(capabilities: DesignCapabilities): Workflow {
  if (!capabilities.grammar.kinds.includes("workflow"))
    invalid("process_editor_capability_unavailable");
  return parsedWorkflow({
    schemaVersion: 1,
    kind: "workflow",
    name: "New workflow",
    description: "",
    trigger: "manual",
    inputSchema: emptyObject(),
    outputSchema: resultObject(),
    limits: { ...capabilities.limits },
    entry: "finish",
    steps: [
      {
        id: "finish",
        type: "return",
        output: { result: { source: "literal", value: "" } },
      },
    ],
  });
}
function freshId(workflow: Workflow, type: ProcessStep["type"]) {
  const ids = new Set(workflow.steps.map((step) => step.id));
  for (let index = 1; index <= 65; index++) {
    const id = `${type}_${index}`;
    if (!ids.has(id)) return id;
  }
  return invalid("process_editor_limit_exceeded");
}
/** Newly added executable nodes lead to the previous entry; return nodes need explicit wiring. */
export type ActionRef = { serviceId: string; actionId: string };
const usableAction = (
  action: DesignCapabilities["services"][number]["actions"][number],
) =>
  action.enabled && action.status === "configured" && !action.schemaUnavailable;
export function addStep(
  definition: Workflow,
  type: ProcessStep["type"],
  capabilities: DesignCapabilities,
  preferred?: ActionRef,
): Workflow {
  const workflow = parsedWorkflow(definition);
  if (
    workflow.steps.length >=
    Math.min(64, workflow.limits.maxSteps, capabilities.limits.maxSteps)
  )
    invalid("process_editor_limit_exceeded");
  const id = freshId(workflow, type);
  let step: ProcessStep;
  switch (type) {
    case "action": {
      const chosen = preferred
        ? capabilities.services.find(
            (item) => item.id === preferred.serviceId && item.enabled,
          )
        : undefined;
      const chosenAction = chosen?.actions.find(
        (item) => item.id === preferred!.actionId && usableAction(item),
      );
      if (preferred && !chosenAction)
        invalid("process_editor_capability_unavailable");
      const service =
        chosen ??
        capabilities.services.find(
          (item) =>
            item.enabled &&
            item.actions.some(
              (action) =>
                action.enabled &&
                action.status === "configured" &&
                !action.schemaUnavailable,
            ),
        );
      const action =
        chosenAction ?? service?.actions.find((item) => usableAction(item));
      if (!service || !action) invalid("process_editor_capability_unavailable");
      step = {
        id,
        type,
        serviceId: service.id,
        actionId: action.id,
        input: {},
        outputSchema: emptyObject(),
        next: workflow.entry,
      };
      break;
    }
    case "agent": {
      const model = capabilities.models.find(
        (item) => item.status === "configured" && item.tools,
      );
      const memory = capabilities.memoryModes.includes("none")
        ? "none"
        : capabilities.memoryModes[0];
      if (!model || !memory) invalid("process_editor_capability_unavailable");
      const agents = workflow.steps.filter((item) => item.type === "agent");
      if (
        agents.length >=
        Math.min(
          workflow.limits.maxModelCalls,
          capabilities.limits.maxModelCalls,
        )
      )
        invalid("process_editor_limit_exceeded");
      step = {
        id,
        type,
        modelId: model.id,
        instructions: "Describe the result.",
        capabilities: [],
        memory,
        inputSchema: emptyObject(),
        outputSchema: emptyObject(),
        input: {},
        next: workflow.entry,
      };
      break;
    }
    case "branch":
      step = {
        id,
        type,
        condition: {
          operator: "equals",
          left: { source: "literal", value: true },
          right: true,
        },
        whenTrue: workflow.entry,
        whenFalse: workflow.entry,
      };
      break;
    case "return":
      step = { id, type, output: {} };
      break;
    default:
      return invalid();
  }
  return parsedWorkflow({
    ...workflow,
    entry: type === "return" ? workflow.entry : id,
    steps: [...workflow.steps, step],
  });
}
/** Insert into one existing connection without replacing the entry or discarding other paths. */
export function insertStep(
  definition: Workflow,
  fromId: string,
  port: StepPort,
  type: ProcessStep["type"],
  capabilities: DesignCapabilities,
  preferred?: ActionRef,
): Workflow {
  const workflow = parsedWorkflow(definition);
  const sources = workflow.steps.filter((step) => step.id === fromId);
  if (!sources.length) invalid("process_editor_step_not_found");
  if (sources.length !== 1) invalid();
  const source = sources[0]!;
  let target: string;
  if (source.type === "branch" && (port === "whenTrue" || port === "whenFalse"))
    target = source[port];
  else if (
    (source.type === "action" || source.type === "agent") &&
    port === "next"
  )
    target = source.next;
  else invalid();
  if (target === UNCONNECTED)
    return attachStep(workflow, fromId, port, type, capabilities, preferred);
  if (workflow.steps.filter((step) => step.id === target).length !== 1)
    invalid();
  const added = addStep(workflow, type, capabilities, preferred);
  const inserted = added.steps[added.steps.length - 1]!;
  const steps = added.steps.map((step): ProcessStep => {
    if (step.id === source.id) return { ...step, [port]: inserted.id };
    if (step.id !== inserted.id || step.type === "return") return step;
    return step.type === "branch"
      ? { ...step, whenTrue: target, whenFalse: target }
      : { ...step, next: target };
  });
  // A new return intentionally cuts this path short. Existing downstream nodes
  // remain in the draft, so unreachable work is visible rather than deleted.
  return parsedWorkflow({ ...added, entry: workflow.entry, steps });
}
/** Add a step whose outputs are still open, optionally leading from one
 * output. An output that already led elsewhere now leads to the new step; the
 * previous target stays in the draft. */
export function attachStep(
  definition: Workflow,
  fromId: string | null,
  port: StepPort,
  type: ProcessStep["type"],
  capabilities: DesignCapabilities,
  preferred?: ActionRef,
): Workflow {
  const workflow = parsedWorkflow(definition);
  if (fromId !== null) portOf(workflow, fromId, port);
  const added = addStep(workflow, type, capabilities, preferred);
  const inserted = added.steps[added.steps.length - 1]!;
  return parsedWorkflow({
    ...added,
    entry: workflow.entry,
    steps: added.steps.map((step): ProcessStep => {
      if (step.id === fromId) return { ...step, [port]: inserted.id };
      if (step.id !== inserted.id || step.type === "return") return step;
      return step.type === "branch"
        ? { ...step, whenTrue: UNCONNECTED, whenFalse: UNCONNECTED }
        : { ...step, next: UNCONNECTED };
    }),
  });
}
function portOf(workflow: Workflow, fromId: string, port: StepPort) {
  const source = workflow.steps.find((step) => step.id === fromId);
  if (!source) invalid("process_editor_step_not_found");
  if (
    source.type === "return" ||
    (source.type === "branch" ? port === "next" : port !== "next")
  )
    invalid();
  return source;
}
/** Point one output at an existing step. Cycles are refused here as well as on
 * the canvas, because a cyclic draft can never be saved. */
export function connectStep(
  definition: Workflow,
  fromId: string,
  port: StepPort,
  toId: string,
): Workflow {
  const workflow = parsedWorkflow(definition);
  portOf(workflow, fromId, port);
  if (!workflow.steps.some((step) => step.id === toId))
    invalid("process_editor_step_not_found");
  const next = parsedWorkflow({
    ...workflow,
    steps: workflow.steps.map((step) =>
      step.id === fromId ? ({ ...step, [port]: toId } as ProcessStep) : step,
    ),
  });
  if (structuralProblems(next).includes("process_editor_cycle"))
    invalid("process_editor_cycle");
  return next;
}
export function disconnectStep(
  definition: Workflow,
  fromId: string,
  port: StepPort,
): Workflow {
  const workflow = parsedWorkflow(definition);
  portOf(workflow, fromId, port);
  return parsedWorkflow({
    ...workflow,
    steps: workflow.steps.map((step) =>
      step.id === fromId
        ? ({ ...step, [port]: UNCONNECTED } as ProcessStep)
        : step,
    ),
  });
}
/** The manual start leads to the entry step. */
export function setEntry(definition: Workflow, id: string): Workflow {
  const workflow = parsedWorkflow(definition);
  if (!workflow.steps.some((step) => step.id === id))
    invalid("process_editor_step_not_found");
  return parsedWorkflow({ ...workflow, entry: id });
}
export function workflowEdges(definition: Workflow): WorkflowEdge[] {
  return definition.steps.flatMap((step): WorkflowEdge[] => {
    if (step.type === "return") return [];
    if (step.type === "branch")
      return [
        { from: step.id, to: step.whenTrue, label: "true" as const },
        { from: step.id, to: step.whenFalse, label: "false" as const },
      ].filter((edge) => edge.to !== UNCONNECTED);
    return step.next === UNCONNECTED ? [] : [{ from: step.id, to: step.next }];
  });
}
function bindings(step: ProcessStep): ProcessBinding[] {
  return step.type === "branch"
    ? [step.condition.left]
    : Object.values(step.type === "return" ? step.output : step.input);
}
function renameBinding(binding: ProcessBinding, oldId: string, newId: string) {
  return binding.source === "step" && binding.stepId === oldId
    ? { ...binding, stepId: newId }
    : binding;
}
/** Rename only node identities; schema keys, literal values and input paths are preserved. */
export function renameStep(
  definition: Workflow,
  oldId: string,
  newId: string,
): Workflow {
  const workflow = parsedWorkflow(definition);
  if (!ProcessKey.safeParse(newId).success)
    invalid("process_editor_step_id_invalid");
  if (!workflow.steps.some((step) => step.id === oldId))
    invalid("process_editor_step_not_found");
  if (oldId !== newId && workflow.steps.some((step) => step.id === newId))
    invalid("process_editor_step_id_exists");
  const rename = (id: string) => (id === oldId ? newId : id);
  const steps = workflow.steps.map((original): ProcessStep => {
    const step = { ...original, id: rename(original.id) };
    if (step.type === "branch")
      return {
        ...step,
        condition: {
          ...step.condition,
          left: renameBinding(step.condition.left, oldId, newId),
        },
        whenTrue: rename(step.whenTrue),
        whenFalse: rename(step.whenFalse),
      };
    const mapped = Object.fromEntries(
      Object.entries(step.type === "return" ? step.output : step.input).map(
        ([key, binding]) => [key, renameBinding(binding, oldId, newId)],
      ),
    );
    return step.type === "return"
      ? { ...step, output: mapped }
      : { ...step, input: mapped, next: rename(step.next) };
  });
  return parsedWorkflow({ ...workflow, entry: rename(workflow.entry), steps });
}
/** Connections into a removed step continue to its single successor, so a
 * step can be taken out of a chain in one move. A condition with two different
 * exits has no single successor and leaves the incoming outputs open. Data
 * bindings to the step would silently change meaning, so those are refused. */
export function removeStep(definition: Workflow, id: string): Workflow {
  const workflow = parsedWorkflow(definition);
  const removed = workflow.steps.find((step) => step.id === id);
  if (!removed) invalid("process_editor_step_not_found");
  const successor =
    removed.type === "branch"
      ? removed.whenTrue === removed.whenFalse
        ? removed.whenTrue
        : UNCONNECTED
      : removed.type === "return"
        ? UNCONNECTED
        : removed.next;
  const heal = successor === id ? UNCONNECTED : successor;
  if (
    workflow.steps.length === 1 ||
    (workflow.entry === id && heal === UNCONNECTED)
  )
    invalid("process_editor_entry_required");
  if (
    workflow.steps.some(
      (step) =>
        step.id !== id &&
        bindings(step).some(
          (binding) => binding.source === "step" && binding.stepId === id,
        ),
    )
  )
    invalid("process_editor_step_referenced");
  const retarget = (to: string) => (to === id ? heal : to);
  return parsedWorkflow({
    ...workflow,
    entry: retarget(workflow.entry),
    steps: workflow.steps
      .filter((step) => step.id !== id)
      .map((step): ProcessStep => {
        if (step.type === "return") return step;
        if (step.type === "branch")
          return {
            ...step,
            whenTrue: retarget(step.whenTrue),
            whenFalse: retarget(step.whenFalse),
          };
        return { ...step, next: retarget(step.next) };
      }),
  });
}
/** Local topology hints only: server validation still proves bindings, policy and types. */
export function structuralProblems(definition: Workflow): string[] {
  const problems = new Set<string>();
  const ids = new Set(definition.steps.map((step) => step.id));
  if (ids.size !== definition.steps.length)
    problems.add("process_editor_duplicate_step");
  if (!ids.has(definition.entry)) problems.add("process_editor_missing_entry");
  if (openPorts(definition).length) problems.add("process_editor_open_output");
  const edges = workflowEdges(definition);
  if (edges.some((edge) => !ids.has(edge.to)))
    problems.add("process_editor_dangling_edge");
  if (
    definition.steps.some((step) =>
      bindings(step).some(
        (binding) => binding.source === "step" && !ids.has(binding.stepId),
      ),
    )
  )
    problems.add("process_editor_dangling_binding");
  const successors = new Map<string, string[]>();
  for (const edge of edges) {
    const next = successors.get(edge.from) ?? [];
    next.push(edge.to);
    successors.set(edge.from, next);
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string) => {
    if (!ids.has(id)) return;
    if (active.has(id)) {
      problems.add("process_editor_cycle");
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    for (const next of successors.get(id) ?? []) visit(next);
    active.delete(id);
  };
  visit(definition.entry);
  if (visited.size !== ids.size)
    problems.add("process_editor_unreachable_step");
  // A disconnected cycle still needs a cycle diagnostic, independently of reachability.
  for (const id of ids) visit(id);
  return [...problems];
}
