import type { TranslationKey } from "../i18n";
import type { OpenWork, WorkItem } from "../protocol";

/** A delete or archive the server refused because work still waits in the
 * chat; `openWork` names it (empty from a server that doesn't list it). */
export class ConversationOpenWorkError extends Error {
  constructor(readonly openWork: readonly OpenWork[]) {
    super("conversation_open_work");
  }
}
export const openWorkKindKey = (kind: OpenWork["kind"]): TranslationKey =>
  kind === "question"
    ? "openWorkQuestion"
    : kind === "approval"
      ? "openWorkApproval"
      : kind === "process"
        ? "openWorkProcess"
        : "openWorkTask";
/** What a failed `ClientSession.cancelWork` tells the person. */
export function workCancelError(error: unknown): TranslationKey {
  const code = error instanceof Error ? error.message : "";
  return code === "work_busy"
    ? "workCancelBusy"
    : code === "work_changed"
      ? "workCancelChanged"
      : "workCancelFailed";
}

/** What a failed rename, archive, restore or delete of a chat tells the
 * person (codes from `ClientSession`'s chat directory commands). */
export function chatChangeError(error: unknown): TranslationKey {
  const code = error instanceof Error ? error.message : "";
  return code === "conversation_busy"
    ? "chatBusy"
    : code === "conversation_open_work"
      ? "chatOpenWork"
      : code === "conversation_command_unsupported"
        ? "chatArchiveUpdateRequired"
        : "chatChangeFailed";
}

/**
 * Native or process work the person can stop with `ClientSession.cancelWork`:
 * a question, an approval, a run waiting for the server or one that stopped
 * mid-way. Not a run that ended with an unconfirmed write (nothing is left
 * to cancel), not a process run still executing, and not fixture tasks or
 * human tasks, which keep their own decline/remove.
 */
export function isCancellableWork(work: WorkItem) {
  if (!work.native || work.demo) return false;
  const process = work.native.process;
  if (process)
    return (
      process.journalStatus === "waiting" ||
      (process.journalStatus === "running" && process.status === "interrupted")
    );
  return (
    ["waiting_input", "waiting_approval", "waiting_system"].includes(
      work.status,
    ) &&
    !(
      work.status === "waiting_system" &&
      work.native.action?.status === "unknown"
    )
  );
}
