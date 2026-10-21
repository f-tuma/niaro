import type { Scope } from "../../packages/protocol";
import {
  ProcessRuntimeCommandSchema,
  ProcessRuntimeResponseSchema,
  ProcessRuntimeStateSchema,
  type ProcessRuntimeCommand,
  type ProcessRuntimeResponse,
  type ProcessRuntimeProfile,
  type ProcessResolveCommand,
} from "../../packages/protocol/process-coordinator";
import { PROCESS_EXECUTION_PROFILE } from "../../packages/protocol/process-execution";
import { PROCESS_QUESTION_EXECUTION_PROFILE } from "../../packages/protocol/process-questions";
import {
  ProcessStartInputSchema,
  type ProcessStartAdmission,
  type ProcessStartIntent,
  type ProcessStartOriginalCommand,
  type ProcessStartOrigin,
  type ProcessStartReceipt,
} from "../../packages/protocol/process-start";
import type { CatalogController, CatalogContext } from "./catalog-controller";
import type { ServiceProcessStore, ProcessActor } from "./service-processes";
import type { AgentMemory } from "./agent-memory";
import { createServiceProcessRuntime } from "./service-process-runtime";
import { JournalSchema } from "./service-process-journal";
import {
  nativeCatalogOwner,
  REQUEST_INTERRUPTION_REASON,
} from "./mastra-runtime";
import { ProcessStartStore } from "./process-start-store";
import { ProcessResolveStore } from "./process-resolve-store";
import { ProcessQuestionStore } from "./process-question-store";
import {
  MAX_ACTIVE_RUNS,
  NativeCommandRequests,
  personLane,
  type NativeTrackedRequest,
} from "./native-command-requests";
import { IdentityError } from "./error";
import { finishLoopTrace } from "./loop-trace";
import { processDigest } from "./process-validation";
import { projectProcessApproval } from "./process-approval";
import { CONTACT_CONTEXT_TTL } from "./contact-context";

type Request = NativeTrackedRequest & {
  profile: "process";
  command: ProcessRuntimeCommand;
  promise: Promise<ProcessRuntimeResponse>;
  parentRunId?: string;
};
/** Request-scoped adapter over the shared native owner. It is not a workflow executor. */
export function createProcessCoordinator(
  controller: CatalogController,
  registry: ServiceProcessStore,
  starts: ProcessStartStore,
  resolves: ProcessResolveStore,
  context: CatalogContext,
  scope: Scope,
  organizationId: string,
  tracker: NativeCommandRequests,
  options: {
    memory?: AgentMemory;
    /** Synchronous current Memory generation, observed under the identity queue. */
    memoryObservation?: () => unknown;
    questions?: ProcessQuestionStore;
    executionProfile?: ProcessRuntimeProfile;
    /** Current scoped meeting record check, required for meeting-origin launches. */
    validateMeetingOrigin?: (
      origin: ProcessStartOrigin,
      inputSchema?: ProcessStartIntent["inputSchema"],
    ) => void;
  } = {},
) {
  const profile = options.executionProfile ?? PROCESS_EXECUTION_PROFILE;
  const acceptCompiler = (compiler: string) => {
    if (
      compiler === "niaro-native-workflow/3" &&
      profile !== PROCESS_QUESTION_EXECUTION_PROFILE
    )
      throw new IdentityError(406, "process_profile_unsupported");
  };
  const acceptAdmission = (receipt: ProcessStartReceipt) => {
    if (receipt.status !== "admitted")
      throw new IdentityError(409, "process_start_conflict");
    acceptCompiler(receipt.compilerVersion);
  };
  const validateMeetingAdmission = (admission: ProcessStartAdmission) => {
    if (admission.origin.type !== "meeting") return;
    if (!options.validateMeetingOrigin)
      throw new IdentityError(409, "process_origin_changed");
    options.validateMeetingOrigin(admission.origin);
  };
  const meetingOriginGuard = (admission: ProcessStartAdmission) =>
    admission.origin.type === "meeting"
      ? () => validateMeetingAdmission(admission)
      : undefined;
  const target = { organizationId, workspaceId: scope.workspaceId };
  const runtime = createServiceProcessRuntime(
    controller,
    registry,
    context,
    scope,
    organizationId,
    { ...options, source: "chat" },
  );
  const actor = async (): Promise<ProcessActor> => {
    context.validateRequest?.();
    const current = await context.actor(target);
    if (current.userId !== scope.userId)
      throw new IdentityError(403, "identity_forbidden");
    return { ...target, ...current };
  };
  const held = async (parentRunId: string) => {
    const current = await actor();
    const original = starts.forParent(current, scope, parentRunId);
    const admission = original.receipt;
    if (admission.status !== "admitted")
      throw new IdentityError(409, "process_start_conflict");
    const journal = JournalSchema.parse(
      controller.store.turn(parentRunId, scope.workspaceId, scope.userId),
    );
    return { actor: current, admission, journal, command: original.command };
  };
  const approvalHeld = async (command: ProcessResolveCommand) => {
    const saved = await held(command.workItemId);
    acceptAdmission(saved.admission);
    const { journal, actor: current } = saved;
    if (
      journal.status !== "waiting" ||
      journal.revision !== command.expectedWorkRevision ||
      !journal.pending ||
      "kind" in journal.pending ||
      journal.pending.operationId !== command.operationId
    )
      throw new IdentityError(409, "process_approval_conflict");
    const artifact = registry.resolveRun(current, command.workItemId);
    const receipts = journal.operations.map((id) => {
      const receipt = controller.store.invocation(
        id,
        scope.workspaceId,
        scope.userId,
      );
      if (!receipt || receipt.organizationId !== organizationId)
        throw new IdentityError(409, "process_receipt_missing");
      const permitted = controller.store.authorize(
        scope.workspaceId,
        receipt.serviceId,
        receipt.serviceRevision,
        receipt.actionId,
        receipt.actionRevision,
        current,
      );
      controller.store.assertExecutionPin(receipt, permitted.executionPin);
      return receipt;
    });
    const sources = [
      ...new Set([
        ...journal.sources,
        ...receipts.flatMap((receipt) => [
          ...(receipt.dependencies ?? []),
          ...(receipt.contactSource ? [receipt.contactSource] : []),
        ]),
      ]),
    ].map((id) =>
      controller.store.contactSource(
        id,
        organizationId,
        scope.workspaceId,
        current,
        CONTACT_CONTEXT_TTL,
      ),
    );
    const review = projectProcessApproval(
      controller,
      scope,
      organizationId,
      command.workItemId,
      journal,
      artifact,
      receipts,
      saved.command.language,
      context.epoch(organizationId),
    );
    if (!review.approval)
      throw new IdentityError(409, "process_approval_conflict");
    return {
      journal,
      signature: processDigest([
        saved.admission,
        journal,
        receipts,
        sources,
        context.epoch(organizationId),
        options.memoryObservation?.(),
      ]),
    };
  };
  const response = (
    value: Awaited<ReturnType<typeof held>>,
    commandId = value.admission.commandId,
  ): ProcessRuntimeResponse => {
    const j = value.journal;
    const output =
      j.output === undefined
        ? undefined
        : ProcessStartInputSchema.safeParse(j.output);
    return ProcessRuntimeResponseSchema.parse({
      profile,
      scope,
      commandId,
      admission: value.admission,
      process: ProcessRuntimeStateSchema.parse({
        parentRunId: value.admission.parentRunId,
        runId: j.runId,
        processId: j.processId,
        version: j.version,
        revision: j.revision,
        status: j.status,
        ...(j.pending
          ? "kind" in j.pending
            ? profile === PROCESS_QUESTION_EXECUTION_PROFILE
              ? {
                  question: {
                    nodeId: j.pending.nodeId,
                    childRunId: j.pending.childRunId,
                    toolCallId: j.pending.toolCallId,
                    questionId: j.pending.questionId,
                    questionRevision: j.pending.questionRevision,
                    question: j.pending.question,
                  },
                }
              : {}
            : { approval: j.pending }
          : {}),
        ...(j.failure ? { failure: j.failure } : {}),
        ...(output?.success ? { output: output.data } : {}),
        ...(output ? { outputTruncated: !output.success } : {}),
      }),
    });
  };
  const read = (parentRunId: string, commandId?: string) =>
    context.serial(async () => response(await held(parentRunId), commandId));
  const recorded = (command: ProcessRuntimeCommand) =>
    context.serial(async () => {
      const current = await actor();
      if (command.type === "process.start") {
        const admission = starts.read(
          current,
          scope,
          command.commandId,
          command.idempotencyKey,
        );
        if (
          admission.commandDigest !== processDigest(command) ||
          admission.intentId !== command.intentId
        )
          throw new IdentityError(409, "idempotency_conflict");
        if (admission.status === "rejected")
          return ProcessRuntimeResponseSchema.parse({
            profile,
            scope,
            commandId: command.commandId,
            admission,
          });
        return response(await held(admission.parentRunId), command.commandId);
      }
      const binding =
        command.type === "process.answer"
          ? options.questions?.read(current, scope, command)
          : resolves.read(current, scope, command);
      if (!binding) throw new IdentityError(404, "process_start_not_found");
      return response(
        await held(binding.admission.parentRunId),
        command.commandId,
      );
    });
  const assertLive = (command: ProcessRuntimeCommand, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (resolves.interrupted(scope, command))
      throw new IdentityError(409, "process_command_cancelled");
  };
  // Only an unstarted seed or this exact pending decision can be terminalized here.
  // Native in-flight effects retain the runtime's authoritative cancelled/unknown outcome.
  const cancelUndispatched = (
    parentRunId: string,
    command: ProcessRuntimeCommand,
  ) =>
    context.serial(async () => {
      await actor();
      starts.retirementProof(scope, parentRunId);
      const journal = JournalSchema.parse(
        controller.store.turn(parentRunId, scope.workspaceId, scope.userId),
      );
      const seed =
        command.type === "process.start" &&
        journal.status === "running" &&
        !journal.visited.length &&
        !journal.operations.length &&
        !journal.inference &&
        !Object.keys(journal.agents).length;
      const decision =
        command.type === "service.resolve" &&
        journal.status === "waiting" &&
        journal.pending &&
        !("kind" in journal.pending) &&
        journal.pending.operationId === command.operationId &&
        journal.revision === command.expectedWorkRevision;
      const answer =
        command.type === "process.answer" &&
        journal.status === "waiting" &&
        journal.pending &&
        "kind" in journal.pending &&
        journal.pending.questionId === command.questionId &&
        journal.pending.questionRevision === command.questionRevision &&
        journal.pending.nodeId === command.nodeId &&
        journal.pending.childRunId === command.childRunId &&
        journal.pending.toolCallId === command.toolCallId &&
        journal.revision === command.expectedWorkRevision;
      if (!seed && !decision && !answer) return;
      journal.status = "cancelled";
      journal.failure = {
        code: "process_cancelled",
        ...(decision && command.type === "service.resolve"
          ? { operationId: command.operationId }
          : {}),
      };
      delete journal.pending;
      journal.revision++;
      finishLoopTrace(journal, "cancelled");
      controller.store.saveTurn(
        parentRunId,
        scope.workspaceId,
        scope.userId,
        JournalSchema.parse(journal),
      );
    });
  async function retired(parentRunId: string, ownedCleanup = false) {
    const value = await context.serial(async () => {
      if (!ownedCleanup) await actor();
      const proof = starts.retirementProof(scope, parentRunId);
      const journal = JournalSchema.parse(
        controller.store.turn(parentRunId, scope.workspaceId, scope.userId),
      );
      return { ...proof, journal };
    });
    const owner = await nativeCatalogOwner(controller);
    if (!owner.isSettled(parentRunId)) return false;
    for (const child of Object.values(value.journal.agents)) {
      const binding = {
        runId: child.runId,
        threadId: child.threadId,
        resourceId: value.journal.scopeDigest,
      };
      if (child.pending) {
        if (
          !(
            (await owner.proveSuspended({
              ...binding,
              toolCallId: child.pending.toolCallId,
              ...(child.pending.kind === "question"
                ? { question: child.pending.questionProof }
                : {}),
            })) && owner.isSettled(child.runId)
          ) &&
          !(owner.isSettled(child.runId) && (await owner.proveRetired(binding)))
        )
          return false;
      } else {
        if (!owner.isSettled(child.runId)) return false;
        let proved = await owner.proveRetired(binding);
        if (!proved)
          for (const answer of child.answers ?? []) {
            if (
              options.questions?.consumed(answer.answerId, answer.question) &&
              (await owner.proveSuspended({
                ...binding,
                toolCallId: answer.question.toolCallId,
                question: answer.question,
              }))
            ) {
              proved = true;
              break;
            }
          }
        if (!proved) return false;
      }
    }
    const journal = value.journal;
    if (
      !journal.visited.length &&
      !journal.operations.length &&
      !journal.inference &&
      !Object.keys(journal.agents).length
    )
      return true;
    const definition = value.artifact;
    const passive = async () => {
      throw new Error("Passive checkpoint proof cannot execute a boundary");
    };
    const proved = await owner.proveWorkflowRetired({
      runId: parentRunId,
      resourceId: journal.scopeDigest,
      artifactDigest: journal.artifactDigest,
      compilerVersion: journal.compilerVersion,
      definition: definition.definition,
      input: journal.input,
      boundary: {
        authorize: passive,
        enter: passive,
        leave: passive,
        action: passive,
        agent: passive,
      },
    });
    await context.serial(async () => {
      if (!ownedCleanup) await actor();
      starts.retirementProof(scope, parentRunId);
    });
    return proved;
  }
  async function dispatch(
    command: ProcessRuntimeCommand,
    signal: AbortSignal,
    entry: Request,
    validateOrigin: (
      intent: ProcessStartIntent,
      command: ProcessStartOriginalCommand,
    ) => void,
  ) {
    if (command.type === "process.start") {
      const admission = await context.serial(async () => {
        assertLive(command, signal);
        const current = await actor();
        resolves.assertUnused(scope, command.commandId, command.idempotencyKey);
        return starts.admit(
          current,
          scope,
          command.intentId,
          command,
          (intent, original) => {
            if (intent.origin.type === "meeting") {
              if (
                original.type !== "process.start" ||
                !options.validateMeetingOrigin
              )
                throw new IdentityError(409, "process_origin_changed");
              options.validateMeetingOrigin(intent.origin, intent.inputSchema);
            }
            validateOrigin(intent, original);
          },
          acceptCompiler,
        );
      });
      if (admission.status === "rejected")
        return ProcessRuntimeResponseSchema.parse({
          profile,
          scope,
          commandId: command.commandId,
          admission,
        });
      entry.parentRunId = admission.parentRunId;
      entry.retire = () => retired(admission.parentRunId, true);
      const saved = await context.serial(() => held(admission.parentRunId));
      if (saved.journal.status !== "running")
        return response(saved, command.commandId);
      await context.serial(async () => {
        await actor();
        assertLive(command, signal);
        validateMeetingAdmission(admission);
      });
      // This is an explicit original-command replay; the existing native runtime proves restart.
      await runtime.start(
        admission.processId,
        admission.runId,
        admission.input,
        signal,
        meetingOriginGuard(admission),
      );
      return read(admission.parentRunId, command.commandId);
    }
    if (command.type === "process.answer") {
      if (!options.questions || profile !== PROCESS_QUESTION_EXECUTION_PROFILE)
        throw new IdentityError(406, "process_profile_unsupported");
      const saved = await context.serial(async () => {
        assertLive(command, signal);
        return options.questions!.bind(
          await actor(),
          scope,
          command,
          () => {},
          validateMeetingAdmission,
        );
      });
      const { binding } = saved;
      entry.parentRunId = binding.admission.parentRunId;
      entry.retire = () => retired(binding.admission.parentRunId, true);
      const current = await context.serial(() =>
        held(binding.admission.parentRunId),
      );
      const pending = current.journal.pending;
      const resumeQuestion =
        current.journal.status === "waiting" &&
        pending &&
        "kind" in pending &&
        processDigest(pending) === processDigest(binding.question);
      const restartQuestion =
        saved.replay && current.journal.status === "running";
      await context.serial(async () => {
        await actor();
        assertLive(command, signal);
        if (resumeQuestion || restartQuestion)
          validateMeetingAdmission(binding.admission);
      });
      if (resumeQuestion) {
        await runtime.resume(
          binding.admission.runId,
          {
            kind: "question",
            nodeId: binding.question.nodeId,
            questionId: binding.question.questionId,
            questionRevision: binding.question.questionRevision,
            answerId: binding.bindingId,
          },
          signal,
          meetingOriginGuard(binding.admission),
        );
      } else if (saved.replay && current.journal.status === "running") {
        await runtime.start(
          binding.admission.processId,
          binding.admission.runId,
          binding.admission.input,
          signal,
          meetingOriginGuard(binding.admission),
        );
      } else if (!saved.replay)
        throw new IdentityError(409, "process_question_conflict");
      return read(binding.admission.parentRunId, command.commandId);
    }
    const priorDecision = await context.serial(async () => {
      assertLive(command, signal);
      return resolves.read(await actor(), scope, command);
    });
    let reviewed: Awaited<ReturnType<typeof approvalHeld>> | undefined;
    if (!priorDecision) {
      reviewed = await context.serial(() => approvalHeld(command));
      // Memory implementations may acquire the identity queue; validate outside a held callback.
      for (const agent of Object.values(reviewed.journal.agents)) {
        if (agent.memoryVersion === undefined) continue;
        if (!options.memory)
          throw new IdentityError(409, "process_memory_unavailable");
        await options.memory.validate(
          agent.memoryVersion,
          agent.memoryMetadata,
        );
      }
    }
    const saved = await context.serial(async () => {
      assertLive(command, signal);
      const current = await actor();
      acceptAdmission(
        starts.forParent(current, scope, command.workItemId).receipt,
      );
      if (
        reviewed &&
        (await approvalHeld(command)).signature !== reviewed.signature
      )
        throw new IdentityError(409, "process_approval_conflict");
      return resolves.bind(
        current,
        scope,
        command,
        (j) => {
          const receipt = controller.store.invocation(
            command.operationId,
            scope.workspaceId,
            scope.userId,
          );
          if (
            receipt?.status !== "awaiting_approval" ||
            receipt.organizationId !== organizationId ||
            !j.operations.includes(receipt.id)
          )
            throw new IdentityError(409, "process_approval_conflict");
        },
        (admission) => {
          if (command.approved) validateMeetingAdmission(admission);
        },
      );
    });
    const { binding } = saved;
    entry.parentRunId = binding.admission.parentRunId;
    entry.retire = () => retired(binding.admission.parentRunId, true);
    const current = await context.serial(() =>
      held(binding.admission.parentRunId),
    );
    const pendingApproval = current.journal.pending;
    const resumeApproval =
      current.journal.status === "waiting" &&
      !!pendingApproval &&
      !("kind" in pendingApproval) &&
      pendingApproval.operationId === binding.command.operationId &&
      pendingApproval.nodeId === binding.nodeId;
    const restartApproval =
      saved.replay && current.journal.status === "running";
    await context.serial(async () => {
      await actor();
      assertLive(command, signal);
      if (command.approved && (resumeApproval || restartApproval))
        validateMeetingAdmission(binding.admission);
    });
    if (resumeApproval) {
      await runtime.resume(
        binding.admission.runId,
        {
          nodeId: binding.nodeId,
          operationId: binding.command.operationId,
          approved: binding.command.approved,
        },
        signal,
        command.approved ? meetingOriginGuard(binding.admission) : undefined,
      );
    } else if (saved.replay && current.journal.status === "running") {
      await runtime.start(
        binding.admission.processId,
        binding.admission.runId,
        binding.admission.input,
        signal,
        command.approved ? meetingOriginGuard(binding.admission) : undefined,
      );
    } else if (!saved.replay)
      throw new IdentityError(409, "process_approval_conflict");
    // Recorded A may now expose pending B; returning its state never approves B.
    return read(binding.admission.parentRunId, command.commandId);
  }
  const runInFlight = (parentRunId: string) =>
    [...tracker.values()].some(
      (request) =>
        request.profile === "process" &&
        request.parentRunId === parentRunId &&
        request.scope.workspaceId === scope.workspaceId &&
        request.scope.userId === scope.userId,
    );
  /**
   * The person cancels their own waiting run (a question, an approval) or one
   * that stopped mid-way. Only after the native owner proves the run and its
   * agents retired or suspended; a request in flight for the run is refused.
   * A pending approval is declined (its receipt is rejected; nothing is
   * dispatched). Every other receipt keeps its outcome, so an unconfirmed
   * write stays unconfirmed.
   */
  async function cancelRun(parentRunId: string, expectedRevision: number) {
    if (runInFlight(parentRunId))
      throw new IdentityError(409, "process_command_in_progress");
    const saved = await context.serial(async () => {
      const value = await held(parentRunId);
      acceptAdmission(value.admission);
      return value.journal;
    });
    if (saved.revision !== expectedRevision)
      throw new IdentityError(409, "process_cancel_conflict");
    if (saved.status !== "running" && saved.status !== "waiting")
      return read(parentRunId);
    if (!(await retired(parentRunId)) || runInFlight(parentRunId))
      throw new IdentityError(409, "process_command_in_progress");
    await context.serial(() =>
      context.transaction(async () => {
        const current = await actor();
        starts.retirementProof(scope, parentRunId);
        const journal = JournalSchema.parse(
          controller.store.turn(parentRunId, scope.workspaceId, scope.userId),
        );
        if (
          journal.revision !== expectedRevision ||
          (journal.status !== "running" && journal.status !== "waiting")
        )
          throw new IdentityError(409, "process_cancel_conflict");
        if (runInFlight(parentRunId))
          throw new IdentityError(409, "process_command_in_progress");
        const receipts = journal.operations.flatMap((id) => {
          const receipt = controller.store.invocation(
            id,
            scope.workspaceId,
            scope.userId,
          );
          return receipt?.organizationId === organizationId ? [receipt] : [];
        });
        if (receipts.some((receipt) => receipt.status === "running"))
          throw new IdentityError(409, "process_command_in_progress");
        const approval =
          journal.pending && !("kind" in journal.pending)
            ? journal.pending
            : undefined;
        const declined =
          approval &&
          receipts.find(
            (receipt) =>
              receipt.id === approval.operationId &&
              receipt.status === "awaiting_approval",
          );
        if (declined)
          controller.store.saveInvocation({ ...declined, status: "rejected" });
        const uncertain = receipts.some(
          (receipt) =>
            receipt.effect === "write" && receipt.status === "unknown",
        );
        journal.status = "cancelled";
        journal.failure = {
          code: "process_cancelled",
          ...(approval ? { operationId: approval.operationId } : {}),
        };
        delete journal.pending;
        journal.revision++;
        finishLoopTrace(journal, uncertain ? "unknown" : "cancelled");
        controller.store.saveTurn(
          parentRunId,
          scope.workspaceId,
          scope.userId,
          JournalSchema.parse(journal),
        );
        context.audit({
          organizationId,
          workspaceId: scope.workspaceId,
          actorId: current.userId,
          source: "chat",
          action: "work.cancelled",
          targetId: parentRunId,
          outcome: uncertain ? "unknown" : "cancelled",
          details: { reason: "cancelled" },
        });
      }),
    );
    return read(parentRunId);
  }
  const coordinator = {
    read,
    retired,
    cancelRun,
    async execute(
      raw: unknown,
      signal: AbortSignal,
      validateOrigin: (
        intent: ProcessStartIntent,
        command: ProcessStartOriginalCommand,
      ) => void,
      /** A hub refresh runs beside the person's chat, not in its place. */
      options: { lane?: "hub" } = {},
    ): Promise<ProcessRuntimeResponse> {
      const command = ProcessRuntimeCommandSchema.parse(raw);
      if (
        command.type === "process.answer" &&
        profile !== PROCESS_QUESTION_EXECUTION_PROFILE
      )
        throw new IdentityError(406, "process_profile_unsupported");
      context.validateRequest?.();
      signal.throwIfAborted();
      let entry = tracker.find<Request>(scope, command, "process");
      if (entry?.unsettled) {
        await context.serial(async () => {
          await actor();
          signal.throwIfAborted();
        });
        await tracker.retireScope(scope, (old) =>
          old.profile === "process" && old.parentRunId
            ? retired(old.parentRunId)
            : Promise.resolve(false),
        );
        const refreshed = tracker.find<Request>(scope, command, "process");
        if (!refreshed)
          return coordinator.execute(command, signal, validateOrigin);
        entry = refreshed;
      }
      if (!entry) {
        const controller = new AbortController();
        const request: Request = {
          scope,
          profile: "process",
          command,
          controller,
          unsettled: false,
          promise: undefined as unknown as Promise<ProcessRuntimeResponse>,
        };
        // Register before the first authorization await so interruption cannot miss a queued request.
        tracker.register(request);
        const combined = AbortSignal.any([signal, controller.signal]);
        const activeKey = personLane(scope, options.lane);
        request.promise = Promise.resolve()
          .then(async () => {
            await context.serial(async () => {
              const current = await actor();
              if (command.type === "service.resolve")
                acceptAdmission(
                  starts.forParent(current, scope, command.workItemId).receipt,
                );
              combined.throwIfAborted();
            });
            if (
              await context.serial(async () => {
                await actor();
                return resolves.interrupted(scope, command);
              })
            ) {
              try {
                return await recorded(command);
              } catch (error) {
                if (error instanceof IdentityError && error.status === 404)
                  throw new IdentityError(409, "process_command_cancelled");
                throw error;
              }
            }
            await tracker.retireOwned();
            await tracker.retireScope(scope, (old) =>
              old.profile === "process" && old.parentRunId
                ? retired(old.parentRunId)
                : Promise.resolve(false),
            );
            await context.serial(async () => {
              await actor();
              assertLive(command, combined);
              if (
                tracker.activeScopes.has(activeKey) ||
                tracker.activeScopes.size >= MAX_ACTIVE_RUNS
              )
                throw new IdentityError(429, "catalog_busy");
              tracker.acquireScope(activeKey, request);
            });
            return dispatch(command, combined, request, validateOrigin);
          })
          .finally(async () => {
            try {
              request.unsettled = request.retire
                ? !(await request.retire())
                : false;
            } catch {
              request.unsettled = true;
            }
            if (!request.unsettled) {
              tracker.releaseScope(activeKey, request);
              tracker.release(request);
            }
          });
        // The caller's separate current-auth check may reject before joining this promise.
        void request.promise.catch(() => {});
        entry = request;
      }
      await context.serial(async () => {
        const current = await actor();
        if (command.type === "service.resolve")
          acceptAdmission(
            starts.forParent(current, scope, command.workItemId).receipt,
          );
        signal.throwIfAborted();
      });
      const result = await entry.promise;
      await context.serial(async () => {
        await actor();
      });
      if (result.admission.status === "admitted")
        acceptCompiler(result.admission.compilerVersion);
      // Shared in-flight ownership remains common; negotiated envelopes are per caller.
      return ProcessRuntimeResponseSchema.parse({ ...result, profile });
    },
    async interrupt(raw: unknown) {
      const command = ProcessRuntimeCommandSchema.parse(raw);
      if (
        command.type === "process.answer" &&
        profile !== PROCESS_QUESTION_EXECUTION_PROFILE
      )
        throw new IdentityError(406, "process_profile_unsupported");
      const entry = await context.serial(async () => {
        await actor();
        const found = tracker.find<Request>(scope, command, "process");
        if (found) resolves.interrupt(scope, command); // Durable barrier precedes abort.
        return found;
      });
      let parentRunId = entry?.parentRunId;
      if (!entry) {
        let saved: ProcessRuntimeResponse;
        try {
          saved = await recorded(command);
        } catch (error) {
          if (!(error instanceof IdentityError) || error.status !== 404)
            throw error;
          return {
            profile,
            scope,
            commandId: command.commandId,
            status: "unknown" as const,
            reason: "not_running" as const,
          };
        }
        await context.serial(async () => {
          await actor();
          resolves.interrupt(scope, command);
        });
        parentRunId = saved.process?.parentRunId;
        if (!parentRunId)
          return {
            profile,
            scope,
            commandId: command.commandId,
            status: "settled" as const,
            result: saved,
          };
      } else {
        entry.controller.abort(REQUEST_INTERRUPTION_REASON);
        try {
          await entry.promise;
        } catch {
          /* Rejection is not retirement proof. */
        }
        parentRunId = entry.parentRunId;
        await tracker.retireScope(scope, (request) =>
          request.profile === "process" && request.parentRunId
            ? retired(request.parentRunId)
            : Promise.resolve(false),
        );
      }
      if (!parentRunId || entry?.unsettled || !(await retired(parentRunId)))
        return {
          profile,
          scope,
          commandId: command.commandId,
          status: "unknown" as const,
          reason: "not_settled" as const,
        };
      await cancelUndispatched(parentRunId, command);
      return {
        profile,
        scope,
        commandId: command.commandId,
        status: "settled" as const,
        result: await read(parentRunId, command.commandId),
      };
    },
  };
  return coordinator;
}
