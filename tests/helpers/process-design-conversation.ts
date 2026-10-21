import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CatalogCommand } from "../../packages/protocol/service-catalog";
import {
  CatalogController,
  type CatalogContext,
} from "../../apps/server-identity/catalog-controller";
import { ServiceCatalogStore } from "../../apps/server-identity/service-catalog";
import { ServiceProcessStore } from "../../apps/server-identity/service-processes";
import { ProcessDesignStore } from "../../apps/server-identity/process-design-store";
import { WorkspacePluginStore } from "../../apps/server-identity/workspace-plugins";
import { AuditStore } from "../../apps/server-identity/audit";
import { IdentityError } from "../../apps/server-identity/error";
import {
  closeNativeCatalogRuntime,
  inspectNativeCatalogRuntime,
  nativeCatalogOwner,
} from "../../apps/server-identity/mastra-runtime";
import { DEFAULT_PROCESS_LIMITS } from "../../apps/server-identity/process-validation";
import type { InferenceBudgetSettings } from "../../packages/protocol/inference-budget";
import type { ProcessActor } from "../../apps/server-identity/service-processes";
import type { ProcessDefinition } from "../../packages/protocol/service-processes";
import type { ModelRequest } from "../agent-trust/harness";
import { designActor, designFixture, designTarget } from "./process-design";

export const conversationTarget = designTarget;
export const conversationActor = designActor;
export const conversationSignal = () => new AbortController().signal;
export const conversationError = (code: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === code;

type ModelScript = (body: ModelRequest) => object | Promise<object>;
type ModelHook = (body: ModelRequest) => void | Promise<void>;

/** Actual catalog/native owner and isolated SQLite stores. This transport has no
 * live branch: a service, discovery, memory, or other network request fails here. */
export function designConversationFixture(
  path?: string,
  options: { maxSteps?: number; reuseConfiguration?: boolean } = {},
) {
  assert(
    !options.reuseConfiguration || path,
    "Reusing a fixture requires its explicit database path",
  );
  const directory = path
    ? undefined
    : mkdtempSync(join(tmpdir(), "niaro-design-conversation-"));
  const databasePath = path ?? join(directory!, "identity.sqlite");
  const processOptions =
    options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps };
  const openExisting = () => {
    const db = new DatabaseSync(databasePath);
    db.exec("PRAGMA foreign_keys=ON");
    const catalog = new ServiceCatalogStore(
      db,
      "TEST-only-encryption-secret",
      [],
    );
    const plugins = new WorkspacePluginStore(db, {
      enabled: ["memory"],
      timeZone: "UTC",
    });
    const audit = new AuditStore(db);
    const registry = new ServiceProcessStore(
      db,
      catalog,
      plugins,
      (record) => audit.append(record),
      { limits: { ...DEFAULT_PROCESS_LIMITS, ...processOptions } },
    );
    const store = new ProcessDesignStore(db, registry, catalog, plugins, () =>
      Date.parse("2026-10-04T12:00:00Z"),
    );
    const row = db
      .prepare("SELECT data FROM test_design_fixture_state WHERE id=1")
      .get();
    assert(row, "Synthetic fixture configuration must already exist");
    const state = JSON.parse(String(row.data)) as {
      serviceId: string;
      actionId: string;
      providerId: string;
      modelId: string;
      workflow: ProcessDefinition;
      agent: ProcessDefinition;
    };
    return {
      db,
      catalog,
      plugins,
      audit,
      registry,
      store,
      serviceId: state.serviceId,
      actionId: state.actionId,
      providerId: state.providerId,
      modelId: state.modelId,
      workflow: () => structuredClone(state.workflow),
      agent: () => structuredClone(state.agent),
    };
  };
  const seeded = options.reuseConfiguration
    ? openExisting()
    : designFixture(databasePath, processOptions);
  const { serviceId, actionId, providerId, modelId } = seeded;
  let { db, catalog, registry, store, audit, plugins } = seeded;
  db.exec(
    "CREATE TABLE IF NOT EXISTS test_design_fixture_state (id INTEGER PRIMARY KEY,data TEXT NOT NULL) STRICT",
  );
  if (!options.reuseConfiguration)
    db.prepare("INSERT INTO test_design_fixture_state VALUES(1,?)").run(
      JSON.stringify({
        serviceId,
        actionId,
        providerId,
        modelId,
        workflow: seeded.workflow(),
        agent: seeded.agent(),
      }),
    );
  db.exec(`CREATE TABLE IF NOT EXISTS test_design_model (
      id INTEGER PRIMARY KEY, body TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS test_design_transport (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL
    ) STRICT;`);
  const scope = {
    serverId: "TEST-design-server",
    connectionId: "TEST-design-connection",
    workspaceId: designTarget.workspaceId,
    userId: designActor.userId,
  };
  let allowed = true;
  let userId = designActor.userId;
  let role: ProcessActor["role"] = "owner";
  let epoch = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let sequence = 0;
  let modelScript: ModelScript = () => ({ content: "TEST design reply" });
  let beforeModel: ModelHook | undefined;
  let afterModel: ModelHook | undefined;
  let modelUsage: object | undefined = {
    prompt_tokens: 10,
    completion_tokens: 5,
    cost: 0.00002,
  };
  let modelStatus = 200;
  const context: CatalogContext = {
    serial: (run) => {
      const result = queue.then(run);
      queue = result.catch(() => {});
      return result;
    },
    actor: async (target) => {
      if (
        !allowed ||
        target.organizationId !== designTarget.organizationId ||
        target.workspaceId !== designTarget.workspaceId
      )
        throw new IdentityError(403, "identity_forbidden");
      return { userId, role };
    },
    session: async () => {
      if (!allowed) throw new IdentityError(403, "identity_forbidden");
      return { userId, sessionId: "TEST-authenticated-session" };
    },
    epoch: () => epoch,
    change: () => {
      epoch++;
    },
    audit: (record) => audit.append(record),
    finish: (id, outcome, details) => audit.finish(id, outcome, details),
    transaction: async (run) => {
      db.exec("SAVEPOINT test_design_context");
      try {
        const result = await run();
        db.exec("RELEASE test_design_context");
        return result;
      } catch (error) {
        db.exec("ROLLBACK TO test_design_context; RELEASE test_design_context");
        throw error;
      }
    },
  };
  const createController = () =>
    new CatalogController(catalog, async (request) => {
      const isModel =
        new URL(request.url).origin === "https://models.example.test";
      db.prepare("INSERT INTO test_design_transport(kind) VALUES(?)").run(
        isModel ? "model" : "service",
      );
      assert(
        isModel,
        "The designer must not call a business or remote service",
      );
      assert(request.beforeDispatch, "Native inference needs its domain guard");
      const body = request.body as ModelRequest;
      await beforeModel?.(body);
      await request.beforeDispatch(() => {
        db.prepare("INSERT INTO test_design_model(body) VALUES(?)").run(
          JSON.stringify(body),
        );
      });
      assert(
        modelCount() <= 100,
        "Synthetic conversation exceeded its dispatch limit",
      );
      const message = await modelScript(structuredClone(body));
      await afterModel?.(body);
      return {
        status: modelStatus,
        headers: {},
        text: JSON.stringify({
          choices: [{ message }],
          ...(modelUsage === undefined ? {} : { usage: modelUsage }),
        }),
      };
    });
  let controller = createController();
  const command = (value: object) =>
    catalog.command(CatalogCommand.parse({ ...designTarget, ...value }));
  const budgetSettings = (
    changes: Partial<InferenceBudgetSettings> = {},
  ): InferenceBudgetSettings => {
    const selected = catalog.model(
      designTarget.organizationId,
      modelId,
      "tools",
    );
    return {
      mode: "enforce",
      maxTokens: 10_000_000,
      maxCostMicros: 100_000_000,
      prices: [
        {
          modelId,
          modelRevision: selected.model.revision,
          providerRevision: selected.provider.revision,
          maxInputTokens: 100_000,
          maxOutputTokens: 10_000,
          inputMicrosPerMillion: 1_000_000,
          outputMicrosPerMillion: 1_000_000,
        },
      ],
      ...changes,
    };
  };
  const setBudget = (changes: Partial<InferenceBudgetSettings> = {}) => {
    const prior = catalog.inferenceBudget.policy(
      designTarget.organizationId,
      designTarget.workspaceId,
    );
    return catalog.inferenceBudget.savePolicy(
      designTarget.organizationId,
      designTarget.workspaceId,
      prior.revision,
      budgetSettings(changes),
    );
  };
  if (!options.reuseConfiguration) setBudget();
  const modelCount = () =>
    Number(
      db.prepare("SELECT COUNT(*) AS count FROM test_design_model").get()!
        .count,
    );
  const models = () =>
    db
      .prepare("SELECT body FROM test_design_model ORDER BY id")
      .all()
      .map((row) => JSON.parse(String(row.body)) as ModelRequest);
  const call = (
    name: string,
    args: unknown,
    id = `TEST-call-${++sequence}`,
  ) => ({
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  const setAction = (settings: object) => {
    const service = catalog.service(designTarget.workspaceId, serviceId);
    const action = service.actions.find((item) => item.id === actionId)!;
    const {
      id: _id,
      revision: _revision,
      sourceKey: _sourceKey,
      ...prior
    } = action;
    return command({
      type: "saveAction",
      id: actionId,
      serviceId,
      serviceRevision: service.revision,
      revision: action.revision,
      settings: { ...prior, ...settings },
    });
  };
  const closeStores = async () => {
    await queue;
    await closeNativeCatalogRuntime(controller);
    db.close();
  };
  return {
    path: databasePath,
    scope,
    target: designTarget,
    actor: designActor,
    context,
    get db() {
      return db;
    },
    get catalog() {
      return catalog;
    },
    get registry() {
      return registry;
    },
    get store() {
      return store;
    },
    get audit() {
      return audit;
    },
    get plugins() {
      return plugins;
    },
    get controller() {
      return controller;
    },
    serviceId,
    actionId,
    providerId,
    modelId,
    command,
    workflow: seeded.workflow,
    agent: seeded.agent,
    setAction,
    setBudget,
    budgetSettings,
    call,
    models,
    modelCount,
    serviceCount: () =>
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM test_design_transport WHERE kind='service'",
          )
          .get()!.count,
      ),
    onModel: (script: ModelScript) => {
      modelScript = script;
    },
    onModelDispatch: (hook: ModelHook | undefined) => {
      beforeModel = hook;
    },
    onModelResponse: (hook: ModelHook | undefined) => {
      afterModel = hook;
    },
    setModelUsage: (usage: object | undefined) => {
      modelUsage = usage;
    },
    setModelStatus: (status: number) => {
      modelStatus = status;
    },
    revoke: () => {
      allowed = false;
      epoch++;
    },
    restore: () => {
      allowed = true;
      epoch++;
    },
    switchActor: (next = "TEST-other-designer") => {
      userId = next;
      epoch++;
    },
    setRole: (next: ProcessActor["role"]) => {
      role = next;
      epoch++;
    },
    nativeOwner: () => nativeCatalogOwner(controller),
    nativeMessages: async (threadId: string, resourceId: string) =>
      (await inspectNativeCatalogRuntime(controller, threadId, resourceId))
        .messages,
    reopen: async () => {
      assert(!closed, "Cannot reopen a disposed fixture");
      assert(
        databasePath !== ":memory:",
        "Reopen requires a file-backed fixture",
      );
      await closeStores();
      db = new DatabaseSync(databasePath);
      db.exec("PRAGMA foreign_keys=ON");
      catalog = new ServiceCatalogStore(db, "TEST-only-encryption-secret", []);
      plugins = new WorkspacePluginStore(db, {
        enabled: ["memory"],
        timeZone: "UTC",
      });
      audit = new AuditStore(db);
      registry = new ServiceProcessStore(
        db,
        catalog,
        plugins,
        (record) => audit.append(record),
        {
          limits: { ...DEFAULT_PROCESS_LIMITS, ...processOptions },
        },
      );
      store = new ProcessDesignStore(db, registry, catalog, plugins, () =>
        Date.parse("2026-10-04T12:00:00Z"),
      );
      controller = createController();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await closeStores();
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
}
