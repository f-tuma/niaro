import { createHash, createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AUTH_PROFILE,
  PROFILE,
  DEVICE_SESSION_PROFILE,
  CredentialSchema,
  AuthSessionSchema,
} from "../../packages/protocol";
import {
  RefreshRequestSchema,
  RevokeDeviceSchema,
} from "../../packages/protocol/device-session";
import { AuthError } from "../fixture-server/auth";

export type DeviceIdentity = {
  member_id: string;
  organization_id: string;
  workspace_id: string;
  user_id: string;
  server_id: string;
};
type Device = DeviceIdentity & {
  id: string;
  refresh_digest: string;
  access_digest: string;
  access_expires_at: number;
  idle_expires_at: number;
  previous_refresh: string | null;
  rotation_id: string | null;
  previous_access: string | null;
  previous_access_expires_at: number | null;
  activation_deadline: number | null;
};
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const derive = (token: string, requestId: string, purpose: string) =>
  createHmac("sha256", token)
    .update(`agent-device-session/1:${purpose}:${requestId}`)
    .digest("base64url");

/** Independent device grants. Only hashes are persisted; access and refresh secrets are distinct. */
export class DeviceSessions {
  constructor(
    private db: DatabaseSync,
    private accessTtlMs: number,
    private idleTtlMs: number,
    private checkAccess: (
      identity: DeviceIdentity,
      workspaceId: string,
    ) => unknown,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_mobile_device (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL, refresh_digest TEXT NOT NULL UNIQUE, access_digest TEXT NOT NULL UNIQUE,
      access_expires_at INTEGER NOT NULL, idle_expires_at INTEGER NOT NULL,
      previous_refresh TEXT, rotation_id TEXT, previous_access TEXT, previous_access_expires_at INTEGER,
      activation_deadline INTEGER
    ) STRICT`);
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(agent_mobile_device)")
        .all()
        .map((column) => String(column.name)),
    );
    if (!columns.has("activation_deadline"))
      db.exec(
        "ALTER TABLE agent_mobile_device ADD COLUMN activation_deadline INTEGER",
      );
    // When the person signed in on the device; older rows show no date.
    if (!columns.has("created_at"))
      db.exec("ALTER TABLE agent_mobile_device ADD COLUMN created_at INTEGER");
  }
  /** The person's own devices, newest first; last activity is the last refresh. */
  listOwn(userId: string) {
    this.prune();
    return this.db
      .prepare(
        "SELECT d.id,d.workspace_id AS workspaceId,w.name AS workspaceName,d.created_at AS createdAt,d.idle_expires_at AS idleExpiresAt FROM agent_mobile_device d LEFT JOIN agent_workspace w ON w.id=d.workspace_id WHERE d.user_id=? ORDER BY d.idle_expires_at DESC",
      )
      .all(userId)
      .map((row) => ({
        id: String(row.id),
        workspaceId: String(row.workspaceId),
        workspaceName:
          row.workspaceName === null ? null : String(row.workspaceName),
        createdAt: row.createdAt === null ? null : Number(row.createdAt),
        lastActiveAt: Number(row.idleExpiresAt) - this.idleTtlMs,
      }));
  }
  revokeOwn(userId: string, id: string) {
    return (
      this.db
        .prepare("DELETE FROM agent_mobile_device WHERE id=? AND user_id=?")
        .run(id, userId).changes === 1
    );
  }
  prune() {
    this.db
      .prepare(
        "DELETE FROM agent_mobile_device WHERE idle_expires_at<=? OR activation_deadline<=?",
      )
      .run(Date.now(), Date.now());
  }
  private check(row: Device, workspaceId: string, serverId: string) {
    if (row.idle_expires_at <= Date.now())
      throw new AuthError(401, "auth_expired");
    if (
      row.activation_deadline !== null &&
      row.activation_deadline <= Date.now()
    )
      throw new AuthError(401, "auth_expired");
    if (row.server_id !== serverId)
      throw new AuthError(403, "auth_scope_mismatch");
    this.checkAccess(row, workspaceId);
  }
  private session(row: Device) {
    return AuthSessionSchema.parse({
      authProfile: AUTH_PROFILE,
      profile: PROFILE,
      expiresAt: new Date(row.access_expires_at).toISOString(),
      scope: {
        serverId: row.server_id,
        connectionId: `account-${row.workspace_id}`,
        workspaceId: row.workspace_id,
        userId: row.user_id,
      },
      permissions: ["workflow.read", "workflow.write"],
    });
  }
  private credential(row: Device, accessToken: string, refreshToken: string) {
    return CredentialSchema.parse({
      ...this.session(row),
      accessToken,
      refresh: {
        profile: DEVICE_SESSION_PROFILE,
        token: refreshToken,
        expiresAt: new Date(row.idle_expires_at).toISOString(),
      },
    });
  }
  issue(identity: DeviceIdentity) {
    const row: Device = {
      ...identity,
      id: hash(secret()),
      refresh_digest: "",
      access_digest: "",
      access_expires_at: Date.now() + this.accessTtlMs,
      idle_expires_at: Date.now() + this.idleTtlMs,
      previous_refresh: null,
      rotation_id: null,
      previous_access: null,
      previous_access_expires_at: null,
      activation_deadline: Date.now() + 300_000,
    };
    const access = secret(),
      refresh = secret();
    row.access_digest = hash(access);
    row.refresh_digest = hash(refresh);
    this.db
      .prepare(
        "INSERT INTO agent_mobile_device (id,member_id,organization_id,workspace_id,user_id,server_id,refresh_digest,access_digest,access_expires_at,idle_expires_at,previous_refresh,rotation_id,previous_access,previous_access_expires_at,activation_deadline,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        row.id,
        row.member_id,
        row.organization_id,
        row.workspace_id,
        row.user_id,
        row.server_id,
        row.refresh_digest,
        row.access_digest,
        row.access_expires_at,
        row.idle_expires_at,
        null,
        null,
        null,
        null,
        row.activation_deadline,
        Date.now(),
      );
    return this.credential(row, access, refresh);
  }
  refresh(raw: unknown, workspaceId: string, serverId: string) {
    const request = RefreshRequestSchema.parse(raw),
      digest = hash(request.refreshToken);
    const row = this.db
      .prepare(
        "SELECT * FROM agent_mobile_device WHERE refresh_digest=? OR previous_refresh=?",
      )
      .get(digest, digest) as Device | undefined;
    if (!row) throw new AuthError(401, "auth_expired");
    this.check(row, workspaceId, serverId);
    const access = derive(request.refreshToken, request.requestId, "access"),
      refresh = derive(request.refreshToken, request.requestId, "refresh");
    if (row.previous_refresh === digest) {
      // Exactly one recoverable rotation: retries never extend either expiry or change secrets.
      if (row.rotation_id !== request.requestId)
        throw new AuthError(401, "auth_expired");
      return this.credential(row, access, refresh);
    }
    const next: Device = {
      ...row,
      refresh_digest: hash(refresh),
      access_digest: hash(access),
      previous_refresh: digest,
      rotation_id: request.requestId,
      previous_access: row.access_digest,
      previous_access_expires_at: Math.min(
        row.access_expires_at,
        Date.now() + 60_000,
      ),
      access_expires_at: Date.now() + this.accessTtlMs,
      idle_expires_at: Date.now() + this.idleTtlMs,
    };
    this.db
      .prepare(
        `UPDATE agent_mobile_device SET refresh_digest=?,access_digest=?,access_expires_at=?,idle_expires_at=?,previous_refresh=?,rotation_id=?,previous_access=?,previous_access_expires_at=?,activation_deadline=NULL WHERE id=?`,
      )
      .run(
        next.refresh_digest,
        next.access_digest,
        next.access_expires_at,
        next.idle_expires_at,
        digest,
        request.requestId,
        next.previous_access,
        next.previous_access_expires_at,
        row.id,
      );
    return this.credential(next, access, refresh);
  }
  authenticate(
    digest: string,
    workspaceId: string,
    serverId: string,
    stableId = false,
  ) {
    const row = (
      stableId
        ? this.db
            .prepare("SELECT * FROM agent_mobile_device WHERE id=?")
            .get(digest)
        : this.db
            .prepare(
              "SELECT * FROM agent_mobile_device WHERE access_digest=? OR previous_access=?",
            )
            .get(digest, digest)
    ) as Device | undefined;
    if (!row) return undefined;
    this.check(row, workspaceId, serverId);
    const expiry =
      !stableId && row.previous_access === digest
        ? row.previous_access_expires_at!
        : row.access_expires_at;
    if (!stableId && expiry <= Date.now())
      throw new AuthError(401, "auth_expired");
    if (row.activation_deadline !== null)
      this.db
        .prepare(
          "UPDATE agent_mobile_device SET activation_deadline=NULL WHERE id=?",
        )
        .run(row.id);
    const session = this.session({ ...row, access_expires_at: expiry });
    return {
      grant: {
        ...row,
        session_id: "",
        expires_at: row.idle_expires_at,
        session_expires_at: expiry,
      },
      session,
      credentialId: row.id,
    };
  }
  revokeAccess(digest: string) {
    this.db
      .prepare(
        "DELETE FROM agent_mobile_device WHERE access_digest=? OR previous_access=?",
      )
      .run(digest, digest);
  }
  revokeRefresh(raw: unknown, workspaceId: string, serverId: string) {
    const { refreshToken } = RevokeDeviceSchema.parse(raw),
      digest = hash(refreshToken);
    this.db
      .prepare(
        "DELETE FROM agent_mobile_device WHERE (refresh_digest=? OR previous_refresh=?) AND workspace_id=? AND server_id=?",
      )
      .run(digest, digest, workspaceId, serverId);
  }
}
