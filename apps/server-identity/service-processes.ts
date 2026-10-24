import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  OwnedProcessRecordSchema,
  ProcessOwnerSchema,
  ProcessOwnerRequestSchema,
  type ProcessOwner,
  type ProcessOwnerRequest,
  type OwnedProcessRecord,
  ProcessDefinitionSchema,
  ProcessLimitsSchema,
  ProcessRecordSchema,
  ProcessVersionSchema,
  ProcessSourceManifestSchema,
  type ProcessDefinition,
  type ProcessRecord,
  type ProcessVersion,
  type ProcessLimits,
} from "../../packages/protocol/service-processes";
import { IdentityId, OrganizationRole } from "../../packages/protocol/identity";
import type { Scope } from "../../packages/protocol";
import {
  PROCESS_EXECUTION_PROFILE,
  ProcessExecutionInventorySchema,
  ProcessExecutionQuerySchema,
  type ProcessExecutionEntry,
} from "../../packages/protocol/process-execution";
import type { AuditRecord } from "../../packages/protocol/audit";
import type { ServiceCatalogStore } from "./service-catalog";
import type { WorkspacePluginStore } from "./workspace-plugins";
import { IdentityError } from "./error";
import {
  migrateProcessOwners,
  processOwnerTable,
} from "./process-owner-migration";
import {
  DEFAULT_PROCESS_LIMITS,
  processDigest,
  validateProcessDefinition,
} from "./process-validation";

/** Supplied by authenticated server context; request bodies cannot supply an actor. */
export type ProcessActor = {
  organizationId: string;
  workspaceId: string;
  userId: string;
  role: "owner" | "admin" | "member";
};
const actorSchema = z.strictObject({
  organizationId: IdentityId,
  workspaceId: IdentityId,
  userId: IdentityId,
  role: OrganizationRole,
});
const versionNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const expectedRevision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const NativeProcessQualificationReferenceSchema = z.strictObject({
  serverId: IdentityId,
  creatorUserId: IdentityId,
  testId: IdentityId,
  qualificationDigest: digest,
});
export type NativeProcessQualificationReference = z.infer<
  typeof NativeProcessQualificationReferenceSchema
>;
export const PROCESS_TEST_SCENARIOS = [
  "success",
  "rejection",
  "missing_input",
  "failure",
  "unknown",
  "restart",
] as const;
const testEvidenceSchema = z
  .strictObject({
    testId: IdentityId,
    digest,
    runnerVersion: z.string().min(1).max(160),
    passed: z.boolean(),
    scenarios: z.array(z.enum(PROCESS_TEST_SCENARIOS)).max(6),
    reportDigest: digest,
  })
  .refine((v) => new Set(v.scenarios).size === v.scenarios.length);
type ProcessRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  service_id: string | null;
  owner_type: "service" | "workspace" | "user";
  owner_user_id: string | null;
  revision: number;
  draft: string;
  active_version: number | null;
  updated_at: string;
  /** Set when the owner deleted (archived) a personal process. */
  archived_at?: string | null;
};
/**
 * What a person may do with one process row:
 * - `read`: metadata, drafts and immutable versions (management console);
 * - `manage`: draft, freeze, test, activate or roll back;
 * - `execute`: inventory, start, pin and resume a run.
 *
 * Service and workspace processes keep their original rules: owners/admins read
 * and manage, and anyone in the workspace may execute under their own current
 * permissions. A personal process (`owner_type='user'`) is visible, managed
 * and executed only by its owner, whatever their role. Administrators may read
 * another person's personal process but never change, test or run it.
 */
export type ProcessAccess = "read" | "manage" | "execute";
/** Synchronous identity-queue store. Definitions/metadata only: never model or service I/O. */
export class ServiceProcessStore {
  private readonly limits;
  private readonly now: () => number;
  private nativeQualificationGate?: (
    actor: ProcessActor,
    artifact: ProcessVersion,
    reference: NativeProcessQualificationReference,
  ) => void;
  constructor(
    private readonly db: DatabaseSync,
    private readonly catalog: ServiceCatalogStore,
    private readonly plugins: WorkspacePluginStore,
    private readonly audit: (record: AuditRecord) => void,
    options: {
      limits?: z.input<typeof ProcessLimitsSchema>;
      now?: () => number;
    } = {},
  ) {
    this.limits = Object.freeze(
      ProcessLimitsSchema.parse(options.limits ?? DEFAULT_PROCESS_LIMITS),
    );
    this.now = options.now ?? Date.now;
    migrateProcessOwners(db);
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE name='agent_service_process'",
        )
        .get()
    )
      db.exec(processOwnerTable("agent_service_process"));
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS agent_service_process_owner_immutable
        BEFORE UPDATE OF owner_type,service_id,organization_id,workspace_id ON agent_service_process
        WHEN NEW.owner_type IS NOT OLD.owner_type OR NEW.service_id IS NOT OLD.service_id
          OR NEW.organization_id IS NOT OLD.organization_id OR NEW.workspace_id IS NOT OLD.workspace_id
        BEGIN SELECT RAISE(ABORT,'process_owner_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS agent_service_process_owner_user_immutable
        BEFORE UPDATE OF owner_user_id ON agent_service_process
        WHEN NEW.owner_user_id IS NOT OLD.owner_user_id
        BEGIN SELECT RAISE(ABORT,'process_owner_immutable'); END;
      CREATE INDEX IF NOT EXISTS agent_service_process_scope ON agent_service_process(organization_id,workspace_id,id);
      CREATE INDEX IF NOT EXISTS agent_service_process_personal ON agent_service_process(organization_id,workspace_id,owner_user_id,id) WHERE owner_type='user';
      CREATE TABLE IF NOT EXISTS agent_service_process_version (
        process_id TEXT NOT NULL REFERENCES agent_service_process(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, definition TEXT NOT NULL, sources TEXT NOT NULL, digest TEXT NOT NULL,
        created_at TEXT NOT NULL, created_by TEXT NOT NULL,
        PRIMARY KEY(process_id,version)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS agent_service_process_version_immutable
        BEFORE UPDATE ON agent_service_process_version BEGIN SELECT RAISE(ABORT,'process_version_immutable'); END;
      CREATE TABLE IF NOT EXISTS agent_service_process_test (
        id INTEGER PRIMARY KEY AUTOINCREMENT, test_id TEXT UNIQUE NOT NULL, process_id TEXT NOT NULL,
        version INTEGER NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(process_id,version) REFERENCES agent_service_process_version(process_id,version) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_service_process_test_version ON agent_service_process_test(process_id,version,id);
      CREATE TABLE IF NOT EXISTS agent_service_process_qualification (
        process_id TEXT NOT NULL, version INTEGER NOT NULL, reference TEXT NOT NULL,
        PRIMARY KEY(process_id,version),
        FOREIGN KEY(process_id,version) REFERENCES agent_service_process_version(process_id,version) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_service_process_run (
        run_id TEXT PRIMARY KEY, process_id TEXT NOT NULL, version INTEGER NOT NULL,
        organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(process_id,version) REFERENCES agent_service_process_version(process_id,version) ON DELETE CASCADE
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS agent_service_process_run_immutable
        BEFORE UPDATE ON agent_service_process_run BEGIN SELECT RAISE(ABORT,'process_run_immutable'); END;
    `);
    // Added after the owner migration so that every earlier shape gains it.
    if (
      !db
        .prepare("PRAGMA table_info(agent_service_process)")
        .all()
        .some((column) => column.name === "archived_at")
    )
      db.exec("ALTER TABLE agent_service_process ADD COLUMN archived_at TEXT");
  }
  /** Scope only. Row access is decided per process by `access`. */
  private actor(raw: ProcessActor) {
    const actor = actorSchema.parse(raw);
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM agent_workspace WHERE id=? AND organization_id=?",
        )
        .get(actor.workspaceId, actor.organizationId)
    )
      throw new IdentityError(404, "process_not_found");
    return actor;
  }
  /** Service and workspace processes are managed only by owners/admins. */
  private manager(actor: ProcessActor) {
    if (actor.role === "member")
      throw new IdentityError(403, "identity_forbidden");
  }
  private access(actor: ProcessActor, row: ProcessRow, mode: ProcessAccess) {
    if (row.owner_type === "user") {
      if (row.owner_user_id === actor.userId) return;
      // Someone else's personal process: administrators may only read it;
      // everyone else, including for execution, must not learn it exists.
      if (actor.role !== "member" && mode === "read") return;
      if (actor.role !== "member" && mode === "manage")
        throw new IdentityError(403, "process_personal_read_only");
      throw new IdentityError(404, "process_not_found");
    }
    if (mode !== "execute") this.manager(actor);
  }
  /** The owner a new draft is bound to. A personal owner is always the actor. */
  private boundOwner(
    actor: ProcessActor,
    requested: ProcessOwner | ProcessOwnerRequest,
  ): ProcessOwner {
    if (requested.type !== "user") {
      this.manager(actor);
      return ProcessOwnerSchema.parse(requested);
    }
    const owner = ProcessOwnerRequestSchema.parse(requested);
    if (owner.type === "user" && owner.userId && owner.userId !== actor.userId)
      throw new IdentityError(403, "identity_forbidden");
    return { type: "user", userId: actor.userId };
  }
  private rowOwner(row: ProcessRow): ProcessOwner {
    return row.owner_type === "service"
      ? { type: "service", serviceId: row.service_id! }
      : row.owner_type === "user"
        ? { type: "user", userId: row.owner_user_id! }
        : { type: "workspace" };
  }
  /** Throws exactly what a lifecycle step on this process would (404/403). */
  assertAccess(raw: ProcessActor, id: string, mode: ProcessAccess) {
    this.row(this.actor(raw), id, mode);
  }
  /** Whether this actor may currently manage the process, without throwing. */
  canManage(raw: ProcessActor, id: string) {
    try {
      this.assertAccess(raw, id, "manage");
      return true;
    } catch (error) {
      if (error instanceof IdentityError) return false;
      throw error;
    }
  }
  private atomic<T>(run: () => T): T {
    this.db.exec("SAVEPOINT process_mutation");
    try {
      const result = run();
      this.db.exec("RELEASE process_mutation");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO process_mutation; RELEASE process_mutation");
      throw error;
    }
  }
  /** An archived (deleted) process behaves as missing, except where a caller
   * reads the provenance of runs that already exist (`archived`). */
  private row(
    actor: ProcessActor,
    id: string,
    mode: ProcessAccess,
    archived = false,
  ) {
    IdentityId.parse(id);
    const row = this.db
      .prepare(
        "SELECT * FROM agent_service_process WHERE id=? AND organization_id=? AND workspace_id=?",
      )
      .get(id, actor.organizationId, actor.workspaceId) as
      | ProcessRow
      | undefined;
    if (!row || (row.archived_at && !archived))
      throw new IdentityError(404, "process_not_found");
    this.access(actor, row, mode);
    return row;
  }
  private check(row: ProcessRow | undefined, revision: number) {
    expectedRevision.parse(revision);
    if ((row?.revision ?? 0) !== revision)
      throw new IdentityError(409, "process_conflict");
  }
  private changed(
    actor: ProcessActor,
    row: ProcessRow,
    event: NonNullable<AuditRecord["details"]["processEvent"]> = "draft_saved",
    version?: number,
  ) {
    this.audit({
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      source: "console",
      action: "catalog.process_changed",
      targetId: row.id,
      outcome: "succeeded",
      details: {
        revision: row.revision,
        previousRevision: row.revision - 1,
        processEvent: event,
        ...(version ? { processVersion: version } : {}),
      },
    });
  }
  private bump(
    actor: ProcessActor,
    row: ProcessRow,
    event: NonNullable<AuditRecord["details"]["processEvent"]>,
    version: number,
  ) {
    this.db
      .prepare(
        "UPDATE agent_service_process SET revision=revision+1,updated_at=? WHERE id=?",
      )
      .run(new Date(this.now()).toISOString(), row.id);
    const current = this.row(actor, row.id, "manage");
    this.changed(actor, current, event, version);
    return current;
  }
  private summary(row: ProcessRow) {
    const definition = ProcessDefinitionSchema.parse(JSON.parse(row.draft));
    return {
      id: row.id,
      ...(row.owner_type === "workspace"
        ? { owner: { type: "workspace" as const } }
        : row.owner_type === "user"
          ? { owner: { type: "user" as const, userId: row.owner_user_id! } }
          : { serviceId: row.service_id! }),
      revision: row.revision,
      name: definition.name,
      kind: definition.kind,
      latestVersion: Number(
        this.db
          .prepare(
            "SELECT max(version) AS version FROM agent_service_process_version WHERE process_id=?",
          )
          .get(row.id)?.version ?? 0,
      ),
      activeVersion: row.active_version,
      updatedAt: row.updated_at,
    };
  }
  list(raw: ProcessActor, after?: string) {
    this.manager(actorSchema.parse(raw));
    const result = this.listOwned(raw, after, true);
    return {
      ...result,
      processes: result.processes.map((p) =>
        ProcessRecordSchema.omit({ draft: true }).parse(p),
      ),
    };
  }
  /** Owners/admins page through every row, including other people's personal
   * processes (read-only). A member pages through their own personal ones. */
  listOwned(raw: ProcessActor, after?: string, serviceOnly = false) {
    const actor = this.actor(raw);
    if (after) IdentityId.parse(after);
    const member = actor.role === "member";
    const rows = this.db
      .prepare(
        "SELECT * FROM agent_service_process WHERE organization_id=? AND workspace_id=? AND archived_at IS NULL AND id>? AND (?=0 OR owner_type='service') AND (?=0 OR (owner_type='user' AND owner_user_id=?)) ORDER BY id LIMIT 101",
      )
      .all(
        actor.organizationId,
        actor.workspaceId,
        after ?? "",
        serviceOnly ? 1 : 0,
        member ? 1 : 0,
        actor.userId,
      ) as ProcessRow[];
    return {
      processes: rows.slice(0, 100).map((row) => ({
        ...this.summary(row),
        ...(this.retestNeeded(actor, row)
          ? { retestNeeded: true as const }
          : {}),
      })),
      nextAfter: rows.length > 100 ? rows[99]!.id : null,
    };
  }
  /**
   * The active version is blocked for this manager in a way only a new test
   * fixes (the app shows it as "Blocked: its service setup changed"). Rows
   * they can't run, like someone else's personal process, say nothing.
   */
  private retestNeeded(actor: ProcessActor, row: ProcessRow) {
    if (row.active_version === null) return false;
    try {
      const entry = this.executionEntry(actor, row);
      return (
        entry?.availability === "blocked" &&
        (entry.reason === "source_changed" ||
          entry.reason === "qualification_required")
      );
    } catch {
      return false;
    }
  }
  /** Passive service-owned management inventory, including inactive drafts. */
  listServiceOwned(raw: ProcessActor, serviceId: string, after?: string) {
    const actor = this.actor(raw);
    this.manager(actor);
    IdentityId.parse(serviceId);
    if (after) IdentityId.parse(after);
    const rows = this.db
      .prepare(
        "SELECT * FROM agent_service_process WHERE organization_id=? AND workspace_id=? AND owner_type='service' AND archived_at IS NULL AND service_id=? AND id>? ORDER BY id LIMIT 101",
      )
      .all(
        actor.organizationId,
        actor.workspaceId,
        serviceId,
        after ?? "",
      ) as ProcessRow[];
    return {
      drafts: rows.slice(0, 100).map((row) => this.summary(row)),
      nextAfter: rows.length > 100 ? rows[99]!.id : null,
    };
  }
  /** Current execution authority, independent of management visibility and drafts. */
  private executionEntry(
    actor: ProcessActor,
    row: ProcessRow,
  ): ProcessExecutionEntry | undefined {
    const artifact = this.versionValue(
      actor,
      row.id,
      row.active_version!,
      "execute",
    );
    const definition = artifact.definition;
    const capabilities =
      definition.kind === "agent"
        ? definition.capabilities
        : definition.steps.flatMap((step) =>
            step.type === "action"
              ? [step]
              : step.type === "agent"
                ? step.capabilities
                : [],
          );
    const models =
      definition.kind === "agent"
        ? [definition]
        : definition.steps.filter((step) => step.type === "agent");
    let reason:
      | Extract<ProcessExecutionEntry, { availability: "blocked" }>["reason"]
      | undefined;
    // Missing or inaccessible dependencies must not reveal a private process.
    const serviceIds = [
      ...new Set([
        ...(row.service_id ? [row.service_id] : []),
        ...capabilities.map((c) => c.serviceId),
      ]),
    ];
    for (const id of serviceIds) {
      let service;
      try {
        service = this.catalog.service(actor.workspaceId, id);
      } catch {
        return undefined;
      }
      if (!this.catalog.serviceAllowed(service, actor.workspaceId, actor))
        return undefined;
      if (!service.enabled) reason = "service_unavailable";
      for (const cap of capabilities.filter((c) => c.serviceId === id)) {
        const action = service.actions.find((a) => a.id === cap.actionId);
        if (!action) return undefined;
        if (!this.catalog.allowed(action, actor)) {
          // Switched off for the person's own account: they still see the
          // process, but it cannot start until they turn the action back on.
          if (
            this.catalog.personalChoice(
              actor.workspaceId,
              id,
              action,
              actor.userId,
            )?.enabled !== false
          )
            return undefined;
          reason = "service_unavailable";
        }
        if (!action.enabled) reason = "service_unavailable";
        const connection =
          this.catalog.oauth?.executionReady(
            {
              workspaceId: actor.workspaceId,
              serviceId: id,
              serviceUrl: service.url,
              serviceRevision: service.revision,
            },
            actor.userId,
            action.effect,
          ) ?? "shared";
        if (connection === false) reason ??= "connection_required";
        if (
          service.auth.type !== "none" &&
          !service.hasCredential &&
          connection !== "personal"
        )
          reason ??= "connection_required";
      }
    }
    for (const node of models) {
      try {
        const selected = this.catalog.processModelMetadata(
          actor.organizationId,
          node.modelId,
        );
        if (
          !this.catalog.processProviderAvailable(
            actor.organizationId,
            selected.provider.id,
          ) ||
          !this.catalog.inferenceBudget.canStartModel(
            actor.organizationId,
            actor.workspaceId,
            selected,
            definition.limits,
          )
        )
          reason ??= "budget_unavailable";
      } catch {
        reason ??= "model_unavailable";
      }
    }
    if (!reason) {
      try {
        this.activeRunVersion(actor, row.id, {
          version: artifact.version,
          artifactDigest: artifact.digest,
        });
      } catch (error) {
        reason =
          error instanceof IdentityError &&
          ["process_sources_changed", "process_definition_invalid"].includes(
            error.code,
          )
            ? "source_changed"
            : "qualification_required";
      }
    }
    const summary = {
      processId: row.id,
      name: definition.name,
      description: definition.description,
      kind: definition.kind,
      version: artifact.version,
      artifactDigest: artifact.digest,
      ...(row.owner_type === "user" ? { personal: true as const } : {}),
    };
    return reason
      ? { ...summary, availability: "blocked", reason }
      : {
          ...summary,
          availability: "ready",
          inputSchema: definition.inputSchema,
        };
  }
  /**
   * What the frozen version's service actions can do with nobody watching,
   * under the current catalog policy: "read" when every action only reads,
   * "approval" when every writing action waits for the person's approval at
   * run time, "write" otherwise. Anything unknown or inaccessible counts as
   * "write". The hub runs only "read" and "approval" processes unattended.
   */
  unattendedEffect(
    raw: ProcessActor,
    id: string,
    expected: { version: number; artifactDigest: string },
  ): "read" | "approval" | "write" {
    try {
      const actor = this.actor(raw),
        row = this.row(actor, id, "execute");
      if (row.active_version !== expected.version) return "write";
      const artifact = this.versionValue(
        actor,
        id,
        expected.version,
        "execute",
      );
      if (artifact.digest !== expected.artifactDigest) return "write";
      const definition = artifact.definition;
      const capabilities =
        definition.kind === "agent"
          ? definition.capabilities
          : definition.steps.flatMap((step) =>
              step.type === "action"
                ? [step]
                : step.type === "agent"
                  ? step.capabilities
                  : [],
            );
      let effect: "read" | "approval" = "read";
      for (const capability of capabilities) {
        // Under a personal account the person's own approval choice counts.
        const action = this.catalog
          .serviceFor(actor.workspaceId, capability.serviceId, actor.userId)
          .actions.find((value) => value.id === capability.actionId);
        if (!action) return "write";
        if (action.effect === "read") continue;
        if (action.approval !== "always") return "write";
        effect = "approval";
      }
      return effect;
    } catch {
      return "write";
    }
  }
  /**
   * The output schema of exactly this active, frozen version (the overview's
   * widgets are checked against it); undefined when it is not that version
   * any more or the person cannot run it.
   */
  activeOutputSchema(
    raw: ProcessActor,
    id: string,
    expected: { version: number; artifactDigest: string },
  ) {
    try {
      const actor = this.actor(raw),
        row = this.row(actor, id, "execute");
      if (row.active_version !== expected.version) return undefined;
      const artifact = this.versionValue(
        actor,
        id,
        expected.version,
        "execute",
      );
      if (artifact.digest !== expected.artifactDigest) return undefined;
      return artifact.definition.outputSchema;
    } catch {
      return undefined;
    }
  }
  executionInventory(raw: ProcessActor, scope: Scope, query: unknown = {}) {
    const actor = this.actor(raw);
    if (
      scope.workspaceId !== actor.workspaceId ||
      scope.userId !== actor.userId
    )
      throw new IdentityError(403, "identity_forbidden");
    const { after, fingerprint } = ProcessExecutionQuerySchema.parse(query);
    const rows = this.db
      .prepare(
        "SELECT id,organization_id,workspace_id,service_id,owner_type,owner_user_id,revision,active_version,updated_at FROM agent_service_process WHERE organization_id=? AND workspace_id=? AND active_version IS NOT NULL AND archived_at IS NULL AND (owner_type<>'user' OR owner_user_id=?) ORDER BY id LIMIT 1001",
      )
      .all(
        actor.organizationId,
        actor.workspaceId,
        actor.userId,
      ) as ProcessRow[];
    if (rows.length > 1000)
      throw new IdentityError(409, "process_inventory_limit");
    const entries = rows.flatMap((row) => {
      const entry = this.executionEntry(actor, row);
      return entry ? [entry] : [];
    });
    const current = processDigest({ scope, actor, entries });
    if (fingerprint && fingerprint !== current)
      throw new IdentityError(409, "process_inventory_changed");
    if (after && !entries.some((entry) => entry.processId === after))
      throw new IdentityError(409, "process_inventory_changed");
    const available = entries.filter(
      (entry) => !after || entry.processId > after,
    );
    return ProcessExecutionInventorySchema.parse({
      profile: PROCESS_EXECUTION_PROFILE,
      scope,
      fingerprint: current,
      processes: available.slice(0, 100),
      nextAfter: available.length > 100 ? available[99]!.processId : null,
    });
  }
  /** Full artifact is private to the server; form responses use a strict projection. */
  executionArtifact(
    raw: ProcessActor,
    id: string,
    expected: { version: number; artifactDigest: string },
  ) {
    const actor = this.actor(raw),
      row = this.row(actor, id, "execute");
    if (!row.active_version) throw new IdentityError(404, "process_not_found");
    const entry = this.executionEntry(actor, row);
    if (!entry) throw new IdentityError(404, "process_not_found");
    if (
      entry.version !== expected.version ||
      entry.artifactDigest !== expected.artifactDigest
    )
      throw new IdentityError(409, "process_active_version_changed");
    if (entry.availability === "blocked")
      throw new IdentityError(409, "process_execution_unavailable");
    return this.activeRunVersion(actor, id, expected);
  }
  get(raw: ProcessActor, id: string): ProcessRecord {
    const value = this.getOwned(raw, id);
    if (!value.serviceId) throw new IdentityError(404, "process_not_found");
    return ProcessRecordSchema.parse(value);
  }
  getOwned(raw: ProcessActor, id: string): OwnedProcessRecord {
    const row = this.row(this.actor(raw), id, "read");
    return OwnedProcessRecordSchema.parse({
      ...this.summary(row),
      draft: JSON.parse(row.draft),
    });
  }
  validate(raw: ProcessActor, serviceId: string, definition: unknown) {
    return this.validateOwner(raw, { type: "service", serviceId }, definition);
  }
  /** Validates under the actor's own current authority. A personal owner is
   * always the actor, so a personal process can only reference services and
   * actions its owner may use. */
  validateOwner(
    raw: ProcessActor,
    rawOwner: ProcessOwner | ProcessOwnerRequest,
    definition: unknown,
  ) {
    const actor = this.actor(raw);
    const owner = this.boundOwner(actor, rawOwner);
    const serviceId = owner.type === "service" ? owner.serviceId : undefined;
    return validateProcessDefinition(definition, {
      ...actor,
      serviceId: serviceId ?? undefined,
      actor,
      catalog: this.catalog,
      plugins: this.plugins,
      limits: this.limits,
    });
  }
  /** The designer and passive validator advertise the same server-owned limits. */
  effectiveLimits(): ProcessLimits {
    return { ...this.limits };
  }
  private ready(
    actor: ProcessActor,
    serviceId: string | null,
    definition: ProcessDefinition,
  ) {
    const result = validateProcessDefinition(definition, {
      ...actor,
      serviceId: serviceId ?? undefined,
      actor,
      catalog: this.catalog,
      plugins: this.plugins,
      limits: this.limits,
    });
    if (!result.valid || !result.sources)
      throw new IdentityError(400, "process_definition_invalid");
    return result.sources;
  }
  saveDraft(
    raw: ProcessActor,
    input: {
      id?: string;
      serviceId: string;
      revision: number;
      definition: ProcessDefinition;
    },
  ): ProcessRecord {
    const { serviceId, ...rest } = input;
    IdentityId.parse(serviceId);
    return ProcessRecordSchema.parse(
      this.saveOwnedDraft(raw, {
        ...rest,
        owner: { type: "service", serviceId },
      }),
    );
  }
  /** Workspace (default) or personal draft; the owner never changes on edit. */
  saveWorkspaceDraft(
    raw: ProcessActor,
    input: {
      id?: string;
      revision: number;
      definition: ProcessDefinition;
      owner?: ProcessOwnerRequest;
    },
  ): OwnedProcessRecord {
    const { owner = { type: "workspace" }, ...rest } = input;
    return this.saveOwnedDraft(raw, { ...rest, owner });
  }
  private saveOwnedDraft(
    raw: ProcessActor,
    input: {
      id?: string;
      owner: ProcessOwner | ProcessOwnerRequest;
      revision: number;
      definition: ProcessDefinition;
    },
  ): OwnedProcessRecord {
    const actor = this.actor(raw);
    const owner = this.boundOwner(actor, input.owner);
    return this.atomic(() => {
      const previous = input.id
        ? this.row(actor, input.id, "manage")
        : undefined;
      this.check(previous, input.revision);
      if (
        previous &&
        processDigest(this.rowOwner(previous)) !== processDigest(owner)
      )
        throw new IdentityError(409, "process_conflict");
      if (!this.validateOwner(actor, owner, input.definition).valid)
        throw new IdentityError(400, "process_definition_invalid");
      const definition = ProcessDefinitionSchema.parse(input.definition);
      const id = previous?.id ?? randomUUID(),
        now = new Date(this.now()).toISOString();
      if (previous)
        this.db
          .prepare(
            "UPDATE agent_service_process SET draft=?,revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(JSON.stringify(definition), now, id);
      else
        this.db
          .prepare(
            "INSERT INTO agent_service_process (id,organization_id,workspace_id,service_id,revision,draft,active_version,updated_at,owner_type,owner_user_id) VALUES (?,?,?,?,?,?,NULL,?,?,?)",
          )
          .run(
            id,
            actor.organizationId,
            actor.workspaceId,
            owner.type === "service" ? owner.serviceId : null,
            1,
            JSON.stringify(definition),
            now,
            owner.type,
            owner.type === "user" ? owner.userId : null,
          );
      this.changed(actor, this.row(actor, id, "manage"));
      return this.getOwned(actor, id);
    });
  }
  freezeDraft(raw: ProcessActor, id: string, revision: number): ProcessVersion {
    const actor = this.actor(raw);
    return this.atomic(() => {
      const row = this.row(actor, id, "manage");
      this.check(row, revision);
      const definition = ProcessDefinitionSchema.parse(JSON.parse(row.draft)),
        sources = this.ready(actor, row.service_id, definition);
      const hash = processDigest({ definition, sources }),
        latest = this.summary(row).latestVersion;
      if (
        latest &&
        this.versionValue(actor, id, latest, "manage").digest === hash
      )
        return this.versionValue(actor, id, latest, "manage");
      this.db
        .prepare(
          "INSERT INTO agent_service_process_version VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          id,
          latest + 1,
          JSON.stringify(definition),
          JSON.stringify(sources),
          hash,
          new Date(this.now()).toISOString(),
          actor.userId,
        );
      this.bump(actor, row, "version_frozen", latest + 1);
      return this.versionValue(actor, id, latest + 1, "manage");
    });
  }
  private versionValue(
    actor: ProcessActor,
    id: string,
    version: number,
    mode: ProcessAccess,
    archived = false,
  ): ProcessVersion {
    this.row(actor, id, mode, archived);
    versionNumber.parse(version);
    const row = this.db
      .prepare(
        "SELECT * FROM agent_service_process_version WHERE process_id=? AND version=?",
      )
      .get(id, version);
    if (!row) throw new IdentityError(404, "process_not_found");
    const test = this.db
      .prepare(
        "SELECT evidence FROM agent_service_process_test WHERE process_id=? AND version=? ORDER BY id DESC LIMIT 1",
      )
      .get(id, version);
    const evidence = test
      ? testEvidenceSchema.parse(JSON.parse(String(test.evidence)))
      : null;
    return ProcessVersionSchema.parse({
      processId: id,
      version,
      definition: JSON.parse(String(row.definition)),
      sources: ProcessSourceManifestSchema.parse(
        JSON.parse(String(row.sources)),
      ),
      digest: row.digest,
      createdAt: row.created_at,
      createdBy: row.created_by,
      testStatus: !evidence
        ? "untested"
        : evidence.passed &&
            PROCESS_TEST_SCENARIOS.every((scenario) =>
              evidence.scenarios.includes(scenario),
            )
          ? "passed"
          : "failed",
    });
  }
  version(raw: ProcessActor, id: string, version: number) {
    return this.versionValue(this.actor(raw), id, version, "read");
  }
  /** Bounded numeric keyset history; current source availability is irrelevant. */
  listVersions(raw: ProcessActor, id: string, before?: number, limit = 20) {
    const actor = this.actor(raw);
    this.row(actor, id, "read");
    if (before !== undefined) versionNumber.parse(before);
    z.number().int().min(1).max(20).parse(limit);
    const rows = this.db
      .prepare(
        `SELECT version FROM agent_service_process_version
      WHERE process_id=? AND (? IS NULL OR version<?)
      ORDER BY version DESC LIMIT ?`,
      )
      .all(id, before ?? null, before ?? null, limit + 1);
    const versions = rows
      .slice(0, limit)
      .map((row) => this.versionValue(actor, id, Number(row.version), "read"));
    return {
      versions,
      nextBefore: rows.length > limit ? versions.at(-1)!.version : null,
    };
  }
  /** Revalidates the artifact under the actor's current authority. */
  private currentVersion(
    actor: ProcessActor,
    id: string,
    version: number,
    mode: Exclude<ProcessAccess, "read">,
  ) {
    const row = this.row(actor, id, mode),
      artifact = this.versionValue(actor, id, version, mode);
    const sources = this.ready(actor, row.service_id, artifact.definition);
    if (processDigest(sources) !== processDigest(artifact.sources))
      throw new IdentityError(409, "process_sources_changed");
    return artifact;
  }
  /** Internal test boundary: resolve an inactive artifact without a production run pin. */
  testArtifact(raw: ProcessActor, id: string, version: number): ProcessVersion {
    return this.currentVersion(this.actor(raw), id, version, "manage");
  }
  /** Trusted test-runner boundary. Deliberately absent from HTTP/LLM commands. */
  recordTest(
    raw: ProcessActor,
    id: string,
    version: number,
    rawEvidence: z.input<typeof testEvidenceSchema>,
  ) {
    const actor = this.actor(raw),
      evidence = testEvidenceSchema.parse(rawEvidence);
    return this.atomic(() => {
      const artifact = this.currentVersion(actor, id, version, "manage");
      if (evidence.digest !== artifact.digest)
        throw new IdentityError(409, "process_conflict");
      const prior = this.db
        .prepare("SELECT * FROM agent_service_process_test WHERE test_id=?")
        .get(evidence.testId);
      if (prior) {
        if (
          prior.process_id !== id ||
          prior.version !== version ||
          processDigest(JSON.parse(String(prior.evidence))) !==
            processDigest(evidence)
        )
          throw new IdentityError(409, "process_conflict");
        return this.versionValue(actor, id, version, "manage");
      }
      this.db
        .prepare(
          "INSERT INTO agent_service_process_test(test_id,process_id,version,evidence,created_at) VALUES (?,?,?,?,?)",
        )
        .run(
          evidence.testId,
          id,
          version,
          JSON.stringify(evidence),
          new Date(this.now()).toISOString(),
        );
      this.bump(
        actor,
        this.row(actor, id, "manage"),
        "version_tested",
        version,
      );
      return this.versionValue(actor, id, version, "manage");
    });
  }
  /** The shared owner attaches this passive gate once, before any native run. */
  attachNativeQualificationGate(
    gate: NonNullable<ServiceProcessStore["nativeQualificationGate"]>,
  ) {
    if (this.nativeQualificationGate)
      throw new Error("Native process qualification gate already attached");
    this.nativeQualificationGate = gate;
  }
  private qualified(actor: ProcessActor, artifact: ProcessVersion) {
    const row = this.db
      .prepare(
        "SELECT reference FROM agent_service_process_qualification WHERE process_id=? AND version=?",
      )
      .get(artifact.processId, artifact.version);
    if (!row) {
      // Only a detached contract store may use legacy recordTest evidence.
      // The native owner must never reinterpret missing lineage as legacy.
      if (this.nativeQualificationGate)
        throw new IdentityError(409, "process_qualification_unavailable");
      return;
    }
    const reference = NativeProcessQualificationReferenceSchema.parse(
      JSON.parse(String(row.reference)),
    );
    if (!this.nativeQualificationGate)
      throw new IdentityError(409, "process_qualification_unavailable");
    this.nativeQualificationGate(actor, artifact, reference);
  }
  /** Trusted lifecycle boundary: a lineage cannot be erased by legacy test metadata. */
  recordNativeQualification(
    raw: ProcessActor,
    id: string,
    version: number,
    evidence: z.input<typeof testEvidenceSchema>,
    rawReference: NativeProcessQualificationReference,
  ) {
    const actor = this.actor(raw),
      reference = NativeProcessQualificationReferenceSchema.parse(rawReference);
    if (
      reference.creatorUserId !== actor.userId ||
      reference.testId !== evidence.testId
    )
      throw new IdentityError(409, "process_test_conflict");
    return this.atomic(() => {
      const artifact = this.recordTest(actor, id, version, evidence);
      this.db
        .prepare(
          `INSERT INTO agent_service_process_qualification VALUES (?,?,?)
           ON CONFLICT(process_id,version) DO UPDATE SET reference=excluded.reference`,
        )
        .run(id, version, JSON.stringify(reference));
      this.qualified(actor, artifact);
      return artifact;
    });
  }
  /** Trusted pointer CAS; the human lifecycle owns public decision receipts. */
  activate(raw: ProcessActor, id: string, revision: number, version: number) {
    const actor = this.actor(raw);
    return this.atomic(() => {
      const row = this.row(actor, id, "manage");
      this.check(row, revision);
      const artifact = this.currentVersion(actor, id, version, "manage");
      this.qualified(actor, artifact);
      if (artifact.testStatus !== "passed")
        throw new IdentityError(409, "process_test_required");
      if (row.active_version === version) return this.getOwned(actor, id);
      this.db
        .prepare("UPDATE agent_service_process SET active_version=? WHERE id=?")
        .run(version, id);
      this.bump(actor, row, "version_activated", version);
      return this.getOwned(actor, id);
    });
  }
  /** Scoped historical provenance. Execution still requires resolveRun's fresh gates. */
  assertExecutionScope(raw: ProcessActor, id: string): void {
    this.row(this.actor(raw), id, "execute", true);
  }
  /**
   * The owner deletes their own personal process. The row is kept (archived)
   * so that existing runs keep their history and receipts, but it leaves every
   * list, the start inventory and offers, and nothing can start or continue it:
   * a run already in progress stops at its next step, like any lost authority.
   * Administrators keep read-only access to other people's processes, so they
   * cannot archive them; company processes are not archived here.
   */
  archive(raw: ProcessActor, id: string, revision: number) {
    const actor = this.actor(raw);
    return this.atomic(() => {
      const row = this.row(actor, id, "manage");
      if (row.owner_type !== "user" || row.owner_user_id !== actor.userId)
        throw new IdentityError(403, "process_archive_forbidden");
      this.check(row, revision);
      const now = new Date(this.now()).toISOString();
      this.db
        .prepare(
          "UPDATE agent_service_process SET archived_at=?,revision=revision+1,updated_at=? WHERE id=? AND archived_at IS NULL",
        )
        .run(now, now, id);
      this.changed(actor, { ...row, revision: row.revision + 1 }, "archived");
      return { id, archivedAt: now };
    });
  }
  pinnedVersion(raw: ProcessActor, runId: string): ProcessVersion {
    const actor = this.actor(raw);
    IdentityId.parse(runId);
    const pin = this.db
      .prepare(
        "SELECT process_id,version FROM agent_service_process_run WHERE run_id=? AND organization_id=? AND workspace_id=? AND user_id=?",
      )
      .get(runId, actor.organizationId, actor.workspaceId, actor.userId);
    if (!pin) throw new IdentityError(404, "process_not_found");
    // Provenance of an existing run stays readable after the owner deletes it.
    return this.versionValue(
      actor,
      String(pin.process_id),
      Number(pin.version),
      "execute",
      true,
    );
  }
  /** Seen-artifact gate for trusted intent issuance. No inference/service I/O. */
  activeRunVersion(
    raw: ProcessActor,
    id: string,
    expected: { version: number; artifactDigest: string },
  ) {
    const actor = this.actor(raw),
      row = this.row(actor, id, "execute");
    versionNumber.parse(expected.version);
    digest.parse(expected.artifactDigest);
    if (row.active_version !== expected.version)
      throw new IdentityError(409, "process_active_version_changed");
    const artifact = this.currentVersion(
      actor,
      id,
      expected.version,
      "execute",
    );
    if (artifact.digest !== expected.artifactDigest)
      throw new IdentityError(409, "process_active_version_changed");
    this.qualified(actor, artifact);
    if (artifact.testStatus !== "passed")
      throw new IdentityError(409, "process_test_required");
    return artifact;
  }
  /** Native runner retry retains its pin; new public admission must supply seen identity. */
  pinRun(
    raw: ProcessActor,
    id: string,
    runId: string,
    expected?: { version: number; artifactDigest: string },
  ): ProcessVersion {
    const actor = this.actor(raw);
    IdentityId.parse(runId);
    return this.atomic(() => {
      const previous = this.db
        .prepare("SELECT * FROM agent_service_process_run WHERE run_id=?")
        .get(runId);
      if (previous) {
        if (previous.process_id !== id)
          throw new IdentityError(409, "process_conflict");
        const artifact = this.resolveRun(actor, runId);
        if (
          expected &&
          (artifact.version !== expected.version ||
            artifact.digest !== expected.artifactDigest)
        )
          throw new IdentityError(409, "process_conflict");
        return artifact;
      }
      const row = this.row(actor, id, "execute");
      if (!row.active_version)
        throw new IdentityError(409, "process_not_active");
      const artifact = expected
        ? this.activeRunVersion(actor, id, expected)
        : this.currentVersion(actor, id, row.active_version, "execute");
      this.qualified(actor, artifact);
      if (artifact.testStatus !== "passed")
        throw new IdentityError(409, "process_test_required");
      this.db
        .prepare("INSERT INTO agent_service_process_run VALUES (?,?,?,?,?,?,?)")
        .run(
          runId,
          id,
          artifact.version,
          actor.organizationId,
          actor.workspaceId,
          actor.userId,
          new Date(this.now()).toISOString(),
        );
      return artifact;
    });
  }
  resolveRun(raw: ProcessActor, runId: string): ProcessVersion {
    const actor = this.actor(raw);
    IdentityId.parse(runId);
    const row = this.db
      .prepare(
        "SELECT * FROM agent_service_process_run WHERE run_id=? AND organization_id=? AND workspace_id=? AND user_id=?",
      )
      .get(runId, actor.organizationId, actor.workspaceId, actor.userId);
    if (!row) throw new IdentityError(404, "process_not_found");
    const artifact = this.currentVersion(
      actor,
      String(row.process_id),
      Number(row.version),
      "execute",
    );
    this.qualified(actor, artifact);
    if (artifact.testStatus !== "passed")
      throw new IdentityError(409, "process_test_required");
    return artifact;
  }
}
