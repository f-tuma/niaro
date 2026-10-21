import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
  createHash,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  CalendarCommand,
  WorkspaceCalendarSchema,
} from "../../packages/protocol/workspace-calendar";
import { OrganizationRole } from "../../packages/protocol/identity";
import { type Scope } from "../../packages/protocol";
import { CalendarConfigSchema } from "../fixture-server/calendar";
import { isAccountScope } from "../../packages/protocol/mobile-access";
import { IdentityError } from "./error";

type Row = {
  workspace_id: string;
  id: string;
  name: string;
  collection_url: string;
  secret: string;
  enabled: number;
  revision: number;
  roles: string;
};
type Role = z.infer<typeof OrganizationRole>;
/** Call within the identity queue. Target projection is also used by read-only workflow hydration. */
export class WorkspaceCalendarStore {
  private key: Buffer;
  constructor(
    private db: DatabaseSync,
    secret: string,
    readonly collections: readonly string[],
  ) {
    this.key = Buffer.from(
      hkdfSync(
        "sha256",
        secret,
        "agent-server",
        "workspace-calendar-credentials/v1",
        32,
      ),
    );
    db.exec(`CREATE TABLE IF NOT EXISTS agent_workspace_calendar (
      workspace_id TEXT PRIMARY KEY REFERENCES agent_workspace(id) ON DELETE CASCADE,
      id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, collection_url TEXT NOT NULL UNIQUE,
      secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      revision INTEGER NOT NULL DEFAULT 1, roles TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_calendar_access_epoch (
      member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(member_id,workspace_id)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS calendar_member_role_epoch AFTER UPDATE OF role ON member
      WHEN OLD.role <> NEW.role BEGIN
      INSERT INTO agent_calendar_access_epoch VALUES (NEW.id,'',1)
      ON CONFLICT(member_id,workspace_id) DO UPDATE SET revision=revision+1;
    END;
    CREATE TRIGGER IF NOT EXISTS calendar_workspace_grant_epoch AFTER INSERT ON agent_workspace_member BEGIN
      INSERT INTO agent_calendar_access_epoch VALUES (NEW.member_id,NEW.workspace_id,1)
      ON CONFLICT(member_id,workspace_id) DO UPDATE SET revision=revision+1;
    END;
    CREATE TRIGGER IF NOT EXISTS calendar_workspace_revoke_epoch AFTER DELETE ON agent_workspace_member
      WHEN EXISTS (SELECT 1 FROM member WHERE id=OLD.member_id) BEGIN
      INSERT INTO agent_calendar_access_epoch VALUES (OLD.member_id,OLD.workspace_id,1)
      ON CONFLICT(member_id,workspace_id) DO UPDATE SET revision=revision+1;
    END;`);
  }
  row(workspaceId: string) {
    return this.db
      .prepare("SELECT * FROM agent_workspace_calendar WHERE workspace_id=?")
      .get(workspaceId) as Row | undefined;
  }
  private seal(
    value: { username: string; password: string },
    workspaceId: string,
    id: string,
  ) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([workspaceId, id])));
    const encrypted = Buffer.concat([
      cipher.update(
        JSON.stringify({ username: value.username, password: value.password }),
      ),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), encrypted]
      .map((b) => b.toString("base64url"))
      .join(".");
  }
  private credentials(row: Row) {
    const parts = row.secret.split(".").map((v) => Buffer.from(v, "base64url"));
    if (parts.length !== 3) throw Error("Invalid calendar credential");
    const decipher = createDecipheriv("aes-256-gcm", this.key, parts[0]!, {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(JSON.stringify([row.workspace_id, row.id])));
    decipher.setAuthTag(parts[1]!);
    return JSON.parse(
      Buffer.concat([decipher.update(parts[2]!), decipher.final()]).toString(
        "utf8",
      ),
    ) as { username: string; password: string };
  }
  list(organizationId: string, workspaceId: string, role: Role) {
    const row = this.row(workspaceId),
      canManage = role !== "member";
    const roles = row
      ? z.array(OrganizationRole).parse(JSON.parse(row.roles))
      : [];
    const available = !!row && this.collections.includes(row.collection_url);
    const canCreate = available && !!row?.enabled && roles.includes(role);
    return WorkspaceCalendarSchema.parse({
      profile: "agent-workspace-calendar/1",
      organizationId,
      workspaceId,
      canManage,
      allowedCollections: canManage ? this.collections : [],
      calendar:
        row && (canManage || canCreate)
          ? {
              id: row.id,
              name: row.name,
              collectionUrl: row.collection_url,
              revision: row.revision,
              enabled: !!row.enabled,
              roles: canManage ? roles : [],
              canCreate,
              state: !available
                ? "unavailable"
                : row.enabled
                  ? "configured"
                  : "disabled",
            }
          : null,
    });
  }
  update(input: z.infer<typeof CalendarCommand>) {
    const row = this.row(input.workspaceId);
    if (input.type === "create") {
      if (row) throw new IdentityError(409, "calendar_conflict");
      if (!this.collections.includes(input.collectionUrl))
        throw new IdentityError(403, "calendar_collection_denied");
      if (
        this.db
          .prepare(
            "SELECT 1 FROM agent_workspace_calendar WHERE collection_url=?",
          )
          .get(input.collectionUrl)
      )
        throw new IdentityError(409, "calendar_conflict");
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO agent_workspace_calendar (workspace_id,id,name,collection_url,secret,roles) VALUES (?,?,?,?,?,?)",
        )
        .run(
          input.workspaceId,
          id,
          input.name,
          input.collectionUrl,
          this.seal(input, input.workspaceId, id),
          "[]",
        );
      return id;
    }
    if (!row || row.id !== input.calendarId || row.revision !== input.revision)
      throw new IdentityError(409, "calendar_conflict");
    if (input.type === "remove")
      this.db
        .prepare("DELETE FROM agent_workspace_calendar WHERE workspace_id=?")
        .run(input.workspaceId);
    else if (input.type === "rotate")
      this.db
        .prepare(
          "UPDATE agent_workspace_calendar SET secret=?,revision=revision+1 WHERE workspace_id=?",
        )
        .run(this.seal(input, input.workspaceId, row.id), input.workspaceId);
    else {
      if (input.enabled && !this.collections.includes(row.collection_url))
        throw new IdentityError(403, "calendar_collection_denied");
      this.db
        .prepare(
          "UPDATE agent_workspace_calendar SET enabled=?,roles=?,revision=revision+1 WHERE workspace_id=?",
        )
        .run(
          Number(input.enabled),
          JSON.stringify(input.roles),
          input.workspaceId,
        );
    }
    return row.id;
  }
  access(scope: Scope) {
    if (!isAccountScope(scope)) return;
    const actor = this.db
      .prepare(
        `SELECT m.role, m.id AS member_id, w.organization_id,
      COALESCE(e.revision,0) AS member_epoch, COALESCE(g.revision,0) AS grant_epoch
      FROM agent_workspace w
      JOIN member m ON m."organizationId"=w.organization_id AND m."userId"=?
      LEFT JOIN agent_calendar_access_epoch e ON e.member_id=m.id AND e.workspace_id=''
      LEFT JOIN agent_calendar_access_epoch g ON g.member_id=m.id AND g.workspace_id=w.id
      WHERE w.id=?`,
      )
      .get(scope.userId, scope.workspaceId);
    if (!actor) return;
    const role = OrganizationRole.parse(actor.role);
    if (
      role === "member" &&
      !this.db
        .prepare(
          "SELECT 1 FROM agent_workspace_member WHERE workspace_id=? AND member_id=?",
        )
        .get(scope.workspaceId, actor.member_id!)
    )
      return;
    const row = this.row(scope.workspaceId);
    if (
      !row ||
      !this.list(String(actor.organization_id), scope.workspaceId, role)
        .calendar?.canCreate
    )
      return;
    const stamp = createHash("sha256")
      .update(
        JSON.stringify([
          row.id,
          row.revision,
          actor.member_id,
          actor.member_epoch,
          actor.grant_epoch,
        ]),
      )
      .digest("hex");
    return {
      row,
      organizationId: String(actor.organization_id),
      target: {
        integrationId: `workspace-calendar-${stamp}`,
        label: row.name,
        collectionUrl: row.collection_url,
        provider: "caldav" as const,
        invitations: "none" as const,
      },
    };
  }
  config(scope: Scope) {
    const access = this.access(scope);
    return access
      ? {
          ...access,
          config: CalendarConfigSchema.parse({
            scope,
            target: access.target,
            ...this.credentials(access.row),
          }),
        }
      : undefined;
  }
}
