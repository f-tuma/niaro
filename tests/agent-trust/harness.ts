import { NativeAttachmentBindingSchema , DomainCommandSchema } from "../../apps/server-identity/mastra-domain";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  FixtureStorage,
  type StorageCheckpoint,
} from "../../apps/fixture-server/storage";
import { ModelService } from "../../apps/fixture-server/model-service";
import { ServiceCatalogStore } from "../../apps/server-identity/service-catalog";
import {
  CatalogController,
  type CatalogContext,
} from "../../apps/server-identity/catalog-controller";
import { createCatalogRuntime } from "../../apps/server-identity/catalog-runtime";
import {
  closeNativeCatalogRuntime,
  inspectNativeCatalogRuntime,
} from "../../apps/server-identity/mastra-runtime";
import { MemoryStore } from "../../apps/server-identity/memory";
import { createMemoryRuntime } from "../../apps/server-identity/memory-runtime";
import { MemorySettingsSchema } from "../../packages/protocol/memory";
import type { MemorySource } from "../../packages/protocol/memory";
import type { MemoryActor } from "../../apps/server-identity/memory";
import { CatalogCommand } from "../../packages/protocol/service-catalog";
import {
  CommandSchema,
  type Command,
  type Language,
  type Scope,
} from "../../packages/protocol";
import type { ModelMessage } from "../../apps/server-integrations/models";
import type {
  IntegrationTransport,
  TransportResponse,
} from "../../apps/server-integrations/transport";

export type ModelRequest = {
  model: string;
  max_tokens?: number;
  messages?: ModelMessage[];
  tools?: { function: { name: string; parameters?: unknown } }[];
  state?: Record<string, unknown>;
  questions?: {
    route: { criteria: Record<string, string>; instructions?: string };
  };
};

export type LiveTrustModel = {
  providerUrl: string;
  modelId: string;
  apiKey: string;
  maxOutputTokensPerRequest: number;
  reserve: (request: ModelRequest) => Promise<void>;
  fail?: (request: ModelRequest, error: unknown) => void | Promise<void>;
  transport: IntegrationTransport;
  observe?: (
    request: ModelRequest,
    response: TransportResponse,
    elapsedMs: number,
  ) => void | Promise<void>;
};
const activeLiveModel = new AsyncLocalStorage<LiveTrustModel | undefined>();

export function withLiveTrustModel<T>(
  model: LiveTrustModel | undefined,
  run: () => T,
) {
  return activeLiveModel.run(model, run);
}
/** Read the actual processor-projected evidence sent to the scripted provider. */
export function systemEvidence<T>(body: ModelRequest, label: string): T[] {
  return (body.messages ?? []).flatMap((message) => {
    if (message.role !== "system" || !message.content) return [];
    const offset = message.content.indexOf(label);
    if (offset < 0) return [];
    const encoded = message.content.slice(offset + label.length).split("\n")[0];
    assert(encoded, "Native model evidence must contain its JSON payload");
    return JSON.parse(encoded) as T[];
  });
}
export const toolResults = (body: ModelRequest): Record<string, any>[] => {
  const wire = (body.messages ?? [])
    .filter((m) => m.role === "tool")
    .map((m) => JSON.parse(m.content ?? "{}") as Record<string, any>);
  const receipts = systemEvidence<Record<string, any>>(
    body,
    "Authoritative scoped tool receipts (currentTurn distinguishes new reads): ",
  );
  const scoped = new Map(
    receipts.map((receipt) => [receipt.operationId, receipt]),
  );
  const observed = new Set(wire.map((result) => result.operationId));
  return [
    ...wire.map((result) =>
      typeof result.operationId === "string" && scoped.has(result.operationId)
        ? { ...result, ...scoped.get(result.operationId) }
        : result,
    ),
    ...systemEvidence<Record<string, any>>(
      body,
      "Current authorized memory tool results: ",
    ),
    ...receipts.filter((receipt) => !observed.has(receipt.operationId)),
  ];
};

/** Isolated, file-backed production stores; every transport call stays in this function. */
/** A scripted service answer with an HTTP status other than 200. */
export class ServiceStatus {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}
export function createTrustHarness(
  options: {
    writeApproval?: "always" | "never";
    checkpoint?: StorageCheckpoint;
    signal?: AbortSignal;
    directory?: string;
    reuseConfiguration?: boolean;
    cleanupDirectory?: boolean;
    liveModel?: LiveTrustModel;
    contacts?: { id: string; name: string; email: string }[];
  } = {},
) {
  const liveModel = options.liveModel ?? activeLiveModel.getStore();
  const root = options.directory ?? mkdtempSync(join(tmpdir(), "agent-trust-"));
  const target = {
    organizationId: "TEST-org",
    workspaceId: "11111111-1111-4111-8111-111111111111",
  };
  const scope = {
    serverId:
      "TEST-server-" +
      createHash("sha256").update(root).digest("hex").slice(0, 16),
    connectionId: `account-${target.workspaceId}`,
    workspaceId: target.workspaceId,
    userId: "TEST-alice",
  };
  const memoryActor = {
    ...target,
    userId: scope.userId,
    canManageShared: true,
  };
  const memorySettings = MemorySettingsSchema.parse({});
  const requests: ModelRequest[] = [];
  const network: { path: string; body: unknown }[] = [];
  const serviceRequests: { method: string; url: string; body: unknown }[] = [];
  let db: DatabaseSync,
    catalog: ServiceCatalogStore,
    controller: CatalogController,
    memoryStore: MemoryStore,
    workflow: FixtureStorage,
    model: ModelService;
  let pending: Promise<unknown> = Promise.resolve(),
    epoch = 0,
    auditId = 0,
    sequence = 0,
    closed = false;
  let currentTime = Date.now();
  let chat: (
    body: ModelRequest,
  ) => object | undefined | Promise<object | undefined> = () => ({
    content: "TEST answer",
  });
  let decision: ((body: ModelRequest) => string | undefined) | undefined;
  let providerResponse:
    | ((body: ModelRequest, message: object) => TransportResponse)
    | undefined;
  let beforeAction: (() => void | Promise<void>) | undefined,
    afterWrite: (() => void | Promise<void>) | undefined;
  /** A scripted answer for a service endpoint the harness does not declare. */
  let service:
    | ((request: {
        method: string;
        path: string;
        search: URLSearchParams;
        body: unknown;
      }) => unknown)
    | undefined;
  const ids: Record<string, string> = {};
  const serial = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const task = pending.then(fn);
    pending = task.catch(() => {});
    return task;
  };
  const context: CatalogContext = {
    serial,
    actor: async (t) => {
      assert.equal(
        t.organizationId,
        target.organizationId,
        "The authenticated organization must match",
      );
      assert.equal(
        t.workspaceId,
        target.workspaceId,
        "The authenticated workspace must match",
      );
      return { userId: scope.userId, role: "member" };
    },
    epoch: () => epoch,
    change: () => {
      epoch++;
    },
    audit: () => ++auditId,
    finish: () => {},
    transaction: async (fn) => {
      db.exec("BEGIN");
      try {
        const result = await fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const json = (value: unknown) => ({
    status: 200,
    headers: {},
    text: JSON.stringify(value),
  });
  const call = (name: string, args: unknown) => ({
    content: null,
    tool_calls: [
      {
        id: `TEST-call-${++sequence}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  const transport: IntegrationTransport = async (req) => {
    const url = new URL(req.url);
    const isModel = liveModel
      ? url.origin === new URL(liveModel.providerUrl).origin
      : url.hostname === "openrouter.ai";
    const liveCompletion =
      !!liveModel && isModel && url.pathname.endsWith("/chat/completions");
    assert(
      isModel || url.hostname === "services.example.test",
      "Unexpected synthetic transport destination",
    );
    if (!isModel) await beforeAction?.();
    if (!liveCompletion) await req.beforeDispatch?.(() => {});
    if (isModel) {
      const body = req.body as ModelRequest;
      requests.push(structuredClone(body));
      assert(requests.length <= 120, "Scenario inference budget exceeded");
      if (url.pathname.endsWith("/decisions")) {
        const criteria = body.questions!.route.criteria;
        let choice = decision?.(body);
        if (!choice) {
          if ("matches" in criteria) choice = "matches";
          else if ("complete" in criteria) choice = "complete";
          else if ("continue_work" in criteria) choice = "continue_work";
          else choice = Object.keys(criteria).find((key) => key !== "fallback");
        }
        assert(
          choice && Object.hasOwn(criteria, choice),
          "Script must choose an offered decision",
        );
        return json({
          answers: {
            route: {
              type: "choice",
              choice,
              confidence: 1,
              probabilities: Object.fromEntries(
                Object.keys(criteria).map((key) => [
                  key,
                  key === choice ? 1 : 0,
                ]),
              ),
            },
          },
        });
      }
      assert(url.pathname.endsWith("/chat/completions"));
      if (liveModel) {
        assert.equal(body.model, liveModel.modelId);
        const requestBody = {
          ...body,
          max_tokens: Math.min(
            body.max_tokens ?? liveModel.maxOutputTokensPerRequest,
            liveModel.maxOutputTokensPerRequest,
          ),
        };
        const liveRequest = { ...req, body: requestBody };
        const startedAt = performance.now();
        const response = await new Promise<TransportResponse>(
          (resolve, reject) => {
            let started = false;
            const start = () => {
              if (started) return;
              started = true;
              void (async () => {
                await liveModel.reserve(requestBody);
                try {
                  resolve(
                    await liveModel.transport({
                      ...liveRequest,
                      beforeDispatch: undefined,
                    }),
                  );
                } catch (error) {
                  await liveModel.fail?.(requestBody, error);
                  reject(error);
                }
              })().catch(reject);
            };
            if (req.beforeDispatch) {
              void req.beforeDispatch(start).then(() => {
                if (!started)
                  reject(
                    new Error("TEST live model dispatch was not admitted"),
                  );
              }, reject);
            } else start();
          },
        );
        await liveModel.observe?.(
          requestBody,
          response,
          Math.round(performance.now() - startedAt),
        );
        return response;
      }
      const message = await chat(body);
      assert(message, "Script must return a model message");
      return (
        providerResponse?.(body, message) ?? json({ choices: [{ message }] })
      );
    }
    network.push({ path: url.pathname, body: structuredClone(req.body) });
    serviceRequests.push({
      method: req.method ?? "GET",
      url: `${url.pathname}${url.search}`,
      body: structuredClone(req.body),
    });
    const scripted = service?.({
      method: req.method ?? "GET",
      path: url.pathname,
      search: url.searchParams,
      body: req.body,
    });
    if (scripted instanceof ServiceStatus)
      return {
        status: scripted.status,
        headers: {},
        text: JSON.stringify(scripted.body),
      };
    if (scripted !== undefined) return json(scripted);
    if (url.pathname.endsWith("/contacts")) {
      const contacts = options.contacts;
      if (!contacts)
        return json({
          contacts: [
            {
              id: "TEST-jane",
              name: "Jane Test",
              email: "jane@example.test",
            },
          ],
        });
      const query = url.searchParams.get("name")?.trim();
      const matching = query
        ? contacts.filter((contact) => {
            const normalize = (value: string) =>
              value
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLocaleLowerCase()
                .replace(/[^a-z0-9]+/g, " ")
                .trim();
            const expected = normalize(query);
            const candidate = normalize(contact.name);
            const expectedTokens = expected.split(/\s+/).filter(Boolean);
            const candidateTokens = candidate.split(/\s+/).filter(Boolean);
            const meaningfulTokens = expectedTokens.filter(
              (token) => token.length >= 3,
            );
            if (!meaningfulTokens.length) return false;
            return (
              candidate.includes(expected) ||
              expected.includes(candidate) ||
              meaningfulTokens.every((token) =>
                candidateTokens.some((part) => part.startsWith(token)),
              )
            );
          })
        : contacts;
      return json({ contacts: matching });
    }
    assert(
      url.pathname.endsWith("/meetings"),
      "Only declared synthetic service endpoints are allowed",
    );
    await afterWrite?.();
    if (h.writeResponse === "lost")
      throw Error("TEST response lost after dispatch");
    return json({ id: "TEST-created-meeting", created: true });
  };
  function open() {
    db = new DatabaseSync(join(root, "identity.sqlite"));
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS organization(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT);
      CREATE TABLE IF NOT EXISTS member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT);
      INSERT OR IGNORE INTO organization VALUES('TEST-org'),('TEST-other');
      INSERT OR IGNORE INTO user VALUES('TEST-alice'),('TEST-bob');
      INSERT OR IGNORE INTO agent_workspace VALUES('11111111-1111-4111-8111-111111111111','TEST-org'),('22222222-2222-4222-8222-222222222222','TEST-org');
      INSERT OR IGNORE INTO member VALUES('TEST-member','TEST-org','TEST-alice');`);
    catalog = new ServiceCatalogStore(db, "TEST-only-secret", []);
    memoryStore = new MemoryStore(db, {
      secret: "TEST-only-secret",
      now: () => currentTime,
    });
    controller = new CatalogController(catalog, transport);
    workflow = new FixtureStorage(
      join(root, "workflow"),
      scope.serverId,
      () => currentTime,
      options.checkpoint,
    );
    model = new ModelService(workflow, undefined, () => currentTime);
  }
  const command = (body: object) =>
    catalog.command(CatalogCommand.parse({ ...target, ...body }));
  function configure() {
    const serviceId = command({
      type: "saveService",
      revision: 0,
      settings: {
        name: "TEST Calendar and contacts",
        description: "Find contacts and create meetings",
        url: "https://services.example.test/v1",
        protocol: "openapi",
        icon: "calendar",
        auth: { type: "bearer" },
        enabled: true,
      },
      apiKey: "TEST-service-key",
    });
    for (const [name, path, effect] of [
      ["Find contact", "/contacts", "read"],
      ["Create meeting", "/meetings", "write"],
    ] as const) {
      ids[name] = command({
        type: "saveAction",
        serviceId,
        serviceRevision: catalog.service(target.workspaceId, serviceId)
          .revision,
        revision: 0,
        settings: {
          name: `TEST ${name}`,
          description: name,
          inputSchema: {
            type: "object",
            properties:
              effect === "read"
                ? { name: { type: "string" } }
                : {
                    body: {
                      type: "object",
                      properties: {
                        attendee: { type: "string" },
                        start: { type: "string" },
                        end: { type: "string" },
                      },
                      required: ["attendee", "start", "end"],
                      additionalProperties: false,
                    },
                  },
            required: effect === "read" ? ["name"] : ["body"],
            additionalProperties: false,
          },
          binding: {
            type: "http",
            method: effect === "read" ? "GET" : "POST",
            path,
            parameters:
              effect === "read"
                ? [{ name: "name", in: "query", required: true }]
                : [],
            body: effect === "write",
          },
          effect,
          approval:
            effect === "read" ? "never" : (options.writeApproval ?? "always"),
          enabled: true,
          policy: { roles: ["member"], users: [] },
        },
      });
    }
    const providerId = command({
      type: "saveProvider",
      revision: 0,
      settings: {
        name: "TEST scripted provider",
        url: liveModel?.providerUrl ?? "https://openrouter.ai/api/v1",
        enabled: true,
        dailyRequestLimit: 10000,
      },
      apiKey: liveModel?.apiKey ?? "TEST-model-key",
    });
    const addModel = (kind: "chat" | "decision") =>
      command({
        type: "saveModel",
        revision: 0,
        settings: {
          providerId,
          model:
            kind === "chat"
              ? (liveModel?.modelId ?? "TEST-agent")
              : "typesafe/jev-1.13",
          name: `TEST ${kind}`,
          enabled: true,
          tools: kind === "chat",
          kind,
        },
      });
    const modelId = addModel("chat"),
      decisionId = addModel("decision");
    command({
      type: "saveRouting",
      routing: {
        revision: 0,
        planner: "model",
        modelId,
        decision: { enabled: true, modelId: decisionId, minConfidence: 0.8 },
        services: [{ serviceId, modelId }],
      },
    });
  }
  const sourceAccess = (source: MemorySource, actor: MemoryActor) => {
    if (!h.sourceAllowed) return false;
    if (source.type !== "verified_operation") return true;
    try {
      return (
        catalog.contactSource(
          source.operationId,
          actor.organizationId,
          actor.workspaceId,
          { userId: actor.userId, role: "member" },
          30 * 60 * 1000,
        ).serviceId === source.serviceId
      );
    } catch {
      return false;
    }
  };
  const runtime = (runtimeContext: CatalogContext = context) =>
    createCatalogRuntime(
      controller,
      transport,
      runtimeContext,
      scope,
      target.organizationId,
      true,
      false,
      { enabled: ["datetime", "memory"], timeZone: "UTC" },
      createMemoryRuntime(memoryStore, memoryActor, memorySettings, {
        read: serial,
        mutate: (fn) => serial(fn),
        check: () => {},
        sourceAccess,
      }),
    );
  const executeAs = (
    principal: Scope,
    input: Command,
    signal = new AbortController().signal,
  ) =>
    model.execute(
      principal,
      CommandSchema.parse(input),
      () => {},
      options.signal ? AbortSignal.any([signal, options.signal]) : signal,
      {
        tools: {
          has: () => false,
          invoke: async () => {
            throw Error("Unexpected legacy tool");
          },
        },
        run: serial,
        integrations:
          principal.userId === scope.userId &&
          principal.workspaceId === scope.workspaceId
            ? runtime()
            : createCatalogRuntime(
                controller,
                transport,
                {
                  ...context,
                  actor: async (t) => {
                    assert.equal(t.organizationId, target.organizationId);
                    assert.equal(t.workspaceId, principal.workspaceId);
                    return { userId: principal.userId, role: "member" };
                  },
                },
                principal,
                target.organizationId,
                true,
                false,
                { enabled: ["datetime", "memory"], timeZone: "UTC" },
                createMemoryRuntime(
                  memoryStore,
                  {
                    ...memoryActor,
                    userId: principal.userId,
                    workspaceId: principal.workspaceId,
                  },
                  memorySettings,
                  {
                    read: serial,
                    mutate: (fn) => serial(fn),
                    check: () => {},
                    sourceAccess,
                  },
                ),
              ),
      },
    );
  const execute = (input: Command, signal = new AbortController().signal) =>
    executeAs(scope, input, signal);
  const h = {
    runtimeProfile: "mastra-1" as const,
    root,
    scope,
    target,
    memoryActor,
    memorySettings,
    requests,
    network,
    serviceRequests,
    context,
    sourceAllowed: true,
    writeResponse: "success" as "success" | "lost",
    get db() {
      return db;
    },
    get catalog() {
      return catalog;
    },
    get controller() {
      return controller;
    },
    get memoryStore() {
      return memoryStore;
    },
    get workflow() {
      return workflow;
    },
    get model() {
      return model;
    },
    attachmentState: (commandId: string) => {
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            scope.serverId,
            scope.workspaceId,
            scope.userId,
            commandId,
          ]),
        )
        .digest("hex");
      const raw = catalog.nativeAttachmentBinding(
        key,
        scope.workspaceId,
        scope.userId,
      );
      return raw === undefined
        ? undefined
        : NativeAttachmentBindingSchema.parse(raw);
    },
    commandState: (commandId?: string) => {
      if (commandId) {
        const state = db
          .prepare(
            "SELECT data FROM agent_service_turn WHERE workspace_id=? AND user_id=? AND json_extract(data,'$.kind')='mastra-1'",
          )
          .all(scope.workspaceId, scope.userId)
          .map((row) => DomainCommandSchema.parse(JSON.parse(String(row.data))))
          .find((entry) => entry.commandId === commandId);
        assert(
          state,
          "The native command must remain in the durable business journal",
        );
        return state;
      }
      const saved = catalog.latestTurn(scope.workspaceId, scope.userId);
      assert(
        saved,
        "The native command must be persisted by the production catalog",
      );
      return DomainCommandSchema.parse(saved.value);
    },
    nativeMessages: async (threadId: string) => {
      const resourceId = createHash("sha256")
        .update(
          JSON.stringify([
            scope.serverId,
            target.organizationId,
            scope.workspaceId,
            scope.userId,
          ]),
        )
        .digest("hex");
      return (
        await inspectNativeCatalogRuntime(controller, threadId, resourceId)
      ).messages;
    },
    nativeInvocations: async (threadId: string) => {
      const messages = await h.nativeMessages(threadId);
      return messages.flatMap((message) =>
        message.content.parts.flatMap((part) =>
          part.type === "tool-invocation" ? [part.toolInvocation] : [],
        ),
      );
    },
    runtime,
    execute,
    executeAs,
    command,
    call,
    tool: (name: string) => {
      assert(ids[name], `Unknown configured action ${name}`);
      return "action_" + ids[name]!.replaceAll("-", "_");
    },
    onChat: (fn: typeof chat) => {
      chat = fn;
    },
    onDecision: (fn: typeof decision) => {
      decision = fn;
    },
    onProviderResponse: (fn: typeof providerResponse) => {
      providerResponse = fn;
    },
    onBeforeActionDispatch: (fn: typeof beforeAction) => {
      beforeAction = fn;
    },
    onWrite: (fn: typeof afterWrite) => {
      afterWrite = fn;
    },
    onService: (fn: typeof service) => {
      service = fn;
    },
    send: (
      text: string,
      input: { id?: string; language?: Language; session?: "new" } = {},
    ) =>
      execute(
        CommandSchema.parse({
          type: "message.send",
          commandId: input.id ?? `TEST-message-${++sequence}`,
          idempotencyKey: input.id ?? `TEST-message-${sequence}`,
          conversationId: "conversation-1",
          text,
          language: input.language ?? "en",
          timeZone: "UTC",
          ...(input.session ? { session: input.session } : {}),
        }),
      ),
    lookupScript: (body: ModelRequest) => {
      const results = toolResults(body).filter((r) => r.currentTurn === true);
      if (!body.tools?.some((t) => t.function.name === h.tool("Find contact")))
        return call("find_actions", {
          service: "TEST Calendar and contacts",
          need: "find contact",
        });
      if (!results.some((r) => r.data?.contacts))
        return call(h.tool("Find contact"), { name: "Jane Test" });
      return { content: "Contact found." };
    },
    writeScript: (body: ModelRequest) => {
      const completed = body.messages?.findLast(
        (m) =>
          m.role === "user" &&
          m.content?.startsWith("[Server]") &&
          m.content?.includes("Result:"),
      );
      if (completed)
        return {
          content: completed.content?.includes('"status":"unknown"')
            ? "The outcome could not be verified. Check the service before repeating this action."
            : completed.content?.includes('"status":"rejected"')
              ? "Action cancelled."
              : "The meeting was created.",
        };
      const results = toolResults(body).filter((r) => r.currentTurn === true);
      if (results.some((result) => result.status === "unknown"))
        return {
          content:
            "The outcome could not be verified. Check the service before repeating this action.",
        };
      if (results.some((result) => result.status === "rejected"))
        return { content: "Action cancelled." };
      if (
        !body.tools?.some((t) => t.function.name === h.tool("Create meeting"))
      )
        return call("find_actions", {
          service: "TEST Calendar and contacts",
          need: "create meeting",
        });
      if (
        !results.some(
          (r) =>
            r.data?.created ||
            r.status === "unknown" ||
            r.status === "awaiting_approval",
        )
      )
        return call(h.tool("Create meeting"), {
          body: {
            attendee: "jane@example.test",
            start: "2026-10-01T12:00:00Z",
            end: "2026-10-01T12:30:00Z",
          },
        });
      return { content: "The meeting was created." };
    },
    now: () => currentTime,
    advance: (ms: number) => {
      currentTime += ms;
    },
    restart: async () => {
      await pending;
      await closeNativeCatalogRuntime(controller);
      await memoryStore.close();
      workflow.close();
      db.close();
      open();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await pending;
        await closeNativeCatalogRuntime(controller);
        await memoryStore.close();
      } finally {
        try {
          workflow.close();
        } finally {
          try {
            db.close();
          } finally {
            if (options.cleanupDirectory !== false)
              rmSync(root, { recursive: true, force: true });
          }
        }
      }
    },
  };
  try {
    open();
    if (!options.reuseConfiguration) configure();
    return h;
  } catch (error) {
    try {
      workflow!.close();
    } catch {}
    try {
      db!.close();
    } catch {}
    if (options.cleanupDirectory !== false)
      rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
export type TrustHarness = ReturnType<typeof createTrustHarness>;
