import { randomUUID } from "node:crypto";
import { CommandSchema, type WorkItem } from "../../packages/protocol";
import type { FixtureStorage } from "../fixture-server/storage";
import type { ModelService } from "../fixture-server/model-service";
import type { MobileRuntime } from "../server-identity/mobile";
import { IdentityError } from "../server-identity/error";
import { ModelError } from "../fixture-server/decision";
import { REQUEST_INTERRUPTION_REASON } from "../server-identity/mastra-runtime";
import type {
  McpAccessScope,
  McpPrincipal,
} from "../server-identity/mcp-access";
import { McpAdmissionStore, type McpAdmission } from "./admission";
import {
  McpTaskError,
  type McpTaskHandlers,
  type McpTaskSubmitInput,
  type McpTaskGetInput,
  type McpTaskRespondInput,
  type McpTaskCancelInput,
} from "./transport";

type Dependencies = {
  store: McpAdmissionStore;
  run<T>(fn: () => T): Promise<T>;
  access(
    grantId: string,
    serverId: string,
    scopes: McpAccessScope[],
    workspaceId?: string,
    credentialKind?: "mcp" | "browser",
    memberId?: string,
  ): Promise<MobileRuntime>;
  attach?(runner: McpTasks): void;
};
const actorFor = (task: McpAdmission) => ({
  grantId: task.grantId,
  userId: task.scope.userId,
  serverId: task.scope.serverId,
  workspaceId: task.scope.workspaceId,
});
/** Durable delivery into the existing command owner; never a planning loop. */
export class McpTasks implements McpTaskHandlers<McpPrincipal> {
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void>; scopeKey: string }
  >();
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private dependencies: Dependencies,
    private storage: FixtureStorage,
    private models: ModelService,
    private approvalUrl: (task: McpAdmission) => string,
  ) {
    dependencies.attach?.(this);
    this.timer = setInterval(() => {
      void this.deliver().catch(() => {});
    }, 500);
    this.timer.unref();
  }
  private access(
    actor: Pick<McpPrincipal, "grantId" | "serverId">,
    execute = false,
  ) {
    if (this.closed) throw new IdentityError(503, "mcp_unavailable");
    return this.dependencies.access(
      actor.grantId,
      actor.serverId,
      execute ? ["native.view", "native.run"] : ["native.view"],
    );
  }
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof IdentityError || error instanceof ModelError)
        throw new McpTaskError(error.code, explanation(error.code));
      throw error;
    }
  }
  submit(actor: McpPrincipal, input: McpTaskSubmitInput) {
    return this.guarded(async () => {
      const access = await this.access(actor, true);
      const task = await access.run(() =>
        this.dependencies.store.submit(actor, input),
      );
      this.launch(task);
      return this.view(actor, task);
    });
  }
  get(actor: McpPrincipal, input: McpTaskGetInput) {
    return this.guarded(async () => {
      const access = await this.access(actor);
      const task = await access.run(() =>
        this.dependencies.store.read(actor, input.taskId),
      );
      const active = this.active.get(task.id);
      if (active && input.waitMs) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            active.promise,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, input.waitMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      return this.view(
        actor,
        await access.run(() => this.dependencies.store.read(actor, task.id)),
      );
    });
  }
  respond(actor: McpPrincipal, input: McpTaskRespondInput) {
    return this.guarded(async () => {
      const access = await this.access(actor, true);
      const request = { tool: "task_respond", ...input };
      const prior = await access.run(() =>
        this.dependencies.store.replay(actor, input.requestId, request),
      );
      if (prior) return this.view(actor, prior);
      const task = await access.run(() =>
        this.dependencies.store.read(actor, input.taskId),
      );
      const work = await this.readNative(access, task);
      const question = work?.native?.question;
      if (
        !question ||
        work?.status !== "waiting_input" ||
        question.id !== input.inputId ||
        question.revision !== input.expectedRevision ||
        question.workItemId !== task.workItemId ||
        task.cancelRequested
      )
        throw new IdentityError(409, "mcp_input_changed");
      const commandId = `mcp-${randomUUID()}`;
      const command = CommandSchema.parse({
        type: "message.send",
        commandId,
        idempotencyKey: commandId,
        conversationId: task.conversationId,
        text: input.text,
        language: task.command.language,
        ...(task.command.type === "message.send" && task.command.timeZone
          ? { timeZone: task.command.timeZone }
          : {}),
        context: {
          runtime: "mastra",
          workItemId: task.workItemId,
          inputRequestId: question.id,
          expectedInputRevision: question.revision,
        },
      }) as McpAdmission["command"];
      const next = await access.run(() =>
        this.dependencies.store.respond(actor, input, command),
      );
      this.launch(next);
      return this.view(actor, next);
    });
  }
  cancel(actor: McpPrincipal, input: McpTaskCancelInput) {
    return this.guarded(async () => {
      const access = await this.access(actor, true);
      const task = await access.run(() =>
        this.dependencies.store.cancel(actor, input),
      );
      const active = this.active.get(task.id);
      if (active) {
        active.controller.abort(REQUEST_INTERRUPTION_REASON);
        // The canonical interruption path retires the native owner and retains receipts.
        await this.models.interrupt(
          task.scope,
          task.command,
          (fn) => access.run(fn),
          access.nativeRequests,
        );
      } else if (task.phase === "settled") {
        const work = await this.readNative(access, task);
        if (
          work &&
          (work.cancellationPending ||
            ["waiting_input", "waiting_approval"].includes(work.status))
        ) {
          if (!access.integrations?.cancelTask)
            throw new IdentityError(503, "mcp_cancellation_unavailable");
          await access.integrations.cancelTask({
            workItemId: task.workItemId,
            expectedWorkRevision: work.native!.revision,
            conversationId: task.conversationId,
          });
        }
      } else {
        this.launch(task);
      }
      // Persisted cancellation is reconciled again even if a delivery promise
      // crossed into suspension before the interruption reached its tracker.
      this.launch(
        await access.run(() => this.dependencies.store.read(actor, task.id)),
      );
      return this.view(
        actor,
        await access.run(() => this.dependencies.store.read(actor, task.id)),
      );
    });
  }
  private async readNative(
    access: MobileRuntime,
    task: McpAdmission,
  ): Promise<
    | (WorkItem & { cancellationSettled?: true; cancellationPending?: true })
    | null
  > {
    return (await access.integrations?.readTask?.(task.rootCommandId)) ?? null;
  }
  private async view(
    actor: Pick<
      McpPrincipal,
      "grantId" | "serverId" | "workspaceId" | "userId"
    >,
    task: McpAdmission,
    suppliedAccess?: MobileRuntime,
  ): Promise<Record<string, unknown>> {
    const access = suppliedAccess ?? (await this.access(actor));
    const current = await access.run(() =>
      this.dependencies.store.read(actor, task.id),
    );
    const work = await this.readNative(access, current);
    await access.run(() => {});
    const unknown = work?.native?.action?.status === "unknown";
    const delivering =
      current.phase !== "settled" && this.active.has(current.id);
    const cancelling =
      current.cancelRequested &&
      !current.cancellationSettled &&
      !["succeeded", "failed", "cancelled", "expired", "superseded"].includes(
        work?.status ?? "",
      );
    const status = unknown
      ? "unknown"
      : cancelling
        ? "waiting_system"
        : delivering
          ? "running"
          : (work?.status ??
            (current.phase === "queued"
              ? "queued"
              : current.phase === "running"
                ? "running"
                : current.errorCode
                  ? "failed"
                  : current.cancelRequested
                    ? "cancelled"
                    : "waiting_system"));
    const available = !["expired", "superseded"].includes(status);
    const base = {
      taskId: current.id,
      conversationId: current.conversationId,
      revision: Math.max(current.revision, work?.revision ?? 0),
      status,
      ...(current.cancelRequested ? { cancellationRequested: true } : {}),
    };
    const text = available ? (work?.result ?? work?.context) : undefined;
    const reply =
      ["waiting_system", "unknown"].includes(status) && !work?.result
        ? explanation(
            status === "unknown" ? status : (current.errorCode ?? status),
          )
        : text || explanation(current.errorCode ?? status);
    return {
      ...base,
      reply: current.cancellationBlocked
        ? "Cancellation is retained, but its authorization is no longer valid. Reconnect with a current MCP grant and send a new task_cancel requestId to verify closure. No action has been retried."
        : cancelling
          ? "Cancellation was requested. The server is checking that the task stopped; previously completed or unconfirmed actions remain recorded."
          : reply,
      ...(available && work?.native?.action
        ? { result: work.native.action }
        : {}),
      ...(status === "waiting_input" &&
      work?.native?.question &&
      !current.cancelRequested
        ? {
            nextInput: {
              kind: "question",
              inputId: work.native.question.id,
              expectedRevision: work.native.question.revision,
              question: work.native.question.question,
            },
          }
        : {}),
      ...(status === "waiting_approval" && !current.cancelRequested
        ? {
            nextInput: {
              kind: "human_approval",
              url: this.approvalUrl(current),
              operationId: work?.native?.action?.operationId,
              expectedRevision: work?.native?.revision,
              message:
                "Open Niaro and review this action. Only a person can approve it; task_respond cannot approve actions.",
            },
          }
        : {}),
      ...(current.errorCode &&
      (!work ||
        current.cancellationBlocked ||
        ["waiting_system", "failed"].includes(status))
        ? {
            error: {
              code: current.errorCode,
              message: explanation(current.errorCode),
            },
          }
        : {}),
    };
  }
  async humanGet(
    actor: Pick<
      McpPrincipal,
      "grantId" | "serverId" | "workspaceId" | "userId"
    >,
    access: MobileRuntime,
    taskId: string,
  ) {
    const task = await access.run(() =>
      this.dependencies.store.read(actor, taskId),
    );
    return this.view(actor, task, access);
  }
  async humanDecide(
    actor: Pick<
      McpPrincipal,
      "grantId" | "serverId" | "workspaceId" | "userId"
    >,
    access: MobileRuntime,
    input: {
      taskId: string;
      requestId: string;
      input: { operationId: string; expectedRevision: number };
      approved: boolean;
    },
  ) {
    const prior = await access.run(() =>
      this.dependencies.store.replay(actor, input.requestId, {
        tool: "human_decision",
        ...input,
      }),
    );
    if (prior) return this.view(actor, prior, access);
    const task = await access.run(() =>
      this.dependencies.store.read(actor, input.taskId),
    );
    const work = await this.readNative(access, task);
    if (
      !work ||
      work.status !== "waiting_approval" ||
      work.native?.action?.operationId !== input.input.operationId ||
      work.native.revision !== input.input.expectedRevision ||
      task.cancelRequested
    )
      throw new IdentityError(409, "mcp_approval_changed");
    const window = await access.integrations!.taskWindow!((id) =>
      this.storage.legacyQuestionProof(task.scope, id),
    );
    const projected = await access.run(() => {
      if (!window.validate())
        throw new IdentityError(409, "mcp_approval_changed");
      this.storage.syncNativeWork(task.scope, window.items, true);
      return this.storage
        .snapshot(task.scope, task.conversationId)
        .workItems.find((item) => item.id === task.workItemId);
    });
    if (
      !projected?.native ||
      projected.native.revision !== input.input.expectedRevision
    )
      throw new IdentityError(409, "mcp_approval_changed");
    const commandId = `mcp-human-${randomUUID()}`;
    const command = CommandSchema.parse({
      type: "service.resolve",
      commandId,
      idempotencyKey: commandId,
      conversationId: task.conversationId,
      operationId: input.input.operationId,
      approved: input.approved,
      workItemId: task.workItemId,
      expectedWorkRevision: projected.revision,
      language: task.command.language,
    }) as McpAdmission["command"];
    const next = await access.run(() =>
      this.dependencies.store.humanDecision(actor, input, command),
    );
    this.launch(next);
    return this.view(actor, next, access);
  }
  private launch(task: McpAdmission) {
    if (
      this.closed ||
      this.active.has(task.id) ||
      (task.phase === "settled" &&
        (!task.cancelRequested ||
          task.cancellationSettled ||
          task.cancellationBlocked))
    )
      return;
    const scopeKey = JSON.stringify(task.scope);
    if (
      this.active.size >= 2 ||
      Array.from(this.active.values()).some(
        (request) => request.scopeKey === scopeKey,
      )
    )
      return;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.execute(task, controller))
      .catch(() => {})
      .finally(() => {
        if (this.active.get(task.id)?.controller === controller)
          this.active.delete(task.id);
      });
    this.active.set(task.id, { controller, promise, scopeKey });
  }
  private async deliver() {
    if (this.closed) return;
    const tasks = await this.dependencies.run(() =>
      this.dependencies.store.pending(),
    );
    for (const task of tasks) this.launch(task);
  }
  private async execute(saved: McpAdmission, controller: AbortController) {
    let access: MobileRuntime | undefined;
    let task = saved;
    const executionCredential = {
      grantId: saved.grantId,
      kind: saved.credentialKind ?? "mcp",
      memberId: saved.credentialMemberId,
    };
    try {
      access =
        task.credentialKind === "browser"
          ? await this.dependencies.access(
              task.grantId,
              task.scope.serverId,
              ["native.view", "native.run"],
              task.scope.workspaceId,
              "browser",
              task.credentialMemberId,
            )
          : await this.access(actorFor(task), true);
      task = await access.run(() =>
        this.dependencies.store.read(actorFor(task), task.id),
      );
      if (
        task.phase === "settled" &&
        (!task.cancelRequested ||
          task.cancellationSettled ||
          task.cancellationBlocked)
      )
        return;
      if (task.cancelRequested && !task.cancellationSettled) {
        let work = await this.readNative(access, task);
        if (
          work &&
          (work.cancellationPending ||
            ["waiting_input", "waiting_approval"].includes(work.status))
        ) {
          if (!access.integrations?.cancelTask)
            throw new IdentityError(503, "mcp_cancellation_unavailable");
          await access.integrations.cancelTask({
            workItemId: task.workItemId,
            expectedWorkRevision: work.native!.revision,
            conversationId: task.conversationId,
          });
          work = await this.readNative(access, task);
        }
        if (
          (work?.status === "waiting_system" && !work.cancellationSettled) ||
          (!work && (await access.integrations?.hasTurn(task.rootCommandId)))
        )
          throw new IdentityError(503, "mcp_cancellation_unconfirmed");
        await access.run(() =>
          this.dependencies.store.save({
            ...task,
            phase: "settled",
            cancellationSettled: true,
            revision: task.revision + 1,
          }),
        );
        return;
      }
      if (!access.integrations?.enabled)
        throw new IdentityError(409, "mcp_native_agent_unavailable");
      const createId = `mcp-create-${task.id}`;
      const created = await access.run(() =>
        this.storage.execute(task.scope, {
          type: "conversation.create",
          commandId: createId,
          idempotencyKey: createId,
          conversationId: task.conversationId,
        }),
      );
      if (created.status !== "accepted")
        throw new IdentityError(409, "mcp_conversation_unavailable");
      task = await access.run(() => {
        const current = this.dependencies.store.read(actorFor(task), task.id);
        const running: McpAdmission = {
          ...current,
          phase: "running",
          revision: current.revision + 1,
        };
        this.dependencies.store.save(running);
        return running;
      });
      if (task.cancelRequested) controller.abort(REQUEST_INTERRUPTION_REASON);
      const result = await this.models.execute(
        task.scope,
        task.command,
        () => access!.run(() => {}),
        controller.signal,
        access,
        access.model,
      );
      if (this.closed) return;
      await access.run(() => {
        const current = this.dependencies.store.read(actorFor(task), task.id);
        this.dependencies.store.save({
          ...current,
          phase: "settled",
          revision: current.revision + 1,
          ...(result.status !== "accepted" ? { errorCode: result.code } : {}),
        });
      });
    } catch (error) {
      if (this.closed) return;
      const code =
        error instanceof IdentityError || error instanceof ModelError
          ? error.code
          : "mcp_execution_unconfirmed";
      if (
        code === "model_busy" &&
        access &&
        !(await access.integrations?.hasTurn(task.command.idempotencyKey))
      ) {
        await access.run(() => {
          const current = this.dependencies.store.read(actorFor(task), task.id);
          this.dependencies.store.save({
            ...current,
            phase: "queued",
            errorCode: undefined,
            revision: current.revision + 1,
          });
        });
        return;
      }
      // No automatic new run or write retry on an unconfirmed result.
      await this.dependencies
        .run(() => {
          const current = this.dependencies.store.read(actorFor(task), task.id);
          this.dependencies.store.save({
            ...current,
            phase: "settled",
            errorCode: code,
            ...(current.cancelRequested &&
            current.grantId === executionCredential.grantId &&
            (current.credentialKind ?? "mcp") === executionCredential.kind &&
            current.credentialMemberId === executionCredential.memberId &&
            error instanceof IdentityError &&
            [401, 403].includes(error.status)
              ? { cancellationBlocked: true }
              : {}),
            revision: current.revision + 1,
          });
        })
        .catch(() => {});
    }
  }
  stop() {
    this.closed = true;
    clearInterval(this.timer);
    for (const request of this.active.values())
      request.controller.abort(REQUEST_INTERRUPTION_REASON);
  }
  async close() {
    this.stop();
    await Promise.allSettled(
      Array.from(this.active.values(), (request) => request.promise),
    );
  }
}

function explanation(code: string) {
  const messages: Record<string, string> = {
    queued:
      "The server accepted this task. Use task_get to receive its status or result.",
    running: "The server is working on this task. Use task_get to check again.",
    waiting_system:
      "The task is retained, but its completion is not confirmed. No action has been retried.",
    cancelled:
      "Further work on this task was cancelled. Previously completed actions remain recorded.",
    expired:
      "This task's context has expired. Submit a new task instead of answering the old question.",
    superseded:
      "The task's permissions or context changed. Submit a new task with current information.",
    unknown:
      "An action's outcome is unconfirmed. Do not repeat it until a person checks the service.",
    mcp_input_changed:
      "The requested input is no longer current. Read task_get for the latest question.",
    mcp_task_changed:
      "Another reply or cancellation changed this task. Read its latest status.",
    mcp_idempotency_conflict:
      "This requestId was already used for different input. Reuse it only for an identical request.",
    mcp_task_not_found:
      "This task is unavailable in your current account and workspace.",
    mcp_native_agent_unavailable:
      "The server agent has no active native model. Configure a model in Niaro before submitting tasks.",
    mcp_execution_unconfirmed:
      "The task could not finish with a confirmed result. Its recorded actions have not been repeated.",
    model_busy:
      "The server is handling another command. This task was not completed; check existing work before submitting a new request.",
  };
  return (
    messages[code] ??
    `The task could not complete (${code}). Review it in Niaro before retrying.`
  );
}
