import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROCESS_NATIVE_TEST_PROFILE,
  NativeTestRequestSchema,
  NativeTestDetailSchema,
  NativeTestDetailQuerySchema,
} from "../packages/protocol/process-native-testing";
import { ProcessTestingStore } from "../apps/server-identity/process-testing-store";
import { AuditStore } from "../apps/server-identity/audit";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { processNativeTools } from "../apps/server-identity/process-native-tools";
import { processAgentToolName } from "../apps/server-agent/process-agent-tools";
import {
  processNativeStamp,
  processNativeExecutionSettings,
} from "../apps/server-identity/process-native-environment";
import {
  fixture,
  admin,
  target,
  code,
} from "./helpers/service-process-runtime";
import { buildNativeTestFixture } from "./helpers/process-native-testing";
import { processObject } from "./helpers/service-process";

async function setup(
  run: (x: ReturnType<typeof build>) => Promise<void> | void,
) {
  const root = mkdtempSync(join(tmpdir(), "niaro-native-detail-"));
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
  const suite = { genericModelId: x.modelId, cases: [x.read] };
  const request = NativeTestRequestSchema.parse({
    ...target,
    profile: PROCESS_NATIVE_TEST_PROFILE,
    requestId: "TEST-native-detail",
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
    (r) => new AuditStore(h.db).append(r),
  );
  const reserve = () =>
    journal.reserveNative(
      admin,
      request,
      processNativeStamp(x.artifact, x.catalog, suite),
      environment,
    ).job;
  const query = (extra: object) =>
    NativeTestDetailQuerySchema.parse({
      ...target,
      profile: PROCESS_NATIVE_TEST_PROFILE,
      ...extra,
    });
  return { ...x, path, request, environment, journal, reserve, query };
}

test("native detail requires exact profile and one test or request identifier", () => {
  const base = { ...target, profile: PROCESS_NATIVE_TEST_PROFILE };
  assert(
    NativeTestDetailQuerySchema.safeParse({ ...base, testId: "TEST-test" })
      .success,
  );
  assert(
    NativeTestDetailQuerySchema.safeParse({
      ...base,
      requestId: "TEST-request",
    }).success,
  );
  for (const value of [
    base,
    { ...base, testId: "TEST-test", requestId: "TEST-request" },
    { ...base, testId: "TEST-test", userId: "TEST-forged" },
    { ...base, requestId: "TEST-request", profile: "agent-process-tests/1" },
    { ...base, requestId: "TEST?" },
  ])
    assert.equal(NativeTestDetailQuerySchema.safeParse(value).success, false);
});

test("native tool projection preserves independent workflow agent node/model/capability order", () =>
  setup((x) => {
    const original = x.artifact.definition;
    assert(original.kind === "agent");
    const {
      kind: _kind,
      modelId,
      instructions,
      capabilities,
      memory,
      ...base
    } = original;
    const agent = (id: string, order: typeof capabilities, next: string) => ({
      type: "agent",
      id,
      modelId,
      instructions,
      capabilities: order,
      memory,
      inputSchema: processObject(),
      outputSchema: processObject(),
      input: {},
      next,
    });
    const definition = ProcessDefinitionSchema.parse({
      ...base,
      kind: "workflow",
      entry: "first",
      steps: [
        agent("first", capabilities, "second"),
        agent("second", [...capabilities].reverse(), "done"),
        { id: "done", type: "return", output: {} },
      ],
    });
    const projected = processNativeTools(
      { ...x.artifact, definition },
      x.catalog,
      x.modelId,
    );
    assert.deepEqual(projected.configured, [
      {
        nodeId: "first",
        modelId,
        tools: capabilities.map((capability, index) => ({
          ...capability,
          name: processAgentToolName(index),
        })),
      },
      {
        nodeId: "second",
        modelId,
        tools: [...capabilities].reverse().map((capability, index) => ({
          ...capability,
          name: processAgentToolName(index),
        })),
      },
    ]);
    assert("actionId" in projected.configured[0]!.tools[0]!);
    assert("actionId" in projected.configured[1]!.tools[0]!);
    assert.notEqual(
      projected.configured[0]!.tools[0]!.actionId,
      projected.configured[1]!.tools[0]!.actionId,
    );
    assert.deepEqual(x.h.counts(), []);
    assert.equal(
      x.h.db.prepare("SELECT COUNT(*) AS n FROM test_model").get()!.n,
      0,
    );
  }));

test("native detail recovers running and interrupted original commands privately without exposing environment", () =>
  setup((x) => {
    const job = x.reserve();
    const detail = { job, request: x.request };
    assert.deepEqual(
      x.journal.nativeDetail(
        admin,
        x.query({ requestId: x.request.requestId }),
      ),
      detail,
    );
    assert.deepEqual(
      x.journal.nativeDetail(admin, x.query({ testId: job.testId })),
      detail,
    );
    const cloned = x.journal.nativeDetail(
      admin,
      x.query({ testId: job.testId }),
    );
    cloned.request.suite.cases[0]!.models.configured[0]!.requiredTools.push(
      "TEST-mutated-client",
    );
    assert.deepEqual(
      x.journal.nativeDetail(admin, x.query({ testId: job.testId })),
      detail,
    );
    assert.deepEqual(Object.keys(detail).sort(), ["job", "request"]);
    assert(!JSON.stringify(detail).includes('"environment"'));
    assert(!JSON.stringify(detail).includes('"catalog"'));
    x.journal.interrupt(admin, job.testId, "test_aborted");
    assert.equal(
      x.journal.nativeDetail(admin, x.query({ requestId: job.requestId })).job
        .status,
      "interrupted",
    );
    for (const query of [
      x.query({ testId: job.testId }),
      x.query({ requestId: job.requestId }),
    ]) {
      assert.throws(
        () => x.journal.nativeDetail({ ...admin, userId: "TEST-other" }, query),
        code("process_test_not_found"),
      );
      assert.throws(
        () =>
          new ProcessTestingStore(
            x.h.db,
            "TEST-other-server",
            x.h.registry,
            () => {},
          ).nativeDetail(admin, query),
        code("process_test_not_found"),
      );
      // A demoted creator keeps only tests of personal processes they own.
      assert.throws(
        () => x.journal.nativeDetail({ ...admin, role: "member" }, query),
        code("process_test_not_found"),
      );
    }
    assert.deepEqual(x.h.counts(), []);
    assert.equal(
      x.h.db.prepare("SELECT COUNT(*) AS n FROM test_model").get()!.n,
      0,
    );
  }));

test("native completed detail retains exact model scripts and historical artifact binding after source drift and reopen", () =>
  setup(async (x) => {
    const job = x.reserve(),
      report = await x.run([x.read]);
    x.journal.completeNative(admin, job.testId, report, {
      catalog: x.catalog,
      authorityEpoch: 0,
    });
    const expected = x.journal.nativeDetail(
      admin,
      x.query({ requestId: job.requestId }),
    );
    assert.deepEqual(expected.request, x.request);
    assert.equal(expected.job.status, "completed");
    assert.deepEqual(expected.job.report, report);
    assert(NativeTestDetailSchema.safeParse(expected).success);
    assert.equal(
      NativeTestDetailSchema.safeParse({
        ...expected,
        request: { ...x.request, artifactDigest: "0".repeat(64) },
      }).success,
      false,
    );
    x.h.db
      .prepare("UPDATE agent_catalog SET revision=revision+1 WHERE id=?")
      .run(x.h.ids.readId);
    x.h.registry.testArtifact = () => {
      throw Error("TEST detail resolved current source");
    };
    assert.deepEqual(
      x.journal.nativeDetail(admin, x.query({ testId: job.testId })),
      expected,
    );
    await x.h.close();
    const reopened = fixture(x.path, x.h.ids);
    try {
      reopened.registry.testArtifact = () => {
        throw Error("TEST reopened detail resolved source");
      };
      const journal = new ProcessTestingStore(
        reopened.db,
        "TEST-server",
        reopened.registry,
        (r) => new AuditStore(reopened.db).append(r),
      );
      assert.deepEqual(
        journal.nativeDetail(admin, x.query({ requestId: job.requestId })),
        expected,
      );
      assert.deepEqual(
        journal.nativeDetail(admin, x.query({ testId: job.testId })),
        expected,
      );
      assert.deepEqual(reopened.counts(), []);
      assert.equal(
        reopened.db.prepare("SELECT COUNT(*) AS n FROM test_model").get()!.n,
        0,
      );
    } finally {
      await reopened.close();
    }
  }));

test("native detail rejects corrupt original actor/scope/process/version/artifact/suite namespace", () =>
  setup((x) => {
    const job = x.reserve();
    const original = x.h.db
      .prepare("SELECT data FROM agent_process_contract_test WHERE test_id=?")
      .get(job.testId)!.data;
    const mutations: ((stored: ReturnType<typeof JSON.parse>) => void)[] = [
      (s) => {
        s.creator.role = "member";
      },
      (s) => {
        s.request.processId = "TEST-forged-process";
      },
      (s) => {
        s.request.requestId = "TEST-forged-request";
      },
      (s) => {
        s.request.organizationId = "TEST-forged-org";
      },
      (s) => {
        s.request.version = 99;
      },
      (s) => {
        s.request.artifactDigest = "0".repeat(64);
      },
      (s) => {
        s.request.suite.cases[0].input = { name: "TEST-tampered" };
      },
      (s) => {
        s.environment.catalog.userId = "TEST-forged-user";
      },
    ];
    for (const mutate of mutations) {
      const stored = JSON.parse(String(original));
      mutate(stored);
      x.h.db
        .prepare(
          "UPDATE agent_process_contract_test SET data=? WHERE test_id=?",
        )
        .run(JSON.stringify(stored), job.testId);
      assert.throws(() =>
        x.journal.nativeDetail(admin, x.query({ testId: job.testId })),
      );
    }
    x.h.db
      .prepare("UPDATE agent_process_contract_test SET data=? WHERE test_id=?")
      .run(original!, job.testId);
    assert.deepEqual(
      x.journal.nativeDetail(admin, x.query({ requestId: job.requestId }))
        .request,
      x.request,
    );
  }));
