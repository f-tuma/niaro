import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Scope } from "../../packages/protocol";
import { IdentityId } from "../../packages/protocol/identity";
import { hubEligibleInput } from "../../packages/protocol/hub";
import {
  PROCESS_PROPOSAL_PROFILE,
  ProcessProposalAcceptSchema,
  ProcessProposalResultSchema,
  ProcessProposalStatusSchema,
  type ProcessProposalAccept,
  type ProcessProposalResult,
  type ProcessProposalStatus,
  type ProcessProposalStep,
} from "../../packages/protocol/process-proposal";
import {
  WORKSPACE_DESIGN_PROFILE,
  type OwnedDesignReview,
} from "../../packages/protocol/process-design";
import { PROCESS_VERSION_PROFILE } from "../../packages/protocol/process-versions";
import { PROCESS_NATIVE_TEST_PROFILE } from "../../packages/protocol/process-native-testing";
import { PROCESS_ACTIVATION_PROFILE } from "../../packages/protocol/process-activation";
import type {
  ProcessData,
  ProcessDefinition,
} from "../../packages/protocol/service-processes";
import { orderedProcessNodes } from "../server-agent/process-workflow";
import type { CatalogContext } from "./catalog-controller";
import { IdentityError } from "./error";
import type { Hub } from "./hub";
import { designProposalCatalog } from "./process-design-capabilities";
import type { ProcessDesignConversation } from "./process-design-conversation";
import type { ProcessDesignStore } from "./process-design-store";
import type { ProcessActivationStore } from "./process-activation-store";
import type { createProcessNativeTesting } from "./process-native-testing-controller";
import { defaultProcessSuite } from "./process-proposal-suite";
import { fitProcessLimits } from "./process-proposal-limits";
import { processDigest } from "./process-validation";
import type { ProcessVersionsStore } from "./process-versions-store";
import type { ServiceCatalogStore } from "./service-catalog";
import type { ProcessActor, ServiceProcessStore } from "./service-processes";
import type { WorkspacePluginStore } from "./workspace-plugins";

type Target = { organizationId: string; workspaceId: string };
type Owner = Target & { userId: string };
type Language = "en" | "cs";

const StoredSchema = z.strictObject({
  /** The designer model this session is bound to (the first turn pins it). */
  modelId: IdentityId,
  status: ProcessProposalStatusSchema,
  /** Digest of the accepted press, so a retried press is recognised. */
  requestDigest: z.string().optional(),
});
type Stored = z.infer<typeof StoredSchema>;

/** Proposals made from chat and the outcome of saving them, per person. */
export class ProcessProposalStore {
  constructor(
    private db: DatabaseSync,
    private serverId: string,
    private now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_process_proposal(
      server_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(server_id, workspace_id, user_id, session_id))`);
    // Nothing continues a save this server no longer runs (e.g. after a restart).
    const time = new Date(this.now()).toISOString();
    for (const row of db
      .prepare("SELECT * FROM agent_process_proposal WHERE server_id = ?")
      .all(serverId)) {
      const stored = StoredSchema.safeParse(JSON.parse(String(row.data)));
      if (!stored.success || stored.data.status.state !== "running") continue;
      const { phase: _phase, ...status } = stored.data.status;
      this.write(
        {
          organizationId: String(row.organization_id),
          workspaceId: String(row.workspace_id),
          userId: String(row.user_id),
        },
        {
          ...stored.data,
          status: {
            ...status,
            state: "failed",
            failure: "process_proposal_interrupted",
            updatedAt: time,
          },
        },
      );
    }
  }
  private write(owner: Owner, stored: Stored) {
    const value = StoredSchema.parse(stored);
    this.db
      .prepare(
        `INSERT INTO agent_process_proposal VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(server_id, workspace_id, user_id, session_id)
        DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(
        this.serverId,
        owner.organizationId,
        owner.workspaceId,
        owner.userId,
        value.status.sessionId,
        JSON.stringify(value),
        new Date(this.now()).toISOString(),
      );
  }
  /** The person's own proposal; anyone else's is missing. */
  read(owner: Owner, sessionId: string): Stored {
    const row = this.db
      .prepare(
        `SELECT data FROM agent_process_proposal WHERE server_id = ?
        AND organization_id = ? AND workspace_id = ? AND user_id = ? AND session_id = ?`,
      )
      .get(
        this.serverId,
        owner.organizationId,
        owner.workspaceId,
        owner.userId,
        sessionId,
      );
    if (!row) throw new IdentityError(404, "process_proposal_not_found");
    return StoredSchema.parse(JSON.parse(String(row.data)));
  }
  register(owner: Owner, sessionId: string, modelId: string) {
    try {
      return this.read(owner, sessionId);
    } catch {
      const stored: Stored = {
        modelId,
        status: {
          profile: PROCESS_PROPOSAL_PROFILE,
          sessionId,
          state: "open",
        },
      };
      this.write(owner, stored);
      return stored;
    }
  }
  /** Starts a save unless this exact press is known or another one runs. */
  begin(owner: Owner, request: ProcessProposalAccept, restart = false) {
    const stored = this.read(owner, request.sessionId);
    const digest = processDigest(request);
    if (stored.status.requestId === request.requestId) {
      if (stored.requestDigest !== digest)
        throw new IdentityError(409, "process_proposal_conflict");
      return { status: stored.status, start: false };
    }
    if (stored.status.state === "running")
      throw new IdentityError(409, "process_proposal_busy");
    if (stored.status.state === "done" && !restart)
      return { status: stored.status, start: false };
    const status: ProcessProposalStatus = {
      profile: PROCESS_PROPOSAL_PROFILE,
      sessionId: request.sessionId,
      state: "running",
      phase: "saving",
      requestId: request.requestId,
      ...(stored.status.processId
        ? { processId: stored.status.processId }
        : {}),
      ...(stored.status.version ? { version: stored.status.version } : {}),
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.write(owner, { ...stored, status, requestDigest: digest });
    return { status, start: true };
  }
  update(
    owner: Owner,
    sessionId: string,
    change: (status: ProcessProposalStatus) => ProcessProposalStatus,
  ) {
    const stored = this.read(owner, sessionId);
    const status = ProcessProposalStatusSchema.parse({
      ...change(stored.status),
      updatedAt: new Date(this.now()).toISOString(),
    });
    this.write(owner, { ...stored, status });
    return status;
  }
}

export type ProcessProposalDependencies = {
  store: ProcessProposalStore;
  proposals: ProcessDesignStore;
  conversation: ProcessDesignConversation;
  registry: ServiceProcessStore;
  catalog: ServiceCatalogStore;
  plugins: WorkspacePluginStore;
  versions: ProcessVersionsStore;
  testing: ReturnType<typeof createProcessNativeTesting>;
  activation: ProcessActivationStore;
  hub: Hub;
};

async function actorOf(
  context: CatalogContext,
  target: Target,
): Promise<ProcessActor> {
  context.validateRequest?.();
  const current = await context.actor(target);
  context.validateRequest?.();
  return { ...target, userId: current.userId, role: current.role };
}
const key = (...parts: unknown[]) => processDigest(parts).slice(0, 64);
const clip = (value: string, max: number) =>
  value.length > max ? value.slice(0, max - 1).trimEnd() + "…" : value;

function fields(schema: ProcessData) {
  return schema.type === "object"
    ? Object.entries(schema.properties).map(([name, field]) => ({
        key: name,
        type: field.type,
        required: schema.required.includes(name),
      }))
    : [];
}
function capabilitiesOf(definition: ProcessDefinition) {
  return definition.kind === "agent"
    ? definition.capabilities
    : definition.steps.flatMap((step) =>
        step.type === "action"
          ? [step]
          : step.type === "agent"
            ? step.capabilities
            : [],
      );
}

/** The card a person reviews; built from the designer's current review. */
export function proposalCard(
  review: OwnedDesignReview,
  catalog: ReturnType<typeof designProposalCatalog>,
  options: { name: string; addToHub: boolean },
): ProcessProposalResult {
  const candidate = review.candidate;
  const action = (serviceId: string, actionId: string) =>
    catalog.actions.get(serviceId + ":" + actionId);
  const model = (id: string) =>
    catalog.models.find((value) => value.id === id)?.name;
  const label = (value: string | undefined, fallback: string) =>
    clip(value?.trim() || fallback, 160);
  const agentStep = (agent: {
    instructions: string;
    modelId: string;
    capabilities: { serviceId: string; actionId: string }[];
  }): ProcessProposalStep => ({
    type: "agent",
    task: clip(agent.instructions.trim(), 300),
    ...(model(agent.modelId)
      ? { model: label(model(agent.modelId), agent.modelId) }
      : {}),
    tools: [
      ...new Set(
        agent.capabilities.map((c) =>
          label(action(c.serviceId, c.actionId)?.action, c.actionId),
        ),
      ),
    ].slice(0, 16),
  });
  let steps: ProcessProposalStep[] = [];
  if (candidate?.kind === "agent")
    steps = [
      agentStep(candidate),
      {
        type: "return",
        fields: fields(candidate.outputSchema).map((f) => f.key),
      },
    ];
  else if (candidate)
    try {
      steps = orderedProcessNodes(candidate).map((step) =>
        step.type === "action"
          ? {
              type: "action",
              service: label(
                action(step.serviceId, step.actionId)?.service,
                step.serviceId,
              ),
              action: label(
                action(step.serviceId, step.actionId)?.action,
                step.actionId,
              ),
              effect: action(step.serviceId, step.actionId)?.effect ?? "write",
              approval:
                action(step.serviceId, step.actionId)?.approval === "always",
            }
          : step.type === "agent"
            ? agentStep(step)
            : step.type === "branch"
              ? { type: "branch" }
              : { type: "return", fields: Object.keys(step.output) },
      );
    } catch {
      steps = [];
    }
  const services = new Map<string, { reads: boolean; writes: boolean }>();
  let unattended = false;
  for (const capability of candidate ? capabilitiesOf(candidate) : []) {
    const known = action(capability.serviceId, capability.actionId);
    if (!known || (known.effect === "write" && known.approval !== "always"))
      unattended = true;
    const name = label(known?.service, capability.serviceId);
    const entry = services.get(name) ?? { reads: false, writes: false };
    if (known?.effect === "read") entry.reads = true;
    else entry.writes = true;
    services.set(name, entry);
  }
  const hubEligible =
    !!candidate && hubEligibleInput(candidate.inputSchema) && !unattended;
  const ready =
    !!candidate &&
    review.validation.valid &&
    review.blockers.every((b) => b === "assumptions_unacknowledged");
  return ProcessProposalResultSchema.parse({
    type: "process.proposal",
    version: 1,
    sessionId: review.id,
    revision: review.revision,
    reviewDigest: review.reviewDigest,
    status: ready ? "ready" : "questions",
    name: clip(candidate?.name ?? options.name, 100),
    description: clip(candidate?.description ?? review.brief.purpose, 1000),
    kind: candidate?.kind ?? null,
    steps: steps.slice(0, 32),
    inputs: candidate ? fields(candidate.inputSchema).slice(0, 40) : [],
    outputs: candidate
      ? fields(candidate.outputSchema)
          .map((f) => f.key)
          .slice(0, 40)
      : [],
    services: [...services]
      .map(([name, value]) => ({ name, ...value }))
      .slice(0, 16),
    assumptions: review.brief.assumptions.flatMap((assumption) => {
      const reviewed = review.assumptions.find((a) => a.id === assumption.id);
      return reviewed
        ? [
            {
              id: assumption.id,
              text: assumption.text,
              digest: reviewed.digest,
            },
          ]
        : [];
    }),
    questions: review.brief.questions.map((q) => q.text),
    hubEligible,
    addToHub: options.addToHub && hubEligible,
  });
}

function budgetCard(name: string, addToHub: boolean): ProcessProposalResult {
  return ProcessProposalResultSchema.parse({
    type: "process.proposal",
    version: 1,
    sessionId: null,
    revision: null,
    reviewDigest: null,
    status: "budget",
    name: clip(name, 100),
    description: "",
    kind: null,
    steps: [],
    inputs: [],
    outputs: [],
    services: [],
    assumptions: [],
    questions: [],
    hubEligible: false,
    addToHub: addToHub && false,
  });
}

/** What the designer is asked: the person's words plus the chat's frame. */
function designerText(
  input: { request: string; name?: string; addToHub: boolean },
  language: Language,
  continuing: boolean,
) {
  const frame = continuing
    ? ""
    : language === "cs"
      ? `\n\n(Z chatu: osobní proces${input.name ? ` s názvem „${input.name}“` : ""}.${
          input.addToHub
            ? " Bude na mém přehledu, takže nesmí mít povinné vstupy a nesmí nic zapisovat bez mého schválení."
            : ""
        } Když ti něco podstatného chybí, zeptej se; jinak rovnou navrhni celý proces.)`
      : `\n\n(From chat: a personal process${input.name ? ` named "${input.name}"` : ""}.${
          input.addToHub
            ? " It goes on my overview, so it must have no required inputs and must not write anything without my approval."
            : ""
        } If something essential is missing, ask; otherwise propose the whole process.)`;
  return clip(input.request.trim(), 4000 - frame.length) + frame;
}

export function createProcessProposals(deps: ProcessProposalDependencies) {
  const owner = (actor: ProcessActor): Owner => ({
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
  });

  /**
   * The chat tool: runs the real designer conversation for a personal process
   * under the person's own capabilities and budget, and returns its card.
   * Nothing is saved. `callKey` makes a replayed tool call return the same
   * session and turn instead of starting new ones.
   */
  async function propose(
    context: CatalogContext,
    target: Target,
    input: {
      request: string;
      name?: string;
      addToHub: boolean;
      sessionId?: string;
      language: Language;
      callKey: string;
    },
    signal: AbortSignal,
  ) {
    const fallbackName = clip(
      input.name?.trim() || input.request.trim().split("\n")[0]!,
      100,
    );
    const prepared = await context.serial(async () => {
      const actor = await actorOf(context, target);
      const catalog = designProposalCatalog(deps.catalog, deps.plugins, actor);
      if (input.sessionId) {
        const stored = deps.store.read(owner(actor), input.sessionId);
        const review = deps.proposals.readReview(actor, input.sessionId);
        if (review.acceptedProcessId)
          throw new IdentityError(409, "process_proposal_saved");
        return { actor, review, modelId: stored.modelId, catalog };
      }
      if (!catalog.budgetReady || !catalog.priced.length)
        return { actor, catalog };
      // The workspace's chat model when the budget prices it, else the first priced one.
      let chat: string | undefined;
      try {
        chat = deps.catalog.resolveModel(
          actor.organizationId,
          actor.workspaceId,
        )?.model.id;
      } catch {
        chat = undefined;
      }
      const modelId = (
        catalog.priced.find((model) => model.id === chat) ?? catalog.priced[0]!
      ).id;
      const receipt = deps.proposals.start(actor, {
        ...target,
        profile: WORKSPACE_DESIGN_PROFILE,
        requestId: key(input.callKey, "start"),
        owner: { type: "user" },
        confirmation: "catalog",
      });
      const stored = deps.store.register(
        owner(actor),
        receipt.sessionId,
        modelId,
      );
      return {
        actor,
        review: deps.proposals.readReview(actor, receipt.sessionId),
        modelId: stored.modelId,
        catalog,
      };
    });
    if (!prepared.review)
      return { card: budgetCard(fallbackName, input.addToHub) };
    const turn = await deps.conversation.message(
      context,
      {
        ...target,
        sessionId: prepared.review.id,
        requestId: key(input.callKey, "turn"),
        revision: prepared.review.revision,
        modelId: prepared.modelId,
        text: designerText(input, input.language, !!input.sessionId),
        language: input.language,
      },
      signal,
    );
    if (turn.status !== "completed")
      return {
        error: turn.failure ?? "process_design_turn_" + turn.status,
        sessionId: prepared.review.id,
      };
    const card = await context.serial(async () => {
      const actor = await actorOf(context, target);
      return proposalCard(
        deps.proposals.readReview(actor, prepared.review!.id),
        designProposalCatalog(deps.catalog, deps.plugins, actor),
        { name: fallbackName, addToHub: input.addToHub },
      );
    });
    return { card, reply: turn.reply };
  }

  const fit = (current: ProcessActor, definition: ProcessDefinition) =>
    fitProcessLimits(definition, {
      budget: deps.catalog.inferenceBudget.policy(
        current.organizationId,
        current.workspaceId,
      ).settings,
      ceiling: deps.registry.effectiveLimits(),
      model: (id) => {
        try {
          const usable = deps.catalog.model(
            current.organizationId,
            id,
            "tools",
          );
          return {
            id: usable.model.id,
            revision: usable.model.revision,
            providerRevision: usable.provider.revision,
          };
        } catch {
          return undefined;
        }
      },
    });
  /** Whether the active version of a saved proposal has limits an ordinary
   * run outgrows (made before limits were sized); a new press resizes it. */
  function outgrown(actor: ProcessActor, processId: string) {
    try {
      const record = deps.registry.getOwned(actor, processId);
      if (!record.activeVersion) return false;
      const sized = fit(
        actor,
        deps.registry.version(actor, processId, record.activeVersion)
          .definition,
      );
      return !("gap" in sized) && sized.changed;
    } catch {
      return false;
    }
  }
  function status(actor: ProcessActor, sessionId: string) {
    const current = deps.store.read(owner(actor), sessionId).status;
    return current.state === "done" &&
      current.processId &&
      outgrown(actor, current.processId)
      ? { ...current, resize: true }
      : current;
  }

  /**
   * Save and turn on, step by step, each through the same store the console
   * uses and under the person's own authority: accept the design (save the
   * draft), freeze a version, run the native test with a generated suite,
   * activate it and optionally add it to the overview. A step that needs a
   * person stops the pipeline there. Each step is idempotent, so a new press
   * after a failure continues from the furthest step reached.
   */
  async function run(
    context: CatalogContext,
    who: Owner,
    scope: Scope,
    request: ProcessProposalAccept,
    language: Language,
    signal: AbortSignal,
  ) {
    const target = {
      organizationId: who.organizationId,
      workspaceId: who.workspaceId,
    };
    const set = (change: (s: ProcessProposalStatus) => ProcessProposalStatus) =>
      context.serial(async () =>
        deps.store.update(who, request.sessionId, change),
      );
    const sessionKey = (...parts: unknown[]) =>
      key(request.sessionId, ...parts);
    const attemptKey = (...parts: unknown[]) =>
      key(request.sessionId, request.requestId, ...parts);
    try {
      // 1. Save the reviewed draft and freeze it.
      const saved = await context.serial(async () => {
        const current = await actorOf(context, target);
        let review = deps.proposals.readReview(current, request.sessionId);
        if (!("owner" in review) || review.owner.type !== "user")
          throw new IdentityError(403, "identity_forbidden");
        if (!review.acceptedProcessId) {
          if (
            review.revision !== request.revision ||
            review.reviewDigest !== request.reviewDigest
          )
            throw new IdentityError(409, "process_proposal_changed");
          // A process whose model can never reserve one call is not saved.
          const before = review.candidate && fit(current, review.candidate);
          if (before && "gap" in before) return before;
          const candidate = processDigest(review.candidate);
          const open = review.assumptions.filter((a) => !a.acknowledged);
          if (open.length) {
            // Only what the card showed is acknowledged by this press.
            if (
              !open.every((a) =>
                request.assumptions.some(
                  (shown) => shown.id === a.id && shown.digest === a.digest,
                ),
              )
            )
              throw new IdentityError(409, "process_proposal_changed");
            deps.proposals.acknowledge(current, {
              ...target,
              sessionId: request.sessionId,
              requestId: attemptKey("acknowledge"),
              revision: review.revision,
              assumptions: review.assumptions.map(({ id, digest }) => ({
                id,
                digest,
              })),
            });
            review = deps.proposals.readReview(current, request.sessionId);
            if (processDigest(review.candidate) !== candidate)
              throw new IdentityError(409, "process_proposal_changed");
          }
          deps.proposals.accept(current, {
            ...target,
            sessionId: request.sessionId,
            requestId: attemptKey("accept"),
            revision: review.revision,
            reviewDigest: review.reviewDigest,
          });
          review = deps.proposals.readReview(current, request.sessionId);
        }
        const processId = review.acceptedProcessId;
        if (!processId)
          throw new IdentityError(409, "process_design_not_ready");
        let record = deps.registry.getOwned(current, processId);
        // Caps sized for the priced reservation of each model call (the
        // designer may write caps no call fits); this saves a new draft.
        const sized = fit(current, record.draft);
        if ("gap" in sized) return { ...sized, processId };
        if (sized.changed) {
          deps.registry.saveWorkspaceDraft(current, {
            id: processId,
            revision: record.revision,
            definition: { ...record.draft, limits: sized.limits },
            owner: { type: "user" },
          });
          record = deps.registry.getOwned(current, processId);
        }
        const latest = record.latestVersion
          ? deps.registry.version(current, processId, record.latestVersion)
          : null;
        // The saved draft is frozen once; a later press reuses that version.
        const version =
          latest &&
          processDigest(latest.definition) === processDigest(record.draft)
            ? latest.version
            : deps.versions.freeze(current, {
                ...target,
                profile: PROCESS_VERSION_PROFILE,
                requestId: sessionKey("freeze", record.revision),
                processId,
                revision: record.revision,
              }).version;
        record = deps.registry.getOwned(current, processId);
        return { processId, version, active: record.activeVersion === version };
      });
      if ("gap" in saved) {
        const { gap, reservation, allowed } = saved;
        return await set((s) => ({
          ...s,
          state: "stopped",
          phase: undefined,
          gap,
          reservation: {
            tokens: reservation.tokens,
            costMicros: reservation.costMicros,
            maxTokens: allowed.tokens,
            maxCostMicros: allowed.costMicros,
            calls: reservation.calls,
          },
          ...("processId" in saved && saved.processId
            ? { processId: saved.processId }
            : {}),
        }));
      }
      await set((s) => ({
        ...s,
        phase: "testing",
        processId: saved.processId,
        version: saved.version,
        gap: undefined,
        reservation: undefined,
      }));
      if (!saved.active) {
        // 2. The native test with a suite generated from the frozen definition.
        const prepared = await context.serial(async () => {
          const current = await actorOf(context, target);
          const artifact = deps.registry.testArtifact(
            current,
            saved.processId,
            saved.version,
          );
          const definition = artifact.definition;
          const genericModelId =
            definition.kind === "agent"
              ? definition.modelId
              : definition.steps.find((step) => step.type === "agent")?.modelId;
          const catalog = deps.catalog.processTestCatalog(
            current.organizationId,
            current.workspaceId,
            current,
            artifact.sources,
            genericModelId,
          );
          return {
            artifact,
            generated: defaultProcessSuite(artifact, catalog, genericModelId),
            revision: deps.registry.getOwned(current, saved.processId).revision,
          };
        });
        if ("gap" in prepared.generated) {
          const gap = prepared.generated.gap;
          return await set((s) => ({
            ...s,
            state: "stopped",
            phase: undefined,
            gap,
          }));
        }
        const job = await deps.testing.start(
          {
            ...target,
            profile: PROCESS_NATIVE_TEST_PROFILE,
            requestId: attemptKey("test"),
            processId: saved.processId,
            revision: prepared.revision,
            version: saved.version,
            artifactDigest: prepared.artifact.digest,
            suite: prepared.generated.suite,
          },
          context,
          signal,
        );
        if (
          job.status !== "completed" ||
          job.qualification?.status !== "qualified"
        )
          throw new IdentityError(409, "process_proposal_test_failed");
        await set((s) => ({ ...s, phase: "activating" }));
        // 3. Activate exactly the tested version.
        await context.serial(async () => {
          const current = await actorOf(context, target);
          const review = deps.activation.review(current, {
            ...target,
            profile: PROCESS_ACTIVATION_PROFILE,
            processId: saved.processId,
            version: saved.version,
            testId: job.testId,
          });
          if (!review.canActivate)
            throw new IdentityError(
              409,
              "process_proposal_activation_unavailable",
            );
          deps.activation.decide(current, {
            ...target,
            profile: PROCESS_ACTIVATION_PROFILE,
            requestId: attemptKey("activate"),
            type: "activate",
            processId: saved.processId,
            revision: review.revision,
            expectedActiveVersion: review.activeVersion,
            version: saved.version,
            artifactDigest: review.artifactDigest,
            testId: job.testId,
            qualificationDigest: review.qualification.qualificationDigest,
            acknowledgement: "controlled_native_test_only",
          });
        });
      }
      // 4. The overview, when the person asked for it.
      let hub: Pick<ProcessProposalStatus, "hub" | "hubFailure"> = {};
      if (request.addToHub) {
        await set((s) => ({ ...s, phase: "hub" }));
        hub = await context.serial(async () => {
          const current = await actorOf(context, target);
          try {
            deps.hub.adopt(current, scope, language, {
              id: sessionKey("hub"),
              processId: saved.processId,
            });
            return { hub: "added" as const };
          } catch (error) {
            if (!(error instanceof IdentityError)) throw error;
            return {
              hub:
                error.code === "hub_item_exists"
                  ? ("added" as const)
                  : ("failed" as const),
              ...(error.code === "hub_item_exists"
                ? {}
                : { hubFailure: error.code }),
            };
          }
        });
      }
      return await set((s) => ({
        ...s,
        state: "done",
        phase: undefined,
        failure: undefined,
        gap: undefined,
        ...hub,
      }));
    } catch (error) {
      const failure = signal.aborted
        ? "process_proposal_interrupted"
        : error instanceof IdentityError &&
            /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
          ? error.code
          : "process_proposal_failed";
      return await set((s) => ({
        ...s,
        state: "failed",
        phase: undefined,
        failure,
      }));
    }
  }

  /**
   * Admits one press: checks the person, the budget and the proposal, then
   * returns the running status and the work to run in the background.
   */
  async function accept(context: CatalogContext, target: Target, raw: unknown) {
    const request = ProcessProposalAcceptSchema.parse(raw);
    return context.serial(async () => {
      const actor = await actorOf(context, target);
      // Members and administrators alike reach only their own proposals.
      const stored = deps.store.read(owner(actor), request.sessionId);
      deps.proposals.readReview(actor, request.sessionId);
      if (
        stored.status.state !== "done" &&
        !designProposalCatalog(deps.catalog, deps.plugins, actor).budgetReady
      )
        throw new IdentityError(409, "process_proposal_budget_not_ready");
      // A finished save starts again only to resize its active version.
      const begun = deps.store.begin(
        owner(actor),
        request,
        stored.status.state === "done" &&
          !!stored.status.processId &&
          outgrown(actor, stored.status.processId),
      );
      return { ...begun, request, owner: owner(actor) };
    });
  }

  return { propose, status, accept, run };
}
export type ProcessProposals = ReturnType<typeof createProcessProposals>;
