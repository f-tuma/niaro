import { DatabaseSync } from "node:sqlite";
import { CatalogCommand } from "../../packages/protocol/service-catalog";
import { ServiceCatalogStore } from "../../apps/server-identity/service-catalog";
import { WorkspacePluginStore } from "../../apps/server-identity/workspace-plugins";
import {
  ServiceProcessStore,
  type ProcessActor,
} from "../../apps/server-identity/service-processes";
import { ProcessDesignStore } from "../../apps/server-identity/process-design-store";
import { AuditStore } from "../../apps/server-identity/audit";
import { DEFAULT_PROCESS_LIMITS } from "../../apps/server-identity/process-validation";
import { processWorkflow, processObject } from "./service-process";
import type { ProcessDefinition } from "../../packages/protocol/service-processes";

export const designTarget = {
  organizationId: "TEST-design-org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
export const designActor: ProcessActor = {
  ...designTarget,
  userId: "TEST-designer-owner",
  role: "owner",
};
export function designFixture(
  path = ":memory:",
  options: { maxSteps?: number } = {},
) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS organization(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT,name TEXT);
    CREATE TABLE IF NOT EXISTS member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT);
    INSERT OR IGNORE INTO organization VALUES ('TEST-design-org'),('TEST-other-org');
    INSERT OR IGNORE INTO agent_workspace VALUES ('${designTarget.workspaceId}','TEST-design-org','TEST design'),('22222222-2222-4222-8222-222222222222','TEST-other-org','TEST other');
    INSERT OR IGNORE INTO member VALUES ('TEST-owner-member','TEST-design-org','TEST-designer-owner');`);
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
  let auditFailure = false;
  const registry = new ServiceProcessStore(
    db,
    catalog,
    plugins,
    (record) => {
      audit.append(record);
      if (auditFailure) throw Error("TEST audit rollback");
    },
    { limits: { ...DEFAULT_PROCESS_LIMITS, ...options } },
  );
  const store = new ProcessDesignStore(db, registry, catalog, plugins, () =>
    Date.parse("2026-10-04T12:00:00Z"),
  );
  const command = (value: object) =>
    catalog.command(CatalogCommand.parse({ ...designTarget, ...value }));
  const serviceId = command({
    type: "saveService",
    revision: 0,
    apiKey: "TEST-configured-key-never-project",
    settings: {
      name: "TEST service",
      url: "https://services.example.test/v1",
      protocol: "openapi",
      icon: "database",
      auth: { type: "header", header: "x-test-key" },
      enabled: true,
    },
  });
  const actionId = command({
    type: "saveAction",
    serviceId,
    serviceRevision: catalog.service(designTarget.workspaceId, serviceId)
      .revision,
    revision: 0,
    settings: {
      name: "TEST lookup",
      description: "",
      inputSchema: processObject({ name: { type: "string" } }),
      binding: {
        type: "http",
        method: "GET",
        path: "/items",
        parameters: [],
        body: false,
      },
      effect: "read",
      approval: "never",
      enabled: true,
      policy: { roles: ["owner", "admin"], users: [] },
    },
  });
  const providerId = command({
    type: "saveProvider",
    revision: 0,
    apiKey: "TEST-provider-key-never-project",
    settings: {
      name: "TEST provider",
      url: "https://models.example.test/v1",
      enabled: true,
      dailyRequestLimit: 100,
    },
  });
  const modelId = command({
    type: "saveModel",
    revision: 0,
    settings: {
      providerId,
      name: "TEST model",
      model: "TEST-tools",
      tools: true,
      enabled: true,
    },
  });
  const workflow = () => processWorkflow(serviceId, actionId);
  const agent = (): ProcessDefinition => ({
    schemaVersion: 1,
    kind: "agent",
    name: "TEST custom agent",
    description: "TEST explain lookup",
    trigger: "manual",
    inputSchema: processObject(),
    outputSchema: processObject(),
    limits: { ...DEFAULT_PROCESS_LIMITS, ...options },
    modelId,
    instructions: "Use only TEST configured lookup",
    capabilities: [{ serviceId, actionId }],
    memory: "conversation",
  });
  const setAction = (settings: object) => {
    const s = catalog.service(designTarget.workspaceId, serviceId),
      a = s.actions.find((a) => a.id === actionId)!;
    const { id: _id, revision: _revision, sourceKey: _sourceKey, ...old } = a;
    return command({
      type: "saveAction",
      id: actionId,
      serviceId,
      serviceRevision: s.revision,
      revision: a.revision,
      settings: { ...old, ...settings },
    });
  };
  return {
    db,
    catalog,
    plugins,
    audit,
    registry,
    store,
    command,
    serviceId,
    actionId,
    providerId,
    modelId,
    workflow,
    agent,
    setAction,
    failAudit: () => {
      auditFailure = true;
    },
    restoreAudit: () => {
      auditFailure = false;
    },
  };
}
