import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ProcessActivationCommandSchema,
  PROCESS_ACTIVATION_PROFILE,
} from "../packages/protocol/process-activation";
import {
  NativeTestRequestSchema,
  PROCESS_NATIVE_TEST_PROFILE,
  type NativeTestJob,
} from "../packages/protocol/process-native-testing";
import {
  WORKSPACE_DESIGN_PROFILE,
  WorkspaceDesignReviewSchema,
} from "../packages/protocol/process-design";
import { PROCESS_VERSION_PROFILE } from "../packages/protocol/process-versions";
import {
  WORKSPACE_PROCESS_PROFILE,
  WorkspaceProcessListSchema,
  type ProcessDefinition,
} from "../packages/protocol/service-processes";
import { ProcessExecutionInventorySchema } from "../packages/protocol/process-execution";
import { AuditStore } from "../apps/server-identity/audit";
import { ProcessActivationStore } from "../apps/server-identity/process-activation-store";
import { ProcessTestingStore } from "../apps/server-identity/process-testing-store";
import { ProcessVersionsStore } from "../apps/server-identity/process-versions-store";
import {
  processNativeStamp,
  processNativeExecutionSettings,
} from "../apps/server-identity/process-native-environment";
import { runProcessNativeComparison } from "../apps/server-identity/process-native-testing";
import { migrateProcessOwners } from "../apps/server-identity/process-owner-migration";
import { handleServiceProcesses } from "../apps/server-identity/process-controller";
import {
  handleProcessDesign,
  PROCESS_DESIGN_PATH,
} from "../apps/server-identity/process-design-controller";
import { designCapabilities } from "../apps/server-identity/process-design-capabilities";
import type { CatalogContext } from "../apps/server-identity/catalog-controller";
import {
  ServiceProcessStore,
  type ProcessActor,
} from "../apps/server-identity/service-processes";
import { IdentityError } from "../apps/server-identity/error";
import {
  designFixture,
  designActor,
  designTarget,
} from "./helpers/process-design";
import {
  fixture,
  admin,
  target,
  scope,
  signal,
} from "./helpers/service-process-runtime";
import { buildNativeTestFixture } from "./helpers/process-native-testing";
import { buildNativeQualificationSuite } from "./helpers/process-native-qualification";

const code = (name: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === name;
const designMember = (userId: string): ProcessActor => ({
  ...designTarget,
  userId,
  role: "member",
});
const designAdmin: ProcessActor = {
  ...designTarget,
  userId: "TEST-design-admin",
  role: "admin",
};

/** Members may use the fixture's lookup action, as the chat runtime would allow. */
function memberDesign() {
  const h = designFixture();
  h.setAction({ policy: { roles: ["owner", "admin", "member"], users: [] } });
  return h;
}

test("registry authorization matrix: own personal vs someone else's vs workspace, admin read-only", () => {
  const h = memberDesign();
  const alice = designMember("TEST-alice"),
    bob = designMember("TEST-bob");
  try {
    const mine = h.registry.saveWorkspaceDraft(alice, {
      owner: { type: "user" },
      revision: 0,
      definition: h.workflow(),
    });
    assert.deepEqual("owner" in mine && mine.owner, {
      type: "user",
      userId: alice.userId,
    });
    const workspace = h.registry.saveWorkspaceDraft(designActor, {
      revision: 0,
      definition: h.workflow(),
    });
    const service = h.registry.saveDraft(designActor, {
      serviceId: h.serviceId,
      revision: 0,
      definition: h.workflow(),
    });
    const theirs = h.registry.saveWorkspaceDraft(designAdmin, {
      owner: { type: "user", userId: designAdmin.userId },
      revision: 0,
      definition: h.workflow(),
    });

    // The owner runs every lifecycle step without an administrator.
    const edited = h.registry.saveWorkspaceDraft(alice, {
      id: mine.id,
      owner: { type: "user" },
      revision: mine.revision,
      definition: { ...h.workflow(), name: "TEST my process" },
    });
    const frozen = h.registry.freezeDraft(alice, edited.id, edited.revision);
    assert.equal(frozen.createdBy, alice.userId);
    assert.equal(h.registry.version(alice, mine.id, 1).digest, frozen.digest);
    assert.equal(h.registry.listVersions(alice, mine.id).versions.length, 1);
    assert.equal(
      h.registry.testArtifact(alice, mine.id, 1).digest,
      frozen.digest,
    );
    assert.deepEqual(
      h.registry.listOwned(alice).processes.map((p) => p.id),
      [mine.id],
    );

    // Someone else's personal process does not exist for another member.
    for (const run of [
      () => h.registry.getOwned(bob, mine.id),
      () => h.registry.version(bob, mine.id, 1),
      () => h.registry.freezeDraft(bob, mine.id, 3),
      () => h.registry.testArtifact(bob, mine.id, 1),
      () =>
        h.registry.saveWorkspaceDraft(bob, {
          id: mine.id,
          owner: { type: "user" },
          revision: 3,
          definition: h.workflow(),
        }),
      () => h.registry.assertExecutionScope(bob, mine.id),
      () => h.registry.getOwned(alice, theirs.id),
    ])
      assert.throws(run, code("process_not_found"));
    assert.deepEqual(h.registry.listOwned(bob).processes, []);

    // Workspace and service processes stay admin-managed.
    for (const run of [
      () => h.registry.getOwned(alice, workspace.id),
      () => h.registry.freezeDraft(alice, workspace.id, workspace.revision),
      () => h.registry.get(alice, service.id),
      () => h.registry.list(alice),
      () =>
        h.registry.saveWorkspaceDraft(alice, {
          revision: 0,
          definition: h.workflow(),
        }),
      () =>
        h.registry.validateOwner(alice, { type: "workspace" }, h.workflow()),
      () =>
        h.registry.saveWorkspaceDraft(alice, {
          owner: { type: "user", userId: bob.userId },
          revision: 0,
          definition: h.workflow(),
        }),
    ])
      assert.throws(run, code("identity_forbidden"));
    // Members can still execute workspace processes under their own grants.
    h.registry.assertExecutionScope(alice, workspace.id);

    // Administrators may read a personal process but never change, test or run it.
    assert.equal(h.registry.getOwned(designActor, mine.id).revision, 3);
    assert.equal(
      h.registry.version(designActor, mine.id, 1).digest,
      frozen.digest,
    );
    assert.deepEqual(
      h.registry
        .listOwned(designActor)
        .processes.map((p) => ("owner" in p ? p.owner : { type: "service" }))
        .filter((owner) => owner.type === "user"),
      [
        { type: "user", userId: alice.userId },
        { type: "user", userId: designAdmin.userId },
      ].sort((a, b) =>
        (a.userId === alice.userId ? mine.id : theirs.id) <
        (b.userId === alice.userId ? mine.id : theirs.id)
          ? -1
          : 1,
      ),
    );
    for (const run of [
      () => h.registry.freezeDraft(designActor, mine.id, 3),
      () => h.registry.testArtifact(designActor, mine.id, 1),
      () => h.registry.activate(designActor, mine.id, 3, 1),
      () =>
        h.registry.saveWorkspaceDraft(designActor, {
          id: mine.id,
          owner: { type: "user", userId: alice.userId },
          revision: 3,
          definition: h.workflow(),
        }),
    ])
      assert.throws(run, (error) =>
        ["process_personal_read_only", "identity_forbidden"].includes(
          (error as IdentityError).code,
        ),
      );
    assert.throws(
      () => h.registry.freezeDraft(designActor, mine.id, 3),
      code("process_personal_read_only"),
    );
    assert.throws(
      () => h.registry.assertExecutionScope(designActor, mine.id),
      code("process_not_found"),
    );
    // The owner cannot be changed by an edit, neither to workspace nor to a person.
    assert.throws(
      () =>
        h.registry.saveWorkspaceDraft(designActor, {
          id: workspace.id,
          owner: { type: "user" },
          revision: workspace.revision,
          definition: h.workflow(),
        }),
      code("process_conflict"),
    );
    assert.throws(
      () =>
        h.db
          .prepare(
            "UPDATE agent_service_process SET owner_user_id=? WHERE id=?",
          )
          .run(bob.userId, mine.id),
      /process_owner_immutable/,
    );
  } finally {
    h.db.close();
  }
});

test("personal processes reference only actions their owner may use, checked again on freeze", () => {
  const h = designFixture();
  const alice = designMember("TEST-alice");
  h.db.exec(
    "INSERT INTO member VALUES ('TEST-alice-member','TEST-design-org','TEST-alice')",
  );
  try {
    // The fixture's action is restricted to owners/admins.
    const invalid = h.registry.validateOwner(
      alice,
      { type: "user" },
      h.workflow(),
    );
    assert.equal(invalid.valid, false);
    assert(invalid.issues.some((issue) => issue.code === "capability_denied"));
    assert.throws(
      () =>
        h.registry.saveWorkspaceDraft(alice, {
          owner: { type: "user" },
          revision: 0,
          definition: h.workflow(),
        }),
      code("process_definition_invalid"),
    );
    assert.deepEqual(
      designCapabilities(h.catalog, h.plugins, alice).services.flatMap(
        (s) => s.actions,
      ),
      [],
    );
    // An administrator's personal process is likewise limited to their grants.
    assert(
      h.registry.validateOwner(designAdmin, { type: "user" }, h.workflow())
        .valid,
    );
    h.setAction({ policy: { roles: ["owner", "admin", "member"], users: [] } });
    const draft = h.registry.saveWorkspaceDraft(alice, {
      owner: { type: "user" },
      revision: 0,
      definition: h.workflow(),
    });
    // Losing the grant before freezing blocks the freeze.
    h.setAction({
      policy: {
        roles: ["owner", "admin", "member"],
        users: [{ userId: alice.userId, access: "deny" }],
      },
    });
    assert.throws(
      () => h.registry.freezeDraft(alice, draft.id, draft.revision),
      code("process_definition_invalid"),
    );
  } finally {
    h.db.close();
  }
});

test("designer: a member's workspace request becomes personal, stays private and can be frozen by them", async () => {
  const h = memberDesign();
  const alice = designMember("TEST-alice"),
    bob = designMember("TEST-bob");
  let current: ProcessActor = alice;
  const context: CatalogContext = {
    serial: async (fn) => fn(),
    transaction: async (fn) => fn(),
    actor: async () => ({ userId: current.userId, role: current.role }),
    epoch: () => 0,
    change: () => {},
    audit: () => 0,
    finish: () => {},
  };
  const design = (method: string, path: string, body?: unknown) =>
    handleProcessDesign(
      method,
      new URL(
        PROCESS_DESIGN_PATH +
          path +
          (path.includes("?") ? "&" : "?") +
          "profile=" +
          WORKSPACE_DESIGN_PROFILE,
        "http://localhost",
      ),
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
  const registry = (method: string, path: string, body?: unknown) =>
    handleServiceProcesses(
      method,
      new URL("/admin/api/identity/catalog/processes" + path, "http://x"),
      body,
      h.registry,
      context,
    );
  try {
    const capabilities = (await design(
      "GET",
      "/capabilities?" + new URLSearchParams(designTarget),
    )) as { capabilities: { services: { actions: unknown[] }[] } };
    assert.equal(
      capabilities.capabilities.services.flatMap((s) => s.actions).length,
      1,
    );
    const started = (await design("POST", "/start", {
      ...designTarget,
      profile: WORKSPACE_DESIGN_PROFILE,
      requestId: "TEST-personal-start",
      owner: { type: "workspace" },
    })) as unknown as { receipt: { sessionId: string }; review: unknown };
    const review = WorkspaceDesignReviewSchema.parse(started.review);
    assert.deepEqual(review.owner, { type: "user", userId: alice.userId });
    const sessionId = started.receipt.sessionId;
    const updated = h.store.update(alice, {
      ...designTarget,
      sessionId,
      requestId: "TEST-personal-update",
      revision: 1,
      brief: { ...review.brief, purpose: "TEST my lookup" },
      candidate: h.workflow(),
    });
    const ready = h.store.getWorkspace(alice, sessionId);
    assert.deepEqual(ready.blockers, []);
    const accepted = h.store.accept(alice, {
      ...designTarget,
      sessionId,
      requestId: "TEST-personal-accept",
      revision: updated.revision,
      reviewDigest: ready.reviewDigest,
    });
    const processId = accepted.processId!;
    const saved = h.registry.getOwned(alice, processId);
    assert.deepEqual("owner" in saved && saved.owner, {
      type: "user",
      userId: alice.userId,
    });
    // Sessions are creator-private, and a member never holds a workspace one.
    current = bob;
    await assert.rejects(
      design("GET", "?" + new URLSearchParams({ ...designTarget, sessionId })),
      code("process_design_not_found"),
    );
    await assert.rejects(
      design("POST", "/start", {
        ...designTarget,
        profile: WORKSPACE_DESIGN_PROFILE,
        requestId: "TEST-bob-edits-alice",
        owner: { type: "user" },
        processId,
      }),
      code("process_not_found"),
    );
    // An administrator cannot take over a personal process through the designer.
    await assert.rejects(
      (async () => {
        current = designActor;
        return design("POST", "/start", {
          ...designTarget,
          profile: WORKSPACE_DESIGN_PROFILE,
          requestId: "TEST-admin-edits-alice",
          owner: { type: "workspace" },
          processId,
        });
      })(),
      code("process_design_conflict"),
    );
    // Metadata API: the member lists exactly their own processes and freezes.
    current = alice;
    const list = WorkspaceProcessListSchema.parse(
      await registry(
        "GET",
        "?" +
          new URLSearchParams({
            ...designTarget,
            profile: WORKSPACE_PROCESS_PROFILE,
          }),
      ),
    );
    assert.deepEqual(
      list.processes.map((p) => p.id),
      [processId],
    );
    const versions = new ProcessVersionsStore(h.db, "TEST-server", h.registry);
    const receipt = versions.freeze(alice, {
      ...designTarget,
      profile: PROCESS_VERSION_PROFILE,
      requestId: "TEST-personal-freeze",
      processId,
      revision: h.registry.getOwned(alice, processId).revision,
    });
    assert.equal(receipt.version, 1);
    assert.throws(
      () =>
        versions.freeze(bob, {
          ...designTarget,
          profile: PROCESS_VERSION_PROFILE,
          requestId: "TEST-bob-freeze",
          processId,
          revision: receipt.resultingRevision,
        }),
      code("process_not_found"),
    );
    // The /1 service metadata API stays admin-only.
    await assert.rejects(
      registry("GET", "?" + new URLSearchParams(designTarget)),
      code("identity_forbidden"),
    );
  } finally {
    h.db.close();
  }
});

/** Actual native qualification and activation of a member's personal process. */
async function personalLifecycle(
  run: (x: {
    h: ReturnType<typeof fixture>;
    owner: ProcessActor;
    processId: string;
    job: NativeTestJob;
    activation: ProcessActivationStore;
    journal: ProcessTestingStore;
    decide: (job: NativeTestJob) => unknown;
    setRole: (userId: string, role: ProcessActor["role"] | null) => void;
  }) => Promise<void>,
  workspace = false,
) {
  const root = mkdtempSync(join(tmpdir(), "niaro-personal-"));
  const h = fixture(join(root, "identity.sqlite"));
  try {
    const x = buildNativeTestFixture(h);
    const suite = buildNativeQualificationSuite(x);
    // For comparison, `workspace` qualifies a workspace process as the admin.
    const owner: ProcessActor = workspace
      ? admin
      : { ...target, userId: "TEST-personal-owner", role: "member" };
    const roles = new Map<string, ProcessActor["role"] | null>([
      [admin.userId, "owner"],
      ["TEST-personal-owner", "member"],
    ]);
    const audit = new AuditStore(h.db);
    const journal = new ProcessTestingStore(
      h.db,
      "TEST-server",
      h.registry,
      (r) => audit.append(r),
      () => 1000000,
    );
    const activation = new ProcessActivationStore(
      h.db,
      "TEST-server",
      h.registry,
      h.catalog,
      journal,
      (r) => audit.append(r),
      {
        epoch: () => 0,
        creatorActor: (original) => {
          const role = roles.get(original.userId);
          if (!role)
            throw new IdentityError(
              409,
              "process_qualification_authority_changed",
            );
          return { ...original, role };
        },
      },
      () => 1000000,
    );
    const definition: ProcessDefinition = x.draft.draft;
    const draft = h.registry.saveWorkspaceDraft(owner, {
      owner: { type: workspace ? "workspace" : "user" },
      revision: 0,
      definition,
    });
    const frozen = h.registry.freezeDraft(owner, draft.id, draft.revision);
    const catalog = h.catalog.processTestCatalog(
      owner.organizationId,
      owner.workspaceId,
      owner,
      frozen.sources,
      suite.genericModelId,
    );
    assert.equal(catalog.role, owner.role);
    const environment = {
      catalog,
      executionSettings: processNativeExecutionSettings(frozen, catalog),
      authorityEpoch: 0,
    };
    const request = NativeTestRequestSchema.parse({
      ...target,
      profile: PROCESS_NATIVE_TEST_PROFILE,
      requestId: "TEST-personal-native",
      processId: frozen.processId,
      revision: h.registry.getOwned(owner, frozen.processId).revision,
      version: frozen.version,
      artifactDigest: frozen.digest,
      suite,
    });
    // Only the owner may reserve a native test of their personal process.
    for (const actor of (workspace
      ? []
      : [admin, { ...owner, userId: "TEST-other-member" }]) as ProcessActor[]) {
      const own = h.catalog.processTestCatalog(
        actor.organizationId,
        actor.workspaceId,
        actor,
        frozen.sources,
        suite.genericModelId,
      );
      assert.throws(
        () =>
          journal.reserveNative(
            actor,
            { ...request, requestId: "TEST-foreign-native" },
            processNativeStamp(frozen, own, suite),
            {
              catalog: own,
              executionSettings: processNativeExecutionSettings(frozen, own),
              authorityEpoch: 0,
            },
          ),
        actor.role === "member"
          ? code("process_not_found")
          : code("process_personal_read_only"),
      );
    }
    const { job: reserved } = journal.reserveNative(
      owner,
      request,
      processNativeStamp(frozen, catalog, suite),
      environment,
    );
    const report = await runProcessNativeComparison(
      frozen,
      catalog,
      suite,
      signal(),
      async () => {},
    );
    const job = journal.completeNative(
      owner,
      reserved.testId,
      report,
      environment,
    );
    assert.equal(
      job.qualification?.status,
      "qualified",
      JSON.stringify(job.qualification),
    );
    const decide = (current: NativeTestJob) => {
      const process = h.registry.getOwned(owner, current.processId);
      return activation.decide(
        owner,
        ProcessActivationCommandSchema.parse({
          ...target,
          profile: PROCESS_ACTIVATION_PROFILE,
          requestId: "TEST-personal-decision-" + process.revision,
          type: "activate",
          processId: current.processId,
          revision: process.revision,
          expectedActiveVersion: process.activeVersion,
          version: current.version,
          artifactDigest: current.stamp.artifactDigest,
          testId: current.testId,
          qualificationDigest: current.qualification!.qualificationDigest,
          acknowledgement: "controlled_native_test_only",
        }),
      );
    };
    await run({
      h,
      owner,
      processId: frozen.processId,
      job,
      activation,
      journal,
      decide,
      setRole: (userId, role) => roles.set(userId, role),
    });
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const scopeFor = (actor: ProcessActor) => ({ ...scope, userId: actor.userId });

test("owner qualifies and activates their personal process; only they see and run it; losing access blocks it", () =>
  personalLifecycle(
    async ({ h, owner, processId, job, activation, decide }) => {
      // An administrator can review metadata but cannot activate someone else's
      // personal process (their own test history is creator-private as well).
      assert.throws(
        () =>
          activation.review(admin, {
            ...target,
            profile: PROCESS_ACTIVATION_PROFILE,
            processId,
            version: 1,
            testId: job.testId,
          }),
        code("process_test_not_found"),
      );
      const receipt = decide(job) as { activeVersion: number };
      assert.equal(receipt.activeVersion, 1);
      assert.equal(h.registry.getOwned(admin, processId).activeVersion, 1);

      // Inventory isolation. The chat process_offer reads this same inventory.
      const mine = ProcessExecutionInventorySchema.parse(
        h.registry.executionInventory(owner, scopeFor(owner)),
      );
      const entry = mine.processes.find((p) => p.processId === processId);
      assert(entry, JSON.stringify(mine));
      assert.equal(entry.personal, true);
      assert.equal(entry.availability, "ready", JSON.stringify(entry));
      const other: ProcessActor = { ...owner, userId: "TEST-other-member" };
      for (const actor of [admin, other])
        assert(
          !h.registry
            .executionInventory(actor, scopeFor(actor))
            .processes.some((p) => p.processId === processId),
        );
      // Workspace/service entries keep their original bytes (no personal flag).
      assert(
        mine.processes
          .filter((p) => p.processId !== processId)
          .every((p) => !("personal" in p)),
      );

      // Only the owner can start; others cannot even learn it exists.
      const seen = { version: 1, artifactDigest: job.stamp.artifactDigest };
      for (const actor of [admin, other]) {
        assert.throws(
          () => h.registry.executionArtifact(actor, processId, seen),
          code("process_not_found"),
        );
        assert.throws(
          () => h.registry.pinRun(actor, processId, "TEST-foreign-run", seen),
          code("process_not_found"),
        );
      }
      assert.equal(
        h.registry.executionArtifact(owner, processId, seen).digest,
        job.stamp.artifactDigest,
      );
      const pinned = h.registry.pinRun(
        owner,
        processId,
        "TEST-personal-run",
        seen,
      );
      assert.equal(pinned.version, 1);
      assert.equal(
        h.registry.resolveRun(owner, "TEST-personal-run").digest,
        pinned.digest,
      );

      // The owner's current authority is checked on every run and listing.
      const allowed = h.catalog.allowed.bind(h.catalog);
      h.catalog.allowed = (action, actor) =>
        actor.userId !== owner.userId && allowed(action, actor);
      assert.throws(
        () => h.registry.resolveRun(owner, "TEST-personal-run"),
        code("process_definition_invalid"),
      );
      assert.throws(
        () => h.registry.pinRun(owner, processId, "TEST-personal-run-2", seen),
        code("process_definition_invalid"),
      );
      assert(
        !h.registry
          .executionInventory(owner, scopeFor(owner))
          .processes.some((p) => p.processId === processId),
      );
      h.catalog.allowed = allowed;
      assert.equal(
        h.registry.resolveRun(owner, "TEST-personal-run").digest,
        pinned.digest,
      );
    },
  ));

test("a personal qualification stops serving when its owner leaves the workspace", () =>
  personalLifecycle(async ({ h, owner, processId, job, decide, setRole }) => {
    decide(job);
    const seen = { version: 1, artifactDigest: job.stamp.artifactDigest };
    h.registry.pinRun(owner, processId, "TEST-personal-run", seen);
    setRole(owner.userId, null);
    assert.throws(
      () => h.registry.resolveRun(owner, "TEST-personal-run"),
      code("process_qualification_authority_changed"),
    );
    assert.throws(
      () => h.registry.pinRun(owner, processId, "TEST-personal-run-2", seen),
      code("process_qualification_authority_changed"),
    );
    const blocked = h.registry
      .executionInventory(owner, scopeFor(owner))
      .processes.find((p) => p.processId === processId);
    assert.equal(blocked?.availability, "blocked");
    // A role change alters the qualified grants, so it needs a new test;
    // the personal process stays theirs alone either way.
    setRole(owner.userId, "admin");
    assert.throws(
      () => h.registry.resolveRun(owner, "TEST-personal-run"),
      code("process_qualification_stale"),
    );
    assert.equal(h.registry.canManage(admin, processId), false);
    setRole(owner.userId, "member");
    assert.equal(
      h.registry.resolveRun(owner, "TEST-personal-run").digest,
      job.stamp.artifactDigest,
    );
  }));

test("migration adds personal owners to an existing owner table without touching rows or children", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE organization(id TEXT PRIMARY KEY);
      CREATE TABLE agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT);
      INSERT INTO organization VALUES('org'); INSERT INTO agent_workspace VALUES('workspace','org');
      CREATE TABLE agent_service_process (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
        service_id TEXT, revision INTEGER NOT NULL, draft TEXT NOT NULL,
        active_version INTEGER, updated_at TEXT NOT NULL,
        owner_type TEXT NOT NULL DEFAULT 'service' CHECK(owner_type IN ('service','workspace')),
        CHECK((owner_type='service' AND service_id IS NOT NULL) OR (owner_type='workspace' AND service_id IS NULL)),
        FOREIGN KEY(id,active_version) REFERENCES agent_service_process_version(process_id,version)
      ) STRICT;
      CREATE TABLE agent_service_process_version(process_id TEXT NOT NULL REFERENCES agent_service_process(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, PRIMARY KEY(process_id,version)) STRICT;
      INSERT INTO agent_service_process VALUES('svc','org','workspace','service',2,'{}',NULL,'TEST-time','service');
      INSERT INTO agent_service_process VALUES('ws','org','workspace',NULL,3,'{"a":1}',NULL,'TEST-time','workspace');
      INSERT INTO agent_service_process_version VALUES('svc',1),('ws',1);
      UPDATE agent_service_process SET active_version=1 WHERE id='ws';
      CREATE TRIGGER agent_service_process_owner_immutable
        BEFORE UPDATE OF owner_type,service_id ON agent_service_process
        WHEN NEW.owner_type IS NOT OLD.owner_type BEGIN SELECT RAISE(ABORT,'process_owner_immutable'); END;`);
    const before = db
      .prepare("SELECT * FROM agent_service_process ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
    migrateProcessOwners(db);
    const after = db
      .prepare("SELECT * FROM agent_service_process ORDER BY id")
      .all();
    assert.deepEqual(
      after.map(({ owner_user_id, ...row }) => {
        assert.equal(owner_user_id, null);
        return row;
      }),
      before,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM agent_service_process_version").all().length,
      2,
    );
    assert(
      db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE name='agent_service_process_owner_immutable'",
        )
        .get(),
    );
    assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.exec(
      "INSERT INTO agent_service_process(id,organization_id,workspace_id,service_id,revision,draft,active_version,updated_at,owner_type,owner_user_id) VALUES('mine','org','workspace',NULL,1,'{}',NULL,'TEST-time','user','TEST-user')",
    );
    for (const invalid of [
      "('bad1','org','workspace','service',1,'{}',NULL,'t','user','TEST-user')",
      "('bad2','org','workspace',NULL,1,'{}',NULL,'t','user',NULL)",
      "('bad3','org','workspace',NULL,1,'{}',NULL,'t','workspace','TEST-user')",
    ])
      assert.throws(
        () =>
          db.exec(
            `INSERT INTO agent_service_process(id,organization_id,workspace_id,service_id,revision,draft,active_version,updated_at,owner_type,owner_user_id) VALUES${invalid}`,
          ),
        /CHECK constraint failed/,
      );
    const snapshot = db.prepare("SELECT sql FROM sqlite_schema").all();
    migrateProcessOwners(db);
    assert.deepEqual(
      db.prepare("SELECT sql FROM sqlite_schema").all(),
      snapshot,
    );
  } finally {
    db.close();
  }
});

test("a store opened on a migrated database lists old rows unchanged for administrators and nothing for members", () => {
  const h = designFixture();
  try {
    const workspace = h.registry.saveWorkspaceDraft(designActor, {
      revision: 0,
      definition: h.workflow(),
    });
    const reopened = new ServiceProcessStore(
      h.db,
      h.catalog,
      h.plugins,
      () => {},
    );
    assert.deepEqual(
      reopened.getOwned(designActor, workspace.id),
      h.registry.getOwned(designActor, workspace.id),
    );
    assert.deepEqual("owner" in workspace && workspace.owner, {
      type: "workspace",
    });
    assert.deepEqual(
      reopened.listOwned(designMember("TEST-alice")).processes,
      [],
    );
  } finally {
    h.db.close();
  }
});

test("a personal process does not block removing a service; it fails closed for its owner instead", () => {
  const h = memberDesign();
  const alice = designMember("TEST-alice");
  try {
    const draft = h.registry.saveWorkspaceDraft(alice, {
      owner: { type: "user" },
      revision: 0,
      definition: h.workflow(),
    });
    h.command({
      type: "removeService",
      id: h.serviceId,
      revision: h.catalog.service(designTarget.workspaceId, h.serviceId)
        .revision,
    });
    assert.throws(
      () => h.registry.freezeDraft(alice, draft.id, draft.revision),
      code("process_definition_invalid"),
    );
  } finally {
    h.db.close();
  }
});

test("a workspace qualification stops serving when its admin is demoted, with the same code", () =>
  personalLifecycle(async ({ h, owner, processId, job, decide, setRole }) => {
    decide(job);
    const seen = { version: 1, artifactDigest: job.stamp.artifactDigest };
    h.registry.pinRun(owner, processId, "TEST-workspace-run", seen);
    setRole(owner.userId, "member");
    assert.throws(
      () =>
        h.registry.resolveRun(
          { ...owner, role: "member" },
          "TEST-workspace-run",
        ),
      code("process_qualification_authority_changed"),
    );
  }, true));

test("the owner deletes (archives) their personal process; nobody else can, and it leaves every list", async () => {
  const h = memberDesign();
  const alice = designMember("TEST-alice"),
    bob = designMember("TEST-bob");
  let current: ProcessActor = alice;
  const context: CatalogContext = {
    serial: async (fn) => fn(),
    transaction: async (fn) => fn(),
    actor: async () => ({ userId: current.userId, role: current.role }),
    epoch: () => 0,
    change: () => {},
    audit: () => 0,
    finish: () => {},
  };
  const archive = (id: string, revision: number) =>
    handleServiceProcesses(
      "POST",
      new URL("/admin/api/identity/catalog/processes/archive", "http://x"),
      {
        ...designTarget,
        profile: WORKSPACE_PROCESS_PROFILE,
        type: "archive",
        id,
        revision,
      },
      h.registry,
      context,
    );
  try {
    const mine = h.registry.saveWorkspaceDraft(alice, {
      owner: { type: "user" },
      revision: 0,
      definition: h.workflow(),
    });
    const workspace = h.registry.saveWorkspaceDraft(designActor, {
      revision: 0,
      definition: h.workflow(),
    });
    // Someone else cannot learn it exists; an administrator keeps read-only.
    current = bob;
    await assert.rejects(
      archive(mine.id, mine.revision),
      code("process_not_found"),
    );
    current = designAdmin;
    await assert.rejects(
      archive(mine.id, mine.revision),
      code("process_personal_read_only"),
    );
    // Company processes are not archived this way, by anyone.
    current = designActor;
    await assert.rejects(
      archive(workspace.id, workspace.revision),
      code("process_archive_forbidden"),
    );
    current = alice;
    await assert.rejects(
      archive(workspace.id, workspace.revision),
      code("identity_forbidden"),
    );
    await assert.rejects(
      archive(mine.id, mine.revision + 1),
      code("process_conflict"),
    );
    const result = (await archive(mine.id, mine.revision)) as {
      id: string;
      archivedAt: string;
    };
    assert.equal(result.id, mine.id);
    assert.deepEqual(h.registry.listOwned(alice).processes, []);
    assert(
      !h.registry
        .listOwned(designActor)
        .processes.some((p) => p.id === mine.id),
    );
    for (const actor of [alice, designActor])
      assert.throws(
        () => h.registry.getOwned(actor, mine.id),
        code("process_not_found"),
      );
    assert.throws(
      () => h.registry.freezeDraft(alice, mine.id, mine.revision + 1),
      code("process_not_found"),
    );
    await assert.rejects(
      archive(mine.id, mine.revision + 1),
      code("process_not_found"),
    );
    const audit = h.db
      .prepare(
        "SELECT actor_id AS actor, details FROM agent_audit WHERE target_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(mine.id) as { actor: string; details: string };
    assert.equal(audit.actor, alice.userId);
    assert.equal(JSON.parse(audit.details).processEvent, "archived");
  } finally {
    h.db.close();
  }
});

test("archiving stops a personal process: no new starts or steps, but past runs keep their provenance", () =>
  personalLifecycle(async ({ h, owner, processId, job, decide }) => {
    decide(job);
    const seen = { version: 1, artifactDigest: job.stamp.artifactDigest };
    const pinned = h.registry.pinRun(
      owner,
      processId,
      "TEST-archived-run",
      seen,
    );
    const process = h.registry.getOwned(owner, processId);
    h.registry.archive(owner, processId, process.revision);
    assert(
      !h.registry
        .executionInventory(owner, scopeFor(owner))
        .processes.some((p) => p.processId === processId),
    );
    assert.throws(
      () => h.registry.executionArtifact(owner, processId, seen),
      code("process_not_found"),
    );
    assert.throws(
      () => h.registry.pinRun(owner, processId, "TEST-archived-run-2", seen),
      code("process_not_found"),
    );
    // A run already in progress stops at its next step.
    assert.throws(
      () => h.registry.resolveRun(owner, "TEST-archived-run"),
      code("process_not_found"),
    );
    // Its receipts and history still resolve the version it ran.
    assert.equal(
      h.registry.pinnedVersion(owner, "TEST-archived-run").digest,
      pinned.digest,
    );
    h.registry.assertExecutionScope(owner, processId);
  }));

test("a process table without archived_at gains the column and keeps its rows", () => {
  const h = designFixture();
  try {
    const workspace = h.registry.saveWorkspaceDraft(designActor, {
      revision: 0,
      definition: h.workflow(),
    });
    h.db.exec("ALTER TABLE agent_service_process DROP COLUMN archived_at");
    const reopened = new ServiceProcessStore(
      h.db,
      h.catalog,
      h.plugins,
      () => {},
    );
    assert(
      h.db
        .prepare("PRAGMA table_info(agent_service_process)")
        .all()
        .some((column) => column.name === "archived_at"),
    );
    assert.deepEqual(
      reopened.listOwned(designActor).processes.map((p) => p.id),
      [workspace.id],
    );
  } finally {
    h.db.close();
  }
});
