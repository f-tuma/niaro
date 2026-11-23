import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AuditRecord } from "../../packages/protocol/audit";
import {
  McpPolicy,
  type McpAdminApp,
  type McpAppState,
  type McpAvailability,
} from "../../packages/protocol/mcp-admin";
import { IdentityError } from "./error";

/** Pending app requests one organization may have before more are refused. */
const MAX_PENDING_APPS = 100;
type AppRow = {
  id: string;
  client_id: string;
  workspace_id: string;
  status: McpAppState;
  requested_by_user_id: string | null;
  requested_at: number;
  revision: number;
};
type Access = { organizationId: string; role: string };
const parseJson = (value: unknown) => {
  try {
    return JSON.parse(String(value)) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Members' external AI apps policy per workspace (NIAR-237) and the approval
 * of each OAuth app per workspace. Owners and administrators are not subject
 * to either. Call in IdentityService's queue.
 */
export class McpPolicyStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: (record: AuditRecord) => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_mcp_policy (
      workspace_id TEXT PRIMARY KEY REFERENCES agent_workspace(id) ON DELETE CASCADE,
      policy TEXT NOT NULL CHECK(policy IN ('off','review','free')),
      revision INTEGER NOT NULL
    ) STRICT`);
    if (this.hasTable("agent_mcp_oauth_app")) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE agent_mcp_oauth_app (
        id TEXT NOT NULL UNIQUE,
        client_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('approved','pending','rejected')),
        requested_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
        requested_at INTEGER NOT NULL,
        reviewed_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
        reviewed_at INTEGER, reason TEXT, revision INTEGER NOT NULL,
        PRIMARY KEY(client_id, workspace_id)
      ) STRICT`);
      this.backfill();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  private hasTable(name: string) {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
  }
  /** Once, when the approvals table appears: every app members could link
   * before stays linkable. Apps registered on this server without an
   * organization are approved in every workspace; metadata-document apps in
   * the workspaces they were already linked into. */
  private backfill() {
    if (!this.hasTable("agent_workspace")) return;
    const insert = `INSERT OR IGNORE INTO agent_mcp_oauth_app
      (id,client_id,workspace_id,status,requested_at,revision)`;
    const at = this.now();
    if (this.hasTable("agent_mcp_oauth_client")) {
      const owned = this.db
        .prepare("PRAGMA table_info(agent_mcp_oauth_client)")
        .all()
        .some((column) => column.name === "organization_id");
      this.db
        .prepare(
          `${insert} SELECT lower(hex(randomblob(16))),c.client_id,w.id,'approved',?,1
          FROM agent_mcp_oauth_client c CROSS JOIN agent_workspace w
          ${owned ? "WHERE c.organization_id IS NULL" : ""}`,
        )
        .run(at);
    }
    if (
      this.hasTable("agent_mcp_oauth_binding") &&
      this.hasTable("agent_mcp_access")
    )
      this.db
        .prepare(
          `${insert} SELECT lower(hex(randomblob(16))),client_id,workspace_id,'approved',?,1
          FROM (SELECT DISTINCT b.client_id,a.workspace_id FROM agent_mcp_oauth_binding b
            JOIN agent_mcp_access a ON a.id=b.grant_id)`,
        )
        .run(at);
  }
  read(workspaceId: string) {
    const row = this.db
      .prepare(
        "SELECT policy,revision FROM agent_mcp_policy WHERE workspace_id=?",
      )
      .get(workspaceId);
    return row
      ? { policy: McpPolicy.parse(row.policy), revision: Number(row.revision) }
      : { policy: "review" as const, revision: 0 };
  }
  policy(workspaceId: string) {
    return this.read(workspaceId).policy;
  }
  save(workspaceId: string, policy: McpPolicy, revision: number) {
    const current = this.read(workspaceId);
    if (current.revision !== revision)
      throw new IdentityError(409, "mcp_policy_conflict");
    this.db
      .prepare(
        `INSERT INTO agent_mcp_policy (workspace_id,policy,revision) VALUES (?,?,?)
      ON CONFLICT(workspace_id) DO UPDATE SET policy=excluded.policy,revision=excluded.revision`,
      )
      .run(workspaceId, policy, revision + 1);
    return { previous: current.policy, policy, revision: revision + 1 };
  }
  /** The person's role where they may use the workspace; undefined without access. */
  private access(userId: string, workspaceId: string): Access | undefined {
    const row = this.db
      .prepare(
        `SELECT m.role,w.organization_id FROM agent_workspace w
      JOIN member m ON m."organizationId"=w.organization_id AND m."userId"=?
      WHERE w.id=? AND (m.role IN ('owner','admin') OR EXISTS
        (SELECT 1 FROM agent_workspace_member wm WHERE wm.workspace_id=w.id AND wm.member_id=m.id))`,
      )
      .get(userId, workspaceId);
    return row
      ? {
          organizationId: String(row.organization_id),
          role: String(row.role),
        }
      : undefined;
  }
  /** The organization an app registered on this server belongs to; null for
   * one registered before NIAR-237 or named by its metadata document. */
  private clientOrganization(clientId: string): string | null {
    if (!this.hasTable("agent_mcp_oauth_client")) return null;
    const row = this.db
      .prepare(
        "SELECT organization_id FROM agent_mcp_oauth_client WHERE client_id=?",
      )
      .get(clientId);
    return typeof row?.organization_id === "string"
      ? row.organization_id
      : null;
  }
  private app(clientId: string, workspaceId: string) {
    return this.db
      .prepare(
        "SELECT * FROM agent_mcp_oauth_app WHERE client_id=? AND workspace_id=?",
      )
      .get(clientId, workspaceId) as AppRow | undefined;
  }
  private state(
    access: Access,
    clientId: string,
    workspaceId: string,
  ): McpAvailability {
    if (access.role !== "member") return "available";
    const policy = this.policy(workspaceId);
    if (policy !== "review") return policy === "off" ? "off" : "available";
    const status = this.app(clientId, workspaceId)?.status;
    return status === "approved" ? "available" : (status ?? "request");
  }
  /** Before an OAuth consent creates a grant. A member's first attempt on an
   * app nobody decided files a request for administrators, then refuses. */
  linkable(input: { userId: string; clientId: string; workspaceId: string }) {
    const access = this.access(input.userId, input.workspaceId);
    const owner = this.clientOrganization(input.clientId);
    if (!access || (owner !== null && owner !== access.organizationId))
      throw new IdentityError(403, "mcp_scope_mismatch");
    const state = this.state(access, input.clientId, input.workspaceId);
    if (state === "available") return;
    if (state === "off") throw new IdentityError(403, "mcp_external_apps_off");
    if (state === "rejected") throw new IdentityError(403, "mcp_app_rejected");
    if (state === "request") {
      this.requestRoom(access.organizationId);
      this.request(
        input.clientId,
        input.workspaceId,
        access.organizationId,
        input.userId,
        "pending",
      );
    }
    throw new IdentityError(403, "mcp_app_pending");
  }
  /** Every workspace the person may use with this app, and what linking means there. */
  availability(input: { userId: string; clientId: string }) {
    const owner = this.clientOrganization(input.clientId);
    return this.db
      .prepare(
        `SELECT w.id FROM agent_workspace w JOIN member m ON m."organizationId"=w.organization_id
      WHERE m."userId"=? AND (? IS NULL OR w.organization_id=?)
        AND (m.role IN ('owner','admin') OR EXISTS
          (SELECT 1 FROM agent_workspace_member wm WHERE wm.workspace_id=w.id AND wm.member_id=m.id))
      ORDER BY w.id LIMIT 1000`,
      )
      .all(input.userId, owner, owner)
      .map((row) => {
        const workspaceId = String(row.id);
        return {
          id: workspaceId,
          state: this.state(
            this.access(input.userId, workspaceId)!,
            input.clientId,
            workspaceId,
          ),
        };
      });
  }
  /** Pending app requests are bounded per organization; checked before a
   * registration creates its client, so no client is left without a state. */
  requestRoom(organizationId: string) {
    const waiting = this.db
      .prepare(
        `SELECT count(*) AS n FROM agent_mcp_oauth_app a JOIN agent_workspace w ON w.id=a.workspace_id
        WHERE w.organization_id=? AND a.status='pending'`,
      )
      .get(organizationId)!;
    if (Number(waiting.n) >= MAX_PENDING_APPS)
      throw new IdentityError(429, "identity_limit");
  }
  /** Records an app's state in a workspace as it was registered or requested;
   * a pending request is audited. Callers check `requestRoom` first. */
  request(
    clientId: string,
    workspaceId: string,
    organizationId: string,
    userId: string,
    status: "approved" | "pending",
    reviewed = false,
  ) {
    const id = randomUUID();
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO agent_mcp_oauth_app (id,client_id,workspace_id,status,requested_by_user_id,
        requested_at,reviewed_by_user_id,reviewed_at,revision) VALUES (?,?,?,?,?,?,?,?,1)`,
      )
      .run(
        id,
        clientId,
        workspaceId,
        status,
        userId,
        at,
        reviewed ? userId : null,
        reviewed ? at : null,
      );
    if (status === "pending")
      this.audit({
        organizationId,
        workspaceId,
        actorId: userId,
        source: "console",
        action: "mcp.app_requested",
        targetId: id,
        outcome: "succeeded",
        details: {},
      });
    return id;
  }
  /** Name and callbacks of an app; undefined once it is gone. */
  private describe(clientId: string) {
    const managed = this.hasTable("agent_mcp_oauth_client")
      ? this.db
          .prepare(
            "SELECT name,redirect_uris FROM agent_mcp_oauth_client WHERE client_id=?",
          )
          .get(clientId)
      : undefined;
    const known =
      !managed && this.hasTable("oauthClient")
        ? this.db
            .prepare(
              'SELECT name,"redirectUris" FROM "oauthClient" WHERE "clientId"=?',
            )
            .get(clientId)
        : undefined;
    const source = managed ?? known;
    if (!source) return undefined;
    const uris = parseJson(
      managed ? managed.redirect_uris : known!.redirectUris,
    );
    let host: string | null = null;
    if (!managed)
      try {
        host = new URL(clientId).host.slice(0, 255);
      } catch {
        host = null;
      }
    return {
      name: String(source.name ?? "").slice(0, 100) || clientId.slice(0, 100),
      host,
      redirectUris: (Array.isArray(uris) ? uris : [])
        .filter((uri): uri is string => typeof uri === "string")
        .slice(0, 10)
        .map((uri) => uri.slice(0, 2048)),
    };
  }
  /** Apps of the workspace for its administrators: those with a state here,
   * and the organization's own apps nobody decided yet. */
  apps(workspaceId: string, organizationId: string): McpAdminApp[] {
    const rows = this.db
      .prepare(
        `SELECT a.client_id,a.status,a.revision,a.requested_at,u.name AS person_name,u.email AS person_email
      FROM agent_mcp_oauth_app a LEFT JOIN user u ON u.id=a.requested_by_user_id
      WHERE a.workspace_id=? ORDER BY a.requested_at DESC,a.client_id LIMIT 1000`,
      )
      .all(workspaceId);
    const undecided = this.hasTable("agent_mcp_oauth_client")
      ? this.db
          .prepare(
            `SELECT client_id FROM agent_mcp_oauth_client c WHERE organization_id=?
          AND NOT EXISTS (SELECT 1 FROM agent_mcp_oauth_app a WHERE a.client_id=c.client_id AND a.workspace_id=?)
          ORDER BY created_at DESC LIMIT 1000`,
          )
          .all(organizationId, workspaceId)
      : [];
    return [...rows, ...undecided].flatMap((row) => {
      const clientId = String(row.client_id);
      const app = this.describe(clientId);
      if (!app) return [];
      const decided = row.status !== undefined;
      return [
        {
          clientId,
          ...app,
          state: decided ? (row.status as McpAppState) : null,
          revision: decided ? Number(row.revision) : 0,
          requestedBy:
            decided && row.person_name !== null
              ? {
                  name: String(row.person_name ?? "").slice(0, 200),
                  email: String(row.person_email ?? "").slice(0, 320),
                }
              : null,
          requestedAt: decided
            ? new Date(Number(row.requested_at)).toISOString()
            : null,
        },
      ];
    });
  }
  /** Waiting member grants and app requests of a workspace. */
  waiting(workspaceId: string) {
    const row = this.db
      .prepare(
        `SELECT (SELECT count(*) FROM agent_mcp_oauth_app WHERE workspace_id=? AND status='pending')
        + (SELECT count(*) FROM agent_mcp_access a JOIN member m ON m.id=a.member_id
          WHERE a.workspace_id=? AND a.status='pending' AND a.revoked_at IS NULL AND a.expires_at>?
          AND m.role='member') AS n`,
      )
      .get(workspaceId, workspaceId, this.now())!;
    return Number(row.n);
  }
  /** An administrator's decision on an app in a workspace; `revision` 0 for
   * an app nobody decided yet. Withdrawing applies to approved apps only. */
  reviewApp(input: {
    workspaceId: string;
    organizationId: string;
    clientId: string;
    revision: number;
    decision: "approve" | "reject" | "withdraw";
    reason?: string;
    reviewerId: string;
  }) {
    const owner = this.clientOrganization(input.clientId);
    if (
      (owner !== null && owner !== input.organizationId) ||
      !this.describe(input.clientId)
    )
      throw new IdentityError(404, "identity_not_found");
    const row = this.app(input.clientId, input.workspaceId);
    const from = row?.status ?? null;
    const allowed =
      input.decision === "approve"
        ? from !== "approved"
        : input.decision === "reject"
          ? from === null || from === "pending"
          : from === "approved";
    if ((row?.revision ?? 0) !== input.revision || !allowed)
      throw new IdentityError(409, "mcp_review_conflict");
    const status = input.decision === "approve" ? "approved" : "rejected";
    const reason = input.reason?.trim() || null;
    const at = this.now();
    const id = row?.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO agent_mcp_oauth_app (id,client_id,workspace_id,status,requested_at,
        reviewed_by_user_id,reviewed_at,reason,revision) VALUES (?,?,?,?,?,?,?,?,1)
      ON CONFLICT(client_id,workspace_id) DO UPDATE SET status=excluded.status,
        reviewed_by_user_id=excluded.reviewed_by_user_id,reviewed_at=excluded.reviewed_at,
        reason=excluded.reason,revision=agent_mcp_oauth_app.revision+1`,
      )
      .run(
        id,
        input.clientId,
        input.workspaceId,
        status,
        at,
        input.reviewerId,
        at,
        reason,
      );
    return { id, status };
  }
}
