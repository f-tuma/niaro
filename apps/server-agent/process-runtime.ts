import { createHash } from "node:crypto";
import type { Mastra } from "@mastra/core/mastra";
import type { LibSQLStore } from "@mastra/libsql";
import type { ProcessDefinition } from "../../packages/protocol/service-processes";
import {
  ProcessWorkflowCheckpointSchema,
  sameProcessCheckpointGraph,
  sameProcessCheckpointValue,
} from "./process-checkpoint";
import {
  compileProcessWorkflow,
  assertProcessCompilerSupported,
  ProcessApprovalSchema,
  ProcessAnyResumeSchema,
  ProcessResumeSchema,
  ProcessQuestionSuspendSchema,
  processWorkflowDefinition,
  processValueSchema,
  type NativeWorkflowBoundary,
  type ProcessApproval,
  type ProcessAnyResume,
  type ProcessQuestion,
} from "./process-workflow";

export type NativeWorkflowInput = {
  runId: string;
  resourceId: string;
  /** Canonical digest of the immutable registry version, provided by the server. */
  artifactDigest: string;
  /** Trusted compiler identity from the immutable saved journal, never a request. */
  compilerVersion: string;
  definition: ProcessDefinition;
  input: Record<string, unknown>;
  /** A missing native snapshot must not erase recorded domain progress. */
  recordedProgress?: boolean;
  resume?: ProcessAnyResume;
  signal: AbortSignal;
  boundary: NativeWorkflowBoundary;
};
export type NativeWorkflowResult =
  | { status: "succeeded"; output: Record<string, unknown> }
  | { status: "waiting"; approval: ProcessApproval }
  | { status: "waiting"; question: ProcessQuestion }
  | { status: "failed"; code: string };

function nativeWorkflowPending(input: NativeWorkflowInput, payload: unknown) {
  const parsed = (
    input.compilerVersion === "niaro-native-workflow/3"
      ? ProcessQuestionSuspendSchema
      : ProcessApprovalSchema
  ).safeParse(payload);
  if (!parsed.success) return undefined;
  if ("kind" in parsed.data) {
    const question = parsed.data;
    const node = processWorkflowDefinition(input.definition).steps.find(
      (node) => node.id === question.nodeId,
    );
    if (
      node?.type !== "agent" ||
      node.humanInput !== "text" ||
      question.parentRunId !== input.runId ||
      question.resourceId !== input.resourceId ||
      question.artifactDigest !== input.artifactDigest ||
      question.compilerVersion !== input.compilerVersion
    )
      return undefined;
  }
  return parsed.data;
}
function waitingResult(
  pending: ProcessApproval | ProcessQuestion,
): NativeWorkflowResult {
  return "kind" in pending
    ? { status: "waiting", question: pending }
    : { status: "waiting", approval: pending };
}
function samePendingResume(
  pending: ProcessApproval | ProcessQuestion,
  resume: ProcessAnyResume,
) {
  return "kind" in pending
    ? "kind" in resume &&
        pending.nodeId === resume.nodeId &&
        pending.questionId === resume.questionId &&
        pending.questionRevision === resume.questionRevision
    : !("kind" in resume) &&
        pending.nodeId === resume.nodeId &&
        pending.operationId === resume.operationId;
}

/** Passive exact checkpoint proof for command retirement; no workflow registration or resume. */
export async function proveNativeWorkflowRetirement(
  storage: LibSQLStore,
  input: Pick<
    NativeWorkflowInput,
    | "runId"
    | "resourceId"
    | "artifactDigest"
    | "compilerVersion"
    | "definition"
    | "input"
    | "boundary"
  >,
) {
  try {
    assertProcessCompilerSupported(input.compilerVersion, input.definition);
  } catch {
    return false;
  }
  const workflowId =
    "niaro-process-" +
    createHash("sha256")
      .update(
        JSON.stringify([
          input.compilerVersion,
          input.runId,
          input.resourceId,
          input.artifactDigest,
        ]),
      )
      .digest("hex");
  const store = await storage.getStore("workflows");
  const previous = await store?.getWorkflowRunById({
    workflowName: workflowId,
    runId: input.runId,
  });
  if (
    !previous ||
    previous.resourceId !== input.resourceId ||
    previous.workflowName !== workflowId ||
    previous.runId !== input.runId
  )
    return false;
  let raw: unknown;
  try {
    raw =
      typeof previous.snapshot === "string"
        ? JSON.parse(previous.snapshot)
        : previous.snapshot;
  } catch {
    return false;
  }
  const parsed = ProcessWorkflowCheckpointSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.runId !== input.runId ||
    !sameProcessCheckpointValue(parsed.data.context.input, input.input)
  )
    return false;
  const workflow = compileProcessWorkflow(
    workflowId,
    input.definition,
    input.boundary,
    AbortSignal.abort(),
    input.compilerVersion,
  );
  return (
    sameProcessCheckpointGraph(
      parsed.data.serializedStepGraph,
      workflow.serializedStepGraph,
    ) &&
    ["success", "failed", "canceled", "cancelled", "suspended"].includes(
      parsed.data.status,
    )
  );
}

export async function executeNativeWorkflow(
  mastra: Mastra,
  storage: LibSQLStore,
  input: NativeWorkflowInput,
): Promise<NativeWorkflowResult> {
  input.signal.throwIfAborted();
  await input.boundary.authorize();
  const workflowId =
    "niaro-process-" +
    createHash("sha256")
      .update(
        JSON.stringify([
          input.compilerVersion,
          input.runId,
          input.resourceId,
          input.artifactDigest,
        ]),
      )
      .digest("hex");
  const workflow = compileProcessWorkflow(
    workflowId,
    input.definition,
    input.boundary,
    input.signal,
    input.compilerVersion,
  );
  if (
    input.resume &&
    !(
      input.compilerVersion === "niaro-native-workflow/3"
        ? ProcessAnyResumeSchema
        : ProcessResumeSchema
    ).safeParse(input.resume).success
  )
    throw new Error("process_question_conflict");
  const workflows = await storage.getStore("workflows");
  if (!workflows) throw new Error("process_storage_unavailable");
  const previous = await workflows.getWorkflowRunById({
    workflowName: workflowId,
    runId: input.runId,
  });
  let rawSnapshot: unknown;
  try {
    rawSnapshot = previous
      ? typeof previous.snapshot === "string"
        ? JSON.parse(previous.snapshot)
        : previous.snapshot
      : undefined;
  } catch {
    return { status: "failed", code: "process_checkpoint_invalid" };
  }
  if (previous && previous.resourceId !== input.resourceId)
    return { status: "failed", code: "process_checkpoint_invalid" };
  const parsed = previous
    ? ProcessWorkflowCheckpointSchema.safeParse(rawSnapshot)
    : undefined;
  if (
    previous &&
    (!parsed?.success ||
      previous.workflowName !== workflowId ||
      previous.runId !== input.runId ||
      parsed.data.runId !== input.runId ||
      !sameProcessCheckpointValue(parsed.data.context.input, input.input) ||
      !sameProcessCheckpointGraph(
        parsed.data.serializedStepGraph,
        workflow.serializedStepGraph,
      ))
  )
    return { status: "failed", code: "process_checkpoint_invalid" };
  if (!previous && input.recordedProgress)
    return { status: "failed", code: "process_checkpoint_missing" };
  const snapshot = parsed?.success ? parsed.data : undefined;
  if (
    snapshot &&
    input.boundary.reconcile &&
    !(await input.boundary.reconcile(snapshot, workflowId))
  )
    return { status: "failed", code: "process_checkpoint_interrupted" };
  if (snapshot?.status === "success") {
    if (input.resume) throw new Error("process_approval_conflict");
    return {
      status: "succeeded",
      output: processValueSchema(input.definition.outputSchema).parse(
        snapshot.result,
      ) as Record<string, unknown>,
    };
  }
  const pending =
    snapshot?.status === "suspended"
      ? Object.values(snapshot.context).flatMap((step) => {
          if (
            !step ||
            typeof step !== "object" ||
            !("status" in step) ||
            step.status !== "suspended"
          )
            return [];
          const pending = nativeWorkflowPending(
            input,
            "suspendPayload" in step ? step.suspendPayload : undefined,
          );
          return pending ? [pending] : [];
        })
      : [];
  if (
    input.compilerVersion === "niaro-native-workflow/3" &&
    snapshot?.status === "suspended"
  ) {
    const suspendedCount = Object.values(snapshot.context).filter(
      (step) =>
        step &&
        typeof step === "object" &&
        "status" in step &&
        step.status === "suspended",
    ).length;
    if (suspendedCount !== 1 || pending.length !== 1)
      return { status: "failed", code: "process_checkpoint_invalid" };
  }
  if (input.resume) {
    if (pending.length !== 1 || !samePendingResume(pending[0]!, input.resume))
      throw new Error("process_approval_conflict");
  } else if (snapshot) {
    if (snapshot.status === "suspended" && pending.length === 1)
      return waitingResult(pending[0]!);
    // Restart only after passive domain proof of the exact saved boundaries.
    // Missing proof is uncertainty, never permission to start another run.
    if (
      !input.boundary.reconcile ||
      !["running", "waiting"].includes(snapshot.status)
    )
      return { status: "failed", code: "process_checkpoint_interrupted" };
  }
  mastra.addWorkflow(workflow, workflowId);
  let cancellation: Promise<unknown> | undefined;
  try {
    const run = await workflow.createRun({
      runId: input.runId,
      resourceId: input.resourceId,
    });
    const cancel = () => {
      cancellation = run.cancel().catch(() => undefined);
    };
    input.signal.addEventListener("abort", cancel, { once: true });
    try {
      input.signal.throwIfAborted();
      const tracingOptions = { hideInput: true, hideOutput: true };
      const result = input.resume
        ? await run.resume({
            step: `execute_${input.resume.nodeId}`,
            resumeData: input.resume,
            tracingOptions,
          })
        : snapshot
          ? await run.restart({ tracingOptions })
          : await run.start({ inputData: input.input, tracingOptions });
      if (result.status === "success")
        return {
          status: "succeeded",
          output: result.result as Record<string, unknown>,
        };
      if (result.status === "suspended") {
        const approvals = Object.values(result.steps).flatMap((step) => {
          if (step.status !== "suspended") return [];
          const pending = nativeWorkflowPending(input, step.suspendPayload);
          return pending ? [pending] : [];
        });
        if (
          approvals.length !== 1 ||
          (input.compilerVersion === "niaro-native-workflow/3" &&
            Object.values(result.steps).filter(
              (step) => step.status === "suspended",
            ).length !== 1)
        )
          throw new Error("process_checkpoint_invalid");
        return waitingResult(approvals[0]!);
      }
      const code =
        result.status === "failed" &&
        [
          "process_output_invalid",
          "process_step_limit",
          "process_duration_exceeded",
          "process_approval_conflict",
          "process_question_conflict",
          "process_agent_budget_required",
        ].includes(result.error.message)
          ? result.error.message
          : "process_execution_failed";
      return { status: "failed", code };
    } finally {
      input.signal.removeEventListener("abort", cancel);
      await cancellation;
    }
  } finally {
    mastra.removeWorkflow(workflowId);
  }
}
