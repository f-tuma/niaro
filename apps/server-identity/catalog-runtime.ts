import { createHash } from "node:crypto";
import type { Scope, Language } from "../../packages/protocol";
import type {
  ActivityTool,
  ActivityWorkflow,
} from "../../packages/protocol/activity";
import type { ServiceResult } from "../../packages/protocol/service-result";
import type { ProcessOfferResult } from "../../packages/protocol/process-offer";
import type { ServiceConnectionCard } from "../../packages/protocol/service-oauth";
import type { GeneratedUi } from "../../packages/protocol/generative-ui";
import type { CatalogController, CatalogContext } from "./catalog-controller";
import type { IntegrationTransport } from "../server-integrations/transport";
import type { PluginSettings } from "../server-plugins/registry";
import type { AgentMemory } from "./agent-memory";
import type { DomainMessageContext } from "./mastra-domain";
import { createNativeCatalogRuntime } from "./mastra-runtime";
import { createServiceAnswer } from "./service-answer";
import { IdentityError } from "./error";
import type { InferenceRunCaps } from "./inference-budget";
import { createTaskReadObservation } from "./process-read-window";
import {
  legacyQuestionCandidate,
  legacyQuestionIsCurrent,
} from "./legacy-question";
export type ServiceAnswer = {
  workItemId?: string;
  connection?: ServiceConnectionCard;
  reply: string;
  result?: ServiceResult;
  /** The answer's admitted UI program, shown beside the reply. */
  ui?: GeneratedUi;
  processOffer?: ProcessOfferResult;
  skillProposal?: import("../../packages/protocol/skills").SkillProposalResult;
  processProposal?: import("../../packages/protocol/process-proposal").ProcessProposalResult;
  resolved?: ServiceResult;
};
export type CatalogRuntime = {
  enabled: boolean;
  /** Validate observation under the authenticated identity queue immediately before publication. */
  taskWindow?: (
    legacyQuestionProof?: CatalogContext["legacyQuestionProof"],
  ) => Promise<{
    items: import("../../packages/protocol").WorkItem[];
    validate: () => boolean;
  }>;
  tasks?: (
    roots?: unknown[],
  ) => Promise<import("../../packages/protocol").WorkItem[]>;
  openTask?: (
    id: string,
    revision: number,
    conversationId: string,
    language: Language,
  ) => Promise<ServiceAnswer>;
  /** Exact passive command projection, including plain replies omitted from Tasks. */
  readTask?: (commandId: string) => Promise<
    | (import("../../packages/protocol").WorkItem & {
        cancellationSettled?: true;
        /** A canonical question/approval still needs its resume authority closed. */
        cancellationPending?: true;
      })
    | null
  >;
  /** Cancel an exactly pinned, settled native suspension without resuming it. */
  cancelTask?: (binding: {
    workItemId: string;
    expectedWorkRevision: number;
    conversationId: string;
  }) => Promise<ServiceAnswer>;
  /**
   * The person cancels their own open chat task at its exact native revision:
   * a paused question or approval closes (the approval is declined), a run
   * that stopped without an answer is closed after its retirement is proved.
   * Never resumes the run or dispatches an action.
   */
  cancelOpenTask?: (binding: {
    workItemId: string;
    expectedWorkRevision: number;
    conversationId: string;
  }) => Promise<void>;
  /** Close a chat's runs that stopped without an answer longer ago than the
   * task expiry, when their retirement is proved; returns how many closed. */
  settleStaleTasks?: (conversationId: string) => Promise<number>;
  hasTurn: (id: string) => Promise<boolean>;
  /** Forget a deleted chat's native threads; returns how many were removed. */
  forgetConversation?: (conversationId: string) => Promise<number>;
  /** Passive scoped retirement check before reserving a different command. */
  ensureSettled?: (input: {
    commandId: string;
    outerCommandId: string;
    requestHash: string;
  }) => Promise<boolean>;
  /** Internal retirement proof only; grants no reply or effect authorization. */
  proveRetired?: (input: {
    commandId: string;
    requestHash: string;
    conversationId: string;
  }) => Promise<boolean>;
  /** Exactly bound terminal native replies can precede obsolete task revisions. */
  hasTerminal?: (input: {
    commandId: string;
    requestHash: string;
    conversationId: string;
  }) => Promise<boolean>;
  /** Read an exactly bound known outcome; never infer, resume or dispatch. */
  recoverResult?: (input: {
    commandId: string;
    text: string;
    language: Language;
    requestHash: string;
  }) => Promise<ServiceAnswer | null>;
  /** Recheck retirement and finalize a stopped native run without executing it. */
  settleInterrupted?: (input: {
    commandId: string;
    requestHash: string;
    language: Language;
    conversationId: string;
    operationId?: string;
  }) => Promise<ServiceAnswer | null>;
  message: (
    id: string,
    text: string,
    language: Language,
    history: {
      role: "user" | "assistant";
      text: string;
      operationId?: string | null;
    }[],
    signal: AbortSignal,
    reportTool?: (tool: ActivityTool) => void,
    reportWorkflow?: (workflow: ActivityWorkflow) => void,
    /** The person's device timezone; used only when it is a valid IANA zone. */
    timeZone?: string,
    context?: DomainMessageContext,
  ) => Promise<ServiceAnswer | null>;
  resolve: (
    id: string,
    approved: boolean,
    language: Language,
    signal: AbortSignal,
    reportTool?: (tool: ActivityTool) => void,
    reportWorkflow?: (workflow: ActivityWorkflow) => void,
    binding?: {
      workItemId: string;
      expectedWorkRevision: number;
      conversationId: string;
    },
    commandBinding?: {
      commandId: string;
      outerCommandId: string;
      requestHash: string;
      conversationId: string;
      legacyQuestionProof?: CatalogContext["legacyQuestionProof"];
    },
  ) => Promise<ServiceAnswer>;
};

/** One native execution engine; historical kinds can only finish their saved work. */
export function createCatalogRuntime(
  controller: CatalogController,
  transport: IntegrationTransport,
  context: CatalogContext,
  scope: Scope,
  organizationId: string,
  enabled = true,
  legacyEnabled = false,
  pluginSettings?: PluginSettings,
  memory?: AgentMemory,
  /** Trusted caller caps; never derived from model text or a command payload. */
  inferenceCaps?: InferenceRunCaps,
  processTasks?: {
    observation?: () => unknown;
    roots: () => Promise<import("./service-catalog").NativeTaskRoot[]>;
    project: (
      roots: import("./service-catalog").NativeTaskRoot[],
    ) => Promise<import("../../packages/protocol").WorkItem[]>;
  },
): CatalogRuntime {
  const target = { organizationId, workspaceId: scope.workspaceId };
  const key = (commandId: string) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          scope.serverId,
          scope.workspaceId,
          scope.userId,
          commandId,
        ]),
      )
      .digest("hex");
  const native = createNativeCatalogRuntime(
    controller,
    context,
    scope,
    organizationId,
    pluginSettings,
    createServiceAnswer(controller, context, scope, organizationId),
    memory,
    inferenceCaps,
  );
  let historical: Promise<CatalogRuntime> | undefined;
  const drain = () =>
    (historical ??= import("./catalog-runtime-legacy").then((module) =>
      module.createDrainCatalogRuntime(
        controller,
        transport,
        context,
        scope,
        organizationId,
        enabled,
        legacyEnabled,
        pluginSettings,
        memory,
      ),
    ));
  async function actor() {
    const current = await context.actor(target);
    if (current.userId !== scope.userId)
      throw new IdentityError(403, "identity_forbidden");
    return current;
  }
  function guardedContext(
    overrides: Pick<CatalogContext, "validateRequest" | "legacyQuestionProof">,
  ): CatalogContext {
    return {
      ...context,
      legacyQuestionProof:
        overrides.legacyQuestionProof ?? context.legacyQuestionProof,
      validateRequest: () => {
        // The owner may revoke its guard while inference is in flight. Forward
        // the current method, including its receiver, instead of copying it.
        context.validateRequest?.();
        if (overrides.validateRequest !== context.validateRequest)
          overrides.validateRequest?.();
      },
    };
  }
  async function kind(commandId: string) {
    return context.serial(async () => {
      await actor();
      context.validateRequest?.();
      const saved = controller.store.turn(
        key(commandId),
        scope.workspaceId,
        scope.userId,
      ) as { kind?: string } | undefined;
      return saved ? (saved.kind ?? "legacy") : undefined;
    });
  }
  function legacyKind(value: string | undefined) {
    if (value === "service-process-1")
      throw new IdentityError(409, "process_command_required");
    if (
      value &&
      !["mastra-1", "legacy", "agent-1", "progressive-1"].includes(value)
    )
      throw new IdentityError(409, "catalog_runtime_unsupported");
    return Boolean(value && value !== "mastra-1");
  }
  async function taskWindow(
    legacyQuestionProof?: CatalogContext["legacyQuestionProof"],
  ) {
    if (legacyQuestionProof)
      return createCatalogRuntime(
        controller,
        transport,
        guardedContext({ legacyQuestionProof }),
        scope,
        organizationId,
        enabled,
        legacyEnabled,
        pluginSettings,
        memory,
        inferenceCaps,
        processTasks,
      ).taskWindow!();
    const roots = processTasks
      ? await processTasks.roots()
      : await context.serial(async () => {
          await actor();
          context.validateRequest?.();
          return controller.store
            .nativeTurns(scope.workspaceId, scope.userId)
            .map((value) => ({
              id: (value as { runId: string }).runId,
              kind: "mastra-1" as const,
              value,
            }));
        });
    const observation = createTaskReadObservation(
      controller,
      context,
      scope,
      organizationId,
      processTasks?.observation,
    );
    const publicProof = (current: typeof roots) =>
      createHash("sha256")
        .update(
          JSON.stringify(
            current
              .filter((root) => root.kind === "mastra-1")
              .map((root) => {
                const origin = (
                  root.value as { legacyQuestion?: { turnId: string } }
                ).legacyQuestion;
                const old =
                  origin &&
                  (controller.store.turn(
                    origin.turnId,
                    scope.workspaceId,
                    scope.userId,
                  ) as { commandId?: string } | undefined);
                let binding: string | undefined;
                if (origin) {
                  try {
                    binding = controller.store.legacyQuestionRoot(
                      origin.turnId,
                      scope.workspaceId,
                      scope.userId,
                    );
                  } catch (error) {
                    if (!(error instanceof IdentityError)) throw error;
                    binding = "conflict";
                  }
                }
                return origin
                  ? [
                      root.id,
                      old
                        ? createHash("sha256")
                            .update(JSON.stringify(old))
                            .digest("hex")
                        : null,
                      legacyQuestionIsCurrent(legacyQuestionCandidate(old)),
                      binding,
                      context.legacyQuestionProof?.(old?.commandId ?? ""),
                    ]
                  : [root.id];
              }),
          ),
        )
        .digest("hex");
    const observed = await context.serial(async () => {
      const currentActor = await actor();
      context.validateRequest?.();
      return {
        actor: currentActor,
        value: observation(roots, currentActor),
        proof: publicProof(roots),
      };
    });
    const [chat, processes] = await Promise.all([
      native.tasks!(
        roots.filter((r) => r.kind === "mastra-1").map((r) => r.value),
      ),
      processTasks
        ? processTasks.project(
            roots.filter((r) => r.kind === "service-process-1"),
          )
        : [],
    ]);
    const byId = new Map(
      [...chat, ...processes].map((work) => [work.id, work]),
    );
    return {
      items: roots.flatMap((root) =>
        byId.has(root.id) ? [byId.get(root.id)!] : [],
      ),
      validate: () => {
        context.validateRequest?.();
        const current = processTasks
          ? controller.store.taskRoots(scope, organizationId)
          : controller.store
              .nativeTurns(scope.workspaceId, scope.userId)
              .map((value) => ({
                id: (value as { runId: string }).runId,
                kind: "mastra-1" as const,
                value,
              }));
        return (
          observation(current, observed.actor) === observed.value &&
          publicProof(current) === observed.proof
        );
      },
    };
  }
  return {
    enabled,
    taskWindow,
    tasks: async () => (await taskWindow()).items,
    readTask: (commandId) => native.readTask!(commandId),
    cancelTask: (binding) => native.cancelTask!(binding),
    cancelOpenTask: async (binding) => {
      const saved = await context.serial(async () => {
        await actor();
        context.validateRequest?.();
        return controller.store.turn(
          binding.workItemId,
          scope.workspaceId,
          scope.userId,
        ) as { kind?: string } | undefined;
      });
      // A process run is cancelled through the process coordinator.
      if (saved?.kind === "service-process-1")
        throw new IdentityError(409, "process_command_required");
      return native.cancelOpenTask!(binding);
    },
    settleStaleTasks: (conversationId) =>
      native.settleStaleTasks!(conversationId),
    openTask: async (id, revision, conversationId, language) => {
      const saved = await context.serial(async () => {
        await actor();
        context.validateRequest?.();
        return controller.store.turn(id, scope.workspaceId, scope.userId) as
          | { kind?: string }
          | undefined;
      });
      if (saved?.kind === "service-process-1")
        throw new IdentityError(409, "process_command_required");
      return native.openTask!(id, revision, conversationId, language);
    },
    ensureSettled: (input) => native.ensureSettled!(input),
    forgetConversation: (conversationId) =>
      native.forgetConversation!(conversationId),
    proveRetired: (input) => native.proveRetired!(input),
    hasTerminal: (input) => native.hasTerminal!(input),
    async hasTurn(commandId) {
      return (await kind(commandId)) !== undefined;
    },
    async recoverResult(input) {
      const previous = await kind(input.commandId);
      return legacyKind(previous)
        ? ((await drain()).recoverResult?.(input) ?? null)
        : (native.recoverResult?.(input) ?? null);
    },
    settleInterrupted: (input) => native.settleInterrupted!(input),
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
      const guarded =
        messageContext?.validateRequest || messageContext?.legacyQuestionProof
          ? createCatalogRuntime(
              controller,
              transport,
              guardedContext(messageContext),
              scope,
              organizationId,
              enabled,
              legacyEnabled,
              pluginSettings,
              memory,
              inferenceCaps,
              processTasks,
            )
          : undefined;
      if (guarded) {
        const {
          validateRequest: _guard,
          legacyQuestionProof: _proof,
          ...current
        } = messageContext!;
        return guarded.message(
          commandId,
          text,
          language,
          history,
          signal,
          reportTool,
          reportWorkflow,
          timeZone,
          current,
        );
      }
      const previous = await kind(commandId);
      const runtime = legacyKind(previous) ? await drain() : native;
      return runtime.message(
        commandId,
        text,
        language,
        history,
        signal,
        reportTool,
        reportWorkflow,
        timeZone,
        messageContext,
      );
    },
    async resolve(
      id,
      approved,
      language,
      signal,
      reportTool,
      reportWorkflow,
      binding,
      commandBinding,
    ) {
      if (commandBinding?.legacyQuestionProof) {
        const { legacyQuestionProof, ...current } = commandBinding;
        return createCatalogRuntime(
          controller,
          transport,
          guardedContext({ legacyQuestionProof }),
          scope,
          organizationId,
          enabled,
          legacyEnabled,
          pluginSettings,
          memory,
          inferenceCaps,
          processTasks,
        ).resolve(
          id,
          approved,
          language,
          signal,
          reportTool,
          reportWorkflow,
          binding,
          current,
        );
      }
      const previous = await context.serial(async () => {
        await actor();
        return controller.store.turnForOperation(
          id,
          scope.workspaceId,
          scope.userId,
        )?.value as { kind?: string } | undefined;
      });
      // Only an operation saved with a chat turn can be resolved here. An
      // unlinked one must not reach the historical drain, which would approve
      // it by invoking the action directly.
      if (!previous) throw new IdentityError(404, "catalog_not_found");
      legacyKind(previous.kind);
      const runtime = previous.kind === "mastra-1" ? native : await drain();
      return runtime.resolve(
        id,
        approved,
        language,
        signal,
        reportTool,
        reportWorkflow,
        binding,
        commandBinding,
      );
    },
  };
}
