/**
 * Service processes on the Pi agent core (NIAR-303). A frozen process graph
 * runs as Pi tasks, one per drive of the run (a start, or a resume after an
 * approval or a question): each node is a task phase, and the run's
 * checkpoint (`niaro.process-run`, one session document per run) records the
 * carry before and after every node, so the next drive, or the passive proof
 * after a restart, continues from the last node that ended.
 *
 * Policy A: a task cut off by a crash is abandoned when the core reopens (its
 * boundary lived in the request that drove it); the run resumes from its
 * checkpoint on the next drive, once the domain has proved every boundary it
 * crossed (`boundary.reconcile`). Actions are never re-run blindly: the
 * domain decides from its receipts.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  defineDocFamily,
  defineExtension,
  defineTask,
  ROOT_CONVERSATION_ID,
  type Harness,
  type JsonObject,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { ProcessDefinition } from "../../../packages/protocol/service-processes";
import {
  processGraphDigest,
  ProcessRunCheckpointSchema,
  sameProcessCheckpointValue,
  type ProcessRunCheckpoint,
  type ProcessRunStep,
} from "../process-checkpoint";
import {
  assertProcessCompilerSupported,
  initialProcessCarry,
  orderedProcessNodes,
  processValueSchema,
  processWorkflowDefinition,
  runProcessNode,
  ProcessAnyResumeSchema,
  ProcessApprovalSchema,
  ProcessQuestionSuspendSchema,
  ProcessResumeSchema,
  type NativeWorkflowBoundary,
  type ProcessAnyResume,
  type ProcessApproval,
  type ProcessQuestion,
} from "../process-workflow";
import { ctx } from "./context";
import { RECOVERY_POLICY_A } from "./policy";

export type NativeWorkflowInput = {
  runId: string;
  resourceId: string;
  /** Canonical digest of the immutable registry version, provided by the server. */
  artifactDigest: string;
  /** Trusted compiler identity from the immutable saved journal, never a request. */
  compilerVersion: string;
  definition: ProcessDefinition;
  input: Record<string, unknown>;
  /** A missing checkpoint must not erase recorded domain progress. */
  recordedProgress?: boolean;
  /**
   * The server drives the run by itself after a restart (policy A): a run
   * stopped mid-run restarts at most `restartLimit` times this way.
   */
  automatic?: boolean;
  resume?: ProcessAnyResume;
  signal: AbortSignal;
  boundary: NativeWorkflowBoundary;
};
export type NativeWorkflowResult =
  | { status: "succeeded"; output: Record<string, unknown> }
  | { status: "waiting"; approval: ProcessApproval }
  | { status: "waiting"; question: ProcessQuestion }
  | { status: "failed"; code: string };

/** Failure codes a run reports as they are; anything else is generic. */
const REPORTED = new Set([
  "process_output_invalid",
  "process_step_limit",
  "process_duration_exceeded",
  "process_approval_conflict",
  "process_question_conflict",
  "process_agent_budget_required",
]);

export const ProcessRunDoc = defineDocFamily<JsonObject, string>({
  kind: "niaro.process-run",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({}),
  checkpointWhen: () => true,
});

/** The id of a run's checkpoint: compiler, run, resource and artifact. */
export function processWorkflowId(
  input: Pick<
    NativeWorkflowInput,
    "compilerVersion" | "runId" | "resourceId" | "artifactDigest"
  >,
) {
  return (
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
      .digest("hex")
  );
}

type Drive = {
  input: NativeWorkflowInput;
  workflowId: string;
};
/** Drives in this process, by token; a task without one was cut off by a restart. */
const drives = new Map<string, Drive>();

type SegmentResult =
  | { status: "succeeded"; output: JsonObject }
  | { status: "waiting"; pending: JsonObject }
  | { status: "failed"; code: string };
type SegmentInput = { token: string; workflowId: string };
type SegmentState = { phase: "node"; step: number };

const json = <T>(value: T) => JSON.parse(JSON.stringify(value)) as T;
const failureCode = (error: unknown) =>
  error instanceof Error && REPORTED.has(error.message)
    ? error.message
    : "process_execution_failed";

const ProcessSegmentTask = defineTask<
  SegmentInput,
  SegmentState,
  SegmentResult
>({
  name: "niaro.process-segment",
  version: 1,
  initial: () => ({ phase: "node", step: 0 }),
  phases: {
    node: async (task, runtime, context) => {
      const drive = drives.get(task.input.token);
      const read = async () =>
        ProcessRunCheckpointSchema.parse(
          await runtime.snapshot(ProcessRunDoc, task.input.workflowId, context),
        );
      const finish = (
        change: (run: ProcessRunCheckpoint) => void,
        result: SegmentResult,
      ) =>
        runtime.commit(async (tx) => {
          const draft = await tx.doc(
            ProcessRunDoc,
            task.input.workflowId,
            task.input.workflowId,
          );
          const run = ProcessRunCheckpointSchema.parse(json(draft));
          change(run);
          Object.assign(draft, json(run));
          return {
            status: "terminal",
            outcome: { status: "completed", result: result as never },
          };
        }, context);
      // Cut off by a restart: the request that drove it is gone.
      if (!drive) {
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                status: "failed",
                code: "process_checkpoint_interrupted",
              },
            },
          }),
          context,
        );
        return;
      }
      const { input } = drive;
      const original = input.definition;
      const definition = processWorkflowDefinition(original);
      const nodes = new Map(
        orderedProcessNodes(definition).map((node) => [node.id, node]),
      );
      const run = await read();
      const last = run.steps.at(-1);
      // The step to run: the one this drive was resumed or restarted in, or
      // the next one after the last that ended.
      let step: ProcessRunStep | undefined;
      if (last?.status === "running") step = last;
      else {
        const carry =
          last?.status === "success"
            ? last.output!
            : initialProcessCarry(definition, run.input);
        if (carry.next === null) {
          const output = processValueSchema(definition.outputSchema).safeParse(
            carry.result,
          );
          try {
            input.signal.throwIfAborted();
            await input.boundary.authorize();
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            await finish(
              (value) => {
                value.status = "failed";
                value.failure = failureCode(error);
              },
              { status: "failed", code: failureCode(error) },
            );
            return;
          }
          if (!output.success) {
            await finish(
              (value) => {
                value.status = "failed";
                value.failure = "process_output_invalid";
              },
              { status: "failed", code: "process_output_invalid" },
            );
            return;
          }
          await finish(
            (value) => {
              value.status = "success";
              value.result = json(output.data) as Record<string, unknown>;
            },
            { status: "succeeded", output: json(output.data) as JsonObject },
          );
          return;
        }
        step = { nodeId: carry.next, carry, status: "running" };
        const entered = step;
        await runtime.commit(async (tx, current) => {
          const draft = await tx.doc(
            ProcessRunDoc,
            task.input.workflowId,
            task.input.workflowId,
          );
          const value = ProcessRunCheckpointSchema.parse(json(draft));
          value.steps.push(entered);
          value.status = "running";
          Object.assign(draft, json(value));
          return {
            status: "running",
            checkpoint: {
              phase: "node",
              step: current.state.checkpoint.step + 1,
            },
          };
        }, context);
      }
      const node = nodes.get(step.nodeId);
      try {
        if (!node) throw new Error("process_checkpoint_invalid");
        const outcome = await runProcessNode({
          original,
          node,
          carry: step.carry,
          resume: step.resume as ProcessAnyResume | undefined,
          boundary: input.boundary,
          signal: input.signal,
          compilerVersion: input.compilerVersion,
        });
        if (outcome.status === "waiting") {
          await finish(
            (value) => {
              const current = value.steps.at(-1)!;
              current.status = "suspended";
              current.pending = json(outcome.pending);
              value.status = "suspended";
            },
            { status: "waiting", pending: json(outcome.pending) as JsonObject },
          );
          return;
        }
        await runtime.commit(async (tx, current) => {
          const draft = await tx.doc(
            ProcessRunDoc,
            task.input.workflowId,
            task.input.workflowId,
          );
          const value = ProcessRunCheckpointSchema.parse(json(draft));
          const entered = value.steps.at(-1)!;
          entered.status = "success";
          entered.output = json(outcome.carry);
          Object.assign(draft, json(value));
          return {
            status: "running",
            checkpoint: {
              phase: "node",
              step: current.state.checkpoint.step + 1,
            },
          };
        }, context);
      } catch (error) {
        // A close or a restart cut it off: the checkpoint stays inside the node.
        if (runtime.signal.aborted) throw error;
        await finish(
          (value) => {
            value.status = input.signal.aborted ? "canceled" : "failed";
            value.failure = failureCode(error);
          },
          { status: "failed", code: failureCode(error) },
        );
      }
    },
  },
  // Abandoned after a restart or aborted with its drive: the checkpoint
  // keeps the node the run stopped in, for a proved restart.
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context,
    );
  },
});

export const processEngineExtension = defineExtension({
  name: "niaro-processes",
  tasks: [ProcessSegmentTask],
});

/** The agent core's harness, as a process drive uses it. */
export type ProcessHarness = Harness;

/** Runs in this process, so one run is never driven twice at once. */
const active = new Set<string>();

function pendingOf(
  input: NativeWorkflowInput,
  payload: unknown,
): ProcessApproval | ProcessQuestion | undefined {
  const parsed = (
    input.compilerVersion === "niaro-native-workflow/3"
      ? ProcessQuestionSuspendSchema
      : ProcessApprovalSchema
  ).safeParse(payload);
  if (!parsed.success) return undefined;
  if ("kind" in parsed.data) {
    const question = parsed.data;
    const node = processWorkflowDefinition(input.definition).steps.find(
      (item) => item.id === question.nodeId,
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
const waitingResult = (
  pending: ProcessApproval | ProcessQuestion,
): NativeWorkflowResult =>
  "kind" in pending
    ? { status: "waiting", question: pending }
    : { status: "waiting", approval: pending };
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

/** The stored checkpoint of a run, when it is this run's and readable. */
async function storedRun(
  harness: ProcessHarness,
  input: Pick<
    NativeWorkflowInput,
    "runId" | "resourceId" | "definition" | "compilerVersion" | "input"
  >,
  workflowId: string,
) {
  const raw = await harness.snapshot(ProcessRunDoc, workflowId, ctx);
  if (!raw) return { found: false as const };
  const parsed = ProcessRunCheckpointSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.workflowId !== workflowId ||
    parsed.data.runId !== input.runId ||
    parsed.data.resourceId !== input.resourceId ||
    parsed.data.graph !==
      processGraphDigest(input.definition, input.compilerVersion) ||
    !sameProcessCheckpointValue(parsed.data.input, input.input)
  )
    return { found: true as const, run: undefined };
  return { found: true as const, run: parsed.data };
}

/** Passive exact checkpoint proof for command retirement; nothing runs. */
export async function proveProcessRunRetired(
  harness: ProcessHarness,
  input: Pick<
    NativeWorkflowInput,
    | "runId"
    | "resourceId"
    | "artifactDigest"
    | "compilerVersion"
    | "definition"
    | "input"
  >,
) {
  try {
    assertProcessCompilerSupported(input.compilerVersion, input.definition);
  } catch {
    return false;
  }
  const workflowId = processWorkflowId(input);
  if (active.has(workflowId)) return false;
  const stored = await storedRun(harness, input, workflowId);
  return (
    !!stored.run &&
    ["success", "failed", "canceled", "suspended"].includes(
      stored.run.status,
    ) &&
    !active.has(workflowId)
  );
}

/** Drive a run from its checkpoint until it waits, succeeds or fails. */
export async function executeProcessRun(
  harness: ProcessHarness,
  input: NativeWorkflowInput,
): Promise<NativeWorkflowResult> {
  input.signal.throwIfAborted();
  await input.boundary.authorize();
  assertProcessCompilerSupported(input.compilerVersion, input.definition);
  const definition = processWorkflowDefinition(input.definition);
  if (definition.steps.some((s) => s.type === "agent") && !input.boundary.agent)
    throw new Error("process_agent_runtime_required");
  if (
    input.resume &&
    !(
      input.compilerVersion === "niaro-native-workflow/3"
        ? ProcessAnyResumeSchema
        : ProcessResumeSchema
    ).safeParse(input.resume).success
  )
    throw new Error("process_question_conflict");
  const workflowId = processWorkflowId(input);
  if (active.has(workflowId)) throw new Error("niaro_native_run_busy");
  active.add(workflowId);
  try {
    const stored = await storedRun(harness, input, workflowId);
    if (stored.found && !stored.run)
      return { status: "failed", code: "process_checkpoint_invalid" };
    if (!stored.found && input.recordedProgress)
      return { status: "failed", code: "process_checkpoint_missing" };
    const run = stored.run;
    if (
      run &&
      input.boundary.reconcile &&
      !(await input.boundary.reconcile(structuredClone(run), workflowId))
    )
      return { status: "failed", code: "process_checkpoint_interrupted" };
    if (run?.status === "success") {
      if (input.resume) throw new Error("process_approval_conflict");
      return {
        status: "succeeded",
        output: processValueSchema(definition.outputSchema).parse(
          run.result,
        ) as Record<string, unknown>,
      };
    }
    const last = run?.steps.at(-1);
    const pending =
      run?.status === "suspended" && last?.status === "suspended"
        ? pendingOf(input, last.pending)
        : undefined;
    if (run?.status === "suspended" && !pending)
      return { status: "failed", code: "process_checkpoint_invalid" };
    if (input.resume) {
      if (!pending || !samePendingResume(pending, input.resume))
        throw new Error("process_approval_conflict");
    } else if (run) {
      if (pending) return waitingResult(pending);
      // Restart only after passive domain proof of the exact saved boundaries.
      // Missing proof is uncertainty, never permission to start another run.
      if (!input.boundary.reconcile || run.status !== "running")
        return { status: "failed", code: "process_checkpoint_interrupted" };
      if (
        input.automatic &&
        (run.automaticRestarts ?? 0) >= RECOVERY_POLICY_A.restartLimit
      )
        return { status: "failed", code: "process_restart_limit" };
    } else if (
      !processValueSchema(definition.inputSchema).safeParse(input.input).success
    )
      return { status: "failed", code: "process_execution_failed" };
    const token = randomUUID();
    drives.set(token, { input, workflowId });
    try {
      const taskId: TaskId<SegmentResult> = await harness.commit(async (tx) => {
        const draft = await tx.doc(ProcessRunDoc, workflowId, workflowId);
        const value: ProcessRunCheckpoint = run
          ? structuredClone(run)
          : {
              version: 1,
              workflowId,
              runId: input.runId,
              resourceId: input.resourceId,
              graph: processGraphDigest(
                input.definition,
                input.compilerVersion,
              ),
              input: input.input,
              status: "running",
              steps: [],
            };
        if (input.automatic && run && !input.resume)
          value.automaticRestarts = (value.automaticRestarts ?? 0) + 1;
        if (input.resume) {
          const resumed = value.steps.at(-1)!;
          resumed.status = "running";
          resumed.resume = input.resume;
          delete resumed.pending;
        }
        value.status = "running";
        Object.assign(draft, json(value));
        return tx.createTask(
          ProcessSegmentTask,
          { token, workflowId },
          {
            ownership: { kind: "conversation" },
            conversationId: ROOT_CONVERSATION_ID,
            background: true,
            abandonOnRestart: true,
          },
        );
      }, ctx);
      const abort = () => void harness.abortTask(taskId, ctx).catch(() => {});
      input.signal.addEventListener("abort", abort, { once: true });
      try {
        const settled = await harness.waitForTask(taskId, ctx);
        const outcome = settled.state.outcome;
        const result = outcome.result;
        if (outcome.status !== "completed" || !result)
          return { status: "failed", code: "process_execution_failed" };
        if (result.status === "succeeded")
          return { status: "succeeded", output: result.output };
        if (result.status === "failed") return result;
        const waiting = pendingOf(input, result.pending);
        if (!waiting) throw new Error("process_checkpoint_invalid");
        return waitingResult(waiting);
      } finally {
        input.signal.removeEventListener("abort", abort);
      }
    } finally {
      drives.delete(token);
    }
  } finally {
    active.delete(workflowId);
  }
}
