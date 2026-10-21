import type { WorkItem } from "../protocol";

export const PROCESS_RUN_HISTORY_LIMIT = 50;

/** Select recent native process projections without mixing in human work. */
export function selectRecentProcessRuns(
  workItems: Iterable<WorkItem>,
): WorkItem[] {
  const sortRecent = (a: WorkItem, b: WorkItem) => {
      const aStarted = Date.parse(a.native!.process!.startedAt ?? "");
      const bStarted = Date.parse(b.native!.process!.startedAt ?? "");
      const aKnown = Number.isFinite(aStarted);
      const bKnown = Number.isFinite(bStarted);
      if (aKnown && bKnown) return bStarted - aStarted;
      if (aKnown) return -1;
      if (bKnown) return 1;
      // Stable sort preserves server order for legacy projections without a
      // start time; current server projections always carry one.
      return 0;
    };
  const runs = Array.from(workItems).filter((work) => !!work.native?.process);
  // Pending questions and approvals are actionable, so never hide them behind
  // the history cap. The cap applies to terminal/history entries only.
  const waiting = runs
    .filter((work) =>
      work.status === "waiting_input" || work.status === "waiting_approval",
    )
    .sort(sortRecent);
  const recent = runs
    .filter(
      (work) =>
        work.status !== "waiting_input" && work.status !== "waiting_approval",
    )
    .sort(sortRecent);
  return [
    ...waiting,
    ...recent.slice(0, Math.max(0, PROCESS_RUN_HISTORY_LIMIT - waiting.length)),
  ];
}
