import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProcessActivationCommandSchema,
  ProcessActivationReceiptSchema,
  PROCESS_ACTIVATION_PROFILE,
} from "../packages/protocol/process-activation";
import {
  NativeTestRequestSchema,
  PROCESS_NATIVE_TEST_PROFILE,
  type NativeTestJob,
  type NativeTestSuite,
} from "../packages/protocol/process-native-testing";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { AuditStore } from "../apps/server-identity/audit";
import { ProcessActivationStore } from "../apps/server-identity/process-activation-store";
import { ProcessTestingStore } from "../apps/server-identity/process-testing-store";
import {
  processNativeStamp,
  processNativeExecutionSettings,
} from "../apps/server-identity/process-native-environment";
import { runProcessNativeComparison } from "../apps/server-identity/process-native-testing";
import { processDigest } from "../apps/server-identity/process-validation";
import {
  PROCESS_TEST_SCENARIOS,
  type ProcessActor,
} from "../apps/server-identity/service-processes";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import {
  fixture,
  admin,
  target,
  signal,
  code,
} from "./helpers/service-process-runtime";
import { buildNativeTestFixture } from "./helpers/process-native-testing";
import { buildNativeQualificationSuite } from "./helpers/process-native-qualification";
import { callProcessTool } from "./helpers/service-process-agent";

function lifecycleFixture() {
  const root = mkdtempSync(join(tmpdir(), "niaro-activation-"));
  const path = join(root, "identity.sqlite");
  let h = fixture(path);
  const x = buildNativeTestFixture(h);
  const suite = buildNativeQualificationSuite(x);
  let epoch = 0,
    sequence = 0,
    failAudit = false,
    creatorAllowed = true;
  let creatorRole: ProcessActor["role"] = "owner";
  const authority = {
    epoch: () => epoch,
    creatorActor: (original: ProcessActor): ProcessActor => {
      if (!creatorAllowed || creatorRole === "member")
        throw new Error("TEST qualification creator revoked");
      return { ...original, role: creatorRole };
    },
  };
  const attach = () => {
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
      (r) => {
        audit.append(r);
        if (failAudit) throw Error("TEST activation audit failed");
      },
      authority,
      () => 1000000,
    );
    return { journal, activation };
  };
  let stores = attach();
  const artifact = (version = 1) =>
    h.registry.version(admin, x.draft.id, version);
  const reserve = (
    version = 1,
    selectedSuite = suite,
    actor = admin,
    retestActive?: true,
  ) => {
    const frozen = artifact(version);
    const catalog = h.catalog.processTestCatalog(
      actor.organizationId,
      actor.workspaceId,
      actor,
      frozen.sources,
      selectedSuite.genericModelId,
    );
    const environment = {
      catalog,
      executionSettings: processNativeExecutionSettings(frozen, catalog),
      authorityEpoch: epoch,
    };
    const request = NativeTestRequestSchema.parse({
      ...target,
      profile: PROCESS_NATIVE_TEST_PROFILE,
      requestId: "TEST-native-" + ++sequence,
      processId: frozen.processId,
      revision: h.registry.get(actor, frozen.processId).revision,
      version,
      artifactDigest: frozen.digest,
      suite: selectedSuite,
      ...(retestActive ? { retestActive } : {}),
    });
    const { job } = stores.journal.reserveNative(
      actor,
      request,
      processNativeStamp(frozen, catalog, selectedSuite),
      environment,
    );
    return { request, job, artifact: frozen, environment, actor };
  };
  const finish = async (reserved: ReturnType<typeof reserve>) => {
    const report = await runProcessNativeComparison(
      reserved.artifact,
      reserved.environment.catalog,
      reserved.request.suite,
      signal(),
      async () => {},
    );
    return stores.journal.completeNative(
      reserved.actor,
      reserved.job.testId,
      report,
      reserved.environment,
    );
  };
  const qualify = async (
    version = 1,
    selectedSuite = suite,
    retestActive?: true,
  ) => finish(reserve(version, selectedSuite, admin, retestActive));
  const command = (
    job: NativeTestJob,
    type: "activate" | "rollback" = "activate",
  ) => {
    const process = h.registry.get(admin, job.processId);
    return ProcessActivationCommandSchema.parse({
      ...target,
      profile: PROCESS_ACTIVATION_PROFILE,
      requestId: "TEST-decision-" + ++sequence,
      type,
      processId: job.processId,
      revision: process.revision,
      expectedActiveVersion: process.activeVersion,
      version: job.version,
      artifactDigest: job.stamp.artifactDigest,
      testId: job.testId,
      qualificationDigest: job.qualification!.qualificationDigest,
      acknowledgement: "controlled_native_test_only",
    });
  };
  const freezeNext = () => {
    const process = h.registry.get(admin, x.draft.id);
    const draft = h.registry.saveDraft(admin, {
      id: process.id,
      serviceId: process.serviceId,
      revision: process.revision,
      definition: ProcessDefinitionSchema.parse({
        ...process.draft,
        name: "TEST next version",
        description: "TEST changed exact artifact",
      }),
    });
    return h.registry.freezeDraft(admin, draft.id, draft.revision);
  };
  const counts = () =>
    Object.fromEntries(
      [
        "agent_service_process_test",
        "agent_service_process_qualification",
        "agent_service_process_run",
        "agent_process_activation_command",
        "agent_inference_run",
        "agent_service_invocation",
        "agent_audit",
      ].map((table) => [
        table,
        h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
      ]),
    );
  return {
    get h() {
      return h;
    },
    get journal() {
      return stores.journal;
    },
    get activation() {
      return stores.activation;
    },
    x,
    suite,
    artifact,
    reserve,
    finish,
    qualify,
    command,
    freezeNext,
    counts,
    bumpEpoch: () => epoch++,
    revokeCreator: () => {
      creatorAllowed = false;
    },
    changeCreatorRole: () => {
      creatorRole = "admin";
    },
    failAudit: () => {
      failAudit = true;
    },
    reopen: async () => {
      await h.close();
      h = fixture(path, x.h.ids);
      stores = attach();
    },
    close: async () => {
      await h.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function isolated(
  run: (x: ReturnType<typeof lifecycleFixture>) => Promise<void>,
) {
  const x = lifecycleFixture();
  try {
    await run(x);
  } finally {
    await x.close();
  }
}

test("actual six-family evidence activates exactly once; metadata reads and exact replay remain passive after drift and two reopens", () =>
  isolated(async (x) => {
    const job = await x.qualify();
    assert.equal(
      job.qualification?.status,
      "qualified",
      JSON.stringify(job.qualification),
    );
    assert.equal(job.report?.activationEligible, false);
    const review = x.activation.review(admin, {
      ...target,
      profile: PROCESS_ACTIVATION_PROFILE,
      processId: job.processId,
      version: 1,
      testId: job.testId,
    });
    assert.equal(review.canActivate, true);
    assert.equal(review.canRollback, false);
    const input = x.command(job);
    const receipt = ProcessActivationReceiptSchema.parse(
      x.activation.decide(admin, input),
    );
    assert.equal(receipt.activeVersion, 1);
    assert.equal(receipt.qualification.liveAcceptance, false);
    assert.equal(
      x.h.registry.version(admin, job.processId, 1).testStatus,
      "passed",
    );
    const after = x.counts();
    assert.deepEqual(x.activation.decide(admin, input), receipt);
    assert.deepEqual(x.activation.read(admin, input.requestId), receipt);
    assert.deepEqual(x.counts(), after);
    assert.equal(after.agent_inference_run, 0);
    assert.equal(after.agent_service_invocation, 0);
    assert.throws(
      () => x.activation.decide(admin, { ...input, type: "rollback" }),
      code("process_activation_conflict"),
    );
    x.changeCreatorRole();
    assert.throws(
      () => x.activation.decide(admin, x.command(job)),
      code("process_qualification_stale"),
    );
    for (let n = 0; n < 2; n++) {
      await x.reopen();
      const before = x.counts();
      x.h.catalog.processTestCatalog = () => {
        throw Error("TEST replay must not resolve sources");
      };
      x.h.registry.testArtifact = () => {
        throw Error("TEST replay must not validate runtime");
      };
      assert.deepEqual(x.activation.decide(admin, input), receipt);
      assert.deepEqual(x.activation.read(admin, input.requestId), receipt);
      assert.deepEqual(
        x.journal.replayNative(
          admin,
          x.journal.nativeEvidence(admin, job.testId).request,
        ),
        job,
      );
      assert.deepEqual(x.counts(), before);
    }
  }));

test("a passed subset is never activation evidence", () =>
  isolated(async (x) => {
    const suite: NativeTestSuite = { ...x.suite, cases: [x.suite.cases[0]!] };
    const job = await x.qualify(1, suite);
    assert.equal(job.status, "completed");
    assert.equal(job.qualification?.status, "failed");
    const before = x.counts();
    assert.throws(
      () => x.activation.decide(admin, x.command(job)),
      code("process_qualification_required"),
    );
    assert.equal(x.h.registry.get(admin, job.processId).activeVersion, null);
    assert.deepEqual(x.counts(), before);
  }));

test("a distinct member runs under their own permissions while qualification stays bound to its private manager", () =>
  isolated(async (x) => {
    const job = await x.qualify();
    x.activation.decide(admin, x.command(job));
    const member: ProcessActor = {
      ...admin,
      userId: "TEST-distinct-runner",
      role: "member",
    };
    const pinned = x.h.registry.pinRun(
      member,
      job.processId,
      "TEST-distinct-pin",
    );
    assert.equal(pinned.version, 1);
    assert.throws(
      () =>
        x.h.registry.resolveRun(
          { ...member, userId: "TEST-foreign-runner" },
          "TEST-distinct-pin",
        ),
      code("process_not_found"),
    );
    assert.throws(
      () => x.journal.nativeEvidence(member, job.testId),
      code("process_test_not_found"),
    );
    const originalAllowed = x.h.catalog.allowed.bind(x.h.catalog);
    x.h.catalog.allowed = (action, actor) =>
      actor.userId !== member.userId && originalAllowed(action, actor);
    assert.throws(
      () => x.h.registry.resolveRun(member, "TEST-distinct-pin"),
      code("process_definition_invalid"),
    );
    const review = x.activation.review(admin, {
      ...target,
      profile: PROCESS_ACTIVATION_PROFILE,
      processId: job.processId,
      version: 1,
      testId: job.testId,
    });
    assert.equal(review.qualification.status, "qualified");
    assert.throws(
      () => x.h.registry.resolveRun(admin, "TEST-distinct-pin"),
      code("process_not_found"),
    );
  }));

test("wrong bindings, unknown payload fields, stale CAS, foreign creator and unactivated rollback cannot promote evidence", () =>
  isolated(async (x) => {
    const job = await x.qualify();
    const input = x.command(job),
      before = x.counts();
    for (const forged of [
      { actor: admin },
      { report: job.report },
      { liveAcceptance: true },
      { acknowledgement: "human" },
    ])
      assert.equal(
        ProcessActivationCommandSchema.safeParse({ ...input, ...forged })
          .success,
        false,
      );
    for (const changed of [
      { artifactDigest: "a".repeat(64) },
      { qualificationDigest: "b".repeat(64) },
      { version: 2 },
    ])
      assert.throws(() => x.activation.decide(admin, { ...input, ...changed }));
    assert.throws(
      () =>
        x.activation.decide(admin, { ...input, revision: input.revision + 1 }),
      code("process_conflict"),
    );
    assert.throws(
      () => x.activation.decide(admin, { ...input, expectedActiveVersion: 1 }),
      code("process_conflict"),
    );
    assert.throws(
      () => x.activation.decide({ ...admin, role: "member" }, input),
      code("identity_forbidden"),
    );
    assert.throws(
      () =>
        x.activation.decide({ ...admin, userId: "TEST-other-manager" }, input),
      code("process_test_not_found"),
    );
    assert.throws(
      () => x.activation.decide(admin, { ...input, type: "rollback" }),
      code("process_rollback_unavailable"),
    );
    assert.deepEqual(x.counts(), before);
  }));

test("durable latest reservation blocks old qualification for a new decision across creators, interruption, VACUUM and reopen while the accepted binding keeps serving; legacy metadata cannot erase native lineage", () =>
  isolated(async (x) => {
    const job = await x.qualify();
    x.activation.decide(admin, x.command(job));
    x.h.registry.pinRun(
      { ...admin, role: "member" },
      job.processId,
      "TEST-original-pin",
    );
    assert.throws(() => x.reserve(), code("process_test_active_version"));
    const other = { ...admin, userId: "TEST-second-manager" };
    const next = x.reserve(1, x.suite, other, true);
    assert.equal(next.job.createdAt, job.createdAt);
    assert.throws(
      () => x.activation.decide(admin, x.command(job)),
      code("process_test_superseded"),
    );
    // Re-testing the live version never takes it offline: existing and new
    // runs keep the accepted qualification until a new human decision.
    assert.equal(
      x.h.registry.resolveRun({ ...admin, role: "member" }, "TEST-original-pin")
        .version,
      1,
    );
    x.h.registry.pinRun(
      { ...admin, role: "member" },
      job.processId,
      "TEST-pin-during-retest",
    );
    assert.throws(
      () => x.journal.nativeEvidence(admin, next.job.testId),
      code("process_test_not_found"),
    );
    x.journal.interrupt(other, next.job.testId, "test_aborted");
    const order = x.h.db
      .prepare(
        "SELECT seq,test_id FROM agent_process_native_test_admission ORDER BY seq",
      )
      .all();
    x.h.db.exec("VACUUM");
    assert.deepEqual(
      x.h.db
        .prepare(
          "SELECT seq,test_id FROM agent_process_native_test_admission ORDER BY seq",
        )
        .all(),
      order,
    );
    await x.reopen();
    assert.throws(
      () => x.activation.decide(admin, x.command(job)),
      code("process_test_superseded"),
    );
    x.h.registry.recordTest(admin, job.processId, 1, {
      testId: "TEST-legacy-pass",
      digest: job.stamp.artifactDigest,
      runnerVersion: "TEST-legacy",
      passed: true,
      scenarios: [...PROCESS_TEST_SCENARIOS],
      reportDigest: processDigest({ legacy: true }),
    });
    // The native lineage survives the legacy record: the gate still binds the
    // original accepted test, not the legacy pass.
    assert.equal(
      JSON.parse(
        String(
          x.h.db
            .prepare(
              "SELECT reference FROM agent_service_process_qualification WHERE process_id=? AND version=1",
            )
            .get(job.processId)!.reference,
        ),
      ).testId,
      job.testId,
    );
    x.h.registry.pinRun(admin, job.processId, "TEST-bypass-pin");
    const current = await x.qualify(1, x.suite, true);
    assert.equal(
      x.h.registry.resolveRun({ ...admin, role: "member" }, "TEST-original-pin")
        .version,
      1,
    );
    const rebound = x.activation.decide(admin, x.command(current));
    assert.equal(rebound.activeVersion, 1);
    assert.equal(rebound.testId, current.testId);
    assert.equal(
      x.h.registry.resolveRun({ ...admin, role: "member" }, "TEST-original-pin")
        .version,
      1,
    );
  }));

test("orphan retest remains latest and interrupted across bootstrap; a historical qualification without an ordinal cannot activate", () =>
  isolated(async (x) => {
    const job = await x.qualify();
    x.h.db
      .prepare(
        "DELETE FROM agent_process_native_test_admission WHERE test_id=?",
      )
      .run(job.testId);
    assert.deepEqual(x.journal.readNative(admin, job.testId), job);
    assert.throws(
      () => x.activation.decide(admin, x.command(job)),
      code("process_test_superseded"),
    );
    const next = x.reserve();
    await x.reopen();
    assert.equal(
      x.journal.readNative(admin, next.job.testId).failure,
      "test_server_restarted",
    );
    assert.throws(
      () => x.activation.decide(admin, x.command(job)),
      code("process_test_superseded"),
    );
  }));

test("an actual failed retest and then an unqualified passing retest never restore the previous accepted qualification for a new decision", () =>
  isolated(async (x) => {
    const original = await x.qualify();
    x.activation.decide(admin, x.command(original));
    const failedSuite = structuredClone(x.suite);
    failedSuite.cases[0]!.expected.output = {
      result: "TEST-wrong-expectation",
    };
    const failed = await x.qualify(1, failedSuite, true);
    assert.equal(failed.status, "failed");
    assert.equal(failed.qualification?.status, "failed");
    assert.throws(
      () => x.activation.decide(admin, x.command(original)),
      code("process_test_superseded"),
    );
    assert.throws(
      () => x.activation.decide(admin, x.command(failed)),
      code("process_qualification_required"),
    );
    const subset = await x.qualify(
      1,
      { ...x.suite, cases: [x.suite.cases[0]!] },
      true,
    );
    assert.equal(subset.status, "completed");
    assert.equal(subset.qualification?.status, "failed");
    assert.throws(
      () => x.activation.decide(admin, x.command(original)),
      code("process_test_superseded"),
    );
    // The live version keeps its accepted binding until a person decides again.
    x.h.registry.pinRun(admin, original.processId, "TEST-active-keeps-serving");
    assert.equal(x.h.registry.get(admin, original.processId).activeVersion, 1);
  }));

test("a malformed later namespace fails closed; reservation and admission ordinal roll back with a failed start audit", () =>
  isolated(async (x) => {
    const original = await x.qualify();
    const audit = new AuditStore(x.h.db);
    const rejectingJournal = new ProcessTestingStore(
      x.h.db,
      "TEST-server",
      x.h.registry,
      (record) => {
        audit.append(record);
        throw Error("TEST admission audit failed");
      },
    );
    const beforeJobs = x.h.db
      .prepare("SELECT count(*) AS n FROM agent_process_contract_test")
      .get()!.n;
    const beforeOrdinals = x.h.db
      .prepare(
        "SELECT seq,test_id FROM agent_process_native_test_admission ORDER BY seq",
      )
      .all();
    const evidence = x.journal.nativeEvidence(admin, original.testId);
    assert.throws(() =>
      rejectingJournal.reserveNative(
        admin,
        {
          ...evidence.request,
          requestId: "TEST-failed-admission-audit",
        },
        original.stamp,
        evidence.environment,
      ),
    );
    assert.equal(
      x.h.db
        .prepare("SELECT count(*) AS n FROM agent_process_contract_test")
        .get()!.n,
      beforeJobs,
    );
    assert.deepEqual(
      x.h.db
        .prepare(
          "SELECT seq,test_id FROM agent_process_native_test_admission ORDER BY seq",
        )
        .all(),
      beforeOrdinals,
    );
    const next = x.reserve();
    x.h.db
      .prepare(
        "UPDATE agent_process_contract_test SET data=json_set(data,'$.request.organizationId','TEST-corrupt-scope') WHERE test_id=?",
      )
      .run(next.job.testId);
    assert.throws(
      () =>
        x.journal.assertLatestNative(
          admin,
          original.processId,
          1,
          original.testId,
        ),
      code("process_test_superseded"),
    );
    assert.throws(
      () =>
        x.journal.assertLatestNative(
          admin,
          original.processId,
          1,
          next.job.testId,
        ),
      code("process_test_superseded"),
    );
    assert.throws(
      () => x.activation.decide(admin, x.command(original)),
      code("process_test_superseded"),
    );
  }));

for (const failure of ["audit", "receipt"] as const) {
  test(`${failure} failure rolls back projection, native binding, active pointer, revision and audit atomically`, () =>
    isolated(async (x) => {
      const job = await x.qualify(),
        input = x.command(job),
        before = x.counts();
      if (failure === "audit") x.failAudit();
      else
        x.h.db
          .exec(`CREATE TRIGGER test_activation_insert_failure BEFORE INSERT ON agent_process_activation_command
      BEGIN SELECT RAISE(ABORT,'TEST receipt insert failed'); END;`);
      assert.throws(() => x.activation.decide(admin, input));
      assert.deepEqual(x.counts(), before);
      const process = x.h.registry.get(admin, job.processId);
      assert.equal(process.activeVersion, null);
      assert.equal(process.revision, input.revision);
      assert.equal(
        x.h.registry.version(admin, job.processId, 1).testStatus,
        "untested",
      );
    }));
}

for (const drift of [
  "role",
  "creator",
  "budget",
  "source",
  "runtime",
] as const) {
  test(`${drift} drift blocks fresh activation and a native pinned run without affecting immutable receipts`, () =>
    isolated(async (x) => {
      const job = await x.qualify(),
        input = x.command(job);
      const receipt = x.activation.decide(admin, input);
      x.h.registry.pinRun(
        { ...admin, role: "member" },
        job.processId,
        "TEST-drift-pin",
      );
      if (drift === "role") x.changeCreatorRole();
      if (drift === "creator") x.revokeCreator();
      if (drift === "budget") {
        const old = x.h.catalog.inferenceBudget.policy(
          target.organizationId,
          target.workspaceId,
        );
        x.h.catalog.inferenceBudget.savePolicy(
          target.organizationId,
          target.workspaceId,
          old.revision,
          old.settings,
        );
      }
      if (drift === "source") {
        const service = x.h.catalog.service(
          target.workspaceId,
          x.h.ids.serviceId,
        );
        x.h.catalog.command(
          CatalogCommand.parse({
            ...target,
            type: "saveService",
            id: service.id,
            revision: service.revision,
            settings: {
              name: service.name,
              url: service.url,
              protocol: service.protocol,
              icon: service.icon,
              auth: service.auth,
              enabled: false,
            },
          }),
        );
      }
      if (drift === "runtime") {
        const original = x.h.registry.testArtifact.bind(x.h.registry);
        x.h.registry.testArtifact = (actor, process, version) => {
          const artifact = original(actor, process, version);
          return {
            ...artifact,
            definition: {
              ...artifact.definition,
              limits: { ...artifact.definition.limits, maxModelCalls: 1 },
            },
          };
        };
      }
      assert.throws(() => x.activation.decide(admin, x.command(job)));
      assert.throws(() =>
        x.h.registry.resolveRun({ ...admin, role: "member" }, "TEST-drift-pin"),
      );
      assert.deepEqual(x.activation.decide(admin, input), receipt);
      assert.deepEqual(x.activation.read(admin, input.requestId), receipt);
    }));
}

test("an unrelated organization policy epoch change keeps qualification fresh for pinned runs, new runs and activation", () =>
  isolated(async (x) => {
    const job = await x.qualify();
    const input = x.command(job);
    x.activation.decide(admin, input);
    x.h.registry.pinRun(
      { ...admin, role: "member" },
      job.processId,
      "TEST-epoch-pin",
    );
    // e.g. someone else joined or a catalog entry the process does not use changed.
    x.bumpEpoch();
    assert.equal(
      x.h.registry.resolveRun({ ...admin, role: "member" }, "TEST-epoch-pin")
        .version,
      1,
    );
    x.h.registry.pinRun(
      { ...admin, role: "member" },
      job.processId,
      "TEST-epoch-new-pin",
    );
    const next = x.freezeNext();
    const v2 = await x.qualify(next.version);
    x.bumpEpoch();
    assert.equal(
      x.activation.decide(admin, x.command(v2)).activeVersion,
      next.version,
    );
  }));

test("two real suspended native runs keep their versions through v2 activation, v1 rollback and two store reopens", () =>
  isolated(async (x) => {
    const v1 = await x.qualify();
    const firstCommand = x.command(v1),
      firstReceipt = x.activation.decide(admin, firstCommand);
    x.h.onModel(() => callProcessTool());
    const waitingA = await x.h.runtime.start(
      v1.processId,
      "TEST-run-A",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(waitingA.status, "waiting", JSON.stringify(waitingA));
    assert(waitingA.approval);
    const runA = String(
      x.h.db
        .prepare(
          "SELECT run_id FROM agent_service_process_run WHERE process_id=? AND version=1",
        )
        .get(v1.processId)!.run_id,
    );
    const frozen = x.freezeNext();
    assert.equal(frozen.version, 2);
    const empty = x.command(v1);
    empty.version = 2;
    assert.throws(() => x.activation.decide(admin, empty));
    const v2 = await x.qualify(2);
    const secondCommand = x.command(v2),
      secondReceipt = x.activation.decide(admin, secondCommand);
    const waitingB = await x.h.runtime.start(
      v2.processId,
      "TEST-run-B",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(waitingB.status, "waiting", JSON.stringify(waitingB));
    assert(waitingB.approval);
    const runB = String(
      x.h.db
        .prepare(
          "SELECT run_id FROM agent_service_process_run WHERE process_id=? AND version=2",
        )
        .get(v2.processId)!.run_id,
    );
    x.activation.decide(admin, x.command(v1, "rollback"));
    const member = { ...admin, role: "member" as const };
    assert.equal(x.h.registry.resolveRun(member, runA).version, 1);
    assert.equal(x.h.registry.resolveRun(member, runB).version, 2);
    assert.equal(
      x.h.registry.pinRun(member, v1.processId, "TEST-run-C").version,
      1,
    );
    // Replaying v2's older activation is an observation, never a pointer switch.
    assert.deepEqual(x.activation.decide(admin, firstCommand), firstReceipt);
    assert.deepEqual(x.activation.decide(admin, secondCommand), secondReceipt);
    assert.equal(x.h.registry.get(admin, v1.processId).activeVersion, 1);
    for (let n = 0; n < 2; n++) {
      await x.reopen();
      assert.equal(x.h.registry.resolveRun(member, runA).version, 1);
      assert.equal(x.h.registry.resolveRun(member, runB).version, 2);
      assert.equal(x.h.registry.resolveRun(member, "TEST-run-C").version, 1);
    }
    x.h.onModel(() => ({ content: '{"result":"TEST-done"}' }));
    const doneA = await x.h.runtime.resume(
      "TEST-run-A",
      { ...waitingA.approval, approved: true },
      signal(),
    );
    const doneB = await x.h.runtime.resume(
      "TEST-run-B",
      { ...waitingB.approval, approved: true },
      signal(),
    );
    assert.equal(doneA.status, "succeeded", JSON.stringify(doneA));
    assert.equal(doneB.status, "succeeded", JSON.stringify(doneB));
    assert.deepEqual(x.h.counts(), [["POST", 2]]);
    assert.equal(x.h.registry.resolveRun(member, runA).version, 1);
    assert.equal(x.h.registry.resolveRun(member, runB).version, 2);
  }));
