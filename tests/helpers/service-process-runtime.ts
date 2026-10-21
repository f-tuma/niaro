import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CatalogCommand } from "../../packages/protocol/service-catalog";
import {
  ProcessDefinitionSchema,
  type ProcessDefinition,
} from "../../packages/protocol/service-processes";
import { ServiceCatalogStore } from "../../apps/server-identity/service-catalog";
import {
  CatalogController,
  type CatalogContext,
} from "../../apps/server-identity/catalog-controller";
import {
  ServiceProcessStore,
  PROCESS_TEST_SCENARIOS,
} from "../../apps/server-identity/service-processes";
import { WorkspacePluginStore } from "../../apps/server-identity/workspace-plugins";
import { createServiceProcessRuntime } from "../../apps/server-identity/service-process-runtime";
import { closeNativeCatalogRuntime } from "../../apps/server-identity/mastra-runtime";
import { processDigest } from "../../apps/server-identity/process-validation";
import { AuditStore } from "../../apps/server-identity/audit";
import { IdentityError } from "../../apps/server-identity/error";
import { processObject, processWorkflow } from "./service-process";
import { MemoryStore } from "../../apps/server-identity/memory";
import { createMemoryRuntime } from "../../apps/server-identity/memory-runtime";
import { MemorySettingsSchema } from "../../packages/protocol/memory";
import type { ModelRequest } from "../agent-trust/harness";

export const target = {
  organizationId: "TEST-org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
export const scope = {
  serverId: "TEST-server",
  connectionId: "TEST-connection",
  workspaceId: target.workspaceId,
  userId: "TEST-user",
};
export const admin = {
  ...target,
  userId: scope.userId,
  role: "owner" as const,
};
export const signal = () => new AbortController().signal;
export const code = (name: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === name;

export function fixture(
  path: string,
  ids?: { serviceId: string; readId: string; writeId: string },
) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS organization(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE IF NOT EXISTS agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT,name TEXT);
    CREATE TABLE IF NOT EXISTS member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT);
    CREATE TABLE IF NOT EXISTS test_dispatch(id INTEGER PRIMARY KEY,method TEXT);
    CREATE TABLE IF NOT EXISTS test_model(id INTEGER PRIMARY KEY,body TEXT);
    INSERT OR IGNORE INTO organization VALUES ('TEST-org');
    INSERT OR IGNORE INTO user VALUES ('TEST-user','TEST user');
    INSERT OR IGNORE INTO agent_workspace VALUES ('${target.workspaceId}','TEST-org','TEST workspace');
    INSERT OR IGNORE INTO member VALUES ('TEST-member','TEST-org','TEST-user');`);
  const catalog = new ServiceCatalogStore(
    db,
    "TEST-only-encryption-secret",
    [],
  );
  const audit = new AuditStore(db);
  const plugins = new WorkspacePluginStore(db, {
    enabled: ["memory"],
    timeZone: "UTC",
  });
  const registry = new ServiceProcessStore(db, catalog, plugins, (record) => {
    audit.append(record);
  });
  const command = (body: object) =>
    catalog.command(CatalogCommand.parse({ ...target, ...body }));
  if (!ids) {
    const serviceId = command({
      type: "saveService",
      revision: 0,
      settings: {
        name: "TEST service",
        url: "https://crm.example.test/v1",
        protocol: "openapi",
        icon: "database",
        auth: { type: "none" },
        enabled: true,
      },
    });
    const action = (effect: "read" | "write") =>
      command({
        type: "saveAction",
        serviceId,
        serviceRevision: catalog.service(target.workspaceId, serviceId)
          .revision,
        revision: 0,
        settings: {
          name: `TEST ${effect}`,
          description: "",
          inputSchema: processObject({ name: { type: "string" } }),
          binding: {
            type: "http",
            method: effect === "read" ? "GET" : "POST",
            path: "/items",
            parameters: [],
            body: effect === "write",
          },
          effect,
          approval: effect === "write" ? "always" : "never",
          enabled: true,
          policy: { roles: ["owner", "admin", "member"], users: [] },
        },
      });
    ids = { serviceId, readId: action("read"), writeId: action("write") };
  }
  let allowed = true;
  let userId = scope.userId;
  let epoch = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const context: CatalogContext = {
    serial: (run) => {
      const pending = queue.then(run);
      queue = pending.catch(() => {});
      return pending;
    },
    actor: async (value) => {
      if (
        !allowed ||
        value.organizationId !== target.organizationId ||
        value.workspaceId !== target.workspaceId
      )
        throw new IdentityError(403, "identity_forbidden");
      return { userId, role: "member" };
    },
    epoch: () => epoch,
    change: () => {
      epoch++;
    },
    audit: (record) => audit.append(record),
    finish: (id, outcome, details) => audit.finish(id, outcome, details),
    transaction: async (run) => run(),
  };
  let mode: "success" | "unknown" | "bad_output" | "http_error" = "success";
  let beforeDispatch: (() => void | Promise<void>) | undefined;
  let modelScript: (body: ModelRequest) => object = () => ({
    content: '{"result":"TEST-model-result"}',
  });
  let beforeModel: (() => void | Promise<void>) | undefined;
  let afterModel: (() => void | Promise<void>) | undefined;
  let afterService: (() => void | Promise<void>) | undefined;
  let modelUsage: object | undefined = {
    prompt_tokens: 10,
    completion_tokens: 5,
    cost: 0.00002,
  };
  const controller = new CatalogController(catalog, async (request) => {
    if (new URL(request.url).origin === "https://models.example.test") {
      await beforeModel?.();
      await request.beforeDispatch!(() => {
        db.prepare("INSERT INTO test_model(body) VALUES(?)").run(
          JSON.stringify(request.body),
        );
      });
      const message = modelScript(request.body as ModelRequest);
      await afterModel?.();
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          choices: [{ message }],
          ...(modelUsage === undefined ? {} : { usage: modelUsage }),
        }),
      };
    }
    assert.equal(new URL(request.url).origin, "https://crm.example.test");
    assert(request.beforeDispatch);
    await beforeDispatch?.();
    await request.beforeDispatch(() => {
      db.prepare("INSERT INTO test_dispatch(method) VALUES(?)").run(
        request.method ?? "GET",
      );
    });
    if (mode === "unknown" && request.method === "POST")
      throw new DOMException("TEST lost response", "TimeoutError");
    await afterService?.();
    return {
      status: mode === "http_error" ? 422 : 200,
      headers: {},
      text: JSON.stringify(
        mode === "bad_output" ? { value: 42 } : { value: "TEST-result" },
      ),
    };
  });
  const memoryStore = new MemoryStore(db, {
    secret: "TEST-only-encryption-secret",
  });
  const memoryActor = {
    ...target,
    userId: scope.userId,
    canManageShared: true,
  };
  const memorySettings = MemorySettingsSchema.parse({});
  const memory = createMemoryRuntime(memoryStore, memoryActor, memorySettings, {
    read: (run) =>
      context.serial(async () => {
        await context.actor(target);
        return run();
      }),
    mutate: async () => {
      throw Error("TEST process saved-memory context is read-only");
    },
    check: () => {
      if (!allowed || userId !== scope.userId)
        throw new IdentityError(403, "identity_forbidden");
    },
    sourceAccess: () => true,
  });
  const runtime = createServiceProcessRuntime(
    controller,
    registry,
    context,
    scope,
    target.organizationId,
    { memory },
  );
  const activate = (definition: ProcessDefinition) => {
    const draft = registry.saveDraft(admin, {
      serviceId: ids!.serviceId,
      revision: 0,
      definition,
    });
    const version = registry.freezeDraft(admin, draft.id, draft.revision);
    // Trusted synthetic evidence only: no production activation endpoint exists.
    registry.recordTest(admin, draft.id, version.version, {
      testId: `TEST-${draft.id}`,
      digest: version.digest,
      runnerVersion: "TEST-offline/1",
      passed: true,
      scenarios: [...PROCESS_TEST_SCENARIOS],
      reportDigest: processDigest({ fixture: true }),
    });
    registry.activate(
      admin,
      draft.id,
      registry.get(admin, draft.id).revision,
      version.version,
    );
    return draft.id;
  };
  const basic = () => processWorkflow(ids!.serviceId, ids!.readId);
  const readWrite = () => {
    const definition = basic();
    assert(definition.kind === "workflow");
    return ProcessDefinitionSchema.parse({
      ...definition,
      steps: [
        definition.steps[0],
        {
          ...definition.steps[0],
          id: "write",
          actionId: ids!.writeId,
          input: {
            name: { source: "step", stepId: "lookup", path: ["value"] },
          },
          next: "done",
        },
        {
          ...definition.steps[1],
          output: {
            result: { source: "step", stepId: "write", path: ["value"] },
          },
        },
      ].map((s, i) => (i === 0 ? { ...s, next: "write" } : s)),
    });
  };
  let closed = false;
  return {
    db,
    catalog,
    registry,
    controller,
    context,
    runtime,
    ids,
    activate,
    basic,
    readWrite,
    memoryStore,
    memoryActor,
    memorySettings,
    memory,
    onModel: (script: typeof modelScript) => {
      modelScript = script;
    },
    onModelDispatch: (fn: typeof beforeModel) => {
      beforeModel = fn;
    },
    onModelResponse: (fn: typeof afterModel) => {
      afterModel = fn;
    },
    onServiceResponse: (fn: typeof afterService) => {
      afterService = fn;
    },
    setModelUsage: (usage: typeof modelUsage) => {
      modelUsage = usage;
    },
    models: () =>
      db
        .prepare("SELECT body FROM test_model ORDER BY id")
        .all()
        .map((r) => JSON.parse(String(r.body)) as ModelRequest),
    model: () => {
      const inventory = catalog.inventory(
        target.organizationId,
        target.workspaceId,
        admin,
      );
      let modelId = inventory.models[0]?.id;
      if (!modelId) {
        const providerId = command({
          type: "saveProvider",
          revision: 0,
          settings: {
            name: "TEST provider",
            url: "https://models.example.test/v1",
            enabled: true,
            dailyRequestLimit: 10000,
          },
          apiKey: "TEST-key",
        });
        modelId = command({
          type: "saveModel",
          revision: 0,
          settings: {
            providerId,
            name: "TEST model",
            model: "TEST-model",
            kind: "chat",
            tools: true,
            enabled: true,
          },
        });
        const selected = catalog.model(target.organizationId, modelId, "tools");
        catalog.inferenceBudget.savePolicy(
          target.organizationId,
          target.workspaceId,
          0,
          {
            mode: "enforce",
            maxTokens: 1000000,
            maxCostMicros: 10000000,
            prices: [
              {
                modelId,
                modelRevision: selected.model.revision,
                providerRevision: selected.provider.revision,
                maxInputTokens: 50000,
                maxOutputTokens: 1000,
                inputMicrosPerMillion: 1000000,
                outputMicrosPerMillion: 1000000,
              },
            ],
          },
        );
      }
      return modelId;
    },
    setMode: (value: typeof mode) => {
      mode = value;
    },
    revoke: () => {
      allowed = false;
    },
    switchActor: () => {
      userId = "TEST-other";
    },
    onDispatch: (fn: () => void | Promise<void>) => {
      beforeDispatch = fn;
    },
    counts: () =>
      db
        .prepare(
          "SELECT method,COUNT(*) AS count FROM test_dispatch GROUP BY method ORDER BY method",
        )
        .all()
        .map((r) => [r.method, r.count]),
    close: async () => {
      if (closed) return;
      closed = true;
      await closeNativeCatalogRuntime(controller);
      await memoryStore.close();
      db.close();
    },
  };
}
