import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { IdentityId, OrganizationRole } from "../../packages/protocol/identity";
import {
  WORKSPACE_DESIGN_PROFILE,
  WorkspaceDesignStartSchema,
  WorkspaceDesignReviewSchema,
  type OwnedDesignReview,
  DESIGN_PROFILE,
  DesignStartSchema,
  DesignUpdateSchema,
  DesignAcknowledgeSchema,
  DesignAcceptSchema,
  DesignReviewSchema,
  DesignReceiptSchema,
  emptyDesignBrief,
  type DesignBrief,
  type DesignConfirmation,
  type DesignReview,
  type DesignReceipt,
  DesignSessionSummarySchema,
} from "../../packages/protocol/process-design";
import {
  type ProcessDefinition,
  type ProcessOwner,
} from "../../packages/protocol/service-processes";
import { IdentityError } from "./error";
import { processDigest } from "./process-validation";
import {
  type ServiceProcessStore,
  type ProcessActor,
} from "./service-processes";
import type { ServiceCatalogStore } from "./service-catalog";
import type { WorkspacePluginStore } from "./workspace-plugins";
import { designCapabilityIndex } from "./process-design-capabilities";
import { processDesignDiff } from "./process-design-diff";

type DesignState = {
  id: string;
  serviceId: string | null;
  /** Personal sessions only; older and workspace sessions omit it. */
  owner?: { type: "user"; userId: string };
  revision: number;
  brief: DesignBrief;
  candidate: ProcessDefinition | null;
  baseline: DesignReview["baseline"];
  baselineSources: DesignReview["baselineSources"];
  /** Digest of the process draft this conversation started from. Freezing or
   * activating the process bumps its registry revision without touching the
   * draft, so only a changed draft invalidates the conversation. Older saved
   * conversations lack it and keep the strict revision comparison. */
  baselineDraftDigest?: string;
  confirmation: DesignConfirmation;
  acknowledgments: Record<string, string>;
  acceptedProcessId: string | null;
  updatedAt: string;
};
const actorSchema = z.strictObject({
  organizationId: IdentityId,
  workspaceId: IdentityId,
  userId: IdentityId,
  role: OrganizationRole,
});
const sensitiveKey =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|credential|secret)$/i;
const sensitiveText =
  /(?:\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|https?:\/\/[^\s/@:]+:[^\s/@]+@)/i;
/** A bounded ingestion contract, not a claim to detect arbitrary secrets pasted as plain text. */
export function assertDesignContent(value: unknown) {
  const pending: [unknown, number][] = [[value, 0]];
  let count = 0,
    bytes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop()!;
    if (++count > 6000 || depth > 24)
      throw new IdentityError(400, "process_design_content_limit");
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item);
      if (sensitiveText.test(item))
        throw new IdentityError(400, "process_design_sensitive_content");
    }
    if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        bytes += Buffer.byteLength(key);
        if (
          sensitiveKey.test(key) &&
          (typeof child === "string" ||
            (child &&
              typeof child === "object" &&
              "source" in child &&
              child.source === "literal"))
        )
          throw new IdentityError(400, "process_design_sensitive_content");
        pending.push([child, depth + 1]);
      }
    }
    if (bytes > 65536)
      throw new IdentityError(400, "process_design_content_limit");
  }
}

/** Identity queue only. The caller supplies a freshly authenticated actor; no model or remote I/O. */
export class ProcessDesignStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly registry: ServiceProcessStore,
    private readonly catalog: ServiceCatalogStore,
    private readonly plugins: WorkspacePluginStore,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_process_design (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, data TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_process_design_command (
      command_key TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_process_design(id) ON DELETE CASCADE,
      payload_digest TEXT NOT NULL, receipt TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_process_design_scope ON agent_process_design(organization_id,workspace_id,user_id,id);
    CREATE INDEX IF NOT EXISTS agent_process_design_service_scope ON agent_process_design(organization_id,workspace_id,user_id,json_extract(data,'$.serviceId'),id);`);
  }
  /** Scope only; sessions are creator-private and members may hold only
   * personal sessions (see `row`). */
  private actor(raw: ProcessActor) {
    const actor = actorSchema.parse(raw);
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM agent_workspace WHERE id=? AND organization_id=?",
        )
        .get(actor.workspaceId, actor.organizationId)
    )
      throw new IdentityError(404, "process_design_not_found");
    return actor;
  }
  private target(
    actor: ProcessActor,
    input: { organizationId: string; workspaceId: string },
  ) {
    if (
      actor.organizationId !== input.organizationId ||
      actor.workspaceId !== input.workspaceId
    )
      throw new IdentityError(404, "process_design_not_found");
  }
  private row(actor: ProcessActor, id: string): DesignState {
    IdentityId.parse(id);
    const row = this.db
      .prepare(
        "SELECT data FROM agent_process_design WHERE id=? AND organization_id=? AND workspace_id=? AND user_id=?",
      )
      .get(id, actor.organizationId, actor.workspaceId, actor.userId);
    if (!row) throw new IdentityError(404, "process_design_not_found");
    const state: DesignState = JSON.parse(String(row.data));
    // A member (including a demoted administrator) keeps only personal sessions.
    if (
      actor.role === "member" &&
      (state.owner?.type !== "user" || state.owner.userId !== actor.userId)
    )
      throw new IdentityError(403, "identity_forbidden");
    return state;
  }
  private owner(state: DesignState): ProcessOwner {
    return state.serviceId
      ? { type: "service", serviceId: state.serviceId }
      : (state.owner ?? { type: "workspace" });
  }
  private write(actor: ProcessActor, state: DesignState) {
    this.db
      .prepare(
        "INSERT INTO agent_process_design VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(
        state.id,
        actor.organizationId,
        actor.workspaceId,
        actor.userId,
        JSON.stringify(state),
      );
  }
  private check(state: DesignState, revision: number) {
    if (state.revision !== revision || state.acceptedProcessId)
      throw new IdentityError(409, "process_design_conflict");
  }
  private atomic<T>(run: () => T): T {
    this.db.exec("SAVEPOINT process_design_mutation");
    try {
      const result = run();
      this.db.exec("RELEASE process_design_mutation");
      return result;
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO process_design_mutation; RELEASE process_design_mutation",
      );
      throw error;
    }
  }
  private command(
    actor: ProcessActor,
    type: string,
    input: { requestId: string },
    run: () => DesignReceipt,
  ) {
    const key = processDigest([
      actor.organizationId,
      actor.workspaceId,
      actor.userId,
      input.requestId,
    ]);
    const hash = processDigest({ type, input });
    return this.atomic(() => {
      const old = this.db
        .prepare(
          "SELECT session_id,payload_digest,receipt FROM agent_process_design_command WHERE command_key=?",
        )
        .get(key);
      if (old) {
        this.row(actor, String(old.session_id));
        if (old.payload_digest !== hash)
          throw new IdentityError(409, "process_design_command_conflict");
        return DesignReceiptSchema.parse(JSON.parse(String(old.receipt)));
      }
      const result = DesignReceiptSchema.parse(run());
      this.db
        .prepare("INSERT INTO agent_process_design_command VALUES (?,?,?,?)")
        .run(key, result.sessionId, hash, JSON.stringify(result));
      return result;
    });
  }
  private receipt(
    actor: ProcessActor,
    state: DesignState,
    requestId: string,
    kind: DesignReceipt["kind"],
  ): DesignReceipt {
    return {
      profile: DESIGN_PROFILE,
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      sessionId: state.id,
      requestId,
      revision: state.revision,
      kind,
      processId: state.acceptedProcessId,
    };
  }
  start(raw: ProcessActor, body: unknown) {
    assertDesignContent(body);
    const actor = this.actor(raw),
      input = z
        .union([DesignStartSchema, WorkspaceDesignStartSchema])
        .parse(body);
    this.target(actor, input);
    return this.command(actor, "start", input, () => {
      const serviceId = "serviceId" in input ? input.serviceId : null;
      // Members never own workspace processes: their designer always creates
      // or edits a personal one. Service designer sessions stay admin-only.
      const personal =
        !serviceId &&
        "owner" in input &&
        (input.owner.type === "user" || actor.role === "member");
      if (
        "owner" in input &&
        input.owner.type === "user" &&
        input.owner.userId &&
        input.owner.userId !== actor.userId
      )
        throw new IdentityError(403, "identity_forbidden");
      if (!personal && actor.role === "member")
        throw new IdentityError(403, "identity_forbidden");
      const owner: ProcessOwner = serviceId
        ? { type: "service", serviceId }
        : personal
          ? { type: "user", userId: actor.userId }
          : { type: "workspace" };
      if (
        serviceId &&
        !this.catalog.service(actor.workspaceId, serviceId).enabled
      )
        throw new IdentityError(409, "process_design_service_unavailable");
      const existing = input.processId
        ? this.registry.getOwned(actor, input.processId)
        : null;
      if (
        existing &&
        processDigest(
          "owner" in existing
            ? existing.owner
            : { type: "service", serviceId: existing.serviceId },
        ) !== processDigest(owner)
      )
        throw new IdentityError(409, "process_design_conflict");
      // Reading is not editing: someone else's personal process stays theirs.
      if (existing) this.registry.assertAccess(actor, existing.id, "manage");
      const baseline = existing
        ? {
            processId: existing.id,
            registryRevision: existing.revision,
            version: input.baselineVersion ?? null,
            definition: input.baselineVersion
              ? this.registry.version(actor, existing.id, input.baselineVersion)
                  .definition
              : existing.draft,
          }
        : null;
      assertDesignContent(baseline);
      assertDesignContent(existing?.draft);
      const baselineSources = baseline
        ? baseline.version
          ? this.registry.version(actor, baseline.processId, baseline.version)
              .sources
          : this.registry.validateOwner(actor, owner, baseline.definition)
              .sources
        : null;
      const state: DesignState = {
        id: randomUUID(),
        serviceId,
        ...(owner.type === "user" ? { owner } : {}),
        revision: 1,
        brief: {
          ...emptyDesignBrief(),
          purpose: existing?.draft.description || existing?.draft.name || "",
        },
        candidate: existing?.draft ?? null,
        baseline,
        baselineSources,
        ...(existing
          ? { baselineDraftDigest: processDigest(existing.draft) }
          : {}),
        confirmation: input.confirmation,
        acknowledgments: {},
        acceptedProcessId: null,
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.write(actor, state);
      this.readReview(actor, state.id);
      return this.receipt(actor, state, input.requestId, "started");
    });
  }
  update(raw: ProcessActor, body: unknown) {
    assertDesignContent(body);
    const actor = this.actor(raw),
      input = DesignUpdateSchema.parse(body);
    this.target(actor, input);
    return this.command(actor, "update", input, () => {
      const state = this.row(actor, input.sessionId);
      this.check(state, input.revision);
      state.brief = input.brief;
      state.candidate = input.candidate;
      state.acknowledgments = Object.fromEntries(
        state.brief.assumptions
          .filter((a) => state.acknowledgments[a.id] === processDigest(a))
          .map((a) => [a.id, state.acknowledgments[a.id]!]),
      );
      state.revision++;
      state.updatedAt = new Date(this.now()).toISOString();
      this.write(actor, state);
      this.readReview(actor, state.id);
      return this.receipt(actor, state, input.requestId, "updated");
    });
  }
  /** This entry point is a human command; it must never be exposed as a model tool. */
  acknowledge(raw: ProcessActor, body: unknown) {
    const actor = this.actor(raw),
      input = DesignAcknowledgeSchema.parse(body);
    this.target(actor, input);
    return this.command(actor, "acknowledge", input, () => {
      const state = this.row(actor, input.sessionId);
      this.check(state, input.revision);
      for (const item of input.assumptions) {
        const current = state.brief.assumptions.find((a) => a.id === item.id);
        if (!current || processDigest(current) !== item.digest)
          throw new IdentityError(409, "process_design_conflict");
        state.acknowledgments[item.id] = item.digest;
      }
      if (input.confirmation) state.confirmation = input.confirmation;
      state.revision++;
      state.updatedAt = new Date(this.now()).toISOString();
      this.write(actor, state);
      this.readReview(actor, state.id);
      return this.receipt(actor, state, input.requestId, "acknowledged");
    });
  }
  get(raw: ProcessActor, id: string): DesignReview {
    const review = this.readReview(raw, id);
    if (review.profile !== DESIGN_PROFILE)
      throw new IdentityError(404, "process_design_not_found");
    return review;
  }
  getWorkspace(raw: ProcessActor, id: string) {
    const review = this.readReview(raw, id);
    if (review.profile !== WORKSPACE_DESIGN_PROFILE)
      throw new IdentityError(404, "process_design_not_found");
    return review;
  }
  /** Session summaries stay private to the authenticated owner and service. */
  listServiceSessions(raw: ProcessActor, serviceId: string, after?: string) {
    const actor = this.actor(raw);
    if (actor.role === "member")
      throw new IdentityError(403, "identity_forbidden");
    IdentityId.parse(serviceId);
    if (after) IdentityId.parse(after);
    const rows = this.db
      .prepare(
        `SELECT data FROM agent_process_design
         WHERE organization_id=? AND workspace_id=? AND user_id=?
           AND json_extract(data,'$.serviceId')=? AND id>?
         ORDER BY id LIMIT 101`,
      )
      .all(
        actor.organizationId,
        actor.workspaceId,
        actor.userId,
        serviceId,
        after ?? "",
      );
    const sessions = rows.slice(0, 100).map((row) => {
      const state = JSON.parse(String(row.data)) as DesignState;
      return DesignSessionSummarySchema.parse({
        id: state.id,
        serviceId: state.serviceId,
        revision: state.revision,
        purpose: state.brief.purpose,
        acceptedProcessId: state.acceptedProcessId,
        updatedAt: state.updatedAt,
      });
    });
    return {
      sessions,
      nextAfter: rows.length > 100 ? sessions[99]!.id : null,
    };
  }
  assertAvailable(raw: ProcessActor, id: string) {
    const actor = this.actor(raw),
      state = this.row(actor, id);
    if (
      state.serviceId &&
      !this.catalog.service(actor.workspaceId, state.serviceId).enabled
    )
      throw new IdentityError(409, "process_design_service_unavailable");
  }
  readReview(raw: ProcessActor, id: string): OwnedDesignReview {
    const actor = this.actor(raw),
      state = this.row(actor, id);
    const limits = this.registry.effectiveLimits();
    const index = designCapabilityIndex(this.catalog, this.plugins, actor, {
      limits,
    });
    const actions = new Map(
      [...index.actions].filter(([, action]) => action.status === "configured"),
    );
    const models = index.models;
    const blockers: DesignReview["blockers"] = [];
    if (!state.brief.purpose) blockers.push("purpose_missing");
    if (!state.candidate) blockers.push("candidate_missing");
    if (state.brief.questions.length) blockers.push("questions_unresolved");
    const assumptions = state.brief.assumptions.map((a) => ({
      id: a.id,
      digest: processDigest(a),
      acknowledged: state.acknowledgments[a.id] === processDigest(a),
    }));
    if (assumptions.some((a) => !a.acknowledged))
      blockers.push("assumptions_unacknowledged");
    if (state.confirmation === "grouped")
      blockers.push("confirmation_unsupported");
    const references =
      state.candidate?.kind === "agent"
        ? state.candidate.capabilities
        : (state.candidate?.steps.flatMap((s) =>
            s.type === "action"
              ? [s]
              : s.type === "agent"
                ? s.capabilities
                : [],
          ) ?? []);
    const agentModels =
      state.candidate?.kind === "agent"
        ? [state.candidate.modelId]
        : (state.candidate?.steps.flatMap((s) =>
            s.type === "agent" ? [s.modelId] : [],
          ) ?? []);
    if (
      references.some((c) => !actions.has(c.serviceId + ":" + c.actionId)) ||
      agentModels.some((id) => !models.has(id))
    )
      blockers.push("capability_unavailable");
    if (
      references.some(
        (c) => !!actions.get(c.serviceId + ":" + c.actionId)?.schemaUnavailable,
      )
    )
      blockers.push("capability_schema_unavailable");
    if (
      state.confirmation === "every_write" &&
      references.some((c) => {
        const a = actions.get(c.serviceId + ":" + c.actionId);
        return a?.effect === "write" && a.approval !== "always";
      })
    )
      blockers.push("confirmation_mismatch");
    if (state.baseline && !state.acceptedProcessId) {
      try {
        const current = this.registry.getOwned(actor, state.baseline.processId);
        if (
          current.revision !== state.baseline.registryRevision &&
          (!state.baselineDraftDigest ||
            processDigest(current.draft) !== state.baselineDraftDigest)
        )
          blockers.push("registry_changed");
      } catch {
        blockers.push("registry_changed");
      }
    }
    const validation = this.registry.validateOwner(
      actor,
      this.owner(state),
      state.candidate,
    );
    const dependencyComparison: DesignReview["dependencyComparison"] =
      !validation.sources || (state.baseline && !state.baselineSources)
        ? "unavailable"
        : state.baseline
          ? "recorded"
          : "new";
    const dependencyChanges: DesignReview["dependencyChanges"] = [];
    if (dependencyComparison !== "unavailable") {
      const before = new Map(
        (state.baselineSources?.resources ?? []).map((r) => [
          r.kind + ":" + r.id,
          r,
        ]),
      );
      const after = new Map(
        (validation.sources?.resources ?? []).map((r) => [
          r.kind + ":" + r.id,
          r,
        ]),
      );
      for (const key of [
        ...new Set([...before.keys(), ...after.keys()]),
      ].sort()) {
        const left = before.get(key),
          right = after.get(key),
          resource = right ?? left!;
        if (left?.revision !== right?.revision)
          dependencyChanges.push({
            kind: resource.kind,
            id: resource.id,
            beforeRevision: left?.revision ?? null,
            afterRevision: right?.revision ?? null,
          });
      }
    }
    const value = {
      ...(state.serviceId === null
        ? {
            profile: WORKSPACE_DESIGN_PROFILE,
            owner: state.owner ?? { type: "workspace" as const },
          }
        : { profile: DESIGN_PROFILE, serviceId: state.serviceId }),
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      id: state.id,
      revision: state.revision,
      brief: state.brief,
      candidate: state.candidate,
      baseline: state.baseline,
      baselineSources: state.baselineSources,
      dependencyComparison,
      dependencyChanges,
      confirmation: state.confirmation,
      assumptions,
      validation,
      blockers,
      ...processDesignDiff(state.baseline?.definition ?? null, state.candidate),
      capabilityFingerprint: index.fingerprint,
      acceptedProcessId: state.acceptedProcessId,
      updatedAt: state.updatedAt,
    };
    return (
      state.serviceId === null
        ? WorkspaceDesignReviewSchema
        : DesignReviewSchema
    ).parse({
      ...value,
      reviewDigest: processDigest(value),
    });
  }
  /** Exact reviewed metadata only. Nested savepoints make draft, audit and receipt atomic. */
  accept(raw: ProcessActor, body: unknown) {
    const actor = this.actor(raw),
      input = DesignAcceptSchema.parse(body);
    this.target(actor, input);
    return this.command(actor, "accept", input, () => {
      const state = this.row(actor, input.sessionId);
      this.check(state, input.revision);
      const review = this.readReview(actor, state.id);
      if (review.reviewDigest !== input.reviewDigest)
        throw new IdentityError(409, "process_design_review_changed");
      if (
        !review.validation.valid ||
        review.blockers.length ||
        !state.candidate
      )
        throw new IdentityError(400, "process_design_not_ready");
      // The review above proved the draft is still the one this conversation
      // started from, so a freeze or activation since then is not a conflict.
      const save = {
        ...(state.baseline ? { id: state.baseline.processId } : {}),
        revision: state.baseline
          ? this.registry.getOwned(actor, state.baseline.processId).revision
          : 0,
        definition: state.candidate,
      };
      const saved =
        state.serviceId === null
          ? this.registry.saveWorkspaceDraft(actor, {
              ...save,
              owner: state.owner ?? { type: "workspace" },
            })
          : this.registry.saveDraft(actor, {
              ...save,
              serviceId: state.serviceId,
            });
      state.acceptedProcessId = saved.id;
      state.revision++;
      state.updatedAt = new Date(this.now()).toISOString();
      this.write(actor, state);
      return this.receipt(actor, state, input.requestId, "accepted");
    });
  }
}
