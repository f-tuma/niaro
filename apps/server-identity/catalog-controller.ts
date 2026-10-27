import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ActionInvokeRequest,
  CatalogCommand,
  CatalogTarget,
  DiscoveryRequest,
  ModelDiscoveryRequest,
  ServiceIconRequest,
  ServiceProbeRequest,
  PersonalServiceCommand,
  type PersonalServiceCommandValue,
  PersonalActionChoices,
  PersonalServiceList,
  PERSONAL_SERVICES_LIMIT,
  twentyReadTool,
} from "../../packages/protocol/service-catalog";
import { ServiceCatalogStore, type CatalogActor } from "./service-catalog";
import { InferenceBudgetCommandSchema } from "../../packages/protocol/inference-budget";
import { IdentityError } from "./error";
import {
  authHeaders,
  discoverOpenAPI,
  invokeAction,
  McpSession,
  type DiscoveredAction,
} from "../server-integrations/discovery";
import {
  IntegrationError,
  jsonResponse,
  sameEndpoint,
  validateEndpoint,
  type IntegrationTransport,
} from "../server-integrations/transport";
import { listModels } from "../server-integrations/models";
import { createNiaroMastraModel } from "../server-integrations/mastra-model";
import {
  ACTION_LABEL_BATCH,
  enrichActionLabels,
} from "../server-agent/catalog-enrichment";
import {
  budgetedInferenceTransport,
  type InferenceRunCaps,
} from "./inference-budget";
import type { AuditRecord } from "../../packages/protocol/audit";
import { loadFavicon } from "../server-integrations/favicon";
import { CONTACT_CONTEXT_TTL } from "./contact-context";
import {
  autoConfigureOAuth,
  handleServiceOAuth,
} from "./service-oauth-controller";
import { refreshOAuthToken } from "../server-integrations/service-oauth";
import { actionFailure } from "../server-integrations/failures";
import type { ActionFailure } from "../../packages/protocol/action-failure";
import type {
  HumanTask,
  HumanTaskContent,
} from "../../packages/protocol/human-tasks";
import type { ProcessExecutionEntry } from "../../packages/protocol/process-execution";
import type { Hub } from "./hub";

type HubAgentAccess = ReturnType<Hub["agent"]>;
type Target = z.infer<typeof CatalogTarget>;
/** Fixed per-request caps; the workspace policy narrows tokens and cost. */
const ENRICHMENT_CAPS: InferenceRunCaps = {
  maxTokens: 10_000_000,
  maxCostMicros: 1_000_000_000,
  maxModelCalls: Math.ceil(1000 / ACTION_LABEL_BATCH),
};
export type CatalogContext = {
  session?: () => Promise<{ userId: string; sessionId: string }>;
  serial: <T>(run: () => Promise<T>) => Promise<T>;
  actor: (target: Target) => Promise<CatalogActor>;
  /** Trusted synchronous request binding check. Called with serial already held,
   * before a new invocation or dispatch, never after a known remote result. */
  validateRequest?: () => void;
  /** Trusted scope-bound store of open items. Native callers must hold serial
   * and current request authority; each change and its turn checkpoint share a transaction. */
  humanTasks?: {
    get: (id: string) => HumanTask;
    /** The newest open items, at most `limit`. */
    open: (limit: number) => HumanTask[];
    openCount: () => number;
    /** Exact normalized duplicate detection against every open item. */
    findOpenDuplicate: (content: HumanTaskContent) => HumanTask | undefined;
    create: (
      id: string,
      content: HumanTaskContent,
      origin: Extract<HumanTask["origin"], { kind: "agent" }>,
    ) => HumanTask;
    close: (id: string, reason: string) => HumanTask;
  };
  /** Saved processes the person can start now, for chat to offer before using
   * services. Synchronous; called with serial held. Only clients that can
   * review and start a process provide it. */
  processOffers?: () => Extract<
    ProcessExecutionEntry,
    { availability: "ready" }
  >[];
  /** The person's hub (overview) for the agent's hub tools. Synchronous; called
   * with serial held. Adding re-reads the person's start inventory. */
  hub?: (language: "en" | "cs") => HubAgentAccess;
  /** Drafts a personal process with the real designer, under the person's own
   * capabilities and budget, for the chat's proposal card. Nothing is saved.
   * Runs outside the identity queue (it takes it for short steps). Only
   * clients that render the card provide it. */
  processProposals?: {
    propose: (
      context: CatalogContext,
      input: {
        request: string;
        name?: string;
        addToHub: boolean;
        sessionId?: string;
        language: "en" | "cs";
        callKey: string;
      },
      signal: AbortSignal,
    ) => Promise<
      | {
          card: import("../../packages/protocol/process-proposal").ProcessProposalResult;
          reply?: string | null;
        }
      | { error: string; sessionId?: string }
    >;
  };
  /** The person's own meetings for the agent's read-only meeting tools.
   * Synchronous; called with serial held. Results are bounded and framed
   * as untrusted data; nothing here changes a meeting. */
  meetings?: import("./meeting-agent").MeetingAgentAccess;
  /** The person's skills for the agent. Synchronous; called with serial held.
   * Every call re-reads current access; nothing here grants an action. */
  skills?: {
    /** Enabled skills the person can use now, their own first. */
    list: () => import("../../packages/protocol/skills").SkillSummary[];
    /** One usable skill with its content, or undefined. */
    load: (
      id: string,
    ) => import("../../packages/protocol/skills").Skill | undefined;
    /** Keeps a drafted skill until the person saves it from the chat card. */
    propose: (
      id: string,
      content: import("../../packages/protocol/skills").SkillContent,
    ) => { id: string };
    /** Whether the person may save a proposal for the whole company. */
    workspaceAllowed: () => boolean;
  };
  /** Synchronous public command/question proof; called with the identity queue held. */
  legacyQuestionProof?: (idempotencyKey: string) =>
    | {
        command: Extract<
          import("../../packages/protocol").Command,
          { type: "message.send" }
        >;
        question: string;
      }
    | undefined;
  epoch: (org: string) => number;
  change: (org: string) => void;
  audit: (record: AuditRecord) => number;
  finish: (
    id: number,
    outcome: "succeeded" | "failed" | "unknown",
    details: AuditRecord["details"],
  ) => void;
  transaction: <T>(run: () => Promise<T>) => Promise<T>;
};
/** The largest service result kept and shown to the model, in characters of JSON. */
const MAX_RESULT_CHARACTERS = 65536;

export class CatalogController {
  private turnLocks = new Set<string>();
  async withTurn<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.turnLocks.has(id)) throw new IdentityError(429, "catalog_busy");
    this.turnLocks.add(id);
    try {
      return await run();
    } finally {
      this.turnLocks.delete(id);
    }
  }
  private active = 0;
  private icons = new Map<
    string,
    { expires: number; dataUrl: string | null }
  >();
  constructor(
    readonly store: ServiceCatalogStore,
    readonly transport: IntegrationTransport,
    readonly voiceAvailable = false,
    readonly legacyVoiceAvailable: (workspace: string) => boolean = () => false,
  ) {}
  private iconActive = 0;
  private iconWaiters = new Set<() => void>();
  private async iconSlot<T>(
    signal: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.iconWaiters.size >= 128)
      throw new IdentityError(429, "catalog_busy");
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.iconWaiters.delete(start);
        reject(signal.reason);
      };
      const start = () => {
        signal.removeEventListener("abort", abort);
        this.iconWaiters.delete(start);
        this.iconActive++;
        resolve();
      };
      if (this.iconActive < 4) start();
      else {
        this.iconWaiters.add(start);
        signal.addEventListener("abort", abort, { once: true });
      }
    });
    try {
      signal.throwIfAborted();
      return await run();
    } finally {
      this.iconActive--;
      this.iconWaiters.values().next().value?.();
    }
  }
  private async icon(
    payload: unknown,
    context: CatalogContext,
    signal: AbortSignal,
  ) {
    const input = ServiceIconRequest.parse(payload);
    const authorize = () =>
      context.serial(async () => {
        const actor = await context.actor(input);
        if ("serviceId" in input) {
          const service = this.store
            .inventory(input.organizationId, input.workspaceId, actor)
            .services.find((s) => s.id === input.serviceId);
          if (!service) throw new IdentityError(404, "not_found");
          return service.iconSource === "favicon" ? service.url : null;
        }
        if (actor.role === "member")
          throw new IdentityError(403, "identity_forbidden");
        return input.url;
      });
    const source = await authorize();
    if (!source) return { dataUrl: null };
    const cacheKey = JSON.stringify([
      input.organizationId,
      input.workspaceId,
      new URL(source).origin,
    ]);
    const cached = this.icons.get(cacheKey);
    if (cached && cached.expires > Date.now())
      return { dataUrl: cached.dataUrl };
    return this.iconSlot(signal, async () => {
      const ready = this.icons.get(cacheKey);
      if (ready && ready.expires > Date.now()) {
        if ((await authorize()) !== source)
          throw new IdentityError(409, "catalog_conflict");
        return { dataUrl: ready.dataUrl };
      }
      const guard = async (start: () => void) => {
        if ((await authorize()) !== source)
          throw new IdentityError(409, "catalog_conflict");
        start();
      };
      const dataUrl = await loadFavicon(this.transport, source, signal, guard);
      if ((await authorize()) !== source)
        throw new IdentityError(409, "catalog_conflict");
      signal.throwIfAborted();
      this.icons.delete(cacheKey);
      if (this.icons.size >= 64)
        this.icons.delete(this.icons.keys().next().value!);
      this.icons.set(cacheKey, {
        dataUrl,
        expires: Date.now() + (dataUrl ? 6 * 60 * 60_000 : 10 * 60_000),
      });
      return { dataUrl };
    });
  }
  /**
   * A service's tools from its address: MCP (initialize, tools/list) or the
   * OpenAPI document next to it. `guard` runs before each remote call with
   * the catalog queue held, so authority is current when the call goes out.
   */
  private async readTools(
    service: { url: string; protocol?: "mcp" | "openapi" },
    headers: Record<string, string>,
    signal: AbortSignal,
    guard: (start?: () => void) => Promise<void>,
  ) {
    const openapi = async () => {
      let document: unknown;
      for (const url of [
        service.url.replace(/\/$/, "") + "/openapi.json",
        service.url.replace(/\/$/, "") + "/swagger.json",
      ]) {
        const response = await this.transport({
          url,
          headers,
          signal,
          beforeDispatch: guard,
        });
        if (response.status === 404) continue;
        document = jsonResponse(response);
        break;
      }
      if (!document) throw new IntegrationError("integration_openapi_required");
      return {
        protocol: "openapi" as const,
        ...discoverOpenAPI(document, service.url),
      };
    };
    const mcp = async () => {
      const session = new McpSession(
        this.transport,
        service.url,
        headers,
        signal,
        guard,
      );
      await session.initialize();
      let discovery = await session.discover();
      // A catalogue server (Twenty) lists choices first; a person's own
      // service takes them all, within the action limit.
      if (discovery.choices)
        discovery = await session.discover(
          discovery.choices.slice(0, 200).map((choice) => choice.name),
        );
      return { protocol: "mcp" as const, ...discovery };
    };
    if (service.protocol === "mcp") return mcp();
    if (service.protocol === "openapi") return openapi();
    try {
      return await mcp();
    } catch (error) {
      if (signal.aborted || error instanceof IdentityError) throw error;
      try {
        return await openapi();
      } catch (fallback) {
        if (signal.aborted || fallback instanceof IdentityError) throw fallback;
        throw new IdentityError(422, "catalog_personal_unreachable");
      }
    }
  }
  /**
   * Every tool an own service offers, as choices for its owner; with `keys`,
   * also the chosen ones as actions to import. A catalogue server (Twenty)
   * describes only the tools asked for.
   */
  private async ownTools(
    service: { url: string; protocol: "mcp" | "openapi" },
    headers: Record<string, string>,
    signal: AbortSignal,
    guard: (start?: () => void) => Promise<void>,
    keys?: readonly string[],
  ) {
    let discovery: {
      actions: DiscoveredAction[];
      readOnly?: string[];
      choices?: { name: string; description: string; sourceKey: string }[];
    };
    let session: McpSession | undefined;
    if (service.protocol === "mcp") {
      session = new McpSession(
        this.transport,
        service.url,
        headers,
        signal,
        guard,
      );
      await session.initialize();
      discovery = await session.discover();
    } else {
      const tools = await this.readTools(service, headers, signal, guard);
      discovery = tools;
    }
    const reads = new Set(
      (discovery.readOnly ?? []).flatMap((name) => [`mcp:${name}`, name]),
    );
    const choices = discovery.choices
      ? discovery.choices.map((choice) => ({
          key: choice.sourceKey,
          name: choice.name,
          description: choice.description,
          effect: twentyReadTool(choice.name)
            ? ("read" as const)
            : ("write" as const),
        }))
      : discovery.actions.map((action) => ({
          key: action.sourceKey,
          name: action.name,
          description: action.description,
          effect:
            action.effect === "read" || reads.has(action.sourceKey)
              ? ("read" as const)
              : ("write" as const),
        }));
    if (!keys) return { choices, actions: [], readOnly: [] };
    const chosen = choices.filter((choice) => keys.includes(choice.key));
    if (chosen.length !== keys.length)
      throw new IdentityError(409, "catalog_conflict");
    if (discovery.choices && session)
      discovery = await session.discover(chosen.map((choice) => choice.name));
    const wanted = new Set(keys);
    return {
      choices,
      actions: discovery.choices
        ? discovery.actions
        : discovery.actions.filter((action) => wanted.has(action.sourceKey)),
      readOnly: discovery.readOnly ?? [],
    };
  }
  /**
   * A person's own MCP service that signs in with their account: the service
   * is stored without tools, its OAuth metadata is found and a client
   * registered (as for an administrator's MCP service), and the owner signs
   * in from the app; reading the tools follows the sign-in. A server that
   * advertises no OAuth, or none a client can register with, is refused and
   * nothing is kept.
   */
  private async addPersonalOAuth(
    input: { organizationId: string; workspaceId: string; url: string },
    name: string,
    status: "pending" | "active",
    userId: string,
    context: CatalogContext,
    signal: AbortSignal,
    audit: (
      action: "catalog.personal_service_added",
      targetId: string,
      details: Record<string, unknown>,
    ) => unknown,
  ) {
    const { organizationId, workspaceId } = input;
    if (!this.store.oauth)
      throw new IdentityError(422, "catalog_personal_unreachable");
    const id = await context.serial(() =>
      context.transaction(async () =>
        this.store.addPersonalService(
          workspaceId,
          userId,
          { name, url: input.url, protocol: "mcp", auth: { type: "none" } },
          undefined,
          status,
        ),
      ),
    );
    const target = { organizationId, workspaceId, serviceId: id };
    let ready = false;
    try {
      await autoConfigureOAuth(
        context,
        this.store,
        this.transport,
        target,
        userId,
        signal,
      );
      ready = await context.serial(async () => {
        const config = this.store.oauth!.config(
          this.store.oauthTarget(workspaceId, id),
        );
        return (
          !!config.discovery &&
          config.hasClientId &&
          config.settings.requiredFor !== "none"
        );
      });
    } finally {
      if (!ready)
        await context.serial(() =>
          context.transaction(async () => {
            const service = this.store.service(workspaceId, id);
            this.store.removePersonalService(
              workspaceId,
              id,
              service.revision,
              userId,
            );
          }),
        );
    }
    if (!ready) throw new IdentityError(422, "catalog_personal_unreachable");
    return context.serial(() =>
      context.transaction(async () => {
        audit("catalog.personal_service_added", id, {
          revision: this.store.service(workspaceId, id).revision,
          added: 0,
          enabled: status === "active",
        });
        return this.store.personalSummary(this.store.service(workspaceId, id));
      }),
    );
  }
  /** A person's own service: added, renamed, read again or removed by its owner. */
  private async personalCommand(
    input: PersonalServiceCommandValue,
    context: CatalogContext,
    signal: AbortSignal,
  ) {
    const { organizationId, workspaceId } = input;
    const actor = await context.serial(() => context.actor(input));
    const guard = async (start?: () => void) => {
      await context.serial(async () => {
        const current = await context.actor(input);
        if (current.userId !== actor.userId)
          throw new IdentityError(403, "identity_forbidden");
        start?.();
      });
    };
    const audit = (
      action:
        | "catalog.personal_service_added"
        | "catalog.personal_service_changed"
        | "catalog.personal_service_removed",
      targetId: string,
      details: Record<string, unknown>,
    ) =>
      context.audit({
        organizationId,
        workspaceId,
        actorId: actor.userId,
        source: "console",
        action,
        targetId,
        outcome: "succeeded",
        details,
      });
    if (input.type === "add") {
      const policy = this.store.personalServicesPolicy(workspaceId);
      if (policy === "off")
        throw new IdentityError(403, "catalog_personal_services_off");
      if (
        this.store.personalServices(workspaceId, actor.userId).length >=
        PERSONAL_SERVICES_LIMIT
      )
        throw new IdentityError(409, "identity_limit");
      validateEndpoint(input.url, []);
      const auth = input.apiKey
        ? ({ type: "bearer" } as const)
        : ({ type: "none" } as const);
      const name = input.name ?? new URL(input.url).hostname;
      let tools: Awaited<ReturnType<CatalogController["readTools"]>>;
      try {
        tools = await this.readTools(
          { url: input.url },
          authHeaders(auth, input.apiKey ?? ""),
          signal,
          guard,
        );
      } catch (error) {
        // Without a key, a server that wants the person's own account
        // (Notion, Linear and other MCP servers with OAuth) is signed in to
        // instead: its tools are read once the person has connected.
        if (signal.aborted || input.apiKey) throw error;
        return this.addPersonalOAuth(
          input,
          name,
          policy === "free" ? "active" : "pending",
          actor.userId,
          context,
          signal,
          audit,
        );
      }
      return context.serial(() =>
        context.transaction(async () => {
          const id = this.store.addPersonalService(
            workspaceId,
            actor.userId,
            { name, url: input.url, protocol: tools.protocol, auth },
            input.apiKey,
            policy === "free" ? "active" : "pending",
          );
          const imported = this.store.importPersonalActions(
            workspaceId,
            id,
            this.store.service(workspaceId, id).revision,
            tools.actions,
            "readOnly" in tools ? (tools.readOnly ?? []) : [],
          );
          audit("catalog.personal_service_added", id, {
            revision: this.store.service(workspaceId, id).revision,
            added: imported.added,
            enabled: policy === "free",
          });
          return this.store.personalSummary(
            this.store.service(workspaceId, id),
          );
        }),
      );
    }
    /** The owner's service and how to call it: a service the person signs
     * in to is read with their own token, renewed first when it lapsed. */
    const owned = async (id: string, revision: number, manage: boolean) => {
      await this.refreshPersonal(
        { organizationId, workspaceId, serviceId: id },
        context,
        signal,
      );
      const found = await context.serial(async () => {
        const service = manage
          ? this.store.managedService(workspaceId, id, actor.userId)
          : this.store.ownedService(workspaceId, id, actor.userId);
        const personal = this.store.personalToken(
          workspaceId,
          id,
          actor.userId,
        );
        return {
          service,
          headers: personal
            ? { Authorization: `Bearer ${personal}` }
            : authHeaders(service.auth, this.store.credential(workspaceId, id)),
        };
      });
      if (found.service.revision !== revision)
        throw new IdentityError(409, "catalog_conflict");
      return found;
    };
    if (input.type === "findActions" || input.type === "addActions") {
      const { service, headers } = await owned(input.id, input.revision, true);
      const tools = await this.ownTools(
        service,
        headers,
        signal,
        guard,
        input.type === "addActions" ? input.keys : undefined,
      );
      if (input.type === "findActions")
        return PersonalActionChoices.parse({
          id: service.id,
          revision: service.revision,
          choices: tools.choices.slice(0, 1000).map((choice) => ({
            ...choice,
            added: service.actions.some(
              (action) =>
                action.sourceKey === choice.key ||
                action.sourceKey === `mcp:${choice.name}`,
            ),
          })),
        });
      return context.serial(() =>
        context.transaction(async () => {
          this.store.managedService(workspaceId, input.id, actor.userId);
          const imported = this.store.importPersonalActions(
            workspaceId,
            input.id,
            input.revision,
            tools.actions,
            tools.readOnly,
          );
          audit("catalog.personal_service_changed", input.id, {
            previousRevision: input.revision,
            added: imported.added,
          });
          return this.store.personalSummary(
            this.store.service(workspaceId, input.id),
          );
        }),
      );
    }
    if (input.type === "editAction" || input.type === "removeAction") {
      return context.serial(() =>
        context.transaction(async () => {
          const service = this.store.managedService(
            workspaceId,
            input.id,
            actor.userId,
          );
          if (service.revision !== input.revision)
            throw new IdentityError(409, "catalog_conflict");
          const action = service.actions.find((a) => a.id === input.actionId);
          if (!action) throw new IdentityError(404, "catalog_not_found");
          if (action.revision !== input.actionRevision)
            throw new IdentityError(409, "catalog_conflict");
          if (input.type === "removeAction") {
            this.store.command({
              organizationId,
              workspaceId,
              type: "removeAction",
              serviceId: service.id,
              serviceRevision: service.revision,
              id: action.id,
              revision: action.revision,
            });
            // Running work of this person loses the action's authority.
            context.change(organizationId);
          } else {
            const {
              id: _id,
              revision: _revision,
              sourceKey: _sourceKey,
              ...settings
            } = action;
            this.store.command({
              organizationId,
              workspaceId,
              type: "saveAction",
              serviceId: service.id,
              serviceRevision: service.revision,
              id: action.id,
              revision: action.revision,
              settings: {
                ...settings,
                name: input.name,
                description: input.description,
                effect: input.effect,
                approval: input.effect === "read" ? "never" : "always",
              },
            });
            if (input.effect !== action.effect) {
              // A change asks before each run again until the owner says
              // otherwise; whether the action is on stays as it was.
              const key = {
                organizationId,
                workspaceId,
                serviceId: service.id,
              };
              const before = this.store.personalChoice(
                workspaceId,
                service.id,
                action,
                actor.userId,
              );
              this.store.personalPolicy.save(
                { ...key, userId: actor.userId },
                this.store.personalPolicy.revision(
                  workspaceId,
                  service.id,
                  actor.userId,
                ),
                [
                  {
                    action: { id: action.id, effect: input.effect },
                    choice: {
                      enabled: before?.enabled ?? true,
                      approval: input.effect === "read" ? "never" : "always",
                    },
                  },
                ],
              );
              context.change(organizationId);
            }
          }
          audit("catalog.personal_service_changed", input.id, {
            previousRevision: input.revision,
            revision: this.store.service(workspaceId, input.id).revision,
          });
          return this.store.personalSummary(
            this.store.service(workspaceId, input.id),
          );
        }),
      );
    }
    if (input.type === "rediscover") {
      const { service, headers } = await owned(input.id, input.revision, false);
      const tools = await this.readTools(service, headers, signal, guard);
      return context.serial(() =>
        context.transaction(async () => {
          const imported = this.store.importPersonalActions(
            workspaceId,
            input.id,
            input.revision,
            tools.actions,
            "readOnly" in tools ? (tools.readOnly ?? []) : [],
          );
          audit("catalog.personal_service_changed", input.id, {
            previousRevision: input.revision,
            added: imported.added,
          });
          return this.store.personalSummary(
            this.store.service(workspaceId, input.id),
          );
        }),
      );
    }
    return context.serial(() =>
      context.transaction(async () => {
        if (input.type === "rename") {
          this.store.renamePersonalService(
            workspaceId,
            input.id,
            input.revision,
            actor.userId,
            input.name,
          );
          audit("catalog.personal_service_changed", input.id, {
            previousRevision: input.revision,
            revision: input.revision + 1,
          });
          return this.store.personalSummary(
            this.store.service(workspaceId, input.id),
          );
        }
        this.store.removePersonalService(
          workspaceId,
          input.id,
          input.revision,
          actor.userId,
        );
        // Running work of this person loses the service's authority.
        context.change(organizationId);
        audit("catalog.personal_service_removed", input.id, {
          revision: input.revision,
        });
        return { id: input.id };
      }),
    );
  }
  async handle(
    method: string,
    url: URL,
    payload: unknown,
    context: CatalogContext,
    signal: AbortSignal,
  ) {
    const path = url.pathname.slice("/admin/api/identity/catalog".length);
    if (path === "" && method === "GET") {
      const target = CatalogTarget.parse(Object.fromEntries(url.searchParams));
      return context.serial(async () => ({
        ...this.store.inventory(
          target.organizationId,
          target.workspaceId,
          await context.actor(target),
        ),
        voiceAvailable: this.voiceAvailable,
        legacyVoiceAvailable: this.legacyVoiceAvailable(target.workspaceId),
      }));
    }
    if (path === "/budget" && (method === "GET" || method === "POST")) {
      if (method === "GET") {
        const target = CatalogTarget.parse(
          Object.fromEntries(url.searchParams),
        );
        return context.serial(async () => {
          const actor = await context.actor(target);
          if (actor.role === "member")
            throw new IdentityError(403, "identity_forbidden");
          return this.store.inferenceBudget.policy(
            target.organizationId,
            target.workspaceId,
          );
        });
      }
      const input = InferenceBudgetCommandSchema.parse(payload);
      return context.serial(async () => {
        const actor = await context.actor(input);
        if (actor.role === "member")
          throw new IdentityError(403, "identity_forbidden");
        const inventory = this.store.inventory(
          input.organizationId,
          input.workspaceId,
          actor,
        );
        for (const price of input.settings.prices) {
          const model = inventory.models.find((m) => m.id === price.modelId);
          if (!model || !["chat", "router", "decision"].includes(model.kind))
            throw new IdentityError(409, "catalog_model_unavailable");
          const selected = this.store.model(
            input.organizationId,
            model.id,
            model.kind === "decision" ? "decision" : "tools",
          );
          if (
            selected.model.revision !== price.modelRevision ||
            selected.provider.revision !== price.providerRevision
          )
            throw new IdentityError(409, "catalog_conflict");
        }
        return context.transaction(async () => {
          const policy = this.store.inferenceBudget.savePolicy(
            input.organizationId,
            input.workspaceId,
            input.revision,
            input.settings,
          );
          context.audit({
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            actorId: actor.userId,
            source: "console",
            action: "catalog.ai_changed",
            targetId: input.workspaceId,
            outcome: "succeeded",
            details: {
              previousRevision: input.revision,
              revision: policy.revision,
            },
          });
          return policy;
        });
      });
    }
    if (path === "/command" && method === "POST") {
      const input = CatalogCommand.parse(payload);
      let probe: { serviceId: string; actorId: string } | undefined;
      const result = await context.serial(async () => {
        const actor = await context.actor(input);
        if (actor.role === "member")
          throw new IdentityError(403, "identity_forbidden");
        return context.transaction(async () => {
          const before = this.store.authorityShape(
            input.organizationId,
            input.workspaceId,
          );
          // An MCP service at a new address gets its OAuth looked up once
          // the save is through; the administrator typed that address.
          const previousUrl =
            input.type === "saveService" && input.id
              ? this.store.service(input.workspaceId, input.id).url
              : undefined;
          const id = this.store.command(input);
          if (
            input.type === "saveService" &&
            input.settings.protocol === "mcp" &&
            input.settings.url !== previousUrl
          )
            probe = { serviceId: id, actorId: actor.userId };
          // Running work keeps its policy epoch unless this edit could take
          // authority away: an existing entry removed, re-keyed or changed in
          // more than its name, description or icon. Additions keep it.
          const after = this.store.authorityShape(
            input.organizationId,
            input.workspaceId,
          );
          if ([...before].some(([key, value]) => after.get(key) !== value))
            context.change(input.organizationId);
          context.audit({
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            actorId: actor.userId,
            source: "console",
            action:
              input.type.includes("Provider") || input.type.includes("Model")
                ? "catalog.ai_changed"
                : input.type === "saveRouting"
                  ? "catalog.routing_changed"
                  : input.type === "reviewPersonalService"
                    ? "catalog.personal_service_reviewed"
                    : "catalog.service_changed",
            targetId: id,
            outcome: "succeeded",
            details: {},
          });
          return { id };
        });
      });
      if (probe && this.store.oauth)
        // In the background, bounded; the console joins it through oauth/auto.
        void autoConfigureOAuth(
          context,
          this.store,
          this.transport,
          {
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            serviceId: probe.serviceId,
          },
          probe.actorId,
          AbortSignal.timeout(60_000),
        ).catch(() => {});
      return result;
    }
    if (method !== "POST") throw new IdentityError(404, "not_found");
    if (path === "/icon") return this.icon(payload, context, signal);
    if (this.active >= 8) throw new IdentityError(429, "catalog_busy");
    this.active++;
    try {
      if (path === "/personal/list") {
        const target = CatalogTarget.parse(payload);
        return await context.serial(async () => {
          const actor = await context.actor(target);
          return PersonalServiceList.parse({
            ...target,
            policy: this.store.personalServicesPolicy(target.workspaceId),
            management: this.store.personalManagement(target.workspaceId),
            limit: PERSONAL_SERVICES_LIMIT,
            services: this.store.personalServices(
              target.workspaceId,
              actor.userId,
            ),
          });
        });
      }
      if (path === "/personal/command")
        return await this.personalCommand(
          PersonalServiceCommand.parse(payload),
          context,
          signal,
        );
      if (path.startsWith("/oauth/"))
        return await handleServiceOAuth(
          path.slice(7),
          payload,
          context,
          this.store,
          this.transport,
          signal,
        );
      if (path === "/invoke")
        return await this.invoke(
          ActionInvokeRequest.parse(payload),
          context,
          signal,
        );
      if (path === "/discover") {
        const input = DiscoveryRequest.parse(payload);
        const prepared = await this.prepare(input, context);
        if (
          input.policyRevision !== undefined &&
          input.policyRevision !== context.epoch(input.organizationId)
        )
          throw new IdentityError(409, "catalog_conflict");
        const service = await context.serial(async () => {
          const s = this.store.service(input.workspaceId, input.serviceId);
          if (s.revision !== input.revision)
            throw new IdentityError(409, "catalog_conflict");
          return s;
        });
        const check = (start?: () => void) =>
          this.check(
            input,
            prepared,
            context,
            () => {
              if (
                this.store.service(input.workspaceId, input.serviceId)
                  .revision !== input.revision
              )
                throw new IdentityError(409, "catalog_conflict");
            },
            start,
          );
        const key = await context.serial(async () =>
          this.store.credential(input.workspaceId, input.serviceId),
        );
        if (service.protocol !== "mcp" && input.toolNames)
          throw new IntegrationError("integration_input_invalid");
        const headers = authHeaders(service.auth, key);
        let discovery: Awaited<ReturnType<McpSession["discover"]>>;
        if (service.protocol === "mcp") {
          const mcp = new McpSession(
            this.transport,
            service.url,
            headers,
            signal,
            check,
          );
          await mcp.initialize();
          discovery = await mcp.discover(input.toolNames);
          if (discovery.choices) {
            await check();
            return {
              added: 0,
              existing: 0,
              warnings: [],
              enriched: false,
              choices: discovery.choices.map((choice) => ({
                ...choice,
                existing: service.actions.some(
                  (action) =>
                    action.sourceKey === choice.sourceKey ||
                    action.sourceKey === `mcp:${choice.name}`,
                ),
              })),
            };
          }
        } else {
          const urls = input.documentUrl
            ? [sameEndpoint(service.url, input.documentUrl).href]
            : [
                service.url.replace(/\/$/, "") + "/openapi.json",
                service.url.replace(/\/$/, "") + "/swagger.json",
              ];
          let document: unknown;
          for (const url of urls) {
            const response = await this.transport({
              url,
              headers,
              signal,
              beforeDispatch: check,
            });
            if (response.status === 404) continue;
            document = jsonResponse(response);
            break;
          }
          if (!document)
            throw new IntegrationError("integration_openapi_required");
          discovery = discoverOpenAPI(document, service.url);
        }
        // Preserve the source identity of a tool imported directly before progressive discovery.
        for (const action of discovery.actions) {
          if (action.binding.type === "mcp" && action.binding.catalogTool) {
            const target = action.binding.catalogTool;
            const legacy = service.actions.find(
              (saved) => saved.sourceKey === `mcp:${target}`,
            );
            if (legacy?.sourceKey) action.sourceKey = legacy.sourceKey;
          }
        }
        let freshActions = discovery.actions.filter(
          (action) =>
            !service.actions.some(
              (saved) => saved.sourceKey === action.sourceKey,
            ),
        );
        // Asked for in slices: this request describes and imports the first
        // few new tools, the rest come back as a continuation.
        let later: string[] = [];
        if (
          input.limit &&
          freshActions.length > input.limit &&
          !("remaining" in discovery && discovery.remaining?.length) &&
          freshActions.every(
            (action) =>
              action.binding.type === "mcp" && !action.binding.catalogTool,
          )
        ) {
          const deferred = new Set(freshActions.slice(input.limit));
          later = [...deferred].map((action) =>
            action.binding.type === "mcp" ? action.binding.name : "",
          );
          freshActions = freshActions.slice(0, input.limit);
          discovery.actions = discovery.actions.filter(
            (action) => !deferred.has(action),
          );
        }
        if (service.actions.length + freshActions.length > 1000)
          throw new IdentityError(409, "identity_limit");
        let enriched = false;
        if (input.enrich && freshActions.length) {
          const selected = await context.serial(async () =>
            this.store.resolveModel(
              input.organizationId,
              input.workspaceId,
              input.serviceId,
            ),
          );
          if (!selected) throw new IdentityError(409, "catalog_model_required");
          // Every naming call goes through the inference ledger under its own
          // admin root, one per import request, like any other model call.
          const transport = budgetedInferenceTransport(
            this.transport,
            this.store.inferenceBudget,
            `catalog-enrich/${input.serviceId}/${input.revision}/${randomUUID()}`,
            {
              organizationId: input.organizationId,
              workspaceId: input.workspaceId,
              userId: prepared.actor.userId,
            },
            selected,
            "model",
            (run) => context.serial(run),
            () => this.validate(input, prepared, context),
            () => 0,
            ENRICHMENT_CAPS,
          );
          const model = createNiaroMastraModel(
            selected,
            transport,
            async (start) => {
              await context.serial(async () => {
                await this.validate(input, prepared, context);
                if (
                  this.store.service(input.workspaceId, input.serviceId)
                    .revision !== input.revision
                )
                  throw new IdentityError(409, "catalog_conflict");
                this.store.useProvider(
                  input.organizationId,
                  selected.provider.id,
                  selected.provider.revision,
                );
                start();
              });
            },
          );
          for (
            let offset = 0;
            offset < freshActions.length;
            offset += ACTION_LABEL_BATCH
          ) {
            const batch = freshActions.slice(
              offset,
              offset + ACTION_LABEL_BATCH,
            );
            let labels: Awaited<ReturnType<typeof enrichActionLabels>>;
            try {
              labels = await enrichActionLabels(model, batch, signal);
            } catch (error) {
              const cause = error instanceof Error ? error.cause : undefined;
              if (
                signal.aborted ||
                error instanceof IdentityError ||
                error instanceof IntegrationError
              )
                throw error;
              if (
                cause instanceof IdentityError ||
                cause instanceof IntegrationError
              )
                throw cause;
              throw new IntegrationError(
                "integration_model_response_invalid",
                502,
              );
            }
            for (const label of labels) {
              const action = batch[label.index];
              if (action) {
                action.name = label.name;
                action.description = label.description;
              }
            }
          }
          enriched = true;
        }
        await check();
        return context.serial(async () => {
          await this.validate(input, prepared, context);
          return context.transaction(async () => {
            const result = this.store.importActions(
              input.workspaceId,
              input.serviceId,
              input.revision,
              discovery.actions,
            );
            // Imported actions arrive disabled and ungranted, so they add
            // nothing anyone can run and leave running work untouched.
            context.audit({
              organizationId: input.organizationId,
              workspaceId: input.workspaceId,
              actorId: prepared.actor.userId,
              source: "console",
              action: "catalog.actions_discovered",
              targetId: input.serviceId,
              outcome: "succeeded",
              details: {},
            });
            const remaining =
              "remaining" in discovery && discovery.remaining?.length
                ? discovery.remaining
                : later;
            const hinted = new Set(
              ("readOnly" in discovery ? (discovery.readOnly ?? []) : []).map(
                (name) => `mcp:${name}`,
              ),
            );
            const readOnly = hinted.size
              ? this.store
                  .service(input.workspaceId, input.serviceId)
                  .actions.filter(
                    (action) =>
                      action.effect === "write" &&
                      !!action.sourceKey &&
                      hinted.has(action.sourceKey),
                  )
                  .map((action) => action.id)
              : [];
            return {
              ...result,
              warnings: discovery.warnings,
              ...(discovery.issues?.length ? { issues: discovery.issues } : {}),
              enriched,
              ...(readOnly.length ? { readOnly } : {}),
              ...(remaining.length
                ? {
                    next: {
                      toolNames: remaining,
                      revision: this.store.service(
                        input.workspaceId,
                        input.serviceId,
                      ).revision,
                      policyRevision: context.epoch(input.organizationId),
                    },
                  }
                : {}),
            };
          });
        });
      }
      if (path === "/probe") {
        const input = ServiceProbeRequest.parse(payload);
        const prepared = await this.prepare(input, context);
        const { service, key } = await context.serial(async () => ({
          service: this.store.service(input.workspaceId, input.serviceId),
          key: this.store.credential(input.workspaceId, input.serviceId),
        }));
        // A missing key is a setup step of its own, not an unreachable address.
        if (service.auth.type !== "none" && !key)
          return { status: "failed", error: "catalog_key_required" };
        const check = (start?: () => void) =>
          this.check(input, prepared, context, () => {}, start);
        const headers = authHeaders(service.auth, key);
        try {
          if (service.protocol === "mcp")
            await new McpSession(
              this.transport,
              service.url,
              headers,
              signal,
              check,
            ).initialize();
          else {
            const response = await this.transport({
              url: service.url,
              headers,
              signal,
              beforeDispatch: check,
            });
            if (response.status === 401 || response.status === 403)
              return { status: "sign_in" };
            if (response.status >= 500)
              return { status: "failed", error: "integration_provider_failed" };
          }
          return { status: "ok" };
        } catch (error) {
          if (signal.aborted || error instanceof IdentityError) throw error;
          if (!(error instanceof IntegrationError))
            return { status: "failed", error: "integration_unavailable" };
          const http = error.failure?.httpStatus;
          return http === 401 || http === 403
            ? { status: "sign_in" }
            : { status: "failed", error: error.code };
        }
      }
      if (path === "/models") {
        const input = ModelDiscoveryRequest.parse(payload),
          prepared = await this.prepare(input, context);
        const selected = await context.serial(async () =>
          this.store.provider(input.organizationId, input.providerId),
        );
        if (selected.provider.revision !== input.revision)
          throw new IdentityError(409, "catalog_conflict");
        const check = (start?: () => void) =>
          this.check(
            input,
            prepared,
            context,
            () => {
              if (
                this.store.provider(input.organizationId, input.providerId)
                  .provider.revision !== input.revision
              )
                throw new IdentityError(409, "catalog_conflict");
            },
            start,
          );
        const models = await listModels(
          this.transport,
          selected.provider,
          selected.key,
          signal,
          check,
        );
        await check();
        return { models };
      }
      throw new IdentityError(404, "not_found");
    } finally {
      this.active--;
    }
  }
  private async prepare(input: Target, ctx: CatalogContext) {
    return ctx.serial(async () => {
      const actor = await ctx.actor(input);
      if (actor.role === "member")
        throw new IdentityError(403, "identity_forbidden");
      return { actor, epoch: ctx.epoch(input.organizationId) };
    });
  }
  private async validate(
    input: Target,
    prepared: { actor: CatalogActor; epoch: number },
    ctx: CatalogContext,
  ) {
    const actor = await ctx.actor(input);
    if (
      actor.role === "member" ||
      actor.userId !== prepared.actor.userId ||
      ctx.epoch(input.organizationId) !== prepared.epoch
    )
      throw new IdentityError(403, "identity_forbidden");
  }
  private async check(
    input: Target,
    prepared: { actor: CatalogActor; epoch: number },
    ctx: CatalogContext,
    extra: () => void,
    start?: () => void,
  ) {
    await ctx.serial(async () => {
      await this.validate(input, prepared, ctx);
      extra();
      start?.();
    });
  }
  /** Refreshes in flight, one per connection: a service that rotates its
   * refresh token would treat a second refresh with the old one as reuse
   * and revoke the whole grant. */
  private refreshing = new Map<string, Promise<void>>();
  /** Renews the person's service token before anything authorizes with it. Only an explicit
   * refusal disconnects; an outage leaves the connection for the next attempt. */
  private async refreshPersonal(
    input: { organizationId: string; workspaceId: string; serviceId: string },
    ctx: CatalogContext,
    signal: AbortSignal,
  ) {
    const oauth = this.store.oauth;
    if (!oauth) return;
    const userId = (await ctx.serial(() => ctx.actor(input))).userId;
    const key = `${input.workspaceId}/${input.serviceId}/${userId}`;
    const running = this.refreshing.get(key);
    if (running) {
      // Joined, not repeated; its failure is the caller's own expired token.
      await running.catch(() => {});
      return;
    }
    const run = this.refreshOnce(input, ctx, signal);
    this.refreshing.set(key, run);
    try {
      await run;
    } finally {
      if (this.refreshing.get(key) === run) this.refreshing.delete(key);
    }
  }
  /**
   * Keeps personal sign-ins alive without anyone using them: a token that
   * lapses within `margin` is renewed, each connection at most once per
   * `interval`. A refresh token a provider only keeps while it is used
   * (Microsoft, Google) then never runs out between two uses.
   */
  private keptAt = new Map<string, number>();
  async keepConnectionsFresh(
    run: Pick<CatalogContext, "serial" | "transaction">,
    signal: AbortSignal,
    margin = 30 * 60_000,
    interval = 6 * 60 * 60_000,
  ) {
    const oauth = this.store.oauth;
    if (!oauth) return { renewed: 0, failed: 0 };
    const due = await run.serial(async () => oauth.renewable(margin));
    let renewed = 0,
      failed = 0;
    for (const item of due) {
      if (signal.aborted) break;
      const key = `${item.workspaceId}/${item.serviceId}/${item.userId}`;
      if (Date.now() - (this.keptAt.get(key) ?? 0) < interval) continue;
      if (this.refreshing.has(key)) continue;
      this.keptAt.set(key, Date.now());
      const ctx: CatalogContext = {
        serial: run.serial,
        transaction: run.transaction,
        // The connection's owner, as the store recorded them; dispatch
        // checks membership again before any use.
        actor: async () => ({ userId: item.userId, role: "member" }),
        epoch: () => 0,
        change: () => {},
        audit: () => 0,
        finish: () => {},
      };
      const attempt = this.refreshOnce(
        {
          organizationId: "",
          workspaceId: item.workspaceId,
          serviceId: item.serviceId,
        },
        ctx,
        signal,
      );
      this.refreshing.set(key, attempt);
      try {
        await attempt;
        renewed++;
      } catch {
        failed++;
      } finally {
        if (this.refreshing.get(key) === attempt) this.refreshing.delete(key);
      }
    }
    return { renewed, failed };
  }
  private async refreshOnce(
    input: { organizationId: string; workspaceId: string; serviceId: string },
    ctx: CatalogContext,
    signal: AbortSignal,
  ) {
    const oauth = this.store.oauth;
    if (!oauth) return;
    const snapshot = await ctx.serial(async () => {
      const actor = await ctx.actor(input);
      return oauth.refreshSnapshot(
        this.store.oauthTarget(input.workspaceId, input.serviceId),
        actor.userId,
      );
    });
    if (!snapshot) return;
    const current = async () => {
      const actor = await ctx.actor(input);
      if (actor.userId !== snapshot.userId)
        throw new IdentityError(403, "identity_forbidden");
      return this.store.oauthTarget(input.workspaceId, input.serviceId);
    };
    try {
      const tokens = await refreshOAuthToken(this.transport, snapshot, {
        signal,
        beforeDispatch: (start) =>
          ctx.serial(async () => {
            await current();
            signal.throwIfAborted();
            start();
          }),
      });
      await ctx.serial(async () =>
        ctx.transaction(async () => {
          oauth.commitRefresh(snapshot, tokens, await current());
        }),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      if (
        error instanceof IntegrationError &&
        error.code === "service_oauth_grant_revoked"
      )
        await ctx.serial(async () => {
          await current();
          oauth.dropRefresh(snapshot);
        });
      // Otherwise authorize() reports the expired connection as a sign-in card.
    }
  }
  async invoke(
    input: z.infer<typeof ActionInvokeRequest>,
    ctx: CatalogContext,
    signal: AbortSignal,
    source: "console" | "chat" | "mcp" = "console",
    contactSource?: string,
    dependencies: string[] = [],
  ) {
    await this.refreshPersonal(input, ctx, signal);
    let created = false;
    const prepared = await ctx.serial(async () => {
      const actor = await ctx.actor(input),
        epoch = ctx.epoch(input.organizationId);
      ctx.validateRequest?.();
      const old = this.store.invocation(
        input.requestId,
        input.workspaceId,
        actor.userId,
      );
      const operation = this.store.prepare(
        input,
        actor,
        epoch,
        contactSource,
        dependencies,
      );
      created = !old;
      return { actor, epoch, operation };
    });
    const operation = prepared.operation;
    if (
      (!created && operation.status !== "awaiting_approval") ||
      (operation.status === "awaiting_approval" && !input.approve)
    )
      return operation;
    const validate = async (forDispatch = false, knownResult = false) => {
      const actor = await ctx.actor(input);
      if (!knownResult) ctx.validateRequest?.();
      if (
        actor.userId !== prepared.actor.userId ||
        ctx.epoch(input.organizationId) !== operation.policyRevision
      )
        throw new IdentityError(403, "identity_forbidden");
      if (operation.contactSource)
        this.store.contactSource(
          operation.contactSource,
          input.organizationId,
          input.workspaceId,
          actor,
          created && forDispatch ? CONTACT_CONTEXT_TTL : undefined,
        );
      for (const sourceId of operation.dependencies ?? [])
        this.store.contactSource(
          sourceId,
          input.organizationId,
          input.workspaceId,
          actor,
          created && forDispatch ? CONTACT_CONTEXT_TTL : undefined,
        );
      const authorized = this.store.authorize(
        input.workspaceId,
        input.serviceId,
        input.serviceRevision,
        input.actionId,
        input.revision,
        actor,
        knownResult,
      );
      this.store.assertExecutionPin(operation, authorized.executionPin);
      return authorized;
    };
    let dispatched = false,
      claimed = false;
    let stage: ActionFailure["stage"] = "validation";
    try {
      const authorized = await ctx.serial(async () => {
        const value = await validate();
        const current = this.store.invocation(
          operation.id,
          operation.workspaceId,
          operation.userId,
        )!;
        if (!created && current.status !== "awaiting_approval")
          throw new IdentityError(409, "catalog_conflict");
        operation.status = "running";
        claimed = true;
        operation.auditId = ctx.audit({
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          actorId: prepared.actor.userId,
          source,
          action: "catalog.action_invoked",
          targetId: input.actionId,
          outcome: "running",
          details: {},
        });
        this.store.saveInvocation(operation);
        return value;
      });
      stage = "connection";
      const result = await invokeAction(
        this.transport,
        authorized.service,
        authorized.action,
        authorized.key,
        input.input,
        signal,
        async (start) => {
          await ctx.serial(async () => {
            await validate(true);
            start();
          });
        },
        () => {
          dispatched = true;
          stage = "dispatch";
        },
      );
      stage = "provider_response";
      const size = JSON.stringify(result).length;
      if (size > MAX_RESULT_CHARACTERS)
        // A read that returns too much can be asked again for less; saying so
        // lets the model narrow it instead of giving up.
        throw new IntegrationError(
          "integration_response_too_large",
          502,
          operation.effect === "read"
            ? {
                code: "integration_response_too_large",
                kind: "validation",
                stage: "provider_response",
                retry: "correct_input",
                message: `The result was too large (${Math.ceil(size / 1024)} KB; the limit is ${MAX_RESULT_CHARACTERS / 1024} KB). Ask for fewer records or only the fields you need, or page through it.`,
                fields: [],
              }
            : undefined,
        );
      stage = "result_commit";
      await ctx.serial(async () => {
        await validate(false, true);
        operation.status = "succeeded";
        operation.result = result;
        delete operation.failure;
        operation.completedAt = Date.now();
        this.store.saveInvocation(operation);
      });
    } catch (error) {
      if (!claimed) throw error;
      await ctx.serial(async () => {
        let diagnosticError = error;
        // Receipt recovery stays passive, but a revoked actor must not receive a
        // provider's response through the diagnostic channel either.
        try {
          await validate(false, true);
        } catch (authorizationError) {
          diagnosticError = authorizationError;
          stage = dispatched ? "result_commit" : "validation";
        }
        operation.status =
          dispatched && operation.effect === "write" ? "unknown" : "failed";
        operation.failure = actionFailure(diagnosticError, {
          stage,
          effect: operation.effect,
          dispatched,
          aborted: signal.aborted,
        });
        operation.completedAt = Date.now();
        delete operation.result;
        this.store.saveInvocation(operation);
      });
    }
    await ctx.serial(async () => {
      if (operation.auditId)
        ctx.finish(
          operation.auditId,
          operation.status === "succeeded"
            ? "succeeded"
            : operation.status === "unknown"
              ? "unknown"
              : "failed",
          {},
        );
    });
    return operation;
  }
}
