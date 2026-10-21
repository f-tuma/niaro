import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  AuthProviderDraftSchema,
  AuthProviderIdSchema,
  AuthProviderInputSchema,
  AuthProviderSchema,
  type AuthProvider,
  type AuthProviderLinkedStatus,
} from "../../packages/protocol/auth-providers";
import { IdentityId } from "../../packages/protocol/identity";
import { Invitations } from "./invitations";
import { IdentityError } from "./error";

export type AuthProviderActor = { userId: string; sessionId: string };
export type AuthProviderPin = {
  providerId: string;
  providerRevision: number;
  accountId: string;
  subject: string;
};
export type AuthProviderSnapshot = Readonly<
  AuthProvider & { clientSecret: string }
>;
export type AuthProviderFlow = Readonly<{
  id: string;
  organizationId: string;
  providerId: string;
  providerRevision: number;
  mode: "link" | "sign-in";
  actor: AuthProviderActor | null;
  invitationId?: string;
  returnPath: string;
  expiresAt: number;
}>;
type FlowData = AuthProviderFlow & {
  phase:
    | "pending"
    | "started"
    | "exchanging"
    | "verified"
    | "complete"
    | "failed";
  userId?: string;
  subject?: string;
};
const failure = (code = "auth_provider_flow_invalid", status = 403) =>
  new IdentityError(status, code);
const conflict = () => failure("auth_provider_conflict", 409);

/** Caller serializes all methods with Better Auth operations and authorizes admin
 * mutations. Snapshots contain secrets and must stay server-side. */
export class AuthProviderStore {
  private readonly key: Buffer;
  readonly baseURL: string;
  constructor(
    private readonly db: DatabaseSync,
    secret: string,
    baseURL: string,
  ) {
    this.baseURL = new URL(baseURL).origin;
    this.key = Buffer.from(
      hkdfSync("sha256", secret, "agent-server", "auth-providers/v1", 32),
    );
    db.exec(`CREATE TABLE IF NOT EXISTS agent_auth_provider (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, revision INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, secret TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_auth_provider_flow (
      id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, data TEXT NOT NULL
    ) STRICT;`);
  }
  private seal(value: string, organizationId: string, id: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([organizationId, id])));
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), body]
      .map((part) => part.toString("base64url"))
      .join(".");
  }
  private unseal(value: string, organizationId: string, id: string) {
    try {
      const parts = value
        .split(".")
        .map((part) => Buffer.from(part, "base64url"));
      const [iv, tag, bytes] = parts;
      if (
        parts.length !== 3 ||
        !iv ||
        iv.length !== 12 ||
        !tag ||
        tag.length !== 16 ||
        !bytes
      )
        throw conflict();
      const cipher = createDecipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(Buffer.from(JSON.stringify([organizationId, id])));
      cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(bytes), cipher.final()]).toString(
        "utf8",
      );
    } catch {
      throw conflict();
    }
  }
  private row(id: string) {
    return this.db
      .prepare("SELECT * FROM agent_auth_provider WHERE id=?")
      .get(id);
  }
  private config(id: string, organizationId?: string): AuthProvider {
    const row = this.row(id);
    if (
      !row ||
      row.deleted ||
      (organizationId && row.organization_id !== organizationId)
    )
      throw failure("auth_provider_unavailable");
    return this.parse(row.data);
  }
  /** The callback follows the server's current public address, not the one
   * recorded when the provider was saved (e.g. before a proxy was set up). */
  private parse(data: unknown): AuthProvider {
    const value = AuthProviderSchema.parse(JSON.parse(String(data)));
    return { ...value, callbackURL: this.callbackURL(value.id) };
  }
  get(organizationId: string, id: string) {
    return this.config(id, organizationId);
  }
  list(organizationId: string): AuthProvider[] {
    return this.db
      .prepare(
        "SELECT data FROM agent_auth_provider WHERE organization_id=? AND deleted=0 ORDER BY id",
      )
      .all(organizationId)
      .map((row) => this.parse(row.data));
  }
  publicChoices(organizationId?: string) {
    const rows = organizationId
      ? this.list(organizationId)
      : this.db
          .prepare(
            "SELECT data FROM agent_auth_provider WHERE deleted=0 ORDER BY id",
          )
          .all()
          .map((row) => this.parse(row.data));
    return rows
      .filter((row) => row.enabled)
      .map(({ id, organizationId, kind, name }) => ({
        id,
        organizationId,
        kind,
        name,
      }));
  }
  draft(organizationId: string) {
    const providerId = `ap_${randomBytes(16).toString("hex")}`;
    // Preparing an address neither persists a provider nor grants sign-in access.
    return AuthProviderDraftSchema.parse({
      organizationId,
      providerId,
      callbackURL: this.callbackURL(providerId),
    });
  }
  private callbackURL(id: string) {
    return `${this.baseURL}/admin/auth/callback/${id}`;
  }
  save(
    organizationId: string,
    id: string | null,
    revision: number,
    raw: unknown,
    creationId?: string,
  ): AuthProvider {
    IdentityId.parse(organizationId);
    const input = AuthProviderInputSchema.parse(raw);
    if (!Number.isSafeInteger(revision) || revision < 0) throw conflict();
    if (creationId !== undefined) {
      AuthProviderIdSchema.parse(creationId);
      if (id !== null || revision !== 0 || this.row(creationId))
        throw conflict();
    }
    const prior = id ? this.config(id, organizationId) : null;
    if (prior ? prior.revision !== revision : revision !== 0) throw conflict();
    if (
      prior &&
      (prior.kind !== input.kind ||
        prior.clientId !== input.clientId ||
        prior.tenantId !== (input.tenantId ?? null) ||
        prior.hostedDomain !== (input.hostedDomain ?? null))
    )
      throw failure("auth_provider_namespace_immutable", 409);
    if (!id && this.list(organizationId).length >= 100)
      throw failure("auth_provider_limit", 409);
    id ??= creationId ?? `ap_${randomBytes(16).toString("hex")}`;
    const oldSecret = prior ? this.row(id)?.secret : null;
    const encrypted = input.clientSecret
      ? this.seal(input.clientSecret, organizationId, id)
      : oldSecret == null
        ? null
        : String(oldSecret);
    if (input.enabled && !encrypted)
      throw failure("auth_provider_secret_required", 400);
    const value = AuthProviderSchema.parse({
      id,
      organizationId,
      revision: revision + 1,
      kind: input.kind,
      name: input.name,
      enabled: input.enabled,
      clientId: input.clientId,
      hasClientSecret: Boolean(encrypted),
      tenantId: input.tenantId ?? null,
      hostedDomain: input.hostedDomain ?? null,
      callbackURL: this.callbackURL(id),
    });
    this.db
      .prepare(
        `INSERT INTO agent_auth_provider(id,organization_id,revision,data,secret) VALUES(?,?,?,?,?)${
          prior
            ? " ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,secret=excluded.secret"
            : ""
        }`,
      )
      .run(
        id,
        organizationId,
        value.revision,
        JSON.stringify(value),
        encrypted,
      );
    return value;
  }
  delete(organizationId: string, id: string, revision: number) {
    const prior = this.config(id, organizationId);
    if (prior.revision !== revision) throw conflict();
    this.db
      .prepare(
        "UPDATE agent_auth_provider SET deleted=1,revision=revision+1,secret=NULL WHERE id=?",
      )
      .run(id);
  }
  snapshot(): readonly AuthProviderSnapshot[] {
    return Object.freeze(
      this.db
        .prepare(
          "SELECT id,organization_id,secret FROM agent_auth_provider WHERE deleted=0",
        )
        .all()
        .map((row) => ({ row, value: this.config(String(row.id)) }))
        .filter(({ value }) => value.enabled)
        .map(({ row, value }) =>
          Object.freeze({
            ...value,
            clientSecret: this.unseal(
              String(row.secret),
              value.organizationId,
              value.id,
            ),
          }),
        ),
    );
  }
  /** Server-only OAuth client of one enabled sign-in method, for delegated service access. */
  client(organizationId: string, id: string) {
    const config = this.enabled(organizationId, id);
    const row = this.row(id);
    if (!row?.secret) throw failure("auth_provider_unavailable");
    return {
      kind: config.kind,
      tenantId: config.tenantId ?? null,
      revision: config.revision,
      clientId: config.clientId,
      clientSecret: this.unseal(String(row.secret), organizationId, id),
    };
  }
  assertMember(organizationId: string, userId: string) {
    if (
      !this.db
        .prepare(
          'SELECT 1 FROM member INNER JOIN user ON user.id=member."userId" WHERE member."organizationId"=? AND member."userId"=?',
        )
        .get(organizationId, userId)
    )
      throw failure("auth_provider_membership_required");
  }
  private assertActor(organizationId: string, actor: AuthProviderActor) {
    this.assertMember(organizationId, actor.userId);
    const session = this.db
      .prepare('SELECT "expiresAt" FROM session WHERE id=? AND "userId"=?')
      .get(actor.sessionId, actor.userId);
    if (!session || !(Date.parse(String(session.expiresAt)) > Date.now()))
      throw failure("auth_provider_session_expired");
  }
  private enabled(organizationId: string, id: string) {
    const config = this.config(id, organizationId);
    if (!config.enabled) throw failure("auth_provider_unavailable");
    return config;
  }
  linkedStatus(
    organizationId: string,
    userId: string,
    id: string,
  ): AuthProviderLinkedStatus {
    const config = this.enabled(organizationId, id);
    this.assertMember(organizationId, userId);
    return {
      providerId: id,
      providerRevision: config.revision,
      name: config.name,
      kind: config.kind,
      linked: Boolean(
        this.db
          .prepare('SELECT 1 FROM account WHERE "providerId"=? AND "userId"=?')
          .get(id, userId),
      ),
    };
  }
  assertLinked(
    organizationId: string,
    userId: string,
    id: string,
    pin?: AuthProviderPin,
  ): AuthProviderPin {
    const config = this.enabled(organizationId, id);
    this.assertMember(organizationId, userId);
    const rows = this.db
      .prepare(
        'SELECT id,"accountId" FROM account WHERE "providerId"=? AND "userId"=?',
      )
      .all(id, userId);
    if (rows.length !== 1) throw failure("auth_provider_link_required");
    const value = {
      providerId: id,
      providerRevision: config.revision,
      accountId: String(rows[0]!.id),
      subject: String(rows[0]!.accountId),
    };
    if (
      pin &&
      Object.keys(value).some(
        (key) =>
          value[key as keyof AuthProviderPin] !==
          pin[key as keyof AuthProviderPin],
      )
    )
      throw conflict();
    return value;
  }
  begin(input: {
    organizationId: string;
    providerId: string;
    mode: "link" | "sign-in";
    actor?: AuthProviderActor;
    returnPath?: string;
    invitationToken?: string;
  }): AuthProviderFlow {
    const config = this.enabled(input.organizationId, input.providerId);
    const invitation = input.invitationToken
      ? new Invitations(this.db).inspect(input.invitationToken)
      : undefined;
    if (
      invitation &&
      (input.mode !== "sign-in" ||
        input.actor ||
        invitation.organization_id !== input.organizationId)
    )
      throw failure();
    if (input.mode !== "link" && input.mode !== "sign-in") throw failure();
    if (input.mode === "link" && !input.actor) throw failure();
    if (input.actor) this.assertActor(input.organizationId, input.actor);
    const returnPath = input.returnPath ?? "/admin/settings";
    const url = new URL(returnPath, this.baseURL);
    if (
      !(
        returnPath.startsWith("/admin/") ||
        /^\/account\/(login|invite)(?:[?#]|$)/.test(returnPath) ||
        /^\/(?:chat(?:\/[A-Za-z0-9_-]+)?|tasks|meetings(?:\/[A-Za-z0-9_-]+)?|processes(?:\/[A-Za-z0-9_-]+)?|skills(?:\/[A-Za-z0-9_-]+)?|connections(?:\/[A-Za-z0-9_-]+)?|search|me)?(?:[?#]|$)/.test(
          returnPath,
        )
      ) ||
      url.origin !== this.baseURL ||
      returnPath.length > 2048 ||
      /[\r\n\\]/.test(returnPath)
    )
      throw failure();
    this.db
      .prepare("DELETE FROM agent_auth_provider_flow WHERE expires_at<=?")
      .run(Date.now());
    if (
      Number(
        this.db
          .prepare("SELECT count(*) AS count FROM agent_auth_provider_flow")
          .get()!.count,
      ) >= 1000
    )
      throw failure("auth_provider_flow_limit", 429);
    const flow: AuthProviderFlow = Object.freeze({
      id: randomBytes(32).toString("base64url"),
      organizationId: input.organizationId,
      providerId: input.providerId,
      providerRevision: config.revision,
      mode: input.mode,
      actor: input.actor ? { ...input.actor } : null,
      ...(invitation ? { invitationId: invitation.id } : {}),
      returnPath,
      expiresAt: Date.now() + 600_000,
    });
    this.db
      .prepare("INSERT INTO agent_auth_provider_flow VALUES(?,?,?)")
      .run(
        flow.id,
        flow.expiresAt,
        JSON.stringify({ ...flow, phase: "pending" }),
      );
    return flow;
  }
  private flow(id: string): FlowData {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw failure();
    const row = this.db
      .prepare("SELECT data FROM agent_auth_provider_flow WHERE id=?")
      .get(id);
    if (!row) throw failure();
    return JSON.parse(String(row.data)) as FlowData;
  }
  private writeFlow(value: FlowData) {
    this.db
      .prepare("UPDATE agent_auth_provider_flow SET data=? WHERE id=?")
      .run(JSON.stringify(value), value.id);
  }
  validateFlow(id: string, providerId?: string): FlowData {
    const flow = this.flow(id);
    const config = this.enabled(flow.organizationId, flow.providerId);
    if (
      flow.expiresAt <= Date.now() ||
      flow.phase === "failed" ||
      config.revision !== flow.providerRevision ||
      (providerId && providerId !== flow.providerId)
    )
      throw failure();
    if (flow.actor) this.assertActor(flow.organizationId, flow.actor);
    if (flow.invitationId) {
      const invitation = new Invitations(this.db).inspectId(flow.invitationId);
      if (
        invitation.organization_id !== flow.organizationId ||
        (flow.userId &&
          this.localEmail(flow.userId).toLowerCase() !== invitation.email)
      )
        throw failure();
    } else if (flow.userId) this.assertMember(flow.organizationId, flow.userId);
    return flow;
  }
  startFlow(id: string, mode: AuthProviderFlow["mode"], providerId: string) {
    const flow = this.validateFlow(id, providerId);
    if (flow.phase !== "pending" || flow.mode !== mode) throw failure();
    this.writeFlow({ ...flow, phase: "started" });
    return flow;
  }
  claimFlow(id: string, providerId: string, revision: number) {
    const flow = this.validateFlow(id, providerId);
    if (flow.phase !== "started" || flow.providerRevision !== revision)
      throw failure();
    this.writeFlow({ ...flow, phase: "exchanging" });
    return flow;
  }
  verifyFlow(
    id: string,
    providerId: string,
    subject: string,
    profile?: { email?: string | null; name?: string | null },
  ) {
    const flow = this.validateFlow(id, providerId);
    if (
      flow.phase !== "exchanging" ||
      !subject.trim() ||
      subject.length > 1024 ||
      ["undefined", "null"].includes(subject)
    )
      throw failure();
    const owners = this.db
      .prepare(
        'SELECT id,"userId" FROM account WHERE "providerId"=? AND "accountId"=?',
      )
      .all(providerId, subject);
    if (owners.length > 1) throw failure();
    let owner = owners[0];
    if (flow.invitationId) {
      const invitation = new Invitations(this.db).inspectId(flow.invitationId);
      if (
        !profile?.email ||
        profile.email.trim().toLowerCase() !== invitation.email
      )
        throw failure("invitation_account_mismatch");
      // The invitation bearer proves the invited mailbox, including providers
      // without emailVerified. Never use an email match to link an existing user.
      const existing = this.db
        .prepare("SELECT id FROM user WHERE lower(email)=?")
        .get(invitation.email);
      if (existing && (!owner || owner.userId !== existing.id))
        throw failure("auth_provider_link_required");
      if (
        owner &&
        this.localEmail(String(owner.userId)).toLowerCase() !== invitation.email
      )
        throw failure("invitation_account_mismatch");
      if (!owner) {
        const userId = randomUUID(),
          accountId = randomUUID(),
          now = new Date().toISOString();
        this.db.exec("SAVEPOINT invitation_identity");
        try {
          this.db
            .prepare(
              'INSERT INTO user (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)',
            )
            .run(
              userId,
              profile.name?.trim().slice(0, 100) || invitation.email,
              invitation.email,
              now,
              now,
            );
          this.db
            .prepare(
              'INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES (?,?,?,?,?,?)',
            )
            .run(accountId, subject, providerId, userId, now, now);
          this.db.exec("RELEASE invitation_identity");
          owner = { id: accountId, userId };
        } catch (error) {
          this.db.exec(
            "ROLLBACK TO invitation_identity; RELEASE invitation_identity",
          );
          throw error;
        }
      }
    }
    const userId =
      flow.mode === "link"
        ? flow.actor!.userId
        : owner
          ? String(owner.userId)
          : null;
    if (
      !userId ||
      (owner && owner.userId !== userId) ||
      (flow.actor && flow.actor.userId !== userId)
    )
      throw failure("auth_provider_link_required");
    if (!flow.invitationId) this.assertMember(flow.organizationId, userId);
    // One provider alias represents one chosen personal identity for each user.
    if (
      this.db
        .prepare(
          'SELECT 1 FROM account WHERE "providerId"=? AND "userId"=? AND "accountId"<>?',
        )
        .get(providerId, userId, subject)
    )
      throw failure("auth_provider_account_conflict");
    const value: FlowData = { ...flow, phase: "verified", userId, subject };
    this.writeFlow(value);
    return value;
  }
  assertVerified(
    id: string,
    userId?: string,
    providerId?: string,
    subject?: string,
  ) {
    const flow = this.validateFlow(id, providerId);
    if (
      !["verified", "complete"].includes(flow.phase) ||
      !flow.userId ||
      !flow.subject ||
      (userId && flow.userId !== userId) ||
      (subject && flow.subject !== subject)
    )
      throw failure();
    return flow;
  }
  complete(id: string) {
    this.writeFlow({ ...this.assertVerified(id), phase: "complete" });
  }
  fail(id: string) {
    const flow = this.flow(id);
    if (flow.phase !== "complete") this.writeFlow({ ...flow, phase: "failed" });
  }
  status(id: string) {
    const flow = this.validateFlow(id);
    return {
      providerId: flow.providerId,
      providerRevision: flow.providerRevision,
      mode: flow.mode,
      phase: flow.phase,
      returnPath: flow.returnPath,
    };
  }
  localEmail(userId: string) {
    const value = this.db
      .prepare("SELECT email FROM user WHERE id=?")
      .get(userId)?.email;
    if (!value) throw failure();
    return z.email().parse(value);
  }
}
