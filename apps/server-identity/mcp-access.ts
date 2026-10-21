import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  IdentityId,
  IdentityName,
  OrganizationRole,
} from "../../packages/protocol/identity";
import { IdentityError } from "./error";

/** Processor scopes submit/observe server-run tasks; the connector scope calls
 * the workspace's permitted service actions directly from the MCP client. */
export const MCP_ACCESS_SCOPES = [
  "native.view",
  "native.run",
  "services.call",
] as const;
export type McpAccessScope = (typeof MCP_ACCESS_SCOPES)[number];
/** Running a task includes reading its status/result; view alone cannot run it. */
export function mcpScopesAllow(
  granted: readonly string[],
  required: readonly McpAccessScope[],
) {
  return required.every(
    (scope) =>
      granted.includes(scope) ||
      (scope === "native.view" && granted.includes("native.run")),
  );
}
const Scope = z.enum(MCP_ACCESS_SCOPES);
const Scopes = z
  .array(Scope)
  .min(1)
  .max(3)
  .refine((v) => new Set(v).size === v.length);
const IssueFields = z.strictObject({
  serverId: IdentityId,
  workspaceId: IdentityId,
  label: IdentityName,
  scopes: Scopes,
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export const McpIssueSchema = IssueFields.extend({ sessionId: IdentityId });
export const McpIssueForUserSchema = IssueFields.extend({
  administratorSessionId: IdentityId,
  userId: IdentityId,
});
export const McpManagementScopeSchema = z.strictObject({
  sessionId: IdentityId,
  serverId: IdentityId,
  workspaceId: IdentityId,
});
export const McpRevokeSchema = McpManagementScopeSchema.extend({
  grantId: IdentityId,
});
const AuthenticationTarget = z.strictObject({
  serverId: IdentityId,
  workspaceId: IdentityId.optional(),
  requiredScopes: z.array(Scope).max(3).optional(),
});
export type McpAuthenticationTarget = z.infer<typeof AuthenticationTarget>;

export type McpGrant = {
  id: string;
  userId: string;
  memberId: string;
  organizationId: string;
  workspaceId: string;
  serverId: string;
  label: string;
  scopes: McpAccessScope[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  issuedByUserId: string | null;
};
export type McpPrincipal = {
  grantId: string;
  userId: string;
  memberId: string;
  organizationId: string;
  workspaceId: string;
  serverId: string;
  role: z.infer<typeof OrganizationRole>;
  scopes: McpAccessScope[];
  expiresAt: string;
};
type StoredGrant = {
  id: string;
  user_id: string;
  member_id: string;
  organization_id: string;
  workspace_id: string;
  server_id: string;
  label: string;
  scopes_json: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  issued_by_user_id: string | null;
};
type Membership = {
  memberId: string;
  organizationId: string;
  role: z.infer<typeof OrganizationRole>;
};
const PUBLIC_COLUMNS = `id,user_id,member_id,organization_id,workspace_id,server_id,
  label,scopes_json,created_at,expires_at,revoked_at,last_used_at,issued_by_user_id`;
const TOKEN_PREFIX = "agent_mcp_";
const digest = (token: string) =>
  createHash("sha256").update(`agent-mcp-access/1\0${token}`).digest("hex");
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new IdentityError(400, "mcp_access_invalid");
  return result.data;
}

/** Dedicated MCP grants, never mobile or console credentials. Call all methods
 * in IdentityService's queue. The mandatory callback reads current server state;
 * identity, membership and workspace authorization remain in the existing DB. */
export class McpAccessStore {
  private readonly now: () => number;
  private readonly maxTtlMs: number;
  private readonly maxActiveGrants: number;
  constructor(
    private readonly db: DatabaseSync,
    private readonly options: {
      checkServer: (serverId: string) => boolean;
      now?: () => number;
      maxTtlMs?: number;
      maxActiveGrants?: number;
    },
  ) {
    this.now = options.now ?? (() => Date.now());
    this.maxTtlMs = options.maxTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.maxActiveGrants = options.maxActiveGrants ?? 50;
    if (
      !Number.isSafeInteger(this.maxTtlMs) ||
      this.maxTtlMs <= 0 ||
      !Number.isSafeInteger(this.maxActiveGrants) ||
      this.maxActiveGrants <= 0
    )
      throw new Error("mcp_access_configuration_invalid");
    db.exec(`CREATE TABLE IF NOT EXISTS agent_mcp_access (
      id TEXT PRIMARY KEY,
      token_digest TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL, label TEXT NOT NULL,
      scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      revoked_at INTEGER, last_used_at INTEGER,
      issued_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
      CHECK(expires_at>created_at)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_mcp_access_owner
      ON agent_mcp_access(user_id,server_id,workspace_id);`);
  }
  private checkServer(serverId: string) {
    if (!this.options.checkServer(serverId))
      throw new IdentityError(403, "mcp_server_unavailable");
  }
  private sessionUser(sessionId: string) {
    const session = this.db
      .prepare(
        'SELECT s."userId",s."expiresAt" FROM session s JOIN user u ON u.id=s."userId" WHERE s.id=?',
      )
      .get(sessionId);
    const expiry = session ? Date.parse(String(session.expiresAt)) : NaN;
    if (!session || !Number.isFinite(expiry) || expiry <= this.now())
      throw new IdentityError(401, "mcp_unauthorized");
    return String(session.userId);
  }
  private membership(
    userId: string,
    workspaceId: string,
    memberId?: string,
    organizationId?: string,
  ): Membership {
    const member = this.db
      .prepare(
        `SELECT m.id,m.role,m."organizationId" FROM member m
       JOIN user u ON u.id=m."userId"
       JOIN agent_workspace w ON w.organization_id=m."organizationId"
       WHERE m."userId"=? AND w.id=?
       AND (? IS NULL OR m.id=?) AND (? IS NULL OR m."organizationId"=?)
       AND (m.role IN ('owner','admin') OR (m.role='member' AND EXISTS
         (SELECT 1 FROM agent_workspace_member wm WHERE wm.workspace_id=w.id AND wm.member_id=m.id)))`,
      )
      .get(
        userId,
        workspaceId,
        memberId ?? null,
        memberId ?? null,
        organizationId ?? null,
        organizationId ?? null,
      );
    if (!member) throw new IdentityError(403, "mcp_scope_mismatch");
    const role = OrganizationRole.safeParse(member.role);
    if (!role.success) throw new IdentityError(403, "mcp_scope_mismatch");
    return {
      memberId: String(member.id),
      organizationId: String(member.organizationId),
      role: role.data,
    };
  }
  private metadata(row: StoredGrant): McpGrant {
    return {
      id: row.id,
      userId: row.user_id,
      memberId: row.member_id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      serverId: row.server_id,
      label: row.label,
      scopes: parse(Scopes, JSON.parse(row.scopes_json)),
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      revokedAt:
        row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
      lastUsedAt:
        row.last_used_at === null
          ? null
          : new Date(row.last_used_at).toISOString(),
      issuedByUserId: row.issued_by_user_id,
    };
  }
  private create(
    userId: string,
    issuer: string,
    input: z.infer<typeof IssueFields>,
  ) {
    this.checkServer(input.serverId);
    const member = this.membership(userId, input.workspaceId);
    const now = this.now();
    if (input.expiresAt <= now || input.expiresAt - now > this.maxTtlMs)
      throw new IdentityError(400, "mcp_access_invalid");
    const count = this.db
      .prepare(
        "SELECT count(*) AS n FROM agent_mcp_access WHERE user_id=? AND server_id=? AND revoked_at IS NULL AND expires_at>?",
      )
      .get(userId, input.serverId, now)!;
    if (Number(count.n) >= this.maxActiveGrants)
      throw new IdentityError(429, "mcp_access_limit");
    const accessToken = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const row: StoredGrant = {
      id: randomUUID(),
      user_id: userId,
      member_id: member.memberId,
      organization_id: member.organizationId,
      workspace_id: input.workspaceId,
      server_id: input.serverId,
      label: input.label,
      scopes_json: JSON.stringify(input.scopes),
      created_at: now,
      expires_at: input.expiresAt,
      revoked_at: null,
      last_used_at: null,
      issued_by_user_id: issuer,
    };
    this.db
      .prepare(
        `INSERT INTO agent_mcp_access (${PUBLIC_COLUMNS},token_digest)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id,
        row.user_id,
        row.member_id,
        row.organization_id,
        row.workspace_id,
        row.server_id,
        row.label,
        row.scopes_json,
        row.created_at,
        row.expires_at,
        row.revoked_at,
        row.last_used_at,
        row.issued_by_user_id,
        digest(accessToken),
      );
    // The secret is returned once; list/authenticate/revoke never return its digest.
    return { grant: this.metadata(row), accessToken };
  }
  issue(raw: unknown) {
    const input = parse(McpIssueSchema, raw);
    const user = this.sessionUser(input.sessionId);
    return this.create(user, user, input);
  }
  /** Explicit administrative issuance. The session must belong to a current
   * owner/admin of the target user's organization; user binding is mandatory.
   * Keep this internal unless a separate administrative consent UI is provided. */
  issueForUser(raw: unknown) {
    const input = parse(McpIssueForUserSchema, raw);
    const issuer = this.sessionUser(input.administratorSessionId);
    const authority = this.membership(issuer, input.workspaceId);
    if (authority.role === "member")
      throw new IdentityError(403, "mcp_scope_mismatch");
    return this.create(input.userId, issuer, input);
  }
  list(raw: unknown): McpGrant[] {
    const input = parse(McpManagementScopeSchema, raw);
    const user = this.sessionUser(input.sessionId);
    this.checkServer(input.serverId);
    this.membership(user, input.workspaceId);
    return (
      this.db
        .prepare(
          `SELECT ${PUBLIC_COLUMNS} FROM agent_mcp_access
      WHERE user_id=? AND server_id=? AND workspace_id=?
      ORDER BY (revoked_at IS NULL AND expires_at>?) DESC,created_at DESC,id LIMIT 200`,
        )
        .all(
          user,
          input.serverId,
          input.workspaceId,
          this.now(),
        ) as StoredGrant[]
    ).map((row) => this.metadata(row));
  }
  revoke(raw: unknown): { revoked: boolean } {
    const input = parse(McpRevokeSchema, raw);
    const user = this.sessionUser(input.sessionId);
    // Revocation remains possible after the server or workspace access is disabled.
    const result = this.db
      .prepare(
        `UPDATE agent_mcp_access SET revoked_at=COALESCE(revoked_at,?)
      WHERE id=? AND user_id=? AND server_id=? AND workspace_id=?`,
      )
      .run(this.now(), input.grantId, user, input.serverId, input.workspaceId);
    return { revoked: Number(result.changes) > 0 };
  }
  /** The person's live grants in every workspace, for their own account page. */
  listOwnActive(userId: string) {
    return (
      this.db
        .prepare(
          `SELECT ${PUBLIC_COLUMNS.replace(/(\w+)/g, "a.$1")},w.name AS workspace_name
      FROM agent_mcp_access a LEFT JOIN agent_workspace w ON w.id=a.workspace_id
      WHERE a.user_id=? AND a.revoked_at IS NULL AND a.expires_at>?
      ORDER BY a.created_at DESC,a.id LIMIT 200`,
        )
        .all(userId, this.now()) as (StoredGrant & {
        workspace_name: string | null;
      })[]
    ).map((row) => ({
      grant: this.metadata(row),
      workspaceName: row.workspace_name,
    }));
  }
  /** Revokes one of the person's own grants (any server or workspace). */
  revokeOwn(userId: string, grantId: string) {
    const result = this.db
      .prepare(
        "UPDATE agent_mcp_access SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL",
      )
      .run(this.now(), grantId, userId);
    this.revokeOAuthTokens(userId, grantId);
    return Number(result.changes) > 0;
  }
  /** Revokes every grant of the person, manual and OAuth alike: a password
   * reset, password change or "sign out everywhere" ends MCP access too. */
  revokeAllOwn(userId: string) {
    const result = this.db
      .prepare(
        "UPDATE agent_mcp_access SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
      )
      .run(this.now(), userId);
    this.revokeOAuthTokens(userId);
    return Number(result.changes);
  }
  /** The grant is the authority; its OAuth tokens are revoked as well so
   * introspection agrees. Tables exist only once the OAuth provider migrated. */
  private revokeOAuthTokens(userId: string, grantId?: string) {
    const at = new Date(this.now()).toISOString();
    for (const table of ["oauthAccessToken", "oauthRefreshToken"]) {
      const columns = this.db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((column) => String(column.name));
      if (
        !["revoked", "userId", "referenceId"].every((c) => columns.includes(c))
      )
        continue;
      this.db
        .prepare(
          `UPDATE "${table}" SET revoked=? WHERE "userId"=? AND revoked IS NULL${grantId ? ' AND "referenceId"=?' : ""}`,
        )
        .run(...(grantId ? [at, userId, grantId] : [at, userId]));
    }
  }
  private authenticateRow(
    row: StoredGrant | undefined,
    target: McpAuthenticationTarget,
  ): McpPrincipal {
    const now = this.now();
    if (!row || row.revoked_at !== null || row.expires_at <= now)
      throw new IdentityError(401, "mcp_unauthorized");
    if (
      row.server_id !== target.serverId ||
      (target.workspaceId !== undefined &&
        row.workspace_id !== target.workspaceId)
    )
      throw new IdentityError(403, "mcp_scope_mismatch");
    this.checkServer(row.server_id);
    const member = this.membership(
      row.user_id,
      row.workspace_id,
      row.member_id,
      row.organization_id,
    );
    let scopes: McpAccessScope[];
    try {
      scopes = Scopes.parse(JSON.parse(row.scopes_json));
    } catch {
      throw new IdentityError(401, "mcp_unauthorized");
    }
    if (!mcpScopesAllow(scopes, target.requiredScopes ?? []))
      throw new IdentityError(403, "mcp_insufficient_scope");
    this.db
      .prepare("UPDATE agent_mcp_access SET last_used_at=? WHERE id=?")
      .run(now, row.id);
    return {
      grantId: row.id,
      userId: row.user_id,
      memberId: row.member_id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      serverId: row.server_id,
      role: member.role,
      scopes,
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }
  authenticate(
    header: string | undefined,
    rawTarget: McpAuthenticationTarget,
  ): McpPrincipal {
    const target = parse(AuthenticationTarget, rawTarget);
    const token = /^Bearer (agent_mcp_[A-Za-z0-9_-]{43})$/i.exec(
      header ?? "",
    )?.[1];
    if (!token) throw new IdentityError(401, "mcp_unauthorized");
    const row = this.db
      .prepare(
        `SELECT ${PUBLIC_COLUMNS} FROM agent_mcp_access WHERE token_digest=?`,
      )
      .get(digest(token)) as StoredGrant | undefined;
    return this.authenticateRow(row, target);
  }
  /** Trusted runtime continuation only. A grant ID is never an HTTP credential.
   * Revalidates expiration, revocation, original membership and server policy. */
  authenticateGrant(
    grantId: string,
    rawTarget: McpAuthenticationTarget,
  ): McpPrincipal {
    const target = parse(AuthenticationTarget, rawTarget);
    const id = parse(IdentityId, grantId);
    const row = this.db
      .prepare(`SELECT ${PUBLIC_COLUMNS} FROM agent_mcp_access WHERE id=?`)
      .get(id) as StoredGrant | undefined;
    return this.authenticateRow(row, target);
  }
}
