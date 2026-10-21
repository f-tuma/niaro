// Real Niaro domain, service receipts and memory with an offline model and SIGKILL.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CatalogCommand } from "../../packages/protocol/service-catalog";
import { MemorySettingsSchema } from "../../packages/protocol/memory";
import {
  CatalogController,
  type CatalogContext,
} from "../../apps/server-identity/catalog-controller";
import { createCatalogRuntime } from "../../apps/server-identity/catalog-runtime";
import { ServiceCatalogStore } from "../../apps/server-identity/service-catalog";
import { DomainCommandSchema } from "../../apps/server-identity/mastra-domain";
import {
  closeNativeCatalogRuntime,
  inspectNativeCatalogRuntime,
} from "../../apps/server-identity/mastra-runtime";
import { MemoryStore } from "../../apps/server-identity/memory";
import { createMemoryRuntime } from "../../apps/server-identity/memory-runtime";
import type { IntegrationTransport } from "../../apps/server-integrations/transport";

export const previousPreference = "TEST old private preference";
export const correctedPreference = "TEST corrected private preference";
export const memoryCommandId = "TEST-production-memory-correction";
const target = {
  organizationId: "TEST-org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
const scope = {
  serverId: "TEST-memory-crash-server",
  connectionId: "TEST-connection",
  workspaceId: target.workspaceId,
  userId: "TEST-alice",
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const memoryActor = { ...target, userId: scope.userId, canManageShared: true };
export const crashMemoryActor = memoryActor;
const settings = MemorySettingsSchema.parse({});
const text = `Revise memory: ${JSON.stringify(previousPreference)} -> ${JSON.stringify(correctedPreference)}`;

type ModelBody = {
  messages?: { role: string; content?: string }[];
  questions?: { route: { criteria: Record<string, string> } };
};
function memoryResults(body: ModelBody): { items?: unknown[] }[] {
  const label = "Current authorized memory tool results: ";
  return (body.messages ?? []).flatMap((message) => {
    if (message.role !== "system" || !message.content) return [];
    const offset = message.content.indexOf(label);
    if (offset < 0) return [];
    return JSON.parse(
      message.content.slice(offset + label.length).split("\n")[0]!,
    ) as { items?: unknown[] }[];
  });
}

export async function runProductionDomainCrash(
  directory: string,
  mode: string,
) {
  const actionFixture = mode.startsWith("action-");
  const commandId = actionFixture
    ? "TEST-production-create-person"
    : memoryCommandId;
  const commandText = actionFixture ? "Create TEST Person in TEST CRM" : text;
  const db = new DatabaseSync(join(directory, "production.sqlite"));
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS organization(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT);
    CREATE TABLE IF NOT EXISTS member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT);
    CREATE TABLE IF NOT EXISTS production_authority(id INTEGER PRIMARY KEY,allowed INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS production_model_call(id INTEGER PRIMARY KEY,mode TEXT NOT NULL,has_receipt INTEGER NOT NULL,call_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS production_memory_call(id INTEGER PRIMARY KEY,mode TEXT NOT NULL,call_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS production_action_call(id INTEGER PRIMARY KEY,mode TEXT NOT NULL,operation_id TEXT NOT NULL,call_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS production_provider_effect(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
    INSERT OR IGNORE INTO organization VALUES('TEST-org');
    INSERT OR IGNORE INTO user VALUES('TEST-alice');
    INSERT OR IGNORE INTO agent_workspace VALUES('11111111-1111-4111-8111-111111111111','TEST-org');
    INSERT OR IGNORE INTO member VALUES('TEST-member','TEST-org','TEST-alice');
    INSERT OR IGNORE INTO production_authority VALUES(1,1);
  `);
  let pending: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => T | Promise<T>): Promise<T> => {
    const task = pending.then(run);
    pending = task.catch(() => {});
    return task;
  };
  const check = () => {
    if (
      db.prepare("SELECT allowed FROM production_authority WHERE id=1").get()
        ?.allowed !== 1
    )
      throw new Error("TEST-production-actor-revoked");
  };
  const context: CatalogContext = {
    serial,
    async actor(value) {
      check();
      if (
        value.organizationId !== target.organizationId ||
        value.workspaceId !== target.workspaceId
      )
        throw new Error("TEST-production-actor-scope");
      return { userId: scope.userId, role: "member" };
    },
    epoch: () => 0,
    change() {},
    audit: () => 1,
    finish() {},
    async transaction(run) {
      db.exec("BEGIN");
      try {
        const result = await run();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const transport: IntegrationTransport = async (request) => {
    check();
    if (new URL(request.url).hostname === "crm.example.test") {
      if (!actionFixture || request.method !== "POST")
        throw new Error("TEST unexpected CRM I/O");
      await request.beforeDispatch!(() => {
        db.prepare(
          "INSERT INTO production_provider_effect(name) VALUES(?)",
        ).run("TEST Person");
      });
      if (mode === "action-unknown-after")
        throw new DOMException(
          "TEST lost response after effect",
          "TimeoutError",
        );
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          id: "TEST-created-person",
          name: "TEST Person",
        }),
      };
    }
    if (new URL(request.url).hostname !== "openrouter.ai")
      throw new Error("TEST unexpected external I/O");
    await request.beforeDispatch?.(() => {});
    const body = request.body as ModelBody;
    let response: unknown;
    if (request.url.endsWith("/decisions")) {
      const criteria = body.questions!.route.criteria;
      const choice =
        ["complete", "matches", "continue_work"].find((key) =>
          Object.hasOwn(criteria, key),
        ) ??
        Object.keys(criteria).find((key) => key !== "fallback") ??
        Object.keys(criteria)[0]!;
      response = {
        answers: {
          route: {
            type: "choice",
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(
              Object.keys(criteria).map((key) => [key, key === choice ? 1 : 0]),
            ),
          },
        },
      };
    } else {
      const wire = (body.messages ?? []).flatMap((message) =>
        message.role === "tool" && message.content
          ? [
              JSON.parse(message.content) as {
                status?: string;
                service?: string;
                services?: { service: string }[];
                actions?: { tool: string }[];
              },
            ]
          : [],
      );
      const receipt = wire.findLast((result) => result.status !== undefined);
      const hasReceipt = actionFixture
        ? !!receipt
        : receipt?.status === "active";
      const service =
        wire.findLast((result) => typeof result.service === "string")
          ?.service ??
        wire.findLast((result) => result.services?.length)?.services?.[0]
          ?.service;
      const action = wire.findLast((result) => result.actions?.length)
        ?.actions?.[0];
      const id = randomUUID();
      db.prepare(
        "INSERT INTO production_model_call(mode,has_receipt,call_id) VALUES(?,?,?)",
      ).run(mode, hasReceipt ? 1 : 0, id);
      const saved = memoryResults(body)
        .flatMap((result) => result.items ?? [])
        .find((item) => {
          const value = item as { content?: string };
          return value.content === previousPreference;
        }) as { id: string; revision: number } | undefined;
      response = {
        choices: [
          {
            finish_reason: hasReceipt ? "stop" : "tool_calls",
            message: hasReceipt
              ? {
                  content: actionFixture
                    ? receipt?.status === "unknown"
                      ? "The action outcome is unknown. Check the service before retrying."
                      : "TEST Person was created."
                    : "TEST corrected preference saved",
                }
              : {
                  content: null,
                  tool_calls: [
                    {
                      id,
                      type: "function",
                      function: {
                        name: actionFixture
                          ? (action?.tool ??
                            (service ? "find_actions" : "find_service"))
                          : saved
                            ? "memory_revise"
                            : "memory_search",
                        arguments: JSON.stringify(
                          actionFixture
                            ? action
                              ? { name: "TEST Person" }
                              : service
                                ? {
                                    service,
                                    need: "Create TEST Person",
                                  }
                                : { need: "TEST CRM" }
                            : saved
                              ? {
                                  id: saved.id,
                                  revision: saved.revision,
                                  content: correctedPreference,
                                }
                              : { query: previousPreference },
                        ),
                      },
                    },
                  ],
                },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
    }
    return { status: 200, headers: {}, text: JSON.stringify(response) };
  };
  const catalog = new ServiceCatalogStore(db, "TEST-memory-crash-secret", []);
  const controller = new CatalogController(catalog, transport);
  const command = (value: object) =>
    catalog.command(CatalogCommand.parse({ ...target, ...value }));
  if (!catalog.routing(target.workspaceId).modelId) {
    const serviceId = actionFixture
      ? command({
          type: "saveService",
          revision: 0,
          settings: {
            name: "TEST CRM",
            url: "https://crm.example.test/api",
            protocol: "openapi",
            icon: "users",
            auth: { type: "none" },
            enabled: true,
          },
        })
      : undefined;
    if (serviceId)
      command({
        type: "saveAction",
        serviceId,
        serviceRevision: catalog.service(target.workspaceId, serviceId)
          .revision,
        revision: 0,
        settings: {
          name: "Create person",
          description: "Create a CRM person by their name",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
          binding: {
            type: "http",
            method: "POST",
            path: "/people",
            parameters: [],
            body: false,
          },
          effect: "write",
          approval: "never",
          enabled: true,
          policy: { roles: ["member"], users: [] },
        },
      });
    const providerId = command({
      type: "saveProvider",
      revision: 0,
      settings: {
        name: "TEST offline memory provider",
        url: "https://openrouter.ai/api/v1",
        enabled: true,
        dailyRequestLimit: 100,
      },
      apiKey: "TEST-offline-memory-key",
    });
    const modelId = command({
      type: "saveModel",
      revision: 0,
      settings: {
        providerId,
        name: "TEST offline memory model",
        model: "TEST/offline",
        enabled: true,
        tools: true,
        kind: "chat",
      },
    });
    const decisionId = command({
      type: "saveModel",
      revision: 0,
      settings: {
        providerId,
        name: "TEST offline decision",
        model: "typesafe/jev-1.13",
        enabled: true,
        tools: false,
        kind: "decision",
      },
    });
    command({
      type: "saveRouting",
      routing: {
        revision: 0,
        planner: "model",
        modelId,
        services: serviceId ? [{ serviceId, modelId }] : [],
        decision: { enabled: true, modelId: decisionId, minConfidence: 0.8 },
      },
    });
  }
  if (actionFixture) {
    const invokeAction = controller.invoke.bind(controller);
    controller.invoke = async (...args) => {
      const key = digest([
        scope.serverId,
        scope.workspaceId,
        scope.userId,
        commandId,
      ]);
      const state = DomainCommandSchema.parse(
        catalog.turn(key, target.workspaceId, scope.userId),
      );
      const callId = state.receipts.find(
        (receipt) => receipt.operationId === args[0].requestId,
      )!.callId;
      db.prepare(
        "INSERT INTO production_action_call(mode,operation_id,call_id) VALUES(?,?,?)",
      ).run(mode, args[0].requestId, callId);
      if (mode === "action-before") process.kill(process.pid, "SIGKILL");
      const receipt = await invokeAction(...args);
      if (mode === "action-succeeded-after" || mode === "action-unknown-after")
        process.kill(process.pid, "SIGKILL");
      return receipt;
    };
  }
  const memoryStore = new MemoryStore(db, {
    secret: "TEST-memory-crash-secret",
  });
  // A restart must not replay fixture seeding after the person erased its lineage.
  if (
    !db
      .prepare("SELECT 1 FROM agent_memory_request WHERE request_id=?")
      .get("TEST-original-private-preference")
  )
    await memoryStore.remember(memoryActor, {
      requestId: "TEST-original-private-preference",
      content: previousPreference,
      kind: "preference",
      source: { type: "user_note" },
      explicitIntent: true,
      settings,
    });
  const revise = memoryStore.revise.bind(memoryStore);
  if (mode === "memory-before") {
    memoryStore.revise = async (actor, input, checkpoint, sourceAccess) =>
      await revise(
        actor,
        input,
        (item) => {
          checkpoint?.(item);
          process.kill(process.pid, "SIGKILL");
        },
        sourceAccess,
      );
  } else if (mode === "memory-after") {
    memoryStore.revise = async (actor, input, checkpoint, sourceAccess) => {
      const item = await revise(actor, input, checkpoint, sourceAccess);
      process.kill(process.pid, "SIGKILL");
      return item;
    };
  }
  const memory = createMemoryRuntime(memoryStore, memoryActor, settings, {
    read: serial,
    mutate: serial,
    check,
    sourceAccess: () => true,
  });
  const invoke = memory.invoke!.bind(memory);
  memory.invoke = async (name, args, metadata) => {
    if (name === "memory_revise") {
      db.prepare(
        "INSERT INTO production_memory_call(mode,call_id) VALUES(?,?)",
      ).run(mode, metadata.callId);
    }
    return invoke(name, args, metadata);
  };
  const runtime = createCatalogRuntime(
    controller,
    transport,
    context,
    scope,
    target.organizationId,
    true,
    false,
    { enabled: actionFixture ? [] : ["memory"], timeZone: "UTC" },
    actionFixture ? undefined : memory,
  );
  try {
    const answer = await runtime.message(
      commandId,
      commandText,
      "en",
      [],
      new AbortController().signal,
      undefined,
      undefined,
      "UTC",
      { conversationId: "TEST-memory-conversation", session: "new" },
    );
    const key = digest([
      scope.serverId,
      scope.workspaceId,
      scope.userId,
      commandId,
    ]);
    const state = DomainCommandSchema.parse(
      catalog.turn(key, target.workspaceId, scope.userId),
    );
    const resourceId = digest([
      scope.serverId,
      target.organizationId,
      scope.workspaceId,
      scope.userId,
    ]);
    const native = await inspectNativeCatalogRuntime(
      controller,
      state.threadId,
      resourceId,
    );
    const calls = native.messages.flatMap((message) =>
      message.content.parts.flatMap((part) =>
        part.type === "tool-invocation" ? [part.toolInvocation] : [],
      ),
    );
    return {
      answer,
      runId: state.runId,
      threadId: state.threadId,
      receipts: state.memoryReceipts,
      nativeCalls: calls,
      memoryVersion: memoryStore.version(memoryActor),
    };
  } finally {
    await pending;
    await closeNativeCatalogRuntime(controller);
    await memoryStore.close();
    db.close();
  }
}
