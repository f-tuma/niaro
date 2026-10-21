import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  ServiceProcessStore,
  PROCESS_TEST_SCENARIOS,
} from "../apps/server-identity/service-processes";
import { ProcessDesignStore } from "../apps/server-identity/process-design-store";
import { ProcessVersionsStore } from "../apps/server-identity/process-versions-store";
import { WorkspacePluginStore } from "../apps/server-identity/workspace-plugins";
import { IdentityError } from "../apps/server-identity/error";
import { processDigest } from "../apps/server-identity/process-validation";
import { migrateProcessOwners } from "../apps/server-identity/process-owner-migration";
import { serviceProcessRunIdentity } from "../apps/server-identity/service-process-journal";
import {
  WORKSPACE_DESIGN_PROFILE,
  emptyDesignBrief,
} from "../packages/protocol/process-design";
import { PROCESS_VERSION_PROFILE } from "../packages/protocol/process-versions";
import {
  ProcessRecordSchema,
  ProcessListSchema,
  WorkspaceProcessListSchema,
  WORKSPACE_PROCESS_PROFILE,
} from "../packages/protocol/service-processes";
import { handleServiceProcesses } from "../apps/server-identity/process-controller";
import {
  handleProcessDesign,
  PROCESS_DESIGN_PATH,
} from "../apps/server-identity/process-design-controller";
import type { CatalogContext } from "../apps/server-identity/catalog-controller";
import {
  designFixture,
  designActor,
  designTarget,
} from "./helpers/process-design";
import {
  fixture,
  admin,
  scope,
  signal,
} from "./helpers/service-process-runtime";

const code = (name: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === name;

test("/1 controllers remain strictly service-only across pagination and reject workspace reads/mutations before changing bytes", async () => {
  const h = designFixture();
  const context: CatalogContext = {
    serial: async (fn) => fn(),
    transaction: async (fn) => fn(),
    actor: async () => ({ userId: designActor.userId, role: designActor.role }),
    epoch: () => 0,
    change: () => {},
    audit: () => 0,
    finish: () => {},
  };
  const base = "/admin/api/identity/catalog/processes";
  const request = (method: string, path: string, body?: unknown) =>
    handleServiceProcesses(
      method,
      new URL(base + path, "http://localhost"),
      body,
      h.registry,
      context,
    );
  const design = (method: string, path: string, body?: unknown) =>
    handleProcessDesign(
      method,
      new URL(PROCESS_DESIGN_PATH + path, "http://localhost"),
      body,
      {
        proposals: h.store,
        registry: h.registry,
        catalog: h.catalog,
        plugins: h.plugins,
      },
      context,
      signal(),
    );
  try {
    // More workspace rows than one legacy page, with keys before the service row.
    const draft = JSON.stringify(h.workflow());
    const insert = h.db.prepare(
      "INSERT INTO agent_service_process(id,organization_id,workspace_id,service_id,revision,draft,active_version,updated_at,owner_type) VALUES(?,?,?,NULL,1,?,NULL,?,'workspace')",
    );
    for (let i = 0; i < 102; i++)
      insert.run(
        `000-TEST-global-${String(i).padStart(3, "0")}`,
        designActor.organizationId,
        designActor.workspaceId,
        draft,
        "2026-10-07T12:00:00Z",
      );
    const old = h.registry.saveDraft(designActor, {
      serviceId: h.serviceId,
      revision: 0,
      definition: h.workflow(),
    });
    const query = new URLSearchParams(designTarget);
    const legacy = ProcessListSchema.parse(await request("GET", "?" + query));
    assert.deepEqual(
      legacy.processes.map((p) => p.id),
      [old.id],
    );
    assert.equal(legacy.nextAfter, null);
    const owned = WorkspaceProcessListSchema.parse(
      await request(
        "GET",
        "?" + query + "&profile=" + WORKSPACE_PROCESS_PROFILE,
      ),
    );
    assert.equal(owned.processes.length, 100);
    assert(owned.nextAfter);
    const next = WorkspaceProcessListSchema.parse(
      await request(
        "GET",
        "?" +
          query +
          "&profile=" +
          WORKSPACE_PROCESS_PROFILE +
          "&after=" +
          owned.nextAfter,
      ),
    );
    assert.equal(next.processes.length, 3);
    assert.equal(next.nextAfter, null);
    const global = h.registry.getOwned(designActor, "000-TEST-global-000");
    const frozen = h.registry.freezeDraft(
      designActor,
      global.id,
      global.revision,
    );
    for (const suffix of ["", `&version=${frozen.version}`])
      await assert.rejects(
        request("GET", "?" + query + "&id=" + global.id + suffix),
        code("process_not_found"),
      );
    const rowBefore = h.db
      .prepare("SELECT * FROM agent_service_process WHERE id=?")
      .get(global.id);
    await assert.rejects(
      request("POST", "/command", {
        ...designTarget,
        type: "freezeDraft",
        id: global.id,
        revision: rowBefore!.revision,
      }),
      code("process_not_found"),
    );
    assert.deepEqual(
      h.db
        .prepare("SELECT * FROM agent_service_process WHERE id=?")
        .get(global.id),
      rowBefore,
    );
    const start = (await design(
      "POST",
      "/start?profile=" + WORKSPACE_DESIGN_PROFILE,
      {
        ...designTarget,
        profile: WORKSPACE_DESIGN_PROFILE,
        owner: { type: "workspace" },
        requestId: "TEST-controller-owner",
      },
    )) as { review: { id: string; revision: number } };
    const update = {
      ...designTarget,
      sessionId: start.review.id,
      requestId: "TEST-controller-legacy-update",
      revision: start.review.revision,
      brief: emptyDesignBrief(),
      candidate: h.workflow(),
    };
    const designBefore = h.db
      .prepare("SELECT * FROM agent_process_design WHERE id=?")
      .get(start.review.id);
    await assert.rejects(
      design("POST", "/update", update),
      code("process_design_not_found"),
    );
    assert.deepEqual(
      h.db
        .prepare("SELECT * FROM agent_process_design WHERE id=?")
        .get(start.review.id),
      designBefore,
    );
    await assert.rejects(
      design("GET", "?" + query + "&sessionId=" + start.review.id),
      code("process_design_not_found"),
    );
  } finally {
    h.db.close();
  }
});

test("workspace ownership is explicit and immutable; /1 stays service-only and actual dependency pins stay exact", () => {
  const h = designFixture();
  try {
    const old = h.registry.saveDraft(designActor, {
      serviceId: h.serviceId,
      revision: 0,
      definition: h.workflow(),
    });
    const global = h.registry.saveWorkspaceDraft(designActor, {
      revision: 0,
      definition: h.workflow(),
    });
    assert.deepEqual(global.serviceId, undefined);
    assert.equal(
      h.db
        .prepare("SELECT service_id FROM agent_service_process WHERE id=?")
        .get(global.id)?.service_id,
      null,
    );
    assert.deepEqual(
      h.registry.list(designActor).processes.map((p) => p.id),
      [old.id],
    );
    assert.equal(h.registry.listOwned(designActor).processes.length, 2);
    assert.throws(
      () => h.registry.get(designActor, global.id),
      code("process_not_found"),
    );
    assert.deepEqual(
      ProcessRecordSchema.parse(h.registry.get(designActor, old.id)),
      old,
    );
    assert.throws(
      () =>
        h.registry.saveDraft(designActor, {
          id: global.id,
          serviceId: h.serviceId,
          revision: global.revision,
          definition: h.workflow(),
        }),
      code("process_conflict"),
    );
    assert.throws(
      () =>
        h.registry.saveWorkspaceDraft(designActor, {
          id: old.id,
          revision: old.revision,
          definition: h.workflow(),
        }),
      code("process_conflict"),
    );
    assert.throws(
      () =>
        h.db
          .prepare(
            "UPDATE agent_service_process SET owner_type='service',service_id=? WHERE id=?",
          )
          .run(h.serviceId, global.id),
      /process_owner_immutable/,
    );
    const a = h.registry.freezeDraft(designActor, old.id, old.revision),
      b = h.registry.freezeDraft(designActor, global.id, global.revision);
    assert.deepEqual(a.sources, b.sources); // same service is actually used, not an invented workspace service
    assert.equal(a.digest, b.digest);
    const agent = { ...h.agent(), capabilities: [] };
    const independent = h.registry.validateOwner(
      designActor,
      { type: "workspace" },
      agent,
    );
    assert.equal(independent.valid, true);
    assert(
      !independent.sources!.resources.some(
        (r) => r.kind === "service" || r.kind === "action",
      ),
    );
    h.setAction({ enabled: false });
    assert.equal(
      h.registry.validateOwner(designActor, { type: "workspace" }, h.workflow())
        .valid,
      false,
    );
    assert.throws(
      () =>
        h.registry.getOwned(
          {
            ...designActor,
            workspaceId: "22222222-2222-4222-8222-222222222222",
          },
          global.id,
        ),
      code("process_not_found"),
    );
  } finally {
    h.db.close();
  }
});

test("workspace designer binds its owner before inference and accepts only the exact reviewed draft", () => {
  const h = designFixture();
  try {
    const start = {
      ...designTarget,
      profile: WORKSPACE_DESIGN_PROFILE,
      requestId: "TEST-global-start",
      owner: { type: "workspace" as const },
    };
    const receipt = h.store.start(designActor, start);
    assert.deepEqual(h.store.start(designActor, start), receipt);
    assert.throws(
      () => h.store.get(designActor, receipt.sessionId),
      code("process_design_not_found"),
    );
    h.store.update(designActor, {
      ...designTarget,
      sessionId: receipt.sessionId,
      requestId: "TEST-global-update",
      revision: 1,
      brief: {
        ...emptyDesignBrief(),
        purpose: "TEST coordinate configured services",
      },
      candidate: h.workflow(),
    });
    const review = h.store.getWorkspace(designActor, receipt.sessionId);
    assert.deepEqual(review.owner, { type: "workspace" });
    assert.equal(review.validation.valid, true);
    assert.deepEqual(review.blockers, []);
    assert.throws(() =>
      h.store.update(designActor, {
        ...designTarget,
        sessionId: receipt.sessionId,
        requestId: "TEST-forged-owner",
        revision: 2,
        owner: { type: "service", serviceId: h.serviceId },
        brief: review.brief,
        candidate: review.candidate,
      }),
    );
    assert.throws(
      () =>
        h.store.accept(designActor, {
          ...designTarget,
          sessionId: review.id,
          requestId: "TEST-stale-review",
          revision: review.revision,
          reviewDigest: "0".repeat(64),
        }),
      code("process_design_review_changed"),
    );
    const input = {
      ...designTarget,
      sessionId: review.id,
      requestId: "TEST-global-accept",
      revision: review.revision,
      reviewDigest: review.reviewDigest,
    };
    const accepted = h.store.accept(designActor, input);
    assert.deepEqual(h.store.accept(designActor, input), accepted);
    assert.equal(h.registry.list(designActor).processes.length, 0);
    assert.deepEqual(
      h.registry.getOwned(designActor, accepted.processId!).draft,
      review.candidate,
    );
    assert.throws(() =>
      h.store.start(designActor, {
        ...start,
        requestId: "TEST-reparent",
        processId: accepted.processId,
        serviceId: h.serviceId,
      }),
    );
  } finally {
    h.db.close();
  }
});

/** Derived legacy-schema control: current service-only producers populate the
 * data before rebuilding the original NOT NULL parent without changing children.
 * An archived old producer is a separate compatibility proof. */
function makeLegacyParent(db: ReturnType<typeof fixture>["db"]) {
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE legacy_parent (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
 service_id TEXT NOT NULL, revision INTEGER NOT NULL, draft TEXT NOT NULL, active_version INTEGER, updated_at TEXT NOT NULL,
 FOREIGN KEY(id,active_version) REFERENCES agent_service_process_version(process_id,version)) STRICT;
 INSERT INTO legacy_parent SELECT id,organization_id,workspace_id,service_id,revision,draft,active_version,updated_at FROM agent_service_process;
 DROP TABLE agent_service_process; ALTER TABLE legacy_parent RENAME TO agent_service_process;
 CREATE INDEX agent_service_process_scope ON agent_service_process(organization_id,workspace_id,id);
 COMMIT;`);
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}

test("owner migration preserves external views and child triggers and restores both connection pragmas", () => {
  for (const foreignKeys of [0, 1])
    for (const legacyAlterTable of [0, 1])
      for (const failure of ["none", "collision", "recreate"] as const) {
        const db = new DatabaseSync(":memory:");
        try {
          db.exec(`CREATE TABLE organization(id TEXT PRIMARY KEY);
            CREATE TABLE agent_workspace(id TEXT PRIMARY KEY);
            INSERT INTO organization VALUES('org'); INSERT INTO agent_workspace VALUES('workspace');
            CREATE TABLE agent_service_process(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organization(id),
              workspace_id TEXT NOT NULL REFERENCES agent_workspace(id),service_id TEXT NOT NULL,revision INTEGER NOT NULL,
              draft TEXT NOT NULL,active_version INTEGER,updated_at TEXT NOT NULL);
            INSERT INTO agent_service_process VALUES('process','org','workspace','service',1,'{}',1,'TEST-time');
            CREATE TABLE agent_service_process_version(process_id TEXT REFERENCES agent_service_process(id),version INTEGER,
              PRIMARY KEY(process_id,version));
            INSERT INTO agent_service_process_version VALUES('process',1);
            CREATE TABLE TEST_trigger_result(process_id TEXT);
            CREATE VIEW TEST_process_view AS SELECT id FROM agent_service_process;
            CREATE TRIGGER TEST_child_trigger AFTER INSERT ON agent_service_process_version BEGIN
              INSERT INTO TEST_trigger_result SELECT id FROM agent_service_process WHERE id=NEW.process_id; END;
            CREATE INDEX TEST_parent_index ON agent_service_process(updated_at);
            PRAGMA foreign_keys=${foreignKeys}; PRAGMA legacy_alter_table=${legacyAlterTable};`);
          const objects = () =>
            db
              .prepare(
                "SELECT name,sql FROM sqlite_schema WHERE name IN ('TEST_process_view','TEST_child_trigger') ORDER BY name",
              )
              .all();
          const before = objects();
          if (failure !== "none") {
            const schemaBefore = db
              .prepare("SELECT name,sql FROM sqlite_schema ORDER BY name")
              .all();
            const execute = db.exec.bind(db);
            if (failure === "collision")
              db.exec(
                "CREATE TABLE agent_service_process_owner_migration(id TEXT)",
              );
            else
              db.exec = (sql: string) => {
                if (sql.startsWith("CREATE INDEX TEST_parent_index"))
                  throw Error("TEST recreate interrupted");
                return execute(sql);
              };
            assert.throws(
              () => migrateProcessOwners(db),
              failure === "collision"
                ? /already exists/
                : /TEST recreate interrupted/,
            );
            db.exec = execute;
            if (failure === "recreate")
              assert.deepEqual(
                db
                  .prepare("SELECT name,sql FROM sqlite_schema ORDER BY name")
                  .all(),
                schemaBefore,
              );
            assert.equal(
              db.prepare("PRAGMA table_info(agent_service_process)").all()
                .length,
              8,
            );
          } else {
            migrateProcessOwners(db);
            assert.equal(
              db.prepare("SELECT owner_type FROM agent_service_process").get()!
                .owner_type,
              "service",
            );
            migrateProcessOwners(db);
          }
          assert.equal(db.isTransaction, false);
          assert.equal(
            db.prepare("PRAGMA foreign_keys").get()!.foreign_keys,
            foreignKeys,
          );
          assert.equal(
            db.prepare("PRAGMA legacy_alter_table").get()!.legacy_alter_table,
            legacyAlterTable,
          );
          assert.deepEqual(objects(), before);
          assert.equal(
            db.prepare("SELECT id FROM TEST_process_view").get()!.id,
            "process",
          );
          db.exec(
            "INSERT INTO agent_service_process_version VALUES('process',2)",
          );
          assert.equal(
            db.prepare("SELECT process_id FROM TEST_trigger_result").get()!
              .process_id,
            "process",
          );
          assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
        } finally {
          db.close();
        }
      }
});

test("owner migration preserves disabled FK enforcement and custom objects, and rolls back safely when preconditions fail", () => {
  const h = designFixture();
  try {
    const process = h.registry.saveDraft(designActor, {
      serviceId: h.serviceId,
      revision: 0,
      definition: h.workflow(),
    });
    h.registry.freezeDraft(designActor, process.id, process.revision);
    makeLegacyParent(h.db);
    h.db.exec(
      "PRAGMA foreign_keys=OFF; CREATE INDEX TEST_process_custom ON agent_service_process(updated_at); CREATE TRIGGER TEST_process_delete BEFORE DELETE ON agent_service_process BEGIN SELECT 1; END",
    );
    const original = h.db.prepare("SELECT * FROM agent_service_process").all(),
      objects = h.db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE name IN ('TEST_process_custom','TEST_process_delete') ORDER BY name",
        )
        .all();
    h.db.exec(
      "INSERT INTO agent_service_process_version SELECT 'TEST-orphan',version,definition,sources,digest,created_at,created_by FROM agent_service_process_version LIMIT 1",
    );
    assert.throws(
      () => migrateProcessOwners(h.db),
      /process_owner_migration_foreign_keys/,
    );
    assert.deepEqual(
      h.db.prepare("SELECT * FROM agent_service_process").all(),
      original,
    );
    assert.equal(h.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 0);
    h.db.exec(
      "DELETE FROM agent_service_process_version WHERE process_id='TEST-orphan'; BEGIN",
    );
    assert.throws(
      () => migrateProcessOwners(h.db),
      /process_owner_migration_transaction/,
    );
    h.db.exec("ROLLBACK");
    h.db.exec("CREATE TABLE agent_service_process_owner_migration(id TEXT)");
    assert.throws(() => migrateProcessOwners(h.db), /already exists/);
    assert.equal(h.db.isTransaction, false);
    assert.deepEqual(
      h.db.prepare("SELECT * FROM agent_service_process").all(),
      original,
    );
    assert.equal(h.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 0);
    h.db.exec("DROP TABLE agent_service_process_owner_migration");
    migrateProcessOwners(h.db);
    assert.equal(h.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 0);
    assert.deepEqual(h.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(
      h.db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE name IN ('TEST_process_custom','TEST_process_delete') ORDER BY name",
        )
        .all(),
      objects,
    );
  } finally {
    h.db.close();
  }
});

test("derived populated legacy-schema migration preserves active artifact, qualification, freeze command, design bytes, native pending approval and unknown receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-owner-migration-")),
    path = join(dir, "identity.sqlite");
  const h = fixture(path);
  try {
    const id = h.activate(h.readWrite());
    const wait = await h.runtime.start(
      id,
      "TEST-migrate-pending",
      { name: "TEST-original-input" },
      signal(),
    );
    assert.equal(wait.status, "waiting");
    assert(wait.approval);
    const uncertain = await h.runtime.start(
      id,
      "TEST-migrate-unknown",
      { name: "TEST-unknown-input" },
      signal(),
    );
    assert(uncertain.approval);
    h.setMode("unknown");
    const unknown = await h.runtime.resume(
      uncertain.runId,
      { ...uncertain.approval, approved: true },
      signal(),
    );
    assert.equal(unknown.status, "unknown");
    h.setMode("success");
    const artifact = h.registry.version(admin, id, 1);
    const reference = {
      serverId: scope.serverId,
      creatorUserId: admin.userId,
      testId: "TEST-qualified-migration",
      qualificationDigest: "a".repeat(64),
    };
    h.registry.attachNativeQualificationGate((_actor, _artifact, current) =>
      assert.deepEqual(current, reference),
    );
    h.registry.recordNativeQualification(
      admin,
      id,
      1,
      {
        testId: reference.testId,
        digest: artifact.digest,
        runnerVersion: "TEST-seeded-qualification/1",
        passed: true,
        scenarios: [...PROCESS_TEST_SCENARIOS],
        reportDigest: processDigest({ fixture: true }),
      },
      reference,
    );
    const versions = new ProcessVersionsStore(h.db, scope.serverId, h.registry);
    const command = {
      ...admin,
      profile: PROCESS_VERSION_PROFILE,
      requestId: "TEST-original-freeze",
      processId: id,
      revision: h.registry.get(admin, id).revision,
    };
    const freeze = versions.freeze(admin, {
      organizationId: admin.organizationId,
      workspaceId: admin.workspaceId,
      profile: command.profile,
      requestId: command.requestId,
      processId: id,
      revision: command.revision,
    });
    const plugins = new WorkspacePluginStore(h.db, {
      enabled: ["memory"],
      timeZone: "UTC",
    });
    const designs = new ProcessDesignStore(
      h.db,
      h.registry,
      h.catalog,
      plugins,
    );
    const started = {
      organizationId: admin.organizationId,
      workspaceId: admin.workspaceId,
      serviceId: h.ids.serviceId,
      requestId: "TEST-original-design",
    };
    const design = designs.start(admin, started),
      review = designs.get(admin, design.sessionId);
    const tables = [
      "agent_service_process_version",
      "agent_service_process_test",
      "agent_service_process_qualification",
      "agent_service_process_run",
      "agent_process_freeze_command",
      "agent_process_design",
      "agent_process_design_command",
      "agent_service_invocation",
      "agent_service_turn",
    ];
    const snapshot = () =>
      Object.fromEntries(
        tables.map((table) => [
          table,
          h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ]),
      );
    const before = snapshot(),
      counts = h.counts();
    const originalParent = h.db
      .prepare(
        "SELECT id,organization_id,workspace_id,service_id,revision,draft,active_version,updated_at FROM agent_service_process ORDER BY id",
      )
      .all();
    makeLegacyParent(h.db);
    assert.equal(
      h.db
        .prepare("PRAGMA table_info(agent_service_process)")
        .all()
        .find((c) => c.name === "service_id")!.notnull,
      1,
    );
    const migrated = new ServiceProcessStore(
      h.db,
      h.catalog,
      plugins,
      () => {},
    );
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(
      h.db
        .prepare(
          "SELECT id,organization_id,workspace_id,service_id,revision,draft,active_version,updated_at FROM agent_service_process ORDER BY id",
        )
        .all(),
      originalParent,
    );
    assert.equal(h.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    assert.deepEqual(h.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(
      h.db
        .prepare("PRAGMA table_info(agent_service_process)")
        .all()
        .find((c) => c.name === "service_id")!.notnull,
      0,
    );
    migrated.attachNativeQualificationGate((_actor, _artifact, current) =>
      assert.deepEqual(current, reference),
    );
    const originalRunId = serviceProcessRunIdentity(
      scope,
      admin.organizationId,
      "TEST-migrate-pending",
    ).parentRunId;
    assert.deepEqual(
      migrated.resolveRun(admin, originalRunId),
      h.registry.resolveRun(admin, originalRunId),
    );
    assert.equal(migrated.version(admin, id, 1).digest, artifact.digest);
    assert.deepEqual(
      new ProcessVersionsStore(h.db, scope.serverId, migrated).freeze(admin, {
        organizationId: admin.organizationId,
        workspaceId: admin.workspaceId,
        profile: command.profile,
        requestId: command.requestId,
        processId: id,
        revision: command.revision,
      }),
      freeze,
    );
    assert.deepEqual(
      new ProcessDesignStore(h.db, migrated, h.catalog, plugins).start(
        admin,
        started,
      ),
      design,
    );
    assert.deepEqual(
      new ProcessDesignStore(h.db, migrated, h.catalog, plugins).get(
        admin,
        design.sessionId,
      ),
      review,
    );
    assert.deepEqual(
      await h.runtime.start(
        id,
        unknown.runId,
        { name: "TEST-unknown-input" },
        signal(),
      ),
      unknown,
    );
    assert.deepEqual(h.counts(), counts);
    migrateProcessOwners(h.db);
    assert.deepEqual(snapshot(), before);
    const originalApproval = wait.approval;
    const originalInvocation = JSON.parse(
      String(
        h.db
          .prepare("SELECT data FROM agent_service_invocation WHERE id=?")
          .get(originalApproval.operationId)!.data,
      ),
    );
    await h.close();
    const reopened = fixture(path, h.ids);
    try {
      reopened.registry.attachNativeQualificationGate(
        (actor, currentArtifact, current) => {
          assert.equal(actor.userId, admin.userId);
          assert.equal(currentArtifact.digest, artifact.digest);
          assert.deepEqual(current, reference);
        },
      );
      const completed = await reopened.runtime.resume(
        wait.runId,
        { ...originalApproval, approved: true },
        signal(),
      );
      assert.equal(completed.status, "succeeded");
      assert(completed.operations.includes(originalApproval.operationId));
      const receipt = JSON.parse(
        String(
          reopened.db
            .prepare("SELECT data FROM agent_service_invocation WHERE id=?")
            .get(originalApproval.operationId)!.data,
        ),
      );
      assert.equal(receipt.status, "succeeded");
      for (const key of [
        "id",
        "organizationId",
        "workspaceId",
        "userId",
        "serviceId",
        "actionId",
        "serviceRevision",
        "actionRevision",
        "policyRevision",
        "input",
      ])
        assert.deepEqual(receipt[key], originalInvocation[key]);
      assert.deepEqual(
        reopened.counts(),
        counts.map(([method, count]) => [
          method,
          method === "POST" ? Number(count) + 1 : count,
        ]),
      );
      const completedCounts = reopened.counts();
      assert.deepEqual(
        await reopened.runtime.start(
          id,
          wait.runId,
          { name: "TEST-original-input" },
          signal(),
        ),
        completed,
      );
      assert.deepEqual(
        await reopened.runtime.start(
          id,
          unknown.runId,
          { name: "TEST-unknown-input" },
          signal(),
        ),
        unknown,
      );
      assert.deepEqual(reopened.counts(), completedCounts);
    } finally {
      await reopened.close();
    }
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
