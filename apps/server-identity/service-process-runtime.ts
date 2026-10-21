import {
  Approval,
  Failure,
  JournalSchema,
  type Journal,
  newServiceProcessJournal,
  serviceProcessRunIdentity,
} from "./service-process-journal";
import { z } from "zod";
import type { Scope } from "../../packages/protocol";
import { IdentityId } from "../../packages/protocol/identity";
import type { ProcessVersion } from "../../packages/protocol/service-processes";
import {
  ProcessAnyResumeSchema,
  type NativeWorkflowInput,
} from "@niaro/server-agent";
import {
  type ProcessQuestion,
  type ProcessQuestionAccess,
} from "../../packages/protocol/process-questions";
import type { CatalogController, CatalogContext } from "./catalog-controller";
import type { ServiceProcessStore, ProcessActor } from "./service-processes";
import { processDigest } from "./process-validation";
import { nativeCatalogOwner } from "./mastra-runtime";
import { IdentityError } from "./error";
import { CONTACT_CONTEXT_TTL } from "./contact-context";
import type { AgentMemory } from "./agent-memory";
import {
  createProcessAgentBoundary,
  isQuestionResume,
  processQuestionAnswer,
} from "./process-agent-runtime";
import {
  startLoopStep,
  finishLoopStep,
  finishLoopTrace,
  toolOutcome,
} from "./loop-trace";
import {
  startLoopToolDetails,
  finishLoopToolDetails,
} from "./loop-tool-details";
import { loopText } from "./loop-redaction";

export type ProcessRunResult = Pick<
  Journal,
  | "runId"
  | "revision"
  | "processId"
  | "version"
  | "status"
  | "output"
  | "failure"
  | "operations"
> & {
  approval?: z.infer<typeof Approval>;
  question?: ProcessQuestion;
};
class ProcessFailure extends Error {
  constructor(
    readonly failure: z.infer<typeof Failure>,
    readonly outcome: "failed" | "unknown" | "cancelled" = "failed",
  ) {
    super(failure.code);
  }
}

/** Internal native runner; public mobile execution remains lifecycle/harness work. */
export function createServiceProcessRuntime(
  controller: CatalogController,
  registry: Pick<ServiceProcessStore, "pinRun" | "resolveRun">,
  context: CatalogContext,
  scope: Scope,
  organizationId: string,
  options: {
    memory?: AgentMemory;
    source?: "chat" | "console";
    questions?: ProcessQuestionAccess;
  } = {},
) {
  const target = { organizationId, workspaceId: scope.workspaceId };
  const scopeDigest = serviceProcessRunIdentity(
    scope,
    organizationId,
    "scope",
  ).scopeDigest;
  // Separate namespace from chat command IDs and native agent runs.
  const key = (runId: string) =>
    serviceProcessRunIdentity(scope, organizationId, runId).parentRunId;
  const actor = async (): Promise<ProcessActor> => {
    context.validateRequest?.();
    const current = await context.actor(target);
    if (current.userId !== scope.userId)
      throw new IdentityError(403, "identity_forbidden");
    return { ...target, ...current };
  };
  const result = (state: Journal): ProcessRunResult => ({
    runId: state.runId,
    revision: state.revision,
    processId: state.processId,
    version: state.version,
    status: state.status,
    operations: [...state.operations],
    ...(state.output ? { output: structuredClone(state.output) } : {}),
    ...(state.pending
      ? "kind" in state.pending
        ? { question: structuredClone(state.pending) }
        : { approval: { ...state.pending } }
      : {}),
    ...(state.failure ? { failure: { ...state.failure } } : {}),
  });

  async function execute(
    runId: string,
    signal: AbortSignal,
    start?: { processId: string; input: unknown },
    resume?: NativeWorkflowInput["resume"],
    validateOrigin?: () => void,
  ) {
    const id = key(runId);
    return controller.withTurn(`process-${id}`, async () => {
      signal.throwIfAborted();
      const native: typeof import("@niaro/server-agent") = await import(
        "@niaro/server-agent"
      );
      let artifact: ProcessVersion;
      let state: Journal;
      await context.serial(async () => {
        const current = await actor();
        artifact = start
          ? registry.pinRun(current, IdentityId.parse(start.processId), id)
          : registry.resolveRun(current, id);
        native.assertWorkflowSupported(artifact.definition);
        const saved = controller.store.turn(
          id,
          scope.workspaceId,
          scope.userId,
        );
        const savedState =
          saved === undefined ? undefined : JournalSchema.parse(saved);
        const modelNodes =
          artifact.definition.kind === "agent"
            ? [artifact.definition]
            : artifact.definition.steps.filter((s) => s.type === "agent");
        if (
          modelNodes.length &&
          (!resume || isQuestionResume(resume) || resume.approved !== false) &&
          (!savedState ||
            savedState.status === "running" ||
            savedState.status === "waiting")
        ) {
          const policy = controller.store.inferenceBudget.policy(
            organizationId,
            scope.workspaceId,
          );
          if (policy.settings.mode !== "enforce")
            throw new IdentityError(409, "process_budget_policy_required");
          for (const node of modelNodes) {
            const selected = controller.store.model(
              organizationId,
              node.modelId,
              "tools",
            );
            if (
              !policy.settings.prices.some(
                (p) =>
                  p.modelId === selected.model.id &&
                  p.modelRevision === selected.model.revision &&
                  p.providerRevision === selected.provider.revision,
              )
            )
              throw new IdentityError(409, "catalog_budget_price_required");
            if (node.memory === "saved" && !options.memory)
              throw new IdentityError(409, "process_memory_unavailable");
          }
        }
        if (savedState) {
          state = savedState;
          if (
            state.scopeDigest !== scopeDigest ||
            state.artifactDigest !== artifact.digest ||
            state.version !== artifact.version ||
            state.processId !== artifact.processId
          )
            throw new IdentityError(409, "process_conflict");
          try {
            native.assertProcessCompilerSupported(
              state.compilerVersion,
              artifact.definition,
            );
          } catch {
            throw new IdentityError(409, "process_conflict");
          }
          if (start) {
            const parsed = native
              .processValueSchema(artifact.definition.inputSchema)
              .safeParse(start.input);
            if (
              !parsed.success ||
              state.inputDigest !== processDigest(parsed.data)
            )
              throw new IdentityError(409, "process_conflict");
          }
        } else {
          if (!start) throw new IdentityError(404, "process_not_found");
          const parsed = native
            .processValueSchema(artifact.definition.inputSchema)
            .safeParse(start.input);
          if (
            !parsed.success ||
            Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 65536
          )
            throw new IdentityError(400, "process_input_invalid");
          state = newServiceProcessJournal(
            artifact,
            runId,
            scope,
            organizationId,
            parsed.data as Record<string, unknown>,
            Date.now(),
          );
          controller.store.saveTurn(id, scope.workspaceId, scope.userId, state);
        }
      });
      // Assignment occurs under the awaited identity queue above.
      const journal = state!;
      const version = artifact!;
      const hasModels =
        version.definition.kind === "agent" ||
        version.definition.steps.some((s) => s.type === "agent");
      const caps = {
        maxTokens: version.definition.limits.maxTokens,
        maxCostMicros: version.definition.limits.maxCostMicros,
        maxModelCalls: version.definition.limits.maxModelCalls,
      };
      const budgetReady = () =>
        controller.store.inferenceBudget.assertReady(
          id,
          { ...target, userId: scope.userId },
          journal.inference,
          caps,
        );
      const save = () => {
        if (journal.revision >= Number.MAX_SAFE_INTEGER)
          throw new IdentityError(409, "process_revision_exhausted");
        const previous = journal.revision;
        journal.revision++;
        try {
          controller.store.saveTurn(
            id,
            scope.workspaceId,
            scope.userId,
            JournalSchema.parse(journal),
          );
        } catch (error) {
          journal.revision = previous;
          throw error;
        }
      };
      const authorizeHeld = async () => {
        const current = await actor();
        if (registry.resolveRun(current, id).digest !== version.digest)
          throw new IdentityError(409, "process_conflict");
        for (const agent of Object.values(journal.agents)) {
          if (agent.memoryVersion === undefined) continue;
          if (!options.memory)
            throw new IdentityError(409, "process_memory_unavailable");
          await options.memory.validate(
            agent.memoryVersion,
            agent.memoryMetadata,
          );
        }
        for (const source of journal.sources)
          controller.store.contactSource(
            source,
            organizationId,
            scope.workspaceId,
            current,
            CONTACT_CONTEXT_TTL,
          );
        for (const operationId of journal.operations) {
          const receipt = controller.store.invocation(
            operationId,
            scope.workspaceId,
            scope.userId,
          );
          if (receipt?.status !== "succeeded" || receipt.effect !== "write")
            continue;
          const permitted = controller.store.authorize(
            scope.workspaceId,
            receipt.serviceId,
            receipt.serviceRevision,
            receipt.actionId,
            receipt.actionRevision,
            current,
          );
          controller.store.assertExecutionPin(receipt, permitted.executionPin);
        }
      };
      const authorize = () => context.serial(authorizeHeld);
      await authorize();
      const questionContext = {
        questions: options.questions,
        scope,
        rootId: id,
        artifactDigest: journal.artifactDigest,
        inputDigest: journal.inputDigest,
        compilerVersion: journal.compilerVersion,
      };
      const proveConsumedQuestion = async (
        runtime: Awaited<ReturnType<typeof nativeCatalogOwner>>,
        child: Journal["agents"][string],
        answer: NonNullable<Journal["agents"][string]["answers"]>[number],
      ) => {
        const bound = await context.serial(async () => {
          await authorizeHeld();
          const binding = processQuestionAnswer(
            questionContext,
            answer.question,
            answer.answerId,
          );
          if (!options.questions!.consumed(answer.answerId, answer.question))
            throw new IdentityError(409, "process_question_conflict");
          return binding;
        });
        const binding = {
          runId: child.runId,
          threadId: child.threadId,
          resourceId: scopeDigest,
          toolCallId: answer.question.toolCallId,
          question: answer.question,
        };
        return (
          (await runtime.proveSuspended(binding)) ||
          (await runtime.proveQuestionRecovery({
            ...binding,
            resumeData: {
              answerId: answer.answerId,
              answer: bound.command.answer,
              questionId: answer.question.questionId,
              questionRevision: answer.question.questionRevision,
            },
          }))
        );
      };
      const consumedResume =
        isQuestionResume(resume) &&
        (await context.serial(async () => {
          await authorizeHeld();
          const history = journal.agents[resume.nodeId]?.answers?.find(
            (item) => item.answerId === resume.answerId,
          );
          if (
            !history ||
            history.question.questionId !== resume.questionId ||
            history.question.questionRevision !== resume.questionRevision
          )
            return false;
          processQuestionAnswer(
            questionContext,
            history.question,
            resume.answerId,
          );
          return options.questions!.consumed(resume.answerId, history.question);
        }));
      if (
        resume &&
        !consumedResume &&
        (!journal.pending ||
          resume.nodeId !== journal.pending.nodeId ||
          (isQuestionResume(resume)
            ? !("kind" in journal.pending) ||
              resume.questionId !== journal.pending.questionId ||
              resume.questionRevision !== journal.pending.questionRevision
            : "kind" in journal.pending ||
              resume.operationId !== journal.pending.operationId) ||
          journal.status !== "waiting")
      )
        throw new IdentityError(
          409,
          isQuestionResume(resume)
            ? "process_question_conflict"
            : "process_approval_conflict",
        );
      if (
        consumedResume &&
        journal.status !== "running" &&
        isQuestionResume(resume)
      ) {
        // A retry may expose a later boundary only after exact private native proof.
        const child = journal.agents[resume.nodeId];
        if (
          !child ||
          child.runId !== processDigest([id, "agent", resume.nodeId]) ||
          child.threadId !==
            processDigest([id, scopeDigest, "agent-thread", resume.nodeId])
        )
          throw new IdentityError(409, "process_question_conflict");
        const owner = await nativeCatalogOwner(controller);
        const binding = {
          runId: child.runId,
          threadId: child.threadId,
          resourceId: scopeDigest,
        };
        let proved = false;
        if (child.output)
          proved =
            (await owner.proveRetired(binding)) && owner.isSettled(child.runId);
        else if (child.pending) {
          const pending = child.pending;
          proved = await owner.proveSuspended({
            ...binding,
            toolCallId: pending.toolCallId,
            ...(pending.kind === "question"
              ? { question: pending.questionProof }
              : {}),
          });
          if (pending.kind === "question") {
            const q = pending.questionProof;
            proved &&=
              !!options.questions &&
              q.questionDigest === processDigest(q.question) &&
              processDigest(
                options.questions.question(q.questionId) ?? null,
              ) === processDigest(q);
          } else {
            const receipt = controller.store.invocation(
              pending.operationId,
              scope.workspaceId,
              scope.userId,
            );
            proved &&=
              receipt?.status === "awaiting_approval" &&
              receipt.organizationId === organizationId &&
              receipt.workspaceId === scope.workspaceId &&
              receipt.userId === scope.userId &&
              pending.operationId ===
                processDigest([id, "action", pending.toolCallId]) &&
              journal.receipts.some(
                (r) =>
                  r.callId === pending.toolCallId &&
                  r.operationId === pending.operationId,
              );
          }
        }
        await authorize();
        if (!proved)
          throw new IdentityError(409, "process_checkpoint_interrupted");
        return result(journal);
      }
      if (!resume && journal.status === "unknown") return result(journal);
      // A crash after dispatch must stay passive even if the parent native
      // checkpoint has not yet committed its suspension/failure.
      const uncertain = await context.serial(async () => {
        await authorizeHeld();
        return journal.operations
          .map((operationId) =>
            controller.store.invocation(
              operationId,
              scope.workspaceId,
              scope.userId,
            ),
          )
          .find(
            (receipt) =>
              receipt?.status === "unknown" || receipt?.status === "running",
          );
      });
      if (uncertain) {
        await context.serial(async () => {
          journal.status = "unknown";
          journal.failure = {
            code: "process_action_unknown",
            operationId: uncertain.id,
          };
          delete journal.pending;
          finishLoopTrace(journal, "unknown");
          save();
        });
        return result(journal);
      }
      if (!resume && journal.status !== "running") return result(journal);
      const remaining =
        version.definition.limits.maxDurationMs -
        (Date.now() - journal.startedAt);
      const executionSignal =
        remaining > 0
          ? AbortSignal.any([signal, AbortSignal.timeout(remaining)])
          : AbortSignal.abort();
      let currentNode: string | undefined;
      let domainFailure: ProcessFailure | undefined;
      const charge = (key: string) => {
        if (journal.visited.includes(key)) return;
        if (journal.visited.length >= version.definition.limits.maxSteps)
          throw new IdentityError(429, "process_step_limit");
        journal.visited.push(key);
      };
      const boundary: NativeWorkflowInput["boundary"] = {
        reconcile: async (checkpoint, workflowId) => {
          const runtime = await nativeCatalogOwner(controller);
          // A saved parent can lag behind its child. Prove all recorded child
          // boundaries before attaching the parent, even at an earlier control step.
          for (const [nodeId, child] of Object.entries(journal.agents)) {
            if (
              child.runId !== processDigest([id, "agent", nodeId]) ||
              child.threadId !==
                processDigest([id, scopeDigest, "agent-thread", nodeId])
            )
              return false;
            const binding = {
              runId: child.runId,
              threadId: child.threadId,
              resourceId: scopeDigest,
            };
            if (child.output) {
              if (
                !(await runtime.proveRetired(binding)) ||
                !runtime.isSettled(child.runId)
              )
                return false;
            } else if (child.pending) {
              if (
                !(await runtime.proveSuspended({
                  ...binding,
                  toolCallId: child.pending.toolCallId,
                  ...(child.pending.kind === "question"
                    ? { question: child.pending.questionProof }
                    : {}),
                }))
              )
                return false;
              if (child.pending.kind === "question") {
                const q = child.pending.questionProof;
                if (
                  !options.questions ||
                  q.parentRunId !== id ||
                  q.nodeId !== nodeId ||
                  q.questionDigest !== processDigest(q.question) ||
                  processDigest(
                    options.questions.question(q.questionId) ?? null,
                  ) !== processDigest(q)
                )
                  return false;
              }
            } else {
              let proved = false;
              for (const answer of child.answers ?? []) {
                try {
                  if (await proveConsumedQuestion(runtime, child, answer)) {
                    proved = true;
                    break;
                  }
                } catch (error) {
                  if (
                    !(error instanceof IdentityError) ||
                    error.code !== "process_question_conflict"
                  )
                    throw error;
                }
              }
              if (!proved) return false;
            }
          }
          if (Object.keys(journal.agents).length) {
            try {
              await context.serial(async () => {
                await authorizeHeld();
                if (
                  !resume ||
                  isQuestionResume(resume) ||
                  resume.approved !== false
                )
                  budgetReady();
              });
            } catch (error) {
              if (
                !(error instanceof IdentityError) ||
                !error.code.startsWith("catalog_budget_")
              )
                throw error;
              domainFailure = new ProcessFailure({ code: error.code });
              return false;
            }
          }
          return native.proveProcessWorkflowCheckpoint({
            checkpoint,
            workflowId,
            definition: version.definition,
            compilerVersion: journal.compilerVersion,
            proveNode: async (node, bound, decision) => {
              await authorize();
              if (node.type === "agent") {
                const child = journal.agents[node.id];
                if (
                  !child ||
                  child.inputDigest !== processDigest(bound) ||
                  child.runId !== processDigest([id, "agent", node.id]) ||
                  child.threadId !==
                    processDigest([id, scopeDigest, "agent-thread", node.id])
                )
                  return undefined;
                const binding = {
                  runId: child.runId,
                  threadId: child.threadId,
                  resourceId: scopeDigest,
                };
                const originalDecision = await context.serial(async () => {
                  await authorizeHeld();
                  if (!decision) return true;
                  if (isQuestionResume(decision)) {
                    const answer = child.answers?.find(
                      (item) => item.answerId === decision.answerId,
                    );
                    if (
                      !answer ||
                      answer.question.questionId !== decision.questionId ||
                      answer.question.questionRevision !==
                        decision.questionRevision ||
                      decision.nodeId !== node.id
                    )
                      return false;
                    try {
                      processQuestionAnswer(
                        questionContext,
                        answer.question,
                        decision.answerId,
                      );
                      return options.questions!.consumed(
                        decision.answerId,
                        answer.question,
                      );
                    } catch (error) {
                      if (
                        !(error instanceof IdentityError) ||
                        error.code !== "process_question_conflict"
                      )
                        throw error;
                      return false;
                    }
                  }
                  const operation = controller.store.invocation(
                    decision.operationId,
                    scope.workspaceId,
                    scope.userId,
                  );
                  return (
                    decision.approved &&
                    decision.nodeId === node.id &&
                    operation?.status === "succeeded" &&
                    operation.effect === "write" &&
                    operation.organizationId === organizationId &&
                    operation.workspaceId === scope.workspaceId &&
                    operation.userId === scope.userId &&
                    node.capabilities.some(
                      (capability) =>
                        capability.serviceId === operation.serviceId &&
                        capability.actionId === operation.actionId,
                    ) &&
                    child.decisions.some(
                      (item) =>
                        item.operationId === decision.operationId &&
                        item.approved === decision.approved &&
                        item.operationId ===
                          processDigest([id, "action", item.toolCallId]) &&
                        journal.receipts.some(
                          (receipt) =>
                            receipt.operationId === item.operationId &&
                            receipt.callId === item.toolCallId,
                        ),
                    )
                  );
                });
                if (!originalDecision) return undefined;
                if (child.output) {
                  const retired = await runtime.proveRetired(binding);
                  await context.serial(async () => {
                    await authorizeHeld();
                    if (
                      retired &&
                      runtime.isSettled(child.runId) &&
                      (!resume ||
                        isQuestionResume(resume) ||
                        resume.approved !== false)
                    )
                      budgetReady();
                  });
                  return retired && runtime.isSettled(child.runId)
                    ? { status: "complete", output: child.output }
                    : undefined;
                }
                if (!child.pending) {
                  for (const answer of child.answers ?? []) {
                    let proved = false;
                    try {
                      proved = await proveConsumedQuestion(
                        runtime,
                        child,
                        answer,
                      );
                    } catch (error) {
                      if (
                        !(error instanceof IdentityError) ||
                        error.code !== "process_question_conflict"
                      )
                        throw error;
                    }
                    if (proved)
                      return { status: "waiting", question: answer.question };
                  }
                  return undefined;
                }
                const pending = child.pending;
                const suspended = await runtime.proveSuspended({
                  ...binding,
                  toolCallId: pending.toolCallId,
                  ...(pending.kind === "question"
                    ? { question: pending.questionProof }
                    : {}),
                });
                if (pending.kind === "question")
                  return context.serial(async () => {
                    await authorizeHeld();
                    const q = pending.questionProof;
                    return suspended &&
                      node.humanInput === "text" &&
                      journal.compilerVersion === "niaro-native-workflow/3" &&
                      q.parentRunId === id &&
                      q.nodeId === node.id &&
                      q.childRunId === child.runId &&
                      q.childThreadId === child.threadId &&
                      q.resourceId === scopeDigest &&
                      q.toolCallId === pending.toolCallId &&
                      q.question === pending.question &&
                      q.questionDigest === processDigest(q.question) &&
                      q.artifactDigest === journal.artifactDigest &&
                      q.inputDigest === journal.inputDigest &&
                      q.issuedWorkRevision <= journal.revision &&
                      q.questionId ===
                        processDigest([
                          id,
                          "question",
                          node.id,
                          child.runId,
                          q.toolCallId,
                        ]) &&
                      options.questions &&
                      processDigest(
                        options.questions.question(q.questionId) ?? null,
                      ) === processDigest(q)
                      ? { status: "waiting", question: q }
                      : undefined;
                  });
                return context.serial(async () => {
                  await authorizeHeld();
                  const receipt = controller.store.invocation(
                    pending.operationId,
                    scope.workspaceId,
                    scope.userId,
                  );
                  if (receipt?.status === "awaiting_approval") {
                    const current = await actor();
                    const permitted = controller.store.authorize(
                      scope.workspaceId,
                      receipt.serviceId,
                      receipt.serviceRevision,
                      receipt.actionId,
                      receipt.actionRevision,
                      current,
                    );
                    controller.store.assertExecutionPin(
                      receipt,
                      permitted.executionPin,
                    );
                    for (const source of receipt.dependencies ?? [])
                      controller.store.contactSource(
                        source,
                        organizationId,
                        scope.workspaceId,
                        current,
                        CONTACT_CONTEXT_TTL,
                      );
                  }
                  return suspended &&
                    pending.operationId ===
                      processDigest([id, "action", pending.toolCallId]) &&
                    journal.receipts.some(
                      (item) =>
                        item.callId === pending.toolCallId &&
                        item.operationId === pending.operationId,
                    ) &&
                    receipt?.status === "awaiting_approval" &&
                    journal.operations.includes(pending.operationId) &&
                    receipt.id === pending.operationId &&
                    receipt.workspaceId === scope.workspaceId &&
                    receipt.userId === scope.userId &&
                    receipt.policyRevision === context.epoch(organizationId) &&
                    receipt.organizationId === organizationId &&
                    node.capabilities.some(
                      (capability) =>
                        capability.serviceId === receipt.serviceId &&
                        capability.actionId === receipt.actionId,
                    )
                    ? {
                        status: "waiting",
                        approval: {
                          nodeId: node.id,
                          operationId: pending.operationId,
                        },
                      }
                    : undefined;
                });
              }
              if (isQuestionResume(decision)) return undefined;
              return context.serial(async () => {
                const current = await actor();
                await authorizeHeld();
                const operationId = processDigest([id, "action", node.id]);
                const receipt = controller.store.invocation(
                  operationId,
                  scope.workspaceId,
                  scope.userId,
                );
                if (
                  !receipt ||
                  !journal.operations.includes(operationId) ||
                  !journal.receipts.some(
                    (item) =>
                      item.callId === node.id &&
                      item.operationId === operationId,
                  ) ||
                  receipt.id !== operationId ||
                  receipt.organizationId !== organizationId ||
                  receipt.workspaceId !== scope.workspaceId ||
                  receipt.userId !== scope.userId ||
                  receipt.serviceId !== node.serviceId ||
                  receipt.actionId !== node.actionId ||
                  !native.sameProcessCheckpointValue(receipt.input, bound) ||
                  (decision &&
                    (decision.nodeId !== node.id ||
                      decision.operationId !== operationId ||
                      !decision.approved))
                )
                  return undefined;
                const authorized = controller.store.authorize(
                  scope.workspaceId,
                  receipt.serviceId,
                  receipt.serviceRevision,
                  receipt.actionId,
                  receipt.actionRevision,
                  current,
                );
                controller.store.assertExecutionPin(
                  receipt,
                  authorized.executionPin,
                );
                for (const dependency of receipt.dependencies ?? [])
                  controller.store.contactSource(
                    dependency,
                    organizationId,
                    scope.workspaceId,
                    current,
                    CONTACT_CONTEXT_TTL,
                  );
                if (receipt.status === "succeeded") {
                  if (receipt.effect === "read")
                    controller.store.contactSource(
                      operationId,
                      organizationId,
                      scope.workspaceId,
                      current,
                      CONTACT_CONTEXT_TTL,
                    );
                  return { status: "complete", output: receipt.result };
                }
                if (
                  receipt.status === "awaiting_approval" &&
                  !decision &&
                  receipt.policyRevision === context.epoch(organizationId)
                )
                  return {
                    status: "waiting",
                    approval: { nodeId: node.id, operationId },
                  };
                if (
                  receipt.status === "failed" ||
                  receipt.status === "rejected"
                )
                  domainFailure = new ProcessFailure(
                    {
                      code:
                        receipt.failure?.code ??
                        `process_action_${receipt.status}`,
                      nodeId: node.id,
                      operationId,
                    },
                    receipt.status === "rejected" ? "cancelled" : "failed",
                  );
                return undefined;
              });
            },
          });
        },
        authorize: async () => {
          await authorize();
          if (executionSignal.aborted)
            throw new ProcessFailure({ code: "process_duration_exceeded" });
        },
        enter: (node) =>
          context.serial(async () => {
            await authorizeHeld();
            currentNode = node.id;
            charge(node.id);
            journal.status = "running";
            journal.trace.status = "running";
            journal.trace.finishedAt = null;
            startLoopStep(
              journal,
              node.type === "action" ? "tool" : "decision",
              node.id,
              [
                { label: "Process version", value: String(journal.version) },
                { label: "Step", value: node.type },
              ],
              node.id,
            );
            save();
          }),
        leave: (node, outcome) =>
          context.serial(async () => {
            const step = journal.trace.steps.findLast(
              (s) => s.callId === node.id && s.status === "running",
            );
            finishLoopStep(step, outcome);
            save();
          }),
        action: async (
          node,
          input,
          decision,
          actionSignal,
          callId = node.id,
        ) => {
          const operationId = processDigest([id, "action", callId]);
          const validateActionOrigin = () => {
            try {
              validateOrigin?.();
            } catch (error) {
              domainFailure = new ProcessFailure({
                code:
                  error instanceof IdentityError
                    ? error.code
                    : "process_origin_changed",
                nodeId: node.id,
                operationId,
              });
              throw error;
            }
          };
          const request = await context.serial(async () => {
            await authorizeHeld();
            // A workflow can sit waiting while its source task is resolved.
            // Recheck under the identity queue before even preparing the next action.
            validateActionOrigin();
            if (
              decision &&
              (decision.nodeId !== node.id ||
                decision.operationId !== operationId)
            )
              throw new IdentityError(409, "process_approval_conflict");
            const service = controller.store.service(
              scope.workspaceId,
              node.serviceId,
            );
            const action = service.actions.find((a) => a.id === node.actionId)!;
            if (!journal.operations.includes(operationId)) {
              if (journal.operations.length >= 64)
                throw new IdentityError(429, "process_step_limit");
              if (hasModels) budgetReady();
              journal.operations.push(operationId);
              journal.receipts.push({ callId, operationId });
            }
            save();
            controller.store.linkTurnOperation(
              id,
              operationId,
              scope.workspaceId,
              scope.userId,
            );
            const linked = controller.store.turnForOperation(
              operationId,
              scope.workspaceId,
              scope.userId,
            );
            if (linked?.id !== id)
              throw new IdentityError(409, "process_conflict");
            return {
              ...target,
              requestId: operationId,
              serviceId: node.serviceId,
              serviceRevision: service.revision,
              actionId: node.actionId,
              revision: action.revision,
              input,
              approve: decision?.approved ?? false,
            };
          });
          const recorded = await context.serial(async () => {
            await authorizeHeld();
            const old = controller.store.invocation(
              operationId,
              scope.workspaceId,
              scope.userId,
            );
            if (!old) return undefined;
            if (
              old.organizationId !== organizationId ||
              old.workspaceId !== scope.workspaceId ||
              old.userId !== scope.userId ||
              old.serviceId !== request.serviceId ||
              old.actionId !== request.actionId ||
              old.serviceRevision !== request.serviceRevision ||
              old.actionRevision !== request.revision ||
              !native.sameProcessCheckpointValue(old.input, input)
            )
              throw new IdentityError(409, "process_conflict");
            const permitted = controller.store.authorize(
              scope.workspaceId,
              old.serviceId,
              old.serviceRevision,
              old.actionId,
              old.actionRevision,
              await actor(),
            );
            controller.store.assertExecutionPin(old, permitted.executionPin);
            for (const source of old.dependencies ?? [])
              controller.store.contactSource(
                source,
                organizationId,
                scope.workspaceId,
                await actor(),
                CONTACT_CONTEXT_TTL,
              );
            if (old.effect === "read" && old.status === "succeeded")
              controller.store.contactSource(
                operationId,
                organizationId,
                scope.workspaceId,
                await actor(),
                CONTACT_CONTEXT_TTL,
              );
            return old;
          });
          let receipt;
          if (
            recorded &&
            (recorded.status !== "awaiting_approval" || !decision)
          ) {
            // A proved canonical result never needs OAuth refresh or transport.
            receipt = recorded;
          } else if (decision?.approved === false) {
            receipt = await context.serial(async () => {
              await authorizeHeld();
              const old = controller.store.invocation(
                operationId,
                scope.workspaceId,
                scope.userId,
              );
              if (!old || old.status !== "awaiting_approval")
                throw new IdentityError(409, "process_approval_conflict");
              old.status = "rejected";
              old.completedAt = Date.now();
              controller.store.saveInvocation(old);
              return old;
            });
          } else {
            // Fresh process/source checks also run inside the transport's dispatch guard.
            const guardedContext: CatalogContext = {
              ...context,
              validateRequest: () => {
                context.validateRequest?.();
                actionSignal.throwIfAborted();
                // CatalogController calls this under the same queue immediately
                // before opening the provider transport.
                validateActionOrigin();
                const current = controller.store.invocation(
                  operationId,
                  scope.workspaceId,
                  scope.userId,
                );
                if (
                  hasModels &&
                  (!current ||
                    current.status === "running" ||
                    current.status === "awaiting_approval")
                )
                  budgetReady();
              },
              actor: async (requested) => {
                await authorizeHeld();
                return context.actor(requested);
              },
            };
            receipt = await controller.invoke(
              request,
              guardedContext,
              actionSignal,
              options.source ?? "console",
              undefined,
              recorded?.dependencies ?? [...journal.sources],
            );
          }
          await context.serial(async () => {
            if (receipt.status === "awaiting_approval")
              journal.pending = { nodeId: node.id, operationId };
            else delete journal.pending;
            // A definitive tool outcome closes this child approval even when the
            // parent throws before the child's usual post-tool save/finalization.
            const child = journal.agents[node.id];
            if (
              receipt.status !== "awaiting_approval" &&
              child?.pending?.kind === "approval" &&
              child.pending.operationId === operationId &&
              child.pending.toolCallId === callId
            )
              delete child.pending;
            if (
              receipt.status === "succeeded" &&
              receipt.effect === "read" &&
              !journal.sources.includes(operationId)
            )
              journal.sources.push(operationId);
            const step = journal.trace.steps.findLast(
              (s) => s.callId === callId && s.status === "running",
            );
            if (step)
              step.details.push({ label: "Operation", value: operationId });
            save();
          });
          if (receipt.status === "awaiting_approval")
            return {
              status: "waiting",
              approval: { nodeId: node.id, operationId },
            };
          if (receipt.status !== "succeeded") {
            domainFailure = new ProcessFailure(
              {
                code:
                  receipt.failure?.code ?? `process_action_${receipt.status}`,
                nodeId: node.id,
                operationId,
              },
              receipt.status === "unknown" || receipt.status === "running"
                ? "unknown"
                : receipt.status === "rejected"
                  ? "cancelled"
                  : "failed",
            );
            throw domainFailure;
          }
          return { status: "complete", output: receipt.result };
        },
      };
      const eventSteps = new Map<string, ReturnType<typeof startLoopStep>>();
      const agent = createProcessAgentBoundary({
        controller,
        context,
        target: { ...target, userId: scope.userId },
        rootId: id,
        resourceId: scopeDigest,
        caps,
        states: journal.agents,
        scope,
        parent: journal,
        questions: options.questions,
        memory: options.memory,
        authorizeHeld,
        save,
        charge,
        inferenceCount: () => journal.inference,
        dispatched: () => {
          journal.inference++;
        },
        action: boundary.action,
        onEvent: (event) =>
          context.serial(async () => {
            if (event.type === "model-start")
              eventSteps.set(
                "model",
                startLoopStep(
                  journal,
                  "model",
                  `Model ${journal.inference + 1}`,
                  [
                    { label: "Step", value: currentNode ?? "agent" },
                    ...(event.model
                      ? [{ label: "Model", value: loopText(event.model, 160) }]
                      : []),
                  ],
                ),
              );
            else if (event.type === "model-end")
              finishLoopStep(eventSteps.get("model"), "succeeded");
            else if (event.type === "tool-start") {
              const step = startLoopStep(
                journal,
                "tool",
                event.name,
                [],
                event.toolCallId,
              );
              if (step)
                step.tool = startLoopToolDetails(event.name, event.args);
              eventSteps.set(event.toolCallId, step);
            } else if (event.type === "tool-end") {
              const step = eventSteps.get(event.toolCallId);
              const operationId =
                !event.invalidArguments && !event.unavailable
                  ? journal.receipts.find(
                      (receipt) => receipt.callId === event.toolCallId,
                    )?.operationId
                  : undefined;
              const candidate =
                operationId && journal.operations.includes(operationId)
                  ? controller.store.invocation(
                      operationId,
                      scope.workspaceId,
                      scope.userId,
                    )
                  : undefined;
              const receipt =
                candidate &&
                candidate.organizationId === organizationId &&
                candidate.workspaceId === scope.workspaceId &&
                candidate.userId === scope.userId &&
                candidate.id === operationId
                  ? candidate
                  : undefined;
              const status =
                event.invalidArguments || event.unavailable
                  ? "failed"
                  : receipt
                    ? toolOutcome(receipt)
                    : event.error
                      ? executionSignal.aborted
                        ? "cancelled"
                        : "failed"
                      : journal.pending
                        ? "waiting"
                        : toolOutcome(event.output);
              if (step && receipt) step.label = receipt.title;
              if (step?.tool)
                step.tool = finishLoopToolDetails(step.tool, {
                  output: event.output,
                  error: event.error,
                  invalidArguments: event.invalidArguments,
                  unavailable: event.unavailable,
                  status,
                });
              finishLoopStep(step, status);
            }
            save();
          }),
      });
      boundary.agent = async (...args) => {
        try {
          return await agent(...args);
        } catch (error) {
          domainFailure ??= new ProcessFailure(
            {
              code: executionSignal.aborted
                ? signal.aborted
                  ? "process_cancelled"
                  : "process_duration_exceeded"
                : error instanceof IdentityError
                  ? error.code
                  : "process_agent_failed",
              nodeId: args[0].id,
            },
            executionSignal.aborted && signal.aborted ? "cancelled" : "failed",
          );
          throw error;
        }
      };
      try {
        executionSignal.throwIfAborted();
        const runtime = await nativeCatalogOwner(controller);
        const completed = await runtime.executeWorkflow({
          runId: id,
          resourceId: scopeDigest,
          artifactDigest: version.digest,
          compilerVersion: journal.compilerVersion,
          definition: version.definition,
          input: journal.input,
          recordedProgress: Boolean(
            journal.visited.length ||
              journal.operations.length ||
              journal.inference ||
              Object.keys(journal.agents).length,
          ),
          ...(resume && !consumedResume ? { resume } : {}),
          signal: executionSignal,
          boundary,
        });
        await context.serial(async () => {
          await authorizeHeld();
          journal.status = completed.status;
          if (completed.status === "succeeded") {
            journal.output = completed.output;
            delete journal.pending;
          } else if (completed.status === "waiting")
            journal.pending =
              "question" in completed ? completed.question : completed.approval;
          else {
            journal.status = domainFailure?.outcome ?? "failed";
            journal.failure = domainFailure?.failure ?? {
              code: executionSignal.aborted
                ? signal.aborted
                  ? "process_cancelled"
                  : "process_duration_exceeded"
                : completed.code,
              ...(currentNode ? { nodeId: currentNode } : {}),
            };
            delete journal.pending;
          }
          finishLoopTrace(journal, journal.status);
          save();
        });
        return result(journal);
      } catch (error) {
        await context.serial(async () => {
          journal.status = domainFailure?.outcome ?? "failed";
          journal.failure = domainFailure?.failure ?? {
            code: executionSignal.aborted
              ? signal.aborted
                ? "process_cancelled"
                : "process_duration_exceeded"
              : error instanceof IdentityError
                ? error.code
                : "process_execution_failed",
            ...(currentNode ? { nodeId: currentNode } : {}),
          };
          delete journal.pending;
          finishLoopTrace(journal, journal.status);
          save();
        });
        throw error;
      }
    });
  }
  return {
    start: (
      processId: string,
      runId: string,
      input: unknown,
      signal: AbortSignal,
      validateOrigin?: () => void,
    ) =>
      execute(runId, signal, { processId, input }, undefined, validateOrigin),
    resume: (
      runId: string,
      decision: NonNullable<NativeWorkflowInput["resume"]>,
      signal: AbortSignal,
      validateOrigin?: () => void,
    ) =>
      execute(
        runId,
        signal,
        undefined,
        ProcessAnyResumeSchema.parse(decision),
        validateOrigin,
      ),
  };
}
