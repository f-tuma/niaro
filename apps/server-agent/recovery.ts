import { DurableStepIds, type DurableAgent } from "@mastra/core/agent/durable";
import type {
  MastraCompositeStore,
  WorkflowsStorage,
} from "@mastra/core/storage";
import type { ShouldPersistSnapshotFn } from "@mastra/core/workflows";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import {
  ProcessQuestionSchema,
  ProcessQuestionResumeSchema,
  type ProcessQuestion,
} from "../../packages/protocol/process-questions";

/** Persist orphaned executions without enabling unscoped boot-time recovery. */
export const persistNativeAgentCheckpoint: ShouldPersistSnapshotFn = ({
  workflowStatus,
}) =>
  workflowStatus === "pending" ||
  workflowStatus === "paused" ||
  workflowStatus === "suspended" ||
  workflowStatus === "running";

/** All identifiers must come from the authorized server command, never the client. */
export type NativeAgentRunBinding = {
  agentId: string;
  runId: string;
  threadId: string;
  resourceId: string;
};
const RETIREMENT_WORKFLOW = "niaro-native-retirement-v1";
const retirementSchema = z.strictObject({
  version: z.literal(1),
  agentId: z.string().min(1),
  runId: z.string().min(1),
  threadId: z.string().min(1),
  resourceId: z.string().min(1),
  checkpointSeen: z.boolean(),
  retired: z.boolean(),
});
export type NativeAgentRetirement = z.infer<typeof retirementSchema>;

/** A bounded metadata receipt, never a transcript or a duplicate execution plan. */
export async function persistNativeAgentRetirement(
  storage: MastraCompositeStore,
  marker: NativeAgentRetirement,
) {
  const workflows = await storage.getStore("workflows");
  if (!workflows) throw new Error("niaro_native_storage_required");
  const checked = retirementSchema.parse(marker);
  await workflows.persistWorkflowSnapshot({
    workflowName: RETIREMENT_WORKFLOW,
    runId: checked.runId,
    resourceId: checked.resourceId,
    snapshot: {
      runId: checked.runId,
      status: checked.retired ? "success" : "running",
      context: {},
      result: { retirement: checked },
      value: {},
      serializedStepGraph: [],
      activePaths: [],
      activeStepsPath: {},
      suspendedPaths: {},
      resumeLabels: {},
      waitingPaths: {},
      timestamp: Date.now(),
    },
  });
}

/** Absence of a process owner or checkpoint alone is never retirement proof. */
export async function proveNativeAgentRetirement(
  storage: MastraCompositeStore,
  binding: NativeAgentRunBinding,
) {
  const workflows = await storage.getStore("workflows");
  if (!workflows) throw new Error("niaro_native_storage_required");
  const row = await workflows.getWorkflowRunById({
    workflowName: RETIREMENT_WORKFLOW,
    runId: binding.runId,
  });
  if (!row) return false;
  let snapshot: unknown = row.snapshot;
  if (typeof snapshot === "string") {
    try {
      snapshot = JSON.parse(snapshot);
    } catch {
      return false;
    }
  }
  const parsed = retirementSchema.safeParse(
    (snapshot as { result?: { retirement?: unknown } } | null)?.result
      ?.retirement,
  );
  if (
    !parsed.success ||
    row.workflowName !== RETIREMENT_WORKFLOW ||
    row.runId !== binding.runId ||
    (snapshot as { runId?: unknown } | null)?.runId !== binding.runId ||
    row.resourceId !== binding.resourceId ||
    Object.entries(binding).some(
      ([key, value]) =>
        parsed.data[key as keyof NativeAgentRunBinding] !== value,
    )
  )
    return false;
  const checkpoints = await Promise.all([
    workflows.getWorkflowRunById({
      workflowName: DurableStepIds.AGENTIC_LOOP,
      runId: binding.runId,
    }),
    workflows.getWorkflowRunById({
      workflowName: DurableStepIds.AGENTIC_EXECUTION,
      runId: binding.runId,
    }),
  ]);
  // Even a previously retired marker cannot authorize a currently suspended run.
  if (checkpoints.some(Boolean)) {
    await inspectNativeAgentCheckpoint(storage, binding);
    return false;
  }
  if (!parsed.data.retired && !parsed.data.checkpointSeen) return false;
  if (!parsed.data.retired)
    await persistNativeAgentRetirement(storage, {
      ...parsed.data,
      retired: true,
    });
  return true;
}
/** Bulk recovery has no segment signal; replayed model/tool closures honor cancellation. */
export type NativeAgentRecoveryOptions = { abortSignal?: AbortSignal };

const scopeSchema = z.object({
  threadId: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
});
const checkpointSchema = z.object({
  runId: z.string().min(1),
  status: z.enum([
    "running",
    "success",
    "failed",
    "tripwire",
    "suspended",
    "waiting",
    "pending",
    "canceled",
    "bailed",
    "paused",
    "skipped",
  ]),
  context: z.object({
    input: z.object({
      __workflowKind: z.literal("durable-agent"),
      runId: z.string().min(1),
      agentId: z.string().min(1),
      state: scopeSchema.optional(),
      messageListState: z
        .object({ memoryInfo: scopeSchema.optional() })
        .optional(),
    }),
  }),
});

export const NativeQuestionSuspensionSchema = z.strictObject({
  kind: z.literal("question"),
  toolName: z.literal("ask_user"),
  toolCallId: z.string().min(1).max(200),
  questionProof: ProcessQuestionSchema,
});
const NativeQuestionEnvelopeSchema = z.strictObject({
  type: z.literal("suspension"),
  toolCallSuspended: NativeQuestionSuspensionSchema,
  toolCallId: z.string().min(1).max(200),
  toolName: z.literal("ask_user"),
});
export type NativeQuestionSuspension = z.infer<
  typeof NativeQuestionSuspensionSchema
>;
export type NativeAgentCheckpoint = {
  /** Bounded private proof metadata; no transcript or executable model arguments. */
  questionSuspensions: NativeQuestionSuspension[];
  questionProofsValid: boolean;
  status: z.infer<typeof checkpointSchema>["status"];
  suspendedToolCallIds: string[];
};

/** Exact question proof is stronger than membership in Mastra's tool-call discovery. */
export function proveNativeAgentQuestionCheckpoint(
  checkpoint: NativeAgentCheckpoint | undefined,
  binding: NativeAgentRunBinding & { toolCallId: string },
  question: ProcessQuestion,
) {
  const parsed = ProcessQuestionSchema.safeParse(question);
  if (
    !parsed.success ||
    checkpoint?.status !== "suspended" ||
    !checkpoint.questionProofsValid ||
    checkpoint.questionSuspensions.length !== 1
  )
    return false;
  const proof = parsed.data;
  return (
    proof.childRunId === binding.runId &&
    proof.childThreadId === binding.threadId &&
    proof.resourceId === binding.resourceId &&
    proof.toolCallId === binding.toolCallId &&
    isDeepStrictEqual(checkpoint.questionSuspensions[0], {
      kind: "question",
      toolName: "ask_user",
      toolCallId: binding.toolCallId,
      questionProof: proof,
    })
  );
}

/** Read only native workflow metadata; do not expose persisted prompts or tool data. */
export async function inspectNativeAgentCheckpoint(
  storage: MastraCompositeStore,
  binding: NativeAgentRunBinding,
): Promise<NativeAgentCheckpoint | undefined> {
  if (Object.values(binding).some((value) => !value)) {
    throw new Error("niaro_native_recovery_binding_invalid");
  }
  const workflows = await storage.getStore("workflows");
  if (!workflows) throw new Error("niaro_native_recovery_storage_required");
  const row = await workflows.getWorkflowRunById({
    workflowName: DurableStepIds.AGENTIC_LOOP,
    runId: binding.runId,
  });
  if (!row) return undefined;
  let serialized: unknown = row.snapshot;
  if (typeof serialized === "string") {
    try {
      serialized = JSON.parse(serialized);
    } catch {
      throw new Error("niaro_native_recovery_checkpoint_invalid");
    }
  }
  const parsed = checkpointSchema.safeParse(serialized);
  if (!parsed.success) {
    throw new Error("niaro_native_recovery_checkpoint_invalid");
  }
  const snapshot = parsed.data;
  const input = snapshot.context.input;
  const state = input.state;
  const memory = input.messageListState?.memoryInfo;
  // Mastra recovers state first, falling back to messageListState.memoryInfo.
  // Every persisted alias must agree so an ambiguous snapshot cannot cross scope.
  const threadId = state?.threadId ?? memory?.threadId;
  const resourceId = state?.resourceId ?? memory?.resourceId;
  if (
    row.workflowName !== DurableStepIds.AGENTIC_LOOP ||
    row.runId !== binding.runId ||
    row.resourceId !== binding.resourceId ||
    snapshot.runId !== binding.runId ||
    input.runId !== binding.runId ||
    input.agentId !== binding.agentId ||
    threadId !== binding.threadId ||
    resourceId !== binding.resourceId ||
    (state?.threadId !== undefined && state.threadId !== binding.threadId) ||
    (state?.resourceId !== undefined &&
      state.resourceId !== binding.resourceId) ||
    (memory?.threadId !== undefined && memory.threadId !== binding.threadId) ||
    (memory?.resourceId !== undefined &&
      memory.resourceId !== binding.resourceId)
  ) {
    throw new Error("niaro_native_recovery_scope_mismatch");
  }
  const callIds = new Set<string>();
  const questionSuspensions: NativeQuestionSuspension[] = [];
  let questionProofsValid = true;
  const questionPayload = (payload: Record<string, unknown>) => {
    const suspended = payload.toolCallSuspended;
    if (
      !("questionProof" in payload) &&
      !(
        suspended &&
        typeof suspended === "object" &&
        "questionProof" in suspended
      )
    )
      return undefined;
    // These are native Mastra envelope fields, not part of the user payload.
    const { __workflow_meta: _meta, __streamState: _stream, ...bare } = payload;
    const checked = NativeQuestionEnvelopeSchema.safeParse(bare);
    if (!checked.success) {
      questionProofsValid = false;
      return undefined;
    }
    const inner = checked.data.toolCallSuspended;
    const proof = inner.questionProof;
    if (
      proof.childRunId !== binding.runId ||
      proof.childThreadId !== binding.threadId ||
      proof.resourceId !== binding.resourceId ||
      proof.toolCallId !== inner.toolCallId ||
      checked.data.toolCallId !== inner.toolCallId ||
      checked.data.toolName !== inner.toolName ||
      proof.questionDigest !==
        createHash("sha256")
          .update(JSON.stringify(proof.question))
          .digest("hex")
    )
      questionProofsValid = false;
    return inner;
  };
  const raw = serialized as {
    context?: Record<
      string,
      { status?: string; suspendPayload?: Record<string, any> }
    >;
  };
  const collect = (payload: Record<string, any>) => {
    const topQuestion = questionPayload(payload);
    const nestedQuestions: NativeQuestionSuspension[] = [];
    const id = payload.requireToolApproval?.toolCallId ?? payload.toolCallId;
    if (typeof id === "string" && id.length <= 200 && callIds.size < 64)
      callIds.add(id);
    const iterations = payload.__workflow_meta?.foreachOutput;
    const iterationEntries = Array.isArray(iterations)
      ? iterations
      : iterations && typeof iterations === "object"
        ? Object.values(iterations)
        : [];
    if (iterationEntries.length > 64) questionProofsValid = false;
    for (const entry of iterationEntries.slice(0, 64)) {
      if (
        entry &&
        typeof entry === "object" &&
        "status" in entry &&
        entry.status === "suspended" &&
        "suspendPayload" in entry &&
        entry.suspendPayload &&
        typeof entry.suspendPayload === "object"
      ) {
        const nested = entry.suspendPayload as Record<string, unknown>;
        const nestedQuestion = questionPayload(nested);
        if (nestedQuestion) {
          nestedQuestions.push(nestedQuestion);
          const original =
            "payload" in entry
              ? (entry.payload as Record<string, unknown> | undefined)
              : undefined;
          const args = original?.args;
          if (
            original?.toolCallId !== nestedQuestion.toolCallId ||
            original?.toolName !== "ask_user" ||
            !args ||
            typeof args !== "object" ||
            !("question" in args) ||
            args.question !== nestedQuestion.questionProof.question ||
            Object.keys(args).length !== 1
          )
            questionProofsValid = false;
        }
        const id =
          nested.requireToolApproval &&
          typeof nested.requireToolApproval === "object"
            ? (nested.requireToolApproval as { toolCallId?: unknown })
                .toolCallId
            : nested.toolCallId;
        if (typeof id === "string" && id.length <= 200 && callIds.size < 64)
          callIds.add(id);
      }
    }
    // Mastra duplicates the selected foreach payload at the enclosing step.
    // That alias must agree exactly; two actual suspended iterations are ambiguous.
    if (
      nestedQuestions.length > 1 ||
      (nestedQuestions.length === 1 &&
        (!topQuestion || !isDeepStrictEqual(topQuestion, nestedQuestions[0])))
    )
      questionProofsValid = false;
    if (topQuestion) questionSuspensions.push(topQuestion);
  };
  if (Object.keys(raw.context ?? {}).length > 64) questionProofsValid = false;
  for (const step of Object.values(raw.context ?? {}).slice(0, 64))
    if (step?.status === "suspended" && step.suspendPayload)
      collect(step.suspendPayload);
  if (questionSuspensions.length > 1) questionProofsValid = false;
  if (questionSuspensions.length === 1 && snapshot.status === "suspended")
    questionProofsValid &&= await proveQuestionSuspensionControls(
      workflows,
      binding,
      serialized,
      questionSuspensions[0]!,
    );
  return {
    status: snapshot.status,
    suspendedToolCallIds: [...callIds],
    questionSuspensions,
    questionProofsValid,
  };
}

export const NativeQuestionAnswerSchema = ProcessQuestionResumeSchema.pick({
  answerId: true,
  questionId: true,
  questionRevision: true,
}).extend({
  answer: z
    .string()
    .min(1)
    .max(4000)
    .refine((answer) => answer.trim().length > 0),
});
const questionMemorySuspensionSchema = z.strictObject({
  toolCallId: z.string().min(1).max(200),
  toolName: z.literal("ask_user"),
  args: z.strictObject({ question: z.string().min(1).max(2000) }),
  type: z.literal("suspension"),
  runId: z.string().min(1),
  suspendPayload: NativeQuestionSuspensionSchema,
});
const activeQuestionRecoverySchema = checkpointSchema.extend({
  activePaths: z.array(z.number()),
  activeStepsPath: z.record(z.string(), z.array(z.number())),
  suspendedPaths: z.record(z.string(), z.unknown()),
  waitingPaths: z.record(z.string(), z.unknown()),
  resumeLabels: z.record(z.string(), z.unknown()),
});

// Mastra carries the marker on the outer durable loop. Its nested execution
// input is a copied iteration state and omits the marker after the first loop.
const executionQuestionControlSchema = activeQuestionRecoverySchema.extend({
  context: checkpointSchema.shape.context.extend({
    input: checkpointSchema.shape.context.shape.input.extend({
      __workflowKind: z.literal("durable-agent").optional(),
    }),
  }),
});

function questionSnapshotMatchesBinding(
  snapshot: z.infer<typeof executionQuestionControlSchema>,
  binding: NativeAgentRunBinding,
) {
  const input = snapshot.context.input;
  return (
    snapshot.runId === binding.runId &&
    input.runId === binding.runId &&
    input.agentId === binding.agentId &&
    (input.state?.threadId ?? input.messageListState?.memoryInfo?.threadId) ===
      binding.threadId &&
    (input.state?.resourceId ??
      input.messageListState?.memoryInfo?.resourceId) === binding.resourceId &&
    (input.state?.threadId === undefined ||
      input.state.threadId === binding.threadId) &&
    (input.state?.resourceId === undefined ||
      input.state.resourceId === binding.resourceId) &&
    (input.messageListState?.memoryInfo?.threadId === undefined ||
      input.messageListState.memoryInfo.threadId === binding.threadId) &&
    (input.messageListState?.memoryInfo?.resourceId === undefined ||
      input.messageListState.memoryInfo.resourceId === binding.resourceId)
  );
}

/** Check native control state as well as the suspension payload. A payload
 * copied onto an unrelated or running path cannot establish resumability. */
async function proveQuestionSuspensionControls(
  workflows: WorkflowsStorage,
  binding: NativeAgentRunBinding,
  rawLoop: unknown,
  question: NativeQuestionSuspension,
  allowMissingLoopLabel = false,
) {
  const loopParsed = activeQuestionRecoverySchema.safeParse(rawLoop);
  if (!loopParsed.success) return false;
  const loop = {
    ...loopParsed.data,
    context: (rawLoop as typeof loopParsed.data).context,
  };
  const row = await workflows.getWorkflowRunById({
    workflowName: DurableStepIds.AGENTIC_EXECUTION,
    runId: binding.runId,
  });
  if (
    !row ||
    row.workflowName !== DurableStepIds.AGENTIC_EXECUTION ||
    row.runId !== binding.runId ||
    row.resourceId !== binding.resourceId
  )
    return false;
  let raw: unknown;
  try {
    raw =
      typeof row.snapshot === "string"
        ? JSON.parse(row.snapshot)
        : row.snapshot;
  } catch {
    return false;
  }
  const executionParsed = executionQuestionControlSchema.safeParse(raw);
  if (!executionParsed.success) return false;
  const execution = {
    ...executionParsed.data,
    context: (raw as typeof executionParsed.data).context,
  };
  if (
    !questionSnapshotMatchesBinding(loop, binding) ||
    !questionSnapshotMatchesBinding(execution, binding)
  )
    return false;
  const callId = question.toolCallId;
  const expected = {
    type: "suspension",
    toolCallSuspended: question,
    toolCallId: callId,
    toolName: "ask_user",
  };
  const sameEnvelope = (payload: unknown) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return false;
    const {
      __workflow_meta: _meta,
      __streamState: _stream,
      ...bare
    } = payload as Record<string, unknown>;
    return isDeepStrictEqual(bare, expected);
  };
  const selected = (
    snapshot: typeof execution,
    key: string,
    position: number,
  ) => {
    const context = snapshot.context as Record<string, any>;
    return (
      snapshot.status === "suspended" &&
      isDeepStrictEqual(snapshot.activePaths, [position]) &&
      isDeepStrictEqual(snapshot.activeStepsPath, {}) &&
      isDeepStrictEqual(snapshot.suspendedPaths, { [key]: [position] }) &&
      isDeepStrictEqual(snapshot.waitingPaths, {}) &&
      context[key]?.status === "suspended" &&
      Object.entries(context).every(
        ([id, step]) =>
          id === "input" ||
          id === key ||
          !["suspended", "running", "waiting", "pending", "paused"].includes(
            step?.status,
          ),
      )
    );
  };
  if (
    !selected(loop, DurableStepIds.AGENTIC_EXECUTION, 1) ||
    !selected(execution, DurableStepIds.TOOL_CALL, 3)
  )
    return false;
  const loopStep = (loop.context as Record<string, any>)[
    DurableStepIds.AGENTIC_EXECUTION
  ];
  const toolStep = (execution.context as Record<string, any>)[
    DurableStepIds.TOOL_CALL
  ];
  const toolMeta = toolStep.suspendPayload?.__workflow_meta;
  const loopMeta = loopStep.suspendPayload?.__workflow_meta;
  const index = toolMeta?.foreachIndex;
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= 64 ||
    loopMeta?.foreachIndex !== index ||
    loopMeta.runId !== binding.runId ||
    !isDeepStrictEqual(loopMeta.path, [DurableStepIds.TOOL_CALL]) ||
    !sameEnvelope(loopStep.suspendPayload) ||
    !sameEnvelope(toolStep.suspendPayload)
  )
    return false;
  const toolLabels = {
    [callId]: { stepId: DurableStepIds.TOOL_CALL, foreachIndex: index },
  };
  if (
    !(
      isDeepStrictEqual(loop.resumeLabels, {
        [callId]: { stepId: DurableStepIds.AGENTIC_EXECUTION },
      }) ||
      (allowMissingLoopLabel && isDeepStrictEqual(loop.resumeLabels, {}))
    ) ||
    !isDeepStrictEqual(execution.resumeLabels, toolLabels) ||
    !isDeepStrictEqual(toolMeta.resumeLabels, toolLabels) ||
    !isDeepStrictEqual(loopMeta.resumeLabels, toolLabels)
  )
    return false;
  return (
    proveQuestionForeachPayload(
      loopStep.suspendPayload,
      toolStep.payload,
      question,
    ) &&
    proveQuestionForeachPayload(
      toolStep.suspendPayload,
      toolStep.payload,
      question,
    )
  );
}

function proveQuestionForeachPayload(
  payload: any,
  calls: any,
  question: NativeQuestionSuspension,
) {
  const callId = question.toolCallId;
  const index = payload?.__workflow_meta?.foreachIndex;
  const expected = {
    type: "suspension",
    toolCallSuspended: question,
    toolCallId: callId,
    toolName: "ask_user",
  };
  const sameEnvelope = (value: any) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const { __workflow_meta: _meta, __streamState: _stream, ...bare } = value;
    return isDeepStrictEqual(bare, expected);
  };
  const originalCall = (call: any) =>
    call?.toolCallId === callId &&
    call?.toolName === "ask_user" &&
    isDeepStrictEqual(call.args, { question: question.questionProof.question });
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= 64 ||
    !sameEnvelope(payload) ||
    !isDeepStrictEqual(payload.__workflow_meta.resumeLabels, {
      [callId]: { stepId: DurableStepIds.TOOL_CALL, foreachIndex: index },
    })
  )
    return false;
  if (
    !Array.isArray(calls) ||
    calls.length === 0 ||
    calls.length > 64 ||
    !originalCall(calls[index]) ||
    calls.filter((call: any) => call?.toolCallId === callId).length !== 1
  )
    return false;
  for (const metadata of [payload.__workflow_meta]) {
    const outputs = metadata.foreachOutput;
    if (
      !outputs ||
      typeof outputs !== "object" ||
      Object.keys(outputs).length > 64 ||
      (Array.isArray(outputs) && outputs.length > calls.length)
    )
      return false;
    const entries = Object.entries(outputs);
    if (
      !entries.every(([key, entry]: [string, any]) => {
        const position = Number(key);
        let originalPayload = isDeepStrictEqual(
          entry?.payload,
          calls[position],
        );
        // A resumed successful foreach step carries its complete input batch.
        // Its output still names the original call for this exact iteration.
        if (
          position !== index &&
          isDeepStrictEqual(entry?.payload, calls) &&
          entry?.output &&
          typeof entry.output === "object" &&
          !Array.isArray(entry.output)
        ) {
          const {
            result: _result,
            transformMetadata: _transform,
            ...originalOutput
          } = entry.output;
          originalPayload = isDeepStrictEqual(originalOutput, calls[position]);
        }
        return (
          Number.isInteger(position) &&
          position >= 0 &&
          position < calls.length &&
          String(position) === key &&
          entry?.status === (position === index ? "suspended" : "success") &&
          originalPayload
        );
      })
    )
      return false;
    const suspended = entries.filter(
      ([, entry]: [string, any]) => entry?.status === "suspended",
    );
    const entry = outputs[index];
    if (
      suspended.length !== 1 ||
      suspended[0]![0] !== String(index) ||
      !sameEnvelope(entry?.suspendPayload) ||
      !originalCall(entry?.payload) ||
      !isDeepStrictEqual(entry.payload, entry.suspendOutput)
    )
      return false;
  }
  return true;
}

/** A running checkpoint is never suspension proof. This separate passive proof
 * permits replay only at the original question tool before its native ACK. */
async function readQuestionRecoveryPoint(
  storage: MastraCompositeStore,
  binding: NativeAgentRunBinding & { toolCallId: string },
  resumeData: unknown,
) {
  const answer = NativeQuestionAnswerSchema.safeParse(resumeData);
  if (!answer.success) return undefined;
  const checkpoint = await inspectNativeAgentCheckpoint(storage, binding);
  if (checkpoint?.status !== "running" || !checkpoint.questionProofsValid)
    return undefined;
  const workflows = await storage.getStore("workflows");
  if (!workflows) throw new Error("niaro_native_recovery_storage_required");
  const rows = await Promise.all([
    workflows.getWorkflowRunById({
      workflowName: DurableStepIds.AGENTIC_LOOP,
      runId: binding.runId,
    }),
    workflows.getWorkflowRunById({
      workflowName: DurableStepIds.AGENTIC_EXECUTION,
      runId: binding.runId,
    }),
  ]);
  const snapshots: z.infer<typeof executionQuestionControlSchema>[] = [];
  for (const [index, row] of rows.entries()) {
    if (
      !row ||
      row.workflowName !==
        (index === 0
          ? DurableStepIds.AGENTIC_LOOP
          : DurableStepIds.AGENTIC_EXECUTION) ||
      row.runId !== binding.runId ||
      row.resourceId !== binding.resourceId
    )
      return undefined;
    let raw: unknown;
    try {
      raw =
        typeof row.snapshot === "string"
          ? JSON.parse(row.snapshot)
          : row.snapshot;
    } catch {
      return undefined;
    }
    const checked = (
      index === 0
        ? activeQuestionRecoverySchema
        : executionQuestionControlSchema
    ).safeParse(raw);
    if (
      !checked.success ||
      checked.data.runId !== binding.runId ||
      checked.data.status !== "running"
    )
      return undefined;
    const input = checked.data.context.input;
    if (
      input.runId !== binding.runId ||
      input.agentId !== binding.agentId ||
      (input.state?.threadId ??
        input.messageListState?.memoryInfo?.threadId) !== binding.threadId ||
      (input.state?.resourceId ??
        input.messageListState?.memoryInfo?.resourceId) !==
        binding.resourceId ||
      (input.state?.threadId !== undefined &&
        input.state.threadId !== binding.threadId) ||
      (input.state?.resourceId !== undefined &&
        input.state.resourceId !== binding.resourceId) ||
      (input.messageListState?.memoryInfo?.threadId !== undefined &&
        input.messageListState.memoryInfo.threadId !== binding.threadId) ||
      (input.messageListState?.memoryInfo?.resourceId !== undefined &&
        input.messageListState.memoryInfo.resourceId !== binding.resourceId)
    )
      return undefined;
    if (
      Object.keys(checked.data.suspendedPaths).length ||
      Object.keys(checked.data.waitingPaths).length ||
      Object.keys(checked.data.resumeLabels).length
    )
      return undefined;
    // Retain native context privately; validation only exposes bounded proof metadata.
    snapshots.push({
      ...checked.data,
      context: (raw as typeof checked.data).context,
    });
  }
  const [loop, execution] = snapshots as [
    (typeof snapshots)[number],
    (typeof snapshots)[number],
  ];
  if (
    !isDeepStrictEqual(loop.activePaths, [1]) ||
    !isDeepStrictEqual(loop.activeStepsPath, {
      [DurableStepIds.AGENTIC_EXECUTION]: [1],
    }) ||
    !isDeepStrictEqual(execution.activePaths, [3]) ||
    !isDeepStrictEqual(execution.activeStepsPath, {
      [DurableStepIds.TOOL_CALL]: [3],
    })
  )
    return undefined;
  const loopStep = (loop.context as Record<string, any>)[
    DurableStepIds.AGENTIC_EXECUTION
  ];
  const tool = (execution.context as Record<string, any>)[
    DurableStepIds.TOOL_CALL
  ];
  if (
    loopStep?.status !== "running" ||
    tool?.status !== "running" ||
    !isDeepStrictEqual(loopStep.resumePayload, answer.data) ||
    !isDeepStrictEqual(tool.resumePayload, answer.data) ||
    tool.output !== undefined ||
    !Array.isArray(tool.payload) ||
    tool.payload.length === 0 ||
    tool.payload.length > 64
  )
    return undefined;
  const inactive = (snapshot: typeof execution, key: string) =>
    Object.entries(snapshot.context).every(
      ([id, step]: [string, any]) =>
        id === "input" ||
        id === key ||
        !["suspended", "running", "waiting", "pending", "paused"].includes(
          step?.status,
        ),
    );
  if (
    !inactive(loop, DurableStepIds.AGENTIC_EXECUTION) ||
    !inactive(execution, DurableStepIds.TOOL_CALL)
  )
    return undefined;
  return {
    answer: answer.data,
    loop,
    execution,
    tool,
    workflows,
    executionRow: rows[1]!,
  };
}

export async function inspectNativeAgentQuestionRecovery(
  storage: MastraCompositeStore,
  binding: NativeAgentRunBinding & { toolCallId: string },
  resumeData: unknown,
): Promise<ProcessQuestion | undefined> {
  const point = await readQuestionRecoveryPoint(storage, binding, resumeData);
  if (!point) return undefined;
  const { answer, execution, tool } = point;
  const matches = tool.payload.filter(
    (call: any) => call?.toolCallId === binding.toolCallId,
  );
  if (matches.length !== 1) return undefined;
  const call = matches[0];
  if (
    call?.toolCallId !== binding.toolCallId ||
    call?.toolName !== "ask_user" ||
    !call.args ||
    typeof call.args !== "object" ||
    Object.keys(call.args).length !== 1 ||
    typeof call.args.question !== "string"
  )
    return undefined;
  let retainedQuestion: ProcessQuestion | undefined;
  if (tool.payload.length > 1) {
    const payload = tool.suspendPayload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return undefined;
    const { __workflow_meta: _meta, __streamState: _stream, ...bare } = payload;
    const retained = NativeQuestionEnvelopeSchema.safeParse(bare);
    if (!retained.success) return undefined;
    const suspension = retained.data.toolCallSuspended;
    const question = suspension.questionProof;
    if (
      question.childRunId !== binding.runId ||
      question.childThreadId !== binding.threadId ||
      question.resourceId !== binding.resourceId ||
      question.toolCallId !== binding.toolCallId ||
      question.questionId !== answer.questionId ||
      question.questionRevision !== answer.questionRevision ||
      question.question !== call.args.question ||
      question.questionDigest !==
        createHash("sha256")
          .update(JSON.stringify(question.question))
          .digest("hex") ||
      !proveQuestionForeachPayload(payload, tool.payload, suspension)
    )
      return undefined;
    retainedQuestion = question;
  } else if (tool.suspendPayload !== undefined) return undefined;
  const llm = (execution.context as Record<string, any>)[
    DurableStepIds.LLM_EXECUTION
  ];
  if (llm?.status !== "success") return undefined;
  const messages = llm.output?.messageListState?.messages;
  if (!Array.isArray(messages) || messages.length > 64) return undefined;
  const candidates: ProcessQuestion[] = [];
  for (const message of messages) {
    const tools = message?.content?.metadata?.suspendedTools;
    if (tools === undefined) continue;
    if (
      !tools ||
      typeof tools !== "object" ||
      Array.isArray(tools) ||
      Object.keys(tools).length > 64
    )
      return undefined;
    for (const [key, value] of Object.entries(tools)) {
      if (key !== binding.toolCallId) continue;
      const saved = questionMemorySuspensionSchema.safeParse(value);
      if (!saved.success) return undefined;
      const question = saved.data.suspendPayload.questionProof;
      if (
        saved.data.runId !== binding.runId ||
        saved.data.toolCallId !== binding.toolCallId ||
        saved.data.suspendPayload.toolCallId !== binding.toolCallId ||
        question.toolCallId !== binding.toolCallId ||
        question.childRunId !== binding.runId ||
        question.childThreadId !== binding.threadId ||
        question.resourceId !== binding.resourceId ||
        saved.data.args.question !== question.question ||
        call.args.question !== question.question ||
        question.questionId !== answer.questionId ||
        question.questionRevision !== answer.questionRevision ||
        question.questionDigest !==
          createHash("sha256")
            .update(JSON.stringify(question.question))
            .digest("hex")
      )
        return undefined;
      candidates.push(question);
    }
  }
  if (retainedQuestion) {
    // Later questions from the same model turn are absent from the original
    // LLM output. The retained, previously proved foreach payload is their proof.
    if (
      candidates.length > 1 ||
      (candidates.length === 1 &&
        !isDeepStrictEqual(candidates[0], retainedQuestion))
    )
      return undefined;
    return retainedQuestion;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Preserve Mastra's already-proved foreach cursor in its own running tool row.
 * The SDK otherwise drops completed siblings before a tool's durable ACK. */
export type NativeQuestionContinuation = {
  calls: unknown[];
  suspendPayload: Record<string, unknown>;
};

export async function captureNativeQuestionContinuation(
  storage: MastraCompositeStore,
  binding: NativeAgentRunBinding & { toolCallId: string },
  question: ProcessQuestion,
  resumeData?: unknown,
): Promise<NativeQuestionContinuation | undefined> {
  const proved =
    resumeData === undefined
      ? proveNativeAgentQuestionCheckpoint(
          await inspectNativeAgentCheckpoint(storage, binding),
          binding,
          question,
        )
      : await proveNativeAgentQuestionRecovery(
          storage,
          binding,
          question,
          resumeData,
        );
  if (!proved) throw new Error("niaro_native_question_proof_invalid");
  const workflows = await storage.getStore("workflows");
  if (!workflows) throw new Error("niaro_native_recovery_storage_required");
  const row = await workflows.getWorkflowRunById({
    workflowName: DurableStepIds.AGENTIC_EXECUTION,
    runId: binding.runId,
  });
  if (
    !row ||
    row.workflowName !== DurableStepIds.AGENTIC_EXECUTION ||
    row.runId !== binding.runId ||
    row.resourceId !== binding.resourceId
  )
    throw new Error("niaro_native_question_proof_invalid");
  const snapshot =
    typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : row.snapshot;
  const tool = (snapshot as any)?.context?.[DurableStepIds.TOOL_CALL];
  if (tool?.payload?.length === 1) return undefined;
  if (
    !proveQuestionForeachPayload(tool?.suspendPayload, tool?.payload, {
      kind: "question",
      toolName: "ask_user",
      toolCallId: binding.toolCallId,
      questionProof: question,
    })
  )
    throw new Error("niaro_native_question_proof_invalid");
  return structuredClone({
    calls: tool.payload,
    suspendPayload: tool.suspendPayload,
  });
}

export async function retainNativeQuestionContinuation(
  storage: MastraCompositeStore,
  binding: NativeAgentRunBinding & { toolCallId: string },
  question: ProcessQuestion,
  resumeData: unknown,
  continuation: NativeQuestionContinuation | undefined,
) {
  if (!continuation) return;
  const point = await readQuestionRecoveryPoint(storage, binding, resumeData);
  if (
    !point ||
    !isDeepStrictEqual(point.tool.payload, continuation.calls) ||
    !proveQuestionForeachPayload(
      continuation.suspendPayload,
      continuation.calls,
      {
        kind: "question",
        toolName: "ask_user",
        toolCallId: binding.toolCallId,
        questionProof: question,
      },
    )
  )
    throw new Error("niaro_native_question_proof_invalid");
  const row = point.executionRow;
  const snapshot: any = structuredClone(
    typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : row.snapshot,
  );
  snapshot.context[DurableStepIds.TOOL_CALL].suspendPayload = structuredClone(
    continuation.suspendPayload,
  );
  await point.workflows.persistWorkflowSnapshot({
    workflowName: row.workflowName,
    runId: row.runId,
    resourceId: row.resourceId!,
    snapshot,
  });
  if (
    !(await proveNativeAgentQuestionRecovery(
      storage,
      binding,
      question,
      resumeData,
    ))
  )
    throw new Error("niaro_native_question_proof_invalid");
}

/** SDK restart forwards the exact nested suspension but omits its outer label.
 * Repair only that alias after owned batch recovery; ordinary proof stays strict. */
export async function reconcileNativeQuestionRecoverySuspension(
  storage: MastraCompositeStore,
  binding: NativeAgentRunBinding & { toolCallId: string },
  question: ProcessQuestion,
) {
  const checked = ProcessQuestionSchema.safeParse(question);
  if (
    !checked.success ||
    checked.data.childRunId !== binding.runId ||
    checked.data.childThreadId !== binding.threadId ||
    checked.data.resourceId !== binding.resourceId ||
    checked.data.toolCallId !== binding.toolCallId ||
    checked.data.questionDigest !==
      createHash("sha256")
        .update(JSON.stringify(checked.data.question))
        .digest("hex")
  )
    throw new Error("niaro_native_question_proof_invalid");
  const checkpoint = await inspectNativeAgentCheckpoint(storage, binding);
  if (proveNativeAgentQuestionCheckpoint(checkpoint, binding, checked.data))
    return;
  const workflows = await storage.getStore("workflows");
  if (!workflows) throw new Error("niaro_native_recovery_storage_required");
  const row = await workflows.getWorkflowRunById({
    workflowName: DurableStepIds.AGENTIC_LOOP,
    runId: binding.runId,
  });
  if (
    !row ||
    row.workflowName !== DurableStepIds.AGENTIC_LOOP ||
    row.runId !== binding.runId ||
    row.resourceId !== binding.resourceId
  )
    throw new Error("niaro_native_question_proof_invalid");
  const snapshot: any = structuredClone(
    typeof row.snapshot === "string" ? JSON.parse(row.snapshot) : row.snapshot,
  );
  if (
    !(await proveQuestionSuspensionControls(
      workflows,
      binding,
      snapshot,
      {
        kind: "question",
        toolName: "ask_user",
        toolCallId: binding.toolCallId,
        questionProof: checked.data,
      },
      true,
    ))
  )
    throw new Error("niaro_native_question_proof_invalid");
  snapshot.resumeLabels = {
    [binding.toolCallId]: { stepId: DurableStepIds.AGENTIC_EXECUTION },
  };
  await workflows.persistWorkflowSnapshot({
    workflowName: row.workflowName,
    runId: row.runId,
    resourceId: row.resourceId!,
    snapshot,
  });
  if (
    !proveNativeAgentQuestionCheckpoint(
      await inspectNativeAgentCheckpoint(storage, binding),
      binding,
      checked.data,
    )
  )
    throw new Error("niaro_native_question_proof_invalid");
}

export async function proveNativeAgentQuestionRecovery(
  storage: MastraCompositeStore,
  binding: NativeAgentRunBinding & { toolCallId: string },
  question: ProcessQuestion,
  resumeData: unknown,
) {
  const parsed = ProcessQuestionSchema.safeParse(question);
  if (!parsed.success) return false;
  const saved = await inspectNativeAgentQuestionRecovery(
    storage,
    binding,
    resumeData,
  );
  return !!saved && isDeepStrictEqual(saved, parsed.data);
}

/**
 * Reattach to an orphaned RUNNING durable execution using Mastra's saved tool IDs.
 * A normal tool error or user cancellation is terminal in core 1.74; its snapshots
 * are cleaned up. Missing/terminal checkpoints must never trigger a fresh model call.
 * Suspended executions require an explicit authorized resume instead.
 */
export async function recoverNativeAgentRun({
  agent,
  storage,
  binding,
  authorize,
  options,
}: {
  agent: Pick<DurableAgent, "id" | "recoverActiveRuns">;
  storage: MastraCompositeStore;
  binding: NativeAgentRunBinding;
  authorize(): Promise<void>;
  options?: NativeAgentRecoveryOptions;
}) {
  options?.abortSignal?.throwIfAborted();
  if (agent.id !== binding.agentId) {
    throw new Error("niaro_native_recovery_agent_mismatch");
  }
  await authorize();
  const checkpoint = await inspectNativeAgentCheckpoint(storage, binding);
  if (!checkpoint) {
    throw new Error("niaro_native_recovery_checkpoint_missing");
  }
  if (checkpoint.status === "suspended") {
    throw new Error("niaro_native_recovery_resume_required");
  }
  if (checkpoint.status !== "running") {
    throw new Error("niaro_native_recovery_checkpoint_not_running");
  }
  // Authorization is current when execution attaches. Individual domain tools
  // still recheck current authorization before dispatching any side effect.
  await authorize();
  options?.abortSignal?.throwIfAborted();
  // The streaming recover() output finishes before the workflow's final storage
  // writes. This public API waits for native workflow settlement before cleanup;
  // closing the store afterward cannot race a pending snapshot write.
  const summary = await agent.recoverActiveRuns({
    runId: binding.runId,
    threadId: binding.threadId,
    resourceId: binding.resourceId,
  });
  const recovered = summary.recovered[0];
  if (summary.recovered.length !== 1 || recovered?.runId !== binding.runId) {
    throw new Error("niaro_native_recovery_result_invalid");
  }
  if (recovered.status === "failed") throw recovered.error;
  options?.abortSignal?.throwIfAborted();
  return recovered;
}
