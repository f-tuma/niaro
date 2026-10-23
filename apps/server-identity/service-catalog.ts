import {
  createCipheriv,
  createHash,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  CatalogSchema,
  type Catalog,
  type Service,
  type ServiceAction,
  CatalogCommand,
  ServiceSchema,
  ServiceSettings,
  ServiceActionSchema,
  ProviderSchema,
  ProviderSettings,
  CatalogModelSchema,
  CatalogModelSettings,
  Routing,
  type ActionInvokeRequest,
} from "../../packages/protocol/service-catalog";
import { normalizeModelCapabilities } from "../server-integrations/model-capabilities";
import { validateEndpoint } from "../server-integrations/transport";
import {
  schemaValidator,
  validateArguments,
} from "../server-integrations/schema";
import type { DiscoveredAction } from "../server-integrations/discovery";
import { IdentityError } from "./error";
import {
  ServiceConnectionRequired,
  type ServiceOAuthStore,
  type ServiceOAuthPin,
} from "./service-oauth";
import { WorkspaceRoleStore } from "./workspace-roles";
import {
  PersonalActionPolicyStore,
  type PersonalChoice,
} from "./personal-action-policy";
import { InferenceBudgetStore } from "./inference-budget";
import type { AuthProviderStore } from "./auth-providers";
import {
  ActionFailureSchema,
  type ActionFailure,
} from "../../packages/protocol/action-failure";
import type { ProcessSourceManifest } from "../../packages/protocol/service-processes";
import { ProcessTestCatalogSchema } from "./process-test-catalog";
import {
  legacyQuestionConsumedRoot,
  LegacyQuestionSchema,
} from "./legacy-question";
import type { Scope } from "../../packages/protocol";
type Row = {
  id: string;
  scope_id: string;
  kind: string;
  revision: number;
  data: string;
  secret: string | null;
};
export type CatalogActor = {
  userId: string;
  role: "owner" | "admin" | "member";
};
export type NativeTaskRoot = {
  id: string;
  kind: "mastra-1" | "service-process-1";
  value: unknown;
};
export type StoredInvocation = {
  executionPin?: ServiceOAuthPin;
  auditId?: number;
  completedAt?: number;
  contactSource?: string;
  dependencies?: string[];
  id: string;
  organizationId: string;
  workspaceId: string;
  userId: string;
  serviceId: string;
  actionId: string;
  serviceRevision: number;
  actionRevision: number;
  policyRevision: number;
  input: Record<string, unknown>;
  status:
    | "awaiting_approval"
    | "running"
    | "succeeded"
    | "failed"
    | "unknown"
    | "rejected";
  title: string;
  serviceName: string;
  effect: "read" | "write";
  result?: unknown;
  failure?: ActionFailure;
};
/** All synchronous methods run inside the identity queue/transaction. No remote I/O in this store. */
export class ServiceCatalogStore {
  private key: Buffer;
  readonly workspaceRoles: WorkspaceRoleStore;
  /** Each person's own choices for services they use with their own account. */
  readonly personalPolicy: PersonalActionPolicyStore;
  readonly nativeStorageUrl: string;
  readonly inferenceBudget: InferenceBudgetStore;
  constructor(
    private db: DatabaseSync,
    secret: string,
    readonly trustedOrigins: readonly string[],
    readonly oauth?: ServiceOAuthStore,
    readonly authProviders?: AuthProviderStore,
  ) {
    db.function(
      "niaro_legacy_question_consumed",
      { deterministic: true },
      (rootId, root, turnId, old, serverId, workspaceId, userId) => {
        try {
          return Number(
            legacyQuestionConsumedRoot(
              JSON.parse(String(root)),
              String(rootId),
              String(turnId),
              JSON.parse(String(old)),
              {
                serverId: String(serverId),
                workspaceId: String(workspaceId),
                userId: String(userId),
              },
            ),
          );
        } catch {
          return 0;
        }
      },
    );
    const file = db
      .prepare("PRAGMA database_list")
      .all()
      .find((row) => row.name === "main")?.file;
    this.nativeStorageUrl =
      typeof file === "string" && file
        ? pathToFileURL(`${file}.mastra.sqlite`).href
        : ":memory:";
    this.workspaceRoles = new WorkspaceRoleStore(db);
    this.personalPolicy = new PersonalActionPolicyStore(db);
    if (oauth && authProviders) {
      oauth.useProviders((workspaceId, providerId) =>
        authProviders.client(
          this.workspaceOrganization(workspaceId),
          providerId,
        ),
      );
      oauth.useProviderMetadata((workspaceId, providerId, userId) => {
        const metadata = authProviders.get(
          this.workspaceOrganization(workspaceId),
          providerId,
        );
        authProviders.assertLinked(
          this.workspaceOrganization(workspaceId),
          userId,
          providerId,
        );
        return metadata.enabled && metadata.hasClientSecret;
      });
    }
    this.key = Buffer.from(
      hkdfSync("sha256", secret, "agent-server", "service-catalog/v1", 32),
    );
    db.exec(`CREATE TABLE IF NOT EXISTS agent_catalog (
      id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, secret TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_catalog_scope ON agent_catalog(scope_id,kind);
    CREATE TABLE IF NOT EXISTS agent_catalog_routing (workspace_id TEXT PRIMARY KEY REFERENCES agent_workspace(id) ON DELETE CASCADE, revision INTEGER NOT NULL, data TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS agent_provider_usage (provider_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(provider_id,day)) STRICT;
    CREATE TABLE IF NOT EXISTS agent_service_invocation (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS agent_service_turn (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS agent_service_turn_operation (operation_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES agent_service_turn(id), workspace_id TEXT NOT NULL, user_id TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS agent_service_turn_cursor (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, turn_id TEXT NOT NULL REFERENCES agent_service_turn(id), PRIMARY KEY(workspace_id,user_id)) STRICT;
    CREATE TABLE IF NOT EXISTS agent_service_task_selection (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, turn_id TEXT NOT NULL REFERENCES agent_service_turn(id), PRIMARY KEY(workspace_id,user_id)) STRICT;
    CREATE TABLE IF NOT EXISTS agent_service_conversation_cursor (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, server_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL REFERENCES agent_service_turn(id), PRIMARY KEY(workspace_id,user_id,server_id,conversation_id)) STRICT;`);
    this.inferenceBudget = new InferenceBudgetStore(db);
    // A write interrupted after dispatch must never be retried automatically.
    for (const row of db
      .prepare("SELECT id,data FROM agent_service_invocation")
      .all()) {
      const value = JSON.parse(String(row.data)) as StoredInvocation;
      if (value.status === "running") {
        value.status = value.effect === "write" ? "unknown" : "failed";
        value.failure = ActionFailureSchema.parse({
          code: "action_interrupted",
          kind: "unknown",
          stage: "dispatch",
          retry: value.effect === "write" ? "verify_first" : "later",
          message:
            "The server restarted before recording the outcome. The original cause is unknown.",
          fields: [],
        });
        value.completedAt = Date.now();
        delete value.result;
        this.saveInvocation(value);
        if (value.auditId && value.effect === "write")
          db.prepare("UPDATE agent_audit SET outcome='unknown' WHERE id=?").run(
            value.auditId,
          );
      }
    }
  }
  private seal(value: string, id: string, scope: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([id, scope])));
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), encrypted]
      .map((b) => b.toString("base64url"))
      .join(".");
  }
  private unseal(row: Row) {
    if (!row.secret) return "";
    const [iv, tag, data] = row.secret
      .split(".")
      .map((v) => Buffer.from(v, "base64url"));
    if (!iv || !tag || !data) throw Error("Invalid credential");
    const cipher = createDecipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([row.id, row.scope_id])));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString(
      "utf8",
    );
  }
  private rows(scope: string, kind: string) {
    return this.db
      .prepare(
        "SELECT * FROM agent_catalog WHERE scope_id=? AND kind=? ORDER BY id",
      )
      .all(scope, kind) as Row[];
  }
  private row(scope: string, kind: string, id: string) {
    const row = this.db
      .prepare(
        "SELECT * FROM agent_catalog WHERE scope_id=? AND kind=? AND id=?",
      )
      .get(scope, kind, id) as Row | undefined;
    if (!row) throw new IdentityError(404, "catalog_not_found");
    return row;
  }
  private dto(row: Row) {
    return { ...JSON.parse(row.data), id: row.id, revision: row.revision };
  }
  private check(row: Row | undefined, revision: number) {
    if ((row?.revision ?? 0) !== revision)
      throw new IdentityError(409, "catalog_conflict");
  }
  private save(
    scope: string,
    kind: string,
    id: string | undefined,
    revision: number,
    data: unknown,
    key?: string,
  ) {
    const previous = id ? this.row(scope, kind, id) : undefined;
    this.check(previous, revision);
    const nextId = id ?? randomUUID();
    const secret =
      key === undefined
        ? (previous?.secret ?? null)
        : this.seal(key, nextId, scope);
    this.db
      .prepare(
        "INSERT INTO agent_catalog VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,secret=excluded.secret",
      )
      .run(nextId, scope, kind, revision + 1, JSON.stringify(data), secret);
    return nextId;
  }
  private remove(scope: string, kind: string, id: string, revision: number) {
    this.check(this.row(scope, kind, id), revision);
    this.db.prepare("DELETE FROM agent_catalog WHERE id=?").run(id);
  }
  service(workspaceId: string, id: string): Service {
    const row = this.row(workspaceId, "service", id);
    return ServiceSchema.parse({
      ...this.dto(row),
      hasCredential: !!row.secret,
      modelId:
        this.routing(workspaceId).services.find((s) => s.serviceId === id)
          ?.modelId ?? null,
      actions: this.rows(id, "action").map((r) => this.dto(r)),
    });
  }
  credential(workspaceId: string, id: string) {
    return this.unseal(this.row(workspaceId, "service", id));
  }
  provider(orgId: string, id: string) {
    const row = this.row(orgId, "provider", id);
    return {
      provider: ProviderSchema.parse({
        ...this.dto(row),
        hasCredential: !!row.secret,
        requestsToday: this.usage(id),
      }),
      key: this.unseal(row),
    };
  }
  private usage(id: string) {
    return Number(
      this.db
        .prepare(
          "SELECT count FROM agent_provider_usage WHERE provider_id=? AND day=?",
        )
        .get(id, new Date().toISOString().slice(0, 10))?.count ?? 0,
    );
  }
  useProvider(orgId: string, id: string, revision: number) {
    const { provider, key } = this.provider(orgId, id);
    if (!provider.enabled || provider.revision !== revision)
      throw new IdentityError(409, "catalog_conflict");
    if (provider.requestsToday >= provider.dailyRequestLimit)
      throw new IdentityError(429, "catalog_provider_limit");
    this.db
      .prepare(
        "INSERT INTO agent_provider_usage VALUES (?,?,1) ON CONFLICT(provider_id,day) DO UPDATE SET count=count+1",
      )
      .run(id, new Date().toISOString().slice(0, 10));
    return { provider, key };
  }
  routing(workspaceId: string) {
    const row = this.db
      .prepare("SELECT * FROM agent_catalog_routing WHERE workspace_id=?")
      .get(workspaceId);
    return Routing.parse({
      revision: row?.revision ?? 0,
      ...(row ? JSON.parse(String(row.data)) : { modelId: null, services: [] }),
    });
  }
  private normalizeModel<T extends z.infer<typeof CatalogModelSettings>>(
    org: string,
    value: T,
  ): T {
    const provider = this.dto(this.row(org, "provider", value.providerId));
    return normalizeModelCapabilities(String(provider.url), value);
  }
  private readModel(org: string, row: Row) {
    return this.normalizeModel(org, CatalogModelSchema.parse(this.dto(row)));
  }
  /** Passive process validation; never unseals a provider key. */
  processModelMetadata(orgId: string, id: string) {
    const model = this.readModel(orgId, this.row(orgId, "model", id));
    const provider = this.row(orgId, "provider", model.providerId);
    const settings = ProviderSettings.parse(JSON.parse(provider.data));
    if (
      !model.enabled ||
      !model.tools ||
      !["chat", "router"].includes(model.kind) ||
      !settings.enabled
    )
      throw new IdentityError(409, "catalog_model_unavailable");
    return {
      model,
      provider: { id: provider.id, revision: provider.revision },
    };
  }
  /** Dispatch quota and credential presence, without decrypting the key. */
  processProviderAvailable(orgId: string, id: string) {
    const row = this.row(orgId, "provider", id);
    const settings = ProviderSettings.parse(JSON.parse(row.data));
    return (
      settings.enabled &&
      !!row.secret &&
      this.usage(id) < settings.dailyRequestLimit
    );
  }
  model(
    orgId: string,
    id: string,
    capability:
      | "tools"
      | "chat"
      | "audioInput"
      | "audioOutput"
      | "decision"
      | "transcription"
      | "speech" = "tools",
  ) {
    const model = this.readModel(orgId, this.row(orgId, "model", id));
    const value = this.provider(orgId, model.providerId);
    const supported =
      capability === "decision" ||
      capability === "transcription" ||
      capability === "speech"
        ? model.kind === capability
        : capability === "tools"
          ? (model.kind === "chat" || model.kind === "router") && model.tools
          : capability === "chat"
            ? model.kind === "chat" || model.kind === "router"
            : model.kind === "chat" && model[capability];
    const openRouter =
      value.provider.url.replace(/\/$/, "") === "https://openrouter.ai/api/v1";
    if (
      !model.enabled ||
      !supported ||
      !value.provider.enabled ||
      (capability !== "tools" && !openRouter)
    )
      throw new IdentityError(409, "catalog_model_unavailable");
    return { model, ...value };
  }
  resolveModel(orgId: string, workspaceId: string, serviceId?: string) {
    const route = this.routing(workspaceId);
    const id =
      (serviceId
        ? route.services.find((s) => s.serviceId === serviceId)?.modelId
        : null) ?? route.modelId;
    return id ? this.model(orgId, id) : undefined;
  }
  resolveVoice(orgId: string, workspaceId: string) {
    const route = this.routing(workspaceId);
    const id = route.voiceMode === "catalog" ? route.voiceModelId : null;
    return id
      ? {
          ...this.model(
            orgId,
            id,
            route.voiceMethod === "transcription"
              ? "transcription"
              : "audioInput",
          ),
          method: route.voiceMethod,
        }
      : undefined;
  }
  /** The separate speech-to-text model for meetings, when one is set. */
  resolveMeetingTranscription(orgId: string, workspaceId: string) {
    const id = this.routing(workspaceId).meetingTranscriptionModelId;
    return id
      ? {
          ...this.model(orgId, id, "transcription"),
          method: "transcription" as const,
        }
      : undefined;
  }
  resolveSpeech(orgId: string, workspaceId: string) {
    const route = this.routing(workspaceId).speech;
    return route.modelId
      ? {
          ...this.model(
            orgId,
            route.modelId,
            route.method === "reader" ? "audioOutput" : "speech",
          ),
          method: route.method,
          voice: route.voice,
          zeroDataRetention: route.zeroDataRetention,
        }
      : undefined;
  }
  /**
   * The model of the web plugin's searches: the organization's chat model
   * with this model ID (for example "openai/gpt-4o-mini") on an OpenRouter
   * provider, or the workspace's chat model when the ID is empty. The
   * decision model answers through another API and cannot search.
   */
  resolveWebSearch(orgId: string, workspaceId: string, model: string) {
    const id = model
      ? this.rows(orgId, "model").find(
          (row) => this.readModel(orgId, row).model === model,
        )?.id
      : this.routing(workspaceId).modelId;
    if (!id) throw new IdentityError(409, "catalog_model_unavailable");
    return this.model(orgId, id, "chat");
  }
  resolveDecision(orgId: string, workspaceId: string) {
    const route = this.routing(workspaceId).decision;
    return route.enabled && route.modelId
      ? this.model(orgId, route.modelId, "decision")
      : undefined;
  }
  /** Passive access decision shared by execution inventory and action dispatch. */
  serviceAllowed(
    service: Pick<Service, "access">,
    workspace: string,
    actor: CatalogActor,
  ) {
    if (!service.access) return true;
    const roles = service.access.workspaceRoles.length
      ? this.workspaceRoles.forUser(workspace, actor.userId)
      : [];
    return (
      service.access.roles.includes(actor.role) ||
      service.access.workspaceRoles.some((id) => roles.includes(id))
    );
  }
  allowed(action: ServiceAction, actor: CatalogActor) {
    const row = this.db
      .prepare(
        "SELECT s.scope_id AS workspace, s.id AS service, s.data FROM agent_catalog a JOIN agent_catalog s ON s.id=a.scope_id AND s.kind='service' WHERE a.id=? AND a.kind='action'",
      )
      .get(action.id);
    if (!row) return false;
    const workspace = String(row.workspace);
    const service = ServiceSettings.parse(JSON.parse(String(row.data)));
    // Under the person's own account, the service gate decides who may connect
    // and the person decides which actions their assistant uses. Action role
    // grants and user overrides are the shared credential's policy.
    if (this.personalAction(workspace, String(row.service), action.effect))
      return (
        this.serviceAllowed(service, workspace, actor) &&
        this.personalPolicy.choice(
          workspace,
          String(row.service),
          actor.userId,
          action,
        ).enabled
      );
    const roles =
      action.policy.workspaceRoles?.length ||
      service.access?.workspaceRoles.length
        ? this.workspaceRoles.forUser(workspace, actor.userId)
        : [];
    if (
      service.access &&
      !service.access.roles.includes(actor.role) &&
      !service.access.workspaceRoles.some((id) => roles.includes(id))
    )
      return false;
    const user = action.policy.users.find((u) => u.userId === actor.userId);
    return user
      ? user.access === "allow"
      : action.policy.roles.includes(actor.role) ||
          !!action.policy.workspaceRoles?.some((id) => roles.includes(id));
  }
  /**
   * Whether this action runs under the person's own account, so that person
   * manages it (on/off and approval): every action of a service that needs
   * personal sign-in for everything, the writes of one that needs it for
   * changes. Everything else follows the shared, administrator-managed policy.
   */
  personalAction(
    workspaceId: string,
    serviceId: string,
    effect: "read" | "write",
  ) {
    const required = this.oauth?.requiredFor(workspaceId, serviceId) ?? "none";
    return required === "all" || (required === "writes" && effect === "write");
  }
  /** The person's own choice for a personal action; undefined for shared ones. */
  personalChoice(
    workspaceId: string,
    serviceId: string,
    action: Pick<ServiceAction, "id" | "effect">,
    userId: string,
  ): PersonalChoice | undefined {
    return this.personalAction(workspaceId, serviceId, action.effect)
      ? this.personalPolicy.choice(workspaceId, serviceId, userId, action)
      : undefined;
  }
  /** The action as it applies to this person: under their own account, the
   * approval they chose replaces the administrator's setting. */
  effectiveAction<T extends Pick<ServiceAction, "id" | "effect" | "approval">>(
    workspaceId: string,
    serviceId: string,
    action: T,
    userId: string,
  ): T {
    const choice = this.personalChoice(workspaceId, serviceId, action, userId);
    return choice ? { ...action, approval: choice.approval } : action;
  }
  /** Services with each action as it applies to this person. */
  servicesFor<T extends Pick<Service, "id" | "actions">>(
    workspaceId: string,
    services: T[],
    userId: string,
  ): T[] {
    return services.map((service) => ({
      ...service,
      actions: service.actions.map((action) =>
        this.effectiveAction(workspaceId, service.id, action, userId),
      ),
    }));
  }
  /** A stored service with each action as it applies to this person. */
  serviceFor(workspaceId: string, id: string, userId: string): Service {
    return this.servicesFor(
      workspaceId,
      [this.service(workspaceId, id)],
      userId,
    )[0]!;
  }
  /**
   * Whether the person may connect their own account to this service and
   * manage its actions: it is on, asks for personal sign-in, the service gate
   * lets them in and an administrator left at least one personal action on.
   * Their own switches do not hide it, so they can turn things back on.
   */
  mayConnect(workspaceId: string, service: Service, actor: CatalogActor) {
    return (
      service.enabled &&
      this.serviceAllowed(service, workspaceId, actor) &&
      service.actions.some(
        (action) =>
          action.enabled &&
          this.personalAction(workspaceId, service.id, action.effect),
      )
    );
  }
  /** What in this workspace's catalog can grant or limit what someone may run,
   * one fingerprint per entry. Names, descriptions, icons and revisions are left
   * out because they never change anyone's authority. A replaced credential
   * changes its sealed value. Never unseals a key. */
  authorityShape(orgId: string, workspaceId: string) {
    const cosmetic = new Set([
      "name",
      "description",
      "icon",
      "iconSource",
      "sourceKey",
    ]);
    const shape = new Map<string, string>();
    const add = (row: Row) => {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      shape.set(
        `${row.kind}:${row.id}`,
        JSON.stringify([
          row.scope_id,
          row.secret,
          Object.entries(data)
            .filter(([key]) => !cosmetic.has(key))
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ]),
      );
    };
    for (const service of this.rows(workspaceId, "service")) {
      add(service);
      for (const action of this.rows(service.id, "action")) add(action);
    }
    for (const row of this.rows(orgId, "provider")) add(row);
    for (const row of this.rows(orgId, "model")) add(row);
    const { revision: _revision, ...routing } = this.routing(workspaceId);
    shape.set(`routing:${workspaceId}`, JSON.stringify(routing));
    return shape;
  }
  inventory(orgId: string, workspaceId: string, actor: CatalogActor): Catalog {
    const manage = actor.role !== "member";
    return CatalogSchema.parse({
      organizationId: orgId,
      workspaceId,
      canManage: manage,
      services: this.rows(workspaceId, "service")
        .map((r) => this.service(workspaceId, r.id))
        .map((s) =>
          manage
            ? s
            : {
                ...s,
                actions: s.actions
                  .filter(
                    (a) => s.enabled && a.enabled && this.allowed(a, actor),
                  )
                  .map((a) => ({
                    ...this.effectiveAction(workspaceId, s.id, a, actor.userId),
                    policy: { roles: [], users: [] },
                  })),
              },
        )
        .filter((s) => manage || s.actions.length > 0),
      providers: manage
        ? this.rows(orgId, "provider").map(
            (r) => this.provider(orgId, r.id).provider,
          )
        : [],
      models: manage
        ? this.rows(orgId, "model").map((r) => this.readModel(orgId, r))
        : [],
      routing: manage
        ? this.routing(workspaceId)
        : { revision: 0, modelId: null, services: [] },
    });
  }
  /** Model IDs in the organization, for the process designer's own safe
   * projection. Never returns provider or credential data. */
  processModelIds(orgId: string) {
    return this.rows(orgId, "model").map((row) => row.id);
  }
  /** Internal source projection for a detached test store. Never unseals any key. */
  processTestCatalog(
    orgId: string,
    workspaceId: string,
    actor: CatalogActor,
    sources: ProcessSourceManifest,
    genericModelId?: string,
  ) {
    // Callers authorize the process (a member only for their personal one);
    // the projection carries the actor's real role and grants.
    if (this.workspaceOrganization(workspaceId) !== orgId)
      throw new IdentityError(403, "identity_forbidden");
    const sourceRows = sources.resources.map((resource) => {
      const scope =
        resource.kind === "action"
          ? this.db
              .prepare(
                "SELECT scope_id FROM agent_catalog WHERE id=? AND kind='action'",
              )
              .get(resource.id)?.scope_id
          : resource.kind === "service"
            ? workspaceId
            : orgId;
      if (typeof scope !== "string")
        throw new IdentityError(409, "process_sources_changed");
      const row = this.row(scope, resource.kind, resource.id);
      if (row.revision !== resource.revision)
        throw new IdentityError(409, "process_sources_changed");
      return row;
    });
    if (
      genericModelId &&
      !sourceRows.some((r) => r.kind === "model" && r.id === genericModelId)
    ) {
      const modelRow = this.row(orgId, "model", genericModelId);
      const model = this.readModel(orgId, modelRow);
      sourceRows.push(modelRow);
      if (
        !sourceRows.some(
          (r) => r.kind === "provider" && r.id === model.providerId,
        )
      )
        sourceRows.push(this.row(orgId, "provider", model.providerId));
    }
    const actions = sourceRows.filter((row) => row.kind === "action");
    const services = sourceRows
      .filter((row) => row.kind === "service")
      .map((row) => {
        const service = ServiceSchema.parse({
          ...this.dto(row),
          hasCredential: false,
          modelId: null,
          actions: [],
        });
        return {
          id: service.id,
          revision: service.revision,
          name: service.name,
          enabled: service.enabled,
          protocol: service.protocol,
          ...(service.access ? { access: service.access } : {}),
          actions: actions
            .filter((a) => a.scope_id === row.id)
            .map((a) => {
              const action = ServiceActionSchema.parse(this.dto(a));
              const { sourceKey: _sourceKey, ...value } = action;
              // Under a personal account the test assumes the service gate is
              // the only grant and every change is confirmed. The person's own
              // switches are checked on every run, so changing them never
              // invalidates a tested version.
              return this.personalAction(workspaceId, service.id, value.effect)
                ? {
                    ...value,
                    approval:
                      value.effect === "write"
                        ? ("always" as const)
                        : ("never" as const),
                    policy: {
                      roles: [],
                      workspaceRoles: [],
                      users: [
                        { userId: actor.userId, access: "allow" as const },
                      ],
                    },
                  }
                : value;
            }),
        };
      });
    if (actions.some((a) => !services.some((s) => s.id === a.scope_id)))
      throw new IdentityError(409, "process_sources_changed");
    return ProcessTestCatalogSchema.parse({
      organizationId: orgId,
      workspaceId,
      userId: actor.userId,
      role: actor.role,
      workspaceRoles: this.workspaceRoles.forUser(workspaceId, actor.userId),
      services,
      models: sourceRows
        .filter((r) => r.kind === "model")
        .map((r) => this.readModel(orgId, r)),
      providers: sourceRows
        .filter((r) => r.kind === "provider")
        .map((r) => {
          const p = ProviderSchema.parse({
            ...this.dto(r),
            hasCredential: false,
            requestsToday: 0,
          });
          return {
            id: p.id,
            revision: p.revision,
            enabled: p.enabled,
            dailyRequestLimit: p.dailyRequestLimit,
          };
        }),
      budget: this.inferenceBudget.policy(orgId, workspaceId).settings,
      budgetRevision: this.inferenceBudget.policy(orgId, workspaceId).revision,
    });
  }
  private members(orgId: string, action: z.infer<typeof ServiceActionSchema>) {
    for (const user of action.policy.users)
      if (
        !this.db
          .prepare(
            'SELECT id FROM member WHERE "organizationId"=? AND "userId"=?',
          )
          .get(orgId, user.userId)
      )
        throw new IdentityError(400, "catalog_user_invalid");
  }
  private validateBinding(
    service: Service,
    action: z.infer<typeof ServiceActionSchema>,
  ) {
    schemaValidator(action.inputSchema);
    if ((service.protocol === "mcp") !== (action.binding.type === "mcp"))
      throw new IdentityError(400, "catalog_binding_invalid");
    if (action.binding.type === "http") {
      if (
        action.binding.path.split("/").some((p) => [".", ".."].includes(p)) ||
        /%2e|%2f|%5c/i.test(action.binding.path)
      )
        throw new IdentityError(400, "catalog_binding_invalid");
      if (action.binding.method !== "GET" && action.effect === "read")
        throw new IdentityError(400, "catalog_effect_invalid");
    }
  }
  /** Saved processes that belong to the service, or whose draft or active
   * version calls one of its actions. */
  private serviceInUse(workspaceId: string, serviceId: string) {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_service_process'",
        )
        .get()
    )
      return false;
    const reference = `"serviceId":${JSON.stringify(serviceId)}`;
    // Personal processes do not hold workspace configuration hostage: they
    // revalidate on every run and fail closed once the service is gone.
    const personal = this.db
      .prepare("PRAGMA table_info(agent_service_process)")
      .all()
      .some((column) => column.name === "owner_user_id");
    return !!this.db
      .prepare(
        `SELECT 1 FROM agent_service_process p WHERE p.workspace_id=?
          ${personal ? "AND p.owner_type<>'user'" : ""} AND (
          p.service_id=? OR instr(p.draft,?)>0 OR EXISTS (
            SELECT 1 FROM agent_service_process_version v
            WHERE v.process_id=p.id AND v.version=p.active_version AND instr(v.definition,?)>0
          )) LIMIT 1`,
      )
      .get(workspaceId, serviceId, reference, reference);
  }
  command(input: z.infer<typeof CatalogCommand>) {
    const { organizationId: org, workspaceId: ws } = input;
    switch (input.type) {
      case "saveService": {
        validateEndpoint(input.settings.url, this.trustedOrigins);
        this.workspaceRoles.validate(ws, input.settings.access?.workspaceRoles);
        if (!input.id && this.rows(ws, "service").length >= 100)
          throw new IdentityError(409, "identity_limit");
        if (
          input.id &&
          this.service(ws, input.id).protocol !== input.settings.protocol &&
          this.rows(input.id, "action").length
        )
          throw new IdentityError(409, "catalog_protocol_locked");
        if (
          input.settings.auth.type !== "none" &&
          !input.apiKey &&
          (!input.id || !this.credential(ws, input.id))
        )
          throw new IdentityError(400, "catalog_key_required");
        return this.save(
          ws,
          "service",
          input.id,
          input.revision,
          {
            ...input.settings,
            access:
              input.settings.access ??
              (input.id ? this.service(ws, input.id).access : undefined),
          },
          input.settings.auth.type === "none" ? "" : input.apiKey,
        );
      }
      case "removeService":
        // Processes owned by or calling this service would silently stop
        // working; they must be deleted or changed first.
        if (this.serviceInUse(ws, input.id))
          throw new IdentityError(409, "catalog_service_in_use");
        this.remove(ws, "service", input.id, input.revision);
        this.db
          .prepare(
            "DELETE FROM agent_catalog WHERE scope_id=? AND kind='action'",
          )
          .run(input.id);
        this.personalPolicy.removeService(ws, input.id);
        this.cleanRouting(ws, input.id);
        return input.id;
      case "saveAction": {
        const service = this.service(ws, input.serviceId);
        this.check(this.row(ws, "service", service.id), input.serviceRevision);
        if (!input.id && service.actions.length >= 1000)
          throw new IdentityError(409, "identity_limit");
        const previous = input.id
          ? ServiceActionSchema.parse(
              this.dto(this.row(service.id, "action", input.id)),
            )
          : undefined;
        const action = {
          ...input.settings,
          id: input.id ?? "new",
          revision: input.revision,
          sourceKey: previous?.sourceKey ?? null,
        };
        this.validateBinding(service, action);
        this.members(org, action);
        this.workspaceRoles.validate(ws, action.policy.workspaceRoles);
        const id = this.save(service.id, "action", input.id, input.revision, {
          ...input.settings,
          sourceKey: action.sourceKey,
        });
        this.bump(service.id);
        return id;
      }
      case "updateActions": {
        const service = this.service(ws, input.serviceId);
        this.check(this.row(ws, "service", service.id), input.serviceRevision);
        // Validate the complete selection before writing. The controller also wraps
        // this command, policy invalidation and its audit entry in one transaction.
        const updates = input.actions.map(({ id, revision }) => {
          const row = this.row(service.id, "action", id);
          this.check(row, revision);
          const previous = ServiceActionSchema.parse(this.dto(row));
          const { id: _id, revision: _revision, ...settings } = previous;
          const next = {
            ...settings,
            ...(input.patch.enabled !== undefined
              ? { enabled: input.patch.enabled }
              : {}),
            ...(input.patch.approval !== undefined
              ? { approval: input.patch.approval }
              : {}),
            ...(input.patch.effect !== undefined
              ? { effect: input.patch.effect }
              : {}),
            policy: {
              ...settings.policy,
              roles: input.patch.roles ?? settings.policy.roles,
              workspaceRoles:
                input.patch.workspaceRoles ?? settings.policy.workspaceRoles,
            },
          };
          this.validateBinding(service, { ...next, id, revision });
          this.workspaceRoles.validate(ws, next.policy.workspaceRoles);
          return { id, revision, settings: next };
        });
        for (const update of updates)
          this.save(
            service.id,
            "action",
            update.id,
            update.revision,
            update.settings,
          );
        this.bump(service.id);
        return service.id;
      }
      case "removeAction":
        this.check(
          this.row(ws, "service", input.serviceId),
          input.serviceRevision,
        );
        this.remove(input.serviceId, "action", input.id, input.revision);
        this.personalPolicy.removeAction(ws, input.serviceId, input.id);
        this.bump(input.serviceId);
        return input.id;
      case "saveProvider":
        validateEndpoint(input.settings.url, this.trustedOrigins);
        if (!input.id && this.rows(org, "provider").length >= 50)
          throw new IdentityError(409, "identity_limit");
        return this.save(
          org,
          "provider",
          input.id,
          input.revision,
          input.settings,
          input.apiKey,
        );
      case "removeProvider": {
        const models = this.rows(org, "model").filter(
          (r) => this.dto(r).providerId === input.id,
        );
        if (models.length)
          throw new IdentityError(409, "catalog_provider_in_use");
        this.remove(org, "provider", input.id, input.revision);
        return input.id;
      }
      case "importModels": {
        this.check(
          this.row(org, "provider", input.providerId),
          input.providerRevision,
        );
        const current = this.rows(org, "model");
        const existing = new Set(
          current
            .filter((r) => this.dto(r).providerId === input.providerId)
            .map((r) => this.dto(r).model),
        );
        const additions = input.models.filter((m) => !existing.has(m.model));
        if (current.length + additions.length > 500)
          throw new IdentityError(409, "identity_limit");
        for (const model of additions)
          this.save(
            org,
            "model",
            undefined,
            0,
            this.normalizeModel(org, {
              ...model,
              providerId: input.providerId,
              enabled: true,
            }),
          );
        return input.providerId;
      }
      case "saveModel":
        this.row(org, "provider", input.settings.providerId);
        if (!input.id && this.rows(org, "model").length >= 500)
          throw new IdentityError(409, "identity_limit");
        if (
          this.rows(org, "model").some(
            (r) =>
              r.id !== input.id &&
              this.dto(r).model === input.settings.model &&
              this.dto(r).providerId === input.settings.providerId,
          )
        )
          throw new IdentityError(409, "catalog_model_exists");
        return this.save(
          org,
          "model",
          input.id,
          input.revision,
          this.normalizeModel(org, input.settings),
        );
      case "removeModel": {
        for (const row of this.db
          .prepare(
            "SELECT r.* FROM agent_catalog_routing r JOIN agent_workspace w ON w.id=r.workspace_id WHERE w.organization_id=?",
          )
          .all(org)) {
          const route = Routing.parse({
            revision: row.revision,
            ...JSON.parse(String(row.data)),
          });
          if (
            route.modelId === input.id ||
            route.voiceModelId === input.id ||
            route.meetingTranscriptionModelId === input.id ||
            route.speech.modelId === input.id ||
            route.decision.modelId === input.id ||
            route.services.some((s) => s.modelId === input.id)
          )
            throw new IdentityError(409, "catalog_model_in_use");
        }
        this.remove(org, "model", input.id, input.revision);
        return input.id;
      }
      case "saveRouting": {
        if (this.routing(ws).revision !== input.routing.revision)
          throw new IdentityError(409, "catalog_conflict");
        if (input.routing.modelId) this.model(org, input.routing.modelId);
        if (
          input.routing.voiceMode === "catalog" &&
          !input.routing.voiceModelId
        )
          throw new IdentityError(409, "catalog_model_required");
        if (input.routing.voiceModelId)
          this.model(
            org,
            input.routing.voiceModelId,
            input.routing.voiceMethod === "transcription"
              ? "transcription"
              : "audioInput",
          );
        if (input.routing.meetingTranscriptionModelId)
          this.model(
            org,
            input.routing.meetingTranscriptionModelId,
            "transcription",
          );
        if (input.routing.speech.modelId)
          this.model(
            org,
            input.routing.speech.modelId,
            input.routing.speech.method === "reader" ? "audioOutput" : "speech",
          );
        if (
          input.routing.decision.enabled &&
          (!input.routing.decision.modelId || !input.routing.modelId)
        )
          throw new IdentityError(409, "catalog_model_required");
        if (input.routing.decision.modelId)
          this.model(org, input.routing.decision.modelId, "decision");
        if (
          new Set(input.routing.services.map((s) => s.serviceId)).size !==
          input.routing.services.length
        )
          throw new IdentityError(400, "catalog_binding_invalid");
        for (const s of input.routing.services) {
          this.row(ws, "service", s.serviceId);
          if (s.modelId) this.model(org, s.modelId);
        }
        this.db
          .prepare(
            "INSERT INTO agent_catalog_routing VALUES (?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
          )
          .run(
            ws,
            input.routing.revision + 1,
            JSON.stringify({
              modelId: input.routing.modelId,
              voiceModelId: input.routing.voiceModelId,
              voiceMode: input.routing.voiceMode,
              voiceMethod: input.routing.voiceMethod,
              meetingTranscriptionModelId:
                input.routing.meetingTranscriptionModelId,
              decision: input.routing.decision,
              planner: input.routing.planner,
              speech: input.routing.speech,
              services: input.routing.services,
            }),
          );
        return ws;
      }
    }
  }
  private cleanRouting(ws: string, serviceId: string) {
    // Keep every routing setting (including the planner); only drop the service.
    const { revision: _revision, ...route } = this.routing(ws);
    this.db
      .prepare(
        "UPDATE agent_catalog_routing SET revision=revision+1,data=? WHERE workspace_id=?",
      )
      .run(
        JSON.stringify({
          ...route,
          services: route.services.filter((s) => s.serviceId !== serviceId),
        }),
        ws,
      );
  }
  private bump(id: string) {
    this.db
      .prepare("UPDATE agent_catalog SET revision=revision+1 WHERE id=?")
      .run(id);
  }
  importActions(
    ws: string,
    serviceId: string,
    revision: number,
    actions: DiscoveredAction[],
  ) {
    const service = this.service(ws, serviceId);
    if (service.revision !== revision)
      throw new IdentityError(409, "catalog_conflict");
    let added = 0,
      existing = 0;
    for (const action of actions) {
      if (service.actions.some((a) => a.sourceKey === action.sourceKey)) {
        existing++;
        continue;
      }
      if (service.actions.length + added >= 1000)
        throw new IdentityError(409, "identity_limit");
      this.validateBinding(service, { ...action, id: "new", revision: 0 });
      this.save(serviceId, "action", undefined, 0, {
        ...action,
        enabled: false,
        approval: "always",
        policy: { roles: [], users: [] },
      });
      added++;
    }
    if (added) this.bump(serviceId);
    return { added, existing };
  }
  authorize(
    ws: string,
    serviceId: string,
    serviceRevision: number,
    actionId: string,
    revision: number,
    actor: CatalogActor,
    allowExpired = false,
  ) {
    const service = this.service(ws, serviceId),
      action = service.actions.find((a) => a.id === actionId);
    if (!action) throw new IdentityError(404, "catalog_not_found");
    if (service.revision !== serviceRevision || action.revision !== revision)
      throw new IdentityError(409, "catalog_conflict");
    if (!service.enabled || !action.enabled || !this.allowed(action, actor))
      throw new IdentityError(403, "catalog_action_denied");
    // The approval that applies is this person's own choice under their account.
    const effective = this.effectiveAction(ws, serviceId, action, actor.userId);
    const personal = this.personal(
      ws,
      service,
      action.effect,
      actor,
      allowExpired,
    );
    // A personal call never falls back to the shared key, and an approval pinned to one
    // account never silently runs under another (executionPin).
    return personal
      ? {
          service: { ...service, auth: { type: "bearer" as const } },
          action: effective,
          key: personal.accessToken,
          executionPin: personal.pin,
        }
      : {
          service,
          action: effective,
          key: this.credential(ws, serviceId),
          executionPin: undefined,
        };
  }
  /** The person's own service account when the service requires it for this effect. */
  private personal(
    ws: string,
    service: { id: string; name: string },
    effect: "read" | "write",
    actor: CatalogActor,
    allowExpired: boolean,
  ): { accessToken: string; pin: ServiceOAuthPin } | undefined {
    if (!this.oauth) return undefined;
    const target = this.oauthTarget(ws, service.id);
    const settings = this.oauth.config(target).settings;
    const gated =
      settings.requiredFor === "all" ||
      (settings.requiredFor === "writes" && effect === "write");
    if (!gated) return undefined;
    let provider: ServiceOAuthPin["authProvider"];
    try {
      if (settings.authProviderId) {
        if (!this.authProviders)
          throw new IdentityError(403, "auth_provider_unavailable");
        provider = this.authProviders.assertLinked(
          this.workspaceOrganization(ws),
          actor.userId,
          settings.authProviderId,
        );
      }
      const resolved = this.oauth.resolve(
        target,
        actor.userId,
        effect,
        allowExpired,
      );
      if (resolved.kind !== "personal") return undefined;
      return {
        accessToken: resolved.accessToken,
        pin: {
          ...resolved.pin,
          ...(provider ? { authProvider: provider } : {}),
        },
      };
    } catch (error) {
      if (
        error instanceof IdentityError &&
        [
          "service_oauth_connection_required",
          "service_oauth_reconnect_required",
          "auth_provider_unavailable",
          "auth_provider_link_required",
        ].includes(error.code)
      )
        throw new ServiceConnectionRequired(service.id, service.name);
      throw error;
    }
  }

  oauthTarget(workspaceId: string, serviceId: string) {
    const service = this.service(workspaceId, serviceId);
    return {
      workspaceId,
      serviceId,
      serviceUrl: service.url,
      serviceRevision: service.revision,
    };
  }
  workspaceOrganization(workspaceId: string) {
    const row = this.db
      .prepare("SELECT organization_id FROM agent_workspace WHERE id=?")
      .get(workspaceId);
    if (!row) throw new IdentityError(404, "identity_not_found");
    return String(row.organization_id);
  }
  assertExecutionPin(value: StoredInvocation, pin?: ServiceOAuthPin) {
    if (JSON.stringify(value.executionPin) !== JSON.stringify(pin))
      throw new IdentityError(409, "service_oauth_conflict");
  }
  invocation(id: string, ws: string, userId: string) {
    const row = this.db
      .prepare(
        "SELECT data FROM agent_service_invocation WHERE id=? AND workspace_id=? AND user_id=?",
      )
      .get(id, ws, userId);
    return row ? (JSON.parse(String(row.data)) as StoredInvocation) : undefined;
  }
  saveInvocation(value: StoredInvocation) {
    this.db
      .prepare(
        "INSERT INTO agent_service_invocation VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(value.id, value.workspaceId, value.userId, JSON.stringify(value));
  }
  /** Receipt replay is passive; reusing source data for NEW work requires current access. */
  contactSource(
    id: string,
    organizationId: string,
    workspaceId: string,
    actor: CatalogActor,
    maxAge?: number,
  ) {
    const value = this.invocation(id, workspaceId, actor.userId);
    const age = Date.now() - (value?.completedAt ?? NaN);
    if (
      !value ||
      value.id !== id ||
      value.organizationId !== organizationId ||
      value.workspaceId !== workspaceId ||
      value.userId !== actor.userId ||
      value.effect !== "read" ||
      value.status !== "succeeded" ||
      !Number.isFinite(age) ||
      age < 0 ||
      (maxAge !== undefined && age > maxAge)
    )
      throw new IdentityError(409, "catalog_conflict");
    const authorized = this.authorize(
      workspaceId,
      value.serviceId,
      value.serviceRevision,
      value.actionId,
      value.actionRevision,
      actor,
    );
    this.assertExecutionPin(value, authorized.executionPin);
    return value;
  }
  prepare(
    input: z.infer<typeof ActionInvokeRequest>,
    actor: CatalogActor,
    policyRevision: number,
    contactSource?: string,
    dependencies: string[] = [],
  ) {
    const old = this.invocation(
      input.requestId,
      input.workspaceId,
      actor.userId,
    );
    if (old) {
      if (
        old.organizationId !== input.organizationId ||
        old.serviceId !== input.serviceId ||
        old.actionId !== input.actionId ||
        JSON.stringify(old.input) !== JSON.stringify(input.input) ||
        old.serviceRevision !== input.serviceRevision ||
        old.actionRevision !== input.revision ||
        old.contactSource !== contactSource ||
        JSON.stringify(old.dependencies ?? []) !== JSON.stringify(dependencies)
      )
        throw new IdentityError(409, "catalog_conflict");
      // Recovery is a read of this user's existing receipt, never a new dispatch.
      if (old.status !== "awaiting_approval") return old;
      if (old.policyRevision !== policyRevision)
        throw new IdentityError(409, "catalog_conflict");
    }
    const authorized = this.authorize(
      input.workspaceId,
      input.serviceId,
      input.serviceRevision,
      input.actionId,
      input.revision,
      actor,
    );
    for (const source of dependencies)
      this.contactSource(
        source,
        input.organizationId,
        input.workspaceId,
        actor,
        old ? undefined : 30 * 60 * 1000,
      );
    if (contactSource)
      this.contactSource(
        contactSource,
        input.organizationId,
        input.workspaceId,
        actor,
      );
    validateArguments(authorized.action.inputSchema, input.input);
    if (old) {
      this.assertExecutionPin(old, authorized.executionPin);
      return old;
    }
    if (
      this.db
        .prepare("SELECT id FROM agent_service_invocation WHERE id=?")
        .get(input.requestId)
    )
      throw new IdentityError(409, "catalog_conflict");
    const pending = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM agent_service_invocation WHERE workspace_id=? AND user_id=? AND json_extract(data,'$.status')='awaiting_approval'",
      )
      .get(input.workspaceId, actor.userId)!;
    if (Number(pending.count) >= 10)
      throw new IdentityError(409, "catalog_pending_limit");
    const value: StoredInvocation = {
      id: input.requestId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      userId: actor.userId,
      serviceId: input.serviceId,
      actionId: input.actionId,
      serviceRevision: input.serviceRevision,
      actionRevision: input.revision,
      policyRevision,
      ...(authorized.executionPin
        ? { executionPin: authorized.executionPin }
        : {}),
      ...(contactSource ? { contactSource } : {}),
      ...(dependencies.length ? { dependencies } : {}),
      input: input.input,
      status:
        authorized.action.approval === "always"
          ? "awaiting_approval"
          : "running",
      title: authorized.action.name,
      serviceName: authorized.service.name,
      effect: authorized.action.effect,
    };
    this.saveInvocation(value);
    return value;
  }
  turn(id: string, workspaceId: string, userId: string) {
    const row = this.db
      .prepare(
        "SELECT data FROM agent_service_turn WHERE id=? AND workspace_id=? AND user_id=?",
      )
      .get(id, workspaceId, userId);
    return row ? (JSON.parse(String(row.data)) as unknown) : undefined;
  }
  nativeTurns(workspaceId: string, userId: string) {
    return this.db
      .prepare(
        "SELECT data FROM agent_service_turn WHERE workspace_id=? AND user_id=? AND json_extract(data, '$.kind')='mastra-1' AND json_extract(data, '$.runId')=id ORDER BY (json_type(data, '$.pending') IS NOT NULL) DESC, rowid DESC LIMIT 400",
      )
      .all(workspaceId, userId)
      .map((row) => JSON.parse(String(row.data)) as unknown);
  }
  /** Passive descriptors only; overflow cannot prove a unique outstanding origin. */
  legacyQuestionTurns(
    scope: Pick<Scope, "serverId" | "workspaceId" | "userId">,
  ) {
    const rows = this.db
      .prepare(
        `WITH bindings AS (
          SELECT json_extract(data,'$.legacyQuestion.turnId') AS turn_id,
            count(*) AS roots,min(id) AS root_id,min(data) AS root_data
          FROM agent_service_turn WHERE workspace_id=? AND user_id=?
          AND json_extract(data,'$.kind')='mastra-1' AND json_extract(data,'$.runId')=id
          AND json_type(data,'$.legacyQuestion') IS NOT NULL
          GROUP BY json_extract(data,'$.legacyQuestion.turnId')
        ) SELECT t.id,json_extract(t.data,'$.commandId') AS command_id
        FROM agent_service_turn t LEFT JOIN bindings b ON b.turn_id=t.id
        WHERE t.workspace_id=? AND t.user_id=? AND (
          (json_extract(t.data,'$.kind')='agent-1' AND (
            (json_extract(t.data,'$.paused') IS NOT NULL AND
             json_extract(t.data,'$.paused')<>0 AND json_extract(t.data,'$.paused')<>'') OR
            json_type(t.data,'$.working.question') IS NOT NULL)) OR
          (json_extract(t.data,'$.kind')='progressive-1' AND (
            json_extract(t.data,'$.pendingInput') IS NOT NULL AND
            json_extract(t.data,'$.pendingInput')<>0 AND
            json_extract(t.data,'$.pendingInput')<>'')))
        AND (b.roots IS NULL OR b.roots<>1 OR
          niaro_legacy_question_consumed(b.root_id,b.root_data,t.id,t.data,?,?,?)=0)
        ORDER BY t.rowid DESC LIMIT 401`,
      )
      .all(
        scope.workspaceId,
        scope.userId,
        scope.workspaceId,
        scope.userId,
        scope.serverId,
        scope.workspaceId,
        scope.userId,
      );
    if (rows.length > 400)
      throw new IdentityError(409, "legacy_context_unavailable");
    return rows.map((row) => ({
      id: String(row.id),
      commandId:
        typeof row.command_id === "string" ? row.command_id : undefined,
    }));
  }
  /** Invalid binding status cannot disappear behind the pending/accepted filter. */
  pendingLegacyQuestionRoots(
    workspaceId: string,
    userId: string,
    conversationId: string,
    turnId?: string,
  ) {
    return this.db
      .prepare(
        "SELECT id,data FROM agent_service_turn WHERE workspace_id=? AND user_id=? AND json_extract(data,'$.kind')='mastra-1' AND json_extract(data,'$.runId')=id AND json_type(data,'$.legacyQuestion') IS NOT NULL AND json_extract(data,'$.legacyQuestion.decision') IS NOT 'accepted' AND (json_extract(data,'$.conversationId')=? OR json_extract(data,'$.legacyQuestion.turnId')=?) LIMIT 2",
      )
      .all(workspaceId, userId, conversationId, turnId ?? null)
      .map((row) => {
        const origin = LegacyQuestionSchema.safeParse(
          JSON.parse(String(row.data)).legacyQuestion,
        );
        if (!origin.success || origin.data.decision !== "pending")
          throw new IdentityError(409, "legacy_context_unavailable");
        return String(row.id);
      });
  }
  /** Singleton origin binding lives in the existing native command journal. */
  legacyQuestionRoot(turnId: string, workspaceId: string, userId: string) {
    const rows = this.db
      .prepare(
        "SELECT id,data FROM agent_service_turn WHERE workspace_id=? AND user_id=? AND json_extract(data,'$.kind')='mastra-1' AND json_extract(data,'$.runId')=id AND json_extract(data,'$.legacyQuestion.turnId')=? LIMIT 2",
      )
      .all(workspaceId, userId, turnId);
    if (rows.length > 1) throw new IdentityError(409, "catalog_conflict");
    if (!rows[0]) return undefined;
    const origin = LegacyQuestionSchema.safeParse(
      JSON.parse(String(rows[0].data)).legacyQuestion,
    );
    if (!origin.success)
      throw new IdentityError(409, "legacy_context_unavailable");
    return origin.data.decision === "accepted" ? String(rows[0].id) : undefined;
  }
  /** One authoritative window. Internal process test/console runs have no public admission. */
  taskRoots(
    scope: import("../../packages/protocol").Scope,
    organizationId: string,
  ): NativeTaskRoot[] {
    return this.db
      .prepare(
        `SELECT t.id,t.data,json_extract(t.data,'$.kind') AS kind
      FROM agent_service_turn t WHERE t.workspace_id=? AND t.user_id=? AND (
        (json_extract(t.data,'$.kind')='mastra-1' AND json_extract(t.data,'$.runId')=t.id
          AND json_type(t.data,'$.conversationId')='text' AND (
            json_extract(t.data,'$.taskTracked')=1 OR json_type(t.data,'$.pending') IS NOT NULL
            OR json_array_length(t.data,'$.operations')>0 OR json_extract(t.data,'$.answeredQuestion')=1)) OR
        (json_extract(t.data,'$.kind')='service-process-1' AND EXISTS (
          SELECT 1 FROM agent_process_start_command c WHERE c.run_id=t.id
          AND json_extract(c.data,'$.scope.connectionId')=?
          AND json_extract(c.data,'$.scope.serverId')=?
          AND json_extract(c.data,'$.actor.organizationId')=?)))
      ORDER BY (json_type(t.data,'$.pending') IS NOT NULL) DESC,t.rowid DESC LIMIT 400`,
      )
      .all(
        scope.workspaceId,
        scope.userId,
        scope.connectionId,
        scope.serverId,
        organizationId,
      )
      .map((row) => ({
        id: String(row.id),
        kind: row.kind as NativeTaskRoot["kind"],
        value: JSON.parse(String(row.data)),
      }));
  }
  selectTurn(
    id: string,
    workspaceId: string,
    userId: string,
    serverId?: string,
  ) {
    this.db
      .prepare(
        "INSERT INTO agent_service_task_selection VALUES (?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET turn_id=excluded.turn_id",
      )
      .run(workspaceId, userId, id);
    this.rememberTurn(id, workspaceId, userId, serverId);
  }
  selectedTurn(workspaceId: string, userId: string, conversationId?: string) {
    const id = this.db
      .prepare(
        "SELECT turn_id FROM agent_service_task_selection WHERE workspace_id=? AND user_id=?",
      )
      .get(workspaceId, userId)?.turn_id;
    if (conversationId !== undefined && id) {
      const value = this.turn(String(id), workspaceId, userId) as
        | { conversationId?: string }
        | undefined;
      if (value?.conversationId !== conversationId) return undefined;
    }
    return id;
  }
  rememberTurn(
    id: string,
    workspaceId: string,
    userId: string,
    serverId?: string,
  ) {
    this.db
      .prepare(
        "INSERT INTO agent_service_turn_cursor VALUES (?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET turn_id=excluded.turn_id",
      )
      .run(workspaceId, userId, id);
    const value = this.turn(id, workspaceId, userId) as
      | { conversationId?: string }
      | undefined;
    if (value?.conversationId && serverId)
      this.db
        .prepare(
          "INSERT INTO agent_service_conversation_cursor VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,user_id,server_id,conversation_id) DO UPDATE SET turn_id=excluded.turn_id",
        )
        .run(workspaceId, userId, serverId, value.conversationId, id);
  }
  /** Every native thread a person's chat ran on, for forgetting a deleted chat. */
  conversationThreads(
    workspaceId: string,
    userId: string,
    conversationId: string,
  ) {
    return [
      ...new Set(
        this.db
          .prepare(
            "SELECT json_extract(data,'$.threadId') AS thread FROM agent_service_turn WHERE workspace_id=? AND user_id=? AND json_extract(data,'$.kind')='mastra-1' AND json_extract(data,'$.conversationId')=?",
          )
          .all(workspaceId, userId, conversationId)
          .flatMap((row) =>
            typeof row.thread === "string" ? [row.thread] : [],
          ),
      ),
    ];
  }
  latestTurn(
    workspaceId: string,
    userId: string,
    conversationId?: string,
    serverId?: string,
    conversationSession?: string,
  ) {
    if (conversationId !== undefined && serverId) {
      let selected = this.db
        .prepare(
          "SELECT turn_id FROM agent_service_conversation_cursor WHERE workspace_id=? AND user_id=? AND server_id=? AND conversation_id=?",
        )
        .get(workspaceId, userId, serverId, conversationId);
      if (selected && conversationSession !== undefined) {
        const state = this.turn(
          String(selected.turn_id),
          workspaceId,
          userId,
        ) as { conversationSession?: string } | undefined;
        if (state?.conversationSession !== conversationSession)
          selected = undefined;
      }
      const fallback =
        selected ??
        this.db
          .prepare(
            "SELECT id AS turn_id,data FROM agent_service_turn WHERE workspace_id=? AND user_id=? AND json_extract(data,'$.conversationId')=? AND json_extract(data,'$.kind')='mastra-1' AND json_extract(data,'$.runId')=id ORDER BY rowid DESC",
          )
          .all(workspaceId, userId, conversationId)
          .find((row) => {
            const state = JSON.parse(String(row.data)) as {
              aliases?: { commandId: string }[];
              conversationSession?: string;
            };
            const commandId = state.aliases?.[0]?.commandId;
            return (
              !!commandId &&
              (conversationSession === undefined ||
                state.conversationSession === conversationSession) &&
              createHash("sha256")
                .update(
                  JSON.stringify([serverId, workspaceId, userId, commandId]),
                )
                .digest("hex") === row.turn_id
            );
          });
      return fallback
        ? {
            id: String(fallback.turn_id),
            value: this.turn(String(fallback.turn_id), workspaceId, userId),
          }
        : undefined;
    }
    const row = this.db
      .prepare(
        "SELECT turn_id FROM agent_service_turn_cursor WHERE workspace_id=? AND user_id=?",
      )
      .get(workspaceId, userId);
    return row
      ? {
          id: String(row.turn_id),
          value: this.turn(String(row.turn_id), workspaceId, userId),
        }
      : undefined;
  }
  linkTurnOperation(
    turnId: string,
    operationId: string,
    workspaceId: string,
    userId: string,
  ) {
    this.db
      .prepare(
        "INSERT INTO agent_service_turn_operation VALUES (?,?,?,?) ON CONFLICT(operation_id) DO NOTHING",
      )
      .run(operationId, turnId, workspaceId, userId);
  }
  turnForOperation(operationId: string, workspaceId: string, userId: string) {
    const row = this.db
      .prepare(
        "SELECT turn_id FROM agent_service_turn_operation WHERE operation_id=? AND workspace_id=? AND user_id=?",
      )
      .get(operationId, workspaceId, userId);
    // Historical process receipts predate explicit operation links. Their canonical
    // journal remains authority; never expose them to the legacy unlinked approval path.
    const historical = row
      ? []
      : this.db
          .prepare(
            `SELECT t.id FROM agent_service_turn t, json_each(t.data,'$.operations') op
       WHERE t.workspace_id=? AND t.user_id=? AND json_extract(t.data,'$.kind')='service-process-1'
       AND op.value=? LIMIT 2`,
          )
          .all(workspaceId, userId, operationId);
    if (historical.length > 1) throw new IdentityError(409, "catalog_conflict");
    const turnId = row
      ? String(row.turn_id)
      : historical[0]
        ? String(historical[0].id)
        : undefined;
    return turnId
      ? {
          id: turnId,
          value: this.turn(turnId, workspaceId, userId),
        }
      : undefined;
  }
  saveTurn(id: string, workspaceId: string, userId: string, value: unknown) {
    const existing = this.db
      .prepare("SELECT workspace_id,user_id FROM agent_service_turn WHERE id=?")
      .get(id);
    if (
      existing &&
      (existing.workspace_id !== workspaceId || existing.user_id !== userId)
    )
      throw new IdentityError(409, "catalog_conflict");
    this.db
      .prepare(
        "INSERT INTO agent_service_turn VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(id, workspaceId, userId, JSON.stringify(value));
  }
}
