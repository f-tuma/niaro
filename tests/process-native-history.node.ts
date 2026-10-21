import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROCESS_NATIVE_TEST_PROFILE,
  NativeTestReadQuerySchema,
  NativeTestListQuerySchema,
  NativeTestSummarySchema,
  NativeTestRequestSchema,
} from "../packages/protocol/process-native-testing";
import {
  PROCESS_TEST_PROFILE,
  ProcessTestSuiteSchema,
} from "../packages/protocol/process-testing";
import { ProcessTestingStore } from "../apps/server-identity/process-testing-store";
import { AuditStore } from "../apps/server-identity/audit";
import { processDigest } from "../apps/server-identity/process-validation";
import {
  processNativeStamp,
  processNativeExecutionSettings,
} from "../apps/server-identity/process-native-testing";
import { processContractStamp } from "../apps/server-agent/process-testing";
import { PROCESS_TEST_SCENARIOS } from "../apps/server-identity/service-processes";
import {
  fixture,
  admin,
  target,
  code,
} from "./helpers/service-process-runtime";
import { buildNativeTestFixture } from "./helpers/process-native-testing";

const profile = PROCESS_NATIVE_TEST_PROFILE;
async function setup(
  run: (x: ReturnType<typeof build>) => Promise<void> | void,
) {
  const root = mkdtempSync(join(tmpdir(), "niaro-native-history-"));
  const path = join(root, "identity.sqlite"),
    h = fixture(path);
  try {
    await run(build(h, path));
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
}
function build(h: ReturnType<typeof fixture>, path: string) {
  const x = buildNativeTestFixture(h);
  const audit = new AuditStore(h.db);
  const suite = { genericModelId: x.modelId, cases: [x.read] };
  const request = NativeTestRequestSchema.parse({
    ...target,
    profile,
    requestId: "TEST-history-seed",
    processId: x.draft.id,
    revision: h.registry.get(admin, x.draft.id).revision,
    version: x.artifact.version,
    artifactDigest: x.artifact.digest,
    suite,
  });
  const environment = {
    catalog: x.catalog,
    authorityEpoch: 0,
    executionSettings: processNativeExecutionSettings(x.artifact, x.catalog),
  };
  const journal = new ProcessTestingStore(
    h.db,
    "TEST-server",
    h.registry,
    (r) => audit.append(r),
  );
  const stamp = processNativeStamp(x.artifact, x.catalog, suite);
  const reserve = (requestId: string) =>
    journal.reserveNative(admin, { ...request, requestId }, stamp, environment)
      .job;
  const query = (extra: object = {}) =>
    NativeTestListQuerySchema.parse({
      ...target,
      profile,
      processId: x.draft.id,
      ...extra,
    });
  const rows = () =>
    h.db
      .prepare(
        "SELECT command_key,test_id,data FROM agent_process_contract_test ORDER BY test_id",
      )
      .all()
      .map((r) => ({ ...r }));
  const seed = (
    id: string,
    changes: {
      userId?: string;
      serverId?: string;
      organizationId?: string;
      workspaceId?: string;
      version?: number;
      contract?: boolean;
      processId?: string;
    } = {},
  ) => {
    const first = rows()[0]!;
    const stored = JSON.parse(String(first.data));
    const creator = {
      ...admin,
      userId: changes.userId ?? admin.userId,
      organizationId: changes.organizationId ?? admin.organizationId,
      workspaceId: changes.workspaceId ?? admin.workspaceId,
    };
    stored.creator = creator;
    stored.request = {
      ...stored.request,
      ...creator,
      requestId: id,
      processId: changes.processId ?? x.draft.id,
      version: changes.version ?? 1,
    };
    delete stored.request.userId;
    delete stored.request.role;
    stored.job = {
      ...stored.job,
      ...target,
      organizationId: creator.organizationId,
      workspaceId: creator.workspaceId,
      requestId: id,
      testId: id,
      processId: stored.request.processId,
      version: stored.request.version,
    };
    if (changes.contract) {
      const contractSuite = ProcessTestSuiteSchema.parse({
        cases: [
          {
            id: "success",
            scenario: "success",
            input: {},
            fixtures: [],
            expected: { outcome: "succeeded", output: {} },
          },
        ],
      });
      delete stored.request.profile;
      stored.request.suite = contractSuite;
      stored.job.profile = PROCESS_TEST_PROFILE;
      stored.job.stamp = processContractStamp(x.artifact, contractSuite);
      delete stored.environment;
    }
    h.db
      .prepare("INSERT INTO agent_process_contract_test VALUES (?,?,?,?)")
      .run(
        processDigest([
          "process-contract-test/1",
          changes.serverId ?? "TEST-server",
          creator.organizationId,
          creator.workspaceId,
          creator.userId,
          id,
        ]),
        id,
        stored.request.processId,
        JSON.stringify(stored),
      );
    return id;
  };
  return {
    ...x,
    path,
    audit,
    request,
    environment,
    journal,
    reserve,
    query,
    rows,
    seed,
  };
}

test("native read/list queries require a strict profile and bound pagination values", () => {
  const read = { ...target, profile, testId: "TEST-test" };
  const list = { ...target, profile, processId: "TEST-process" };
  assert.equal(NativeTestReadQuerySchema.safeParse(read).success, true);
  for (const value of [
    { ...read, profile: undefined },
    { ...read, profile: "agent-process-tests/1" },
    { ...read, userId: "TEST-forged" },
    { ...read, testId: "TEST?" },
  ])
    assert.equal(NativeTestReadQuerySchema.safeParse(value).success, false);
  assert.deepEqual(NativeTestListQuerySchema.parse(list), {
    ...list,
    limit: 20,
  });
  assert.deepEqual(
    NativeTestListQuerySchema.parse({
      ...list,
      version: "2",
      limit: "1",
      after: "TEST-after",
    }),
    { ...list, version: 2, limit: 1, after: "TEST-after" },
  );
  for (const extra of [
    { profile: undefined },
    { profile: "agent-process-tests/1" },
    { version: "0" },
    { version: "1.5" },
    { version: "9007199254740992" },
    { limit: "0" },
    { limit: "21" },
    { limit: "1.5" },
    { limit: "NaN" },
    { after: "TEST' OR 1=1" },
    { testId: "TEST-extra" },
    { userId: "TEST-forged" },
  ])
    assert.equal(
      NativeTestListQuerySchema.safeParse({ ...list, ...extra }).success,
      false,
    );
});

test("native history filters every private namespace before keyset pagination", () =>
  setup((x) => {
    const initial = x.reserve("TEST-history-original");
    x.journal.interrupt(admin, initial.testId, "test_aborted");
    const own: string[] = [initial.testId];
    for (let i = 0; i < 25; i++) {
      const prefix = `TEST-${String(i).padStart(3, "0")}`;
      own.push(x.seed(prefix + "-own"));
      x.seed(prefix + "-a-creator", { userId: "TEST-foreign-owner" });
      x.seed(prefix + "-b-server", { serverId: "TEST-foreign-server" });
      x.seed(prefix + "-c-profile", { contract: true });
      x.seed(prefix + "-d-workspace", {
        workspaceId: "TEST-foreign-workspace",
      });
      x.seed(prefix + "-e-organization", {
        organizationId: "TEST-foreign-organization",
      });
    }
    // This constructor re-registers the pure SQL function on the same connection.
    const foreign = new ProcessTestingStore(
      x.h.db,
      "TEST-foreign-server",
      x.h.registry,
      (r) => x.audit.append(r),
    );
    const before = x.rows();
    const first = x.journal.listNative(admin, x.query());
    assert.equal(first.summaries.length, 20);
    assert.deepEqual(
      first.summaries.map((s) => s.testId),
      own.sort().slice(0, 20),
    );
    assert.equal(first.nextAfter, first.summaries.at(-1)!.testId);
    const second = x.journal.listNative(
      admin,
      x.query({ after: first.nextAfter }),
    );
    assert.deepEqual(
      second.summaries.map((s) => s.testId),
      own.slice(20),
    );
    assert.equal(second.nextAfter, null);
    assert.equal(
      x.journal.listNative(admin, x.query({ after: own.at(-1) })).summaries
        .length,
      0,
    );
    assert(
      foreign
        .listNative(admin, x.query())
        .summaries.every((s) => s.testId.endsWith("-b-server")),
    );
    const encoded = JSON.stringify(first);
    for (const forbidden of [
      "environment",
      '"suite"',
      '"report"',
      "TEST-input",
      "TEST-key",
      'configured": [',
    ])
      assert(!encoded.includes(forbidden), forbidden);
    assert(
      first.summaries.every(
        (s) => s.reportStatus === null && s.comparison === null,
      ),
    );
    assert.deepEqual(x.rows(), before);
    assert.deepEqual(x.h.counts(), []);
    assert.equal(
      x.h.db.prepare("SELECT COUNT(*) AS n FROM test_model").get()!.n,
      0,
    );
  }));

test("history cursors remain creator-private and belong to the requested process/version", () =>
  setup((x) => {
    const initial = x.reserve("TEST-cursor-original");
    x.journal.interrupt(admin, initial.testId, "test_aborted");
    const current = x.h.registry.get(admin, x.draft.id);
    const edited = x.h.registry.saveDraft(admin, {
      id: current.id,
      serviceId: x.h.ids.serviceId,
      revision: current.revision,
      definition: { ...current.draft, name: "TEST version two" },
    });
    x.h.registry.freezeDraft(admin, edited.id, edited.revision);
    const other = x.h.registry.saveDraft(admin, {
      serviceId: x.h.ids.serviceId,
      revision: 0,
      definition: { ...current.draft, name: "TEST other process" },
    });
    const versionTwo = x.seed("TEST-cursor-v2", { version: 2 });
    const invalid = [
      "TEST-absent",
      x.seed("TEST-cursor-creator", { userId: "TEST-other" }),
      x.seed("TEST-cursor-server", { serverId: "TEST-other-server" }),
      x.seed("TEST-cursor-contract", { contract: true }),
      x.seed("TEST-cursor-process", { processId: other.id }),
      versionTwo,
    ];
    for (const after of invalid)
      assert.throws(
        () => x.journal.listNative(admin, x.query({ version: 1, after })),
        code("process_test_not_found"),
      );
    assert.deepEqual(
      x.journal
        .listNative(admin, x.query({ version: 2 }))
        .summaries.map((s) => s.testId),
      [versionTwo],
    );
    assert.equal(
      x.journal.listNative(admin, x.query({ version: 2, after: versionTwo }))
        .nextAfter,
      null,
    );
    assert.throws(
      () => x.journal.listNative({ ...admin, role: "member" }, x.query()),
      code("identity_forbidden"),
    );
    assert.throws(
      () => x.journal.listNative(admin, x.query({ workspaceId: "TEST-other" })),
      code("identity_forbidden"),
    );
    assert.throws(
      () => x.journal.listNative(admin, x.query({ processId: "TEST-absent" })),
      code("process_not_found"),
    );
    assert.throws(
      () => x.journal.listNative(admin, x.query({ version: 999 })),
      code("process_not_found"),
    );
  }));

test("native summaries include comparison metadata without depending on current source/runtime", () =>
  setup(async (x) => {
    const job = x.reserve("TEST-summary-completed");
    const report = await x.run([x.read]);
    x.journal.completeNative(admin, job.testId, report, {
      catalog: x.catalog,
      authorityEpoch: 0,
    });
    const expected = x.journal.listNative(admin, x.query());
    const summary = expected.summaries[0]!;
    assert.equal(summary.reportStatus, "passed");
    assert.deepEqual(summary.comparison, report.comparison);
    assert.equal(summary.status, "completed");
    assert.equal(
      NativeTestSummarySchema.safeParse({ ...summary, report }).success,
      false,
    );
    assert.equal(
      NativeTestSummarySchema.safeParse({ ...summary, comparison: null })
        .success,
      false,
    );
    x.h.db
      .prepare("UPDATE agent_catalog SET revision=revision+1 WHERE id=?")
      .run(x.h.ids.readId);
    x.h.registry.testArtifact = () => {
      throw Error("TEST passive history resolved current sources");
    };
    const before = x.rows();
    assert.deepEqual(x.journal.listNative(admin, x.query()), expected);
    assert.deepEqual(x.rows(), before);
    await x.h.close();
    const reopened = fixture(x.path, x.h.ids);
    try {
      reopened.registry.testArtifact = () => {
        throw Error("TEST reopen resolved current runtime");
      };
      const store = new ProcessTestingStore(
        reopened.db,
        "TEST-server",
        reopened.registry,
        (r) => new AuditStore(reopened.db).append(r),
      );
      assert.deepEqual(store.listNative(admin, x.query()), expected);
      assert.deepEqual(store.readNative(admin, job.testId).report, report);
      assert.deepEqual(reopened.counts(), []);
      assert.equal(
        reopened.db.prepare("SELECT COUNT(*) AS n FROM test_model").get()!.n,
        0,
      );
      assert.equal(
        reopened.registry.get(admin, x.draft.id).activeVersion,
        null,
      );
    } finally {
      await reopened.close();
    }
  }));

test("failed and running history summaries expose only their report availability", () =>
  setup(async (x) => {
    const failedCase = {
      ...x.read,
      expected: {
        ...x.read.expected,
        output: { result: "TEST wrong expected result" },
      },
    };
    const suite = { genericModelId: x.modelId, cases: [failedCase] };
    const failed = x.journal.reserveNative(
      admin,
      { ...x.request, requestId: "TEST-failed-summary", suite },
      processNativeStamp(x.artifact, x.catalog, suite),
      x.environment,
    ).job;
    const report = await x.run([failedCase]);
    assert.equal(report.status, "failed");
    x.journal.completeNative(admin, failed.testId, report, {
      catalog: x.catalog,
      authorityEpoch: 0,
    });
    const running = x.reserve("TEST-running-summary"),
      before = x.rows();
    const list = x.journal.listNative(admin, x.query());
    const failedSummary = list.summaries.find(
      (s) => s.testId === failed.testId,
    )!;
    assert.equal(failedSummary.status, "failed");
    assert.equal(failedSummary.reportStatus, "failed");
    assert.deepEqual(failedSummary.comparison, report.comparison);
    const runningSummary = list.summaries.find(
      (s) => s.testId === running.testId,
    )!;
    assert.equal(runningSummary.status, "running");
    assert.equal(runningSummary.reportStatus, null);
    assert.equal(runningSummary.comparison, null);
    assert.deepEqual(
      x.journal.listNative({ ...admin, role: "admin" }, x.query()),
      list,
    );
    assert.deepEqual(x.rows(), before);
    assert(!JSON.stringify(list).includes("TEST wrong expected result"));
    assert.deepEqual(x.h.counts(), []);
  }));

test("new native reservations reject active versions after exact historical replay", () =>
  setup((x) => {
    const job = x.reserve("TEST-pre-activation-history");
    x.journal.interrupt(admin, job.testId, "test_aborted");
    x.h.registry.recordTest(admin, x.draft.id, x.artifact.version, {
      testId: "TEST-trusted-activation",
      digest: x.artifact.digest,
      runnerVersion: "TEST-offline/1",
      passed: true,
      scenarios: [...PROCESS_TEST_SCENARIOS],
      reportDigest: processDigest({ fixture: true }),
    });
    x.h.registry.activate(
      admin,
      x.draft.id,
      x.h.registry.get(admin, x.draft.id).revision,
      x.artifact.version,
    );
    const before = x.rows();
    assert.deepEqual(x.journal.replayNative(admin, x.request), undefined);
    assert.deepEqual(
      x.journal.reserveNative(
        admin,
        { ...x.request, requestId: job.requestId },
        job.stamp,
        x.environment,
      ),
      { created: false, job: x.journal.readNative(admin, job.testId) },
    );
    assert.throws(
      () => x.reserve("TEST-post-activation-new"),
      code("process_test_active_version"),
    );
    assert.equal(
      x.journal.listNative(admin, x.query()).summaries[0]!.testId,
      job.testId,
    );
    assert.deepEqual(x.rows(), before);
  }));
