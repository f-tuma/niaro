import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROCESS_NATIVE_TEST_PROFILE,
  NativeTestRequestSchema,
  NativeTestReportSchema,
  type NativeTestReport,
} from "../packages/protocol/process-native-testing";
import { ProcessTestSuiteSchema } from "../packages/protocol/process-testing";
import {
  CatalogCommand,
  CatalogModelSettings,
  ProviderSettings,
  ActionSettings,
} from "../packages/protocol/service-catalog";
import { createProcessNativeTesting } from "../apps/server-identity/process-native-testing-controller";
import { ProcessTestingStore } from "../apps/server-identity/process-testing-store";
import {
  processNativeStamp,
  processNativeExecutionSettings,
} from "../apps/server-identity/process-native-testing";
import { processContractStamp } from "../apps/server-agent/process-testing";
import { type CatalogContext } from "../apps/server-identity/catalog-controller";
import { AuditStore } from "../apps/server-identity/audit";
import { IdentityError } from "../apps/server-identity/error";
import { processDigest } from "../apps/server-identity/process-validation";
import {
  fixture,
  admin,
  target,
  code,
} from "./helpers/service-process-runtime";
import { buildNativeTestFixture } from "./helpers/process-native-testing";

const signal = () => new AbortController().signal;
async function setup(
  run: (x: ReturnType<typeof build>) => Promise<void>,
  baseline = false,
) {
  const root = mkdtempSync(join(tmpdir(), "niaro-native-journal-"));
  const path = join(root, "identity.sqlite");
  const h = fixture(path);
  try {
    await run(build(h, path, baseline));
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
}
function build(h: ReturnType<typeof fixture>, path: string, baseline: boolean) {
  const x = buildNativeTestFixture(h);
  const auditStore = new AuditStore(h.db);
  const command = (body: object) =>
    h.catalog.command(CatalogCommand.parse({ ...target, ...body }));
  let genericModelId = x.modelId;
  if (baseline) {
    const providerId = command({
      type: "saveProvider",
      revision: 0,
      settings: {
        name: "TEST baseline provider",
        url: "https://models.example.test/v1",
        enabled: true,
        dailyRequestLimit: 10000,
      },
      apiKey: "TEST-baseline-key",
    });
    genericModelId = command({
      type: "saveModel",
      revision: 0,
      settings: {
        providerId,
        name: "TEST baseline model",
        model: "TEST-baseline-model",
        kind: "chat",
        tools: true,
        enabled: true,
      },
    });
    const selected = h.catalog.processModelMetadata(
      admin.organizationId,
      genericModelId,
    );
    const policy = h.catalog.inferenceBudget.policy(
      admin.organizationId,
      admin.workspaceId,
    );
    h.catalog.inferenceBudget.savePolicy(
      admin.organizationId,
      admin.workspaceId,
      policy.revision,
      {
        ...policy.settings,
        prices: [
          ...policy.settings.prices,
          {
            ...policy.settings.prices[0]!,
            modelId: genericModelId,
            modelRevision: selected.model.revision,
            providerRevision: selected.provider.revision,
          },
        ],
      },
    );
  }
  const read = structuredClone(x.read);
  for (const step of read.models.generic) step.modelId = genericModelId;
  const request = NativeTestRequestSchema.parse({
    ...target,
    profile: PROCESS_NATIVE_TEST_PROFILE,
    requestId: "TEST-native-command",
    processId: x.draft.id,
    revision: h.registry.get(admin, x.draft.id).revision,
    version: x.artifact.version,
    artifactDigest: x.artifact.digest,
    suite: { genericModelId, cases: [read] },
  });
  let auditFailure: string | undefined;
  const audit = (record: Parameters<typeof auditStore.append>[0]) => {
    const id = auditStore.append(record);
    if (record.details.processEvent === auditFailure)
      throw Error("TEST audit failure");
    return id;
  };
  const journal = new ProcessTestingStore(
    h.db,
    "TEST-server",
    h.registry,
    audit,
  );
  const runtime = createProcessNativeTesting(h.registry, h.catalog, journal);
  let queue: Promise<unknown> = Promise.resolve();
  let checks = 0,
    epoch = 0,
    allowed = true,
    userId = admin.userId;
  let role: "owner" | "admin" | "member" = "owner";
  let hook: ((n: number) => void | Promise<void>) | undefined;
  const context: CatalogContext = {
    serial: (run) => {
      const p = queue.then(run);
      queue = p.catch(() => {});
      return p;
    },
    actor: async (scope) => {
      checks++;
      await hook?.(checks);
      if (
        !allowed ||
        scope.organizationId !== target.organizationId ||
        scope.workspaceId !== target.workspaceId
      )
        throw new IdentityError(403, "identity_forbidden");
      return { userId, role };
    },
    epoch: () => epoch,
    change: () => {
      epoch++;
    },
    audit,
    finish: () => {},
    transaction: (run) => run(),
  };
  const catalog = () =>
    h.catalog.processTestCatalog(
      admin.organizationId,
      admin.workspaceId,
      admin,
      x.artifact.sources,
      genericModelId,
    );
  const environment = () => ({
    catalog: catalog(),
    authorityEpoch: epoch,
    executionSettings: processNativeExecutionSettings(x.artifact, catalog()),
  });
  const reserve = (requestId = request.requestId) => {
    const safe = catalog();
    return journal.reserveNative(
      admin,
      { ...request, requestId },
      processNativeStamp(x.artifact, safe, request.suite),
      environment(),
    );
  };
  const onlyJob = () => {
    const rows = h.db
      .prepare("SELECT test_id FROM agent_process_contract_test")
      .all();
    assert.equal(rows.length, 1);
    return journal.readNative(admin, String(rows[0]!.test_id));
  };
  return {
    ...x,
    path,
    request,
    journal,
    runtime,
    context,
    catalog,
    environment,
    reserve,
    onlyJob,
    audit,
    command,
    start: (requestId = request.requestId, abort = signal()) =>
      runtime.start({ ...request, requestId }, context, abort),
    checks: () => checks,
    during: (fn: typeof hook) => {
      hook = fn;
    },
    revoke: () => {
      allowed = false;
    },
    allow: () => {
      allowed = true;
    },
    switchActor: () => {
      userId = "TEST-other";
    },
    member: () => {
      role = "member";
    },
    bumpEpoch: () => {
      epoch++;
    },
    failAudit: (event?: string) => {
      auditFailure = event;
    },
  };
}
function editAction(x: ReturnType<typeof build>) {
  const action = x.h.catalog
    .service(admin.workspaceId, x.h.ids.serviceId)
    .actions.find((a) => a.id === x.h.ids.readId)!;
  const {
    id: _id,
    revision: _revision,
    sourceKey: _sourceKey,
    ...settings
  } = action;
  x.command({
    type: "saveAction",
    id: action.id,
    serviceId: x.h.ids.serviceId,
    serviceRevision: x.h.catalog.service(admin.workspaceId, x.h.ids.serviceId)
      .revision,
    revision: action.revision,
    settings: ActionSettings.parse({
      ...settings,
      description: "TEST changed source",
    }),
  });
}
function assertNoProductionEffects(x: ReturnType<typeof build>) {
  assert.deepEqual(x.h.counts(), []);
  assert.equal(
    x.h.db.prepare("SELECT COUNT(*) AS n FROM test_model").get()!.n,
    0,
  );
  assert.equal(
    x.h.db.prepare("SELECT COUNT(*) AS n FROM agent_service_invocation").get()!
      .n,
    0,
  );
  assert.equal(x.h.registry.get(admin, x.draft.id).activeVersion, null);
  assert.equal(
    x.h.registry.version(admin, x.draft.id, 1).testStatus,
    "untested",
  );
}

test("native journal stores actual configured and generic receipts, replays privately and survives two reopens", () =>
  setup(async (x) => {
    // Production credential paths must never be touched by passive validation or the isolated runner.
    for (const key of ["model", "provider", "credential", "inventory"] as const)
      Object.defineProperty(x.h.catalog, key, {
        value: () => {
          throw Error(`TEST credential-capable getter ${key}`);
        },
      });
    const job = await x.start();
    assert.equal(job.status, "completed");
    assert(job.report);
    assert.equal(job.report.activationEligible, false);
    assert.equal(job.report.qualification, "native_scripted");
    assert(job.qualification);
    assert.equal(job.qualification.status, "failed");
    assert.equal(job.qualification.liveAcceptance, false);
    assert.equal(job.qualification.policy, "native-scripted-runtime/2");
    assert(job.qualification.reasons.includes("missing_scenario"));
    assert.equal(job.qualification.creatorUserId, admin.userId);
    assert.equal(job.qualification.serverId, "TEST-server");
    assert.equal(job.qualification.reportDigest, processDigest(job.report));
    assert.equal(
      job.qualification.environmentDigest,
      processDigest(x.environment()),
    );
    const { qualificationDigest, ...verdict } = job.qualification;
    assert.equal(qualificationDigest, processDigest(verdict));
    assert.deepEqual(
      job.report.observations.map((o) => [
        o.strategy,
        o.modelCalls,
        o.businessDispatches,
      ]),
      [
        ["configured", 2, 1],
        ["generic", 3, 1],
      ],
    );
    assertNoProductionEffects(x);
    assert.deepEqual(await x.start(), job);
    assert.deepEqual(await x.runtime.read(x.context, target, job.testId), job);
    assert.throws(
      () =>
        x.journal.readNative({ ...admin, userId: "TEST-other" }, job.testId),
      code("process_test_not_found"),
    );
    assert.throws(
      () => x.journal.readNative({ ...admin, role: "member" }, job.testId),
      code("process_test_not_found"),
    );
    assert.throws(
      () =>
        x.journal.readNative(
          { ...admin, workspaceId: "TEST-other" },
          job.testId,
        ),
      code("process_test_not_found"),
    );
    x.h.db
      .prepare("UPDATE agent_catalog SET revision=revision+1 WHERE id=?")
      .run(x.h.ids.readId);
    x.h.registry.testArtifact = () => {
      throw Error("TEST replay must not resolve current source/runtime");
    };
    assert.deepEqual(await x.start(), job);
    await assert.rejects(
      x.runtime.start(
        {
          ...x.request,
          suite: {
            ...x.request.suite,
            cases: [
              { ...x.request.suite.cases[0]!, input: { name: "TEST-changed" } },
            ],
          },
        },
        x.context,
        signal(),
      ),
      code("process_test_conflict"),
    );
    assert.throws(
      () =>
        x.h.db
          .prepare(
            "UPDATE agent_process_contract_test SET data=data WHERE test_id=?",
          )
          .run(job.testId),
      /process_contract_test_immutable/,
    );
    await x.h.close();
    for (let i = 0; i < 2; i++) {
      const reopened = fixture(x.path, x.h.ids);
      try {
        const journal = new ProcessTestingStore(
          reopened.db,
          "TEST-server",
          reopened.registry,
          (r) => new AuditStore(reopened.db).append(r),
        );
        assert.deepEqual(journal.readNative(admin, job.testId), job);
        assert.deepEqual(journal.replayNative(admin, x.request), job);
        assert.equal(
          reopened.db.prepare("SELECT COUNT(*) AS n FROM test_model").get()!.n,
          0,
        );
        assert.deepEqual(reopened.counts(), []);
        const foreignServer = new ProcessTestingStore(
          reopened.db,
          "TEST-other-server",
          reopened.registry,
          (r) => new AuditStore(reopened.db).append(r),
        );
        assert.throws(
          () => foreignServer.readNative(admin, job.testId),
          code("process_test_not_found"),
        );
      } finally {
        await reopened.close();
      }
    }
  }));

test("simultaneous exact commands share a running native reservation and a different command is busy", () =>
  setup(async (x) => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    x.during(async (n) => {
      if (n === 3) {
        entered();
        await gate;
      }
    });
    const first = x.start();
    await ready;
    const second = x.start();
    const busy = assert.rejects(
      x.start("TEST-other-command"),
      code("process_test_busy"),
    );
    release();
    const replay = await second;
    assert.equal(replay.status, "running");
    await busy;
    const terminal = await first;
    assert.equal(terminal.testId, replay.testId);
    assert.equal(terminal.status, "completed");
    assert.equal(
      x.h.db
        .prepare("SELECT COUNT(*) AS n FROM agent_process_contract_test")
        .get()!.n,
      1,
    );
    assertNoProductionEffects(x);
  }));

test("contract and native profiles share busy holds and command conflicts without mixing report types", () =>
  setup(async (x) => {
    const request = {
      ...x.request,
      requestId: "TEST-contract",
      suite: ProcessTestSuiteSchema.parse({
        cases: [
          {
            id: "read",
            scenario: "success",
            input: { name: "TEST-input" },
            fixtures: [],
            expected: { outcome: "succeeded", output: {} },
          },
        ],
      }),
    };
    const { profile: _profile, ...contract } = request;
    const stamp = processContractStamp(x.artifact, contract.suite);
    const staticJob = x.journal.reserve(admin, contract, stamp).job;
    assert.throws(
      () => x.journal.readNative(admin, staticJob.testId),
      code("process_test_not_found"),
    );
    assert.throws(() => x.reserve(), code("process_test_busy"));
    assert.throws(
      () =>
        x.journal.replayNative(admin, {
          ...x.request,
          requestId: contract.requestId,
        }),
      code("process_test_conflict"),
    );
    x.journal.interrupt(admin, staticJob.testId, "test_aborted");
    const native = x.reserve().job;
    assert.throws(
      () => x.journal.read(admin, native.testId),
      code("process_test_not_found"),
    );
    assert.throws(
      () =>
        x.journal.reserve(
          admin,
          { ...contract, requestId: "TEST-another-contract" },
          stamp,
        ),
      code("process_test_busy"),
    );
    assert.throws(
      () =>
        x.journal.replay(admin, { ...contract, requestId: native.requestId }),
      code("process_test_conflict"),
    );
    assert.deepEqual(
      x.journal.reserveNative(
        admin,
        x.request,
        { ...native.stamp, runnerVersion: "TEST-new-runtime" },
        x.environment(),
      ),
      { created: false, job: native },
    );
    assert.throws(
      () =>
        x.journal.reserveNative(
          admin,
          { ...x.request, requestId: "TEST-forged" },
          { ...native.stamp, sourcesDigest: "0".repeat(64) },
          x.environment(),
        ),
      code("process_test_conflict"),
    );
  }));

for (const mode of [
  "actor",
  "revocation",
  "epoch",
  "abort",
  "source",
  "policy_aba",
  "tariff",
  "baseline_model",
  "baseline_provider",
] as const)
  test(`native journal interrupts without report after ${mode} changes during actual work`, () =>
    setup(async (x) => {
      const abort = new AbortController();
      x.during((n) => {
        if (n !== 8) return;
        if (mode === "actor") x.switchActor();
        if (mode === "revocation") x.revoke();
        if (mode === "epoch") x.bumpEpoch();
        if (mode === "abort") abort.abort(Error("TEST native canceled"));
        if (mode === "source") editAction(x);
        if (mode === "policy_aba") {
          const policy = x.h.catalog.inferenceBudget.policy(
            admin.organizationId,
            admin.workspaceId,
          );
          x.h.catalog.inferenceBudget.savePolicy(
            admin.organizationId,
            admin.workspaceId,
            policy.revision,
            {
              ...policy.settings,
              maxCostMicros: policy.settings.maxCostMicros + 1,
            },
          );
          x.h.catalog.inferenceBudget.savePolicy(
            admin.organizationId,
            admin.workspaceId,
            policy.revision + 1,
            policy.settings,
          );
        }
        if (mode === "tariff") {
          const policy = x.h.catalog.inferenceBudget.policy(
            admin.organizationId,
            admin.workspaceId,
          );
          x.h.catalog.inferenceBudget.savePolicy(
            admin.organizationId,
            admin.workspaceId,
            policy.revision,
            {
              ...policy.settings,
              prices: policy.settings.prices.map((p) => ({
                ...p,
                inputMicrosPerMillion: p.inputMicrosPerMillion + 1,
              })),
            },
          );
        }
        if (mode === "baseline_model") {
          const value = x.h.catalog.processModelMetadata(
            admin.organizationId,
            x.request.suite.genericModelId!,
          ).model;
          const { id: _id, revision: _revision, ...settings } = value;
          x.command({
            type: "saveModel",
            id: value.id,
            revision: value.revision,
            settings: CatalogModelSettings.parse({
              ...settings,
              name: "TEST changed baseline",
            }),
          });
        }
        if (mode === "baseline_provider") {
          const model = x.h.catalog.processModelMetadata(
            admin.organizationId,
            x.request.suite.genericModelId!,
          ).model;
          const { provider } = x.h.catalog.provider(
            admin.organizationId,
            model.providerId,
          );
          const {
            id: _id,
            revision: _revision,
            hasCredential: _hasCredential,
            requestsToday: _requestsToday,
            ...settings
          } = provider;
          x.command({
            type: "saveProvider",
            id: provider.id,
            revision: provider.revision,
            settings: ProviderSettings.parse({
              ...settings,
              name: "TEST changed baseline provider",
            }),
          });
        }
      });
      await assert.rejects(x.start(x.request.requestId, abort.signal));
      assert.equal(x.checks(), 8);
      const job = x.onlyJob();
      assert.equal(job.status, "interrupted");
      assert.equal(job.report, null);
      assert.equal(
        job.failure,
        mode === "abort"
          ? "test_aborted"
          : ["actor", "revocation"].includes(mode)
            ? "test_authority_changed"
            : "test_source_changed",
      );
      assertNoProductionEffects(x);
      const raw = String(
        x.h.db.prepare("SELECT data FROM agent_process_contract_test").get()!
          .data,
      );
      assert(!raw.includes("TEST-baseline-key"));
      assert(!raw.includes("TEST-key"));
      x.during(undefined);
      x.allow();
      if (mode !== "actor") assert.deepEqual(await x.start(), job);
    }, mode.startsWith("baseline")));

test("final publication rechecks source freshness after both actual strategy runs", () =>
  setup(async (x) => {
    const original = await x.start("TEST-reference-count");
    const boundary = x.checks();
    assert.equal(original.status, "completed");
    x.during((n) => {
      if (n === boundary * 2) editAction(x);
    });
    await assert.rejects(x.start(), code("process_sources_changed"));
    const row = x.h.db
      .prepare(
        "SELECT test_id FROM agent_process_contract_test WHERE json_extract(data,'$.job.requestId')=?",
      )
      .get(x.request.requestId)!;
    const job = x.journal.readNative(admin, String(row.test_id));
    assert.equal(x.checks(), boundary * 2);
    assert.equal(job.report, null);
    assert.equal(job.failure, "test_source_changed");
    assert.deepEqual(x.journal.readNative(admin, original.testId), original);
    assertNoProductionEffects(x);
  }));

test("native reservation, completion and orphan recovery roll back atomically with failed audits", () =>
  setup(async (x) => {
    x.failAudit("native_test_started");
    await assert.rejects(x.start(), /TEST audit failure/);
    assert.equal(
      x.h.db
        .prepare("SELECT COUNT(*) AS n FROM agent_process_contract_test")
        .get()!.n,
      0,
    );
    x.failAudit("native_test_completed");
    await assert.rejects(x.start(), /TEST audit failure/);
    const failed = x.onlyJob();
    assert.equal(failed.status, "interrupted");
    assert.equal(failed.failure, "test_runner_failed");
    assert.equal(failed.report, null);
    assert.equal(failed.qualification, undefined);
    x.failAudit();
    const orphan = x.reserve("TEST-orphan").job;
    const before = x.h.db
      .prepare("SELECT COUNT(*) AS n FROM agent_audit")
      .get()!.n;
    x.failAudit("native_test_interrupted");
    assert.throws(
      () =>
        new ProcessTestingStore(x.h.db, "TEST-server", x.h.registry, x.audit),
      /TEST audit failure/,
    );
    assert.equal(x.journal.readNative(admin, orphan.testId).status, "running");
    assert.equal(
      x.h.db.prepare("SELECT COUNT(*) AS n FROM agent_audit").get()!.n,
      before,
    );
    x.failAudit();
    await x.h.close();
    const h = fixture(x.path, x.h.ids);
    try {
      const journal = new ProcessTestingStore(
        h.db,
        "TEST-server",
        h.registry,
        (r) => new AuditStore(h.db).append(r),
      );
      const job = journal.readNative(admin, orphan.testId);
      assert.equal(job.status, "interrupted");
      assert.equal(job.failure, "test_server_restarted");
      assert.equal(job.report, null);
      assert.deepEqual(
        journal.replayNative(admin, { ...x.request, requestId: "TEST-orphan" }),
        job,
      );
      assert.deepEqual(h.counts(), []);
      assert.equal(
        h.db.prepare("SELECT COUNT(*) AS n FROM test_model").get()!.n,
        0,
      );
    } finally {
      await h.close();
    }
  }));

test("qualification audit failure cannot leave a staged report or verdict", () =>
  setup(async (x) => {
    x.failAudit("native_test_qualification_failed");
    await assert.rejects(x.start(), /TEST audit failure/);
    const job = x.onlyJob();
    assert.equal(job.status, "interrupted");
    assert.equal(job.failure, "test_runner_failed");
    assert.equal(job.report, null);
    assert.equal(job.qualification, undefined);
    assert.equal(
      x.h.db
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_audit WHERE json_extract(details,'$.processEvent') IN ('native_test_completed','native_test_qualification_failed')",
        )
        .get()!.n,
      0,
    );
    assertNoProductionEffects(x);
  }));

test("historical native jobs without qualification remain passive and cannot acquire a verdict by reading", () =>
  setup(async (x) => {
    const completed = await x.start();
    const row = x.h.db
      .prepare("SELECT data FROM agent_process_contract_test WHERE test_id=?")
      .get(completed.testId)!;
    // Reproduce a pre-qualification terminal snapshot without rewriting history.
    const historical = JSON.parse(String(row.data));
    historical.request.requestId = "TEST-historical-command";
    historical.job.requestId = historical.request.requestId;
    historical.job.testId = "TEST-historical-job";
    delete historical.job.qualification;
    x.h.db
      .prepare("INSERT INTO agent_process_contract_test VALUES (?,?,?,?)")
      .run(
        processDigest([
          "process-contract-test/1",
          "TEST-server",
          admin.organizationId,
          admin.workspaceId,
          admin.userId,
          historical.request.requestId,
        ]),
        historical.job.testId,
        x.draft.id,
        JSON.stringify(historical),
      );
    const before = x.h.db
      .prepare("SELECT COUNT(*) AS n FROM agent_audit")
      .get()!.n;
    x.h.registry.testArtifact = () => {
      throw Error("TEST historical read resolved current sources");
    };
    const job = x.journal.readNative(admin, historical.job.testId);
    assert.equal(job.status, "completed");
    assert.equal(job.report?.activationEligible, false);
    assert.equal(job.qualification, undefined);
    assert.deepEqual(x.journal.replayNative(admin, historical.request), job);
    const history = x.journal.listNative(admin, {
      ...target,
      profile: PROCESS_NATIVE_TEST_PROFILE,
      processId: x.draft.id,
      limit: 20,
    });
    assert.equal(
      history.summaries.find((s) => s.testId === job.testId)?.qualification,
      undefined,
    );
    assert.equal(
      x.h.db.prepare("SELECT COUNT(*) AS n FROM agent_audit").get()!.n,
      before,
    );
    assertNoProductionEffects(x);
  }));

test("native completion rejects wrong stamps, settings, case pairs and current pins without changing the reservation", () =>
  setup(async (x) => {
    const terminal = await x.start("TEST-original");
    assert(terminal.report);
    const job = x.reserve().job;
    const report = terminal.report;
    const mutations: NativeTestReport[] = [
      { ...report, stamp: { ...report.stamp, runnerVersion: "TEST-forged" } },
      {
        ...report,
        executionSettings: {
          ...report.executionSettings,
          nativeAgentMaxStepsPerInvocation: 999,
        },
      },
      {
        ...report,
        observations: report.observations.map((o) => ({
          ...o,
          caseId: "wrong_case",
        })),
      },
      {
        ...report,
        observations: report.observations.map((o) => ({
          ...o,
          observed: "failed",
          output: { result: "TEST-wrong" },
          code: "TEST_wrong",
        })),
      },
      {
        ...report,
        observations: report.observations.map((o) => ({
          ...o,
          output: undefined,
        })),
      },
      {
        ...report,
        observations: report.observations.map((o) => ({ ...o, approvals: 1 })),
      },
      {
        ...report,
        observations: report.observations.map((o) => ({
          ...o,
          budget: { ...o.budget, accountedTokens: 0, accountedCostMicros: 0 },
        })),
      },
      {
        ...report,
        observations: report.observations.map((o) => ({
          ...o,
          receipts: [],
          businessDispatches: 0,
        })),
      },
    ];
    for (const forged of mutations) {
      const parsed = NativeTestReportSchema.safeParse(forged);
      assert(parsed.success, JSON.stringify(parsed.error?.issues));
      assert.throws(
        () =>
          x.journal.completeNative(admin, job.testId, forged, x.environment()),
        code("process_test_conflict"),
      );
      assert.deepEqual(x.journal.readNative(admin, job.testId), job);
    }
    assert.throws(
      () =>
        x.journal.completeNative(admin, job.testId, report, {
          ...x.environment(),
          authorityEpoch: 999,
        }),
      code("process_sources_changed"),
    );
    const drifted = x.environment();
    drifted.catalog.budgetRevision++;
    assert.throws(
      () => x.journal.completeNative(admin, job.testId, report, drifted),
      code("process_sources_changed"),
    );
    assert.deepEqual(x.journal.readNative(admin, job.testId), job);
    const completed = x.journal.completeNative(
      admin,
      job.testId,
      report,
      x.environment(),
    );
    assert.equal(completed.status, "completed");
    assert.throws(
      () =>
        x.journal.completeNative(admin, job.testId, report, x.environment()),
      code("process_test_terminal"),
    );
  }));

test("native admission rejects untrusted snapshots, members, foreign scope and unenforced budget without a reservation", () =>
  setup(async (x) => {
    await assert.rejects(
      x.runtime.start(
        { ...x.request, catalog: x.catalog() } as typeof x.request,
        x.context,
        signal(),
      ),
    );
    await assert.rejects(
      x.runtime.start(
        { ...x.request, organizationId: "TEST-foreign" },
        x.context,
        signal(),
      ),
      code("identity_forbidden"),
    );
    const policy = x.h.catalog.inferenceBudget.policy(
      admin.organizationId,
      admin.workspaceId,
    );
    x.h.catalog.inferenceBudget.savePolicy(
      admin.organizationId,
      admin.workspaceId,
      policy.revision,
      { ...policy.settings, mode: "observe" },
    );
    await assert.rejects(x.start(), code("process_test_budget_required"));
    x.h.catalog.inferenceBudget.savePolicy(
      admin.organizationId,
      admin.workspaceId,
      policy.revision + 1,
      policy.settings,
    );
    x.member();
    await assert.rejects(x.start(), code("identity_forbidden"));
    assert.equal(
      x.h.db
        .prepare("SELECT COUNT(*) AS n FROM agent_process_contract_test")
        .get()!.n,
      0,
    );
    assertNoProductionEffects(x);
  }));

test("an actual failed native verdict remains immutable when a later new test succeeds", () =>
  setup(async (x) => {
    const failedRequest = {
      ...x.request,
      suite: {
        ...x.request.suite,
        cases: [
          {
            ...x.read,
            expected: {
              ...x.read.expected,
              output: { result: "TEST-different-expectation" },
            },
          },
        ],
      },
    };
    const failed = await x.runtime.start(failedRequest, x.context, signal());
    assert.equal(failed.status, "failed");
    assert(failed.report);
    assert.equal(failed.report.status, "failed");
    assert(
      failed.report.observations.every(
        (o) => !o.passed && o.assertions.includes("output_mismatch"),
      ),
    );
    assert.deepEqual(
      await x.runtime.start(failedRequest, x.context, signal()),
      failed,
    );
    const retest = await x.start("TEST-retest");
    assert.equal(retest.status, "completed");
    assert.notEqual(retest.testId, failed.testId);
    assert.deepEqual(x.journal.readNative(admin, failed.testId), failed);
    assert.equal(
      x.h.db
        .prepare("SELECT COUNT(*) AS n FROM agent_process_contract_test")
        .get()!.n,
      2,
    );
    assertNoProductionEffects(x);
  }));

test("native publication rejects an impossible passed budget despite matching scripted usage totals", () =>
  setup(async (x) => {
    const original = await x.start("TEST-valid-budget");
    assert(original.report);
    for (const mode of [
      "settlement_overrun",
      "token_reservation",
      "cost_reservation",
      "call_cap",
      "native_cap",
    ] as const) {
      let artifact = x.artifact;
      const suite = structuredClone(x.request.suite);
      if (mode === "settlement_overrun")
        for (const strategy of ["configured", "generic"] as const)
          suite.cases[0]!.models[strategy][0]!.usage.inputTokens = 1000000;
      if (mode === "native_cap")
        for (const strategy of ["configured", "generic"] as const) {
          while (suite.cases[0]!.models[strategy].length < 13)
            suite.cases[0]!.models[strategy].push(
              x.text({ result: "TEST-result" }),
            );
        }
      if (mode === "call_cap") {
        const draft = x.h.registry.saveDraft(admin, {
          serviceId: x.h.ids.serviceId,
          revision: 0,
          definition: {
            ...artifact.definition,
            name: "TEST bounded model",
            limits: { ...artifact.definition.limits, maxModelCalls: 1 },
          },
        });
        artifact = x.h.registry.freezeDraft(admin, draft.id, draft.revision);
      }
      if (mode === "token_reservation" || mode === "cost_reservation") {
        const policy = x.h.catalog.inferenceBudget.policy(
          admin.organizationId,
          admin.workspaceId,
        );
        x.h.catalog.inferenceBudget.savePolicy(
          admin.organizationId,
          admin.workspaceId,
          policy.revision,
          {
            ...policy.settings,
            ...(mode === "token_reservation"
              ? { maxTokens: 500 }
              : { maxCostMicros: 500 }),
          },
        );
      }
      const catalog = x.h.catalog.processTestCatalog(
        admin.organizationId,
        admin.workspaceId,
        admin,
        artifact.sources,
        x.modelId,
      );
      const executionSettings = processNativeExecutionSettings(
        artifact,
        catalog,
      );
      const request = NativeTestRequestSchema.parse({
        ...x.request,
        requestId: `TEST-impossible-${mode}`,
        suite,
        processId: artifact.processId,
        revision: x.h.registry.get(admin, artifact.processId).revision,
        artifactDigest: artifact.digest,
        version: artifact.version,
      });
      const stamp = processNativeStamp(artifact, catalog, suite);
      const environment = { catalog, executionSettings, authorityEpoch: 0 };
      const job = x.journal.reserveNative(
        admin,
        request,
        stamp,
        environment,
      ).job;
      const observations = original.report.observations.map((o) => {
        const tokens = suite.cases[0]!.models[o.strategy].reduce(
          (n, m) => n + m.usage.inputTokens + m.usage.outputTokens,
          0,
        );
        // Fixture prices are one micro per token, so these are exact usage totals.
        return {
          ...o,
          modelCalls: suite.cases[0]!.models[o.strategy].length,
          budget: {
            accountedTokens: tokens,
            accountedCostMicros: tokens,
            unknownCalls: 0,
            overrun: false,
          },
        };
      });
      const forged = NativeTestReportSchema.parse({
        ...original.report,
        stamp,
        executionSettings,
        observations,
        comparison: {
          ...original.report.comparison,
          configuredModelCalls: suite.cases[0]!.models.configured.length,
          genericModelCalls: suite.cases[0]!.models.generic.length,
        },
      });
      assert.throws(
        () => x.journal.completeNative(admin, job.testId, forged, environment),
        code("process_test_conflict"),
      );
      assert.deepEqual(x.journal.readNative(admin, job.testId), job);
      x.journal.interrupt(admin, job.testId, "test_aborted");
    }
    assert.deepEqual(x.journal.readNative(admin, original.testId), original);
    assertNoProductionEffects(x);
  }));
