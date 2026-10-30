import { createHash } from "node:crypto";
import type {
  AnswerStreamEvent,
  AnswerStreamListener,
  AnswerStreamApproval,
  AnswerStreamStep,
} from "../../packages/protocol/answer-stream";
import {
  CommandSchema,
  CrmContactResultSchema,
  type CrmContactResult,
  type Conversation,
  type Scope,
  type Command,
  type CommandResult,
  type WorkItem,
} from "../../packages/protocol";
import {
  REQUEST_INTERRUPTION_PROFILE,
  type RequestInterruptionResponse,
} from "../../packages/protocol/request-interruption";
import {
  REQUEST_INTERRUPTION_REASON,
  NativeRunUnsettledError,
  NativeRunRetiredPublicationError,
} from "../server-identity/mastra-runtime";
import { type DecisionRouter, DecisionSchema, ModelError } from "./decision";
import type { FixtureStorage } from "./storage";
import { isOpenWork } from "./engine";
import {
  emptyMeeting,
  mergeMeeting,
  startsNewMeeting,
} from "./conversation-memory";
import {
  createContactTools,
  ContactLookupSchema,
  type ContactLookup,
  type ContactDirectory,
} from "../server-tools/contacts";
import type { ToolContext, ToolRegistry } from "../server-tools/registry";
import {
  ACTIVITY_DRAFT_MAX,
  type RequestActivity,
  type ActivityTool,
  type ActivityWorkflow,
} from "../../packages/protocol/activity";
import { IdentityError } from "../server-identity/error";
import { isInferenceBudgetFailureCode } from "../server-identity/inference-budget-failure";
import { IntegrationError } from "../server-integrations/transport";
import type { MobileRuntime } from "../server-identity/mobile";
import type {
  CatalogRuntime,
  ServiceAnswer,
} from "../server-identity/catalog-runtime";
import { operatorLog } from "./operator-log";
import { en, translate, type TranslationKey } from "../../packages/i18n";
import {
  MAX_ACTIVE_RUNS,
  NativeCommandRequests,
  personLane,
  type NativeTrackedRequest,
} from "../server-identity/native-command-requests";

/** Chat directory changes and cancellations: never a turn of the chat they name. */
const DIRECTORY_COMMANDS = new Set<Command["type"]>([
  "conversation.rename",
  "conversation.delete",
  "conversation.archive",
  "conversation.restore",
  "work.cancel",
]);
function historyText(message: Conversation["messages"][number]) {
  if (message.attachments?.length || message.processing)
    return "An attachment message was accepted for retention; its file evidence is unavailable for interpretation.";
  // Source text and record names are display data, not previous assistant
  // instructions or evidence of authorization. Preserve only server-owned facts.
  if (message.result?.type === "service.action")
    return `Service action: ${message.result.effect}; status: ${message.result.status}. Structured result is displayed in the chat card.`;
  if (message.result?.type === "crm.contacts")
    return `Contact lookup returned ${message.result.contacts.length} displayed contacts.`;
  return message.text;
}
/** What cancelling open work needs from the authenticated runtime. */
type WorkAccess = Partial<
  Pick<MobileRuntime, "integrations" | "cancelProcessRun">
>;
type InFlightRequest = NativeTrackedRequest & {
  profile: "workflow";
  command: Command;
  controller: AbortController;
  promise: Promise<CommandResult>;
  nativeStarted: boolean;
  unsettled: boolean;
  activeKey?: string;
  settleInterrupted?: () => Promise<CommandResult | undefined>;
  finalizing?: Promise<CommandResult | undefined>;
};

/** No SQLite transaction is held over inference. Commit validates the captured cursor again. */
export class ModelService {
  private tools: ToolRegistry;
  private requestTracker = new NativeCommandRequests();
  private get active() {
    return this.requestTracker.activeScopes;
  }
  private activities = new Map<
    string,
    { value: RequestActivity; updatedAt: number }
  >();
  /** Streams open on a command; each gets the draft and the tool steps as they happen. */
  private listeners = new Map<string, Set<AnswerStreamListener>>();
  constructor(
    private storage: FixtureStorage,
    private router: DecisionRouter | undefined,
    private now = () => Date.now(),
    crm?: ContactDirectory,
  ) {
    this.tools = createContactTools(crm);
  }
  /** Passive recovery/publication only; neither dispatches nor resumes native work. */
  async publishAttachmentResult(
    scope: Scope,
    attemptId: string,
    token: string,
    access: MobileRuntime,
  ) {
    const a = await access.run(() =>
      this.storage.attachments.publication(scope, attemptId, token),
    );
    if (a.published)
      return access.run(() =>
        this.storage.snapshot(scope, a.command.conversationId),
      );
    const outcome = await access.integrations?.readAttachmentOutcome?.(a.input);
    if (outcome?.status !== "recorded")
      throw new IdentityError(409, "attachment_retry_required");
    const window = await access.integrations?.taskWindow?.((id) =>
      this.storage.legacyQuestionProof(scope, id),
    );
    if (!window) throw new IdentityError(409, "catalog_conflict");
    return access.run(() => {
      if (!window.validate()) throw new IdentityError(409, "catalog_conflict");
      const result = outcome.result;
      return this.storage.publishAttachmentResult(scope, attemptId, token, {
        decision: {
          kind: "reply",
          contactId: null,
          title: null,
          localStart: null,
          durationMinutes: null,
          reply: result.reply.slice(0, 800),
        },
        expectedCursor: 0,
        timeZone: "UTC",
        nativeWork: window.items,
        nativeWorkAuthoritative: true,
        nativeReply: result.reply.slice(0, 2000),
        workItemId: result.workItemId,
        serviceResult: result.result,
        connectionResult: result.connection,
        ui: result.ui,
        processOffer: result.processOffer,
        skillProposal: result.skillProposal,
        processProposal: result.processProposal,
        resolvedServiceResult: result.resolved,
      });
    });
  }
  describeTools() {
    return this.tools.describe();
  }
  activity(scope: Scope, commandId: string) {
    this.pruneActivities();
    return (
      this.activities.get(JSON.stringify([scope, commandId]))?.value ?? null
    );
  }
  /**
   * Follows a command's run while it is open: the answer's draft and each
   * tool step. Transient like the activity; nothing here is stored. The
   * returned function stops following.
   */
  subscribe(scope: Scope, commandId: string, listener: AnswerStreamListener) {
    const key = JSON.stringify([scope, commandId]);
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(key);
    };
  }
  private notify(key: string, event: AnswerStreamEvent) {
    for (const listener of this.listeners.get(key) ?? [])
      try {
        listener(event);
      } catch {
        // A listener never affects the run.
      }
  }
  private pruneActivities() {
    for (const [key, entry] of this.activities) {
      if (
        entry.value.status !== "running" &&
        (this.now() - entry.updatedAt > 300_000 || this.activities.size > 100)
      )
        this.activities.delete(key);
    }
  }
  private startActivity(
    scope: Scope,
    command: { commandId: string; conversationId: string },
  ) {
    this.pruneActivities();
    const activityKey = JSON.stringify([scope, command.commandId]);
    let activity: RequestActivity = {
      commandId: command.commandId,
      conversationId: command.conversationId,
      status: "running",
      steps: [
        { id: "understanding", status: "running" },
        { id: "preparing", status: "pending" },
      ],
    };
    const publish = () =>
      this.activities.set(activityKey, {
        value: activity,
        updatedAt: this.now(),
      });
    const advance = (stage: "crm" | "preparing") => {
      const ids: RequestActivity["steps"][number]["id"][] =
        stage === "crm" || activity.steps.some((step) => step.id === "crm")
          ? ["understanding", "crm", "preparing"]
          : ["understanding", "preparing"];
      const current = ids.indexOf(stage);
      activity = {
        ...activity,
        steps: ids.map((id, index) => ({
          id,
          status:
            index < current
              ? "succeeded"
              : index === current
                ? "running"
                : "pending",
        })),
      };
      publish();
    };
    publish();
    let closed = false;
    return {
      advance: (stage: "crm" | "preparing") => {
        if (!closed) advance(stage);
      },
      tool: (tool: ActivityTool) => {
        if (closed) return;
        activity = { ...activity, tools: [tool] };
        publish();
      },
      workflow: (workflow: ActivityWorkflow) => {
        if (closed) return;
        activity = { ...activity, workflow };
        publish();
      },
      /** The answer while it is written; the stored message replaces it. */
      draft: (draft: string | null) => {
        if (closed) return;
        const { draft: _previous, ...rest } = activity;
        activity = draft
          ? { ...rest, draft: draft.slice(0, ACTIVITY_DRAFT_MAX) }
          : rest;
        publish();
        this.notify(activityKey, {
          type: "draft",
          draft: activity.draft ?? null,
        });
      },
      /** A tool step of the run, for open streams only. */
      step: (step: AnswerStreamStep) => {
        if (closed) return;
        this.notify(activityKey, { type: "step", step });
      },
      /** A write waiting for the person's decision, for open streams only. */
      approval: (approval: AnswerStreamApproval) => {
        if (closed) return;
        this.notify(activityKey, { type: "approval", approval });
      },
      finish: (status: "succeeded" | "failed") => {
        if (closed) return;
        // Only an executor's completion notification can mark a tool successful.
        if (activity.tools?.some((tool) => tool.status === "running"))
          status = "failed";
        const { draft: _draft, ...current } = activity;
        activity = {
          ...current,
          status,
          steps: activity.steps.map((step) =>
            step.status === "running" ? { ...step, status } : step,
          ),
          ...(activity.tools
            ? {
                tools: activity.tools.map((tool) =>
                  tool.status === "running" ? { ...tool, status } : tool,
                ),
              }
            : {}),
        };
        publish();
        closed = true;
      },
    };
  }
  async execute(
    scope: Scope,
    raw: unknown,
    validateSession: () => void | Promise<void>,
    signal: AbortSignal,
    access?: Pick<MobileRuntime, "tools" | "run"> &
      Partial<
        Pick<
          MobileRuntime,
          | "runModel"
          | "integrations"
          | "nativeRequests"
          | "retireProcessRequest"
          | "cancelProcessRun"
        >
      >,
    routerOverride?: DecisionRouter,
  ): Promise<CommandResult> {
    const command = CommandSchema.parse(raw);
    if (access?.nativeRequests) this.requestTracker = access.nativeRequests;
    const existing = this.requestTracker.find<InFlightRequest>(
      scope,
      command,
      "workflow",
    );
    if (existing) {
      return Promise.resolve().then(async () => {
        await validateSession();
        if (JSON.stringify(existing.command) !== JSON.stringify(command))
          throw new IdentityError(409, "idempotency_conflict");
        let result: CommandResult;
        try {
          result = await existing.promise;
        } catch (error) {
          if (!existing.unsettled) throw error;
          const finalized = await this.settleRequest(scope, existing);
          if (!finalized) throw error;
          result = finalized;
        }
        await validateSession();
        return result;
      });
    }
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const entry: InFlightRequest = {
      scope,
      profile: "workflow",
      command,
      controller,
      nativeStarted: false,
      unsettled: false,
      promise: undefined as unknown as Promise<CommandResult>,
    };
    if (access?.integrations?.proveRetired)
      entry.retire = () =>
        access.integrations!.proveRetired!({
          commandId: command.idempotencyKey,
          requestHash: createHash("sha256")
            .update(JSON.stringify(command))
            .digest("hex"),
          conversationId:
            "conversationId" in command ? command.conversationId : "",
        });
    // Registration precedes inference, replay reads and every asynchronous step.
    this.requestTracker.register(entry);
    entry.promise = Promise.resolve()
      .then(() =>
        this.executeInternal(
          scope,
          command,
          validateSession,
          combined,
          access,
          routerOverride,
          entry,
        ),
      )
      .catch(async (error) => {
        if (
          combined.reason !== REQUEST_INTERRUPTION_REASON ||
          entry.nativeStarted ||
          command.type !== "message.send"
        )
          throw error;
        await validateSession();
        const recorded = access
          ? await access.run(() => this.storage.replay(scope, command))
          : this.storage.replay(scope, command);
        if (recorded) return recorded;
        const requestHash = createHash("sha256")
          .update(JSON.stringify(command))
          .digest("hex");
        if (
          access?.integrations?.ensureSettled &&
          !(await access.integrations.ensureSettled({
            commandId: command.idempotencyKey,
            outerCommandId: command.commandId,
            requestHash,
          }))
        )
          throw new ModelError("model_busy");
        await this.releaseRetiredRequests(scope, access?.integrations, entry);
        // An interrupted retry can stop before executeInternal reaches native
        // dispatch. Its durable predecessor still requires exact passive proof.
        if (
          access?.integrations &&
          (await access.integrations.hasTurn(command.idempotencyKey))
        ) {
          entry.nativeStarted = true;
          entry.unsettled = true;
          const activeKey = personLane(scope);
          if (!this.active.has(activeKey)) {
            this.requestTracker.acquireScope(activeKey, entry);
            entry.activeKey = activeKey;
          }
          entry.settleInterrupted = async () => {
            const result = await access.integrations!.settleInterrupted?.({
              commandId: command.idempotencyKey,
              requestHash,
              language: "language" in command ? command.language : "en",
              conversationId:
                "conversationId" in command ? command.conversationId : "",
            });
            if (!result) return undefined;
            try {
              const nativeWindow = await access.integrations!.taskWindow?.(
                (id) => this.storage.legacyQuestionProof(scope, id),
              );
              const nativeWork =
                nativeWindow?.items ?? (await access.integrations!.tasks?.());
              await validateSession();
              return await access.run(() => {
                if (nativeWindow && !nativeWindow.validate())
                  throw new ModelError("model_busy");
                const before = this.storage.snapshot(
                  scope,
                  command.conversationId,
                );
                const conversation = before.conversations.find(
                  (value) =>
                    "conversationId" in command &&
                    value.id === command.conversationId,
                );
                return this.storage.execute(scope, command, {
                  decision: {
                    kind: "reply",
                    contactId: null,
                    title: null,
                    localStart: null,
                    durationMinutes: null,
                    reply: result.reply.slice(0, 800),
                  },
                  expectedCursor: before.cursor,
                  timeZone: "UTC",
                  nativeWork,
                  nativeWorkAuthoritative: !!nativeWindow,
                  nativeReply: result.reply.slice(0, 2000),
                  expectedConversationRevision: conversation?.revision,
                  workItemId: result.workItemId,
                  serviceResult: result.result,
                  connectionResult: result.connection,
                  resolvedServiceResult: result.resolved,
                  ui: result.ui,
                  processOffer: result.processOffer,
                  skillProposal: result.skillProposal,
                  processProposal: result.processProposal,
                });
              });
            } catch (error) {
              throw new NativeRunRetiredPublicationError(error);
            }
          };
          const finalized = await this.settleRequest(scope, entry);
          if (finalized) return finalized;
          throw new NativeRunUnsettledError();
        }
        const commit = () => {
          const before = this.storage.snapshot(scope, command.conversationId);
          return this.storage.execute(scope, command, {
            decision: {
              kind: "reply",
              contactId: null,
              title: null,
              localStart: null,
              durationMinutes: null,
              reply: translate("language" in command ? command.language : "en")(
                "requestInterrupted",
              ),
            },
            expectedCursor: before.cursor,
            timeZone: "UTC",
          });
        };
        await validateSession();
        return access ? access.run(commit) : commit();
      })
      .finally(() => {
        if (!entry.unsettled) this.releaseRequest(scope, entry);
      });
    return entry.promise;
  }
  private releaseRequest(_scope: Scope, entry: InFlightRequest) {
    this.requestTracker.release(entry);
  }
  private async releaseRetiredRequests(
    scope: Scope,
    runtime: CatalogRuntime | undefined,
    current: InFlightRequest | undefined,
  ) {
    if (!runtime?.proveRetired) return;
    const activeKey = personLane(scope);
    for (const saved of this.requestTracker.values()) {
      if (saved.profile !== "workflow") continue;
      const held = saved as InFlightRequest;
      // Proof comes from this credential's runtime, so only its own requests.
      if (
        held === current ||
        !held.unsettled ||
        held.activeKey !== activeKey ||
        JSON.stringify(held.scope) !== JSON.stringify(scope)
      )
        continue;
      const command = held.command;
      if (
        !(await runtime.proveRetired({
          commandId: command.idempotencyKey,
          requestHash: createHash("sha256")
            .update(JSON.stringify(command))
            .digest("hex"),
          conversationId:
            "conversationId" in command ? command.conversationId : "",
        }))
      )
        continue;
      if (held.unsettled) {
        held.unsettled = false;
        this.requestTracker.releaseScope(activeKey, held);
        this.releaseRequest(scope, held);
      }
    }
  }
  private async settleRequest(scope: Scope, entry: InFlightRequest) {
    if (!entry.unsettled || !entry.settleInterrupted) return undefined;
    entry.finalizing ??= entry.settleInterrupted().finally(() => {
      entry.finalizing = undefined;
    });
    let finalized: CommandResult | undefined;
    try {
      finalized = await entry.finalizing;
    } catch (error) {
      if (error instanceof NativeRunRetiredPublicationError) {
        if (entry.unsettled) {
          entry.unsettled = false;
          if (entry.activeKey)
            this.requestTracker.releaseScope(entry.activeKey, entry);
          this.releaseRequest(scope, entry);
        }
        throw error.rejection;
      }
      throw error;
    }
    if (finalized && entry.unsettled) {
      entry.unsettled = false;
      if (entry.activeKey)
        this.requestTracker.releaseScope(entry.activeKey, entry);
      this.releaseRequest(scope, entry);
    }
    return finalized;
  }
  async interrupt(
    scope: Scope,
    raw: unknown,
    run: <T>(fn: () => T) => Promise<T>,
    tracker?: NativeCommandRequests,
  ): Promise<RequestInterruptionResponse> {
    const command = CommandSchema.parse(raw);
    if (tracker) this.requestTracker = tracker;
    const base = {
      profile: REQUEST_INTERRUPTION_PROFILE,
      scope,
      commandId: command.commandId,
    };
    // A conflicting receipt is not proof that the live request retired. Check
    // both reserved identities and their exact payload before reading replay.
    const { entry, replay } = await run(() => {
      const entry = this.requestTracker.find<InFlightRequest>(
        scope,
        command,
        "workflow",
      );
      if (entry && JSON.stringify(entry.command) !== JSON.stringify(command))
        throw new IdentityError(409, "idempotency_conflict");
      const replay = entry ? undefined : this.storage.replay(scope, command);
      if (replay?.code === "idempotency_conflict")
        throw new IdentityError(409, "idempotency_conflict");
      return { entry, replay };
    });
    if (replay) return { ...base, status: "settled", result: replay };
    if (!entry) return { ...base, status: "unknown", reason: "not_running" };
    entry.controller.abort(REQUEST_INTERRUPTION_REASON);
    try {
      await entry.promise;
    } catch {
      // Execution rejection, including an unretired native checkpoint, grants
      // no delivery certainty. Never retry the command to manufacture a result.
    }
    if (entry.unsettled && entry.settleInterrupted) {
      try {
        await this.settleRequest(scope, entry);
      } catch {
        // A new passive proof may still be unavailable, or the captured
        // authorization may be revoked. Keep the original reservation intact.
      }
    }
    const result = await run(() => {
      const result = this.storage.replay(scope, command);
      if (result?.code === "idempotency_conflict")
        throw new IdentityError(409, "idempotency_conflict");
      return result;
    });
    return result
      ? { ...base, status: "settled", result }
      : { ...base, status: "unknown", reason: "not_settled" };
  }
  /** A request of this person still answers in the chat, or still runs one
   * of the named process runs. Directory changes and cancellations don't count. */
  private answering(
    scope: Scope,
    conversationId: string,
    workItemIds: string[],
    entry: InFlightRequest | undefined,
  ) {
    return [...this.requestTracker.values()].some(
      (held) =>
        held !== entry &&
        held.scope.workspaceId === scope.workspaceId &&
        held.scope.userId === scope.userId &&
        (held.profile === "workflow"
          ? !DIRECTORY_COMMANDS.has((held as InFlightRequest).command.type) &&
            "conversationId" in held.command &&
            held.command.conversationId === conversationId
          : !!held.parentRunId && workItemIds.includes(held.parentRunId)),
    );
  }
  /** A refusal that leaves no receipt: the same press can be tried again. */
  private unrecorded(
    scope: Scope,
    command: Command,
    run: <T>(fn: () => T) => Promise<T>,
    status: "conflict" | "rejected",
    code: CommandResult["code"],
  ) {
    return run(
      (): CommandResult => ({
        commandId: command.commandId,
        status,
        code,
        snapshot: this.storage.snapshot(scope),
      }),
    );
  }
  /** Re-read the native/process projection after its runtime changed a run. */
  private async refreshWork(
    scope: Scope,
    access: WorkAccess | undefined,
    run: <T>(fn: () => T) => Promise<T>,
  ) {
    const integrations = access?.integrations;
    if (integrations?.taskWindow) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const window = await integrations.taskWindow((id) =>
          this.storage.legacyQuestionProof(scope, id),
        );
        if (
          await run(() => {
            if (!window.validate()) return false;
            this.storage.syncNativeWork(scope, window.items, true);
            return true;
          })
        )
          return;
      }
      throw new IdentityError(503, "task_projection_changed");
    }
    if (integrations?.tasks) {
      const tasks = await integrations.tasks();
      await run(() => this.storage.syncNativeWork(scope, tasks));
    }
  }
  /**
   * Stops one open native or process WorkItem through its owner at the
   * revision the projection showed. Returns a refusal (never recorded) when
   * the run is still executing, changed meanwhile or cannot be stopped here.
   */
  private async stopWork(
    work: WorkItem,
    access: WorkAccess | undefined,
  ): Promise<["conflict" | "rejected", CommandResult["code"]] | undefined> {
    try {
      if (work.native?.process) {
        if (!access?.cancelProcessRun)
          return ["rejected", "integration_unavailable"];
        await access.cancelProcessRun(work.id, work.native.revision);
      } else {
        if (!work.native || !access?.integrations?.cancelOpenTask)
          return ["rejected", "integration_unavailable"];
        await access.integrations.cancelOpenTask({
          workItemId: work.id,
          expectedWorkRevision: work.native.revision,
          conversationId: work.conversationId,
        });
      }
      return undefined;
    } catch (error) {
      if (error instanceof NativeRunUnsettledError)
        return ["conflict", "operation_in_progress"];
      if (!(error instanceof IdentityError)) throw error;
      if (error.status === 429 || error.code === "process_command_in_progress")
        return ["conflict", "operation_in_progress"];
      if (error.status === 404) return ["rejected", "unknown_context"];
      if (error.status === 409 || error.status === 406)
        return ["conflict", "revision_conflict"];
      throw error;
    }
  }
  /**
   * `work.cancel`: the person stops their own waiting work. Native and
   * process work is stopped by its owner first; the receipt follows in the
   * workflow store. Fixture tasks and every refusal are decided there.
   */
  private async cancelWork(
    scope: Scope,
    command: Extract<Command, { type: "work.cancel" }>,
    run: <T>(fn: () => T) => Promise<T>,
    access: WorkAccess | undefined,
    entry: InFlightRequest | undefined,
  ): Promise<CommandResult> {
    if (
      this.answering(scope, command.conversationId, [command.workItemId], entry)
    )
      return this.unrecorded(
        scope,
        command,
        run,
        "conflict",
        "operation_in_progress",
      );
    const work = await run(() =>
      this.storage.conversationDeleted(scope, command.conversationId) ||
      this.storage.conversationArchived(scope, command.conversationId)
        ? undefined
        : this.storage
            .snapshot(scope)
            .workItems.find((item) => item.id === command.workItemId),
    );
    if (
      !work?.native ||
      work.conversationId !== command.conversationId ||
      work.revision !== command.expectedWorkRevision ||
      !isOpenWork(work)
    )
      return run(() => this.storage.execute(scope, command));
    const refusal = await this.stopWork(work, access);
    if (refusal) return this.unrecorded(scope, command, run, ...refusal);
    await this.refreshWork(scope, access, run);
    return run(() =>
      this.storage.execute(scope, command, undefined, { workCancelled: true }),
    );
  }
  /**
   * Deleting a chat commits first; the assistant's native threads of that chat
   * are forgotten after, under the chat's turn lock. Archiving and restoring
   * only change the directory. A chat still answering is refused without a
   * receipt, so the same press can be tried again.
   */
  private async directoryCommand(
    scope: Scope,
    command: Extract<
      Command,
      {
        type:
          | "conversation.delete"
          | "conversation.archive"
          | "conversation.restore";
      }
    >,
    run: <T>(fn: () => T) => Promise<T>,
    access: WorkAccess | undefined,
    entry: InFlightRequest | undefined,
  ): Promise<CommandResult> {
    if (this.answering(scope, command.conversationId, [], entry))
      return this.unrecorded(
        scope,
        command,
        run,
        "conflict",
        "operation_in_progress",
      );
    if (
      command.type === "conversation.delete" ||
      command.type === "conversation.archive"
    ) {
      // Runs that stopped without an answer longer ago than the task expiry
      // no longer hold the chat: they close once their retirement is proved.
      try {
        if (
          await access?.integrations?.settleStaleTasks?.(command.conversationId)
        )
          await this.refreshWork(scope, access, run);
      } catch (error) {
        if (error instanceof IdentityError && error.status === 403) throw error;
        operatorLog(
          "stale_work_settle_failed",
          {
            error:
              error instanceof Error
                ? error.constructor.name.slice(0, 60)
                : typeof error,
          },
          "error",
        );
      }
      if (command.cancelOpenWork) {
        // Native and process work commits in the identity store, the chat
        // directory in the workflow store: cancel first, then delete or
        // archive. A repeated press skips what is already cancelled.
        const open = await run(() =>
          this.storage
            .snapshot(scope)
            .workItems.filter(
              (work) =>
                work.conversationId === command.conversationId &&
                !!work.native &&
                isOpenWork(work),
            ),
        );
        if (
          this.answering(
            scope,
            command.conversationId,
            open.map((work) => work.id),
            entry,
          )
        )
          return this.unrecorded(
            scope,
            command,
            run,
            "conflict",
            "operation_in_progress",
          );
        for (const work of open) {
          const refusal = await this.stopWork(work, access);
          if (refusal) return this.unrecorded(scope, command, run, ...refusal);
        }
        if (open.length) await this.refreshWork(scope, access, run);
      }
    }
    const attachmentOwned =
      command.type === "conversation.delete" &&
      (await run(() =>
        this.storage.attachments.hasLineage(scope, command.conversationId),
      ));
    const result = await run(() => this.storage.execute(scope, command));
    if (
      !attachmentOwned &&
      command.type === "conversation.delete" &&
      result.status === "accepted" &&
      access?.integrations?.forgetConversation
    )
      try {
        await access.integrations.forgetConversation(command.conversationId);
      } catch (error) {
        // The chat is gone for the person either way; deleting it again retries.
        operatorLog(
          "conversation_forget_failed",
          {
            error:
              error instanceof Error
                ? error.constructor.name.slice(0, 60)
                : typeof error,
          },
          "error",
        );
      }
    return result;
  }
  private async executeInternal(
    scope: Scope,
    raw: unknown,
    validateSession: () => void | Promise<void>,
    signal: AbortSignal,
    access?: Pick<MobileRuntime, "tools" | "run"> &
      Partial<
        Pick<
          MobileRuntime,
          | "runModel"
          | "integrations"
          | "retireProcessRequest"
          | "cancelProcessRun"
        >
      >,
    routerOverride?: DecisionRouter,
    entry?: InFlightRequest,
  ) {
    const tools = access?.tools ?? this.tools;
    let inference = false;
    const run = <T>(fn: () => T, passive = false): Promise<T> =>
      access
        ? (inference && access.runModel ? access.runModel : access.run)(() => {
            if (!passive || signal.reason !== REQUEST_INTERRUPTION_REASON)
              signal.throwIfAborted();
            return fn();
          })
        : Promise.resolve().then(async () => {
            await validateSession();
            if (!passive || signal.reason !== REQUEST_INTERRUPTION_REASON)
              signal.throwIfAborted();
            return fn();
          });
    const originalCommand = CommandSchema.parse(raw);
    if (
      originalCommand.type === "message.send" &&
      originalCommand.attachments
    ) {
      // Retention-only acceptance never prepares a caption-only native request.
      return run(() =>
        this.storage.acceptAttachmentMessage(scope, originalCommand),
      );
    }
    await this.requestTracker.retireOwned();
    await this.requestTracker.retireScope(scope, async (held) => {
      if (held.profile === "process")
        return held.parentRunId
          ? ((await access?.retireProcessRequest?.(held.parentRunId)) ?? false)
          : false;
      const command = (held as InFlightRequest).command;
      return (
        (await access?.integrations?.proveRetired?.({
          commandId: command.idempotencyKey,
          requestHash: createHash("sha256")
            .update(JSON.stringify(command))
            .digest("hex"),
          conversationId:
            "conversationId" in command ? command.conversationId : "",
        })) ?? false
      );
    });
    const requestHash = createHash("sha256")
      .update(JSON.stringify(originalCommand))
      .digest("hex");
    const replay = await run(() => this.storage.replay(scope, originalCommand));
    if (replay) return replay;
    if (
      originalCommand.type === "conversation.delete" ||
      originalCommand.type === "conversation.archive" ||
      originalCommand.type === "conversation.restore"
    )
      return this.directoryCommand(scope, originalCommand, run, access, entry);
    if (originalCommand.type === "work.cancel")
      return this.cancelWork(scope, originalCommand, run, access, entry);
    // A deleted or archived chat reaches no native runtime; its receipt says
    // why (an archived chat can still be renamed).
    if (
      await run(
        () =>
          this.storage.conversationDeleted(
            scope,
            originalCommand.conversationId,
          ) ||
          this.storage.conversationArchived(
            scope,
            originalCommand.conversationId,
          ),
      )
    )
      return run(() => this.storage.execute(scope, originalCommand));
    if (
      originalCommand.type !== "conversation.create" &&
      !(
        await run(() =>
          this.storage.snapshot(scope, originalCommand.conversationId),
        )
      ).conversations.some(
        (conversation) => conversation.id === originalCommand.conversationId,
      )
    )
      return run(() => this.storage.execute(scope, originalCommand));
    const command = originalCommand;
    let activeKey: string | undefined;
    let trackedActivity: ReturnType<ModelService["startActivity"]> | undefined;
    try {
      if (
        access?.integrations?.ensureSettled &&
        !(await access.integrations.ensureSettled({
          commandId: command.idempotencyKey,
          outerCommandId: originalCommand.commandId,
          requestHash,
        }))
      )
        throw new ModelError("model_busy");
      await this.releaseRetiredRequests(scope, access?.integrations, entry);
      // Reserve inference before archiving the chat. A concurrent new-session
      // request that is refused as busy must leave the running request intact.
      if (command.type === "message.send" && command.session === "new")
        await run(() => {
          const key = personLane(scope);
          if (this.active.has(key) || this.active.size >= MAX_ACTIVE_RUNS)
            throw new ModelError("model_busy");
          this.requestTracker.acquireScope(key, entry);
          activeKey = key;
          this.storage.startSession(scope, command.conversationId, command);
        });
      if (
        access?.integrations &&
        (command.type === "task.open" ||
          command.type === "service.resolve" ||
          (command.type === "message.send" &&
            (!command.context || command.context.runtime === "mastra") &&
            (access.integrations.enabled ||
              (await access.integrations.hasTurn(command.idempotencyKey)))))
      ) {
        const before = await run(() =>
          this.storage.snapshot(scope, command.conversationId),
        );
        const conversation = before.conversations.find(
          (c) => c.id === command.conversationId,
        );
        if (
          !conversation ||
          (command.type === "service.resolve" &&
            !conversation.messages.some(
              (m) =>
                m.result?.type === "service.action" &&
                m.result.operationId === command.operationId,
            ) &&
            !before.workItems.some(
              (work) =>
                work.native?.action?.operationId === command.operationId &&
                work.conversationId === command.conversationId,
            ))
        )
          return run(() => this.storage.execute(scope, originalCommand));
        const invalidBinding =
          command.type === "service.resolve" &&
          !!command.workItemId !== (command.expectedWorkRevision !== undefined);
        const exactTerminal = await access.integrations.hasTerminal?.({
          commandId: command.idempotencyKey,
          requestHash,
          conversationId: command.conversationId,
        });
        const boundWork =
          command.type === "task.open" ||
          (command.type === "service.resolve" && command.workItemId)
            ? before.workItems.find(
                (work) =>
                  work.id === command.workItemId &&
                  work.native &&
                  work.conversationId === command.conversationId,
              )
            : undefined;
        if (
          !exactTerminal &&
          (invalidBinding ||
            ((command.type === "task.open" ||
              (command.type === "service.resolve" && command.workItemId)) &&
              (!boundWork ||
                boundWork.revision !== command.expectedWorkRevision ||
                (command.type === "service.resolve" &&
                  boundWork.native?.action?.operationId !==
                    command.operationId))))
        ) {
          return run(() =>
            this.storage.execute(scope, originalCommand, {
              decision: {
                kind: "reply",
                contactId: null,
                title: null,
                localStart: null,
                durationMinutes: null,
                reply: "",
              },
              expectedCursor: before.cursor,
              timeZone: "UTC",
              terminal: {
                status: "conflict",
                code: "revision_conflict",
                reply: translate(command.language)("revision_conflict"),
              },
            }),
          );
        }
        const key = personLane(scope);
        if (!activeKey) {
          if (this.active.has(key) || this.active.size >= MAX_ACTIVE_RUNS)
            throw new ModelError("model_busy");
          this.requestTracker.acquireScope(key, entry);
          activeKey = key;
        }
        const activity = (trackedActivity = this.startActivity(scope, command));
        const commitNativeResult = async (
          result: ServiceAnswer,
          passive = false,
        ) => {
          activity.advance("preparing");
          const nativeWindow = await access.integrations!.taskWindow?.((id) =>
            this.storage.legacyQuestionProof(scope, id),
          );
          const nativeWork =
            nativeWindow?.items ?? (await access.integrations!.tasks?.());
          const committed = await run(() => {
            if (nativeWindow && !nativeWindow.validate())
              throw new ModelError("model_busy");
            return this.storage.execute(scope, originalCommand, {
              decision: {
                kind: "reply",
                contactId: null,
                title: null,
                localStart: null,
                durationMinutes: null,
                reply: result.reply.slice(0, 800),
              },
              expectedCursor: before.cursor,
              timeZone: "UTC",
              nativeWork,
              nativeWorkAuthoritative: !!nativeWindow,
              nativeReply: result.reply.slice(0, 2000),
              ...(originalCommand.type === "message.send" &&
              originalCommand.retryOf
                ? { nativeRetryAuthorized: true }
                : {}),
              expectedConversationRevision: conversation.revision,
              workItemId: result.workItemId,
              serviceResult: result.result,
              connectionResult: result.connection,
              resolvedServiceResult: result.resolved,
              ui: result.ui,
              processOffer: result.processOffer,
              skillProposal: result.skillProposal,
              processProposal: result.processProposal,
            });
          }, passive);
          const work = nativeWork?.find(
            (value) => value.id === result.workItemId,
          );
          activity.finish(
            committed.status === "accepted" &&
              work?.status !== "failed" &&
              work?.native?.action?.status !== "unknown"
              ? "succeeded"
              : "failed",
          );
          return committed;
        };
        if (entry && access.integrations.settleInterrupted)
          entry.settleInterrupted = async () => {
            const result = await access.integrations!.settleInterrupted!({
              commandId: command.idempotencyKey,
              requestHash,
              language: command.language,
              conversationId: command.conversationId,
              ...(command.type === "service.resolve"
                ? { operationId: command.operationId }
                : {}),
            });
            if (!result) return undefined;
            try {
              return await commitNativeResult(result, true);
            } catch (error) {
              throw new NativeRunRetiredPublicationError(error);
            }
          };
        try {
          if (entry) entry.nativeStarted = true;
          const result =
            command.type === "task.open"
              ? await access.integrations.openTask!(
                  command.workItemId,
                  boundWork!.native!.revision,
                  command.conversationId,
                  command.language,
                )
              : command.type === "service.resolve"
                ? await access.integrations.resolve(
                    command.operationId,
                    command.approved,
                    command.language,
                    signal,
                    activity.tool,
                    activity.workflow,
                    command.workItemId
                      ? {
                          workItemId: command.workItemId,
                          expectedWorkRevision:
                            boundWork?.native?.revision ??
                            command.expectedWorkRevision!,
                          conversationId: command.conversationId,
                        }
                      : undefined,
                    {
                      commandId: command.idempotencyKey,
                      outerCommandId: originalCommand.commandId,
                      requestHash,
                      conversationId: command.conversationId,
                      legacyQuestionProof: (id) =>
                        this.storage.legacyQuestionProof(scope, id),
                    },
                    {
                      reportDraft: activity.draft,
                      reportStep: activity.step,
                      reportApproval: activity.approval,
                    },
                  )
                : await access.integrations.message(
                    command.idempotencyKey,
                    command.text,
                    command.language,
                    ((await run(() => this.storage.attachmentRestoreId()))
                      ? []
                      : conversation.messages
                    )
                      .slice(-8)
                      .map((m) => ({
                        role: m.role,
                        text: historyText(m),
                        ...(m.result || m.workItemId
                          ? {
                              operationId:
                                m.result?.type === "service.action"
                                  ? m.result.operationId
                                  : null,
                            }
                          : {}),
                      })),
                    signal,
                    activity.tool,
                    activity.workflow,
                    command.timeZone,
                    {
                      conversationId: command.conversationId,
                      attachmentGeneration: await run(() =>
                        this.storage.attachmentGeneration(
                          scope,
                          command.conversationId,
                        ),
                      ),
                      attachmentRestoreId: await run(() =>
                        this.storage.attachmentRestoreId(),
                      ),
                      requestHash,
                      outerCommandId: originalCommand.commandId,
                      conversationSession: await run(() =>
                        this.storage.conversationSession(
                          scope,
                          command.conversationId,
                          command.type === "message.send" &&
                            command.session === "new"
                            ? command
                            : undefined,
                        ),
                      ),
                      ...((await run(() =>
                        this.storage.createdConversation(
                          scope,
                          command.conversationId,
                        ),
                      ))
                        ? { createdConversation: true as const }
                        : {}),
                      legacyQuestionProof: (id) =>
                        this.storage.legacyQuestionProof(scope, id),
                      ...(command.context?.runtime === "mastra"
                        ? { task: command.context }
                        : {}),
                      ...(command.type === "message.send" && command.humanTask
                        ? { humanTaskId: command.humanTask.id }
                        : {}),
                      ...(command.type === "message.send" &&
                      command.withoutProcess
                        ? { withoutProcess: true as const }
                        : {}),
                      ...(command.type === "message.send" &&
                      command.mentions?.length
                        ? { mentions: command.mentions }
                        : {}),
                      ...(command.type === "message.send" && command.retryOf
                        ? {
                            retryOf: command.retryOf,
                            logicalMessageId: command.logicalMessageId,
                          }
                        : {}),
                      ...(command.session ? { session: command.session } : {}),
                      reportDraft: activity.draft,
                      reportStep: activity.step,
                      reportApproval: activity.approval,
                    },
                  );
          if (result) {
            return await commitNativeResult(
              result,
              signal.reason === REQUEST_INTERRUPTION_REASON,
            );
          }
          // Keep the same tracker while the built-in workflow takes over.
        } catch (error) {
          activity.finish("failed");
          if (
            signal.reason === REQUEST_INTERRUPTION_REASON &&
            error instanceof IdentityError
          )
            throw error;
          // Validation/policy conflicts before dispatch are durable command outcomes.
          // Captured identity is checked again by run; revocation cannot commit a receipt.
          if (
            (error instanceof IdentityError ||
              error instanceof IntegrationError) &&
            [400, 403, 404, 409, 429].includes(error.status)
          ) {
            const budgetFailure = isInferenceBudgetFailureCode(error.code);
            return run(() =>
              this.storage.execute(scope, originalCommand, {
                decision: {
                  kind: "reply",
                  contactId: null,
                  title: null,
                  localStart: null,
                  durationMinutes: null,
                  reply: "",
                },
                expectedCursor: before.cursor,
                timeZone: "UTC",
                terminal: {
                  status:
                    error.status === 409 && !budgetFailure
                      ? "conflict"
                      : "rejected",
                  reply: translate(command.language)(
                    error.code in en
                      ? (error.code as TranslationKey)
                      : error.status === 409
                        ? "revision_conflict"
                        : "requestRejected",
                  ),
                  code:
                    error.status === 409 && !budgetFailure
                      ? "revision_conflict"
                      : "integration_unavailable",
                },
              }),
            );
          }
          throw error;
        }
      }
      if (command.type !== "message.send")
        return run(() => this.storage.execute(scope, originalCommand));
      const router = routerOverride ?? this.router;
      // No model at all is a settled refusal, not an uncertain delivery: the
      // app must be able to send again once a model is configured.
      if (!router) {
        trackedActivity?.finish("failed");
        const before = await run(() =>
          this.storage.snapshot(scope, command.conversationId),
        );
        return run(() =>
          this.storage.execute(scope, originalCommand, {
            decision: {
              kind: "reply",
              contactId: null,
              title: null,
              localStart: null,
              durationMinutes: null,
              reply: "",
            },
            expectedCursor: before.cursor,
            timeZone: "UTC",
            terminal: {
              status: "rejected",
              reply: translate(command.language)("model_unavailable"),
              code: "integration_unavailable",
            },
          }),
        );
      }
      inference = true;
      const { snapshot, activeMeeting, historyFrom, recentContacts } =
        await run(() =>
          this.storage.modelState(
            scope,
            router.timeZone,
            command.context ? undefined : command.text,
            command.conversationId,
          ),
        );
      const conversation = snapshot.conversations.find(
        (c) => c.id === command.conversationId,
      );
      const input =
        command.context &&
        snapshot.inputRequests.find(
          (i) => i.id === command.context!.inputRequestId,
        );
      const work =
        input && snapshot.workItems.find((w) => w.id === input.workItemId);
      if (
        !conversation ||
        (command.context &&
          (!input ||
            !work ||
            input.workItemId !== command.context.workItemId ||
            input.conversationId !== command.conversationId ||
            input.status !== "open" ||
            input.revision !== command.context.expectedInputRevision ||
            work.status !== "waiting_input"))
      ) {
        trackedActivity?.advance("preparing");
        const result = await run(() =>
          this.storage.execute(scope, originalCommand),
        );
        trackedActivity?.finish(
          result.status === "accepted" ? "succeeded" : "failed",
        );
        return result;
      }
      const key = personLane(scope);
      if (!activeKey) {
        if (this.active.has(key) || this.active.size >= MAX_ACTIVE_RUNS)
          throw new ModelError("model_busy");
        this.requestTracker.acquireScope(key, entry);
        activeKey = key;
      }
      const activity = (trackedActivity ??= this.startActivity(scope, command));
      const advance = activity.advance;
      try {
        const history: { role: "user" | "assistant"; text: string }[] = [];
        // Only the current clarification exchange, never old tasks or another account.
        for (const message of conversation.messages
          .slice(historyFrom)
          .reverse()) {
          if (message.workItemId || history.length === 6) break;
          history.unshift({
            role: message.role,
            text: historyText(message).slice(0, 1200),
          });
        }
        const freshMeeting = !command.context && startsNewMeeting(command.text);
        let contactResult: CrmContactResult | undefined;
        let contactLookup: ContactLookup | undefined;
        const toolContext: ToolContext = {
          scope,
          permissions: new Set(["contacts.read.test"]),
          signal,
          validateSession: () => run(() => undefined),
        };
        const readTool = async (name: string, args: unknown) => {
          advance("crm");
          try {
            return ContactLookupSchema.parse(
              await tools.invoke(name, args, toolContext),
            );
          } catch {
            signal.throwIfAborted();
            await validateSession();
            throw new ModelError("model_unavailable");
          }
        };
        let decision = DecisionSchema.parse(
          await router.decide(
            {
              text: command.text,
              language: command.language,
              now: new Date(this.now()).toISOString(),
              timeZone: router.timeZone,
              history: freshMeeting ? [] : history,
              activeMeeting: freshMeeting ? null : activeMeeting,
              testCrmRead: tools.has("crm.contacts.list"),
              testCrmSearch: tools.has("crm.contacts.search"),
              recentContacts,
              ...(input
                ? { question: { text: input.question, options: input.options } }
                : {}),
            },
            signal,
          ),
        );
        signal.throwIfAborted();
        await validateSession();
        signal.throwIfAborted();
        if (decision.kind === "crm_contacts") {
          const found = await readTool("crm.contacts.list", {});
          const records = found.contacts;
          advance("preparing");
          contactResult = CrmContactResultSchema.parse({
            type: "crm.contacts",
            version: 1,
            source: "twenty",
            hasMore: !found.complete || records.length > 5,
            contacts: records.slice(0, 5),
          });
          // Keep a short fallback/history summary; contact fields never enter model history.
          const reply =
            command.language === "cs"
              ? records.length
                ? `Kontakty z CRM s označením TEST: ${contactResult.contacts.length}.`
                : "V CRM jsem nenašel žádné kontakty s označením TEST."
              : records.length
                ? `CRM contacts marked TEST: ${contactResult.contacts.length}.`
                : "No contacts marked TEST were found in CRM.";
          decision = {
            kind: "reply",
            reply,
            contactId: null,
            title: null,
            localStart: null,
            durationMinutes: null,
          };
        }
        if (decision.kind === "meeting_patch" && !command.context) {
          const patch = decision.patch!;
          const continuing = !freshMeeting && patch.mode === "continue";
          const slots = mergeMeeting(
            continuing && activeMeeting ? activeMeeting.slots : emptyMeeting(),
            patch,
          );
          const demoId =
            slots.contactId === "peter-novak" ||
            slots.contactId === "peter-svoboda";
          const demoName =
            !slots.contactId &&
            /^(peter|petr)(em|a|ovi)?$/i.test(slots.contactName ?? "");
          const existingId =
            continuing &&
            activeMeeting?.phase !== "collecting" &&
            activeMeeting?.options.some((o) => o.id === slots.contactId);
          if (
            slots.contactId &&
            !demoId &&
            !existingId &&
            !recentContacts.some((c) => c.id === slots.contactId)
          )
            throw new ModelError("model_invalid_response");
          if (
            tools.has("crm.contacts.search") &&
            (!continuing ||
              (activeMeeting && activeMeeting.phase !== "locked")) &&
            slots.localDate &&
            slots.localTime &&
            !demoId &&
            !demoName &&
            !existingId &&
            (slots.contactName || slots.contactId)
          )
            contactLookup = await readTool(
              "crm.contacts.search",
              slots.contactId
                ? { id: slots.contactId }
                : { name: slots.contactName },
            );
        }
        advance("preparing");
        const result = await run(() =>
          this.storage.execute(scope, originalCommand, {
            decision,
            expectedCursor: snapshot.cursor,
            timeZone: router.timeZone,
            ...(contactResult ? { contactResult } : {}),
            ...(contactLookup ? { contactLookup } : {}),
          }),
        );
        const status = result.status === "accepted" ? "succeeded" : "failed";
        activity.finish(status);
        return result;
      } catch (error) {
        activity.finish("failed");
        throw error;
      }
    } catch (error) {
      if (error instanceof NativeRunUnsettledError && entry)
        entry.unsettled = true;
      // Includes fallback preparation failures before legacy inference starts.
      trackedActivity?.finish("failed");
      throw error;
    } finally {
      if (entry && activeKey) entry.activeKey = activeKey;
      if (activeKey && !entry?.unsettled)
        this.requestTracker.releaseScope(activeKey, entry);
    }
  }
}
