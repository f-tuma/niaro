import type { TranslationKey } from "../../../../packages/i18n";
import type { ProcessExecutionEntry } from "../../../../packages/protocol/process-execution";

export type ProcessBlockedReason = Extract<
  ProcessExecutionEntry,
  { availability: "blocked" }
>["reason"];

const blocked: Record<ProcessBlockedReason, TranslationKey> = {
  service_unavailable: "process_service_unavailable",
  model_unavailable: "process_model_unavailable",
  source_changed: "process_source_changed",
  connection_required: "process_connection_required",
  qualification_required: "process_qualification_required",
  budget_unavailable: "process_budget_unavailable",
};

/**
 * Why a process can't run, one message per code wherever it shows: a blocked
 * row on the Processes page or a failed process widget on the overview.
 */
const problems: Readonly<Record<string, TranslationKey>> = {
  ...blocked,
  process_sources_changed: "process_source_changed",
  process_not_active: "process_not_active",
  process_execution_unavailable: "process_execution_unavailable",
};

export function processProblemKey(
  code: string | undefined,
): TranslationKey | undefined {
  return code && Object.hasOwn(problems, code) ? problems[code] : undefined;
}

export function processBlockedKey(reason: ProcessBlockedReason) {
  return blocked[reason];
}

/** The process's services changed since it was tested; it needs a new test. */
export const processSourceChanged = (code: string | undefined) =>
  code === "source_changed" || code === "process_sources_changed";
