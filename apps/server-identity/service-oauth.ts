import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  ServiceOAuthClientInput,
  ServiceOAuthConfig,
  ServiceOAuthFinishInput,
  ServiceOAuthIdentity,
  ServiceOAuthSettings,
  ServiceOAuthStatus,
  type OAuthMetadata,
  type ServiceOAuthProbe,
} from "../../packages/protocol/service-oauth";
import {
  oauthOrigin,
  providerOAuthMetadata,
  validateOAuthMetadata,
  type OAuthClient,
  type OAuthExchange,
  type OAuthProfile,
  type OAuthRefresh,
  type OAuthRegistration,
  type OAuthTokens,
  type ProviderOAuthSource,
} from "../server-integrations/service-oauth";
import { IdentityError } from "./error";

export type ServiceOAuthTarget = {
  workspaceId: string;
  serviceId: string;
  serviceUrl: string;
  serviceRevision: number;
};
export type ServiceOAuthActor = { userId: string; sessionId: string };
export type ServiceOAuthPin = {
  authProvider?: import("./auth-providers").AuthProviderPin;
  configRevision: number;
  connectionRevision: number;
  externalUserId: string;
  externalWorkspaceId: string;
};
export type ServiceOAuthRegistrationSnapshot = OAuthRegistration & {
  target: ServiceOAuthTarget;
  configRevision: number;
  scopes: string[];
};
export type ServiceOAuthClaim = OAuthExchange & {
  target: ServiceOAuthTarget;
  actor: ServiceOAuthActor;
  configRevision: number;
  connectionRevision: number;
  expiresAt: number;
  profile: OAuthProfile;
  scopes: string[];
  providerRevision?: number;
};
/** Server-only OAuth client of an organization sign-in method. */
export type ProviderClient = ProviderOAuthSource &
  OAuthClient & { revision: number };
export type ProviderClients = (
  workspaceId: string,
  providerId: string,
) => ProviderClient;
export type ServiceOAuthRefreshSnapshot = OAuthRefresh & {
  target: ServiceOAuthTarget;
  userId: string;
  configRevision: number;
  connectionRevision: number;
  generation: number;
};
type Configuration = {
  revision: number;
  /** Revision of what a personal connection's tokens depend on: service URL,
   * sign-in source and method, scopes, discovered endpoints and client. When
   * only the approval mode or the sign-in hint changes it stays put, so saving
   * those does not disconnect everyone. Absent on older rows: `revision`. */
  credentialRevision?: number;
  serviceUrl: string;
  settings: ServiceOAuthSettings;
  metadata: OAuthMetadata | null;
  /** The last automatic probe of `serviceUrl`; informational, no revision. */
  probe?: ServiceOAuthProbe;
};
type Connection = {
  revision: number;
  configRevision: number;
  identity: z.infer<typeof ServiceOAuthIdentity> | null;
  expiresAt: number | null;
  /** Bumped by every token write, so a stale refresh can never overwrite a newer grant. */
  generation?: number;
  refreshable?: boolean;
};
type Effective = {
  metadata: OAuthMetadata | null;
  client?: OAuthClient;
  scopes: string[];
  profile: OAuthProfile;
  providerRevision?: number;
};
/** Refresh ahead of expiry so a dispatched request never carries a token about to lapse. */
const REFRESH_MARGIN = 5 * 60 * 1000;
type Pending = Omit<ServiceOAuthClaim, "code">;
/** The configuration revision personal connections and execution pins bind to. */
const credentialRevision = (config: Configuration) =>
  config.credentialRevision ?? config.revision;
/** Settings that change which account and permissions a token stands for. */
const credentialSettings = (settings: ServiceOAuthSettings) =>
  JSON.stringify([
    settings.source ?? "service",
    settings.authProviderId ?? null,
    settings.scopes ?? null,
  ]);
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const defaults: ServiceOAuthSettings = {
  requiredFor: "none",
  signInHint: "service",
};
const unique = (values: readonly string[]) => [...new Set(values)];
const conflict = () => new IdentityError(409, "service_oauth_conflict");
const invalidState = () =>
  new IdentityError(403, "service_oauth_state_invalid");
export class ServiceConnectionRequired extends IdentityError {
  constructor(
    readonly serviceId: string,
    readonly serviceName: string,
    readonly providerName?: string,
  ) {
    super(403, "service_oauth_connection_required");
  }
}
/** Pin fields for either account shape; Twenty keeps its original user/workspace pair. */
function external(identity: z.infer<typeof ServiceOAuthIdentity>) {
  return "subject" in identity
    ? {
        externalUserId: identity.subject,
        externalWorkspaceId: identity.tenant ?? "",
      }
    : {
        externalUserId: identity.userId,
        externalWorkspaceId: identity.workspaceId,
      };
}
/** A consent belongs to the service's address, not its revision: editing a description or
 * its actions must not cancel a sign-in. Its OAuth settings have their own revision. */
const equalTarget = (a: ServiceOAuthTarget, b: ServiceOAuthTarget) =>
  a.workspaceId === b.workspaceId &&
  a.serviceId === b.serviceId &&
  a.serviceUrl === b.serviceUrl;

/** Synchronous methods require the caller's identity queue/transaction and authorization.
 * Snapshots/claims contain secrets and are server-only. Async provider calls happen elsewhere.
 * The caller must validate current session, membership and catalog service before each step.
 */
export class ServiceOAuthStore {
  private readonly key: Buffer;
  private providers?: ProviderClients;
  private providerMetadata?: (
    workspaceId: string,
    providerId: string,
    userId: string,
  ) => boolean;
  readonly redirectUri: string;
  constructor(
    private readonly db: DatabaseSync,
    secret: string,
    baseURL: string,
  ) {
    this.key = Buffer.from(
      hkdfSync("sha256", secret, "agent-server", "service-oauth/v1", 32),
    );
    this.redirectUri = new URL("/admin/service-connect", baseURL).href;
    db.exec(`CREATE TABLE IF NOT EXISTS agent_service_oauth_config (
      workspace_id TEXT NOT NULL, service_id TEXT NOT NULL, data TEXT NOT NULL, secret TEXT,
      PRIMARY KEY(workspace_id,service_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_service_oauth_connection (
      workspace_id TEXT NOT NULL, service_id TEXT NOT NULL, user_id TEXT NOT NULL,
      data TEXT NOT NULL, secret TEXT,
      PRIMARY KEY(workspace_id,service_id,user_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_service_oauth_pending (
      digest TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, service_id TEXT NOT NULL,
      user_id TEXT NOT NULL, session_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
      secret TEXT NOT NULL
    ) STRICT;`);
  }
  /** Sign-in methods live in another store; they are resolved on every use, never copied. */
  useProviders(providers: ProviderClients) {
    this.providers = providers;
  }
  useProviderMetadata(
    read: (workspaceId: string, providerId: string, userId: string) => boolean,
  ) {
    this.providerMetadata = read;
  }
  /** When the service needs the person's own account; passive, never decrypts. */
  requiredFor(
    workspaceId: string,
    serviceId: string,
  ): ServiceOAuthSettings["requiredFor"] {
    const row = this.db
      .prepare(
        "SELECT data FROM agent_service_oauth_config WHERE workspace_id=? AND service_id=?",
      )
      .get(workspaceId, serviceId);
    return row
      ? (JSON.parse(String(row.data)) as Configuration).settings.requiredFor
      : defaults.requiredFor;
  }
  /** Availability only. Never decrypts a client/token or refreshes an account. */
  executionReady(
    target: ServiceOAuthTarget,
    userId: string,
    effect: "read" | "write",
  ) {
    const config = this.read(target);
    if (
      config.settings.requiredFor === "none" ||
      (config.settings.requiredFor === "writes" && effect === "read")
    )
      return "shared" as const;
    const { data, secret } = this.connection(target, userId);
    let configured = config.serviceUrl === target.serviceUrl;
    if (config.settings.authProviderId) {
      try {
        configured &&= !!this.providerMetadata?.(
          target.workspaceId,
          config.settings.authProviderId,
          userId,
        );
      } catch {
        configured = false;
      }
    }
    if (config.settings.source === "provider") {
      try {
        configured &&=
          !!config.settings.authProviderId && !!this.providerMetadata;
      } catch {
        configured = false;
      }
    } else configured &&= !!config.metadata && !!this.row(target)?.secret;
    return configured &&
      !!secret &&
      data.configRevision === credentialRevision(config) &&
      !!data.identity &&
      (data.expiresAt ?? 0) > Date.now() + 30000
      ? ("personal" as const)
      : false;
  }
  private effective(
    target: ServiceOAuthTarget,
    config = this.read(target),
  ): Effective {
    const { settings } = config;
    if (settings.source === "provider") {
      if (!this.providers || !settings.authProviderId)
        throw new IdentityError(409, "auth_provider_unavailable");
      const provider = this.providers(
        target.workspaceId,
        settings.authProviderId,
      );
      return {
        metadata: providerOAuthMetadata(provider),
        client: {
          clientId: provider.clientId,
          clientSecret: provider.clientSecret,
        },
        // openid proves the account; offline_access lets Microsoft issue a refresh token.
        scopes: unique([
          "openid",
          "profile",
          ...(provider.kind === "microsoft" ? ["offline_access"] : []),
          ...(settings.scopes ?? []),
        ]),
        profile: "oidc",
        providerRevision: provider.revision,
      };
    }
    const scopes = settings.scopes ?? ["api", "profile"];
    const matches = config.serviceUrl === target.serviceUrl;
    return {
      metadata: matches ? config.metadata : null,
      client: matches ? this.client(target) : undefined,
      scopes,
      profile: scopes.includes("openid") ? "oidc" : "twenty",
    };
  }
  private seal(value: unknown, scope: readonly string[]) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(scope)));
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), bytes]
      .map((b) => b.toString("base64url"))
      .join(".");
  }
  private unseal<T>(value: unknown, scope: readonly string[]): T {
    const [iv, tag, bytes] = String(value)
      .split(".")
      .map((p) => Buffer.from(p, "base64url"));
    if (!iv || !tag || !bytes) throw conflict();
    const cipher = createDecipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(scope)));
    cipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([cipher.update(bytes), cipher.final()]).toString("utf8"),
    ) as T;
  }
  private row(target: ServiceOAuthTarget) {
    return this.db
      .prepare(
        "SELECT data,secret FROM agent_service_oauth_config WHERE workspace_id=? AND service_id=?",
      )
      .get(target.workspaceId, target.serviceId);
  }
  private read(target: ServiceOAuthTarget): Configuration {
    const row = this.row(target);
    return row
      ? (JSON.parse(String(row.data)) as Configuration)
      : {
          revision: 0,
          serviceUrl: target.serviceUrl,
          settings: defaults,
          metadata: null,
        };
  }
  private client(target: ServiceOAuthTarget): OAuthClient | undefined {
    const row = this.row(target);
    return row?.secret
      ? this.unseal(row.secret, [
          "client",
          target.workspaceId,
          target.serviceId,
        ])
      : undefined;
  }
  /** How many people have a working sign-in to the service: one made for its
   * current address and sign-in settings. Expiry is left out; it refreshes. */
  connectedPeople(target: ServiceOAuthTarget): number {
    const stored = this.read(target);
    if (stored.serviceUrl !== target.serviceUrl) return 0;
    return this.db
      .prepare(
        "SELECT data,secret FROM agent_service_oauth_connection WHERE workspace_id=? AND service_id=?",
      )
      .all(target.workspaceId, target.serviceId)
      .filter((row) => {
        const data = JSON.parse(String(row.data)) as Connection;
        return (
          !!row.secret &&
          !!data.identity &&
          data.configRevision === credentialRevision(stored)
        );
      }).length;
  }
  private connection(target: ServiceOAuthTarget, userId: string) {
    const row = this.db
      .prepare(
        "SELECT data,secret FROM agent_service_oauth_connection WHERE workspace_id=? AND service_id=? AND user_id=?",
      )
      .get(target.workspaceId, target.serviceId, userId);
    const data: Connection = row
      ? (JSON.parse(String(row.data)) as Connection)
      : {
          revision: 0,
          configRevision: 0,
          identity: null,
          expiresAt: null,
        };
    return { data, secret: row?.secret };
  }
  config(target: ServiceOAuthTarget): ServiceOAuthConfig {
    const config = this.read(target);
    let effective: Effective | undefined;
    try {
      effective = this.effective(target, config);
    } catch {
      // A disabled or deleted sign-in method leaves the service unconfigured, not broken.
    }
    return ServiceOAuthConfig.parse({
      revision: config.revision,
      settings: config.settings,
      hasClientId: !!effective?.client?.clientId,
      hasClientSecret: !!effective?.client?.clientSecret,
      discovery: effective?.metadata ?? null,
      // A probe belongs to the address it looked at, like the metadata.
      lastProbe:
        config.serviceUrl === target.serviceUrl ? (config.probe ?? null) : null,
    });
  }
  status(target: ServiceOAuthTarget, userId: string): ServiceOAuthStatus {
    const config = this.config(target),
      stored = this.read(target);
    const { data, secret } = this.connection(target, userId);
    const active =
      !!secret &&
      stored.serviceUrl === target.serviceUrl &&
      data.configRevision === credentialRevision(stored) &&
      !!data.identity &&
      !!config.discovery;
    return ServiceOAuthStatus.parse({
      config,
      connection: {
        revision: data.revision,
        // An access token that lapsed but can be renewed is still a working
        // connection: it is refreshed before the next call (and in the
        // background), so the person is not asked to sign in again.
        status: !active
          ? "disconnected"
          : (data.expiresAt ?? 0) <= Date.now() + 30000 && !data.refreshable
            ? "expired"
            : "connected",
        identity: active ? data.identity : null,
        expiresAt: active ? data.expiresAt : null,
      },
    });
  }
  private check(target: ServiceOAuthTarget, revision: number) {
    const config = this.read(target);
    if (config.revision !== revision || config.serviceUrl !== target.serviceUrl)
      throw conflict();
    return config;
  }
  /** Stores the configuration; sign-ins under way end unless `keepPending`
   * (a change nothing a sign-in depends on). */
  private writeConfig(
    target: ServiceOAuthTarget,
    config: Configuration,
    client?: OAuthClient,
    keepPending = false,
  ) {
    this.db
      .prepare(
        `INSERT INTO agent_service_oauth_config VALUES (?,?,?,?)
      ON CONFLICT(workspace_id,service_id) DO UPDATE SET data=excluded.data,secret=excluded.secret`,
      )
      .run(
        target.workspaceId,
        target.serviceId,
        JSON.stringify(config),
        client
          ? this.seal(client, ["client", target.workspaceId, target.serviceId])
          : null,
      );
    if (keepPending) return;
    this.db
      .prepare(
        "DELETE FROM agent_service_oauth_pending WHERE workspace_id=? AND service_id=?",
      )
      .run(target.workspaceId, target.serviceId);
  }
  save(
    target: ServiceOAuthTarget,
    expectedRevision: number,
    settings: ServiceOAuthSettings,
    credentials: z.infer<typeof ServiceOAuthClientInput> = {},
  ) {
    const value0 = ServiceOAuthSettings.parse(settings);
    // A service that publishes its own OAuth metadata must be reached over HTTPS.
    if (value0.requiredFor !== "none" && value0.source !== "provider")
      oauthOrigin(target.serviceUrl);
    const previous = this.read(target);
    if (previous.revision !== expectedRevision) throw conflict();
    const value = ServiceOAuthClientInput.parse(credentials);
    const sameService = previous.serviceUrl === target.serviceUrl;
    const previousClient = sameService ? this.client(target) : undefined;
    const clientId = value.clientId ?? previousClient?.clientId;
    const clientSecret =
      value.clientSecret ??
      (value.clientId && value.clientId !== previousClient?.clientId
        ? undefined
        : previousClient?.clientSecret);
    if (clientSecret && !clientId)
      throw new IdentityError(400, "service_oauth_client_required");
    const credentialsKept =
      sameService &&
      previous.revision > 0 &&
      credentialSettings(previous.settings) === credentialSettings(value0) &&
      clientId === previousClient?.clientId &&
      clientSecret === previousClient?.clientSecret;
    this.writeConfig(
      target,
      {
        revision: expectedRevision + 1,
        credentialRevision: credentialsKept
          ? credentialRevision(previous)
          : expectedRevision + 1,
        serviceUrl: target.serviceUrl,
        settings: value0,
        metadata: sameService ? previous.metadata : null,
        ...(sameService && previous.probe ? { probe: previous.probe } : {}),
      },
      clientId
        ? { clientId, ...(clientSecret ? { clientSecret } : {}) }
        : undefined,
    );
    return this.config(target);
  }
  /** After the service address changed, the stored metadata, client and probe
   * belong to the old origin: drop them and keep the settings, so discovery
   * can start again at the new address. A matching address is a no-op. */
  rebase(target: ServiceOAuthTarget, expectedRevision: number) {
    const previous = this.read(target);
    if (previous.revision !== expectedRevision) throw conflict();
    if (previous.serviceUrl !== target.serviceUrl)
      this.writeConfig(target, {
        revision: expectedRevision + 1,
        credentialRevision: expectedRevision + 1,
        serviceUrl: target.serviceUrl,
        settings: previous.settings,
        metadata: null,
      });
    return this.config(target);
  }
  /** Notes what an automatic probe found; the configuration revision stays,
   * nothing a connection (or a sign-in under way) depends on changes. */
  recordProbe(
    target: ServiceOAuthTarget,
    expectedRevision: number,
    probe: ServiceOAuthProbe,
  ) {
    const previous = this.check(target, expectedRevision);
    this.writeConfig(target, { ...previous, probe }, this.client(target), true);
    return this.config(target);
  }
  setDiscovery(
    target: ServiceOAuthTarget,
    expectedRevision: number,
    metadata: OAuthMetadata,
  ) {
    const previous = this.check(target, expectedRevision);
    const validated = validateOAuthMetadata(target.serviceUrl, metadata);
    this.writeConfig(
      target,
      {
        ...previous,
        revision: expectedRevision + 1,
        // Rediscovering the same endpoints keeps existing connections.
        credentialRevision:
          JSON.stringify(validated) === JSON.stringify(previous.metadata)
            ? credentialRevision(previous)
            : expectedRevision + 1,
        metadata: validated,
      },
      this.client(target),
    );
    return this.config(target);
  }
  registration(
    target: ServiceOAuthTarget,
    revision: number,
  ): ServiceOAuthRegistrationSnapshot {
    const config = this.check(target, revision);
    if (config.settings.source === "provider")
      throw new IdentityError(409, "service_oauth_registration_unsupported");
    if (!config.metadata)
      throw new IdentityError(409, "service_oauth_discovery_required");
    return {
      target: { ...target },
      configRevision: revision,
      serviceUrl: target.serviceUrl,
      metadata: config.metadata,
      redirectUri: this.redirectUri,
      scopes: this.effective(target, config).scopes,
    };
  }
  commitRegistration(
    snapshot: ServiceOAuthRegistrationSnapshot,
    result: OAuthClient,
    currentTarget: ServiceOAuthTarget,
  ) {
    if (!equalTarget(snapshot.target, currentTarget)) throw conflict();
    const previous = this.check(currentTarget, snapshot.configRevision);
    const client = ServiceOAuthClientInput.parse(result);
    if (!client.clientId)
      throw new IdentityError(400, "service_oauth_client_required");
    // A public client (no secret) needs a token endpoint that accepts "none".
    if (
      !client.clientSecret &&
      !snapshot.metadata.tokenEndpointAuthMethods.includes("none")
    )
      throw new IdentityError(409, "service_oauth_client_invalid");
    this.writeConfig(
      currentTarget,
      {
        ...previous,
        revision: previous.revision + 1,
        credentialRevision: previous.revision + 1,
      },
      {
        clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
      },
    );
    return this.config(currentTarget);
  }
  start(
    target: ServiceOAuthTarget,
    actor: ServiceOAuthActor,
    revision: number,
  ) {
    const config = this.check(target, revision);
    const effective = this.effective(target, config);
    const metadata = effective.metadata,
      client = effective.client;
    if (!metadata)
      throw new IdentityError(409, "service_oauth_discovery_required");
    if (!client) throw new IdentityError(409, "service_oauth_client_required");
    if (
      !metadata.tokenEndpointAuthMethods.includes(
        client.clientSecret ? "client_secret_post" : "none",
      )
    )
      throw new IdentityError(409, "service_oauth_client_invalid");
    this.db
      .prepare("DELETE FROM agent_service_oauth_pending WHERE expires_at<=?")
      .run(Date.now());
    const count = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_service_oauth_pending WHERE user_id=?",
      )
      .get(actor.userId);
    if (Number(count?.n) >= 10)
      throw new IdentityError(429, "service_oauth_pending_limit");
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url");
    const oidc = effective.profile === "oidc";
    const nonce = oidc ? randomBytes(32).toString("base64url") : undefined;
    const stateDigest = digest(state),
      expiresAt = Date.now() + 10 * 60 * 1000;
    const pending: Pending = {
      target: { ...target },
      configRevision: revision,
      serviceUrl: target.serviceUrl,
      metadata,
      redirectUri: this.redirectUri,
      ...client,
      actor: { ...actor },
      verifier,
      expiresAt,
      profile: effective.profile,
      scopes: effective.scopes,
      ...(nonce ? { nonce } : {}),
      ...(effective.providerRevision !== undefined
        ? { providerRevision: effective.providerRevision }
        : {}),
      connectionRevision: this.connection(target, actor.userId).data.revision,
    };
    this.db
      .prepare("INSERT INTO agent_service_oauth_pending VALUES (?,?,?,?,?,?,?)")
      .run(
        stateDigest,
        target.workspaceId,
        target.serviceId,
        actor.userId,
        actor.sessionId,
        expiresAt,
        this.seal(pending, [
          "pending",
          stateDigest,
          actor.userId,
          actor.sessionId,
        ]),
      );
    const url = new URL(metadata.authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: client.clientId,
      response_type: "code",
      redirect_uri: this.redirectUri,
      ...(effective.scopes.length ? { scope: effective.scopes.join(" ") } : {}),
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      ...(nonce ? { nonce } : {}),
      // Google issues a refresh token only for offline access with fresh consent.
      ...(metadata.issuer === "https://accounts.google.com"
        ? { access_type: "offline", prompt: "consent" }
        : {}),
    }).toString();
    return { authorizationUrl: url.href, expiresAt };
  }
  private pending(state: string, actor: ServiceOAuthActor): Pending {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw invalidState();
    const stateDigest = digest(state);
    const row = this.db
      .prepare(
        "SELECT * FROM agent_service_oauth_pending WHERE digest=? AND user_id=? AND session_id=?",
      )
      .get(stateDigest, actor.userId, actor.sessionId);
    if (!row || Number(row.expires_at) <= Date.now()) throw invalidState();
    const pending = this.unseal<Pending>(row.secret, [
      "pending",
      stateDigest,
      actor.userId,
      actor.sessionId,
    ]);
    this.checkProvider(pending.target, pending.configRevision, pending);
    if (
      this.connection(pending.target, actor.userId).data.revision !==
      pending.connectionRevision
    )
      throw conflict();
    return pending;
  }
  /** The sign-in method must still be the same one whose client started the flow. */
  private checkProvider(
    target: ServiceOAuthTarget,
    revision: number,
    value: { providerRevision?: number },
  ) {
    const config = this.check(target, revision);
    if (config.settings.source !== "provider") return config;
    let current: number | undefined;
    try {
      current = this.effective(target, config).providerRevision;
    } catch {
      throw conflict();
    }
    if (current !== value.providerRevision) throw conflict();
    return config;
  }
  pendingTarget(state: string, actor: ServiceOAuthActor): ServiceOAuthTarget {
    return { ...this.pending(state, actor).target };
  }
  /** Only the opaque state from a mobile-initiated PKCE flow can select this actor.
   * Caller must revalidate this mobile session before claiming and after network I/O. */
  mobileActor(state: string): ServiceOAuthActor {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw invalidState();
    const row = this.db
      .prepare(
        "SELECT user_id, session_id, expires_at FROM agent_service_oauth_pending WHERE digest=?",
      )
      .get(digest(state));
    if (
      !row ||
      Number(row.expires_at) <= Date.now() ||
      !/^mobile:[a-f0-9]{64}$/.test(String(row.session_id))
    )
      throw invalidState();
    return { userId: String(row.user_id), sessionId: String(row.session_id) };
  }
  cancelPending(state: string, actor: ServiceOAuthActor) {
    this.db
      .prepare(
        "DELETE FROM agent_service_oauth_pending WHERE digest=? AND user_id=? AND session_id=?",
      )
      .run(digest(state), actor.userId, actor.sessionId);
  }
  claimFromState(
    actor: ServiceOAuthActor,
    input: z.infer<typeof ServiceOAuthFinishInput>,
  ): ServiceOAuthClaim {
    const value = ServiceOAuthFinishInput.parse(input),
      pending = this.pending(value.state, actor);
    if (
      (pending.metadata.authorizationResponseIssParameterSupported &&
        !value.iss) ||
      (value.iss && value.iss !== pending.metadata.issuer)
    )
      throw invalidState();
    this.db
      .prepare("DELETE FROM agent_service_oauth_pending WHERE digest=?")
      .run(digest(value.state));
    return { ...pending, code: value.code };
  }
  assertClaim(
    claim: ServiceOAuthClaim,
    actor: ServiceOAuthActor,
    currentTarget: ServiceOAuthTarget,
  ) {
    if (
      claim.actor.userId !== actor.userId ||
      claim.actor.sessionId !== actor.sessionId ||
      !equalTarget(claim.target, currentTarget) ||
      claim.expiresAt <= Date.now()
    )
      throw invalidState();
    this.checkProvider(currentTarget, claim.configRevision, claim);
    if (
      this.connection(currentTarget, actor.userId).data.revision !==
      claim.connectionRevision
    )
      throw conflict();
  }
  /** linkedSubject: the account the person linked with this sign-in method. A token
   * for any other account (e.g. a forwarded consent link) is never stored. */
  commitConnection(
    claim: ServiceOAuthClaim,
    tokens: OAuthTokens,
    actor: ServiceOAuthActor,
    currentTarget: ServiceOAuthTarget,
    linkedSubject?: string,
  ) {
    this.assertClaim(claim, actor, currentTarget);
    const identity = ServiceOAuthIdentity.parse(tokens.identity);
    // Twenty's user tokens must carry its "api" permission; an opaque
    // token of another MCP server carries no scope we could read.
    if (
      tokens.expiresAt <= Date.now() + 30000 ||
      (claim.profile !== "oidc" &&
        "userId" in identity &&
        !tokens.scopes.includes("api"))
    )
      throw new IdentityError(401, "service_oauth_token_expired");
    if (
      claim.providerRevision !== undefined &&
      (!("subject" in identity) || identity.subject !== linkedSubject)
    )
      throw new IdentityError(403, "service_oauth_account_mismatch");
    const previous = this.connection(currentTarget, actor.userId).data;
    const connection: Connection = {
      revision: claim.connectionRevision + 1,
      // assertClaim proved the configuration is still claim.configRevision.
      configRevision: credentialRevision(this.read(currentTarget)),
      identity,
      expiresAt: tokens.expiresAt,
      generation: (previous.generation ?? 0) + 1,
      refreshable: !!tokens.refreshToken,
    };
    this.db
      .prepare(
        `INSERT INTO agent_service_oauth_connection VALUES (?,?,?,?,?)
      ON CONFLICT(workspace_id,service_id,user_id) DO UPDATE SET data=excluded.data,secret=excluded.secret`,
      )
      .run(
        currentTarget.workspaceId,
        currentTarget.serviceId,
        actor.userId,
        JSON.stringify(connection),
        this.seal(tokens, [
          "connection",
          currentTarget.workspaceId,
          currentTarget.serviceId,
          actor.userId,
        ]),
      );
    this.db
      .prepare(
        "DELETE FROM agent_service_oauth_pending WHERE workspace_id=? AND service_id=? AND user_id=?",
      )
      .run(currentTarget.workspaceId, currentTarget.serviceId, actor.userId);
    return this.status(currentTarget, actor.userId);
  }
  disconnect(
    target: ServiceOAuthTarget,
    userId: string,
    expectedConnectionRevision: number,
  ) {
    const { data } = this.connection(target, userId);
    if (data.revision !== expectedConnectionRevision) throw conflict();
    const next: Connection = {
      revision: data.revision + 1,
      configRevision: credentialRevision(this.read(target)),
      identity: null,
      expiresAt: null,
      generation: (data.generation ?? 0) + 1,
    };
    this.db
      .prepare(
        `INSERT INTO agent_service_oauth_connection VALUES (?,?,?,?,NULL)
      ON CONFLICT(workspace_id,service_id,user_id) DO UPDATE SET data=excluded.data,secret=NULL`,
      )
      .run(target.workspaceId, target.serviceId, userId, JSON.stringify(next));
    this.db
      .prepare(
        "DELETE FROM agent_service_oauth_pending WHERE workspace_id=? AND service_id=? AND user_id=?",
      )
      .run(target.workspaceId, target.serviceId, userId);
    return this.status(target, userId);
  }
  resolve(
    target: ServiceOAuthTarget,
    userId: string,
    effect: "read" | "write",
    allowExpired = false,
  ):
    | { kind: "shared" }
    | { kind: "personal"; accessToken: string; pin: ServiceOAuthPin } {
    const config = this.read(target);
    if (
      config.settings.requiredFor === "none" ||
      (config.settings.requiredFor === "writes" && effect === "read")
    )
      return { kind: "shared" };
    const status = this.status(target, userId);
    if (
      status.connection.status !== "connected" &&
      !(allowExpired && status.connection.status === "expired")
    )
      throw new IdentityError(
        403,
        status.connection.status === "expired"
          ? "service_oauth_reconnect_required"
          : "service_oauth_connection_required",
      );
    const { data, secret } = this.connection(target, userId);
    const tokens = this.unseal<OAuthTokens>(secret, [
      "connection",
      target.workspaceId,
      target.serviceId,
      userId,
    ]);
    return {
      kind: "personal",
      accessToken: tokens.accessToken,
      pin: {
        configRevision: credentialRevision(config),
        connectionRevision: data.revision,
        ...external(data.identity!),
      },
    };
  }
  /** allowExpired is only for recording an already-dispatched request's known result. */
  assertPin(
    target: ServiceOAuthTarget,
    userId: string,
    pin: ServiceOAuthPin,
    allowExpired = false,
  ) {
    const config = this.read(target),
      status = this.status(target, userId);
    if (
      credentialRevision(config) !== pin.configRevision ||
      (status.connection.status !== "connected" &&
        !(allowExpired && status.connection.status === "expired")) ||
      status.connection.revision !== pin.connectionRevision ||
      !status.connection.identity ||
      external(status.connection.identity).externalUserId !==
        pin.externalUserId ||
      external(status.connection.identity).externalWorkspaceId !==
        pin.externalWorkspaceId
    )
      throw conflict();
  }
  /**
   * Connections whose access token lapses within `margin` and can be renewed,
   * for the background keeper. Only identifiers; nothing is unsealed.
   */
  renewable(margin: number) {
    return (
      this.db
        .prepare(
          "SELECT workspace_id, service_id, user_id, data FROM agent_service_oauth_connection WHERE secret IS NOT NULL",
        )
        .all() as {
        workspace_id: string;
        service_id: string;
        user_id: string;
        data: string;
      }[]
    ).flatMap((row) => {
      const data = JSON.parse(row.data) as Connection;
      return data.refreshable && (data.expiresAt ?? 0) <= Date.now() + margin
        ? [
            {
              workspaceId: row.workspace_id,
              serviceId: row.service_id,
              userId: row.user_id,
            },
          ]
        : [];
    });
  }
  /** A connection whose token is expired or about to expire but can be renewed. */
  refreshSnapshot(
    target: ServiceOAuthTarget,
    userId: string,
  ): ServiceOAuthRefreshSnapshot | undefined {
    const config = this.read(target);
    if (config.settings.requiredFor === "none") return undefined;
    const status = this.status(target, userId);
    const { data, secret } = this.connection(target, userId);
    if (
      status.connection.status === "disconnected" ||
      !data.refreshable ||
      !secret ||
      (data.expiresAt ?? 0) > Date.now() + REFRESH_MARGIN
    )
      return undefined;
    const tokens = this.unseal<OAuthTokens>(secret, [
      "connection",
      target.workspaceId,
      target.serviceId,
      userId,
    ]);
    const effective = this.effective(target, config);
    if (!tokens.refreshToken || !effective.metadata || !effective.client)
      return undefined;
    return {
      target: { ...target },
      userId,
      configRevision: config.revision,
      connectionRevision: data.revision,
      generation: data.generation ?? 0,
      serviceUrl: target.serviceUrl,
      redirectUri: this.redirectUri,
      metadata: effective.metadata,
      ...effective.client,
      refreshToken: tokens.refreshToken,
      scopes: effective.scopes,
      profile: effective.profile,
      identity: data.identity!,
    };
  }
  /** Keeps the connection revision: approvals pinned to this account stay valid. */
  commitRefresh(
    snapshot: ServiceOAuthRefreshSnapshot,
    tokens: OAuthTokens,
    currentTarget: ServiceOAuthTarget,
  ) {
    if (!equalTarget(snapshot.target, currentTarget)) throw conflict();
    this.check(currentTarget, snapshot.configRevision);
    const { data } = this.connection(currentTarget, snapshot.userId);
    if (
      data.revision !== snapshot.connectionRevision ||
      (data.generation ?? 0) !== snapshot.generation ||
      JSON.stringify(ServiceOAuthIdentity.parse(tokens.identity)) !==
        JSON.stringify(data.identity)
    )
      throw conflict();
    this.writeTokens(currentTarget, snapshot.userId, tokens, {
      ...data,
      expiresAt: tokens.expiresAt,
      generation: snapshot.generation + 1,
      refreshable: !!tokens.refreshToken,
    });
  }
  /** The provider refused the refresh token (revoked or expired): the person reconnects. */
  dropRefresh(snapshot: ServiceOAuthRefreshSnapshot) {
    const { data } = this.connection(snapshot.target, snapshot.userId);
    if (
      data.revision !== snapshot.connectionRevision ||
      (data.generation ?? 0) !== snapshot.generation
    )
      return;
    this.disconnect(snapshot.target, snapshot.userId, data.revision);
  }
  private writeTokens(
    target: ServiceOAuthTarget,
    userId: string,
    tokens: OAuthTokens,
    connection: Connection,
  ) {
    this.db
      .prepare(
        `INSERT INTO agent_service_oauth_connection VALUES (?,?,?,?,?)
      ON CONFLICT(workspace_id,service_id,user_id) DO UPDATE SET data=excluded.data,secret=excluded.secret`,
      )
      .run(
        target.workspaceId,
        target.serviceId,
        userId,
        JSON.stringify(connection),
        this.seal(tokens, [
          "connection",
          target.workspaceId,
          target.serviceId,
          userId,
        ]),
      );
  }
}
