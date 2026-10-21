import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import {
  ProcessDefinitionSchema,
  type ProcessDefinition,
} from "../packages/protocol/service-processes";
import { ServiceCatalogStore } from "../apps/server-identity/service-catalog";
import { WorkspacePluginStore } from "../apps/server-identity/workspace-plugins";
import {
  ServiceProcessStore,
  PROCESS_TEST_SCENARIOS,
  type ProcessActor,
} from "../apps/server-identity/service-processes";
import {
  DEFAULT_PROCESS_LIMITS,
  processDigest,
} from "../apps/server-identity/process-validation";
import { AuditStore } from "../apps/server-identity/audit";
import { IdentityError } from "../apps/server-identity/error";
import { processObject, processWorkflow } from "./helpers/service-process";

export const target = {
  organizationId: "TEST-org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
const actor: ProcessActor = { ...target, userId: "TEST-owner", role: "owner" };
const elsewhere: ProcessActor = {
  organizationId: "TEST-other",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  userId: "TEST-other-user",
  role: "owner",
};
function fixture(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS organization(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT,name TEXT);
    CREATE TABLE IF NOT EXISTS member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT);
    INSERT OR IGNORE INTO organization VALUES ('TEST-org'),('TEST-other');
    INSERT OR IGNORE INTO agent_workspace VALUES ('${target.workspaceId}','TEST-org','TEST workspace'),('${elsewhere.workspaceId}','TEST-other','TEST other');
    INSERT OR IGNORE INTO member VALUES ('TEST-member','TEST-org','TEST-member-user');`);
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
  let failAudit = false;
  const registry = (limits = DEFAULT_PROCESS_LIMITS) =>
    new ServiceProcessStore(
      db,
      catalog,
      plugins,
      (record) => {
        audit.append(record);
        if (failAudit) throw Error("TEST audit failed");
      },
      { limits },
    );
  const store = registry();
  const command = (body: object) =>
    catalog.command(CatalogCommand.parse({ ...target, ...body }));
  const serviceId = command({
    type: "saveService",
    revision: 0,
    settings: {
      name: "TEST service",
      url: "https://services.example.test/v1",
      protocol: "openapi",
      icon: "database",
      auth: { type: "none" },
      enabled: true,
    },
  });
  const actionId = command({
    type: "saveAction",
    serviceId,
    serviceRevision: catalog.service(target.workspaceId, serviceId).revision,
    revision: 0,
    settings: {
      name: "TEST lookup",
      description: "",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
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
      policy: { roles: ["owner", "admin", "member"], users: [] },
    },
  });
  const providerId = command({
    type: "saveProvider",
    revision: 0,
    settings: {
      name: "TEST model provider",
      url: "https://models.example.test/v1",
      enabled: true,
      dailyRequestLimit: 10,
    },
  });
  const modelId = command({
    type: "saveModel",
    revision: 0,
    settings: {
      providerId,
      name: "TEST model",
      model: "TEST-tool-model",
      kind: "chat",
      tools: true,
      enabled: true,
    },
  });
  const workflow = () => processWorkflow(serviceId, actionId);
  const save = (definition = workflow()) =>
    store.saveDraft(actor, { serviceId, revision: 0, definition });
  const tested = (id: string, version: number, testId = "TEST-test") => {
    const artifact = store.version(actor, id, version);
    return store.recordTest(actor, id, version, {
      testId,
      digest: artifact.digest,
      runnerVersion: "TEST-native-runner/1",
      passed: true,
      scenarios: [...PROCESS_TEST_SCENARIOS],
      reportDigest: processDigest({ offline: true, testId }),
    });
  };
  return {
    db,
    catalog,
    plugins,
    store,
    command,
    registry,
    serviceId,
    actionId,
    modelId,
    providerId,
    workflow,
    save,
    tested,
    failAudit: () => {
      failAudit = true;
    },
  };
}
const errorCode = (code: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === code;

test("only a detached contract store accepts legacy evidence; an attached native gate fails closed on missing lineage", () => {
  const h = fixture();
  try {
    const draft = h.save();
    const artifact = h.store.freezeDraft(actor, draft.id, draft.revision);
    h.tested(draft.id, artifact.version);
    h.store.activate(
      actor,
      draft.id,
      h.store.get(actor, draft.id).revision,
      artifact.version,
    );
    h.store.pinRun(actor, draft.id, "TEST-legacy-pin");
    assert.equal(
      h.store.resolveRun(actor, "TEST-legacy-pin").digest,
      artifact.digest,
    );

    const attached = h.registry();
    const reference = {
      serverId: "TEST-server",
      creatorUserId: actor.userId,
      testId: "TEST-native-lineage",
      qualificationDigest: processDigest({ synthetic: "contract gate" }),
    };
    let gates = 0;
    attached.attachNativeQualificationGate((current, version, proof) => {
      assert.deepEqual(current, actor);
      assert.equal(version.digest, artifact.digest);
      assert.deepEqual(proof, reference);
      gates++;
    });
    const denied = () => {
      for (const execute of [
        () =>
          attached.activate(
            actor,
            draft.id,
            attached.get(actor, draft.id).revision,
            1,
          ),
        () =>
          attached.activeRunVersion(actor, draft.id, {
            version: 1,
            artifactDigest: artifact.digest,
          }),
        () => attached.pinRun(actor, draft.id, "TEST-new-pin"),
        () => attached.pinRun(actor, draft.id, "TEST-legacy-pin"),
        () => attached.resolveRun(actor, "TEST-legacy-pin"),
      ])
        assert.throws(execute, errorCode("process_qualification_unavailable"));
      assert.equal(attached.version(actor, draft.id, 1).testStatus, "passed");
      assert.equal(
        attached.listVersions(actor, draft.id).versions[0]!.digest,
        artifact.digest,
      );
      assert.equal(
        attached.pinnedVersion(actor, "TEST-legacy-pin").digest,
        artifact.digest,
      );
      assert.equal(
        h.db
          .prepare("SELECT count(*) AS n FROM agent_service_process_run")
          .get()!.n,
        1,
      );
    };
    denied();
    assert.equal(
      gates,
      0,
      "Missing proof cannot invoke or bypass the native gate",
    );
    attached.recordNativeQualification(
      actor,
      draft.id,
      1,
      {
        testId: reference.testId,
        digest: artifact.digest,
        runnerVersion: "TEST-explicit-contract-proof/1",
        passed: true,
        scenarios: [...PROCESS_TEST_SCENARIOS],
        reportDigest: processDigest({ synthetic: "contract proof" }),
      },
      reference,
    );
    assert.equal(
      attached.resolveRun(actor, "TEST-legacy-pin").digest,
      artifact.digest,
    );
    assert.equal(gates, 2);
    assert.throws(
      () => h.store.resolveRun(actor, "TEST-legacy-pin"),
      errorCode("process_qualification_unavailable"),
    );
    h.db
      .prepare(
        "DELETE FROM agent_service_process_qualification WHERE process_id=? AND version=?",
      )
      .run(draft.id, 1);
    denied();
    assert.equal(gates, 2);
  } finally {
    h.db.close();
  }
});

function invalid(h: ReturnType<typeof fixture>, value: unknown, code: string) {
  const result = h.store.validate(actor, h.serviceId, value);
  assert.equal(result.valid, false);
  assert(
    result.issues.some((issue) => issue.code === code),
    JSON.stringify(result),
  );
  assert.equal(result.sources, null);
}

test("process definition pins only authorized catalog resources and stable canonical digests", () => {
  const h = fixture();
  try {
    const valid = h.store.validate(actor, h.serviceId, h.workflow());
    assert.equal(valid.valid, true, JSON.stringify(valid));
    assert.deepEqual(valid.issues, []);
    assert.deepEqual(valid.sources?.resources.map((item) => item.kind).sort(), [
      "action",
      "service",
    ]);
    assert.equal(valid.sources?.pluginsDigest, null);
    assert.equal(processDigest({ b: 2, a: 1 }), processDigest({ a: 1, b: 2 }));
    assert.equal(
      h.store.list(actor).processes.length,
      0,
      "Validation is passive",
    );
    invalid(
      h,
      { ...h.workflow(), instructions: "execute code" },
      "definition_invalid",
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    invalid(h, cyclic, "limit_exceeded");
    invalid(
      h,
      { ...h.workflow(), description: "x".repeat(70000) },
      "limit_exceeded",
    );
    invalid(
      h,
      {
        ...h.workflow(),
        limits: { ...DEFAULT_PROCESS_LIMITS, maxTokens: 100001 },
      },
      "limit_exceeded",
    );
    invalid(
      h,
      { ...h.workflow(), limits: { ...DEFAULT_PROCESS_LIMITS, maxSteps: 1 } },
      "limit_exceeded",
    );
    const missing = h.workflow();
    assert.equal(missing.kind, "workflow");
    assert.equal(missing.steps[0]!.type, "action");
    missing.steps[0]!.actionId = "TEST-missing";
    invalid(h, missing, "resource_unavailable");
  } finally {
    h.db.close();
  }
});

test("workflow validation rejects cycles, unreachable nodes, missing targets and unsafe data bindings", () => {
  const h = fixture();
  try {
    const change = (
      mutate: (d: Extract<ProcessDefinition, { kind: "workflow" }>) => void,
      code: string,
    ) => {
      const d = h.workflow();
      assert.equal(d.kind, "workflow");
      mutate(d);
      invalid(h, d, code);
    };
    change((d) => {
      const s = d.steps[0]!;
      assert.equal(s.type, "action");
      s.next = "lookup";
    }, "graph_invalid");
    change((d) => {
      const s = d.steps[0]!;
      assert.equal(s.type, "action");
      s.next = "absent";
    }, "graph_invalid");
    change(
      (d) => d.steps.push({ id: "orphan", type: "return", output: {} }),
      "graph_invalid",
    );
    change((d) => d.steps.push(structuredClone(d.steps[0]!)), "graph_invalid");
    change((d) => {
      const s = d.steps[0]!;
      assert.equal(s.type, "action");
      s.input.name = { source: "step", stepId: "lookup", path: ["value"] };
    }, "binding_invalid");
    change((d) => {
      const s = d.steps[0]!;
      assert.equal(s.type, "action");
      s.input = {};
    }, "binding_invalid");
    change((d) => {
      const s = d.steps[0]!;
      assert.equal(s.type, "action");
      s.input.name = { source: "literal", value: 3 };
    }, "binding_type_unproven");
    change((d) => {
      d.inputSchema = processObject({ name: { type: "string" } }, []);
    }, "binding_invalid");
    change((d) => {
      d.entry = "choice";
      d.steps.unshift({
        id: "choice",
        type: "branch",
        condition: {
          operator: "equals",
          left: { source: "literal", value: true },
          right: true,
        },
        whenTrue: "lookup",
        whenFalse: "done",
      });
    }, "binding_invalid");
    const branch = h.workflow();
    assert.equal(branch.kind, "workflow");
    branch.entry = "choice";
    branch.steps.unshift({
      id: "choice",
      type: "branch",
      condition: {
        operator: "exists",
        left: { source: "input", path: ["name"] },
      },
      whenTrue: "lookup",
      whenFalse: "empty",
    });
    branch.steps.push({
      id: "empty",
      type: "return",
      output: { result: { source: "literal", value: "TEST absent" } },
    });
    assert.equal(h.store.validate(actor, h.serviceId, branch).valid, true);
  } finally {
    h.db.close();
  }
});

test("catalog schema constraints, local refs, unions and boolean constants are checked", () => {
  const h = fixture();
  try {
    const updateSchema = (inputSchema: object) => {
      const service = h.catalog.service(target.workspaceId, h.serviceId),
        action = service.actions.find((a) => a.id === h.actionId)!;
      const {
        id: _id,
        revision: _revision,
        sourceKey: _sourceKey,
        ...settings
      } = action;
      h.command({
        type: "saveAction",
        serviceId: h.serviceId,
        serviceRevision: service.revision,
        id: h.actionId,
        revision: action.revision,
        settings: { ...settings, inputSchema },
      });
    };
    updateSchema({
      type: "object",
      properties: { name: { type: "string", maxLength: 5 } },
      required: ["name"],
      additionalProperties: false,
    });
    invalid(h, h.workflow(), "binding_type_unproven");
    const narrowed = h.workflow();
    narrowed.inputSchema = processObject({
      name: { type: "string", maxLength: 5 },
    });
    assert.equal(h.store.validate(actor, h.serviceId, narrowed).valid, true);
    updateSchema({
      type: "object",
      properties: { name: { $ref: "#/$defs/title" } },
      required: ["name"],
      additionalProperties: false,
      $defs: { title: { type: "string" } },
    });
    assert.equal(
      h.store.validate(actor, h.serviceId, h.workflow()).valid,
      true,
    );
    updateSchema({
      type: "object",
      anyOf: [{ required: ["name", "extra"] }, { required: ["other"] }],
    });
    invalid(h, h.workflow(), "binding_type_unproven");
    updateSchema({
      type: "object",
      properties: { name: { type: "string", pattern: "^TEST" } },
    });
    invalid(h, h.workflow(), "binding_type_unproven");
    updateSchema({
      type: "object",
      properties: { name: { type: "boolean", const: true } },
      required: ["name"],
    });
    const bool = h.workflow();
    assert.equal(bool.kind, "workflow");
    const step = bool.steps[0]!;
    assert.equal(step.type, "action");
    step.input.name = { source: "literal", value: true };
    assert.equal(h.store.validate(actor, h.serviceId, bool).valid, true);
    step.input.name = { source: "literal", value: false };
    invalid(h, bool, "binding_type_unproven");
  } finally {
    h.db.close();
  }
});

test("agents require a tool model, permitted capabilities and enabled saved memory", () => {
  const h = fixture();
  try {
    const workflow = h.workflow();
    assert.equal(workflow.kind, "workflow");
    const { entry: _entry, steps: _steps, ...base } = workflow;
    const d = ProcessDefinitionSchema.parse({
      ...base,
      kind: "agent",
      modelId: h.modelId,
      instructions: "TEST synthetic assistant",
      capabilities: [{ serviceId: h.serviceId, actionId: h.actionId }],
      memory: "saved",
      limits: DEFAULT_PROCESS_LIMITS,
    });
    const result = h.store.validate(actor, h.serviceId, d);
    assert.equal(result.valid, true);
    assert.deepEqual(result.sources?.resources.map((r) => r.kind).sort(), [
      "action",
      "model",
      "provider",
      "service",
    ]);
    assert(result.sources?.pluginsDigest);
    invalid(h, { ...d, modelId: "TEST-missing" }, "resource_unavailable");
    invalid(
      h,
      { ...d, limits: { ...DEFAULT_PROCESS_LIMITS, maxModelCalls: 0 } },
      "limit_exceeded",
    );
    h.plugins.update(target.workspaceId, 0, { enabled: [], timeZone: "UTC" });
    invalid(h, d, "resource_unavailable");
  } finally {
    h.db.close();
  }
});

test("immutable versions, test gates, rollback and original run pins survive registry restart", () => {
  const root = mkdtempSync(join(tmpdir(), "niaro-process-"));
  const h = fixture(join(root, "registry.sqlite"));
  try {
    const draft = h.save(),
      first = h.store.freezeDraft(actor, draft.id, draft.revision);
    assert.equal(first.testStatus, "untested");
    assert.throws(
      () =>
        h.store.activate(
          actor,
          draft.id,
          h.store.get(actor, draft.id).revision,
          1,
        ),
      errorCode("process_test_required"),
    );
    assert.throws(
      () => h.store.pinRun(actor, draft.id, "TEST-before-active"),
      errorCode("process_not_active"),
    );
    const evidence = {
      testId: "TEST-incomplete",
      digest: first.digest,
      runnerVersion: "TEST/1",
      passed: true,
      scenarios: ["success" as const],
      reportDigest: processDigest({ test: 1 }),
    };
    assert.equal(
      h.store.recordTest(actor, draft.id, 1, evidence).testStatus,
      "failed",
    );
    assert.throws(
      () =>
        h.store.activate(
          actor,
          draft.id,
          h.store.get(actor, draft.id).revision,
          1,
        ),
      errorCode("process_test_required"),
    );
    assert.equal(h.tested(draft.id, 1).testStatus, "passed");
    h.store.activate(actor, draft.id, h.store.get(actor, draft.id).revision, 1);
    assert.equal(
      h.store.pinRun(actor, draft.id, "TEST-existing-run").version,
      1,
    );
    const originalDigest = first.digest,
      updated = h.workflow();
    updated.name = "TEST new version";
    const edited = h.store.saveDraft(actor, {
      id: draft.id,
      serviceId: h.serviceId,
      revision: h.store.get(actor, draft.id).revision,
      definition: updated,
    });
    assert.equal(edited.activeVersion, 1);
    const second = h.store.freezeDraft(actor, draft.id, edited.revision);
    assert.equal(second.version, 2);
    assert.notEqual(second.digest, originalDigest);
    h.tested(draft.id, 2, "TEST-second-test");
    h.store.activate(actor, draft.id, h.store.get(actor, draft.id).revision, 2);
    assert.equal(
      h.store.pinRun(actor, draft.id, "TEST-existing-run").version,
      1,
    );
    assert.equal(h.store.pinRun(actor, draft.id, "TEST-new-run").version, 2);
    assert.equal(h.store.version(actor, draft.id, 1).digest, originalDigest);
    assert.throws(
      () =>
        h.db
          .prepare(
            "UPDATE agent_service_process_version SET definition='{}' WHERE process_id=?",
          )
          .run(draft.id),
      /process_version_immutable/,
    );
    assert.throws(
      () =>
        h.db
          .prepare(
            "UPDATE agent_service_process_run SET version=2 WHERE run_id='TEST-existing-run'",
          )
          .run(),
      /process_run_immutable/,
    );
    h.db.close();
    const db = new DatabaseSync(join(root, "registry.sqlite"));
    db.exec("PRAGMA foreign_keys=ON");
    try {
      const catalog = new ServiceCatalogStore(
          db,
          "TEST-only-encryption-secret",
          [],
        ),
        plugins = new WorkspacePluginStore(db, {
          enabled: ["memory"],
          timeZone: "UTC",
        }),
        audit = new AuditStore(db);
      const restarted = new ServiceProcessStore(db, catalog, plugins, (r) => {
        audit.append(r);
      });
      assert.equal(restarted.resolveRun(actor, "TEST-existing-run").version, 1);
      assert.equal(restarted.get(actor, draft.id).activeVersion, 2);
      restarted.activate(
        actor,
        draft.id,
        restarted.get(actor, draft.id).revision,
        1,
      );
      assert.equal(
        restarted.pinRun(actor, draft.id, "TEST-after-rollback").version,
        1,
      );
      assert.equal(restarted.resolveRun(actor, "TEST-new-run").version, 2);
      db.prepare("DELETE FROM agent_workspace WHERE id=?").run(
        target.workspaceId,
      );
      assert.equal(
        db
          .prepare("SELECT count(*) AS n FROM agent_service_process_version")
          .get()!.n,
        0,
      );
    } finally {
      db.close();
    }
  } finally {
    if (h.db.isOpen) h.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("revisions, scoped reads, detached results and duplicate freezes cannot overwrite history", () => {
  const h = fixture();
  try {
    const draft = h.save();
    draft.draft.name = "TEST locally mutated";
    assert.equal(h.store.get(actor, draft.id).name, "TEST lookup");
    assert.throws(
      () => h.store.get(elsewhere, draft.id),
      errorCode("process_not_found"),
    );
    assert.throws(
      () => h.store.get({ ...actor, role: "member" }, draft.id),
      errorCode("identity_forbidden"),
    );
    assert.throws(
      () =>
        h.store.saveDraft(actor, {
          id: draft.id,
          serviceId: h.serviceId,
          revision: 0,
          definition: h.workflow(),
        }),
      errorCode("process_conflict"),
    );
    const version = h.store.freezeDraft(actor, draft.id, draft.revision);
    const revision = h.store.get(actor, draft.id).revision;
    assert.equal(h.store.freezeDraft(actor, draft.id, revision).version, 1);
    assert.equal(h.store.get(actor, draft.id).revision, revision);
    const proof = {
      testId: "TEST-idempotent",
      digest: version.digest,
      runnerVersion: "TEST/1",
      passed: true,
      scenarios: [...PROCESS_TEST_SCENARIOS],
      reportDigest: processDigest({ test: true }),
    };
    h.store.recordTest(actor, draft.id, 1, proof);
    const testedRevision = h.store.get(actor, draft.id).revision;
    h.store.recordTest(actor, draft.id, 1, proof);
    assert.equal(h.store.get(actor, draft.id).revision, testedRevision);
    assert.throws(
      () => h.store.recordTest(actor, draft.id, 1, { ...proof, passed: false }),
      errorCode("process_conflict"),
    );
    h.store.activate(actor, draft.id, testedRevision, 1);
    h.store.pinRun(actor, draft.id, "TEST-scope-run");
    assert.throws(
      () =>
        h.store.resolveRun(
          { ...actor, userId: "TEST-another-user" },
          "TEST-scope-run",
        ),
      errorCode("process_not_found"),
    );
    assert.throws(
      () => h.store.resolveRun(elsewhere, "TEST-scope-run"),
      errorCode("process_not_found"),
    );
  } finally {
    h.db.close();
  }
});

test("catalog changes, capability revocation and narrower server limits invalidate activation and resume", () => {
  const h = fixture();
  try {
    const draft = h.save();
    h.store.freezeDraft(actor, draft.id, 1);
    h.tested(draft.id, 1);
    h.store.activate(actor, draft.id, h.store.get(actor, draft.id).revision, 1);
    h.store.pinRun(actor, draft.id, "TEST-pinned");
    const memberActor: ProcessActor = {
      ...actor,
      userId: "TEST-member-user",
      role: "member",
    };
    h.store.pinRun(memberActor, draft.id, "TEST-member-run");
    assert.throws(
      () =>
        h
          .registry({ ...DEFAULT_PROCESS_LIMITS, maxTokens: 99 })
          .resolveRun(actor, "TEST-pinned"),
      errorCode("process_definition_invalid"),
    );
    const service = h.catalog.service(target.workspaceId, h.serviceId);
    const {
      id: _id,
      revision: _revision,
      hasCredential: _credential,
      modelId: _modelId,
      actions: _actions,
      ...serviceSettings
    } = service;
    h.command({
      type: "saveService",
      id: service.id,
      revision: service.revision,
      settings: { ...serviceSettings, name: "TEST updated dependency" },
    });
    assert.throws(
      () => h.store.resolveRun(actor, "TEST-pinned"),
      errorCode("process_sources_changed"),
    );
    const changed = h.catalog.service(target.workspaceId, h.serviceId),
      action = changed.actions.find((a) => a.id === h.actionId)!;
    const {
      id: _actionId,
      revision: _actionRevision,
      sourceKey: _sourceKey,
      ...actionSettings
    } = action;
    h.command({
      type: "saveAction",
      id: action.id,
      revision: action.revision,
      serviceId: service.id,
      serviceRevision: changed.revision,
      settings: { ...actionSettings, policy: { roles: [], users: [] } },
    });
    assert.throws(
      () => h.store.resolveRun(memberActor, "TEST-member-run"),
      errorCode("process_definition_invalid"),
    );
  } finally {
    h.db.close();
  }
});

test("audit failures roll back definitions and audit rows atomically; invalid drafts create nothing", () => {
  const h = fixture();
  try {
    const bad = h.workflow();
    bad.inputSchema = processObject();
    assert.throws(() => h.save(bad), errorCode("process_definition_invalid"));
    assert.equal(h.store.list(actor).processes.length, 0);
    const draft = h.save();
    const auditBefore = h.db
      .prepare("SELECT count(*) AS n FROM agent_audit")
      .get()!.n;
    h.failAudit();
    assert.throws(
      () => h.store.freezeDraft(actor, draft.id, draft.revision),
      /TEST audit failed/,
    );
    assert.equal(h.store.get(actor, draft.id).latestVersion, 0);
    assert.equal(h.store.get(actor, draft.id).revision, 1);
    assert.throws(() => h.save(), /TEST audit failed/);
    assert.equal(h.store.list(actor).processes.length, 1);
    assert.equal(
      h.db.prepare("SELECT count(*) AS n FROM agent_audit").get()!.n,
      auditBefore,
    );
    const details = JSON.parse(
      String(
        h.db
          .prepare("SELECT details FROM agent_audit ORDER BY id DESC LIMIT 1")
          .get()!.details,
      ),
    );
    assert.deepEqual(details, {
      revision: 1,
      previousRevision: 0,
      processEvent: "draft_saved",
    });
  } finally {
    h.db.close();
  }
});

test("failed retests revoke starts and resumes while preserving immutable history", () => {
  const h = fixture();
  try {
    const draft = h.save(),
      version = h.store.freezeDraft(actor, draft.id, 1);
    h.tested(draft.id, 1);
    h.store.activate(actor, draft.id, h.store.get(actor, draft.id).revision, 1);
    h.store.pinRun(actor, draft.id, "TEST-retest-run");
    h.store.recordTest(actor, draft.id, 1, {
      testId: "TEST-failed-retest",
      digest: version.digest,
      runnerVersion: "TEST/2",
      passed: false,
      scenarios: [...PROCESS_TEST_SCENARIOS],
      reportDigest: processDigest({ failed: true }),
    });
    assert.throws(
      () => h.store.resolveRun(actor, "TEST-retest-run"),
      errorCode("process_test_required"),
    );
    assert.throws(
      () => h.store.pinRun(actor, draft.id, "TEST-retest-run"),
      errorCode("process_test_required"),
    );
    assert.throws(
      () => h.store.pinRun(actor, draft.id, "TEST-after-failed-retest"),
      errorCode("process_test_required"),
    );
    assert.equal(h.store.version(actor, draft.id, 1).digest, version.digest);
    assert.equal(
      h.db.prepare("SELECT count(*) AS n FROM agent_service_process_run").get()!
        .n,
      1,
    );
  } finally {
    h.db.close();
  }
});

test("saved-memory and model dependencies include effective operator defaults and provider revisions", () => {
  const h = fixture();
  try {
    const workflow = h.workflow();
    assert.equal(workflow.kind, "workflow");
    const { entry: _entry, steps: _steps, ...base } = workflow;
    const d = ProcessDefinitionSchema.parse({
      ...base,
      kind: "agent",
      modelId: h.modelId,
      instructions: "TEST assistant",
      capabilities: [],
      memory: "saved",
      limits: DEFAULT_PROCESS_LIMITS,
    });
    const draft = h.save(d);
    h.store.freezeDraft(actor, draft.id, 1);
    h.tested(draft.id, 1);
    h.store.activate(actor, draft.id, h.store.get(actor, draft.id).revision, 1);
    h.store.pinRun(actor, draft.id, "TEST-memory-run");
    const changedDefaults = new ServiceProcessStore(
      h.db,
      h.catalog,
      new WorkspacePluginStore(h.db, {
        enabled: ["memory"],
        timeZone: "Europe/Prague",
      }),
      () => {},
    );
    assert.throws(
      () => changedDefaults.resolveRun(actor, "TEST-memory-run"),
      errorCode("process_sources_changed"),
    );
    h.plugins.update(target.workspaceId, 0, { enabled: [], timeZone: "UTC" });
    assert.throws(
      () => h.store.resolveRun(actor, "TEST-memory-run"),
      errorCode("process_definition_invalid"),
    );
    h.plugins.update(target.workspaceId, 1, null);
    assert.throws(
      () => h.store.resolveRun(actor, "TEST-memory-run"),
      errorCode("process_sources_changed"),
    );
    const provider = h.catalog.provider(
      target.organizationId,
      h.providerId,
    ).provider;
    const {
      id: _id,
      revision: _revision,
      hasCredential: _credential,
      requestsToday: _requests,
      ...settings
    } = provider;
    h.command({
      type: "saveProvider",
      id: provider.id,
      revision: provider.revision,
      settings: { ...settings, enabled: false },
    });
    invalid(h, d, "resource_unavailable");
  } finally {
    h.db.close();
  }
});
