import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProcessTestSuiteSchema,
  ProcessTestReportSchema,
  TestJsonSchema,
  type ProcessTestSuite,
  type ProcessTestRequest,
} from "../packages/protocol/process-testing";
import { ProcessTestingStore } from "../apps/server-identity/process-testing-store";
import { createProcessTesting } from "../apps/server-identity/process-testing";
import {
  runProcessContractExperiment,
  processContractStamp,
} from "../apps/server-agent/process-testing";
import { processDigest } from "../apps/server-identity/process-validation";
import type { CatalogContext } from "../apps/server-identity/catalog-controller";
import { IdentityError } from "../apps/server-identity/error";
import {
  designFixture,
  designActor,
  designTarget,
} from "./helpers/process-design";
import { processObject } from "./helpers/service-process";
import {
  ProcessDefinitionSchema,
  type ProcessDefinition,
} from "../packages/protocol/service-processes";

const signal = () => new AbortController().signal;
function suite(): ProcessTestSuite {
  const success = {
    id: "success",
    scenario: "success",
    input: { name: "TEST input" },
    fixtures: [
      {
        nodeId: "lookup",
        kind: "action",
        input: { name: "TEST input" },
        output: { value: "TEST result" },
        outcome: "complete",
        approval: "none",
      },
    ],
    expected: { outcome: "succeeded", output: { result: "TEST result" } },
  };
  return ProcessTestSuiteSchema.parse({
    cases: [
      success,
      {
        ...success,
        id: "missing",
        scenario: "missing_input",
        input: {},
        fixtures: [],
        expected: { outcome: "input_invalid", code: "test_input_invalid" },
      },
      {
        ...success,
        id: "failure",
        scenario: "failure",
        fixtures: [{ ...success.fixtures[0], outcome: "failure" }],
        expected: { outcome: "failed", code: "test_mock_failure" },
      },
      {
        ...success,
        id: "unknown",
        scenario: "unknown",
        fixtures: [{ ...success.fixtures[0], outcome: "unknown" }],
        expected: { outcome: "unknown", code: "test_mock_unknown" },
      },
      {
        ...success,
        id: "rejected",
        scenario: "rejection",
        fixtures: [{ ...success.fixtures[0], approval: "reject" }],
        expected: { outcome: "rejected", code: "test_rejected" },
      },
      {
        ...success,
        id: "reopened",
        scenario: "restart",
        reopenAt: "suspended",
        fixtures: [{ ...success.fixtures[0], approval: "approve" }],
      },
      { ...success, id: "replay", scenario: "restart", reopenAt: "completed" },
    ],
  });
}
function setup(path?: string) {
  const h = designFixture(path);
  const draft = h.registry.saveDraft(designActor, {
    serviceId: h.serviceId,
    revision: 0,
    definition: h.workflow(),
  });
  const artifact = h.registry.freezeDraft(
    designActor,
    draft.id,
    draft.revision,
  );
  let auditFailure = false;
  const journal = new ProcessTestingStore(
    h.db,
    "TEST-server",
    h.registry,
    (record) => {
      h.audit.append(record);
      if (auditFailure) throw Error("TEST journal audit failed");
    },
  );
  const request: ProcessTestRequest = {
    ...designTarget,
    requestId: "TEST-test-command",
    processId: draft.id,
    version: artifact.version,
    revision: h.registry.get(designActor, draft.id).revision,
    artifactDigest: artifact.digest,
    suite: suite(),
  };
  const runtime = createProcessTesting(h.registry, journal);
  let allowed = true,
    userId = designActor.userId,
    role: "owner" | "admin" | "member" = "owner";
  let checks = 0,
    duringCheck: ((count: number) => void) | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const context: CatalogContext = {
    serial: (run) => {
      const next = queue.then(run);
      queue = next.catch(() => {});
      return next;
    },
    actor: async () => {
      checks++;
      duringCheck?.(checks);
      if (!allowed) throw new IdentityError(403, "identity_forbidden");
      return { userId, role };
    },
    epoch: () => 0,
    change: () => {},
    audit: (r) => h.audit.append(r),
    finish: () => {},
    transaction: (run) => run(),
  };
  return {
    ...h,
    draft,
    artifact,
    journal,
    request,
    runtime,
    context,
    failJournalAudit: () => {
      auditFailure = true;
    },
    onCheck: (f: (count: number) => void) => {
      duringCheck = f;
    },
    revoke: () => {
      allowed = false;
    },
    changeUser: () => {
      userId = "TEST-other";
    },
    member: () => {
      role = "member";
    },
  };
}

test("JSON/suite admission rejects cycles, oversized/deep content, code and scenario relabeling", () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  assert.equal(TestJsonSchema.safeParse(cycle).success, false);
  assert.equal(TestJsonSchema.safeParse({ method: () => 1 }).success, false);
  assert.equal(TestJsonSchema.safeParse({ date: new Date() }).success, false);
  assert.equal(TestJsonSchema.safeParse({ n: NaN }).success, false);
  assert.equal(TestJsonSchema.safeParse("X".repeat(65537)).success, false);
  let deep: unknown = 1;
  for (let i = 0; i < 18; i++) deep = { next: deep };
  assert.equal(TestJsonSchema.safeParse(deep).success, false);
  const cases = suite().cases;
  assert.equal(
    ProcessTestSuiteSchema.safeParse({ cases: [cases[0], cases[0]] }).success,
    false,
  );
  assert.equal(
    ProcessTestSuiteSchema.safeParse({
      cases: [{ ...cases[0], scenario: "unknown" }],
    }).success,
    false,
  );
});

test("actual Mastra dataset executes inactive workflow cases and separates expected failures from verdict", async () => {
  const h = setup();
  try {
    const job = await h.runtime.start(h.request, h.context, signal());
    assert.equal(job.status, "completed");
    assert(job.report);
    assert.equal(job.report.status, "passed");
    assert.equal(job.report.activationEligible, false);
    assert.equal(job.report.qualification, "compiler_contract");
    assert.equal(job.report.agentExecution, "absent");
    assert.equal(job.report.observations.length, 7);
    assert.equal(job.report.stamp.suiteDigest, processDigest(h.request.suite));
    assert(job.report.datasetVersion > 0);
    assert(job.report.experimentId);
    assert(job.report.datasetId);
    const observations = new Map(
      job.report.observations.map((r) => [r.caseId, r]),
    );
    assert.equal(observations.get("missing")!.dispatches, 0);
    assert.deepEqual(observations.get("missing")!.visited, []);
    assert.equal(observations.get("rejected")!.dispatches, 0);
    assert.equal(observations.get("rejected")!.approvals, 1);
    assert.equal(observations.get("unknown")!.observed, "unknown");
    assert.equal(observations.get("unknown")!.dispatches, 1);
    assert.equal(observations.get("reopened")!.reopened, true);
    assert.equal(observations.get("reopened")!.dispatches, 1);
    assert.equal(observations.get("replay")!.reopened, true);
    assert.equal(observations.get("replay")!.dispatches, 1);
    assert.equal(h.registry.get(designActor, h.draft.id).activeVersion, null);
    assert.equal(
      h.registry.version(designActor, h.draft.id, 1).testStatus,
      "untested",
    );
    assert.equal(
      h.db.prepare("SELECT count(*) AS n FROM agent_service_process_run").get()!
        .n,
      0,
    );
    assert.equal(
      h.db
        .prepare("SELECT count(*) AS n FROM agent_service_process_test")
        .get()!.n,
      0,
    );
    const beforeAudit = h.db
      .prepare("SELECT count(*) AS n FROM agent_audit")
      .get();
    assert.deepEqual(
      await h.runtime.start(h.request, h.context, signal()),
      job,
    );
    assert.deepEqual(
      await h.runtime.read(h.context, designTarget, job.testId),
      job,
    );
    assert.deepEqual(
      h.db.prepare("SELECT count(*) AS n FROM agent_audit").get(),
      beforeAudit,
    );
    assert.equal(
      h.db
        .prepare("SELECT count(*) AS n FROM agent_process_contract_test")
        .get()!.n,
      1,
    );
    await assert.rejects(
      h.runtime.start(
        { ...h.request, suite: { cases: [h.request.suite.cases[0]!] } },
        h.context,
        signal(),
      ),
      (e) => e instanceof IdentityError && e.code === "process_test_conflict",
    );
  } finally {
    h.db.close();
  }
});

test("unmatched inputs, absent/unconsumed fixtures and wrong expected output cannot pass", async () => {
  const h = setup();
  try {
    const item = suite().cases[0]!;
    const report = await runProcessContractExperiment(
      h.artifact,
      ProcessTestSuiteSchema.parse({
        cases: [
          {
            ...item,
            id: "wrongInput",
            fixtures: [
              { ...item.fixtures[0], input: { name: "TEST different" } },
            ],
          },
          { ...item, id: "absent", fixtures: [] },
          {
            ...item,
            id: "unused",
            fixtures: [...item.fixtures, item.fixtures[0]],
          },
          {
            ...item,
            id: "wrongOutput",
            expected: {
              outcome: "succeeded",
              output: { result: "TEST wrong" },
            },
          },
          {
            ...item,
            id: "invalidOutput",
            fixtures: [{ ...item.fixtures[0], output: { value: 42 } }],
          },
        ],
      }),
      signal(),
      async () => {},
    );
    assert.equal(report.status, "failed");
    assert(report.observations.every((c) => !c.passed));
    const cases = new Map(report.observations.map((v) => [v.caseId, v]));
    assert.equal(cases.get("wrongInput")!.code, "test_fixture_conflict");
    assert.equal(cases.get("wrongInput")!.dispatches, 0);
    assert.equal(cases.get("absent")!.code, "test_fixture_missing");
    assert(cases.get("unused")!.assertions.includes("fixtures_unconsumed"));
    assert(cases.get("wrongOutput")!.assertions.includes("output_mismatch"));
    assert.equal(cases.get("invalidOutput")!.code, "process_output_invalid");
  } finally {
    h.db.close();
  }
});

test("agent output fixtures prove compiler plumbing only and cannot qualify activation", async () => {
  const h = setup();
  try {
    const draft = h.registry.saveDraft(designActor, {
      serviceId: h.serviceId,
      revision: 0,
      definition: h.agent(),
    });
    const artifact = h.registry.freezeDraft(
      designActor,
      draft.id,
      draft.revision,
    );
    const report = await runProcessContractExperiment(
      artifact,
      ProcessTestSuiteSchema.parse({
        cases: [
          {
            id: "agent",
            scenario: "success",
            input: {},
            fixtures: [
              {
                nodeId: "agent",
                kind: "agent",
                input: {},
                output: {},
                outcome: "complete",
                approval: "none",
              },
            ],
            expected: { outcome: "succeeded", output: {} },
          },
        ],
      }),
      signal(),
      async () => {},
    );
    assert.equal(report.status, "passed");
    assert.equal(report.agentExecution, "static_output");
    assert.equal(report.activationEligible, false);
    assert.equal(
      h.registry.version(designActor, draft.id, 1).testStatus,
      "untested",
    );
    assert.equal(
      ProcessTestReportSchema.safeParse({ ...report, activationEligible: true })
        .success,
      false,
    );
  } finally {
    h.db.close();
  }
});

test("private reservations reject member, cross-scope and changed command/stamps and preserve pending replay", () => {
  const h = setup();
  try {
    const stamp = processContractStamp(h.artifact, h.request.suite);
    const reserved = h.journal.reserve(designActor, h.request, stamp);
    assert.equal(reserved.created, true);
    assert.equal(
      h.journal.reserve(designActor, h.request, stamp).created,
      false,
    );
    assert.throws(
      () =>
        h.journal.read(
          { ...designActor, userId: "TEST-other-admin" },
          reserved.job.testId,
        ),
      (e) => e instanceof IdentityError && e.code === "process_test_not_found",
    );
    assert.throws(
      () =>
        h.journal.read({ ...designActor, role: "member" }, reserved.job.testId),
      (e) => e instanceof IdentityError && e.code === "process_test_not_found",
    );
    assert.throws(() =>
      h.journal.reserve({ ...designActor, role: "member" }, h.request, stamp),
    );
    assert.throws(() =>
      h.journal.reserve(
        designActor,
        { ...h.request, workspaceId: "TEST-other" },
        stamp,
      ),
    );
    assert.deepEqual(
      h.journal.reserve(designActor, h.request, {
        ...stamp,
        compilerVersion: "TEST-changed",
      }),
      { created: false, job: reserved.job },
    );
    assert.throws(
      () =>
        h.journal.reserve(
          designActor,
          {
            ...h.request,
            requestId: "TEST-forged-new-command",
          },
          { ...stamp, sourcesDigest: "0".repeat(64) },
        ),
      (e) => e instanceof IdentityError && e.code === "process_test_conflict",
    );
    assert.throws(
      () =>
        h.journal.reserve(
          designActor,
          { ...h.request, requestId: "TEST-second" },
          stamp,
        ),
      (e) => e instanceof IdentityError && e.code === "process_test_busy",
    );
    assert.equal(
      h.journal.read(designActor, reserved.job.testId).status,
      "running",
    );
  } finally {
    h.db.close();
  }
});

test("audit failure rolls back reservation; interrupted terminal report is immutable", () => {
  const h = setup();
  try {
    h.failJournalAudit();
    assert.throws(
      () =>
        h.journal.reserve(
          designActor,
          h.request,
          processContractStamp(h.artifact, h.request.suite),
        ),
      /TEST journal audit failed/,
    );
    assert.equal(
      h.db
        .prepare("SELECT count(*) AS n FROM agent_process_contract_test")
        .get()!.n,
      0,
    );
  } finally {
    h.db.close();
  }
  const other = setup();
  try {
    const reserved = other.journal.reserve(
      designActor,
      other.request,
      processContractStamp(other.artifact, other.request.suite),
    );
    const stopped = other.journal.interrupt(
      designActor,
      reserved.job.testId,
      "test_aborted",
    );
    assert.equal(stopped.status, "interrupted");
    assert.equal(stopped.report, null);
    assert.throws(
      () =>
        other.db
          .prepare(
            "UPDATE agent_process_contract_test SET data=data WHERE test_id=?",
          )
          .run(stopped.testId),
      /process_contract_test_immutable/,
    );
    assert.equal(
      other.journal.reserve(designActor, other.request, stopped.stamp).created,
      false,
    );
  } finally {
    other.db.close();
  }
});

test("reopen marks orphan reservations interrupted twice without producing test evidence or rerun", async () => {
  const root = mkdtempSync(join(tmpdir(), "niaro-contract-journal-")),
    path = join(root, "identity.sqlite");
  let h = setup(path);
  try {
    const original = h.journal.reserve(
      designActor,
      h.request,
      processContractStamp(h.artifact, h.request.suite),
    );
    const request = h.request;
    h.db.close();
    for (let i = 0; i < 2; i++) {
      const reopened = designFixture(path);
      const journal = new ProcessTestingStore(
        reopened.db,
        "TEST-server",
        reopened.registry,
        (r) => {
          reopened.audit.append(r);
        },
      );
      try {
        const job = journal.read(designActor, original.job.testId);
        assert.equal(job.status, "interrupted");
        assert.equal(job.failure, "test_server_restarted");
        assert.equal(job.report, null);
        assert.equal(
          journal.reserve(designActor, request, original.job.stamp).created,
          false,
        );
        assert.equal(
          reopened.db
            .prepare("SELECT count(*) AS n FROM agent_service_process_test")
            .get()!.n,
          0,
        );
      } finally {
        reopened.db.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("actor replacement or revoked source during native work leaves only an interrupted job", async () => {
  for (const mode of ["actor", "source", "abort"] as const) {
    const h = setup(),
      controller = new AbortController();
    h.onCheck((n) => {
      if (n === 4) {
        if (mode === "actor") h.changeUser();
        else if (mode === "source") h.setAction({ enabled: false });
        else controller.abort();
      }
    });
    try {
      await assert.rejects(
        h.runtime.start(h.request, h.context, controller.signal),
      );
      const row = h.db
        .prepare("SELECT data FROM agent_process_contract_test")
        .get()!;
      const stored = JSON.parse(String(row.data));
      assert.equal(stored.job.status, "interrupted");
      assert.equal(stored.job.report, null);
      assert.equal(
        stored.job.failure,
        mode === "actor"
          ? "test_authority_changed"
          : mode === "source"
            ? "test_source_changed"
            : "test_aborted",
      );
      assert.equal(stored.creator.userId, designActor.userId);
      assert.equal(
        h.registry.version(designActor, h.draft.id, 1).testStatus,
        "untested",
      );
    } finally {
      h.db.close();
    }
  }
});

test("an expected failure cannot conceal missing fixtures or an unrelated native output error", async () => {
  const h = setup();
  try {
    const item = suite().cases[2]!;
    const report = await runProcessContractExperiment(
      h.artifact,
      ProcessTestSuiteSchema.parse({
        cases: [
          { ...item, id: "missingFailure", fixtures: [] },
          {
            ...item,
            id: "unrelatedFailure",
            fixtures: [
              {
                ...item.fixtures[0],
                outcome: "complete",
                output: { value: 42 },
              },
            ],
          },
        ],
      }),
      signal(),
      async () => {},
    );
    assert.equal(report.status, "failed");
    const cases = new Map(report.observations.map((v) => [v.caseId, v]));
    assert(
      cases
        .get("missingFailure")!
        .assertions.includes("infrastructure_failure"),
    );
    assert(
      cases.get("missingFailure")!.assertions.includes("failure_code_mismatch"),
    );
    assert(
      cases
        .get("unrelatedFailure")!
        .assertions.includes("failure_code_mismatch"),
    );
    assert(report.observations.every((v) => !v.passed));
  } finally {
    h.db.close();
  }
});

test("completed evidence survives dependency edits and later retests without being overwritten", async () => {
  const h = setup();
  try {
    const request = {
      ...h.request,
      suite: { cases: [h.request.suite.cases[0]!] },
    };
    const first = await h.runtime.start(request, h.context, signal());
    assert.equal(first.status, "completed");
    assert(first.report);
    const wrong = ProcessTestSuiteSchema.parse({
      cases: [
        {
          ...request.suite.cases[0],
          expected: { outcome: "succeeded", output: { result: "TEST wrong" } },
        },
      ],
    });
    const second = await h.runtime.start(
      { ...request, requestId: "TEST-second", suite: wrong },
      h.context,
      signal(),
    );
    assert.equal(second.status, "failed");
    assert.deepEqual(h.journal.read(designActor, first.testId), first);
    assert.throws(
      () => h.journal.complete(designActor, first.testId, first.report!),
      (e) => e instanceof IdentityError && e.code === "process_test_terminal",
    );
    h.setAction({ description: "TEST changed revision" });
    assert.deepEqual(
      await h.runtime.read(h.context, designTarget, first.testId),
      first,
    );
    await assert.rejects(
      h.runtime.start(
        { ...request, requestId: "TEST-stale" },
        h.context,
        signal(),
      ),
      (e) => e instanceof IdentityError && e.code === "process_sources_changed",
    );
    h.revoke();
    await assert.rejects(h.runtime.read(h.context, designTarget, first.testId));
  } finally {
    h.db.close();
  }
});

test("final report/audit commit is atomic and cannot overwrite prior terminal report", async () => {
  const h = setup();
  try {
    const request = {
      ...h.request,
      suite: { cases: [h.request.suite.cases[0]!] },
    };
    const reserved = h.journal.reserve(
      designActor,
      request,
      processContractStamp(h.artifact, request.suite),
    );
    const report = await runProcessContractExperiment(
      h.artifact,
      request.suite,
      signal(),
      async () => {},
    );
    assert.throws(
      () =>
        h.journal.complete(designActor, reserved.job.testId, {
          ...report,
          stamp: { ...report.stamp, suiteDigest: "f".repeat(64) },
        }),
      (e) => e instanceof IdentityError && e.code === "process_test_conflict",
    );
    h.failJournalAudit();
    assert.throws(
      () => h.journal.complete(designActor, reserved.job.testId, report),
      /TEST journal audit failed/,
    );
    assert.equal(
      h.journal.read(designActor, reserved.job.testId).status,
      "running",
    );
    assert.equal(h.journal.read(designActor, reserved.job.testId).report, null);
  } finally {
    h.db.close();
  }
});

test("native contract reports cannot claim nonexistent suspension or downstream fixture coverage", async () => {
  const h = setup();
  try {
    const item = suite().cases[0]!;
    const report = await runProcessContractExperiment(
      h.artifact,
      ProcessTestSuiteSchema.parse({
        cases: [{ ...item, scenario: "restart", reopenAt: "suspended" }],
      }),
      signal(),
      async () => {},
    );
    assert.equal(report.status, "failed");
    assert(report.observations[0]!.assertions.includes("reopen_not_exercised"));
    const artifact = {
      ...h.artifact,
      definition: ProcessDefinitionSchema.parse({
        ...h.artifact.definition,
        inputSchema: processObject(),
        entry: "done",
        steps: [
          {
            id: "done",
            type: "return",
            output: { result: { source: "literal", value: "TEST result" } },
          },
        ],
      }) as ProcessDefinition,
    };
    // This deliberately bypasses registry validation to probe the native runner's fail-closed identity.
    await assert.rejects(
      runProcessContractExperiment(
        artifact,
        { cases: [item] },
        signal(),
        async () => {},
      ),
    );
  } finally {
    h.db.close();
  }
});
