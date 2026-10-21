import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeTestSuiteSchema,
  NativeTestReportSchema,
  type NativeTestCase,
} from "../packages/protocol/process-native-testing";
import { runProcessNativeComparison } from "../apps/server-identity/process-native-testing";
import { fixture, admin } from "./helpers/service-process-runtime";
import { buildNativeTestFixture as build } from "./helpers/process-native-testing";
import { processDigest } from "../apps/server-identity/process-validation";
import {
  ProcessDefinitionSchema,
  type ProcessDefinition,
} from "../packages/protocol/service-processes";
import { IdentityError } from "../apps/server-identity/error";
import { CatalogCommand } from "../packages/protocol/service-catalog";

const signal = () => new AbortController().signal;
async function setup(run: (input: ReturnType<typeof build>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "niaro-native-testing-fixture-"));
  const h = fixture(join(root, "identity.sqlite"));
  try {
    await run(build(h));
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function writeCase(
  x: ReturnType<typeof build>,
  decision: "approve" | "reject" = "approve",
  outcome: "complete" | "unknown" = "complete",
): NativeTestCase {
  const action = x.catalog.services
    .find((s) => s.id === x.h.ids.serviceId)!
    .actions.find((a) => a.id === x.h.ids.writeId)!;
  const rejected = decision === "reject";
  const unknown = !rejected && outcome === "unknown";
  const { output: _output, ...receipt } = x.read.expected.receipts[0]!;
  return NativeTestSuiteSchema.parse({
    genericModelId: x.modelId,
    cases: [
      {
        ...x.read,
        id: rejected ? "rejected" : unknown ? "unknown" : "write",
        scenario: rejected ? "rejection" : unknown ? "unknown" : "success",
        actions: [
          { ...x.read.actions[0], actionId: action.id, decision, outcome },
        ],
        models: {
          configured: [
            x.tool(
              "action_process_0",
              { name: "TEST-input" },
              "TEST-write-configured",
            ),
            ...(!rejected && !unknown
              ? [x.text({ result: "TEST-result" })]
              : []),
          ],
          generic: [
            x.tool(
              "find_actions",
              { service: "TEST service", need: "TEST write" },
              "TEST-write-find",
            ),
            x.tool(
              x.actionName(action.id),
              { name: "TEST-input" },
              "TEST-write-generic",
            ),
            x.text({
              result: unknown
                ? "The outcome is unknown; verify before retrying."
                : "TEST-result",
            }),
            ...(unknown
              ? [
                  x.text({
                    result: "The outcome is unknown; verify before retrying.",
                  }),
                ]
              : []),
          ],
        },
        expected: {
          outcome: rejected ? "rejected" : unknown ? "unknown" : "succeeded",
          ...(!rejected && !unknown
            ? { output: { result: "TEST-result" } }
            : {
                codes: {
                  configured: rejected
                    ? "process_action_rejected"
                    : "integration_unavailable",
                  generic: rejected
                    ? "process_action_rejected"
                    : "integration_unavailable",
                },
              }),
          receipts: [
            {
              ...receipt,
              actionId: action.id,
              actionRevision: action.revision,
              effect: "write",
              status: rejected ? "rejected" : unknown ? "unknown" : "succeeded",
              ...(!rejected && !unknown
                ? { output: { value: "TEST-result" } }
                : {}),
              ...(unknown ? { code: "integration_unavailable" } : {}),
              dispatches: rejected ? 0 : 1,
            },
          ],
        },
      },
    ],
  }).cases[0]!;
}

function freezeDefinition(
  x: ReturnType<typeof build>,
  definition: ProcessDefinition,
) {
  const draft = x.h.registry.saveDraft(admin, {
    serviceId: x.h.ids.serviceId,
    revision: 0,
    definition,
  });
  const artifact = x.h.registry.freezeDraft(admin, draft.id, draft.revision);
  const catalog = x.h.catalog.processTestCatalog(
    admin.organizationId,
    admin.workspaceId,
    admin,
    artifact.sources,
    x.modelId,
  );
  return { artifact, catalog };
}

function twoAgentDefinition(
  x: ReturnType<typeof build>,
  maxModelCalls: number,
) {
  const base = x.artifact.definition;
  assert(base.kind === "agent");
  const {
    kind: _kind,
    modelId,
    instructions,
    capabilities,
    memory,
    ...common
  } = base;
  const agent = {
    type: "agent",
    modelId,
    instructions,
    capabilities,
    memory,
    inputSchema: common.inputSchema,
    outputSchema: common.outputSchema,
  };
  return ProcessDefinitionSchema.parse({
    ...common,
    limits: { ...common.limits, maxModelCalls },
    kind: "workflow",
    entry: "first",
    steps: [
      {
        ...agent,
        id: "first",
        input: { name: { source: "input", path: ["name"] } },
        next: "second",
      },
      {
        ...agent,
        id: "second",
        input: { name: { source: "step", stepId: "first", path: ["result"] } },
        next: "done",
      },
      {
        id: "done",
        type: "return",
        output: {
          result: { source: "step", stepId: "second", path: ["result"] },
        },
      },
    ],
  });
}

test("real native process and generic discovery use one pinned Dataset with domain receipts and separate ledgers", () =>
  setup(async (x) => {
    const before = processDigest(
      x.h.catalog.inventory(admin.organizationId, admin.workspaceId, admin),
    );
    const report = await x.run([x.read]);
    assert.equal(
      report.status,
      "passed",
      JSON.stringify(report.observations, null, 2),
    );
    assert.equal(report.qualification, "native_scripted");
    assert.equal(report.activationEligible, false);
    assert.notEqual(report.experiments.configured, report.experiments.generic);
    assert.equal(report.comparison.configuredModelCalls, 2);
    assert.equal(report.comparison.genericModelCalls, 3);
    assert.equal(report.stamp.artifactDigest, x.artifact.digest);
    assert.equal(report.stamp.catalogDigest, processDigest(x.catalog));
    for (const o of report.observations) {
      assert.equal(o.businessDispatches, 1);
      assert.equal(o.budget.unknownCalls, 0);
      assert.equal(o.budget.accountedTokens, o.modelCalls * 15);
    }
    assert.equal(x.h.registry.get(admin, x.draft.id).activeVersion, null);
    assert.equal(
      x.h.registry.version(admin, x.draft.id, 1).testStatus,
      "untested",
    );
    assert.equal(
      x.h.db
        .prepare("SELECT COUNT(*) AS n FROM agent_service_invocation")
        .get()!.n,
      0,
    );
    assert.equal(
      x.h.db.prepare("SELECT COUNT(*) AS n FROM agent_inference_run").get()!.n,
      0,
    );
    assert.equal(
      processDigest(
        x.h.catalog.inventory(admin.organizationId, admin.workspaceId, admin),
      ),
      before,
    );
  }));

test("safe descriptor projection never calls any credential-capable getter or copies endpoints", () =>
  setup(async (x) => {
    x.h.catalog.provider = () => {
      throw Error("TEST credential getter called");
    };
    x.h.catalog.credential = () => {
      throw Error("TEST credential getter called");
    };
    x.h.catalog.model = () => {
      throw Error("TEST credential getter called");
    };
    x.h.catalog.inventory = () => {
      throw Error("TEST credential getter called");
    };
    const safe = x.h.catalog.processTestCatalog(
      admin.organizationId,
      admin.workspaceId,
      admin,
      x.artifact.sources,
      x.modelId,
    );
    assert.deepEqual(safe, x.catalog);
    assert(!JSON.stringify(safe).includes("https://"));
    assert(!JSON.stringify(safe).includes("TEST-key"));
    const report = await runProcessNativeComparison(
      x.artifact,
      safe,
      NativeTestSuiteSchema.parse({
        genericModelId: x.modelId,
        cases: [x.read],
      }),
      signal(),
      async () => {},
    );
    assert.equal(report.status, "passed");
  }));

test("missing input performs no Agent inference or business dispatch in either strategy", () =>
  setup(async (x) => {
    const c = NativeTestSuiteSchema.parse({
      genericModelId: x.modelId,
      cases: [
        {
          ...x.read,
          id: "missing",
          scenario: "missing_input",
          input: {},
          actions: [],
          models: { configured: [], generic: [] },
          expected: {
            outcome: "input_invalid",
            codes: {
              configured: "process_input_invalid",
              generic: "process_input_invalid",
            },
            receipts: [],
          },
        },
      ],
    }).cases[0]!;
    const report = await x.run([c]);
    assert.equal(report.status, "passed", JSON.stringify(report));
    for (const o of report.observations) {
      assert.equal(o.modelCalls, 0);
      assert.equal(o.businessDispatches, 0);
    }
  }));

test("completed store reopen reads the same result without model or action replay", () =>
  setup(async (x) => {
    const report = await x.run([
      { ...x.read, id: "replay", scenario: "restart", reopenAt: "completed" },
    ]);
    assert.equal(
      report.status,
      "passed",
      JSON.stringify(report.observations, null, 2),
    );
    for (const o of report.observations) {
      assert.equal(o.reopened, true);
      assert.equal(o.businessDispatches, 1);
    }
  }));

test("native approval, rejection and unknown writes retain real receipts without duplicate dispatch", () =>
  setup(async (x) => {
    const report = await x.run([
      writeCase(x),
      writeCase(x, "reject"),
      writeCase(x, "approve", "unknown"),
    ]);
    assert.equal(
      report.status,
      "passed",
      JSON.stringify(report.observations, null, 2),
    );
    for (const o of report.observations) {
      assert.equal(o.approvals, 1);
      assert.equal(o.businessDispatches, o.scenario === "rejection" ? 0 : 1);
    }
  }));

test("actual suspended native Agent and generic approval survive detached store reopen", () =>
  setup(async (x) => {
    const report = await x.run([
      {
        ...writeCase(x),
        id: "suspended",
        scenario: "restart",
        reopenAt: "suspended",
      },
    ]);
    assert.equal(
      report.status,
      "passed",
      JSON.stringify(report.observations, null, 2),
    );
    for (const o of report.observations) {
      assert.equal(o.reopened, true);
      assert.equal(o.approvals, 1);
      assert.equal(o.businessDispatches, 1);
    }
  }));

test("domain service rejection is distinct from infrastructure failure", () =>
  setup(async (x) => {
    const { output: _output, ...receipt } = x.read.expected.receipts[0]!;
    const report = await x.run([
      {
        ...x.read,
        id: "failure",
        scenario: "failure",
        actions: [{ ...x.read.actions[0]!, outcome: "failure" }],
        models: {
          configured: [x.read.models.configured[0]!],
          generic: x.read.models.generic,
        },
        expected: {
          outcome: "failed",
          codes: {
            configured: "integration_provider_failed",
            generic: "integration_provider_failed",
          },
          receipts: [
            {
              ...receipt,
              status: "failed",
              code: "integration_provider_failed",
            },
          ],
        },
      },
    ]);
    assert.equal(
      report.status,
      "passed",
      JSON.stringify(report.observations, null, 2),
    );
  }));

test("scripted success cannot hide missing, extra or conflicting real business evidence", () =>
  setup(async (x) => {
    const wrong = {
      ...x.read,
      id: "wrong",
      actions: [{ ...x.read.actions[0]!, input: { name: "TEST-wrong" } }],
    };
    const missing = { ...x.read, id: "missing_fixture", actions: [] };
    const unconsumed = {
      ...x.read,
      id: "unconsumed",
      actions: [...x.read.actions, x.read.actions[0]!],
    };
    const noCall = {
      ...x.read,
      id: "no_call",
      models: {
        configured: [
          x.text({ result: "TEST-result" }),
        ] as NativeTestCase["models"]["configured"],
        generic: [
          x.text({ result: "TEST-result" }),
        ] as NativeTestCase["models"]["generic"],
      },
    };
    const report = await x.run([wrong, missing, unconsumed, noCall]);
    assert.equal(report.status, "failed");
    for (const o of report.observations) {
      assert.equal(o.passed, false);
      assert(
        o.assertions.some((a) =>
          [
            "infrastructure_failure",
            "action_fixtures_unconsumed",
            "receipt_ledger_mismatch",
          ].includes(a),
        ),
        JSON.stringify(o),
      );
    }
  }));

test("declared approval must be exercised; a direct read cannot impersonate a confirmed action", () =>
  setup(async (x) => {
    const report = await x.run([
      {
        ...x.read,
        id: "fake_approval",
        actions: [{ ...x.read.actions[0]!, decision: "approve" }],
      },
    ]);
    assert.equal(report.status, "failed");
    for (const o of report.observations) {
      assert.equal(o.passed, false);
      assert.equal(o.approvals, 0);
      assert.equal(o.businessDispatches, 0);
      assert(
        o.infrastructureCodes.includes("native_test_approval_not_exercised"),
      );
      assert(o.assertions.includes("approval_ledger_mismatch"));
    }
  }));

test("successful write receipt remains succeeded when derived model output is invalid", () =>
  setup(async (x) => {
    const c = writeCase(x);
    c.id = "invalid_output";
    c.scenario = "failure";
    c.models.configured[1] = {
      ...c.models.configured[1]!,
      reply: { type: "text", text: "NIARO TEST invalid JSON" },
    };
    c.models.generic[2] = {
      ...c.models.generic[2]!,
      reply: { type: "text", text: "NIARO TEST invalid JSON" },
    };
    c.expected = {
      outcome: "failed",
      codes: {
        configured: "process_output_invalid",
        generic: "process_output_invalid",
      },
      receipts: c.expected.receipts,
    };
    const report = await x.run([c]);
    assert.equal(
      report.status,
      "passed",
      JSON.stringify(report.observations, null, 2),
    );
    for (const o of report.observations) {
      assert.equal(o.receipts[0]!.status, "succeeded");
      assert.equal(o.businessDispatches, 1);
      assert.equal(o.observed, "failed");
    }
  }));

test("missing model fixtures cannot qualify even a specifically expected failed case", () =>
  setup(async (x) => {
    const c = {
      ...x.read,
      id: "missing_model",
      scenario: "failure" as const,
      actions: [],
      models: { configured: [], generic: [] },
      expected: {
        outcome: "failed" as const,
        codes: {
          configured: "native_test_runner_failed",
          generic: "native_test_runner_failed",
        },
        receipts: [],
      },
    };
    const report = await x.run([c]);
    assert.equal(report.status, "failed");
    for (const o of report.observations) {
      assert(o.assertions.includes("infrastructure_failure"));
      assert(o.infrastructureCodes.includes("native_test_model_missing"));
      assert.equal(o.modelCalls, 0);
    }
  }));

test("report schemas reject forged pass counts, scenario relabels and activation claims", () =>
  setup(async (x) => {
    const report = await x.run([x.read]);
    assert.equal(
      NativeTestReportSchema.safeParse({ ...report, activationEligible: true })
        .success,
      false,
    );
    assert.equal(
      NativeTestReportSchema.safeParse({
        ...report,
        comparison: { ...report.comparison, genericPassed: 0 },
      }).success,
      false,
    );
    assert.equal(
      NativeTestReportSchema.safeParse({
        ...report,
        observations: report.observations.map((o) => ({ ...o, passed: false })),
      }).success,
      false,
    );
    assert.equal(
      NativeTestSuiteSchema.safeParse({
        genericModelId: x.modelId,
        cases: [{ ...x.read, scenario: "unknown" }],
      }).success,
      false,
    );
  }));

test("a suspended question with matching JSON cannot qualify as terminal success", () =>
  setup(async (x) => {
    // Unresolved native suspension is an incomplete experiment, never a terminal result.
    await assert.rejects(
      x.run([
        {
          ...x.read,
          id: "suspended_question",
          actions: [],
          models: {
            configured: [x.text({ result: "TEST-result" })],
            generic: [
              x.tool(
                "ask_user",
                { question: '{"result":"TEST-result"}' },
                "TEST-question",
              ),
            ],
          },
          expected: {
            outcome: "succeeded",
            output: { result: "TEST-result" },
            receipts: [],
          },
        },
      ]),
      /native_test_question_fixture_conflict/,
    );
  }));

test("generic native budget failure keeps its actual cause instead of masquerading as invalid output", () =>
  setup(async (x) => {
    const c: NativeTestCase = {
      ...x.read,
      id: "terminal_budget",
      scenario: "failure",
      actions: [],
      models: {
        configured: [x.text({ result: 42 })],
        generic: Array.from({ length: 12 }, (_, i) =>
          x.tool(
            "find_actions",
            { service: "TEST service", need: "TEST read" },
            `TEST-limit-${i}`,
          ),
        ),
      },
      expected: {
        outcome: "failed",
        codes: {
          configured: "process_output_invalid",
          generic: "process_output_invalid",
        },
        receipts: [],
      },
    };
    const report = await x.run([c]);
    assert.equal(report.status, "failed");
    const generic = report.observations.find((o) => o.strategy === "generic")!;
    assert.equal(generic.code, "native_budget");
    assert(generic.assertions.includes("failure_code_mismatch"));
    assert.equal(generic.modelCalls, 12);
    assert.equal(generic.businessDispatches, 0);
    assert.equal(report.executionSettings.nativeAgentMaxStepsPerInvocation, 12);
    assert.equal(report.executionSettings.declaredLimits.maxDurationMs, 600000);
    assert.equal(
      report.executionSettings.effectiveBudgetLimits.maxDurationMs,
      30000,
    );
  }));

test("source drift, artifact tampering and unrelated catalog resources reject before authority or dispatch", () =>
  setup(async (x) => {
    let checks = 0;
    const invoke = (artifact = x.artifact, catalog = x.catalog) =>
      runProcessNativeComparison(
        artifact,
        catalog,
        { genericModelId: x.modelId, cases: [x.read] },
        signal(),
        async () => {
          checks++;
        },
      );
    await assert.rejects(
      invoke({ ...x.artifact, digest: "0".repeat(64) }),
      /native_test_artifact_conflict/,
    );
    const drift = structuredClone(x.catalog);
    drift.services[0]!.revision++;
    await assert.rejects(
      invoke(x.artifact, drift),
      /native_test_sources_conflict/,
    );
    const extra = structuredClone(x.catalog);
    extra.services.push({
      ...extra.services[0]!,
      id: "TEST-unrelated",
      actions: [],
    });
    await assert.rejects(
      invoke(x.artifact, extra),
      /native_test_sources_conflict/,
    );
    assert.equal(checks, 0);
  }));

test("authority revocation or cancellation during a run prevents publication and is sticky", () =>
  setup(async (x) => {
    for (const code of ["identity_forbidden", "process_sources_changed"]) {
      let checks = 0;
      const revoked = new IdentityError(403, code);
      await assert.rejects(
        x.run([x.read], async () => {
          // One failed freshness check retires the whole experiment, even if a later callback would allow it.
          if (++checks === 8) throw revoked;
        }),
        (error) => error === revoked,
      );
      assert.equal(checks, 8);
    }
    const aborted = new AbortController();
    const reason = new Error("TEST canceled experiment");
    let checks = 0;
    await assert.rejects(
      x.run(
        [x.read],
        async () => {
          if (++checks === 8) aborted.abort(reason);
        },
        aborted.signal,
      ),
      (error) => error === reason,
    );
    assert.equal(checks, 8);
    assert.equal(
      x.h.db
        .prepare("SELECT COUNT(*) AS n FROM agent_service_invocation")
        .get()!.n,
      0,
    );
  }));

test("native workflow agents share a root model-call cap and generic baseline uses the same cap", () =>
  setup(async (x) => {
    const c: NativeTestCase = {
      ...x.read,
      id: "shared_cap",
      scenario: "failure",
      actions: x.read.actions,
      models: {
        configured: [
          x.read.models.configured[0]!,
          x.text({ result: "TEST-first" }),
        ],
        generic: x.read.models.generic.slice(0, 2),
      },
      expected: {
        outcome: "failed",
        codes: {
          configured: "catalog_budget_exhausted",
          generic: "catalog_budget_exhausted",
        },
        receipts: x.read.expected.receipts,
      },
    };
    const { artifact, catalog } = freezeDefinition(x, twoAgentDefinition(x, 2));
    const report = await runProcessNativeComparison(
      artifact,
      catalog,
      { genericModelId: x.modelId, cases: [c] },
      signal(),
      async () => {},
    );
    assert.equal(
      report.status,
      "passed",
      JSON.stringify(report.observations, null, 2),
    );
    for (const o of report.observations) {
      assert.equal(o.modelCalls, 2);
      assert.equal(o.budget.accountedTokens, 30);
      assert.equal(o.businessDispatches, 1);
      assert.equal(o.budget.unknownCalls, 0);
    }
    assert.equal(
      report.executionSettings.effectiveBudgetLimits.maxModelCalls,
      2,
    );
  }));

test("workspace token and cost policies narrow both strategies and are stamped as effective caps", () =>
  setup(async (x) => {
    const catalog = structuredClone(x.catalog);
    catalog.budget.maxTokens = 1;
    catalog.budget.maxCostMicros = 1;
    const c: NativeTestCase = {
      ...x.read,
      id: "policy_cap",
      scenario: "failure",
      actions: [],
      models: { configured: [], generic: [] },
      expected: {
        outcome: "failed",
        codes: {
          configured: "catalog_budget_exhausted",
          generic: "catalog_budget_exhausted",
        },
        receipts: [],
      },
    };
    const report = await runProcessNativeComparison(
      x.artifact,
      catalog,
      { genericModelId: x.modelId, cases: [c] },
      signal(),
      async () => {},
    );
    assert.equal(
      report.status,
      "passed",
      JSON.stringify(report.observations, null, 2),
    );
    assert.equal(report.executionSettings.effectiveBudgetLimits.maxTokens, 1);
    assert.equal(
      report.executionSettings.effectiveBudgetLimits.maxCostMicros,
      1,
    );
    assert(report.executionSettings.declaredLimits.maxTokens > 1);
    for (const o of report.observations) {
      assert.equal(o.modelCalls, 0);
      assert.equal(o.businessDispatches, 0);
      assert.equal(o.budget.accountedTokens, 0);
    }
  }));

test("MCP control traffic and real tool arguments produce exactly one business receipt per strategy", () =>
  setup(async (x) => {
    const serviceId = x.h.catalog.command(
      CatalogCommand.parse({
        organizationId: admin.organizationId,
        workspaceId: admin.workspaceId,
        type: "saveService",
        revision: 0,
        settings: {
          name: "TEST MCP",
          protocol: "mcp",
          url: "https://mcp.example.test",
          icon: "plug",
          auth: { type: "none" },
          enabled: true,
        },
      }),
    );
    const {
      id: _id,
      revision: _revision,
      sourceKey: _sourceKey,
      ...settings
    } = x.h.catalog
      .service(admin.workspaceId, x.h.ids.serviceId)
      .actions.find((a) => a.id === x.h.ids.readId)!;
    const actionId = x.h.catalog.command(
      CatalogCommand.parse({
        organizationId: admin.organizationId,
        workspaceId: admin.workspaceId,
        type: "saveAction",
        serviceId,
        serviceRevision: 1,
        revision: 0,
        settings: { ...settings, binding: { type: "mcp", name: "TEST-read" } },
      }),
    );
    assert(x.artifact.definition.kind === "agent");
    const definition = ProcessDefinitionSchema.parse({
      ...x.artifact.definition,
      capabilities: [{ serviceId, actionId }],
    });
    const { artifact, catalog } = freezeDefinition(x, definition);
    const current = catalog.services.find((s) => s.id === serviceId)!;
    const c = structuredClone(x.read);
    c.id = "mcp_read";
    c.actions[0] = { ...c.actions[0]!, serviceId, actionId };
    c.models.configured[0] = x.tool(
      "action_process_0",
      { name: "TEST-input" },
      "TEST-MCP-configured",
    );
    c.models.generic[0] = x.tool(
      "find_actions",
      { service: "TEST MCP", need: "TEST read" },
      "TEST-MCP-find",
    );
    c.models.generic[1] = x.tool(
      x.actionName(actionId),
      { name: "TEST-input" },
      "TEST-MCP-generic",
    );
    c.expected.receipts[0] = {
      ...c.expected.receipts[0]!,
      serviceId,
      actionId,
      serviceRevision: current.revision,
      actionRevision: current.actions.find((a) => a.id === actionId)!.revision,
      output: {
        content: [
          { type: "text", text: JSON.stringify({ value: "TEST-result" }) },
        ],
      },
    };
    const report = await runProcessNativeComparison(
      artifact,
      catalog,
      { genericModelId: x.modelId, cases: [c] },
      signal(),
      async () => {},
    );
    assert.equal(
      report.status,
      "passed",
      JSON.stringify(report.observations, null, 2),
    );
    for (const o of report.observations) {
      assert.equal(o.businessDispatches, 1);
      assert.equal(o.receipts.length, 1);
      assert.equal(o.receipts[0]!.dispatches, 1);
    }
  }));
