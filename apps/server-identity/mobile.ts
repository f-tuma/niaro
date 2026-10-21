import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AUTH_PROFILE,
  PROFILE,
  CredentialSchema,
  type AuthSession,
} from "../../packages/protocol";
import {
  AccountWorkspaceId,
  MobilePairingResult,
} from "../../packages/protocol/mobile-access";
import { OrganizationRole } from "../../packages/protocol/identity";
import { AuthError } from "../fixture-server/auth";
import type { ToolRegistry } from "../server-tools/registry";
import { IdentityError } from "./error";
import { DeviceSessions, type DeviceIdentity } from "./device-sessions";
import type { DecisionRouter } from "../fixture-server/decision";
import type { Transcriber } from "../fixture-server/voice";
import {
  BROWSER_LOGIN_PROFILE,
  BrowserLoginChallenge,
  BrowserLoginDetails,
} from "../../packages/protocol/browser-login";

export type MobileRuntime = {
  nativeRequests?: import("./native-command-requests").NativeCommandRequests;
  retireProcessRequest?: (parentRunId: string) => Promise<boolean>;
  /** The person cancels their own waiting process run at its journal revision. */
  cancelProcessRun?: (
    parentRunId: string,
    expectedRevision: number,
  ) => Promise<void>;
  session: AuthSession;
  modelEnabled: boolean;
  voiceEnabled: boolean;
  model?: DecisionRouter;
  integrations?: import("./catalog-runtime").CatalogRuntime;
  transcriber?: Transcriber;
  meetingAnalyzer?: NonNullable<
    import("./meeting-processing").MeetingProcessingAccess["analyzer"]
  >;
  /** Timestamped meeting transcription, when a speech-to-text model is set. */
  meetingTranscriber?: import("./meeting-processing").MeetingChunkTranscriber;
  /** The workspace's time zone, for meeting deadlines. */
  timeZone?: string;
  synthesizer?: import("../server-integrations/speech").SpeechSynthesizer;
  tools: Pick<ToolRegistry, "has" | "invoke">;
  /** Validate policy and perform a synchronous workflow read/commit in one identity queue turn. */
  run<T>(fn: () => T): Promise<T>;
  /** Final inference commits also require the selected model to remain available. */
  runModel<T>(fn: () => T): Promise<T>;
};
type Grant = {
  session_id: string;
  member_id: string;
  organization_id: string;
  workspace_id: string;
  user_id: string;
  server_id: string;
  expires_at: number;
  session_expires_at: number;
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/**
 * Web chat credentials kept per browser session and workspace: one per open
 * tab (each holds its own in memory and issues the next when refused), so
 * the bound is above the tabs anyone keeps open of one workspace, or the
 * tabs would replace each other's credentials in turn.
 */
export const WEB_PER_BROWSER = 12;
/** Web chat credentials kept per person; the oldest goes first. */
export const WEB_PER_PERSON = 32;
/** A stable handle for a stored credential row that reveals nothing about it. */
export const publicId = (value: string) =>
  createHash("sha256")
    .update(`agent-access-id/1:${value}`)
    .digest("base64url")
    .slice(0, 32);

/** All methods run in IdentityService's queue. No direct Better Auth token leaves the server. */
export class MobileSessionStore {
  private devices: DeviceSessions;
  constructor(
    private db: DatabaseSync,
    private baseURL: string,
    private ttlMs: number,
    idleTtlMs = 30 * 24 * 60 * 60 * 1000,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_mobile_pairing (
        digest TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
        organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, server_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, session_expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_mobile_session (
        digest TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE,
        organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, server_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, session_expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_browser_login (
        digest TEXT PRIMARY KEY, user_digest TEXT NOT NULL UNIQUE,
        server_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
        last_poll INTEGER NOT NULL, status TEXT NOT NULL,
        owner_session TEXT REFERENCES session(id) ON DELETE CASCADE, grant_json TEXT,
        issued_digest TEXT
      ) STRICT;
    `);
    // Web app chat sessions follow one browser session each and never use a
    // device slot; older rows are app sessions.
    if (
      !db
        .prepare("PRAGMA table_info(agent_mobile_session)")
        .all()
        .some((column) => column.name === "web")
    )
      db.exec(
        "ALTER TABLE agent_mobile_session ADD COLUMN web INTEGER NOT NULL DEFAULT 0",
      );
    if (
      !db
        .prepare("PRAGMA table_info(agent_browser_login)")
        .all()
        .some((column) => column.name === "persistent")
    )
      db.exec(
        "ALTER TABLE agent_browser_login ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0",
      );
    this.devices = new DeviceSessions(
      db,
      ttlMs,
      idleTtlMs,
      (grant, workspace) => this.checkMembership(grant, workspace),
    );
  }
  issueApp(grant: DeviceIdentity) {
    this.prune();
    // The person can fix this one: remove a device in their account.
    if (!this.availableSlots(grant.user_id))
      throw new IdentityError(409, "mobile_device_limit");
    if (
      Number(
        this.db
          .prepare(
            "SELECT (SELECT count(*) FROM agent_mobile_session WHERE web=0)+(SELECT count(*) FROM agent_mobile_device) AS n",
          )
          .get()!.n,
      ) >= 512
    )
      throw new AuthError(429, "pairing_rate_limited");
    this.checkMembership(grant, grant.workspace_id);
    return this.devices.issue(grant);
  }
  private prune() {
    this.devices.prune();
    this.db
      .prepare("DELETE FROM agent_browser_login WHERE expires_at<=?")
      .run(Date.now());
    for (const table of ["agent_mobile_pairing", "agent_mobile_session"])
      this.db
        .prepare(`DELETE FROM ${table} WHERE expires_at<=?`)
        .run(Date.now());
  }
  private check(grant: Grant, workspaceId: string) {
    if (grant.workspace_id !== workspaceId)
      throw new AuthError(403, "auth_scope_mismatch");
    const parent = this.db
      .prepare('SELECT "expiresAt" FROM session WHERE id=? AND "userId"=?')
      .get(grant.session_id, grant.user_id);
    // Better Auth's pinned SQLite adapter stores dates as ISO strings (supportsDates=false).
    const parentExpiry = parent ? Date.parse(String(parent.expiresAt)) : NaN;
    if (
      !Number.isFinite(parentExpiry) ||
      parentExpiry <= Date.now() ||
      grant.expires_at <= Date.now() ||
      grant.session_expires_at <= Date.now()
    )
      throw new AuthError(401, "auth_expired");
    return this.checkMembership(grant, workspaceId);
  }
  private checkMembership(grant: DeviceIdentity, workspaceId: string) {
    if (grant.workspace_id !== workspaceId)
      throw new AuthError(403, "auth_scope_mismatch");
    const member = this.db
      .prepare(
        'SELECT m.role FROM member m JOIN agent_workspace w ON w.organization_id=m."organizationId" WHERE m.id=? AND m."userId"=? AND m."organizationId"=? AND w.id=?',
      )
      .get(grant.member_id, grant.user_id, grant.organization_id, workspaceId);
    if (!member) throw new AuthError(403, "auth_scope_mismatch");
    const role = OrganizationRole.parse(member.role);
    if (
      role === "member" &&
      !this.db
        .prepare(
          "SELECT 1 FROM agent_workspace_member WHERE workspace_id=? AND member_id=?",
        )
        .get(workspaceId, grant.member_id)
    )
      throw new AuthError(403, "auth_scope_mismatch");
    return role;
  }
  issue(
    grant: Omit<Grant, "expires_at" | "session_expires_at">,
    parentExpiresAt: Date,
  ) {
    this.prune();
    if (!this.availableSlots(grant.user_id))
      throw new IdentityError(409, "mobile_device_limit");
    const sessionExpiresAt = Math.min(
      parentExpiresAt.getTime(),
      Date.now() + this.ttlMs,
    );
    if (sessionExpiresAt - Date.now() < 10_000)
      throw new IdentityError(409, "mobile_session_ending");
    // One outstanding code per account/workspace; a new code replaces the old one.
    this.db
      .prepare(
        "DELETE FROM agent_mobile_pairing WHERE user_id=? AND workspace_id=?",
      )
      .run(grant.user_id, grant.workspace_id);
    const count = Number(
      this.db
        .prepare("SELECT count(*) AS count FROM agent_mobile_pairing")
        .get()!.count,
    );
    if (count >= 512) throw new IdentityError(429, "identity_limit");
    const code = randomBytes(16).toString("hex");
    const expiresAt = Math.min(sessionExpiresAt, Date.now() + 300_000);
    this.db
      .prepare("INSERT INTO agent_mobile_pairing VALUES (?,?,?,?,?,?,?,?,?)")
      .run(
        hash(code),
        grant.session_id,
        grant.member_id,
        grant.organization_id,
        grant.workspace_id,
        grant.user_id,
        grant.server_id,
        expiresAt,
        sessionExpiresAt,
      );
    return MobilePairingResult.parse({
      organizationId: grant.organization_id,
      workspaceId: grant.workspace_id,
      code,
      address: `${this.baseURL}/v1/${grant.workspace_id}`,
      expiresAt: new Date(expiresAt).toISOString(),
      sessionExpiresAt: new Date(sessionExpiresAt).toISOString(),
    });
  }
  pair(
    code: string,
    workspaceId: string,
    serverId: string,
    persistent = false,
  ) {
    this.prune();
    AccountWorkspaceId.parse(workspaceId);
    const grant = this.db
      .prepare("SELECT * FROM agent_mobile_pairing WHERE digest=?")
      .get(hash(code)) as Grant | undefined;
    if (!grant) throw new AuthError(401, "pairing_invalid");
    this.check(grant, workspaceId);
    if (grant.server_id !== serverId)
      throw new AuthError(403, "auth_scope_mismatch");
    const credential = this.redeem(grant, persistent);
    this.db
      .prepare("DELETE FROM agent_mobile_pairing WHERE digest=?")
      .run(hash(code));
    return credential;
  }
  private redeem(grant: Grant, persistent = false, web = false) {
    const workspaceId = grant.workspace_id,
      serverId = grant.server_id;
    const total = Number(
      this.db
        .prepare(
          "SELECT (SELECT count(*) FROM agent_mobile_session WHERE web=0)+(SELECT count(*) FROM agent_mobile_device) AS count",
        )
        .get()!.count,
    );
    const own = Number(
      this.db
        .prepare(
          "SELECT (SELECT count(*) FROM agent_mobile_session WHERE user_id=? AND web=0)+(SELECT count(*) FROM agent_mobile_device WHERE user_id=?) AS count",
        )
        .get(grant.user_id, grant.user_id)!.count,
    );
    // Web chat credentials are bounded per person in issueWebSession, so
    // they never use a device slot or the server-wide app sign-in budget.
    if (!web && (total >= 512 || own >= 8))
      throw new AuthError(429, "pairing_rate_limited");
    if (persistent) return this.devices.issue(grant);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(grant.session_expires_at).toISOString();
    const credential = CredentialSchema.parse({
      authProfile: AUTH_PROFILE,
      profile: PROFILE,
      accessToken: token,
      expiresAt,
      scope: {
        serverId,
        connectionId: `account-${workspaceId}`,
        workspaceId,
        userId: grant.user_id,
      },
      permissions: ["workflow.read", "workflow.write"],
    });
    this.db
      .prepare(
        "INSERT INTO agent_mobile_session(digest,session_id,member_id,organization_id,workspace_id,user_id,server_id,expires_at,session_expires_at,web) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        hash(token),
        grant.session_id,
        grant.member_id,
        grant.organization_id,
        workspaceId,
        grant.user_id,
        grant.server_id,
        grant.session_expires_at,
        grant.session_expires_at,
        web ? 1 : 0,
      );
    return credential;
  }
  startBrowser(serverId: string, persistent = false) {
    this.prune();
    if (
      Number(
        this.db.prepare("SELECT count(*) AS n FROM agent_browser_login").get()!
          .n,
      ) >= 512
    )
      throw new IdentityError(429, "identity_limit");
    const deviceCode = randomBytes(32).toString("base64url");
    const userCode = randomBytes(6).toString("hex").toUpperCase();
    const expiresAt = Date.now() + 300_000;
    this.db
      .prepare(
        "INSERT INTO agent_browser_login VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?)",
      )
      .run(
        hash(deviceCode),
        hash(userCode),
        serverId,
        expiresAt,
        0,
        "pending",
        persistent ? 1 : 0,
      );
    return BrowserLoginChallenge.parse({
      profile: BROWSER_LOGIN_PROFILE,
      deviceCode,
      userCode,
      serverId,
      verificationUri: `${this.baseURL}/admin/device#${userCode}`,
      expiresAt: new Date(expiresAt).toISOString(),
      interval: 5,
    });
  }
  private browserRow(userCode: string) {
    this.prune();
    const row = this.db
      .prepare("SELECT * FROM agent_browser_login WHERE user_digest=?")
      .get(hash(userCode));
    if (!row) throw new IdentityError(410, "browser_login_expired");
    return row;
  }
  inspectBrowser(userCode: string, sessionId: string) {
    const row = this.browserRow(userCode);
    if (row.owner_session && row.owner_session !== sessionId)
      throw new IdentityError(403, "browser_login_claimed");
    // Claim only through an authenticated CSRF-protected POST, never a navigation.
    this.db
      .prepare("UPDATE agent_browser_login SET owner_session=? WHERE digest=?")
      .run(sessionId, String(row.digest));
    return BrowserLoginDetails.parse({
      userCode,
      expiresAt: new Date(Number(row.expires_at)).toISOString(),
      status: row.status,
      ...(row.persistent ? { persistent: true } : {}),
    });
  }
  releaseBrowser(userCode: string, sessionId: string) {
    const row = this.browserRow(userCode);
    if (
      (row.owner_session && row.owner_session !== sessionId) ||
      row.status !== "pending"
    )
      throw new IdentityError(409, "browser_login_changed");
    this.db
      .prepare(
        "UPDATE agent_browser_login SET owner_session=NULL WHERE digest=?",
      )
      .run(String(row.digest));
  }
  denyBrowser(userCode: string, sessionId: string) {
    const row = this.browserRow(userCode);
    if (row.owner_session !== sessionId || row.status !== "pending")
      throw new IdentityError(409, "browser_login_changed");
    this.db
      .prepare("UPDATE agent_browser_login SET status='denied' WHERE digest=?")
      .run(String(row.digest));
  }
  /**
   * The web app's chat credential: bound to the browser session, ends with it,
   * has no refresh token and never uses a device slot. Each browser session
   * keeps its newest few per workspace (several open tabs keep working) and
   * each person a bounded number; older ones are removed.
   */
  issueWebSession(
    grant: Omit<Grant, "expires_at" | "session_expires_at">,
    parentExpiresAt: Date,
  ) {
    this.prune();
    const expiry = Math.min(parentExpiresAt.getTime(), Date.now() + this.ttlMs);
    if (expiry - Date.now() < 10_000)
      throw new IdentityError(409, "mobile_session_ending");
    const full = { ...grant, expires_at: expiry, session_expires_at: expiry };
    this.check(full, grant.workspace_id);
    this.evictWeb(
      "session_id=? AND workspace_id=? AND user_id=?",
      [grant.session_id, grant.workspace_id, grant.user_id],
      WEB_PER_BROWSER - 1,
    );
    this.evictWeb("user_id=?", [grant.user_id], WEB_PER_PERSON - 1);
    return this.redeem(full, false, true);
  }
  /** Leaves the newest `keep` web credentials matching `where`; app sessions are never touched. */
  private evictWeb(where: string, params: string[], keep: number) {
    this.db
      .prepare(
        `DELETE FROM agent_mobile_session WHERE web=1 AND ${where} AND rowid NOT IN (SELECT rowid FROM agent_mobile_session WHERE web=1 AND ${where} ORDER BY rowid DESC LIMIT ?)`,
      )
      .run(...params, ...params, keep);
  }
  consentBrowser(
    userCode: string,
    approve: boolean,
    grant: Omit<Grant, "expires_at" | "session_expires_at">,
    parentExpiresAt: Date,
  ) {
    const row = this.browserRow(userCode);
    if (
      row.owner_session !== grant.session_id ||
      row.status !== "pending" ||
      row.server_id !== grant.server_id
    )
      throw new IdentityError(409, "browser_login_changed");
    const expiry = Math.min(parentExpiresAt.getTime(), Date.now() + this.ttlMs);
    if (expiry - Date.now() < 10_000)
      throw new IdentityError(409, "mobile_session_ending");
    const full = { ...grant, expires_at: expiry, session_expires_at: expiry };
    this.check(full, grant.workspace_id);
    if (approve && !this.availableSlots(grant.user_id))
      throw new IdentityError(409, "mobile_device_limit");
    this.db
      .prepare(
        "UPDATE agent_browser_login SET status=?,grant_json=? WHERE digest=?",
      )
      .run(
        approve ? "approved" : "denied",
        approve ? JSON.stringify(full) : null,
        String(row.digest),
      );
  }
  pollBrowser(deviceCode: string, serverId: string) {
    this.prune();
    const row = this.db
      .prepare("SELECT * FROM agent_browser_login WHERE digest=?")
      .get(hash(deviceCode));
    if (!row || row.server_id !== serverId || row.status === "consumed")
      throw new IdentityError(410, "browser_login_expired");
    if (Number(row.last_poll) + 5000 > Date.now())
      throw new IdentityError(429, "browser_login_slow_down");
    this.db
      .prepare("UPDATE agent_browser_login SET last_poll=? WHERE digest=?")
      .run(Date.now(), String(row.digest));
    if (row.status === "denied")
      throw new IdentityError(403, "browser_login_denied");
    if (row.status !== "approved")
      return { status: "pending" as const, interval: 5 };
    const grant = JSON.parse(String(row.grant_json)) as Grant;
    this.check(grant, grant.workspace_id);
    const credential = this.redeem(grant, row.persistent === 1);
    this.db
      .prepare(
        "UPDATE agent_browser_login SET status='consumed',issued_digest=? WHERE digest=?",
      )
      .run(hash(credential.accessToken), String(row.digest));
    return {
      status: "approved" as const,
      address: `${this.baseURL}/v1/${grant.workspace_id}`,
      credential,
    };
  }
  cancelBrowser(deviceCode: string) {
    const issued = this.db
      .prepare("SELECT issued_digest FROM agent_browser_login WHERE digest=?")
      .get(hash(deviceCode));
    if (issued?.issued_digest)
      this.devices.revokeAccess(String(issued.issued_digest));
    this.db
      .prepare(
        "DELETE FROM agent_mobile_session WHERE digest=(SELECT issued_digest FROM agent_browser_login WHERE digest=?)",
      )
      .run(hash(deviceCode));
    this.db
      .prepare("DELETE FROM agent_browser_login WHERE digest=?")
      .run(hash(deviceCode));
  }
  authenticate(
    header: string | undefined,
    workspaceId: string,
    serverId: string,
  ) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? "")?.[1];
    if (!token) throw new AuthError(401, "auth_expired");
    const device = this.devices.authenticate(
      hash(token),
      workspaceId,
      serverId,
    );
    if (device)
      return {
        ...device,
        role: this.checkMembership(device.grant, workspaceId),
      };
    return this.authenticateDigest(hash(token), workspaceId, serverId);
  }
  /** Internal callback validation; the digest never authenticates an HTTP request. */
  authenticateDigest(
    credentialId: string,
    workspaceId: string,
    serverId: string,
  ) {
    const device = this.devices.authenticate(
      credentialId,
      workspaceId,
      serverId,
      true,
    );
    if (device)
      return {
        ...device,
        role: this.checkMembership(device.grant, workspaceId),
      };
    const grant = this.db
      .prepare("SELECT * FROM agent_mobile_session WHERE digest=?")
      .get(credentialId) as Grant | undefined;
    if (!grant) throw new AuthError(401, "auth_expired");
    const role = this.check(grant, workspaceId);
    if (grant.server_id !== serverId)
      throw new AuthError(403, "auth_scope_mismatch");
    const session: AuthSession = {
      authProfile: AUTH_PROFILE,
      profile: PROFILE,
      expiresAt: new Date(grant.session_expires_at).toISOString(),
      scope: {
        serverId,
        connectionId: `account-${workspaceId}`,
        workspaceId,
        userId: grant.user_id,
      },
      permissions: ["workflow.read", "workflow.write"],
    };
    return { grant, role, session, credentialId };
  }
  revoke(header: string) {
    this.devices.revokeAccess(hash(header.slice(7)));
    this.db
      .prepare("DELETE FROM agent_mobile_session WHERE digest=?")
      .run(hash(header.slice(7)));
  }
  revokeMember(memberId: string, workspaceId?: string) {
    if (
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='agent_app_login'")
        .get()
    )
      this.db
        .prepare(
          `DELETE FROM agent_app_login WHERE json_extract(grant_json, '$.member_id')=?${workspaceId ? " AND json_extract(grant_json, '$.workspace_id')=?" : ""}`,
        )
        .run(...(workspaceId ? [memberId, workspaceId] : [memberId]));
    this.db
      .prepare(
        `DELETE FROM agent_browser_login WHERE json_extract(grant_json, '$.member_id')=?${workspaceId ? " AND json_extract(grant_json, '$.workspace_id')=?" : ""}`,
      )
      .run(...(workspaceId ? [memberId, workspaceId] : [memberId]));
    for (const table of [
      "agent_mobile_pairing",
      "agent_mobile_session",
      "agent_mobile_device",
    ])
      this.db
        .prepare(
          `DELETE FROM ${table} WHERE member_id=?${workspaceId ? " AND workspace_id=?" : ""}`,
        )
        .run(...(workspaceId ? [memberId, workspaceId] : [memberId]));
  }
  revokeOwn(userId: string, workspaceId: string) {
    if (
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='agent_app_login'")
        .get()
    )
      this.db
        .prepare(
          "DELETE FROM agent_app_login WHERE json_extract(grant_json, '$.user_id')=? AND json_extract(grant_json, '$.workspace_id')=?",
        )
        .run(userId, workspaceId);
    this.db
      .prepare(
        "DELETE FROM agent_browser_login WHERE json_extract(grant_json, '$.user_id')=? AND json_extract(grant_json, '$.workspace_id')=?",
      )
      .run(userId, workspaceId);
    for (const table of [
      "agent_mobile_pairing",
      "agent_mobile_session",
      "agent_mobile_device",
    ])
      this.db
        .prepare(`DELETE FROM ${table} WHERE user_id=? AND workspace_id=?`)
        .run(userId, workspaceId);
  }
  /**
   * What the person is signed in with: mobile devices and chat credentials
   * (the web app's and older pairings'). Ids are derived so the stored
   * digests never leave the server.
   */
  ownAccess(userId: string) {
    this.prune();
    const sessions = this.db
      .prepare(
        "SELECT s.digest,s.session_id AS sessionId,s.workspace_id AS workspaceId,w.name AS workspaceName,s.expires_at AS expiresAt FROM agent_mobile_session s LEFT JOIN agent_workspace w ON w.id=s.workspace_id WHERE s.user_id=? ORDER BY s.expires_at DESC",
      )
      .all(userId)
      .map((row) => ({
        id: publicId(String(row.digest)),
        sessionId: String(row.sessionId),
        workspaceId: String(row.workspaceId),
        workspaceName:
          row.workspaceName === null ? null : String(row.workspaceName),
        expiresAt: Number(row.expiresAt),
      }));
    return {
      devices: this.devices
        .listOwn(userId)
        .map(({ id, ...device }) => ({ ...device, id: publicId(id) })),
      sessions,
      limit: 8,
      used: 8 - this.availableSlots(userId),
    };
  }
  /** Revokes one of the person's own devices or chat credentials by its public id. */
  revokeOwnAccess(userId: string, id: string) {
    const device = this.devices
      .listOwn(userId)
      .find((value) => publicId(value.id) === id);
    if (device) return this.devices.revokeOwn(userId, device.id);
    const session = this.db
      .prepare("SELECT digest FROM agent_mobile_session WHERE user_id=?")
      .all(userId)
      .find((row) => publicId(String(row.digest)) === id);
    if (!session) return false;
    this.db
      .prepare("DELETE FROM agent_mobile_session WHERE digest=? AND user_id=?")
      .run(String(session.digest), userId);
    return true;
  }
  /** Signs the person out of every app and device, in every workspace. */
  revokeAllOwn(userId: string) {
    for (const table of ["agent_app_login", "agent_browser_login"])
      if (
        this.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)
      )
        this.db
          .prepare(
            `DELETE FROM ${table} WHERE json_extract(grant_json, '$.user_id')=?`,
          )
          .run(userId);
    for (const table of [
      "agent_mobile_pairing",
      "agent_mobile_session",
      "agent_mobile_device",
    ])
      this.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
  }
  /**
   * Whether the person is still signed in somewhere: a live browser session
   * (the web app's chat credentials hang off one) or an app device in the
   * workspace. Background work on their behalf stops once they signed out
   * everywhere or reset their password, until they sign in again.
   */
  signedIn(userId: string, workspaceId: string) {
    const now = Date.now();
    if (
      this.db
        .prepare('SELECT "expiresAt" FROM session WHERE "userId"=?')
        .all(userId)
        .some((row) => Date.parse(String(row.expiresAt)) > now)
    )
      return true;
    return !!this.db
      .prepare(
        "SELECT 1 FROM agent_mobile_device WHERE user_id=? AND workspace_id=? AND idle_expires_at>? AND (activation_deadline IS NULL OR activation_deadline>?)",
      )
      .get(userId, workspaceId, now, now);
  }
  count(userId: string, workspaceId: string) {
    this.prune();
    return Number(
      this.db
        .prepare(
          "SELECT (SELECT count(*) FROM agent_mobile_session WHERE user_id=? AND workspace_id=? AND web=0)+(SELECT count(*) FROM agent_mobile_device WHERE user_id=? AND workspace_id=?) AS count",
        )
        .get(userId, workspaceId, userId, workspaceId)!.count,
    );
  }
  availableSlots(userId: string) {
    this.prune();
    const count = Number(
      this.db
        .prepare(
          "SELECT (SELECT count(*) FROM agent_mobile_session WHERE user_id=? AND web=0)+(SELECT count(*) FROM agent_mobile_device WHERE user_id=?) AS count",
        )
        .get(userId, userId)!.count,
    );
    return Math.max(0, 8 - count);
  }
  refresh(raw: unknown, workspace: string, server: string, revoke = false) {
    this.prune();
    if (revoke) return this.devices.revokeRefresh(raw, workspace, server);
    return this.devices.refresh(raw, workspace, server);
  }
}
