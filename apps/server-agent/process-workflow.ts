import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  ProcessQuestionSchema,
  ProcessQuestionResumeSchema,
  type ProcessQuestion,
} from "../../packages/protocol/process-questions";
import { PROCESS_ROOT_AGENT_NODE_ID } from "./process-agent-tools";
import type { ProcessWorkflowCheckpoint } from "./process-checkpoint";
import {
  ProcessDefinitionSchema,
  processValueSchema,
  type ProcessBinding,
  type ProcessData,
  type ProcessDefinition,
  type ProcessStep,
} from "../../packages/protocol/service-processes";

export {
  PROCESS_COMPILER_VERSION,
  processCompilerVersion,
} from "./process-contract";
export type ActionStep = Extract<ProcessStep, { type: "action" }>;
export type AgentStep = Extract<ProcessStep, { type: "agent" }>;
export const ProcessApprovalSchema = z.strictObject({
  nodeId: z.string(),
  operationId: z.string(),
});
export const ProcessResumeSchema = ProcessApprovalSchema.extend({
  approved: z.boolean(),
});
export type ProcessApproval = z.infer<typeof ProcessApprovalSchema>;
export type ProcessResume = z.infer<typeof ProcessResumeSchema>;
export { ProcessQuestionSchema, ProcessQuestionResumeSchema };
export type {
  ProcessQuestion,
  ProcessQuestionResume,
} from "../../packages/protocol/process-questions";
export const ProcessAnyResumeSchema = z.union([
  ProcessResumeSchema,
  ProcessQuestionResumeSchema,
]);
export const ProcessQuestionSuspendSchema = z.union([
  ProcessApprovalSchema,
  ProcessQuestionSchema,
]);
export type ProcessAnyResume = z.infer<typeof ProcessAnyResumeSchema>;
export type ProcessBoundaryResult =
  | { status: "complete"; output: unknown }
  | { status: "waiting"; approval: ProcessApproval }
  | { status: "waiting"; question: ProcessQuestion };
export type NativeWorkflowBoundary = {
  /** Trusted server callbacks; never taken from a definition or request body. */
  authorize(): Promise<void>;
  enter(node: ProcessStep): Promise<void>;
  leave(node: ProcessStep, status: "succeeded" | "waiting"): Promise<void>;
  /** Passive domain proof; only this trusted callback can admit native restart. */
  reconcile?(
    checkpoint: ProcessWorkflowCheckpoint,
    workflowId: string,
  ): Promise<boolean>;
  action(
    node: ActionStep,
    input: Record<string, unknown>,
    resume: ProcessResume | undefined,
    signal: AbortSignal,
    /** Child tool identity supplied by the trusted native runtime, never the model arguments. */
    callId?: string,
  ): Promise<
    | { status: "complete"; output: unknown }
    | { status: "waiting"; approval: ProcessApproval }
  >;
  agent?(
    node: AgentStep,
    input: Record<string, unknown>,
    resume: ProcessAnyResume | undefined,
    signal: AbortSignal,
  ): Promise<ProcessBoundaryResult>;
};

export { processValueSchema } from "../../packages/protocol/service-processes";

export function assertWorkflowSupported(definition: ProcessDefinition): void {
  ProcessDefinitionSchema.parse(definition);
}
/** Saved compiler identity is independent of the selector used for new runs. */
export function assertProcessCompilerSupported(
  compilerVersion: string,
  definition: ProcessDefinition,
): void {
  if (
    compilerVersion !== "niaro-native-workflow/1" &&
    compilerVersion !== "niaro-native-workflow/2" &&
    compilerVersion !== "niaro-native-workflow/3"
  )
    throw new Error("process_compiler_unsupported");
  const hasQuestions =
    definition.kind === "agent"
      ? definition.humanInput === "text"
      : definition.steps.some(
          (node) => node.type === "agent" && node.humanInput === "text",
        );
  if (hasQuestions !== (compilerVersion === "niaro-native-workflow/3"))
    throw new Error("process_compiler_incompatible");
  if (
    compilerVersion === "niaro-native-workflow/1" &&
    (definition.kind === "agent" ||
      definition.steps.some((node) => node.type === "agent"))
  )
    throw new Error("process_compiler_incompatible");
}
export function processWorkflowDefinition(
  definition: ProcessDefinition,
): Extract<ProcessDefinition, { kind: "workflow" }> {
  if (definition.kind === "workflow") return definition;
  const {
    kind: _kind,
    modelId,
    instructions,
    capabilities,
    memory,
    humanInput,
    ...base
  } = definition;
  return {
    ...base,
    kind: "workflow",
    entry: PROCESS_ROOT_AGENT_NODE_ID,
    steps: [
      {
        id: PROCESS_ROOT_AGENT_NODE_ID,
        type: "agent",
        modelId,
        instructions,
        capabilities,
        memory,
        ...(humanInput ? { humanInput } : {}),
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        input: Object.fromEntries(
          Object.keys(
            (definition.inputSchema as Extract<ProcessData, { type: "object" }>)
              .properties,
          ).map((key) => [key, { source: "input" as const, path: [key] }]),
        ),
        next: "done",
      },
      {
        id: "done",
        type: "return",
        output: Object.fromEntries(
          Object.keys(
            (
              definition.outputSchema as Extract<
                ProcessData,
                { type: "object" }
              >
            ).properties,
          ).map((key) => [
            key,
            {
              source: "step" as const,
              stepId: PROCESS_ROOT_AGENT_NODE_ID,
              path: [key],
            },
          ]),
        ),
      },
    ],
  };
}

export const ProcessCarrySchema = z.strictObject({
  input: z.record(z.string(), z.unknown()),
  outputs: z.record(z.string(), z.unknown()),
  next: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).optional(),
});
// Preserve the persisted native mapping function for compiler versions 1/2.
const carrySchema = ProcessCarrySchema;
type Carry = z.infer<typeof ProcessCarrySchema>;
const successors = (step: ProcessStep) =>
  step.type === "return"
    ? []
    : step.type === "branch"
      ? [step.whenTrue, step.whenFalse]
      : [step.next];

/** Each DAG node becomes a native branch/step; there is no interpreter run loop. */
export function orderedProcessNodes(
  definition: Extract<ProcessDefinition, { kind: "workflow" }>,
) {
  const nodes = new Map(definition.steps.map((node) => [node.id, node]));
  if (nodes.size !== definition.steps.length || !nodes.has(definition.entry))
    throw new Error("process_graph_invalid");
  const incoming = new Map(definition.steps.map((node) => [node.id, 0]));
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    const node = nodes.get(id);
    if (!node) throw new Error("process_graph_invalid");
    reachable.add(id);
    for (const next of new Set(successors(node))) visit(next);
  };
  visit(definition.entry);
  if (reachable.size !== nodes.size) throw new Error("process_graph_invalid");
  for (const node of nodes.values())
    for (const next of new Set(successors(node)))
      incoming.set(next, incoming.get(next)! + 1);
  const queue = [...nodes.keys()].filter((id) => incoming.get(id) === 0);
  const result: ProcessStep[] = [];
  for (let index = 0; index < queue.length; index++) {
    const node = nodes.get(queue[index]!)!;
    result.push(node);
    for (const next of new Set(successors(node))) {
      incoming.set(next, incoming.get(next)! - 1);
      if (incoming.get(next) === 0) queue.push(next);
    }
  }
  if (result.length !== nodes.size) throw new Error("process_graph_invalid");
  return result;
}

export function processBindingValue(
  binding: ProcessBinding,
  carry: Carry,
): unknown {
  if (binding.source === "literal") return binding.value;
  let result: unknown =
    binding.source === "input" ? carry.input : carry.outputs[binding.stepId];
  for (const key of binding.path) {
    if (!result || typeof result !== "object" || !Object.hasOwn(result, key))
      return undefined;
    result = (result as Record<string, unknown>)[key];
  }
  return result;
}
export function processBoundInput(
  bindings: Record<string, ProcessBinding>,
  carry: Carry,
) {
  return Object.fromEntries(
    Object.entries(bindings)
      .map(
        ([key, binding]) => [key, processBindingValue(binding, carry)] as const,
      )
      .filter(([, item]) => item !== undefined),
  );
}

export function compileProcessWorkflow(
  id: string,
  raw: ProcessDefinition,
  boundary: NativeWorkflowBoundary,
  signal: AbortSignal,
  compilerVersion: string,
) {
  const original = ProcessDefinitionSchema.parse(raw);
  assertProcessCompilerSupported(compilerVersion, original);
  if (compilerVersion === "niaro-native-workflow/3")
    return compileProcessQuestionWorkflow(id, original, boundary, signal);
  const definition = processWorkflowDefinition(original);
  if (definition.steps.some((s) => s.type === "agent") && !boundary.agent)
    throw new Error("process_agent_runtime_required");
  const nodes = orderedProcessNodes(definition);
  const inputSchema = processValueSchema(definition.inputSchema);
  const outputSchema = processValueSchema(definition.outputSchema);
  const initialize = createStep({
    id: "initialize",
    inputSchema,
    outputSchema: ProcessCarrySchema,
    retries: 0,
    execute: async ({ inputData }) => ({
      input: inputData as Record<string, unknown>,
      outputs: {},
      next: definition.entry,
    }),
  });
  let workflow = createWorkflow({
    id,
    inputSchema,
    outputSchema,
    options: { validateInputs: true, autoRestartActiveRuns: false },
  }).then(initialize);
  for (const node of nodes) {
    const execute = createStep({
      id: `execute_${node.id}`,
      inputSchema: ProcessCarrySchema,
      outputSchema: ProcessCarrySchema,
      suspendSchema: ProcessApprovalSchema,
      resumeSchema: ProcessResumeSchema,
      retries: 0,
      execute: async ({ inputData, resumeData, suspend }) => {
        signal.throwIfAborted();
        await boundary.authorize();
        const syntheticReturn =
          original.kind === "agent" && node.type === "return";
        if (!syntheticReturn) await boundary.enter(node);
        const carry = structuredClone(inputData);
        if (node.type === "action" || node.type === "agent") {
          const bound = processBoundInput(node.input, carry);
          const result =
            node.type === "agent"
              ? await boundary.agent!(
                  node,
                  processValueSchema(node.inputSchema).parse(bound) as Record<
                    string,
                    unknown
                  >,
                  resumeData,
                  signal,
                )
              : await boundary.action(node, bound, resumeData, signal);
          if (result.status === "waiting") {
            if (!("approval" in result))
              throw new Error("process_question_conflict");
            if (result.approval.nodeId !== node.id)
              throw new Error("process_approval_conflict");
            await boundary.leave(node, "waiting");
            return suspend(result.approval);
          }
          const parsed = processValueSchema(node.outputSchema).safeParse(
            result.output,
          );
          if (!parsed.success) throw new Error("process_output_invalid");
          carry.outputs[node.id] = parsed.data;
          carry.next = node.next;
        } else if (node.type === "branch") {
          const left = processBindingValue(node.condition.left, carry);
          const matches =
            node.condition.operator === "exists"
              ? left !== undefined
              : left === node.condition.right;
          carry.next = matches ? node.whenTrue : node.whenFalse;
        } else if (node.type === "return") {
          const parsed = outputSchema.safeParse(
            processBoundInput(node.output, carry),
          );
          if (!parsed.success) throw new Error("process_output_invalid");
          carry.result = parsed.data as Record<string, unknown>;
          carry.next = null;
        }
        if (!syntheticReturn) await boundary.leave(node, "succeeded");
        return carry;
      },
    });
    const skip = createStep({
      id: `skip_${node.id}`,
      inputSchema: ProcessCarrySchema,
      outputSchema: ProcessCarrySchema,
      retries: 0,
      execute: async ({ inputData }) => inputData,
    });
    workflow = workflow
      .branch([
        [async ({ inputData }) => inputData.next === node.id, execute],
        [async ({ inputData }) => inputData.next !== node.id, skip],
      ])
      .map(async ({ inputData }) =>
        carrySchema.parse(inputData[execute.id] ?? inputData[skip.id]),
      );
  }
  return workflow
    .then(
      createStep({
        id: "finish",
        inputSchema: ProcessCarrySchema,
        outputSchema,
        retries: 0,
        execute: async ({ inputData }) => {
          signal.throwIfAborted();
          await boundary.authorize();
          if (inputData.next !== null || !inputData.result)
            throw new Error("process_output_invalid");
          return inputData.result;
        },
      }),
    )
    .commit();
}

// Compiler /3 has a separate persisted map ABI; legacy carrySchema remains frozen.
const questionCarrySchema = ProcessCarrySchema;
function compileProcessQuestionWorkflow(
  id: string,
  raw: ProcessDefinition,
  boundary: NativeWorkflowBoundary,
  signal: AbortSignal,
) {
  const original = ProcessDefinitionSchema.parse(raw);
  const definition = processWorkflowDefinition(original);
  if (definition.steps.some((s) => s.type === "agent") && !boundary.agent)
    throw new Error("process_agent_runtime_required");
  const nodes = orderedProcessNodes(definition);
  const inputSchema = processValueSchema(definition.inputSchema);
  const outputSchema = processValueSchema(definition.outputSchema);
  const initialize = createStep({
    id: "initialize",
    inputSchema,
    outputSchema: ProcessCarrySchema,
    retries: 0,
    execute: async ({ inputData }) => ({
      input: inputData as Record<string, unknown>,
      outputs: {},
      next: definition.entry,
    }),
  });
  let workflow = createWorkflow({
    id,
    inputSchema,
    outputSchema,
    options: { validateInputs: true, autoRestartActiveRuns: false },
  }).then(initialize);
  for (const node of nodes) {
    const execute = createStep({
      id: `execute_${node.id}`,
      inputSchema: ProcessCarrySchema,
      outputSchema: ProcessCarrySchema,
      suspendSchema: ProcessQuestionSuspendSchema,
      resumeSchema: ProcessAnyResumeSchema,
      retries: 0,
      execute: async ({ inputData, resumeData, suspend }) => {
        signal.throwIfAborted();
        await boundary.authorize();
        if (
          resumeData &&
          (resumeData.nodeId !== node.id ||
            ("kind" in resumeData &&
              (node.type !== "agent" || node.humanInput !== "text")))
        )
          throw new Error("process_question_conflict");
        const syntheticReturn =
          original.kind === "agent" && node.type === "return";
        if (!syntheticReturn) await boundary.enter(node);
        const carry = structuredClone(inputData);
        if (node.type === "action" || node.type === "agent") {
          const bound = processBoundInput(node.input, carry);
          const result =
            node.type === "agent"
              ? await boundary.agent!(
                  node,
                  processValueSchema(node.inputSchema).parse(bound) as Record<
                    string,
                    unknown
                  >,
                  resumeData,
                  signal,
                )
              : await boundary.action(
                  node,
                  bound,
                  ProcessResumeSchema.optional().parse(resumeData),
                  signal,
                );
          if (result.status === "waiting") {
            const pending =
              "question" in result
                ? ProcessQuestionSchema.parse(result.question)
                : ProcessApprovalSchema.parse(result.approval);
            if (pending.nodeId !== node.id)
              throw new Error("process_question_conflict");
            if (
              "question" in result &&
              (node.type !== "agent" || node.humanInput !== "text")
            )
              throw new Error("process_question_conflict");
            await boundary.leave(node, "waiting");
            return suspend(pending);
          }
          const parsed = processValueSchema(node.outputSchema).safeParse(
            result.output,
          );
          if (!parsed.success) throw new Error("process_output_invalid");
          carry.outputs[node.id] = parsed.data;
          carry.next = node.next;
        } else if (node.type === "branch") {
          const left = processBindingValue(node.condition.left, carry);
          const matches =
            node.condition.operator === "exists"
              ? left !== undefined
              : left === node.condition.right;
          carry.next = matches ? node.whenTrue : node.whenFalse;
        } else if (node.type === "return") {
          const parsed = outputSchema.safeParse(
            processBoundInput(node.output, carry),
          );
          if (!parsed.success) throw new Error("process_output_invalid");
          carry.result = parsed.data as Record<string, unknown>;
          carry.next = null;
        }
        if (!syntheticReturn) await boundary.leave(node, "succeeded");
        return carry;
      },
    });
    const skip = createStep({
      id: `skip_${node.id}`,
      inputSchema: ProcessCarrySchema,
      outputSchema: ProcessCarrySchema,
      retries: 0,
      execute: async ({ inputData }) => inputData,
    });
    workflow = workflow
      .branch([
        [async ({ inputData }) => inputData.next === node.id, execute],
        [async ({ inputData }) => inputData.next !== node.id, skip],
      ])
      .map(async ({ inputData }) =>
        questionCarrySchema.parse(inputData[execute.id] ?? inputData[skip.id]),
      );
  }
  return workflow
    .then(
      createStep({
        id: "finish",
        inputSchema: ProcessCarrySchema,
        outputSchema,
        retries: 0,
        execute: async ({ inputData }) => {
          signal.throwIfAborted();
          await boundary.authorize();
          if (inputData.next !== null || !inputData.result)
            throw new Error("process_output_invalid");
          return inputData.result;
        },
      }),
    )
    .commit();
}
