import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AuditRecord } from "../../packages/protocol/audit";
import { IdentityId } from "../../packages/protocol/identity";
import {
  SKILLS_PROFILE,
  SKILL_LIMITS,
  SkillCommandSchema,
  SkillContentSchema,
  SkillFileSchema,
  SkillSchema,
  type Skill,
  type SkillCommand,
  type SkillContent,
  type SkillList,
  type SkillProposalStatus,
  type SkillSummary,
} from "../../packages/protocol/skills";
import { IdentityError } from "./error";

/** The authenticated person and their organization role, resolved by the caller. */
export type SkillActor = {
  organizationId: string;
  workspaceId: string;
  userId: string;
  role: "owner" | "admin" | "member";
};
type Row = Record<string, unknown>;
const manages = (actor: SkillActor) => actor.role !== "member";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Unsaved proposals from chat are kept this long. */
const PROPOSAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Skills of one workspace in the identity database: company skills
 * (`owner_type = 'workspace'`, administrators manage them, everyone uses the
 * enabled ones) and personal skills (`owner_type = 'user'`, only their owner
 * sees and uses them; anyone else gets 404). Proposals from chat wait here
 * until the person saves them. Nothing here grants an action or a service.
 */
export class SkillStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit?: (record: AuditRecord) => number,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_skill (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
      owner_type TEXT NOT NULL CHECK(owner_type IN ('workspace','user')),
      owner_user_id TEXT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      instructions TEXT NOT NULL,
      files TEXT NOT NULL CHECK(json_valid(files)),
      revision INTEGER NOT NULL CHECK(revision > 0),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      archived_at TEXT,
      CHECK((owner_type = 'user') = (owner_user_id IS NOT NULL))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_skill_proposal (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL CHECK(json_valid(content)),
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      skill_id TEXT,
      target TEXT CHECK(target IS NULL OR target IN ('personal','workspace')),
      saved_at TEXT
    ) STRICT;`);
    // A table from an earlier build without these columns gains them in place.
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(agent_skill)")
        .all()
        .map((column) => String(column.name)),
    );
    if (!columns.has("enabled"))
      db.exec(
        "ALTER TABLE agent_skill ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))",
      );
    if (!columns.has("archived_at"))
      db.exec("ALTER TABLE agent_skill ADD COLUMN archived_at TEXT");
    db.exec(`CREATE INDEX IF NOT EXISTS agent_skill_owner
      ON agent_skill(workspace_id, owner_type, owner_user_id, archived_at);
    CREATE INDEX IF NOT EXISTS agent_skill_proposal_owner
      ON agent_skill_proposal(workspace_id, user_id, created_at);
    CREATE TRIGGER IF NOT EXISTS agent_skill_owner_immutable
      BEFORE UPDATE ON agent_skill
      WHEN OLD.owner_type IS NOT NEW.owner_type
        OR OLD.owner_user_id IS NOT NEW.owner_user_id
        OR OLD.workspace_id IS NOT NEW.workspace_id
        OR OLD.organization_id IS NOT NEW.organization_id
      BEGIN SELECT RAISE(ABORT, 'skill_owner_immutable'); END;`);
    db.prepare(
      "DELETE FROM agent_skill_proposal WHERE skill_id IS NULL AND created_at < ?",
    ).run(new Date(this.now() - PROPOSAL_TTL_MS).toISOString());
  }

  private atomic<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT agent_skill");
    try {
      const value = fn();
      this.db.exec("RELEASE agent_skill");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK TO agent_skill; RELEASE agent_skill");
      throw error;
    }
  }
  /** The person must still belong to the workspace's organization. */
  private member(actor: SkillActor) {
    IdentityId.parse(actor.workspaceId);
    const row = this.db
      .prepare(
        `SELECT m.id FROM member m JOIN agent_workspace w ON w.organization_id = m."organizationId"
        WHERE m."userId" = ? AND m."organizationId" = ? AND w.id = ?`,
      )
      .get(actor.userId, actor.organizationId, actor.workspaceId);
    if (!row) throw new IdentityError(403, "identity_forbidden");
  }
  private skill(row: Row): Skill {
    return SkillSchema.parse({
      id: row.id,
      owner:
        row.owner_type === "user"
          ? { type: "user", userId: row.owner_user_id }
          : { type: "workspace" },
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      files: SkillFileSchema.array().parse(JSON.parse(String(row.files))),
      enabled: row.enabled === 1,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  private summary(row: Row): SkillSummary {
    const skill = this.skill(row);
    return {
      id: skill.id,
      owner: skill.owner,
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
      revision: skill.revision,
      updatedAt: skill.updatedAt,
      files: skill.files.map((file) => file.name),
    };
  }
  /** Whether this person may see the row at all; anything else is 404. */
  private visible(actor: SkillActor, row: Row) {
    if (
      row.archived_at !== null ||
      row.workspace_id !== actor.workspaceId ||
      row.organization_id !== actor.organizationId
    )
      return false;
    return row.owner_type === "user"
      ? row.owner_user_id === actor.userId
      : manages(actor) || row.enabled === 1;
  }
  private row(actor: SkillActor, id: string) {
    IdentityId.parse(id);
    const row = this.db
      .prepare("SELECT * FROM agent_skill WHERE id = ?")
      .get(id);
    if (!row || !this.visible(actor, row))
      throw new IdentityError(404, "skill_not_found");
    return row;
  }
  /** Changing a company skill needs an owner or administrator. */
  private writable(actor: SkillActor, row: Row) {
    if (row.owner_type === "workspace" && !manages(actor))
      throw new IdentityError(403, "skill_forbidden");
  }
  private rows(actor: SkillActor, owner: "user" | "workspace") {
    return this.db
      .prepare(
        `SELECT * FROM agent_skill WHERE organization_id = ? AND workspace_id = ? AND archived_at IS NULL
        AND owner_type = ? AND (owner_type = 'workspace' OR owner_user_id = ?)
        ORDER BY lower(name), id`,
      )
      .all(actor.organizationId, actor.workspaceId, owner, actor.userId);
  }
  private nameTaken(
    actor: SkillActor,
    owner: "user" | "workspace",
    name: string,
    except?: string,
  ) {
    const key = name.trim().toLocaleLowerCase();
    return this.rows(actor, owner).some(
      (row) =>
        row.id !== except && String(row.name).toLocaleLowerCase() === key,
    );
  }
  private record(
    actor: SkillActor,
    skill: Pick<Skill, "id" | "owner" | "revision">,
    event: "created" | "updated" | "enabled" | "disabled" | "archived",
    source: "console" | "chat",
    previousRevision?: number,
  ) {
    this.audit?.({
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      source,
      action: "skill.changed",
      targetId: skill.id,
      outcome: "succeeded",
      details: {
        skillEvent: event,
        skillOwner: skill.owner.type === "user" ? "personal" : "workspace",
        revision: skill.revision,
        ...(previousRevision !== undefined ? { previousRevision } : {}),
      },
    });
  }
  private insert(
    actor: SkillActor,
    owner: "personal" | "workspace",
    content: SkillContent,
    enabled: boolean,
    source: "console" | "chat",
  ) {
    if (owner === "workspace" && !manages(actor))
      throw new IdentityError(403, "skill_forbidden");
    const type = owner === "workspace" ? "workspace" : "user";
    const count = this.rows(actor, type).length;
    if (
      count >=
      (type === "workspace"
        ? SKILL_LIMITS.workspacePerWorkspace
        : SKILL_LIMITS.personalPerPerson)
    )
      throw new IdentityError(409, "skill_limit");
    if (this.nameTaken(actor, type, content.name))
      throw new IdentityError(409, "skill_name_taken");
    const id = randomUUID();
    const at = new Date(this.now()).toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_skill (id, organization_id, workspace_id, owner_type, owner_user_id, name,
          description, instructions, files, revision, created_by, created_at, updated_by, updated_at,
          enabled, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        actor.organizationId,
        actor.workspaceId,
        type,
        type === "user" ? actor.userId : null,
        content.name,
        content.description,
        content.instructions,
        JSON.stringify(content.files),
        actor.userId,
        at,
        actor.userId,
        at,
        enabled ? 1 : 0,
      );
    const skill = this.get(actor, id);
    this.record(actor, skill, "created", source);
    return skill;
  }

  /** The person's own skills and the company skills they may see. */
  list(actor: SkillActor): SkillList {
    this.member(actor);
    return {
      profile: SKILLS_PROFILE,
      canManageWorkspace: manages(actor),
      personal: this.rows(actor, "user").map((row) => this.summary(row)),
      workspace: this.rows(actor, "workspace")
        .filter((row) => this.visible(actor, row))
        .map((row) => this.summary(row)),
    };
  }
  get(actor: SkillActor, id: string): Skill {
    this.member(actor);
    return this.skill(this.row(actor, id));
  }
  /** Enabled skills this person can use now: their own first, then the company's. */
  usable(actor: SkillActor): SkillSummary[] {
    this.member(actor);
    return [...this.rows(actor, "user"), ...this.rows(actor, "workspace")]
      .filter((row) => row.enabled === 1)
      .map((row) => this.summary(row));
  }
  /** One usable skill with its content, or undefined when it is not usable. */
  usableSkill(actor: SkillActor, id: string): Skill | undefined {
    if (!IdentityId.safeParse(id).success) return undefined;
    this.member(actor);
    const row = this.db
      .prepare("SELECT * FROM agent_skill WHERE id = ?")
      .get(id);
    return row && this.visible(actor, row) && row.enabled === 1
      ? this.skill(row)
      : undefined;
  }
  command(
    actor: SkillActor,
    raw: unknown,
    source: "console" | "chat" = "console",
  ) {
    const command: SkillCommand = SkillCommandSchema.parse(raw);
    return this.atomic(() => {
      this.member(actor);
      if (command.type === "save" && !command.id) {
        if (command.revision !== 0)
          throw new IdentityError(409, "skill_conflict");
        return this.insert(
          actor,
          command.owner ?? "personal",
          command.content,
          command.enabled,
          source,
        );
      }
      const row = this.row(actor, command.id!);
      this.writable(actor, row);
      if (Number(row.revision) !== command.revision)
        throw new IdentityError(409, "skill_conflict");
      const current = this.skill(row);
      const at = new Date(this.now()).toISOString();
      if (command.type === "archive") {
        this.db
          .prepare(
            "UPDATE agent_skill SET archived_at = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ?",
          )
          .run(at, actor.userId, at, current.id);
        this.record(
          actor,
          { ...current, revision: current.revision + 1 },
          "archived",
          source,
          current.revision,
        );
        return { ...current, revision: current.revision + 1 };
      }
      if (command.type === "setEnabled") {
        this.db
          .prepare(
            "UPDATE agent_skill SET enabled = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ?",
          )
          .run(command.enabled ? 1 : 0, actor.userId, at, current.id);
      } else {
        const owner = current.owner.type === "user" ? "personal" : "workspace";
        if (command.owner && command.owner !== owner)
          throw new IdentityError(409, "skill_conflict");
        if (
          this.nameTaken(
            actor,
            current.owner.type,
            command.content.name,
            current.id,
          )
        )
          throw new IdentityError(409, "skill_name_taken");
        this.db
          .prepare(
            `UPDATE agent_skill SET name = ?, description = ?, instructions = ?, files = ?, enabled = ?,
              revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            command.content.name,
            command.content.description,
            command.content.instructions,
            JSON.stringify(command.content.files),
            command.enabled ? 1 : 0,
            actor.userId,
            at,
            current.id,
          );
      }
      // A member who just disabled a company skill could not read it back,
      // but only managers change company skills, so this read is visible.
      const next = this.skill(
        this.db
          .prepare("SELECT * FROM agent_skill WHERE id = ?")
          .get(current.id)!,
      );
      this.record(
        actor,
        next,
        command.type === "save"
          ? "updated"
          : command.enabled
            ? "enabled"
            : "disabled",
        source,
        current.revision,
      );
      return next;
    });
  }

  /**
   * Keeps a skill the assistant drafted in chat until the person saves it.
   * The id is derived from the exact tool call, so a replay returns the same
   * proposal; different content under the same id is a conflict.
   */
  propose(actor: SkillActor, id: string, raw: SkillContent) {
    IdentityId.parse(id);
    const content = SkillContentSchema.parse(raw);
    const contentHash = hash(content);
    return this.atomic(() => {
      this.member(actor);
      const existing = this.db
        .prepare("SELECT * FROM agent_skill_proposal WHERE id = ?")
        .get(id);
      if (existing) {
        if (
          existing.user_id !== actor.userId ||
          existing.workspace_id !== actor.workspaceId ||
          existing.content_hash !== contentHash
        )
          throw new IdentityError(409, "skill_conflict");
        return { id, content };
      }
      this.db
        .prepare(
          "INSERT INTO agent_skill_proposal VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)",
        )
        .run(
          id,
          actor.organizationId,
          actor.workspaceId,
          actor.userId,
          JSON.stringify(content),
          contentHash,
          new Date(this.now()).toISOString(),
        );
      return { id, content };
    });
  }
  private proposal(actor: SkillActor, id: string) {
    IdentityId.parse(id);
    const row = this.db
      .prepare("SELECT * FROM agent_skill_proposal WHERE id = ?")
      .get(id);
    if (
      !row ||
      row.user_id !== actor.userId ||
      row.workspace_id !== actor.workspaceId ||
      row.organization_id !== actor.organizationId
    )
      throw new IdentityError(404, "skill_proposal_not_found");
    return row;
  }
  private status(row: Row): SkillProposalStatus {
    return {
      profile: SKILLS_PROFILE,
      proposalId: String(row.id),
      status: row.skill_id ? "saved" : "open",
      ...(row.skill_id
        ? {
            target: row.target === "workspace" ? "workspace" : "personal",
            skillId: String(row.skill_id),
          }
        : {}),
    } as SkillProposalStatus;
  }
  proposalStatus(actor: SkillActor, id: string) {
    this.member(actor);
    return this.status(this.proposal(actor, id));
  }
  /**
   * Saves a proposal once. Repeating the accept (any target) returns the
   * saved result. A taken name gets a number so saving never dead-ends.
   */
  accept(actor: SkillActor, id: string, target: "personal" | "workspace") {
    return this.atomic(() => {
      this.member(actor);
      const row = this.proposal(actor, id);
      if (row.skill_id) return this.status(row);
      if (target === "workspace" && !manages(actor))
        throw new IdentityError(403, "skill_forbidden");
      const content = SkillContentSchema.parse(JSON.parse(String(row.content)));
      const type = target === "workspace" ? "workspace" : "user";
      let name = content.name;
      for (let n = 2; this.nameTaken(actor, type, name); n++) {
        if (n > 20) throw new IdentityError(409, "skill_name_taken");
        const suffix = ` ${n}`;
        name =
          content.name.slice(0, SKILL_LIMITS.name - suffix.length) + suffix;
      }
      const skill = this.insert(
        actor,
        target,
        { ...content, name },
        true,
        "chat",
      );
      this.db
        .prepare(
          "UPDATE agent_skill_proposal SET skill_id = ?, target = ?, saved_at = ? WHERE id = ?",
        )
        .run(skill.id, target, new Date(this.now()).toISOString(), id);
      return this.status(
        this.db
          .prepare("SELECT * FROM agent_skill_proposal WHERE id = ?")
          .get(id)!,
      );
    });
  }
}
