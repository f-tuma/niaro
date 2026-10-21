import { createHash } from "node:crypto";
import type { Scope, Language } from "../../packages/protocol";
import type { CatalogContext, CatalogController } from "./catalog-controller";
import type { CatalogRuntime, ServiceAnswer } from "./catalog-runtime";
import type { AgentMemory } from "./agent-memory";
import type { PluginSettings } from "../server-plugins/registry";
import { createNiaroMastraModel } from "../server-integrations/mastra-model";
import {
  createMastraDomain,
  DomainCommandSchema,
  NATIVE_TASK_EXPIRY_MS,
  nativeQuestionId,
  type DomainSession,
  type NativeFailureReason,
} from "./mastra-domain";
import { IdentityError } from "./error";
import { isInferenceBudgetFailureCode } from "./inference-budget-failure";
import {
  finishLoopTrace,
  finishLoopStep,
  startLoopStep,
  toolOutcome,
} from "./loop-trace";
import {
  startLoopToolDetails,
  finishLoopToolDetails,
} from "./loop-tool-details";
import { loopText } from "./loop-redaction";
import { IntegrationError } from "../server-integrations/transport";
import { ServiceConnectionRequired } from "./service-oauth";
import type { InferenceRunCaps } from "./inference-budget";

type NativeRuntime = Awaited<
  ReturnType<(typeof import("@niaro/server-agent"))["createNativeAgentRuntime"]>
>;
const owners = new WeakMap<CatalogController, Promise<NativeRuntime>>();
/** Only the authenticated command coordinator can create this abort reason. */
export const REQUEST_INTERRUPTION_REASON = Symbol("request-interruption");
export class NativeRunUnsettledError extends Error {
  constructor(message = "native_run_not_settled") {
    super(message);
  }
}
export class RequestInterruptionUnsettledError extends NativeRunUnsettledError {
  constructor() {
    super("request_interruption_not_settled");
  }
}
/** Retirement is proved even when current authority denies publishing the old turn. */
export class NativeRunRetiredPublicationError extends Error {
  constructor(readonly rejection: unknown) {
    super("native_run_retired_publication_failed");
  }
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function nativeCatalogOwner(controller: CatalogController) {
  let runtime = owners.get(controller);
  if (!runtime) {
    runtime = import("@niaro/server-agent").then((module) =>
      module.createNativeAgentRuntime(controller.store.nativeStorageUrl),
    );
    owners.set(controller, runtime);
    runtime.catch(() => {
      if (owners.get(controller) === runtime) owners.delete(controller);
    });
  }
  return runtime;
}

/** Close the native checkpoint and conversation store before the identity DB. */
export async function closeNativeCatalogRuntime(controller: CatalogController) {
  const runtime = owners.get(controller);
  if (!runtime) return;
  owners.delete(controller);
  await (await runtime).close();
}

/** Native memory inspection is scoped by the same server-owned thread/resource ids. */
export async function inspectNativeCatalogRuntime(
  controller: CatalogController,
  threadId: string,
  resourceId: string,
) {
  const runtime = await nativeCatalogOwner(controller);
  return runtime.inspect({ threadId, resourceId });
}

/** The application boundary contains policy and receipts; Mastra owns the execution loop. */
export function createNativeCatalogRuntime(
  controller: CatalogController,
  context: CatalogContext,
  scope: Scope,
  organizationId: string,
  settings: PluginSettings | undefined,
  resultCard: (id: string, language: Language) => Promise<ServiceAnswer>,
  memory?: AgentMemory,
  inferenceCaps?: InferenceRunCaps,
): CatalogRuntime {
  const store = controller.store;
  const target = { organizationId, workspaceId: scope.workspaceId };
  const domain = createMastraDomain(
    controller,
    context,
    scope,
    organizationId,
    settings,
    resultCard,
    memory,
    inferenceCaps,
  );
  const resourceId = digest([
    scope.serverId,
    organizationId,
    scope.workspaceId,
    scope.userId,
  ]);
  const key = (commandId: string) =>
    digest([scope.serverId, scope.workspaceId, scope.userId, commandId]);
  const retired = async (
    runtime: NativeRuntime,
    state: DomainSession["state"],
  ) => {
    try {
      return (
        (await runtime.proveRetired({
          runId: state.runId,
          threadId: state.threadId,
          resourceId,
        })) && runtime.isSettled(state.runId)
      );
    } catch {
      return false;
    }
  };
  async function finishRetiredFailure(
    session: DomainSession,
    state: DomainSession["state"],
    cause: "authority" | "execution",
    publish: boolean,
    originalError: unknown,
  ): Promise<ServiceAnswer> {
    const runtime = await nativeCatalogOwner(controller);
    if (!(await retired(runtime, state))) throw new NativeRunUnsettledError();
    if (!publish) {
      try {
        await session.recordRetiredDiagnostic();
      } catch {
        /* Preserve the original refusal; no stale answer is published. */
      }
      throw originalError;
    }
    try {
      return await session.finishRetiredFailure(cause);
    } catch {
      // Once exact native retirement is proved, retain a terminal trace even
      // when current membership no longer permits publishing a user reply.
      try {
        await session.recordRetiredDiagnostic();
      } catch {
        /* Never replace the original authorization/execution failure. */
      }
      throw originalError;
    }
  }
  function failureReason(
    error: unknown,
    session: DomainSession,
  ): NativeFailureReason | undefined {
    if (error instanceof ServiceConnectionRequired) return undefined;
    if (error instanceof IdentityError) {
      if (
        error.code === "catalog_budget_exhausted" &&
        session.modelLimitReached()
      )
        return "budget";
      return isInferenceBudgetFailureCode(error.code) ? error.code : undefined;
    }
    if (error instanceof IntegrationError) {
      if (
        [
          "integration_model_response_invalid",
          "integration_response_invalid",
          "integration_response_too_large",
          "integration_model_input_unsupported",
        ].includes(error.code)
      )
        return "protocol";
      if (
        ["integration_provider_failed", "integration_unavailable"].includes(
          error.code,
        )
      )
        return "provider";
      return undefined;
    }
    if (
      error instanceof Error &&
      error.message === "niaro_native_step_budget_exhausted"
    )
      return "budget";
    // Native/SDK execution exceptions are safe only after retirement and full
    // current domain authorization. Their message and cause never reach storage.
    return error instanceof Error ? "execution" : undefined;
  }
  async function currentActor() {
    const actor = await context.actor(target);
    if (actor.userId !== scope.userId)
      throw new IdentityError(403, "identity_forbidden");
    return actor;
  }
  const withConversation = <T>(
    conversationId: string | undefined,
    run: () => Promise<T>,
  ) =>
    controller.withTurn(
      "native-conversation-" +
        digest([resourceId, conversationId ?? "default"]),
      run,
    );
  async function recorded(
    session: DomainSession,
  ): Promise<ServiceAnswer | undefined> {
    const answer = session.state.answer;
    if (!answer) return undefined;
    await session.authorize();
    if (!answer.result) return { ...answer, workItemId: session.state.runId };
    const current = await resultCard(
      answer.result.operationId,
      session.state.language,
    );
    return current.result?.status === answer.result.status
      ? {
          ...current,
          workItemId: session.state.runId,
          reply: answer.reply,
          result: {
            ...current.result,
            ...(answer.result.card ? { card: answer.result.card } : {}),
          },
        }
      : { ...current, workItemId: session.state.runId };
  }
  async function execute(
    session: DomainSession,
    signal: AbortSignal,
    text?: string,
    resume?: { toolCallId: string; data: unknown },
  ) {
    const runtime = await nativeCatalogOwner(controller);
    const state = session.state;
    if (state.trace) {
      state.trace.status = "running";
      state.trace.finishedAt = null;
    }
    let definitions: Awaited<ReturnType<DomainSession["definitions"]>>;
    try {
      definitions = await session.definitions();
    } catch (error) {
      if (signal.reason !== REQUEST_INTERRUPTION_REASON) throw error;
      if (!runtime.isSettled(state.runId))
        throw new RequestInterruptionUnsettledError();
      return session.finishInterrupted();
    }
    const actionLabels = new Map(
      definitions
        .filter((definition) => definition.name.startsWith("action_"))
        .map((definition) => [
          definition.name,
          definition.description.split(":")[0]!.slice(0, 160),
        ]),
    );
    const steps = new Map<string, ReturnType<typeof startLoopStep>>();
    // A mutation may commit and then lose its return value. Its business checkpoint
    // must survive native error handling, which runs in a different database.
    async function restoreCommittedMutation() {
      await context.serial(async () => {
        await currentActor();
        const saved = DomainCommandSchema.safeParse(
          store.turn(state.runId, scope.workspaceId, scope.userId),
        );
        if (
          saved.success &&
          saved.data.memoryReceipts.length > state.memoryReceipts.length
        ) {
          state.memoryReceipts = saved.data.memoryReceipts;
          state.memoryChanged = saved.data.memoryChanged;
          state.memoryVersion = saved.data.memoryVersion;
          state.memoryMetadata = saved.data.memoryMetadata;
          state.threadAuthority = saved.data.threadAuthority;
          state.answeredQuestion = saved.data.answeredQuestion;
          state.memoryReads = saved.data.memoryReads;
          state.pending = saved.data.pending;
        }
      });
    }
    try {
      const output = await runtime.execute({
        runId: state.runId,
        threadId: state.threadId,
        resourceId,
        text,
        resume,
        signal,
        session,
        definitions,
        createModel: (selected) =>
          createNiaroMastraModel(
            selected,
            session.transport(selected, "model"),
            (start) =>
              session.allowance(
                selected.provider.id,
                selected.provider.revision,
                start,
              ),
          ),
        onEvent: async (event) => {
          if (event.type === "model-start") {
            steps.set(
              "model",
              startLoopStep(
                state,
                "model",
                "Mastra model",
                event.model
                  ? [{ label: "Model", value: loopText(event.model, 160) }]
                  : [],
              ),
            );
          } else if (event.type === "model-end") {
            finishLoopStep(steps.get("model"), "succeeded");
          } else if (event.type === "tool-start") {
            const step = startLoopStep(
              state,
              "tool",
              actionLabels.get(event.name) ?? event.name,
              [],
              event.toolCallId,
            );
            if (step) step.tool = startLoopToolDetails(event.name, event.args);
            steps.set(event.toolCallId, step);
          } else if (event.type === "tool-end") {
            if (event.error) await restoreCommittedMutation();
            // A card that could not be composed only changes how the reply
            // looks; it is not an action an administrator has to check.
            if (event.name !== "compose_card")
              session.recordToolProblem(
                actionLabels.get(event.name) ?? event.name,
                event.invalidArguments
                  ? "invalid_arguments"
                  : event.error || event.unavailable
                    ? "unavailable"
                    : undefined,
              );
            const step = steps.get(event.toolCallId);
            const operationId =
              !event.unavailable &&
              state.receipts.find(
                (receipt) => receipt.callId === event.toolCallId,
              )?.operationId;
            const receipt =
              operationId &&
              (await context.serial(async () => {
                await currentActor();
                return store.invocation(
                  operationId,
                  scope.workspaceId,
                  scope.userId,
                );
              }));
            if (step && receipt) step.label = receipt.title;
            const committedMemory =
              !event.unavailable &&
              state.memoryReceipts.find(
                (receipt) => receipt.toolCallId === event.toolCallId,
              );
            const status =
              event.unavailable || event.invalidArguments
                ? "failed"
                : receipt
                  ? toolOutcome(receipt)
                  : committedMemory
                    ? "succeeded"
                    : event.error
                      ? signal.aborted
                        ? "cancelled"
                        : "failed"
                      : toolOutcome(event.output);
            if (step?.tool)
              step.tool = finishLoopToolDetails(step.tool, {
                output: committedMemory ? committedMemory.result : event.output,
                error: committedMemory ? undefined : event.error,
                unavailable: event.unavailable,
                invalidArguments: event.invalidArguments,
                status,
              });
            finishLoopStep(step, status);
          }
          await session.save(false);
        },
      });
      if (state.pending) {
        finishLoopTrace(state, "waiting");
        await session.finalize(output.text ?? "");
      }
      const answer = await recorded(session);
      if (!answer)
        throw new IdentityError(502, "integration_model_response_invalid");
      await session.save(false);
      return answer;
    } catch (error) {
      if (signal.reason === REQUEST_INTERRUPTION_REASON) {
        if (!(await retired(runtime, state)))
          throw new RequestInterruptionUnsettledError();
        await restoreCommittedMutation();
        if (state.terminalCandidate) return domain.finalizeFailure(state.runId);
        return session.finishInterrupted();
      }
      const reason = !signal.aborted
        ? failureReason(error, session)
        : undefined;
      try {
        await restoreCommittedMutation();
      } catch (authorityError) {
        if (!(await retired(runtime, state))) {
          try {
            await session.stageFailure(reason ?? "execution");
          } catch {
            /* No publication authority. */
          }
          throw new NativeRunUnsettledError();
        }
        return finishRetiredFailure(
          session,
          state,
          authorityError instanceof IdentityError ? "authority" : "execution",
          authorityError instanceof IdentityError &&
            authorityError.code === "identity_forbidden",
          authorityError,
        );
      }
      if (reason) {
        if (state.pending) {
          let suspended = false;
          try {
            suspended = await runtime.proveSuspended({
              runId: state.runId,
              threadId: state.threadId,
              resourceId,
              toolCallId: state.pending.toolCallId,
            });
          } catch {
            /* An invalid checkpoint cannot authorize waiting input. */
          }
          if (suspended && runtime.isSettled(state.runId)) {
            await session.finalize("");
            return (await recorded(session))!;
          }
        }
        try {
          await session.stageFailure(reason);
        } catch (authorityError) {
          if (!(await retired(runtime, state)))
            throw new NativeRunUnsettledError();
          return finishRetiredFailure(
            session,
            state,
            authorityError instanceof IdentityError ? "authority" : "execution",
            authorityError instanceof IdentityError &&
              authorityError.code === "identity_forbidden",
            authorityError,
          );
        }
        if (!(await retired(runtime, state)))
          throw new NativeRunUnsettledError();
        await session.finishFailure(reason);
        return (await recorded(session))!;
      }
      // Authority and abort rejections retain their own semantics, but they
      // cannot release a native worker whose retirement is still unproved.
      if (!(await retired(runtime, state))) {
        try {
          await session.stageFailure("execution");
        } catch {
          /* Diagnostics were persisted before the publication guards. */
        }
        throw new NativeRunUnsettledError();
      }
      return finishRetiredFailure(
        session,
        state,
        error instanceof IdentityError ? "authority" : "execution",
        error instanceof IdentityError && error.code === "identity_forbidden",
        error,
      );
    }
  }
  async function projectTasks(roots?: unknown[], includePlain = false) {
    const states = await context.serial(async () => {
      await currentActor();
      context.validateRequest?.();
      return (roots ?? store.nativeTurns(scope.workspaceId, scope.userId))
        .map((value) => DomainCommandSchema.parse(value))
        .filter(
          (state) =>
            (includePlain ||
              state.taskTracked ||
              state.pending ||
              state.operations.length ||
              state.answeredQuestion) &&
            state.conversationId &&
            state.runId === key(state.aliases[0]!.commandId),
        );
    });
    return Promise.all(
      states.map(async (state) => {
        const availability =
          includePlain || state.pending
            ? await domain.taskAvailability(state)
            : "available";
        const available = availability === "available";
        let resumable =
          available && !!state.pending && !state.terminalCandidate;
        if (resumable) {
          const owner = await nativeCatalogOwner(controller);
          try {
            resumable = await owner.proveSuspended({
              runId: state.runId,
              threadId: state.threadId,
              resourceId,
              toolCallId: state.pending!.toolCallId,
            });
          } catch {
            resumable = false;
          }
        }
        const actionId =
          state.pending?.operationId ??
          state.taskCancellation?.operationId ??
          state.answer?.result?.operationId;
        const currentAction =
          available && actionId
            ? (await resultCard(actionId, state.language)).result
            : undefined;
        const action =
          currentAction?.status === "awaiting_approval" && !resumable
            ? undefined
            : currentAction;
        // A finished trace is the run's last word; only an unfinished failure
        // still waits for the server to settle it.
        const finished =
          state.trace?.status === "failed" ||
          state.trace?.status === "cancelled";
        const status = !available
          ? availability
          : state.terminalCandidate && !state.answer && !finished
            ? "waiting_system"
            : state.pending && !resumable
              ? "waiting_system"
              : state.pending?.kind === "question"
                ? "waiting_input"
                : state.pending?.kind === "approval" &&
                    action?.status === "awaiting_approval"
                  ? "waiting_approval"
                  : state.trace?.status === "succeeded"
                    ? "succeeded"
                    : state.trace?.status === "cancelled"
                      ? "cancelled"
                      : state.trace?.status === "failed"
                        ? "failed"
                        : "waiting_system";
        return {
          id: state.runId,
          revision: state.workRevision,
          conversationId: state.conversationId!,
          title: state.goal.slice(0, 160),
          context: available
            ? state.pending?.question || state.answer?.reply || state.goal
            : state.goal,
          status,
          inputRequestIds: [],
          actionProposalIds: [],
          operationIds: [],
          demo: false,
          native: {
            runId: state.runId,
            revision: state.workRevision,
            ...(state.aliases[0]?.outerCommandId
              ? { sourceCommandId: state.aliases[0].outerCommandId }
              : {}),
            ...(resumable && state.pending?.kind === "question"
              ? {
                  question: {
                    runtime: "mastra" as const,
                    id: nativeQuestionId(state.runId, state.pending.toolCallId),
                    revision: 1,
                    workItemId: state.runId,
                    conversationId: state.conversationId!,
                    question: state.pending.question || state.goal,
                    status: "open" as const,
                    ...(state.pending.options
                      ? {
                          options: state.pending.options,
                          ...(state.pending.multiple
                            ? { multiple: true as const }
                            : {}),
                        }
                      : {}),
                  },
                }
              : {}),
            ...(action ? { action } : {}),
          },
          ...(available && state.answer && !state.pending
            ? { result: state.answer.reply }
            : {}),
          presentation: {
            type: "workflow.progress" as const,
            version: 1 as const,
            variant: "default" as const,
          },
        } satisfies import("../../packages/protocol").WorkItem;
      }),
    );
  }
  async function cancelTask(binding: {
    workItemId: string;
    expectedWorkRevision: number;
    conversationId: string;
  }): Promise<ServiceAnswer> {
    return withConversation(binding.conversationId, () =>
      controller.withTurn(binding.workItemId, async () => {
        const session = await domain.forTaskCancellation(binding);
        const state = session.state;
        if (state.taskCancellation) {
          const action = state.taskCancellation.operationId
            ? await resultCard(
                state.taskCancellation.operationId,
                state.language,
              )
            : undefined;
          return {
            ...state.answer!,
            workItemId: state.runId,
            ...(action?.result ? { result: action.result } : {}),
          };
        }
        const owner = await nativeCatalogOwner(controller);
        // Settled suspension is a different proof from native retirement.
        // Cancellation closes domain resume authority and leaves the exact
        // durable checkpoint dormant; it never executes or resumes that call.
        if (!state.pending || !owner.isSettled(state.runId))
          throw new NativeRunUnsettledError();
        const suspended = await owner.proveSuspended({
          runId: state.runId,
          threadId: state.threadId,
          resourceId,
          toolCallId: state.pending.toolCallId,
        });
        const provedRetired = !suspended && (await retired(owner, state));
        if ((!suspended && !provedRetired) || !owner.isSettled(state.runId))
          throw new NativeRunUnsettledError();
        return session.cancelSuspended(
          () => owner.isSettled(state.runId),
          suspended ? "suspended" : "retired",
        );
      }),
    );
  }
  async function cancelOpenTask(binding: {
    workItemId: string;
    expectedWorkRevision: number;
    conversationId: string;
  }) {
    const state = await context.serial(async () => {
      await currentActor();
      context.validateRequest?.();
      const parsed = DomainCommandSchema.safeParse(
        store.turn(binding.workItemId, scope.workspaceId, scope.userId),
      );
      if (
        !parsed.success ||
        parsed.data.runId !== binding.workItemId ||
        parsed.data.runId !== key(parsed.data.aliases[0]!.commandId) ||
        parsed.data.conversationId !== binding.conversationId
      )
        throw new IdentityError(404, "catalog_not_found");
      return parsed.data;
    });
    if (state.workRevision !== binding.expectedWorkRevision)
      throw new IdentityError(409, "catalog_conflict");
    if (state.pending) {
      // The exact settled suspension closes; the checkpoint stays dormant.
      await cancelTask(binding);
      await context.serial(async () => {
        const actor = await currentActor();
        context.audit({
          organizationId,
          workspaceId: scope.workspaceId,
          actorId: actor.userId,
          source: "chat",
          action: "work.cancelled",
          targetId: state.runId,
          outcome: "cancelled",
          details: { reason: "cancelled" },
        });
      });
      return;
    }
    // Already answered or closed: nothing waits any more.
    if (state.answer) return;
    await withConversation(state.conversationId, () =>
      controller.withTurn(state.runId, async () => {
        const owner = await nativeCatalogOwner(controller);
        // A run still executing is never closed underneath its worker.
        if (!(await retired(owner, state))) throw new NativeRunUnsettledError();
        if (state.terminalCandidate) await domain.finalizeFailure(state.runId);
        else await domain.cancelRetired(state.runId, state.workRevision);
      }),
    );
  }
  return {
    enabled: true,
    async hasTerminal(input) {
      return context.serial(async () => {
        await currentActor();
        const state = DomainCommandSchema.safeParse(
          store.turn(key(input.commandId), scope.workspaceId, scope.userId),
        );
        return (
          state.success &&
          !!state.data.terminalCandidate &&
          state.data.conversationId === input.conversationId &&
          state.data.aliases.some(
            (alias) =>
              alias.commandId === input.commandId &&
              alias.requestHash === input.requestHash,
          )
        );
      });
    },
    async ensureSettled(input) {
      const candidates = await context.serial(async () => {
        await currentActor();
        const states = store
          .nativeTurns(scope.workspaceId, scope.userId)
          .map((value) => DomainCommandSchema.parse(value));
        for (const state of states) {
          for (const alias of state.aliases) {
            if (
              alias.commandId === input.commandId ||
              alias.outerCommandId === input.outerCommandId
            ) {
              if (alias.requestHash && alias.requestHash !== input.requestHash)
                throw new IdentityError(409, "idempotency_conflict");
            }
          }
        }
        return states.filter(
          (state) =>
            state.terminalCandidate &&
            !state.answer &&
            !state.aliases.some((alias) => alias.commandId === input.commandId),
        );
      });
      if (!candidates.length) return true;
      const owner = await nativeCatalogOwner(controller);
      for (const state of candidates)
        if (!(await retired(owner, state))) return false;
      return true;
    },
    async proveRetired(input) {
      // A server-owned exact journal binding can retire a reservation even when
      // its captured actor can no longer authorize any public response.
      const state = await context.serial(async () => {
        const parsed = DomainCommandSchema.safeParse(
          store.turn(key(input.commandId), scope.workspaceId, scope.userId),
        );
        return parsed.success &&
          parsed.data.conversationId === input.conversationId &&
          parsed.data.aliases.some(
            (alias) =>
              alias.commandId === input.commandId &&
              alias.requestHash === input.requestHash,
          )
          ? parsed.data
          : null;
      });
      return !!state && retired(await nativeCatalogOwner(controller), state);
    },
    tasks: (roots) => projectTasks(roots),
    async readTask(commandId) {
      const state = await context.serial(async () => {
        await currentActor();
        context.validateRequest?.();
        const parsed = DomainCommandSchema.safeParse(
          store.turn(key(commandId), scope.workspaceId, scope.userId),
        );
        if (
          !parsed.success ||
          !parsed.data.aliases.some((alias) => alias.commandId === commandId) ||
          parsed.data.runId !== key(parsed.data.aliases[0]!.commandId) ||
          !parsed.data.conversationId
        )
          return null;
        return parsed.data;
      });
      if (!state) return null;
      let task = (await projectTasks([state], true))[0] ?? null;
      if (!task) return null;
      let cancellationSettled = false;
      if (!state.pending && !["expired", "superseded"].includes(task.status)) {
        const owner = await nativeCatalogOwner(controller);
        let settled = false;
        try {
          settled =
            state.taskCancellation &&
            state.taskCancellation.proofType !== "retired"
              ? owner.isSettled(state.runId) &&
                (await owner.proveSuspended({
                  runId: state.runId,
                  threadId: state.threadId,
                  resourceId,
                  toolCallId: state.taskCancellation.toolCallId,
                })) &&
                owner.isSettled(state.runId)
              : await retired(owner, state);
          cancellationSettled = !!state.taskCancellation && settled;
        } catch {
          settled = false;
        }
        if (!settled) {
          const { result: _result, ...waiting } = task;
          task = { ...waiting, status: "waiting_system", context: state.goal };
        }
      }
      // Native inspection and canonical receipt projection may await storage.
      // Reject a changed journal rather than publishing an older input binding.
      await context.serial(async () => {
        await currentActor();
        context.validateRequest?.();
        if (
          digest(store.turn(state.runId, scope.workspaceId, scope.userId)) !==
          digest(state)
        )
          throw new IdentityError(409, "catalog_conflict");
      });
      const availability = await domain.taskAvailability(state);
      if (availability !== "available") {
        const { result: _result, ...redacted } = task;
        return {
          ...redacted,
          status: availability,
          context: state.goal,
          native: {
            runId: state.runId,
            revision: state.workRevision,
            ...(task.native?.sourceCommandId
              ? { sourceCommandId: task.native.sourceCommandId }
              : {}),
          },
        };
      }
      return {
        ...task,
        ...(cancellationSettled ? { cancellationSettled: true as const } : {}),
        ...(state.pending ? { cancellationPending: true as const } : {}),
      };
    },
    cancelTask,
    cancelOpenTask,
    async settleStaleTasks(conversationId) {
      const stale = await context.serial(async () => {
        await currentActor();
        context.validateRequest?.();
        return store
          .nativeTurns(scope.workspaceId, scope.userId)
          .flatMap((value) => {
            const parsed = DomainCommandSchema.safeParse(value);
            if (!parsed.success) return [];
            const state = parsed.data;
            const age = Date.now() - Date.parse(state.openedAt);
            return state.conversationId === conversationId &&
              state.runId === key(state.aliases[0]!.commandId) &&
              !state.pending &&
              !state.answer &&
              age >= NATIVE_TASK_EXPIRY_MS
              ? [state]
              : [];
          });
      });
      let settled = 0;
      for (const state of stale) {
        try {
          await cancelOpenTask({
            workItemId: state.runId,
            expectedWorkRevision: state.workRevision,
            conversationId,
          });
          settled++;
        } catch {
          // It stays open; the refusal names it and the person can cancel it.
        }
      }
      return settled;
    },
    async openTask(id, revision, conversationId, language) {
      return withConversation(conversationId, () =>
        controller.withTurn(id, async () => {
          const state = await domain.selectTask(id, revision, conversationId);
          if (state.terminalCandidate && !state.answer) {
            const owner = await nativeCatalogOwner(controller);
            if (!(await retired(owner, state)))
              throw new NativeRunUnsettledError();
            return domain.finalizeFailure(state.runId);
          }
          return state.pending?.operationId
            ? resultCard(state.pending.operationId, language)
            : { reply: state.pending?.question ?? state.goal };
        }),
      );
    },
    async forgetConversation(conversationId) {
      const threadIds = await context.serial(async () => {
        await currentActor();
        return store.conversationThreads(
          scope.workspaceId,
          scope.userId,
          conversationId,
        );
      });
      if (!threadIds.length) return 0;
      // The chat's turn lock: a turn still finishing writes its thread first.
      return withConversation(conversationId, async () => {
        const runtime = await nativeCatalogOwner(controller);
        return runtime.forgetThreads({ threadIds, resourceId });
      });
    },
    async hasTurn(commandId) {
      return context.serial(async () => {
        await currentActor();
        return DomainCommandSchema.safeParse(
          store.turn(key(commandId), scope.workspaceId, scope.userId),
        ).success;
      });
    },
    async recoverResult(input) {
      const state = await context.serial(async () => {
        await currentActor();
        const parsed = DomainCommandSchema.safeParse(
          store.turn(key(input.commandId), scope.workspaceId, scope.userId),
        );
        if (!parsed.success) return null;
        const request = parsed.data.aliases.find(
          (alias) => alias.commandId === input.commandId,
        );
        if (request?.requestHash && request.requestHash !== input.requestHash)
          throw new IdentityError(409, "catalog_conflict");
        if (
          request?.hash !== digest([input.text, input.language]) ||
          request.requestHash !== input.requestHash
        )
          return null;
        return parsed.data;
      });
      if (!state) return null;
      if (
        state.answer?.result &&
        ["succeeded", "unknown"].includes(state.answer.result.status)
      ) {
        // An old model reply may contain memory that has since been invalidated.
        return resultCard(state.answer.result.operationId, input.language);
      }
      // Losing a native checkpoint cannot make a recorded effect executable again.
      // Report the receipt without claiming the remaining task was completed.
      const terminal = await context.serial(async () => {
        await currentActor();
        return state.operations
          .map((id) => store.invocation(id, scope.workspaceId, scope.userId))
          .findLast(
            (receipt) =>
              receipt?.organizationId === organizationId &&
              receipt.effect === "write" &&
              ["succeeded", "unknown"].includes(receipt.status),
          );
      });
      if (!terminal) return null;
      const current = await resultCard(terminal.id, input.language);
      return {
        ...current,
        reply:
          input.language === "cs"
            ? "Předchozí běh byl přerušen. Uložený výsledek akce je na kartě; dokončení zbytku úkolu nemám potvrzené."
            : "The previous run was interrupted. The card shows the recorded action outcome; completion of the remaining task is unconfirmed.",
      };
    },
    async settleInterrupted(input) {
      const state = await context.serial(async () => {
        const raw = input.operationId
          ? store.turnForOperation(
              input.operationId,
              scope.workspaceId,
              scope.userId,
            )?.value
          : store.turn(key(input.commandId), scope.workspaceId, scope.userId);
        const parsed = DomainCommandSchema.safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.conversationId !== input.conversationId
        )
          return null;
        if (input.operationId) {
          if (!parsed.data.operations.includes(input.operationId)) return null;
          const receipt = store.invocation(
            input.operationId,
            scope.workspaceId,
            scope.userId,
          );
          if (receipt?.organizationId !== organizationId) return null;
        } else {
          const alias = parsed.data.aliases.find(
            (value) => value.commandId === input.commandId,
          );
          if (!alias || alias.requestHash !== input.requestHash) return null;
        }
        return parsed.data;
      });
      if (!state) return null;
      return withConversation(input.conversationId, () =>
        controller.withTurn(state.runId, async () => {
          const owner = await nativeCatalogOwner(controller);
          if (!(await retired(owner, state)))
            throw state.terminalCandidate
              ? new NativeRunUnsettledError()
              : new RequestInterruptionUnsettledError();
          try {
            const answer = await (state.terminalCandidate
              ? domain.finalizeFailure(state.runId)
              : domain.finalizeInterruption(state.runId));
            return input.operationId
              ? {
                  ...answer,
                  resolved: (
                    await resultCard(input.operationId, input.language)
                  ).result,
                }
              : answer;
          } catch (error) {
            throw new NativeRunRetiredPublicationError(error);
          }
        }),
      );
    },
    async message(
      commandId,
      text,
      language,
      history,
      signal,
      reportTool,
      reportWorkflow,
      timeZone,
      messageContext,
    ) {
      const lock = await context.serial(async () => {
        await currentActor();
        const cached = DomainCommandSchema.safeParse(
          store.turn(key(commandId), scope.workspaceId, scope.userId),
        );
        if (cached.success) return cached.data.runId;
        if (messageContext?.task) return messageContext.task.workItemId;
        const latest = DomainCommandSchema.safeParse(
          store.latestTurn(
            scope.workspaceId,
            scope.userId,
            messageContext?.conversationId,
            scope.serverId,
            messageContext?.conversationSession,
          )?.value,
        );
        return messageContext?.session !== "new" &&
          latest.success &&
          latest.data.pending?.kind === "question" &&
          latest.data.conversationId === messageContext?.conversationId
          ? latest.data.runId
          : key(commandId);
      });
      return withConversation(messageContext?.conversationId, () =>
        controller.withTurn(lock, async () => {
          const options = {
            signal,
            reportTool,
            progress:
              reportWorkflow &&
              ((
                stage: "service" | "action" | "inputs" | "execute",
                step: number,
              ) => reportWorkflow({ stage, step: Math.min(5, step) })),
          };
          try {
            if (messageContext?.retryOf) {
              if (
                messageContext.session === "new" ||
                !messageContext.logicalMessageId
              )
                throw new IdentityError(409, "catalog_conflict");
              const parent = await domain.retryParent(
                messageContext.retryOf,
                messageContext.logicalMessageId,
                text,
                language,
                messageContext,
                commandId,
              );
              const owner = await nativeCatalogOwner(controller);
              if (!(await retired(owner, parent)))
                throw new NativeRunUnsettledError();
            }
            const continuation = messageContext?.retryOf
              ? null
              : await domain.continuation(
                  commandId,
                  text,
                  language,
                  history,
                  timeZone,
                  messageContext,
                  options,
                );
            if (continuation) {
              const answer = await recorded(continuation.session);
              if (answer) return answer;
              if (continuation.session.state.terminalCandidate) {
                const owner = await nativeCatalogOwner(controller);
                if (!(await retired(owner, continuation.session.state)))
                  throw new NativeRunUnsettledError();
                await continuation.session.finishFailure();
                return (await recorded(continuation.session))!;
              }
              return execute(continuation.session, signal, undefined, {
                toolCallId: continuation.toolCallId,
                data: { answer: text },
              });
            }
            const session = await domain.begin(
              commandId,
              text,
              language,
              history,
              timeZone,
              messageContext,
              options,
            );
            const prior = await recorded(session);
            if (prior) return prior;
            if (session.state.terminalCandidate) {
              const owner = await nativeCatalogOwner(controller);
              if (!(await retired(owner, session.state)))
                throw new NativeRunUnsettledError();
              await session.finishFailure();
              return (await recorded(session))!;
            }
            return execute(session, signal, text);
          } catch (error) {
            if (signal.reason !== REQUEST_INTERRUPTION_REASON) throw error;
            // Preparation may dispatch continuity inference before a native
            // worker exists. Its rejected transport is settled at this point.
            // Load/create the exact command turn without another continuity test.
            const stopped = await domain.begin(
              commandId,
              text,
              language,
              history,
              timeZone,
              { ...messageContext, session: "new" },
              { ...options, signal: undefined },
            );
            const owner = await nativeCatalogOwner(controller);
            if (stopped.state.terminalCandidate) {
              if (!(await retired(owner, stopped.state)))
                throw new NativeRunUnsettledError();
              return domain.finalizeFailure(stopped.state.runId);
            }
            if (!owner.isSettled(stopped.state.runId))
              throw new RequestInterruptionUnsettledError();
            return stopped.finishInterrupted();
          }
        }),
      );
    },
    async resolve(
      operationId,
      approved,
      language,
      signal,
      reportTool,
      reportWorkflow,
      binding,
      commandBinding,
    ) {
      const linked = await context.serial(async () => {
        await currentActor();
        return store.turnForOperation(
          operationId,
          scope.workspaceId,
          scope.userId,
        );
      });
      if (!linked) throw new IdentityError(404, "catalog_not_found");
      const saved = DomainCommandSchema.parse(linked.value);
      if (saved.runId !== key(saved.aliases[0]!.commandId))
        throw new IdentityError(404, "catalog_not_found");
      const exactAlias =
        commandBinding &&
        saved.aliases.find(
          (alias) => alias.commandId === commandBinding.commandId,
        );
      if (
        exactAlias &&
        (exactAlias.requestHash !== commandBinding!.requestHash ||
          saved.conversationId !== commandBinding!.conversationId)
      )
        throw new IdentityError(409, "idempotency_conflict");
      if (exactAlias && saved.terminalCandidate) {
        return withConversation(saved.conversationId, () =>
          controller.withTurn(saved.runId, async () => {
            const owner = await nativeCatalogOwner(controller);
            if (!(await retired(owner, saved)))
              throw new NativeRunUnsettledError();
            const answer = await domain.finalizeFailure(saved.runId);
            return {
              ...answer,
              resolved: (await resultCard(operationId, language)).result,
            };
          }),
        );
      }
      if (
        binding &&
        (binding.workItemId !== saved.runId ||
          binding.expectedWorkRevision !== saved.workRevision ||
          binding.conversationId !== saved.conversationId)
      )
        throw new IdentityError(409, "catalog_conflict");
      return withConversation(saved.conversationId, () =>
        controller.withTurn(linked.id, async () => {
          const session = await domain.forOperation(operationId, language, {
            signal,
            reportTool,
            progress:
              reportWorkflow &&
              ((stage, step) =>
                reportWorkflow({ stage, step: Math.min(5, step) })),
          });
          if (
            binding &&
            (binding.workItemId !== session.state.runId ||
              binding.expectedWorkRevision !== session.state.workRevision ||
              binding.conversationId !== session.state.conversationId)
          )
            throw new IdentityError(409, "catalog_conflict");
          const receipt = await context.serial(async () => {
            await currentActor();
            return store.invocation(
              operationId,
              scope.workspaceId,
              scope.userId,
            );
          });
          if (!receipt) throw new IdentityError(404, "catalog_not_found");
          if (receipt.status !== "awaiting_approval")
            return resultCard(operationId, language);
          const pending = session.state.pending;
          if (commandBinding) {
            if (session.state.conversationId !== commandBinding.conversationId)
              throw new IdentityError(409, "catalog_conflict");
            // Housekeeping cap on distinct commands answering one approval.
            if (session.state.aliases.length >= 32)
              throw new IdentityError(429, "catalog_retry_limit");
            if (
              !session.state.aliases.some(
                (alias) => alias.commandId === commandBinding.commandId,
              )
            ) {
              session.state.aliases.push({
                commandId: commandBinding.commandId,
                outerCommandId: commandBinding.outerCommandId,
                requestHash: commandBinding.requestHash,
                hash: digest([
                  "service.resolve",
                  operationId,
                  approved,
                  language,
                ]),
              });
              await session.save();
            }
          }
          try {
            await session.resolve(operationId, approved, signal);
          } catch (error) {
            // Approval dispatch can end before execute(session) is entered.
            // Its settled adapter receipts still need a durable chat outcome.
            if (signal.reason !== REQUEST_INTERRUPTION_REASON) throw error;
            const runtime = await nativeCatalogOwner(controller);
            if (!runtime.isSettled(session.state.runId))
              throw new RequestInterruptionUnsettledError();
            return session.finishInterrupted();
          }
          const resolved = await resultCard(operationId, language);
          if (
            pending?.kind !== "approval" ||
            pending.operationId !== operationId
          )
            return resolved;
          const next = await execute(session, signal, undefined, {
            toolCallId: pending.toolCallId,
            data: { resolved: true },
          });
          return {
            ...next,
            ...(resolved.result ? { resolved: resolved.result } : {}),
          };
        }),
      );
    },
  };
}
