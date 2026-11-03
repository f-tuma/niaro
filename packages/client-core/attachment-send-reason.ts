import type { TranslationKey } from "../i18n";
import type { AttachmentEntry } from "./attachments";

/**
 * Why Send waits for the files in the composer, from the attachment
 * runtime's own states: one failed or expired, or one is still being
 * prepared, uploaded or checked (an uncertain upload is checked from its
 * chip). Nothing when they are ready. The phone and the web say the same.
 */
export function attachmentSendReason(
  entries: readonly Pick<AttachmentEntry, "state">[],
  ready: boolean,
): TranslationKey | undefined {
  if (!entries.length || ready) return undefined;
  return entries.some((entry) => ["failed", "expired"].includes(entry.state))
    ? "attachmentFailedSend"
    : "attachmentWait";
}
