import {
  PROCESS_RUN_HISTORY_LIMIT,
  selectRecentProcessRuns,
} from "../packages/client-core/process-run-history";
import type { WorkItem } from "../packages/protocol";

function run(id: number, startedAt: string): WorkItem {
  return {
    id: `run-${id}`,
    revision: 1,
    conversationId: `conversation-${id}`,
    title: `Run ${id}`,
    context: "",
    status: "succeeded",
    inputRequestIds: [],
    actionProposalIds: [],
    operationIds: [],
    demo: false,
    native: {
      runId: `run-${id}`,
      revision: 1,
      process: {
        kind: "service-process-1",
        startedAt,
        provenance: {
          runId: `run-${id}`,
          processId: `process-${id}`,
          version: 1,
          artifactDigest: "a".repeat(64),
          actorId: "user-1",
        },
        status: "succeeded",
        journalStatus: "succeeded",
        detailsAvailable: true,
        receipts: [],
      },
    },
    presentation: { type: "workflow.progress", version: 1, variant: "default" },
  };
}

function waitingRun(id: number, status: "waiting_input" | "waiting_approval") {
  const item = run(id, new Date(Date.UTC(2026, 0, id + 1)).toISOString());
  item.status = status;
  return item;
}

test("recent process history sorts by server admission time and caps at 50", () => {
  const runs = Array.from({ length: 55 }, (_, id) =>
    run(id, new Date(Date.UTC(2026, 0, id + 1)).toISOString()),
  );
  const humanTask = {
    ...runs[54]!,
    id: "human-task",
    native: undefined,
  };

  const selected = selectRecentProcessRuns([humanTask, ...runs]);

  expect(selected).toHaveLength(PROCESS_RUN_HISTORY_LIMIT);
  expect(selected[0]!.id).toBe("run-54");
  expect(selected.at(-1)!.id).toBe("run-5");
  expect(selected.some((item) => item.id === "human-task")).toBe(false);
});

test("runs without the additive start timestamp keep their server ordering", () => {
  const legacyRuns = [1, 2].map((id) => {
    const item = run(id, "2026-01-01T00:00:00.000Z");
    const { startedAt: _startedAt, ...legacyProcess } = item.native!.process!;
    item.native!.process = legacyProcess;
    return item;
  });

  expect(selectRecentProcessRuns(legacyRuns).map((item) => item.id)).toEqual([
    "run-1",
    "run-2",
  ]);
});

test("pending human decisions stay reachable ahead of newer terminal history", () => {
  const oldQuestion = waitingRun(1, "waiting_input");
  const oldApproval = waitingRun(2, "waiting_approval");
  const newerTerminalRuns = Array.from({ length: 55 }, (_, index) =>
    run(index + 100, new Date(Date.UTC(2026, 1, index + 1)).toISOString()),
  );

  const selected = selectRecentProcessRuns([
    ...newerTerminalRuns,
    oldApproval,
    oldQuestion,
  ]);

  expect(selected).toHaveLength(PROCESS_RUN_HISTORY_LIMIT);
  expect(selected.slice(0, 2).map((item) => item.id)).toEqual([
    "run-2",
    "run-1",
  ]);
  expect(selected.some((item) => item.id === "run-154")).toBe(true);
  expect(selected.some((item) => item.id === "run-100")).toBe(false);
});

test("the history cap never hides a pending question or approval", () => {
  const pending = Array.from({ length: 55 }, (_, index) =>
    waitingRun(index + 1, index % 2 ? "waiting_approval" : "waiting_input"),
  );
  const terminal = run(100, "2026-03-01T00:00:00.000Z");

  const selected = selectRecentProcessRuns([terminal, ...pending]);

  expect(selected).toHaveLength(55);
  expect(selected).toEqual(expect.arrayContaining(pending));
  expect(selected.some((item) => item.id === "run-100")).toBe(false);
});
