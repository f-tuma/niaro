import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { IdentityError } from "./error";
import type { AuditStore } from "./audit";
import { LINK_TTL_MS, sendMail, type Mail } from "./invitations";
import { publicId, type MobileSessionStore } from "./mobile";
import type { McpAccessStore } from "./mcp-access";
import type { AuditRecord } from "../../packages/protocol/audit";

/** The part of Better Auth's context this module needs. */
export type PasswordHasher = {
  hash(password: string): Promise<string>;
  verify(input: { hash: string; password: string }): Promise<boolean>;
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

/** A small sliding-window counter; state lives only for this process. */
export class AttemptLimiter {
  private attempts = new Map<string, number[]>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  /** Counts one attempt; throws once the key has used up its window. */
  take(key: string, code = "identity_rate_limited") {
    const now = Date.now();
    const recent = (this.attempts.get(key) ?? []).filter(
      (at) => at > now - this.windowMs,
    );
    if (recent.length >= this.max) throw new IdentityError(429, code);
    recent.push(now);
    this.attempts.set(key, recent);
    if (this.attempts.size > 10_000)
      for (const [k, v] of this.attempts)
        if (!v.some((at) => at > now - this.windowMs)) this.attempts.delete(k);
  }
  reset(key: string) {
    this.attempts.delete(key);
  }
}

/**
 * Passwords, password-reset links and the person's own sign-ins. Every method
 * runs in IdentityService's queue; nothing here trusts the browser.
 */
export class AccountSecurity {
  private passwordAttempts = new AttemptLimiter(5, 15 * 60_000);
  private publicAttempts = new AttemptLimiter(30, 10 * 60_000);
  constructor(
    private db: DatabaseSync,
    private deps: {
      password: () => Promise<PasswordHasher>;
      audit: AuditStore;
      mobile: MobileSessionStore;
      /** Personal MCP grants end with the person's sign-ins. */
      mcp?: Pick<
        McpAccessStore,
        "listOwnActive" | "revokeOwn" | "revokeAllOwn"
      >;
      mail?: Mail;
    },
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_password_reset (
      id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      issuer_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, used_at INTEGER
    ) STRICT`);
    // A replaced or cancelled link stays as a row (it still counts toward the
    // issuer's hourly limit) but never works again.
    if (
      !db
        .prepare("PRAGMA table_info(agent_password_reset)")
        .all()
        .some((column) => column.name === "superseded_at")
    )
      db.exec(
        "ALTER TABLE agent_password_reset ADD COLUMN superseded_at INTEGER",
      );
  }
  /** Outstanding links of the person stop working. */
  private supersedeResets(userId: string) {
    this.db
      .prepare(
        "UPDATE agent_password_reset SET superseded_at=? WHERE user_id=? AND used_at IS NULL AND superseded_at IS NULL",
      )
      .run(Date.now(), userId);
  }
  private organizations(userId: string) {
    return this.db
      .prepare('SELECT "organizationId" AS id FROM member WHERE "userId"=?')
      .all(userId)
      .map((row) => String(row.id));
  }
  /** One audit row per organization the person belongs to. */
  private auditPerson(
    userId: string,
    action: AuditRecord["action"],
    actorId: string | null = userId,
  ) {
    for (const organizationId of this.organizations(userId))
      this.deps.audit.append({
        organizationId,
        workspaceId: null,
        actorId,
        source: "console",
        action,
        targetId: userId,
        outcome: "succeeded",
        details: {},
      });
  }
  private credential(userId: string) {
    return this.db
      .prepare(
        'SELECT id,password FROM account WHERE "userId"=? AND "providerId"=\'credential\'',
      )
      .get(userId) as { id: string; password: string | null } | undefined;
  }
  hasPassword(userId: string) {
    return !!this.credential(userId)?.password;
  }
  private async setPassword(userId: string, password: string) {
    const hash = await (await this.deps.password()).hash(password);
    const now = new Date().toISOString();
    const account = this.credential(userId);
    if (account)
      this.db
        .prepare('UPDATE account SET password=?,"updatedAt"=? WHERE id=?')
        .run(hash, now, account.id);
    else
      this.db
        .prepare(
          'INSERT INTO account (id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES (?,?,\'credential\',?,?,?,?)',
        )
        .run(randomUUID(), userId, userId, hash, now, now);
  }
  /**
   * Changes the signed-in person's password, signs out their other browsers
   * and ends their MCP access tokens and outstanding reset links: a password
   * change is often the response to a suspected compromise.
   */
  async changePassword(
    userId: string,
    sessionId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const account = this.credential(userId);
    if (!account?.password) throw new IdentityError(409, "password_not_set");
    this.passwordAttempts.take(userId, "password_rate_limited");
    const hasher = await this.deps.password();
    if (
      !(await hasher.verify({
        hash: account.password,
        password: currentPassword,
      }))
    )
      throw new IdentityError(403, "password_incorrect");
    this.passwordAttempts.reset(userId);
    await this.setPassword(userId, newPassword);
    // Other browsers lose their session (and the chat credentials bound to
    // it); this one stays signed in. Devices are listed for the person to remove.
    this.db
      .prepare('DELETE FROM session WHERE "userId"=? AND id<>?')
      .run(userId, sessionId);
    this.deps.mcp?.revokeAllOwn(userId);
    this.supersedeResets(userId);
    this.auditPerson(userId, "password.changed");
  }
  /**
   * Who may get a reset link from whom. Owners reset anyone but themselves,
   * administrators only plain members. A person who also belongs to another
   * organization is refused: one company's administrator must not take over
   * an account another company relies on.
   */
  private assertResettable(
    issuerId: string,
    organizationId: string,
    userId: string,
  ) {
    const issuer = this.db
      .prepare(
        'SELECT role FROM member WHERE "userId"=? AND "organizationId"=?',
      )
      .get(issuerId, organizationId);
    const target = this.db
      .prepare(
        'SELECT role FROM member WHERE "userId"=? AND "organizationId"=?',
      )
      .get(userId, organizationId);
    if (
      !issuer ||
      !target ||
      issuerId === userId ||
      !["owner", "admin"].includes(String(issuer.role)) ||
      (issuer.role === "admin" && target.role !== "member")
    )
      throw new IdentityError(403, "password_reset_forbidden");
    if (this.organizations(userId).length !== 1)
      throw new IdentityError(403, "password_reset_other_organization");
  }
  /** A 48 h single-use link; emailed when SMTP exists, always returned once to copy. */
  async issueReset(
    issuerId: string,
    organizationId: string,
    memberId: string,
    origin: string,
  ) {
    const member = this.db
      .prepare(
        'SELECT m."userId" AS userId,u.email,u.name FROM member m JOIN user u ON u.id=m."userId" WHERE m.id=? AND m."organizationId"=?',
      )
      .get(memberId, organizationId);
    if (!member) throw new IdentityError(404, "identity_not_found");
    const userId = String(member.userId);
    this.assertResettable(issuerId, organizationId, userId);
    if (
      Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM agent_password_reset WHERE issuer_id=? AND expires_at>?",
          )
          .get(issuerId, Date.now() + LINK_TTL_MS - 3600000)!.n,
      ) >= 20
    )
      throw new IdentityError(429, "password_reset_rate_limited");
    // Only the newest link works. Older ones are marked, not deleted, so
    // re-issuing cannot reset the issuer's hourly count.
    this.supersedeResets(userId);
    this.db
      .prepare("DELETE FROM agent_password_reset WHERE expires_at<=?")
      .run(Date.now() - LINK_TTL_MS);
    const token = randomBytes(32).toString("base64url"),
      id = randomUUID(),
      expiresAt = Date.now() + LINK_TTL_MS,
      link = `${origin}/account/reset#${token}`;
    this.db
      .prepare(
        "INSERT INTO agent_password_reset (id,digest,user_id,organization_id,issuer_id,expires_at,used_at) VALUES (?,?,?,?,?,?,NULL)",
      )
      .run(id, digest(token), userId, organizationId, issuerId, expiresAt);
    let delivery: "email" | "link" = "link";
    if (this.deps.mail)
      try {
        await sendMail(this.deps.mail, {
          to: String(member.email),
          subject: "Nové heslo",
          text: `Správce ti poslal odkaz pro nastavení nového hesla.\n\nNastavit heslo: ${link}\n\nPlatí 48 hodin a jen jednou. Pokud o nic takového nevíš, dej vědět správci.`,
        });
        delivery = "email";
      } catch {
        // The link still works; the administrator is told to pass it on.
        delivery = "link";
      }
    this.deps.audit.append({
      organizationId,
      workspaceId: null,
      actorId: issuerId,
      source: "console",
      action: "password.reset_issued",
      targetId: userId,
      outcome: "succeeded",
      details: {},
    });
    return {
      ok: true as const,
      link,
      expiresAt,
      delivery,
      mail: !!this.deps.mail,
    };
  }
  private reset(token: string, client: string) {
    this.publicAttempts.take(client);
    const row = this.db
      .prepare(
        "SELECT r.*,u.email FROM agent_password_reset r JOIN user u ON u.id=r.user_id WHERE r.digest=?",
      )
      .get(digest(token));
    if (!row) throw new IdentityError(410, "password_reset_invalid");
    if (row.used_at !== null)
      throw new IdentityError(410, "password_reset_used");
    if (row.superseded_at !== null)
      throw new IdentityError(410, "password_reset_invalid");
    if (Number(row.expires_at) <= Date.now())
      throw new IdentityError(410, "password_reset_expired");
    try {
      this.assertResettable(
        String(row.issuer_id),
        String(row.organization_id),
        String(row.user_id),
      );
    } catch {
      throw new IdentityError(410, "password_reset_invalid");
    }
    return {
      id: String(row.id),
      userId: String(row.user_id),
      organizationId: String(row.organization_id),
      email: String(row.email),
    };
  }
  inspectReset(token: string, client: string) {
    return { email: this.reset(token, client).email };
  }
  /** Sets the new password, uses up the link and signs the person out everywhere. */
  async useReset(token: string, password: string, client: string) {
    const reset = this.reset(token, client);
    const claimed = this.db
      .prepare(
        "UPDATE agent_password_reset SET used_at=? WHERE id=? AND used_at IS NULL AND superseded_at IS NULL",
      )
      .run(Date.now(), reset.id);
    if (claimed.changes !== 1)
      throw new IdentityError(410, "password_reset_used");
    await this.setPassword(reset.userId, password);
    this.db.prepare('DELETE FROM session WHERE "userId"=?').run(reset.userId);
    this.deps.mobile.revokeAllOwn(reset.userId);
    this.deps.mcp?.revokeAllOwn(reset.userId);
    this.deps.audit.append({
      organizationId: reset.organizationId,
      workspaceId: null,
      actorId: reset.userId,
      source: "console",
      action: "password.reset_used",
      targetId: reset.userId,
      outcome: "succeeded",
      details: {},
    });
    return { email: reset.email };
  }
  /** Browser sessions, mobile devices, chat credentials and MCP access of one person. */
  access(userId: string, sessionId: string) {
    const own = this.deps.mobile.ownAccess(userId);
    const browsers = this.db
      .prepare(
        'SELECT id,"createdAt","expiresAt","userAgent" FROM session WHERE "userId"=? ORDER BY "createdAt" DESC',
      )
      .all(userId)
      .filter((row) => Date.parse(String(row.expiresAt)) > Date.now())
      .map((row) => ({
        id: publicId(String(row.id)),
        current: row.id === sessionId,
        createdAt: Date.parse(String(row.createdAt)),
        expiresAt: Date.parse(String(row.expiresAt)),
        userAgent: row.userAgent ? String(row.userAgent).slice(0, 300) : null,
        // Several tabs hold one credential each; the browser shows each workspace once.
        chats: [
          ...new Set(
            own.sessions
              .filter((s) => s.sessionId === row.id)
              .map((s) => s.workspaceName ?? "")
              .filter(Boolean),
          ),
        ],
      }));
    const live = new Set(
      this.db
        .prepare('SELECT id FROM session WHERE "userId"=?')
        .all(userId)
        .map((row) => String(row.id)),
    );
    return {
      hasPassword: this.hasPassword(userId),
      limit: own.limit,
      used: own.used,
      devices: own.devices,
      // Chat credentials not shown under a browser above (older pairings).
      sessions: own.sessions
        .filter((s) => !live.has(s.sessionId))
        .map(({ sessionId: _session, ...s }) => s),
      browsers,
      mcp: (this.deps.mcp?.listOwnActive(userId) ?? []).map(
        ({ grant, workspaceName }) => ({
          id: publicId(grant.id),
          label: grant.label,
          workspaceName,
          scopes: grant.scopes,
          createdAt: Date.parse(grant.createdAt),
          expiresAt: Date.parse(grant.expiresAt),
          lastUsedAt: grant.lastUsedAt ? Date.parse(grant.lastUsedAt) : null,
        }),
      ),
    };
  }
  /** Revokes one browser session, device, chat credential or MCP grant of the person. */
  revoke(userId: string, id: string) {
    const browser = this.db
      .prepare('SELECT id FROM session WHERE "userId"=?')
      .all(userId)
      .find((row) => publicId(String(row.id)) === id);
    const grant = this.deps.mcp
      ?.listOwnActive(userId)
      .find((value) => publicId(value.grant.id) === id);
    if (browser)
      this.db
        .prepare('DELETE FROM session WHERE id=? AND "userId"=?')
        .run(String(browser.id), userId);
    else if (grant) this.deps.mcp!.revokeOwn(userId, grant.grant.id);
    else if (!this.deps.mobile.revokeOwnAccess(userId, id))
      throw new IdentityError(404, "identity_not_found");
    this.auditPerson(userId, "session.revoked");
  }
  /**
   * Signs the person's other browsers out (and the chat credentials bound to
   * them); this one stays signed in. Devices and MCP access stay listed.
   */
  revokeOtherBrowsers(userId: string, sessionId: string) {
    const { changes } = this.db
      .prepare('DELETE FROM session WHERE "userId"=? AND id<>?')
      .run(userId, sessionId);
    if (changes) this.auditPerson(userId, "session.revoked");
  }
  /** Signs the person out of every browser, device and app, and ends their MCP access. */
  revokeEverything(userId: string) {
    this.db.prepare('DELETE FROM session WHERE "userId"=?').run(userId);
    this.deps.mobile.revokeAllOwn(userId);
    this.deps.mcp?.revokeAllOwn(userId);
    this.auditPerson(userId, "session.revoked");
  }
}
