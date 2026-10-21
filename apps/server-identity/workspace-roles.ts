import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { WorkspaceRoleSchema } from "../../packages/protocol/identity";
import { IdentityError } from "./error";
import type { z } from "zod";

type Role = z.infer<typeof WorkspaceRoleSchema>;
/** Workspace service permissions are separate from organization administration. */
export class WorkspaceRoleStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_workspace_role (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, name TEXT NOT NULL, UNIQUE(workspace_id,name)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_workspace_role_member (
      role_id TEXT NOT NULL REFERENCES agent_workspace_role(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
      PRIMARY KEY(role_id,member_id)
    ) STRICT;`);
  }
  list(workspace: string): Role[] {
    return this.db
      .prepare(
        "SELECT id,name,revision FROM agent_workspace_role WHERE workspace_id=? ORDER BY name",
      )
      .all(workspace)
      .map((row) =>
        WorkspaceRoleSchema.parse({
          ...row,
          memberIds: this.db
            .prepare(
              "SELECT member_id FROM agent_workspace_role_member WHERE role_id=? ORDER BY member_id",
            )
            .all(row.id!)
            .map((r) => r.member_id),
        }),
      );
  }
  validate(workspace: string, ids: readonly string[] = []) {
    for (const id of ids)
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM agent_workspace_role WHERE id=? AND workspace_id=?",
          )
          .get(id, workspace)
      )
        throw new IdentityError(400, "workspace_role_invalid");
  }
  forUser(workspace: string, user: string): string[] {
    return this.db
      .prepare(
        `SELECT r.id FROM agent_workspace_role r
      JOIN agent_workspace_role_member rm ON rm.role_id=r.id
      JOIN member m ON m.id=rm.member_id
      JOIN agent_workspace w ON w.id=r.workspace_id AND w.organization_id=m."organizationId"
      WHERE r.workspace_id=? AND m."userId"=?`,
      )
      .all(workspace, user)
      .map((r) => String(r.id));
  }
  save(
    workspace: string,
    input: { id?: string; revision: number; name: string; memberIds: string[] },
  ) {
    const previous = input.id
      ? this.list(workspace).find((r) => r.id === input.id)
      : undefined;
    if (input.id && !previous)
      throw new IdentityError(404, "identity_not_found");
    if ((previous?.revision ?? 0) !== input.revision)
      throw new IdentityError(409, "catalog_conflict");
    if (!input.id && this.list(workspace).length >= 50)
      throw new IdentityError(409, "identity_limit");
    if (
      this.list(workspace).some(
        (r) =>
          r.name.toLocaleLowerCase() === input.name.toLocaleLowerCase() &&
          r.id !== input.id,
      )
    )
      throw new IdentityError(409, "workspace_role_exists");
    for (const member of input.memberIds) {
      const eligible = this.db
        .prepare(
          `SELECT 1 FROM member m JOIN agent_workspace w ON w.organization_id=m."organizationId"
        WHERE w.id=? AND m.id=? AND (m.role IN ('owner','admin') OR EXISTS
        (SELECT 1 FROM agent_workspace_member wm WHERE wm.workspace_id=w.id AND wm.member_id=m.id))`,
        )
        .get(workspace, member);
      if (!eligible)
        throw new IdentityError(400, "workspace_role_member_invalid");
    }
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO agent_workspace_role(id,workspace_id,revision,name) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,name=excluded.name`,
      )
      .run(id, workspace, input.revision + 1, input.name);
    this.db
      .prepare("DELETE FROM agent_workspace_role_member WHERE role_id=?")
      .run(id);
    for (const member of input.memberIds)
      this.db
        .prepare("INSERT INTO agent_workspace_role_member VALUES (?,?)")
        .run(id, member);
    return id;
  }
  remove(workspace: string, id: string, revision: number) {
    const role = this.list(workspace).find((r) => r.id === id);
    if (!role) throw new IdentityError(404, "identity_not_found");
    if (role.revision !== revision)
      throw new IdentityError(409, "catalog_conflict");
    const used = this.db
      .prepare(
        `SELECT 1 FROM agent_catalog c WHERE
      (c.kind='service' AND c.scope_id=? AND EXISTS (SELECT 1 FROM json_each(c.data,'$.access.workspaceRoles') WHERE value=?)) OR
      (c.kind='action' AND c.scope_id IN (SELECT id FROM agent_catalog WHERE kind='service' AND scope_id=?)
      AND EXISTS (SELECT 1 FROM json_each(c.data,'$.policy.workspaceRoles') WHERE value=?)) LIMIT 1`,
      )
      .get(workspace, id, workspace, id);
    if (used) throw new IdentityError(409, "workspace_role_in_use");
    this.db
      .prepare("DELETE FROM agent_workspace_role WHERE id=? AND workspace_id=?")
      .run(id, workspace);
  }
  revokeMember(workspace: string, member: string) {
    this.db
      .prepare(
        "UPDATE agent_workspace_role SET revision=revision+1 WHERE workspace_id=? AND id IN (SELECT role_id FROM agent_workspace_role_member WHERE member_id=?)",
      )
      .run(workspace, member);
    this.db
      .prepare(
        "DELETE FROM agent_workspace_role_member WHERE member_id=? AND role_id IN (SELECT id FROM agent_workspace_role WHERE workspace_id=?)",
      )
      .run(member, workspace);
  }
}
