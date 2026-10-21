import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import type { CatalogContext } from "../../../apps/server-identity/catalog-controller.ts";
import type {
  CatalogActor,
  StoredInvocation,
} from "../../../apps/server-identity/service-catalog.ts";
import type { IntegrationTransport } from "../../../apps/server-integrations/transport.ts";

// The spike is ESM; the application remains CommonJS. tsx registers this bridge.
const require = createRequire(import.meta.url);
const { ActionInvokeRequest, CatalogCommand } =
  require("../../../packages/protocol/service-catalog.ts") as typeof import("../../../packages/protocol/service-catalog.ts");
const { CatalogController } =
  require("../../../apps/server-identity/catalog-controller.ts") as typeof import("../../../apps/server-identity/catalog-controller.ts");
const { ServiceCatalogStore } =
  require("../../../apps/server-identity/service-catalog.ts") as typeof import("../../../apps/server-identity/service-catalog.ts");
const { IdentityError } =
  require("../../../apps/server-identity/error.ts") as typeof import("../../../apps/server-identity/error.ts");

export type { StoredInvocation };
export type Scope = {
  organizationId: string;
  workspaceId: string;
  userId: string;
};
export const TEST_SCOPE: Readonly<Scope> = Object.freeze({
  organizationId: "TEST-org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  userId: "TEST-user",
});
export type TestPerson = { id: string; name: string };
export type NiaroBoundary = {
  prepare(
    scope: Scope,
    operationId: string,
    input: { name: string },
  ): Promise<StoredInvocation>;
  approve(scope: Scope, operationId: string): Promise<StoredInvocation>;
  reject(scope: Scope, operationId: string): Promise<StoredInvocation>;
  read(scope: Scope, operationId: string): StoredInvocation | undefined;
  revoke(): void;
  verify(
    scope: Scope,
    operationId: string,
  ): { found: boolean; person?: TestPerson };
  setLoseResponse(value: boolean): void;
  dispatchCount(): number;
  close(): void;
};

/** Actual Niaro policy/receipts with isolated fixture DBs; no agent or network loop. */
export function createNiaroBoundary(directory: string): NiaroBoundary {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const identityFile = join(directory, "niaro.sqlite"),
    providerFile = join(directory, "provider.sqlite");
  const db = new DatabaseSync(identityFile),
    provider = new DatabaseSync(providerFile);
  chmodSync(identityFile, 0o600);
  chmodSync(providerFile, 0o600);
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS organization(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE IF NOT EXISTS agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id)) STRICT;
    CREATE TABLE IF NOT EXISTS member(id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES organization(id), "userId" TEXT NOT NULL, role TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS test_actor_grant(organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(organization_id,workspace_id,user_id)) STRICT;
    CREATE TABLE IF NOT EXISTS test_policy(organization_id TEXT PRIMARY KEY, revision INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS test_catalog_binding(singleton INTEGER PRIMARY KEY CHECK(singleton=1), service_id TEXT NOT NULL, action_id TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS agent_audit(id INTEGER PRIMARY KEY, outcome TEXT NOT NULL, data TEXT NOT NULL) STRICT;
  `);
  provider.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS test_people(operation_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, person_id TEXT NOT NULL, name TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS test_dispatch(id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL) STRICT;
  `);
  db.prepare("INSERT OR IGNORE INTO organization VALUES (?)").run(
    TEST_SCOPE.organizationId,
  );
  db.prepare("INSERT OR IGNORE INTO agent_workspace VALUES (?,?)").run(
    TEST_SCOPE.workspaceId,
    TEST_SCOPE.organizationId,
  );
  db.prepare("INSERT OR IGNORE INTO member VALUES (?,?,?,?)").run(
    "TEST-member",
    TEST_SCOPE.organizationId,
    TEST_SCOPE.userId,
    "member",
  );
  db.prepare("INSERT OR IGNORE INTO test_actor_grant VALUES (?,?,?,1)").run(
    TEST_SCOPE.organizationId,
    TEST_SCOPE.workspaceId,
    TEST_SCOPE.userId,
  );
  db.prepare("INSERT OR IGNORE INTO test_policy VALUES (?,0)").run(
    TEST_SCOPE.organizationId,
  );
  const store = new ServiceCatalogStore(
    db,
    "TEST-only-mastra-spike-secret",
    [],
  );
  let binding = db
    .prepare(
      "SELECT service_id,action_id FROM test_catalog_binding WHERE singleton=1",
    )
    .get();
  if (!binding) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const command = (value: object) =>
        store.command(
          CatalogCommand.parse({
            organizationId: TEST_SCOPE.organizationId,
            workspaceId: TEST_SCOPE.workspaceId,
            ...value,
          }),
        );
      const serviceId = command({
        type: "saveService",
        revision: 0,
        settings: {
          name: "TEST CRM",
          description: "Only isolated synthetic TEST people.",
          url: "https://crm.example.test/api",
          protocol: "openapi",
          icon: "users",
          auth: { type: "none" },
          enabled: true,
          access: { roles: ["member"], workspaceRoles: [] },
        },
      });
      const actionId = command({
        type: "saveAction",
        serviceId,
        serviceRevision: store.service(TEST_SCOPE.workspaceId, serviceId)
          .revision,
        revision: 0,
        settings: {
          name: "TEST create person",
          description:
            "Create a synthetic person in the isolated TEST provider.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 100 },
            },
            required: ["name"],
            additionalProperties: false,
          },
          binding: {
            type: "http",
            method: "POST",
            path: "/people",
            parameters: [{ name: "name", in: "query", required: true }],
            body: false,
          },
          effect: "write",
          approval: "always",
          enabled: true,
          policy: { roles: ["member"], users: [] },
        },
      });
      db.prepare("INSERT INTO test_catalog_binding VALUES (1,?,?)").run(
        serviceId,
        actionId,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      provider.close();
      db.close();
      throw error;
    }
    binding = db
      .prepare(
        "SELECT service_id,action_id FROM test_catalog_binding WHERE singleton=1",
      )
      .get();
  }
  const serviceId = String(binding!.service_id),
    actionId = String(binding!.action_id);
  const dispatchScope = new AsyncLocalStorage<{
    scope: Scope;
    operationId: string;
  }>();
  let loseResponse = false,
    closed = false,
    activeCalls = 0;
  let queue: Promise<unknown> = Promise.resolve();

  function actor(scope: Scope): CatalogActor {
    if (closed) throw new IdentityError(503, "identity_unavailable");
    if (
      scope.organizationId !== TEST_SCOPE.organizationId ||
      scope.workspaceId !== TEST_SCOPE.workspaceId ||
      scope.userId !== TEST_SCOPE.userId
    )
      throw new IdentityError(403, "identity_forbidden");
    const granted = db
      .prepare(
        `
      SELECT m.role FROM member m JOIN test_actor_grant g
      ON g.organization_id=m."organizationId" AND g.user_id=m."userId"
      WHERE g.organization_id=? AND g.workspace_id=? AND g.user_id=? AND g.active=1
    `,
      )
      .get(scope.organizationId, scope.workspaceId, scope.userId);
    if (
      !granted ||
      !["owner", "admin", "member"].includes(String(granted.role))
    )
      throw new IdentityError(403, "identity_forbidden");
    return {
      userId: scope.userId,
      role: String(granted.role) as CatalogActor["role"],
    };
  }
  function context(scope: Scope): CatalogContext {
    return {
      serial: (run) => {
        const result = queue.then(run);
        queue = result.catch(() => {});
        return result;
      },
      actor: async (target) => {
        if (
          target.organizationId !== scope.organizationId ||
          target.workspaceId !== scope.workspaceId
        )
          throw new IdentityError(403, "identity_forbidden");
        return actor(scope);
      },
      epoch: (organizationId) => {
        if (organizationId !== scope.organizationId)
          throw new IdentityError(403, "identity_forbidden");
        return Number(
          db
            .prepare("SELECT revision FROM test_policy WHERE organization_id=?")
            .get(organizationId)?.revision,
        );
      },
      change: (organizationId) => {
        if (organizationId !== scope.organizationId)
          throw new IdentityError(403, "identity_forbidden");
        db.prepare(
          "UPDATE test_policy SET revision=revision+1 WHERE organization_id=?",
        ).run(organizationId);
      },
      audit: (record) =>
        Number(
          db
            .prepare("INSERT INTO agent_audit(outcome,data) VALUES (?,?)")
            .run(record.outcome, JSON.stringify(record)).lastInsertRowid,
        ),
      finish: (id, outcome, details) => {
        db.prepare(
          "UPDATE agent_audit SET outcome=?,data=json_set(data,'$.details',json(?)) WHERE id=?",
        ).run(outcome, JSON.stringify(details), id);
      },
      transaction: async (run) => {
        db.exec("BEGIN IMMEDIATE");
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
  }
  const transport: IntegrationTransport = async (request) => {
    const trusted = dispatchScope.getStore(),
      url = new URL(request.url);
    if (
      !trusted ||
      url.origin !== "https://crm.example.test" ||
      url.pathname !== "/api/people" ||
      request.method !== "POST"
    )
      throw new Error("Only the isolated TEST provider can dispatch.");
    const name = url.searchParams.get("name");
    if (!name || name.length > 100)
      throw new Error("Invalid TEST person name.");
    request.signal?.throwIfAborted();
    let dispatched = false;
    const person: TestPerson = {
      id:
        "TEST-person-" +
        createHash("sha256")
          .update(trusted.operationId)
          .digest("hex")
          .slice(0, 16),
      name,
    };
    const start = () => {
      if (dispatched) throw new Error("Duplicate TEST dispatch callback.");
      request.signal?.throwIfAborted();
      provider.exec("BEGIN IMMEDIATE");
      try {
        provider
          .prepare("INSERT INTO test_dispatch(operation_id) VALUES (?)")
          .run(trusted.operationId);
        provider
          .prepare("INSERT INTO test_people VALUES (?,?,?,?,?,?)")
          .run(
            trusted.operationId,
            trusted.scope.organizationId,
            trusted.scope.workspaceId,
            trusted.scope.userId,
            person.id,
            person.name,
          );
        provider.exec("COMMIT");
        dispatched = true;
      } catch (error) {
        provider.exec("ROLLBACK");
        throw error;
      }
    };
    if (!request.beforeDispatch)
      throw new Error("Missing Niaro dispatch guard.");
    await request.beforeDispatch(start);
    if (!dispatched) throw new Error("The Niaro guard did not dispatch.");
    if (loseResponse)
      throw new DOMException(
        "TEST response lost after durable write.",
        "TimeoutError",
      );
    return { status: 200, headers: {}, text: JSON.stringify({ person }) };
  };
  const controller = new CatalogController(store, transport);
  async function invoke(
    scope: Scope,
    request: ReturnType<typeof ActionInvokeRequest.parse>,
  ) {
    actor(scope);
    activeCalls++;
    try {
      return await controller.withTurn(request.requestId, () =>
        dispatchScope.run(
          { scope: { ...scope }, operationId: request.requestId },
          () =>
            controller.invoke(
              request,
              context({ ...scope }),
              new AbortController().signal,
              "chat",
            ),
        ),
      );
    } finally {
      activeCalls--;
    }
  }
  function read(scope: Scope, operationId: string) {
    actor(scope);
    const receipt = store.invocation(
      operationId,
      scope.workspaceId,
      scope.userId,
    );
    if (receipt && receipt.organizationId !== scope.organizationId)
      throw new IdentityError(403, "identity_forbidden");
    return receipt;
  }
  return {
    async prepare(scope, operationId, input) {
      actor(scope);
      const service = store.service(scope.workspaceId, serviceId),
        action = service.actions.find((value) => value.id === actionId);
      if (!action) throw new IdentityError(404, "catalog_not_found");
      return invoke(
        scope,
        ActionInvokeRequest.parse({
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
          serviceId,
          serviceRevision: service.revision,
          actionId,
          revision: action.revision,
          input: { ...input },
          requestId: operationId,
          approve: false,
        }),
      );
    },
    async approve(scope, operationId) {
      const receipt = read(scope, operationId);
      if (!receipt) throw new IdentityError(404, "catalog_not_found");
      return invoke(
        scope,
        ActionInvokeRequest.parse({
          organizationId: receipt.organizationId,
          workspaceId: receipt.workspaceId,
          serviceId: receipt.serviceId,
          serviceRevision: receipt.serviceRevision,
          actionId: receipt.actionId,
          revision: receipt.actionRevision,
          input: receipt.input,
          requestId: receipt.id,
          approve: true,
        }),
      );
    },
    async reject(scope, operationId) {
      activeCalls++;
      try {
        return await context({ ...scope }).serial(async () => {
          const receipt = read(scope, operationId);
          if (!receipt) throw new IdentityError(404, "catalog_not_found");
          if (receipt.status === "awaiting_approval") {
            receipt.status = "rejected";
            store.saveInvocation(receipt);
          }
          return receipt;
        });
      } finally {
        activeCalls--;
      }
    },
    read,
    revoke() {
      if (closed) throw new IdentityError(503, "identity_unavailable");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE test_actor_grant SET active=0 WHERE organization_id=? AND workspace_id=? AND user_id=?",
        ).run(
          TEST_SCOPE.organizationId,
          TEST_SCOPE.workspaceId,
          TEST_SCOPE.userId,
        );
        db.prepare(
          "UPDATE test_policy SET revision=revision+1 WHERE organization_id=?",
        ).run(TEST_SCOPE.organizationId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    verify(scope, operationId) {
      if (!read(scope, operationId)) return { found: false };
      const person = provider
        .prepare(
          "SELECT person_id,name FROM test_people WHERE operation_id=? AND organization_id=? AND workspace_id=? AND user_id=?",
        )
        .get(
          operationId,
          scope.organizationId,
          scope.workspaceId,
          scope.userId,
        );
      return person
        ? {
            found: true,
            person: { id: String(person.person_id), name: String(person.name) },
          }
        : { found: false };
    },
    setLoseResponse(value) {
      loseResponse = value;
    },
    dispatchCount() {
      if (closed) throw new IdentityError(503, "identity_unavailable");
      return Number(
        provider.prepare("SELECT COUNT(*) AS count FROM test_dispatch").get()!
          .count,
      );
    },
    close() {
      if (closed) return;
      if (activeCalls)
        throw new Error("Await active Niaro calls before closing.");
      closed = true;
      provider.close();
      db.close();
    },
  };
}
