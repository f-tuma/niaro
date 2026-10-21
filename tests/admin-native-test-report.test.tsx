import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeTestReportView } from "../apps/server-admin/web/process-test-report";
import { testEn, testCs } from "../apps/server-admin/web/process-test-copy";
import {
  PROCESS_NATIVE_TEST_PROFILE,
  NativeTestJobSchema,
  NativeTestDiagnosticSchema,
  NativeTestReportSchema,
  type NativeTestDiagnostic,
} from "../packages/protocol/process-native-testing";

// Admin primitives render to DOM. These lightweight hosts keep this test focused
// on report semantics; actual Radix layout and disclosure are covered by browser QA.
jest.mock(
  "@admin/components/ui/card",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children);
    return {
      Card: host,
      CardHeader: host,
      CardTitle: host,
      CardDescription: host,
      CardContent: host,
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/alert",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children);
    return { Alert: host, AlertTitle: host, AlertDescription: host };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/console/status",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const pill = ({ children }: { children: React.ReactNode }) =>
      React.createElement("span", null, children);
    return { StatusBadge: pill, StatusDot: pill };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/table",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = (tag: string) => {
      const Host = ({ children }: { children?: React.ReactNode }) =>
        React.createElement(tag, null, children);
      Host.displayName = tag;
      return Host;
    };
    return {
      Table: host("table"),
      TableHeader: host("thead"),
      TableBody: host("tbody"),
      TableRow: host("tr"),
      TableHead: host("th"),
      TableCell: host("td"),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/console/page",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      Section: ({
        title,
        children,
      }: {
        title: string;
        children: React.ReactNode;
      }) =>
        React.createElement(
          "section",
          null,
          React.createElement("h2", null, title),
          children,
        ),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/console/forms",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      DetailList: ({
        items,
      }: {
        items: { label: string; value: React.ReactNode }[];
      }) =>
        React.createElement(
          "dl",
          null,
          items.map(({ label, value }) =>
            React.createElement(
              React.Fragment,
              { key: label },
              React.createElement("dt", null, label),
              React.createElement("dd", null, value),
            ),
          ),
        ),
    };
  },
  { virtual: true },
);
jest.mock("../apps/server-admin/web/process-design-review", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    Disclosure: ({
      title,
      children,
    }: {
      title: string;
      children: React.ReactNode;
    }) =>
      React.createElement(
        "details",
        null,
        React.createElement("summary", null, title),
        children,
      ),
    JsonDetail: ({ value }: { value: unknown }) =>
      React.createElement("pre", null, JSON.stringify(value)),
  };
});

const stamp = {
  artifactDigest: "a".repeat(64),
  sourcesDigest: "b".repeat(64),
  suiteDigest: "c".repeat(64),
  catalogDigest: "d".repeat(64),
  compilerVersion: "TEST-compiler",
  runtimeVersion: "TEST-runtime",
  runnerVersion: "TEST-runner",
};
const job = NativeTestJobSchema.parse({
  profile: PROCESS_NATIVE_TEST_PROFILE,
  organizationId: "TEST-org",
  workspaceId: "TEST-workspace",
  processId: "TEST-process",
  requestId: "TEST-request",
  testId: "TEST-test",
  version: 1,
  stamp,
  status: "interrupted",
  report: null,
  failure: "test_runner_failed",
  createdAt: "2026-10-07T12:00:00.000Z",
  updatedAt: "2026-10-07T12:00:01.000Z",
});
function diagnostic(
  code: NativeTestDiagnostic["code"] = "native_test_approval_unexpected",
) {
  return NativeTestDiagnosticSchema.parse({
    category: "native_checkpoint",
    phase: "native_boundary",
    code,
    secondaryCodes: [],
    evidence: {
      caseId: "TEST_case",
      scenario: "success",
      strategy: "configured",
      runId: "TEST-run",
      checkpoint: { status: "waiting", pending: "approval" },
      modelCalls: 1,
      businessDispatches: 0,
      approvals: 0,
      receipts: [
        {
          serviceId: "TEST-service",
          actionId: "TEST-action",
          serviceRevision: 1,
          actionRevision: 1,
          effect: "write",
          status: "awaiting_approval",
          dispatches: 0,
        },
      ],
    },
  });
}
function render(
  language: "en" | "cs",
  value = job,
  detail: NativeTestDiagnostic | null = null,
) {
  const markup = renderToStaticMarkup(
    <NativeTestReportView
      job={value}
      diagnostic={detail}
      language={language}
    />,
  );
  return {
    markup,
    visible: markup.replace(/<details[\s\S]*?<\/details>/g, ""),
  };
}

test.each(["en", "cs"] as const)(
  "%s interruption explains cause, pending approval and zero dispatches without qualifying or exposing codes",
  (language) => {
    const copy = language === "cs" ? testCs : testEn;
    const { markup, visible } = render(language, job, diagnostic());
    expect(visible).toContain(copy.incomplete);
    expect(visible).toContain(copy.unqualified);
    expect(visible).not.toContain(copy.historical);
    expect(visible).toContain(copy.diagnostic_native_checkpoint);
    expect(visible).toContain(copy.native_test_approval_unexpected);
    expect(visible).toContain(copy.diagnosticApprovalAction);
    expect(visible).toContain(copy.pending_approval);
    expect(visible).toContain(`<dt>${copy.id}</dt><dd>TEST_case</dd>`);
    expect(visible).toContain(
      `<dt>${copy.strategy}</dt><dd>${copy.configured}</dd>`,
    );
    expect(visible).not.toContain(`<dt>${copy.model}</dt>`);
    expect(visible).toContain(`<dt>${copy.dispatches}</dt><dd>0</dd>`);
    expect(visible).toContain(copy.awaiting_approval);
    expect(visible).not.toContain("native_test_approval_unexpected");
    expect(visible).not.toContain("native_boundary");
    expect(visible).not.toContain("TEST-action");
    expect(markup).toContain("native_test_approval_unexpected");
    expect(markup).toContain("native_boundary");
    expect(visible).not.toMatch(/<button|activationEligible|canActivate/);
  },
);

test.each(["en", "cs"] as const)(
  "%s later unanswered question retains a succeeded write receipt and actual counters",
  (language) => {
    const copy = language === "cs" ? testCs : testEn,
      detail = diagnostic("native_test_question_fixture_conflict");
    detail.evidence!.checkpoint = { status: "waiting", pending: "question" };
    detail.evidence!.modelCalls = 3;
    detail.evidence!.businessDispatches = 1;
    detail.evidence!.approvals = 1;
    detail.evidence!.receipts![0]!.status = "succeeded";
    detail.evidence!.receipts![0]!.dispatches = 1;
    const { visible } = render(language, job, detail);
    expect(visible).toContain(copy.native_test_question_fixture_conflict);
    expect(visible).toContain(copy.diagnosticQuestionAction);
    expect(visible).toContain(copy.pending_question);
    expect(visible).toContain(copy.succeeded);
    expect(visible).toContain(`<dt>${copy.calls}</dt><dd>3</dd>`);
    expect(visible).toContain(`<dt>${copy.dispatches}</dt><dd>1</dd>`);
    expect(visible).not.toContain(copy.awaiting_approval);
  },
);

test.each(["en", "cs"] as const)(
  "%s partial unknown evidence keeps its uncertainty and recorded dispatch instead of inventing success",
  (language) => {
    const copy = language === "cs" ? testCs : testEn;
    const detail = diagnostic("native_test_process_nonterminal");
    detail.evidence!.checkpoint = { status: "unknown" };
    detail.evidence!.businessDispatches = 1;
    detail.evidence!.receipts![0]!.status = "unknown";
    detail.evidence!.receipts![0]!.dispatches = 1;
    delete detail.evidence!.approvals;
    const { visible } = render(language, job, detail);
    expect(visible).toContain(copy.native_test_process_nonterminal);
    expect(visible).toContain(copy.checkpoint_unknown);
    expect(visible).toContain(copy.unknown);
    expect(visible).toContain(`<dt>${copy.dispatches}</dt><dd>1</dd>`);
    expect(visible).toContain(copy.incomplete);
    expect(visible).not.toContain(copy.succeeded);
    expect(visible).not.toContain(copy.approvals);
  },
);

test.each(["en", "cs"] as const)(
  "%s absent partial evidence stays absent and old incomplete jobs never become historical",
  (language) => {
    const copy = language === "cs" ? testCs : testEn;
    const detail = diagnostic();
    delete detail.evidence;
    const { visible } = render(language, job, detail);
    expect(visible).not.toContain(copy.calls);
    expect(visible).not.toContain(copy.dispatches);
    expect(visible).not.toContain(copy.partialEvidence);
    const sparse = diagnostic();
    delete sparse.evidence!.modelCalls;
    delete sparse.evidence!.approvals;
    delete sparse.evidence!.businessDispatches;
    delete sparse.evidence!.receipts;
    const partial = render(language, job, sparse).visible;
    expect(partial).toContain(copy.pending_approval);
    expect(partial).not.toContain(copy.calls);
    expect(partial).not.toContain(copy.dispatches);
    expect(partial).not.toContain(copy.approvals);
    const legacy = render(language).visible;
    expect(legacy).toContain(copy.test_runner_failed);
    expect(legacy).toContain(copy.incomplete);
    expect(legacy).not.toContain(copy.historical);
  },
);

test.each(["en", "cs"] as const)(
  "%s infrastructure and persistence failures provide localized causes and recovery guidance",
  (language) => {
    const copy = language === "cs" ? testCs : testEn;
    for (const [code, category, phase, remedy] of [
      [
        "native_test_cleanup_failed",
        "infrastructure",
        "cleanup",
        copy.diagnosticRunnerAction,
      ],
      [
        "native_test_result_persistence_failed",
        "persistence",
        "result_persistence",
        copy.diagnosticPersistenceAction,
      ],
    ] as const) {
      const detail = NativeTestDiagnosticSchema.parse({
        code,
        category,
        phase,
        secondaryCodes: [],
      });
      const { visible } = render(language, job, detail);
      expect(visible).toContain(copy[`diagnostic_${category}`]);
      expect(visible).toContain(copy[code]);
      expect(visible).toContain(remedy);
      expect(visible).not.toContain(copy.calls);
    }
  },
);

test.each(["en", "cs"] as const)(
  "%s completed expected unknown and failed domain observations remain terminal reports",
  (language) => {
    const copy = language === "cs" ? testCs : testEn;
    for (const outcome of [
      "unknown",
      "failed",
      "input_invalid",
      "rejected",
    ] as const) {
      const report = NativeTestReportSchema.parse({
        profile: PROCESS_NATIVE_TEST_PROFILE,
        qualification: "native_scripted",
        agentExecution: "native_agent_scripted_provider",
        adapterMode: "isolated_catalog_receipts",
        activationEligible: false,
        executionSettings: {
          transport: "scripted_only",
          serviceAuth: "synthetic_none",
          savedMemory: "empty_read_only",
          optionalPlugins: "disabled",
          genericDecision: "disabled",
          usage: "scripted_tokens_tariff",
          declaredLimits: {
            maxSteps: 64,
            maxModelCalls: 32,
            maxTokens: 100000,
            maxCostMicros: 10000000,
            maxDurationMs: 600000,
          },
          effectiveBudgetLimits: {
            maxDurationMs: 30000,
            maxTokens: 1000,
            maxCostMicros: 1000,
            maxModelCalls: 4,
          },
          nativeAgentMaxStepsPerInvocation: 4,
          genericSafetyLimits: {
            maxModelCalls: 4,
            maxInference: 4,
            maxActionCalls: 4,
            maxExposed: 4,
          },
        },
        stamp,
        datasetId: "TEST-dataset",
        datasetVersion: 1,
        experiments: { configured: "TEST-configured", generic: "TEST-generic" },
        observations: ["configured", "generic"].map((strategy) => ({
          caseId: "TEST_case",
          scenario:
            outcome === "input_invalid"
              ? "missing_input"
              : outcome === "rejected"
                ? "rejection"
                : outcome === "failed"
                  ? "failure"
                  : "unknown",
          strategy,
          runId: `TEST-${strategy}`,
          observed: outcome,
          code: "TEST_domain_code",
          receipts: [],
          modelCalls: 1,
          businessDispatches: 0,
          approvals: 0,
          reopened: false,
          infrastructureCodes: [],
          budget: {
            accountedTokens: 1,
            accountedCostMicros: 1,
            unknownCalls: 0,
            overrun: false,
          },
          assertions: [],
          passed: true,
        })),
        comparison: {
          cases: 1,
          configuredPassed: 1,
          genericPassed: 1,
          configuredModelCalls: 1,
          genericModelCalls: 1,
        },
        status: "passed",
      });
      const terminal = NativeTestJobSchema.parse({
        ...job,
        status: "completed",
        failure: null,
        report,
      });
      const { visible } = render(language, terminal, diagnostic());
      expect(visible).toContain(copy[outcome]);
      expect(visible).toContain(copy.passed);
      expect(visible).toContain(copy.historical);
      expect(visible).not.toContain(copy.incomplete);
      expect(visible).not.toContain(copy.diagnostic);
      expect(visible).not.toContain(copy.test_runner_failed);
    }
  },
);
