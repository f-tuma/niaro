import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  ProcessDefinition,
  ProcessStep,
} from "../../packages/protocol/service-processes";
import {
  assertProcessCompilerSupported,
  initialProcessCarry,
  orderedProcessNodes,
  processBindingValue,
  processBoundInput,
  processValueSchema,
  processWorkflowDefinition,
  ProcessAnyResumeSchema,
  ProcessApprovalSchema,
  ProcessCarrySchema,
  ProcessQuestionSuspendSchema,
  ProcessResumeSchema,
  type ProcessAnyResume,
  type ProcessBoundaryResult,
} from "./process-workflow";

/**
 * One node a run entered, as the agent core stored it (pi/process-engine):
 * the carry it started from, the decision it was resumed with, and how it
 * ended. `running` means the process stopped inside it.
 */
export const ProcessRunStepSchema = z.strictObject({
  nodeId: z.string().min(1).max(64),
  carry: ProcessCarrySchema,
  resume: z.unknown().optional(),
  status: z.enum(["running", "success", "suspended"]),
  output: ProcessCarrySchema.optional(),
  pending: z.unknown().optional(),
});
/** The durable checkpoint of one process run in the agent core. */
export const ProcessRunCheckpointSchema = z.strictObject({
  version: z.literal(1),
  workflowId: z.string().min(1),
  runId: z.string().min(1),
  resourceId: z.string().min(1),
  /** The frozen graph this run executes; a changed definition never attaches. */
  graph: z.string().regex(/^[a-f0-9]{64}$/),
  input: z.record(z.string(), z.unknown()),
  status: z.enum(["running", "suspended", "success", "failed", "canceled"]),
  steps: z.array(ProcessRunStepSchema).max(1024),
  result: z.record(z.string(), z.unknown()).optional(),
  failure: z.string().max(80).optional(),
  /** Restarts the server made by itself after crashes (policy A), bounded. */
  automaticRestarts: z.number().int().nonnegative().max(1000).optional(),
});
export type ProcessRunStep = z.infer<typeof ProcessRunStepSchema>;
export type ProcessRunCheckpoint = z.infer<typeof ProcessRunCheckpointSchema>;

export function sameProcessCheckpointValue(left: unknown, right: unknown) {
  return isDeepStrictEqual(left, right);
}

/** The identity of a run's frozen graph: compiler and normalized definition. */
export function processGraphDigest(
  definition: ProcessDefinition,
  compilerVersion: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([compilerVersion, processWorkflowDefinition(definition)]),
    )
    .digest("hex");
}

/**
 * Passive verification of a stored run, never an execution: the steps must
 * replay the frozen graph exactly, and every action and agent boundary they
 * crossed must be proved independently by the domain (`proveNode`, from
 * receipts and exact child retirement). A run stopped inside a node is
 * admissible only when that node's boundary proves too.
 */
export async function proveProcessRunCheckpoint(input: {
  checkpoint: ProcessRunCheckpoint;
  definition: ProcessDefinition;
  compilerVersion: string;
  workflowId: string;
  proveNode(
    node: Extract<ProcessStep, { type: "action" | "agent" }>,
    bound: Record<string, unknown>,
    resume: ProcessAnyResume | undefined,
  ): Promise<ProcessBoundaryResult | undefined>;
}) {
  try {
    assertProcessCompilerSupported(input.compilerVersion, input.definition);
  } catch {
    return false;
  }
  const parsed = ProcessRunCheckpointSchema.safeParse(input.checkpoint);
  if (!parsed.success) return false;
  const checkpoint = parsed.data;
  if (
    checkpoint.workflowId !== input.workflowId ||
    checkpoint.graph !==
      processGraphDigest(input.definition, input.compilerVersion) ||
    !["running", "suspended", "success"].includes(checkpoint.status)
  )
    return false;
  const questions = input.compilerVersion === "niaro-native-workflow/3";
  const definition = processWorkflowDefinition(input.definition);
  const nodes = new Map(
    orderedProcessNodes(definition).map((node) => [node.id, node]),
  );
  const outputSchema = processValueSchema(definition.outputSchema);
  let carry = initialProcessCarry(definition, checkpoint.input);
  for (const [index, step] of checkpoint.steps.entries()) {
    const last = index === checkpoint.steps.length - 1;
    const node = nodes.get(step.nodeId);
    if (
      !node ||
      carry.next !== node.id ||
      !sameProcessCheckpointValue(step.carry, carry)
    )
      return false;
    const resume =
      step.resume === undefined
        ? undefined
        : (questions ? ProcessAnyResumeSchema : ProcessResumeSchema).safeParse(
            step.resume,
          );
    if (resume && !resume.success) return false;
    if (resume && node.type !== "action" && node.type !== "agent") return false;
    if (
      resume?.success &&
      "kind" in resume.data &&
      (node.type !== "agent" ||
        node.humanInput !== "text" ||
        resume.data.nodeId !== node.id)
    )
      return false;
    const next = structuredClone(carry);
    let proof: ProcessBoundaryResult | undefined;
    if (node.type === "action" || node.type === "agent") {
      proof = await input.proveNode(
        node,
        processBoundInput(node.input, carry),
        resume?.data,
      );
      if (!proof) return false;
      if (proof.status === "complete") {
        const output = processValueSchema(node.outputSchema).safeParse(
          proof.output,
        );
        if (!output.success) return false;
        next.outputs[node.id] = output.data;
        next.next = node.next;
      }
    } else if (node.type === "branch") {
      const left = processBindingValue(node.condition.left, carry);
      next.next = (
        node.condition.operator === "exists"
          ? left !== undefined
          : left === node.condition.right
      )
        ? node.whenTrue
        : node.whenFalse;
    } else {
      const result = outputSchema.safeParse(
        processBoundInput(node.output, carry),
      );
      if (!result.success) return false;
      next.result = result.data as Record<string, unknown>;
      next.next = null;
    }
    if (step.status === "running")
      return last && checkpoint.status === "running";
    if (step.status === "suspended") {
      const pending = (
        questions ? ProcessQuestionSuspendSchema : ProcessApprovalSchema
      ).safeParse(step.pending);
      if (
        pending.success &&
        "kind" in pending.data &&
        (node.type !== "agent" || node.humanInput !== "text")
      )
        return false;
      return (
        last &&
        checkpoint.status === "suspended" &&
        proof?.status === "waiting" &&
        pending.success &&
        sameProcessCheckpointValue(
          pending.data,
          "question" in proof ? proof.question : proof.approval,
        )
      );
    }
    if (
      proof?.status === "waiting" ||
      !sameProcessCheckpointValue(step.output, next)
    )
      return false;
    carry = next;
  }
  if (checkpoint.status === "running") return true;
  return (
    checkpoint.status === "success" &&
    carry.next === null &&
    !!carry.result &&
    sameProcessCheckpointValue(checkpoint.result, carry.result)
  );
}
