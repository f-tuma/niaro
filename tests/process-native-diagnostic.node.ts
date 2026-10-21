import assert from "node:assert/strict";
import { after, test } from "node:test";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Dataset } from "@mastra/core/datasets";
import { ExperimentsLibSQL, LibSQLStore } from "@mastra/libsql";
import {
  PROCESS_NATIVE_TEST_DETAIL_PROFILE as detailProfile,
  NativeTestRequestSchema,
  NativeTestDetailSchema,
  NativeTestDetailV2Schema,
  NativeTestDetailV2QuerySchema,
  NativeTestDiagnosticSchema,
  type NativeTestRequest,
  type NativeTestDetailV2,
} from "../packages/protocol/process-native-testing";
import { ProcessVersionSchema } from "../packages/protocol/service-processes";
import { PROCESS_VERSION_PROFILE } from "../packages/protocol/process-versions";
import { processDigest } from "../apps/server-identity/process-validation";
import { NativeTestDiagnosticError } from "../apps/server-agent/process-native-diagnostic";
import {
  nativeHttpFixture,
  nativeHttpPath as base,
} from "./helpers/process-native-http";

type Fixture = Awaited<ReturnType<typeof nativeHttpFixture>>;
let ready: Promise<Fixture> | undefined;
const rendered: Record<string, NativeTestDetailV2> = {};
const renderedContext: Record<string, unknown> = {};
async function fixture() {
  ready ??= (async () => {
    const h = await nativeHttpFixture();
    const service = h.identity["catalog"].store.service(
      h.target.workspaceId,
      h.serviceId,
    );
    const action = service.actions.find((a) => a.id === h.actionId)!;
    const { id, revision, sourceKey: _sourceKey, ...settings } = action;
    await h.catalog({
      type: "saveAction",
      id,
      revision,
      serviceId: service.id,
      serviceRevision: service.revision,
      settings: {
        ...settings,
        effect: "write",
        approval: "always",
        binding: { ...settings.binding, method: "POST", body: true },
      },
    });
    return h;
  })();
  return ready;
}
after(async () => {
  if (ready) await (await ready).close();
  if (process.env.NIAR99_RENDER_FIXTURES) {
    writeFileSync(
      process.env.NIAR99_RENDER_FIXTURES,
      JSON.stringify(rendered, null, 2),
      { mode: 0o600 },
    );
    writeFileSync(
      process.env.NIAR99_RENDER_FIXTURES + ".contexts.json",
      JSON.stringify(renderedContext, null, 2),
      { mode: 0o600 },
    );
  }
});
function query(h: Fixture, fields: Record<string, string>) {
  return new URLSearchParams({
    ...h.target,
    profile: detailProfile,
    ...fields,
  }).toString();
}
async function fresh(h: Fixture, id: string, human = false) {
  let request = structuredClone(await h.fresh());
  request.requestId = "TEST-NIAR99-" + id;
  request.suite.cases[0]!.id = id;
  request.suite.cases[0]!.expected.receipts[0]!.effect = "write";
  if (human) {
    const old = await h.request(
      "owner",
      "api/identity/catalog/processes?" +
        new URLSearchParams({
          ...h.target,
          id: request.processId,
          version: String(request.version),
        }),
    );
    assert.equal(old.status, 200);
    const version = ProcessVersionSchema.parse(h.record(old.data).version);
    const saved = await h.request(
      "owner",
      "api/identity/catalog/processes/command",
      {
        ...h.target,
        type: "saveDraft",
        serviceId: h.serviceId,
        revision: 0,
        definition: { ...version.definition, humanInput: "text" },
      },
    );
    assert.equal(saved.status, 200);
    const draft = h.record(h.record(saved.data).process);
    const frozen = await h.request(
      "owner",
      "api/identity/catalog/processes/command",
      {
        ...h.target,
        type: "freezeDraft",
        id: draft.id,
        revision: draft.revision,
      },
    );
    assert.equal(frozen.status, 200);
    const artifact = ProcessVersionSchema.parse(h.record(frozen.data).version);
    const process = h.record(h.record(frozen.data).process);
    request = NativeTestRequestSchema.parse({
      ...request,
      processId: process.id,
      revision: process.revision,
      version: artifact.version,
      artifactDigest: artifact.digest,
    });
  }
  return NativeTestRequestSchema.parse(request);
}
function question(h: Fixture, callId: string) {
  return {
    modelId: h.modelId,
    requiredTools: ["ask_user"],
    reply: {
      type: "tool" as const,
      name: "ask_user",
      callId,
      input: { question: "TEST which account?" },
    },
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}
function approved(request: NativeTestRequest) {
  request.suite.cases[0]!.actions[0]!.decision = "approve";
  return request;
}
async function detail(h: Fixture, request: NativeTestRequest) {
  const response = await h.request(
    "owner",
    base + "/detail?" + query(h, { requestId: request.requestId }),
  );
  assert.equal(response.status, 200);
  const result = NativeTestDetailV2Schema.parse(response.data);
  rendered[request.suite.cases[0]!.id] = result;
  if (process.env.NIAR99_RENDER_FIXTURES) {
    const paths = [
      "api/identity/catalog/processes?" +
        new URLSearchParams({ ...h.target, id: request.processId }),
      "api/identity/catalog/processes/versions?" +
        new URLSearchParams({
          ...h.target,
          profile: PROCESS_VERSION_PROFILE,
          processId: request.processId,
        }),
      base +
        "/list?" +
        h.query({ processId: request.processId, version: request.version }),
      "api/identity/catalog/processes/design/capabilities?" +
        new URLSearchParams(h.target),
    ];
    const responses = await Promise.all(
      paths.map(async (path) => {
        const response = await h.request("owner", path);
        assert.equal(response.status, 200);
        return { path, data: response.data };
      }),
    );
    const stored = JSON.parse(
      String(
        h.identity["db"]
          .prepare(
            "SELECT data FROM agent_process_contract_test WHERE test_id=?",
          )
          .get(result.job.testId)!.data,
      ),
    );
    renderedContext[request.suite.cases[0]!.id] = {
      scope: {
        ...h.target,
        processId: request.processId,
        serviceId: h.serviceId,
        userId: stored.creator.userId,
        authority: "TEST-console-authority",
      },
      responses,
    };
  }
  return result;
}
async function incomplete(h: Fixture, request: NativeTestRequest) {
  const before = h.production();
  const response = await h.request("owner", base, request);
  assert.equal(response.status, 502);
  assert.deepEqual(response.data, { error: "integration_unavailable" });
  const result = await detail(h, request);
  assert.equal(result.job.status, "interrupted");
  assert.equal(result.job.failure, "test_runner_failed");
  assert.equal(result.job.report, null);
  assert.equal(result.job.qualification, undefined);
  assert(result.diagnostic);
  assert.deepEqual(h.production(), before);
  assert.equal(h.modelCount(), 0);
  assert.equal(h.businessCount(), 0);
  return result;
}

test("configured approval-always without a decision persists truthful incomplete diagnostics and passive /1 and /2 recovery", async (t) => {
  let experiments = 0;
  const start = Dataset.prototype.startExperiment;
  t.mock.method(
    Dataset.prototype,
    "startExperiment",
    function (this: Dataset, config: Parameters<typeof start>[0]) {
      experiments++;
      return start.call(this, config);
    },
  );
  const h = await fixture(),
    request = await fresh(h, "approval");
  const result = await incomplete(h, request);
  assert.equal(result.diagnostic!.code, "native_test_approval_unexpected");
  assert.equal(result.diagnostic!.category, "native_checkpoint");
  assert.deepEqual(result.diagnostic!.evidence!.checkpoint, {
    status: "waiting",
    pending: "approval",
  });
  assert.equal(
    result.diagnostic!.evidence!.receipts![0]!.status,
    "awaiting_approval",
  );
  assert.equal(result.diagnostic!.evidence!.businessDispatches, 0);
  assert.equal(result.diagnostic!.evidence!.approvals, 0);
  const raw = () =>
    String(
      h.identity["db"]
        .prepare("SELECT data FROM agent_process_contract_test WHERE test_id=?")
        .get(result.job.testId)!.data,
    );
  const original = raw(),
    audits = h.identity["db"]
      .prepare("SELECT COUNT(*) AS n FROM agent_audit")
      .get()!.n;
  for (let i = 0; i < 3; i++) {
    const history = await h.request(
      "owner",
      base +
        "/list?" +
        h.query({ processId: request.processId, version: request.version }),
    );
    assert.equal(history.status, 200);
    const legacy = await h.request(
      "owner",
      base + "/detail?" + h.query({ testId: result.job.testId }),
    );
    assert.deepEqual(NativeTestDetailSchema.parse(legacy.data), {
      job: result.job,
      request,
    });
    assert.deepEqual(await detail(h, request), result);
    const replay = await h.request("owner", base, request);
    assert.equal(replay.status, 200);
    assert.deepEqual(h.job(replay.data), result.job);
    assert.equal(raw(), original);
    assert.equal(
      h.identity["db"].prepare("SELECT COUNT(*) AS n FROM agent_audit").get()!
        .n,
      audits,
    );
    if (i < 2) await h.restart();
  }
  assert.equal(experiments, 1);
});

for (const later of [false, true])
  test(`compiler3 ${later ? "later question preserves succeeded write" : "first unexpected question preserves waiting checkpoint"}`, async () => {
    const h = await fixture(),
      request = await fresh(
        h,
        later ? "later_question" : "first_question",
        true,
      );
    const item = request.suite.cases[0]!;
    if (later) {
      approved(request);
      item.models.configured[1] = question(h, "TEST-later-question");
    } else {
      item.actions = [];
      item.expected.receipts = [];
      item.models.configured = [question(h, "TEST-first-question")];
    }
    const result = await incomplete(h, request);
    assert.equal(
      result.diagnostic!.code,
      "native_test_question_fixture_conflict",
    );
    assert.deepEqual(result.diagnostic!.evidence!.checkpoint, {
      status: "waiting",
      pending: "question",
    });
    assert.equal(
      result.diagnostic!.evidence!.businessDispatches,
      later ? 1 : 0,
    );
    assert.deepEqual(
      result.diagnostic!.evidence!.receipts!.map((r) => r.status),
      later ? ["succeeded"] : [],
    );
  });

test("unknown write, invalid output after a completed write and domain denial retain their complete terminal report semantics", async () => {
  const h = await fixture();
  for (const control of [
    "unknown",
    "invalid_output",
    "domain_denial",
  ] as const) {
    const request = approved(await fresh(h, control)),
      item = request.suite.cases[0]!;
    if (control === "unknown") {
      item.scenario = "unknown";
      item.actions[0]!.outcome = "unknown";
      item.models.configured = item.models.configured.slice(0, 1);
      item.models.generic[2]!.reply = {
        type: "text",
        text: '{"result":"The outcome is unknown; verify before retrying."}',
      };
      item.models.generic.push(structuredClone(item.models.generic[2]!));
      const { output: _output, ...receipt } = item.expected.receipts[0]!;
      item.expected = {
        outcome: "unknown",
        codes: {
          configured: "integration_unavailable",
          generic: "integration_unavailable",
        },
        receipts: [
          { ...receipt, status: "unknown", code: "integration_unavailable" },
        ],
      };
    } else if (control === "invalid_output") {
      item.scenario = "failure";
      item.models.configured[1]!.reply = {
        type: "text",
        text: "TEST invalid JSON",
      };
      item.models.generic[2]!.reply = {
        type: "text",
        text: "TEST invalid JSON",
      };
      item.expected = {
        outcome: "failed",
        codes: {
          configured: "process_output_invalid",
          generic: "process_output_invalid",
        },
        receipts: item.expected.receipts,
      };
    } else {
      item.scenario = "rejection";
      item.actions[0]!.decision = "reject";
      item.models.configured = item.models.configured.slice(0, 1);
      const { output: _output, ...receipt } = item.expected.receipts[0]!;
      item.expected = {
        outcome: "rejected",
        codes: {
          configured: "process_action_rejected",
          generic: "process_action_rejected",
        },
        receipts: [{ ...receipt, status: "rejected", dispatches: 0 }],
      };
    }
    const response = await h.request(
      "owner",
      base,
      NativeTestRequestSchema.parse(request),
    );
    assert.equal(response.status, 200);
    const result = await detail(h, request);
    assert.equal(result.diagnostic, null);
    assert.equal(result.job.status, "completed");
    for (const observation of result.job.report!.observations)
      assert.equal(
        observation.receipts[0]!.status,
        control === "unknown"
          ? "unknown"
          : control === "invalid_output"
            ? "succeeded"
            : "rejected",
      );
  }
});

test("actual succeeded write plus Mastra result persistence failure carries bounded persistence evidence without raw error strings", async (t) => {
  const h = await fixture(),
    request = approved(await fresh(h, "persistence"));
  t.mock.method(
    ExperimentsLibSQL.prototype,
    "addExperimentResult",
    async () => {
      throw Error("TEST PRIVATE RAW password=DO-NOT-EXPOSE SQL payload");
    },
  );
  const result = await incomplete(h, request);
  assert.equal(result.diagnostic!.category, "persistence");
  assert.equal(
    result.diagnostic!.code,
    "native_test_result_persistence_failed",
  );
  assert.equal(result.diagnostic!.evidence!.receipts![0]!.status, "succeeded");
  assert.equal(result.diagnostic!.evidence!.businessDispatches, 1);
  assert(!JSON.stringify(result).includes("DO-NOT-EXPOSE"));
  assert(!JSON.stringify(result.diagnostic).includes("input"));
});

test("actual succeeded native task with malformed persisted result is interrupted without repairing the experiment", async (t) => {
  const h = await fixture(),
    request = approved(await fresh(h, "malformed"));
  const list = Dataset.prototype.listExperimentResults;
  t.mock.method(
    Dataset.prototype,
    "listExperimentResults",
    async function (this: Dataset, ...args: Parameters<typeof list>) {
      const results = await list.apply(this, args);
      results.results[0]!.output = { private: "TEST DO-NOT-EXPOSE" };
      return results;
    },
  );
  const result = await incomplete(h, request);
  assert.equal(
    result.diagnostic!.code,
    "native_test_experiment_result_invalid",
  );
  assert.equal(result.diagnostic!.evidence!.receipts![0]!.status, "succeeded");
  assert(!JSON.stringify(result).includes("DO-NOT-EXPOSE"));
});

test("first native boundary survives later case failures, Mastra orchestration throw and cleanup overlay", async (t) => {
  const h = await fixture(),
    request = await fresh(h, "first_primary", true);
  const second = structuredClone(request.suite.cases[0]!);
  second.id = "second_question";
  second.actions = [];
  second.expected.receipts = [];
  second.models.configured = [question(h, "TEST-second-question")];
  request.suite.cases.push(second);
  const start = Dataset.prototype.startExperiment;
  t.mock.method(
    Dataset.prototype,
    "startExperiment",
    async function (this: Dataset, ...args: Parameters<typeof start>) {
      await start.apply(this, args);
      throw Error("TEST PRIVATE orchestration error");
    },
  );
  const close = LibSQLStore.prototype.close;
  t.mock.method(
    LibSQLStore.prototype,
    "close",
    async function (this: LibSQLStore) {
      await close.call(this);
      throw Error("TEST PRIVATE cleanup error");
    },
  );
  const result = await incomplete(h, request);
  assert.equal(result.diagnostic!.code, "native_test_approval_unexpected");
  assert.equal(result.diagnostic!.evidence!.caseId, "first_primary");
  assert.equal(
    result.diagnostic!.evidence!.receipts![0]!.status,
    "awaiting_approval",
  );
  assert(
    result.diagnostic!.secondaryCodes.includes("native_test_cleanup_failed"),
  );
});

test("generic orchestration failure after real native tasks retains only current strategy evidence", async (t) => {
  const h = await fixture(),
    request = approved(await fresh(h, "generic_orchestration"));
  const start = Dataset.prototype.startExperiment;
  let experiments = 0;
  t.mock.method(
    Dataset.prototype,
    "startExperiment",
    async function (this: Dataset, config: Parameters<typeof start>[0]) {
      experiments++;
      const result = await start.call(this, config);
      if (config.name === "generic")
        throw Error("TEST PRIVATE generic orchestration error");
      return result;
    },
  );
  const result = await incomplete(h, request);
  assert.equal(experiments, 2);
  assert.equal(result.diagnostic!.code, "native_test_experiment_incomplete");
  assert.equal(result.diagnostic!.evidence!.strategy, "generic");
  assert.equal(result.diagnostic!.evidence!.receipts![0]!.status, "succeeded");
  assert.equal(result.diagnostic!.evidence!.businessDispatches, 1);
  assert(!JSON.stringify(result).includes("PRIVATE"));
});

test("specific question boundary and succeeded receipt survive unavailable budget evidence without invented counters", async (t) => {
  const h = await fixture(),
    request = approved(await fresh(h, "budget_overlay", true));
  request.suite.cases[0]!.models.configured[1] = question(
    h,
    "TEST-budget-question",
  );
  const prepare = DatabaseSync.prototype.prepare;
  let failures = 0;
  t.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, ...args: Parameters<typeof prepare>) {
      if (
        args[0] ===
        "SELECT COUNT(*) AS n FROM agent_inference_attempt WHERE status IN ('settled','unknown','dispatched')"
      ) {
        failures++;
        throw Error("TEST PRIVATE unavailable budget query");
      }
      return prepare.apply(this, args);
    },
  );
  const result = await incomplete(h, request);
  assert(failures > 0);
  assert.equal(
    result.diagnostic!.code,
    "native_test_question_fixture_conflict",
  );
  assert(
    result.diagnostic!.secondaryCodes.includes(
      "native_test_budget_unavailable",
    ),
  );
  assert.equal(result.diagnostic!.evidence!.receipts![0]!.status, "succeeded");
  assert.equal(result.diagnostic!.evidence!.businessDispatches, 1);
  assert.equal(result.diagnostic!.evidence!.modelCalls, undefined);
  assert.deepEqual(result.diagnostic!.evidence!.checkpoint, {
    status: "waiting",
    pending: "question",
  });
});

test("generic capture rejects cross-owner, cross-conversation and foreign canonical native root facts", async (t) => {
  const h = await fixture();
  let mutation: "owner" | "conversation" | "run" = "owner",
    guardedReads = 0;
  let forgedRoot:
    | { workspace_id: string; user_id: string; data: string }
    | undefined;
  let actualNativeRunId: string | undefined;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(
    DatabaseSync.prototype,
    "prepare",
    function (this: DatabaseSync, ...args: Parameters<typeof prepare>) {
      const statement = prepare.apply(this, args);
      if (
        mutation === "run" &&
        args[0] ===
          "SELECT id,workspace_id,user_id,data FROM agent_service_turn WHERE json_extract(data,'$.kind')='mastra-1' ORDER BY rowid DESC LIMIT 1"
      ) {
        const get = statement.get;
        statement.get = function (
          this: typeof statement,
          ...parameters: unknown[]
        ) {
          const row = Reflect.apply(get, this, parameters) as ReturnType<
            typeof get
          >;
          assert(row);
          const state = JSON.parse(String(row.data));
          actualNativeRunId = state.runId;
          state.runId = "TEST-foreign-native-run";
          forgedRoot = {
            workspace_id: String(row.workspace_id),
            user_id: String(row.user_id),
            data: JSON.stringify(state),
          };
          return { ...row, ...forgedRoot, id: state.runId };
        };
      }
      if (
        args[0] ===
        "SELECT workspace_id,user_id,data FROM agent_service_turn WHERE id=?"
      ) {
        const get = statement.get;
        statement.get = function (
          this: typeof statement,
          ...parameters: unknown[]
        ) {
          if (mutation === "run" && forgedRoot) {
            guardedReads++;
            return forgedRoot;
          }
          const row = Reflect.apply(get, this, parameters) as ReturnType<
            typeof get
          >;
          assert(row);
          guardedReads++;
          const state = JSON.parse(String(row.data));
          actualNativeRunId = state.runId;
          if (mutation === "owner")
            return { ...row, user_id: "TEST-foreign-owner" };
          if (mutation === "conversation")
            state.conversationId = "TEST-foreign-conversation";
          else state.runId = "TEST-foreign-native-run";
          return { ...row, data: JSON.stringify(state) };
        };
      }
      return statement;
    },
  );
  for (mutation of ["owner", "conversation", "run"] as const) {
    forgedRoot = undefined;
    actualNativeRunId = undefined;
    const request = approved(await fresh(h, "generic_root_" + mutation));
    const result = await incomplete(h, request);
    assert.equal(result.diagnostic!.code, "native_test_receipt_unavailable");
    assert.equal(result.diagnostic!.evidence!.strategy, "generic");
    assert.equal(result.diagnostic!.evidence!.checkpoint, undefined);
    assert.equal(
      result.diagnostic!.evidence!.receipts![0]!.status,
      "succeeded",
    );
    assert.notEqual(
      result.diagnostic!.evidence!.runId,
      "TEST-foreign-native-run",
    );
    assert.equal(result.diagnostic!.evidence!.runId, actualNativeRunId);
  }
  assert.equal(guardedReads, 3);
});

test("task input conflict is preserved before Mastra serialization and does not execute a native case", async (t) => {
  const h = await fixture(),
    request = await fresh(h, "input_conflict");
  const start = Dataset.prototype.startExperiment;
  t.mock.method(
    Dataset.prototype,
    "startExperiment",
    function (this: Dataset, config: Parameters<typeof start>[0]) {
      const task = config.task!;
      return start.call(this, {
        ...config,
        task: (context) =>
          task({
            ...context,
            input: { ...(context.input as object), id: "TEST-forged-case" },
          }),
      });
    },
  );
  const result = await incomplete(h, request);
  assert.equal(result.diagnostic!.code, "native_test_experiment_conflict");
  assert.equal(result.diagnostic!.evidence, undefined);
});

test("a later unidentifiable task input cannot replace the first actual native approval boundary", async (t) => {
  const h = await fixture(),
    request = await fresh(h, "first_before_unidentifiable");
  const second = structuredClone(request.suite.cases[0]!);
  second.id = "second_unidentifiable";
  request.suite.cases.push(second);
  const start = Dataset.prototype.startExperiment;
  let callbacks = 0;
  t.mock.method(
    Dataset.prototype,
    "startExperiment",
    function (this: Dataset, config: Parameters<typeof start>[0]) {
      const task = config.task!;
      return start.call(this, {
        ...config,
        task: (context) => {
          callbacks++;
          return task(
            (context.input as { id: string }).id === "second_unidentifiable"
              ? { ...context, input: { id: "TEST-unidentifiable" } }
              : context,
          );
        },
      });
    },
  );
  const result = await incomplete(h, request);
  assert.equal(callbacks, 2);
  assert.equal(result.diagnostic!.code, "native_test_approval_unexpected");
  assert.equal(
    result.diagnostic!.evidence!.caseId,
    "first_before_unidentifiable",
  );
  assert.equal(result.diagnostic!.evidence!.modelCalls, 1);
  assert.equal(
    result.diagnostic!.evidence!.receipts![0]!.status,
    "awaiting_approval",
  );
});

for (const change of ["source", "authority"] as const)
  test(`${change} loss before retirement discards staged native diagnostics`, async (t) => {
    const h = await fixture(),
      request = await fresh(h, "discard_" + change);
    const start = Dataset.prototype.startExperiment;
    t.mock.method(
      Dataset.prototype,
      "startExperiment",
      async function (this: Dataset, ...args: Parameters<typeof start>) {
        const summary = await start.apply(this, args);
        if (change === "authority")
          h.mutateNativeHeader("cookie", "TEST-replaced-session");
        else {
          const service = h.identity["catalog"].store.service(
              h.target.workspaceId,
              h.serviceId,
            ),
            action = service.actions.find((a) => a.id === h.actionId)!;
          const { id, revision, sourceKey: _sourceKey, ...settings } = action;
          await h.catalog({
            type: "saveAction",
            id,
            revision,
            serviceId: service.id,
            serviceRevision: service.revision,
            settings: {
              ...settings,
              description: "TEST drift after native boundary",
            },
          });
        }
        return summary;
      },
    );
    const response = await h.request("owner", base, request);
    assert([401, 403, 409].includes(response.status));
    const row = JSON.parse(
      String(
        h.identity["db"]
          .prepare(
            "SELECT data FROM agent_process_contract_test WHERE json_extract(data,'$.request.requestId')=?",
          )
          .get(request.requestId)!.data,
      ),
    );
    assert.equal(row.job.status, "interrupted");
    assert.equal(
      row.job.failure,
      change === "source" ? "test_source_changed" : "test_authority_changed",
    );
    assert.equal(row.nativeDiagnostic, undefined);
    assert.equal(row.job.qualification, undefined);
  });

test("v2 detail negotiation is explicit, creator-private and rejected on every /1 endpoint", async () => {
  const h = await fixture(),
    request = await fresh(h, "negotiation");
  const result = await incomplete(h, request);
  for (const suffix of ["", "/list", "/tools"]) {
    const response = await h.request(
      "owner",
      base + suffix + "?" + query(h, { testId: result.job.testId }),
    );
    assert.equal(response.status, 400);
  }
  assert.equal(
    (await h.request("owner", base, { ...request, profile: detailProfile }))
      .status,
    400,
  );
  for (const invalid of [
    new URLSearchParams({ ...h.target, testId: result.job.testId }).toString(),
    query(h, { testId: result.job.testId, requestId: request.requestId }),
    query(h, { testId: result.job.testId }) + "&profile=" + detailProfile,
    query(h, { testId: result.job.testId }) + "&private=true",
  ])
    assert.equal(
      (await h.request("owner", base + "/detail?" + invalid)).status,
      400,
    );
  assert.equal(
    (
      await h.request(
        "admin",
        base + "/detail?" + query(h, { testId: result.job.testId }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await h.request(
        "member",
        base + "/detail?" + query(h, { testId: result.job.testId }),
      )
    ).status,
    // Creator-private: members can own personal tests, so not theirs is 404.
    404,
  );
  assert.equal(
    NativeTestDetailV2QuerySchema.safeParse({
      ...h.target,
      testId: result.job.testId,
    }).success,
    false,
  );
  assert.equal(
    NativeTestDetailV2Schema.safeParse({ ...result, profile: request.profile })
      .success,
    false,
  );
  assert.equal(
    NativeTestDiagnosticSchema.safeParse({
      ...result.diagnostic,
      raw: "TEST secret",
    }).success,
    false,
  );
});

test("abort during fresh retirement after an actual boundary interrupts without staged diagnostic", async (t) => {
  const h = await fixture(),
    request = await fresh(h, "discard_abort");
  let armed = false;
  const start = Dataset.prototype.startExperiment;
  t.mock.method(
    Dataset.prototype,
    "startExperiment",
    async function (this: Dataset, ...args: Parameters<typeof start>) {
      const summary = await start.apply(this, args);
      armed = true;
      return summary;
    },
  );
  const testing = h.identity["processNativeTesting"]!,
    original = testing.start;
  const abort = new AbortController();
  t.mock.method(
    testing,
    "start",
    (...[raw, context, signal]: Parameters<typeof original>) =>
      original(
        raw,
        {
          ...context,
          actor: async (target) => {
            const actor = await context.actor(target);
            if (armed) abort.abort();
            return actor;
          },
        },
        AbortSignal.any([signal, abort.signal]),
      ),
  );
  const response = await h.request("owner", base, request);
  assert.equal(response.status, 502);
  assert.equal(armed, true);
  const result = await detail(h, request);
  assert.equal(result.job.status, "interrupted");
  assert.equal(result.job.failure, "test_aborted");
  assert.equal(result.diagnostic, null);
  assert.equal(result.job.report, null);
});

test("genuine lost HTTP response after terminal diagnostic commit recovers by original request without another experiment", async (t) => {
  const h = await fixture(),
    request = await fresh(h, "lost_response");
  let experiments = 0;
  const start = Dataset.prototype.startExperiment;
  t.mock.method(
    Dataset.prototype,
    "startExperiment",
    function (this: Dataset, ...args: Parameters<typeof start>) {
      experiments++;
      return start.apply(this, args);
    },
  );
  const journal = h.identity["processTests"]!,
    interrupt = journal.interrupt;
  const abort = new AbortController();
  t.mock.method(
    journal,
    "interrupt",
    (...args: Parameters<typeof interrupt>) => {
      const job = interrupt.apply(journal, args);
      // The real journal has committed before the client loses its response.
      abort.abort();
      return job;
    },
  );
  await assert.rejects(
    h.request("owner", base, request, { signal: abort.signal }),
  );
  const result = await detail(h, request);
  assert.equal(result.diagnostic!.code, "native_test_approval_unexpected");
  const replay = await h.request("owner", base, request);
  assert.equal(replay.status, 200);
  assert.deepEqual(h.job(replay.data), result.job);
  assert.equal(experiments, 1);
});

test("private attachment rejects forged source, suite and counter facts while terminal diagnostics stay immutable", async () => {
  const h = await fixture(),
    request = await fresh(h, "attachment_guards");
  const result = await incomplete(h, request);
  const journal = h.identity["processTests"]!;
  const row = JSON.parse(
    String(
      h.identity["db"]
        .prepare("SELECT data FROM agent_process_contract_test WHERE test_id=?")
        .get(result.job.testId)!.data,
    ),
  );
  const evidence = journal.nativeEvidence(row.creator, result.job.testId);
  for (const change of [
    "service",
    "revision",
    "effect",
    "case",
    "scenario",
    "counter",
    "environment",
  ] as const) {
    const command = { ...request, requestId: request.requestId + "-" + change };
    const job = journal.reserveNative(
      row.creator,
      command,
      evidence.job.stamp,
      evidence.environment,
    ).job;
    const value = structuredClone(result.diagnostic!);
    const current = structuredClone(evidence.environment);
    if (change === "service")
      value.evidence!.receipts![0]!.serviceId = "TEST-foreign-service";
    if (change === "revision") value.evidence!.receipts![0]!.actionRevision++;
    if (change === "effect") value.evidence!.receipts![0]!.effect = "read";
    if (change === "case") value.evidence!.caseId = "TEST-foreign-case";
    if (change === "scenario") value.evidence!.scenario = "unknown";
    if (change === "counter") value.evidence!.modelCalls = 32;
    if (change === "environment") current.authorityEpoch++;
    assert.throws(() =>
      journal.interrupt(row.creator, job.testId, "test_runner_failed", {
        value,
        current,
        stamp: job.stamp,
      }),
    );
    assert.equal(journal.readNative(row.creator, job.testId).status, "running");
    journal.interrupt(row.creator, job.testId, "test_aborted");
  }
  assert.throws(
    () =>
      h.identity["db"]
        .prepare(
          "UPDATE agent_process_contract_test SET data=? WHERE test_id=?",
        )
        .run(
          JSON.stringify({ ...row, nativeDiagnostic: null }),
          result.job.testId,
        ),
    /process_contract_test_immutable/,
  );
  assert.deepEqual(await detail(h, request), result);
});

test("controller discards malformed or foreign attachment after an actual native boundary and still interrupts without another experiment", async (t) => {
  const h = await fixture();
  let mutation: "malformed" | "foreign" = "malformed",
    experiments = 0,
    nativeBoundaries = 0;
  const start = Dataset.prototype.startExperiment;
  t.mock.method(
    Dataset.prototype,
    "startExperiment",
    function (this: Dataset, config: Parameters<typeof start>[0]) {
      experiments++;
      const task = config.task!;
      return start.call(this, {
        ...config,
        task: async (context) => {
          try {
            return await task(context);
          } catch (error) {
            assert(error instanceof NativeTestDiagnosticError);
            assert.equal(
              error.diagnostic.code,
              "native_test_approval_unexpected",
            );
            nativeBoundaries++;
            if (mutation === "malformed")
              Object.assign(error.diagnostic, {
                code: "TEST PRIVATE invalid code",
              });
            else error.diagnostic.evidence!.receipts![0]!.actionRevision++;
            throw error;
          }
        },
      });
    },
  );
  for (mutation of ["malformed", "foreign"] as const) {
    const request = await fresh(h, "attachment_" + mutation),
      before = h.production();
    const response = await h.request("owner", base, request);
    assert.equal(response.status, 502);
    assert.deepEqual(response.data, { error: "integration_unavailable" });
    const result = await detail(h, request);
    assert.equal(result.job.status, "interrupted");
    assert.equal(result.job.failure, "test_runner_failed");
    assert.equal(result.job.report, null);
    assert.equal(result.job.qualification, undefined);
    assert.equal(result.diagnostic, null);
    const replay = await h.request("owner", base, request);
    assert.equal(replay.status, 200);
    assert.deepEqual(h.job(replay.data), result.job);
    assert.deepEqual(h.production(), before);
  }
  assert.equal(nativeBoundaries, 2);
  assert.equal(experiments, 2);
});

test("historical detail stays null and malformed or foreign persisted diagnostics fail passive reads without repair or execution", async (t) => {
  const h = await fixture(),
    request = await fresh(h, "persisted_guards");
  let experiments = 0;
  const start = Dataset.prototype.startExperiment;
  t.mock.method(
    Dataset.prototype,
    "startExperiment",
    function (this: Dataset, ...args: Parameters<typeof start>) {
      experiments++;
      return start.apply(this, args);
    },
  );
  const result = await incomplete(h, request);
  const db = h.identity["db"],
    journal = h.identity["processTests"]!,
    source = JSON.parse(
      String(
        db
          .prepare(
            "SELECT data FROM agent_process_contract_test WHERE test_id=?",
          )
          .get(result.job.testId)!.data,
      ),
    ),
    evidence = journal.nativeEvidence(source.creator, result.job.testId);
  const historical = {
    ...request,
    requestId: request.requestId + "-historical",
  };
  historical.suite = structuredClone(request.suite);
  historical.suite.cases[0]!.id = "null_historical";
  // This exercises the existing interrupted journal format with no optional
  // diagnostic, as retained by historical rows and ordinary interruption.
  const historicalJob = journal.reserveNative(
    source.creator,
    historical,
    { ...evidence.job.stamp, suiteDigest: processDigest(historical.suite) },
    evidence.environment,
  ).job;
  journal.interrupt(source.creator, historicalJob.testId, "test_runner_failed");
  assert.equal((await detail(h, historical)).diagnostic, null);
  for (const mutation of ["malformed", "foreign"] as const) {
    const command = {
      ...request,
      requestId: request.requestId + "-" + mutation,
    };
    const job = journal.reserveNative(
      source.creator,
      command,
      evidence.job.stamp,
      evidence.environment,
    ).job;
    const stored = JSON.parse(
      String(
        db
          .prepare(
            "SELECT data FROM agent_process_contract_test WHERE test_id=?",
          )
          .get(job.testId)!.data,
      ),
    );
    stored.job.status = "interrupted";
    stored.job.failure = "test_runner_failed";
    stored.nativeDiagnostic = structuredClone(result.diagnostic);
    if (mutation === "malformed")
      stored.nativeDiagnostic.code = "TEST PRIVATE unsupported raw failure";
    else stored.nativeDiagnostic.evidence.receipts[0].actionRevision++;
    const raw = JSON.stringify(stored);
    db.prepare(
      "UPDATE agent_process_contract_test SET data=? WHERE test_id=?",
    ).run(raw, job.testId);
    const audits = db.prepare("SELECT COUNT(*) AS n FROM agent_audit").get()!.n;
    for (let i = 0; i < 2; i++) {
      for (const profile of [request.profile, detailProfile]) {
        const response = await h.request(
          "owner",
          base +
            "/detail?" +
            new URLSearchParams({
              ...h.target,
              profile,
              testId: job.testId,
            }),
        );
        assert.equal(response.status, 409);
        assert.deepEqual(response.data, { error: "process_test_conflict" });
        assert(!JSON.stringify(response.data).includes("PRIVATE"));
      }
      const replay = await h.request("owner", base, command);
      assert.equal(replay.status, 409);
      assert.deepEqual(replay.data, { error: "process_test_conflict" });
      assert.equal(
        db
          .prepare(
            "SELECT data FROM agent_process_contract_test WHERE test_id=?",
          )
          .get(job.testId)!.data,
        raw,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM agent_audit").get()!.n,
        audits,
      );
      assert.equal(experiments, 1);
    }
  }
});
