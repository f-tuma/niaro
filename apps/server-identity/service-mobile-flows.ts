import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ServiceCatalogStore } from "./service-catalog";
import type { MobileSessionStore } from "./mobile";
import type { ServiceOAuthActor, ServiceOAuthTarget } from "./service-oauth";
import { IdentityError } from "./error";
import type { AuthProviderPin } from "./auth-providers";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Flow = {
  target: ServiceOAuthTarget;
  actor: ServiceOAuthActor;
  configRevision: number;
  authorizationUrl: string;
  authProviderRevision?: number;
  authProviderPin?: AuthProviderPin;
  connectionRevision: number;
  expiresAt: number;
  status: "pending" | "connected" | "cancelled";
};
/** Each attempt owns its cancellation and completion; old cards never disconnect new grants. */
export class ServiceMobileFlows {
  constructor(
    private db: DatabaseSync,
    private catalog: ServiceCatalogStore,
    private mobile: MobileSessionStore,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS agent_service_mobile_flow (digest TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, data TEXT NOT NULL) STRICT",
    );
  }
  start(target: ServiceOAuthTarget, actor: ServiceOAuthActor) {
    this.db
      .prepare("DELETE FROM agent_service_mobile_flow WHERE expires_at<=?")
      .run(Date.now());
    const count = Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM agent_service_mobile_flow WHERE user_id=?",
        )
        .get(actor.userId)?.n,
    );
    const total = Number(
      this.db
        .prepare("SELECT count(*) AS n FROM agent_service_mobile_flow")
        .get()?.n,
    );
    if (count >= 10 || total >= 512)
      throw new IdentityError(429, "service_oauth_pending_limit");
    const oauth = this.catalog.oauth!,
      config = oauth.config(target),
      connection = oauth.status(target, actor.userId).connection;
    const provider = config.settings.authProviderId
      ? this.catalog.authProviders?.get(
          this.catalog.workspaceOrganization(target.workspaceId),
          config.settings.authProviderId,
        )
      : undefined;
    if (config.settings.authProviderId && !provider?.enabled)
      throw new IdentityError(403, "auth_provider_unavailable");
    const started = oauth.start(target, actor, config.revision);
    const attemptId = new URL(started.authorizationUrl).searchParams.get(
      "state",
    )!;
    const flow: Flow = {
      target,
      actor,
      authorizationUrl: started.authorizationUrl,
      configRevision: config.revision,
      connectionRevision: connection.revision,
      expiresAt: started.expiresAt,
      status: "pending",
    };
    if (provider) flow.authProviderRevision = provider.revision;
    this.db
      .prepare("INSERT INTO agent_service_mobile_flow VALUES (?,?,?,?)")
      .run(hash(attemptId), actor.userId, flow.expiresAt, JSON.stringify(flow));
    return {
      ...started,
      authorizationUrl: `${oauth.redirectUri}#${attemptId}`,
      attemptId,
      serviceId: target.serviceId,
    };
  }
  read(attemptId: string, actor?: ServiceOAuthActor) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(attemptId))
      throw new IdentityError(403, "service_oauth_state_invalid");
    const row = this.db
      .prepare("SELECT data FROM agent_service_mobile_flow WHERE digest=?")
      .get(hash(attemptId));
    if (!row) throw new IdentityError(403, "service_oauth_state_invalid");
    const flow = JSON.parse(String(row.data)) as Flow;
    if (
      flow.expiresAt <= Date.now() ||
      (actor &&
        (actor.userId !== flow.actor.userId ||
          actor.sessionId !== flow.actor.sessionId))
    )
      throw new IdentityError(403, "service_oauth_state_invalid");
    return flow;
  }
  validate(
    attemptId: string,
    serverId: string,
    browserUserId: string,
    requireProvider = false,
  ) {
    const flow = this.read(attemptId);
    if (
      flow.status !== "pending" ||
      flow.actor.userId !== browserUserId ||
      !/^mobile:[a-f0-9]{64}$/.test(flow.actor.sessionId)
    )
      throw new IdentityError(403, "service_oauth_state_invalid");
    const account = this.mobile.authenticateDigest(
      flow.actor.sessionId.slice(7),
      flow.target.workspaceId,
      serverId,
    );
    if (account.grant.user_id !== flow.actor.userId)
      throw new IdentityError(403, "identity_forbidden");
    const current = this.catalog.oauthTarget(
      flow.target.workspaceId,
      flow.target.serviceId,
    );
    const status = this.catalog.oauth!.status(current, flow.actor.userId);
    if (
      current.serviceUrl !== flow.target.serviceUrl ||
      status.config.revision !== flow.configRevision ||
      status.connection.revision !== flow.connectionRevision
    )
      throw new IdentityError(409, "service_oauth_conflict");
    if (status.config.settings.authProviderId) {
      const providers = this.catalog.authProviders,
        id = status.config.settings.authProviderId;
      const provider = providers?.get(account.grant.organization_id, id);
      if (!provider?.enabled || provider.revision !== flow.authProviderRevision)
        throw new IdentityError(409, "service_oauth_conflict");
      if (flow.authProviderPin)
        providers!.assertLinked(
          account.grant.organization_id,
          flow.actor.userId,
          id,
          flow.authProviderPin,
        );
      else if (requireProvider)
        throw new IdentityError(403, "auth_provider_link_required");
    }
    return { flow, account, current };
  }
  authorize(attemptId: string, serverId: string, browserUserId: string) {
    const value = this.validate(attemptId, serverId, browserUserId);
    const id = this.catalog.oauth!.config(value.current).settings
      .authProviderId;
    if (id) {
      const pin = this.catalog.authProviders!.assertLinked(
        value.account.grant.organization_id,
        browserUserId,
        id,
      );
      this.save(attemptId, { ...value.flow, authProviderPin: pin });
    }
    return value.flow.authorizationUrl;
  }
  finish(attemptId: string, revision: number) {
    const flow = this.read(attemptId);
    if (flow.status !== "pending")
      throw new IdentityError(409, "service_oauth_conflict");
    this.save(attemptId, {
      ...flow,
      connectionRevision: revision,
      status: "connected",
    });
  }
  cancel(attemptId: string, actor: ServiceOAuthActor) {
    const flow = this.read(attemptId, actor);
    if (flow.status === "pending") {
      this.save(attemptId, { ...flow, status: "cancelled" });
      this.catalog.oauth!.cancelPending(attemptId, actor);
    }
    return this.read(attemptId, actor);
  }
  private save(attemptId: string, flow: Flow) {
    this.db
      .prepare("UPDATE agent_service_mobile_flow SET data=? WHERE digest=?")
      .run(JSON.stringify(flow), hash(attemptId));
  }
}
