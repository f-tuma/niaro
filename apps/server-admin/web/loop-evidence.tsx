import { StatusBadge } from "./components/console/status";
import type { LoopsCopy } from "./loops-copy";

/** Visible evidence qualifiers for persisted loop states. */
export function LoopEvidenceBadges({
  statusEvidence,
  unconfirmedFailure,
  copy,
}: {
  statusEvidence?: "last_saved_unverified";
  unconfirmedFailure?: true;
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
    </>
  );
}
