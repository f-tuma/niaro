import type { DatabaseSync } from "node:sqlite";
import type { AuditRecord } from "../../packages/protocol/audit";
import { IdentityId } from "../../packages/protocol/identity";
import {
  INSTRUCTIONS_LIMITS,
  INSTRUCTIONS_PROFILE,
  InstructionsCommandSchema,
  InstructionsContentSchema,
  InstructionsVersionSchema,
  WorkspaceChatSetupSchema,
  type InstructionsAdminView,
  type InstructionsContent,
  type InstructionsScope,
  type InstructionsVersion,
  type WorkspaceChatSetup,
} from "../../packages/protocol/workspace-instructions";
import { IdentityError } from "./error";

/** The authenticated person and their organization role, resolved by the caller. */
export type InstructionsActor = {
  organizationId: string;
  userId: string;
  role: "owner" | "admin" | "member";
};
type Row = Record<string, unknown>;
const EMPTY: InstructionsContent = { text: "", starters: [] };

/**
 * Workspace instructions and starters in the identity database: one current
 * row per scope (the organization default, keyed by the organization id, or
 * one workspace) and every saved version beside it, so an older version can
 * be restored. Only owners and administrators read the history or change
 * anything; members read what applies through `effective`. Nothing here
 * grants an action, a service or an approval.
 */
export class InstructionsStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit?: (record: AuditRecord) => number,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_instructions (
      scope_key TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      workspace_id TEXT REFERENCES agent_workspace(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      starters TEXT NOT NULL CHECK(json_valid(starters)),
      revision INTEGER NOT NULL CHECK(revision > 0),
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK((workspace_id IS NULL) = (scope_key = organization_id))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_instructions_version (
      scope_key TEXT NOT NULL REFERENCES agent_instructions(scope_key) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision > 0),
      text TEXT NOT NULL,
      starters TEXT NOT NULL CHECK(json_valid(starters)),
      event TEXT NOT NULL CHECK(event IN ('saved','restored')),
      restored_from INTEGER,
      author_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(scope_key, revision)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS agent_instructions_scope_immutable
      BEFORE UPDATE ON agent_instructions
      WHEN OLD.organization_id IS NOT NEW.organization_id
        OR OLD.workspace_id IS NOT NEW.workspace_id
      BEGIN SELECT RAISE(ABORT, 'instructions_scope_immutable'); END;`);
  }

  private atomic<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT agent_instructions");
    try {
      const value = fn();
      this.db.exec("RELEASE agent_instructions");
      return value;
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO agent_instructions; RELEASE agent_instructions",
      );
      throw error;
    }
  }
  /** The scope's row key; a workspace must belong to the organization. */
  private key(organizationId: string, scope: InstructionsScope) {
    IdentityId.parse(organizationId);
    if (scope.type === "organization") return organizationId;
    const workspace = this.db
      .prepare(
        "SELECT id FROM agent_workspace WHERE id = ? AND organization_id = ?",
      )
      .get(scope.workspaceId, organizationId);
    if (!workspace) throw new IdentityError(404, "identity_not_found");
    return scope.workspaceId;
  }
  /** Owners and administrators who still belong to the organization. */
  private manager(actor: InstructionsActor) {
    const row = this.db
      .prepare(
        `SELECT role FROM member WHERE "userId" = ? AND "organizationId" = ?`,
      )
      .get(actor.userId, actor.organizationId);
    if (!row) throw new IdentityError(403, "identity_forbidden");
    if (actor.role === "member" || row.role === "member")
      throw new IdentityError(403, "instructions_forbidden");
  }
  private content(row: Row | undefined): InstructionsContent {
    if (!row) return EMPTY;
    return InstructionsContentSchema.parse({
      text: row.text,
      starters: JSON.parse(String(row.starters)),
    });
  }
  private current(key: string) {
    return this.db
      .prepare("SELECT * FROM agent_instructions WHERE scope_key = ?")
      .get(key);
  }
  private name(userId: unknown): string | null {
    const row = this.db
      .prepare('SELECT name FROM "user" WHERE id = ?')
      .get(String(userId));
    return row && typeof row.name === "string" ? row.name.slice(0, 200) : null;
  }

  /**
   * The current content and revision of one scope. Typed read for the
   * configuration bundle (export); no role check: the caller decides who may
   * export.
   */
  readContent(organizationId: string, scope: InstructionsScope) {
    const row = this.current(this.key(organizationId, scope));
    return {
      revision: row ? Number(row.revision) : 0,
      content: this.content(row),
    };
  }
  /**
   * Saves new content as the next revision when `revision` is the current one.
   * Typed write for the editor and for the configuration bundle (import).
   */
  writeContent(
    actor: InstructionsActor,
    scope: InstructionsScope,
    raw: InstructionsContent,
    revision: number,
    restoredFrom?: number,
  ) {
    const content = InstructionsContentSchema.parse(raw);
    return this.atomic(() => {
      this.manager(actor);
      const key = this.key(actor.organizationId, scope);
      const row = this.current(key);
      const current = row ? Number(row.revision) : 0;
      if (current !== revision)
        throw new IdentityError(409, "instructions_conflict");
      const next = current + 1;
      const at = new Date(this.now()).toISOString();
      const starters = JSON.stringify(content.starters);
      if (row)
        this.db
          .prepare(
            `UPDATE agent_instructions SET text = ?, starters = ?, revision = ?, updated_by = ?,
              updated_at = ? WHERE scope_key = ?`,
          )
          .run(content.text, starters, next, actor.userId, at, key);
      else
        this.db
          .prepare(
            "INSERT INTO agent_instructions VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
          )
          .run(
            key,
            actor.organizationId,
            scope.type === "workspace" ? scope.workspaceId : null,
            content.text,
            starters,
            actor.userId,
            at,
          );
      this.db
        .prepare(
          "INSERT INTO agent_instructions_version VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          key,
          next,
          content.text,
          starters,
          restoredFrom === undefined ? "saved" : "restored",
          restoredFrom ?? null,
          actor.userId,
          at,
        );
      // Metadata only: never the text or the starters.
      this.audit?.({
        organizationId: actor.organizationId,
        workspaceId: scope.type === "workspace" ? scope.workspaceId : null,
        actorId: actor.userId,
        source: "console",
        action: "instructions.changed",
        targetId: key,
        outcome: "succeeded",
        details: {
          instructionsEvent: restoredFrom === undefined ? "saved" : "restored",
          instructionsScope: scope.type,
          revision: next,
          previousRevision: current,
        },
      });
      return { revision: next, content };
    });
  }

  /** The editor: current content, the organization default and the history. */
  view(
    actor: InstructionsActor,
    scope: InstructionsScope,
  ): InstructionsAdminView {
    this.manager(actor);
    const key = this.key(actor.organizationId, scope);
    const row = this.current(key);
    const history = this.db
      .prepare(
        `SELECT * FROM agent_instructions_version WHERE scope_key = ?
        ORDER BY revision DESC LIMIT ?`,
      )
      .all(key, INSTRUCTIONS_LIMITS.history)
      .map(
        (version): InstructionsVersion =>
          InstructionsVersionSchema.parse({
            revision: version.revision,
            content: this.content(version),
            event: version.event,
            ...(version.restored_from !== null
              ? { restoredFrom: version.restored_from }
              : {}),
            authorName: this.name(version.author_id),
            createdAt: version.created_at,
          }),
      );
    return {
      profile: INSTRUCTIONS_PROFILE,
      organizationId: actor.organizationId,
      scope,
      revision: row ? Number(row.revision) : 0,
      content: this.content(row),
      updatedAt: row ? String(row.updated_at) : null,
      updatedByName: row ? this.name(row.updated_by) : null,
      ...(scope.type === "workspace"
        ? {
            organizationDefault: this.content(
              this.current(actor.organizationId),
            ),
          }
        : {}),
      history,
    };
  }
  /** Save or restore, revision-checked and audited. */
  command(actor: InstructionsActor, raw: unknown) {
    const command = InstructionsCommandSchema.parse(raw);
    if (command.type === "save")
      return this.writeContent(
        actor,
        command.scope,
        command.content,
        command.revision,
      );
    this.manager(actor);
    const key = this.key(actor.organizationId, command.scope);
    const version = this.db
      .prepare(
        "SELECT * FROM agent_instructions_version WHERE scope_key = ? AND revision = ?",
      )
      .get(key, command.version);
    if (!version)
      throw new IdentityError(404, "instructions_version_not_found");
    return this.writeContent(
      actor,
      command.scope,
      this.content(version),
      command.revision,
      command.version,
    );
  }
  /**
   * What applies in a workspace now. The workspace's own text and starters
   * win; each falls back to the organization default while it is empty.
   */
  effective(organizationId: string, workspaceId: string): WorkspaceChatSetup {
    const own = this.content(
      this.current(
        this.key(organizationId, { type: "workspace", workspaceId }),
      ),
    );
    const fallback = this.content(this.current(organizationId));
    const text = own.text.trim()
      ? { text: own.text, source: "workspace" as const }
      : fallback.text.trim()
        ? { text: fallback.text, source: "organization" as const }
        : null;
    return WorkspaceChatSetupSchema.parse({
      profile: INSTRUCTIONS_PROFILE,
      workspaceId,
      instructions: text,
      starters: own.starters.length ? own.starters : fallback.starters,
    });
  }
}
