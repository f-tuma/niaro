import { StatusBadge } from "./components/console/status";
import type { LoopsCopy } from "./loops-copy";

/** Visible evidence qualifiers for persisted loop states. */
export function LoopEvidenceBadges({
  statusEvidence,
  unconfirmedFailure,
  failedSteps,
  copy,
}: {
  statusEvidence?: "last_saved_unverified";
  unconfirmedFailure?: true;
  failedSteps?: true;
  copy: LoopsCopy;
}) {
  return (
    <>
      {statusEvidence && (
        <StatusBadge tone="warning">{copy.runningUnverified}</StatusBadge>
      )}
      {unconfirmedFailure && (
        <StatusBadge tone="warning">{copy.unconfirmedOutcome}</StatusBadge>
      )}
      {/* Muted: the run delivered its reply; the failed steps are in its detail. */}
      {failedSteps && (
        <StatusBadge tone="neutral">{copy.failedSteps}</StatusBadge>
      )}
    </>
  );
}
