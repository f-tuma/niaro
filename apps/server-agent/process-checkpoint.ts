import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  ProcessDefinition,
  ProcessStep,
} from "../../packages/protocol/service-processes";
import {
  orderedProcessNodes,
  processWorkflowDefinition,
  processBoundInput,
  processBindingValue,
  processValueSchema,
  ProcessCarrySchema,
  ProcessResumeSchema,
  ProcessAnyResumeSchema,
  ProcessQuestionSuspendSchema,
  ProcessApprovalSchema,
  assertProcessCompilerSupported,
  type ProcessAnyResume,
  type ProcessBoundaryResult,
} from "./process-workflow";

const path = z.array(z.number().int().nonnegative()).max(16);
const step = z.object({
  status: z.string().min(1).max(32),
  payload: z.unknown().optional(),
  output: z.unknown().optional(),
  resumePayload: z.unknown().optional(),
  suspendPayload: z.unknown().optional(),
});
export const ProcessWorkflowCheckpointSchema = z.object({
  runId: z.string().min(1),
  status: z.enum([
    "running",
    "waiting",
    "pending",
    "paused",
    "suspended",
    "success",
    "failed",
    "canceled",
    "tripwire",
    "bailed",
    "skipped",
  ]),
  context: z.record(z.string(), z.unknown()),
  serializedStepGraph: z.array(z.unknown()).max(256),
  activePaths: path,
  activeStepsPath: z.record(z.string(), path),
  suspendedPaths: z.record(z.string(), path),
  waitingPaths: z.record(z.string(), path),
  resumeLabels: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
});
export type ProcessWorkflowCheckpoint = z.infer<
  typeof ProcessWorkflowCheckpointSchema
>;
export const ProcessCheckpointStepSchema = step;

/** Compare the public compiler graph with its persisted JSON representation. */
export function sameProcessCheckpointValue(left: unknown, right: unknown) {
  return isDeepStrictEqual(left, right);
}
export function sameProcessCheckpointGraph(saved: unknown, compiled: unknown) {
  return isDeepStrictEqual(saved, JSON.parse(JSON.stringify(compiled)));
}

/** Passive verification of saved native state, never a process execution loop.
 * Native Mastra still selects and runs the steps. Receipts and exact child
 * retirement must independently prove every saved action/agent boundary.
 */
export async function proveProcessWorkflowCheckpoint(input: {
  checkpoint: ProcessWorkflowCheckpoint;
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
  const { checkpoint } = input;
  if (
    Object.keys(checkpoint.waitingPaths).length ||
    Object.keys(checkpoint.resumeLabels).length ||
    (checkpoint.status !== "suspended" &&
      Object.keys(checkpoint.suspendedPaths).length)
  )
    return false;
  const definition = processWorkflowDefinition(input.definition);
  const knownKeys = new Set(["input", "initialize", "finish"]);
  const nodes = orderedProcessNodes(definition);
  for (const [index, node] of nodes.entries()) {
    knownKeys.add(`execute_${node.id}`);
    knownKeys.add(`skip_${node.id}`);
    knownKeys.add(`mapping_${input.workflowId}_${index}`);
  }
  if (Object.keys(checkpoint.context).some((key) => !knownKeys.has(key)))
    return false;
  const entries = new Set(
    Object.keys(checkpoint.context).filter((key) => key !== "input"),
  );
  const active = (key: string, position: number[]) =>
    ["running", "waiting"].includes(checkpoint.status) &&
    sameProcessCheckpointValue(checkpoint.activePaths, position) &&
    sameProcessCheckpointValue(checkpoint.activeStepsPath, {
      [key]: position,
    }) &&
    [...entries].every((entry) => entry === key);
  const finished = (position: number) =>
    ["running", "waiting"].includes(checkpoint.status) &&
    entries.size === 0 &&
    sameProcessCheckpointValue(checkpoint.activePaths, [position]) &&
    sameProcessCheckpointValue(checkpoint.activeStepsPath, {});
  const read = (key: string) => {
    const parsed = ProcessCheckpointStepSchema.safeParse(
      checkpoint.context[key],
    );
    if (!parsed.success) return undefined;
    entries.delete(key);
    return parsed.data;
  };
  let carry: z.infer<typeof ProcessCarrySchema> = {
    input: checkpoint.context.input as Record<string, unknown>,
    outputs: {},
    next: definition.entry,
  };
  const initialize = read("initialize");
  if (
    !initialize ||
    !sameProcessCheckpointValue(initialize.payload, carry.input)
  )
    return false;
  if (initialize.status !== "success")
    return initialize.status === "running" && active("initialize", [0]);
  if (!sameProcessCheckpointValue(initialize.output, carry)) return false;
  if (finished(0)) return true;
  for (const [index, node] of nodes.entries()) {
    const selected = carry.next === node.id;
    const key = `${selected ? "execute" : "skip"}_${node.id}`;
    if (
      checkpoint.context[`${selected ? "skip" : "execute"}_${node.id}`] !==
      undefined
    )
      return false;
    const saved = read(key);
    if (!saved || !sameProcessCheckpointValue(saved.payload, carry))
      return false;
    let next = structuredClone(carry);
    let proof: ProcessBoundaryResult | undefined;
    const resume =
      saved.resumePayload === undefined
        ? undefined
        : (input.compilerVersion === "niaro-native-workflow/3"
            ? ProcessAnyResumeSchema
            : ProcessResumeSchema
          ).safeParse(saved.resumePayload);
    if (resume && !resume.success) return false;
    if (
      resume &&
      (!selected || (node.type !== "action" && node.type !== "agent"))
    )
      return false;
    if (
      resume?.success &&
      "kind" in resume.data &&
      (node.type !== "agent" ||
        node.humanInput !== "text" ||
        resume.data.nodeId !== node.id)
    )
      return false;
    if (selected && (node.type === "action" || node.type === "agent")) {
      proof = await input.proveNode(
        node,
        processBoundInput(node.input, carry),
        resume?.data,
      );
      if (!proof) return false;
      if (proof.status === "complete") {
        const parsed = processValueSchema(node.outputSchema).safeParse(
          proof.output,
        );
        if (!parsed.success) return false;
        next.outputs[node.id] = parsed.data;
        next.next = node.next;
      }
    } else if (selected && node.type === "branch") {
      const left = processBindingValue(node.condition.left, carry);
      next.next = (
        node.condition.operator === "exists"
          ? left !== undefined
          : left === node.condition.right
      )
        ? node.whenTrue
        : node.whenFalse;
    } else if (selected && node.type === "return") {
      const parsed = processValueSchema(definition.outputSchema).safeParse(
        processBoundInput(node.output, carry),
      );
      if (!parsed.success) return false;
      next.result = parsed.data as Record<string, unknown>;
      next.next = null;
    }
    if (saved.status !== "success") {
      if (saved.status === "suspended") {
        const pending = (
          input.compilerVersion === "niaro-native-workflow/3"
            ? ProcessQuestionSuspendSchema
            : ProcessApprovalSchema
        ).safeParse(saved.suspendPayload);
        if (
          pending.success &&
          "kind" in pending.data &&
          (node.type !== "agent" || node.humanInput !== "text")
        )
          return false;
        return (
          checkpoint.status === "suspended" &&
          entries.size === 0 &&
          sameProcessCheckpointValue(checkpoint.activePaths, [1 + index * 2]) &&
          sameProcessCheckpointValue(checkpoint.activeStepsPath, {}) &&
          sameProcessCheckpointValue(checkpoint.suspendedPaths, {
            [key]: [1 + index * 2, 0],
          }) &&
          proof?.status === "waiting" &&
          pending.success &&
          sameProcessCheckpointValue(
            pending.data,
            "question" in proof ? proof.question : proof.approval,
          )
        );
      }
      if (
        !["running", "waiting"].includes(saved.status) ||
        !active(key, [1 + index * 2, selected ? 0 : 1])
      )
        return false;
      return true;
    }
    if (
      proof?.status === "waiting" ||
      !sameProcessCheckpointValue(saved.output, next)
    )
      return false;
    if (
      checkpoint.status === "running" &&
      active(key, [1 + index * 2, selected ? 0 : 1])
    )
      return true;
    if (finished(1 + index * 2)) return true;
    const mappingKey = `mapping_${input.workflowId}_${index}`;
    const mapping = read(mappingKey);
    if (
      !mapping ||
      !sameProcessCheckpointValue(mapping.payload, { [key]: next })
    )
      return false;
    if (mapping.status !== "success")
      return (
        mapping.status === "running" && active(mappingKey, [2 + index * 2])
      );
    if (!sameProcessCheckpointValue(mapping.output, next)) return false;
    if (checkpoint.status === "running" && active(mappingKey, [2 + index * 2]))
      return true;
    if (finished(2 + index * 2)) return true;
    carry = next;
  }
  const finish = read("finish");
  if (
    !finish ||
    carry.next !== null ||
    !carry.result ||
    !sameProcessCheckpointValue(finish.payload, carry) ||
    entries.size
  )
    return false;
  if (finish.status !== "success")
    return (
      finish.status === "running" && active("finish", [nodes.length * 2 + 1])
    );
  if (
    sameProcessCheckpointValue(finish.output, carry.result) &&
    finished(nodes.length * 2 + 1)
  )
    return true;
  return (
    checkpoint.status === "success" &&
    sameProcessCheckpointValue(checkpoint.activePaths, [
      nodes.length * 2 + 1,
    ]) &&
    sameProcessCheckpointValue(checkpoint.activeStepsPath, {}) &&
    sameProcessCheckpointValue(finish.output, carry.result) &&
    sameProcessCheckpointValue(checkpoint.result, carry.result)
  );
}
