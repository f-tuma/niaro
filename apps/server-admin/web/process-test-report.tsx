import type { ReactNode } from "react";
import type {
  NativeTestJob,
  NativeTestObservation,
  NativeTestDiagnostic,
} from "../../../packages/protocol/process-native-testing";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@admin/components/ui/card";
import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@admin/components/ui/alert";
import { StatusBadge, StatusDot } from "@admin/components/console/status";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@admin/components/ui/table";
import { Section } from "@admin/components/console/page";
import { DetailList } from "@admin/components/console/forms";
import { Disclosure, JsonDetail } from "./process-design-review";
import { testEn, testCs, type TestCopy } from "./process-test-copy";
function Diagnostic({
  diagnostic,
  copy,
}: {
  diagnostic: NativeTestDiagnostic;
  copy: TestCopy;
}) {
  const evidence = diagnostic.evidence;
  const action =
    diagnostic.code === "native_test_approval_unexpected"
      ? copy.diagnosticApprovalAction
      : [
            "native_test_question_fixture_conflict",
            "native_test_question_answer_unconsumed",
            "native_test_generic_question_missing",
          ].includes(diagnostic.code)
        ? copy.diagnosticQuestionAction
        : diagnostic.category === "persistence"
          ? copy.diagnosticPersistenceAction
          : copy.diagnosticRunnerAction;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-native-diagnostic>
      <h3 className="text-sm font-medium">{copy.diagnostic}</h3>
      <Alert variant="destructive">
        <AlertTitle>{copy[`diagnostic_${diagnostic.category}`]}</AlertTitle>
        <AlertDescription>
          <p>{copy[diagnostic.code]}</p>
          <p>{action}</p>
        </AlertDescription>
      </Alert>
      {evidence && (
        <>
          <h4 className="text-sm font-medium">{copy.partialEvidence}</h4>
          <DetailList
            items={[
              { label: copy.id, value: evidence.caseId },
              { label: copy.scenario, value: copy[evidence.scenario] },
              { label: copy.strategy, value: copy[evidence.strategy] },
              ...(evidence.checkpoint
                ? [
                    {
                      label: copy.checkpoint,
                      value: evidence.checkpoint.pending
                        ? copy[`pending_${evidence.checkpoint.pending}`]
                        : copy[`checkpoint_${evidence.checkpoint.status}`],
                    },
                  ]
                : []),
              ...(evidence.modelCalls !== undefined
                ? [{ label: copy.calls, value: evidence.modelCalls }]
                : []),
              ...(evidence.businessDispatches !== undefined
                ? [
                    {
                      label: copy.dispatches,
                      value: evidence.businessDispatches,
                    },
                  ]
                : []),
              ...(evidence.approvals !== undefined
                ? [{ label: copy.approvals, value: evidence.approvals }]
                : []),
            ]}
          />
          {evidence.receipts && evidence.receipts.length > 0 && (
            <div className="flex min-w-0 flex-col gap-3">
              <h4 className="text-sm font-medium">{copy.diagnosticReceipts}</h4>
              <ol className="flex min-w-0 flex-col gap-3">
                {evidence.receipts.map((receipt, index) => (
                  <li key={index} className="flex min-w-0 flex-col gap-2">
                    <h5 className="text-sm font-medium">
                      {index + 1}. {copy[receipt.effect]}
                    </h5>
                    <StatusBadge
                      tone={
                        receipt.status === "succeeded"
                          ? "success"
                          : receipt.status === "failed"
                            ? "danger"
                            : "warning"
                      }
                    >
                      {receipt.status === "running"
                        ? copy.checkpoint_running
                        : copy[receipt.status]}
                    </StatusBadge>
                    <DetailList
                      items={[
                        { label: copy.dispatches, value: receipt.dispatches },
                      ]}
                    />
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </div>
  );
}
function Observation({
  item,
  copy,
}: {
  item: NativeTestObservation;
  copy: TestCopy;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy[item.strategy]}</CardTitle>
        <CardDescription>
          <StatusBadge tone={item.passed ? "success" : "danger"}>
            {item.passed ? copy.passed : copy.mismatch}
          </StatusBadge>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <DetailList
            items={[
              {
                label: copy.observed,
                value: copy[item.observed as keyof TestCopy] ?? item.observed,
              },
              { label: copy.observedCode, value: item.code ?? "—" },
              { label: copy.calls, value: item.modelCalls },
              { label: copy.dispatches, value: item.businessDispatches },
              { label: copy.approvals, value: item.approvals },
              { label: copy.reopen, value: item.reopened ? copy.yes : copy.no },
              {
                label: copy.budget,
                value: `${item.budget.accountedTokens} tokens, ${item.budget.accountedCostMicros} µUSD`,
              },
            ]}
          />
          {item.assertions.length > 0 && (
            <Alert variant="destructive">
              <AlertDescription>{item.assertions.join(", ")}</AlertDescription>
            </Alert>
          )}
          {item.infrastructureCodes.length > 0 && (
            <p className="text-sm">
              {copy.infrastructure}: {item.infrastructureCodes.join(", ")}
            </p>
          )}
          {item.output && (
            <Disclosure title={copy.observedOutput}>
              <JsonDetail value={item.output} />
            </Disclosure>
          )}
          <Disclosure title={`${copy.ledger} (${item.receipts.length})`}>
            <div className="flex flex-col gap-3">
              {item.receipts.map((r, i) => (
                <div key={i}>
                  <h4 className="text-sm font-medium">
                    {i + 1}. {r.serviceId} / {r.actionId}
                  </h4>
                  <p className="text-sm">
                    {copy[r.status]} · {copy[r.effect]} · {r.dispatches}{" "}
                    {copy.dispatches}
                  </p>
                  <JsonDetail value={r} />
                </div>
              ))}
            </div>
          </Disclosure>
          <Disclosure title={copy.details}>
            <JsonDetail
              value={{
                runId: item.runId,
                budget: item.budget,
                infrastructureCodes: item.infrastructureCodes,
              }}
            />
          </Disclosure>
        </div>
      </CardContent>
    </Card>
  );
}
export function NativeTestReportView({
  job,
  diagnostic: candidate = null,
  language,
  actions,
}: {
  job: NativeTestJob;
  diagnostic?: NativeTestDiagnostic | null;
  language: "en" | "cs";
  /** Optional section actions, e.g. reuse of the original scenarios. */
  actions?: ReactNode;
}) {
  const copy = language === "cs" ? testCs : testEn,
    report = job.report,
    q = job.qualification;
  const diagnostic =
    job.status === "interrupted" &&
    job.failure === "test_runner_failed" &&
    !report &&
    !q
      ? candidate
      : null;
  const ids = [...new Set(report?.observations.map((o) => o.caseId) ?? [])];
  return (
    <div className="flex min-w-0 flex-col gap-6" data-native-report>
      <Section title={copy.report} actions={actions}>
        <Card>
          <CardContent>
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge
                  tone={
                    job.status === "running"
                      ? "info"
                      : job.status === "interrupted"
                        ? "warning"
                        : report?.status === "passed"
                          ? "success"
                          : "danger"
                  }
                >
                  {job.status === "running"
                    ? copy.running
                    : job.status === "interrupted"
                      ? copy.interrupted
                      : report?.status === "passed"
                        ? copy.passed
                        : copy.mismatch}
                </StatusBadge>
                {q ? (
                  <StatusBadge
                    tone={q.status === "qualified" ? "success" : "warning"}
                  >
                    {q.status === "qualified"
                      ? copy.qualifiedBadge
                      : copy.unqualifiedBadge}
                  </StatusBadge>
                ) : report ? (
                  <span className="text-sm text-muted-foreground">
                    {copy.historical}
                  </span>
                ) : (
                  <>
                    <StatusBadge tone="warning">
                      {copy.unqualifiedBadge}
                    </StatusBadge>
                    <span className="text-sm text-muted-foreground">
                      {copy.incomplete}
                    </span>
                  </>
                )}
              </div>
              {diagnostic ? (
                <Diagnostic diagnostic={diagnostic} copy={copy} />
              ) : job.failure ? (
                <Alert variant="destructive">
                  <AlertDescription>{copy[job.failure]}</AlertDescription>
                </Alert>
              ) : null}
              {q && (
                <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
                  {q.coverage.map((c) => (
                    <li
                      key={c.scenario}
                      className="flex min-w-0 flex-col gap-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          {copy[c.scenario]}
                        </span>
                        <StatusBadge
                          tone={
                            c.passed
                              ? c.applicable === false
                                ? "neutral"
                                : "success"
                              : "warning"
                          }
                        >
                          {c.passed
                            ? c.applicable === false
                              ? copy.notApplicable
                              : copy.passed
                            : copy.unqualifiedBadge}
                        </StatusBadge>
                      </div>
                      {c.reasons.map((r) => (
                        <p key={r} className="text-sm text-muted-foreground">
                          {copy[r]}
                        </p>
                      ))}
                      {c.caseIds.length > 0 && (
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {c.caseIds.join(", ")}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {report?.comparison.mode === "configured_only" && (
                <p className="text-sm text-muted-foreground">
                  {copy.configuredOnlyHint}
                </p>
              )}
              <Disclosure title={copy.details}>
                <JsonDetail
                  value={{
                    testId: job.testId,
                    requestId: job.requestId,
                    version: job.version,
                    stamp: job.stamp,
                    createdAt: job.createdAt,
                    updatedAt: job.updatedAt,
                    failure: job.failure,
                    diagnostic,
                    qualification: q,
                    comparison: report?.comparison,
                    executionSettings: report?.executionSettings,
                    datasetId: report?.datasetId,
                    datasetVersion: report?.datasetVersion,
                    experiments: report?.experiments,
                  }}
                />
              </Disclosure>
            </div>
          </CardContent>
        </Card>
      </Section>
      {report && report.observations.length > 0 && (
        <Section title={copy.cases} count={ids.length}>
          <div className="flex flex-col gap-2">
            <Card variant="flush">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{copy.id}</TableHead>
                    <TableHead>{copy.strategy}</TableHead>
                    <TableHead className="hidden md:table-cell">
                      {copy.observed}
                    </TableHead>
                    <TableHead>{copy.assertions}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.observations.map((item) => (
                    <TableRow key={`${item.caseId}/${item.strategy}`}>
                      <TableCell>
                        <span className="font-mono text-xs">{item.caseId}</span>
                      </TableCell>
                      <TableCell>{copy[item.strategy]}</TableCell>
                      <TableCell className="hidden md:table-cell">
                        {copy[item.observed as keyof TestCopy] ?? item.observed}
                      </TableCell>
                      <TableCell>
                        <StatusDot tone={item.passed ? "success" : "danger"}>
                          {item.passed ? copy.passed : copy.mismatch}
                        </StatusDot>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
            <Disclosure title={copy.caseDetails}>
              <div className="flex flex-col gap-6">
                {ids.map((id) => {
                  const entries = report.observations.filter(
                    (o) => o.caseId === id,
                  );
                  return (
                    <Section
                      key={id}
                      title={`${id} (${copy[entries[0]!.scenario]})`}
                    >
                      <div className="grid items-start gap-4 xl:grid-cols-2">
                        {entries.map((item) => (
                          <Observation
                            key={item.strategy}
                            item={item}
                            copy={copy}
                          />
                        ))}
                      </div>
                    </Section>
                  );
                })}
              </div>
            </Disclosure>
          </div>
        </Section>
      )}
    </div>
  );
}
