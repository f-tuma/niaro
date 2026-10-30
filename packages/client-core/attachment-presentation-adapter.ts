import type { AttachmentEntry, AttachmentRuntime } from "./attachments";
import type {
  AttachmentProcessing,
  AttachmentPublicFile,
} from "../protocol/attachments";
const detail = (file: { mediaType: string; size: number }) => {
  const names: Record<string, string> = {
    "text/plain": "TXT",
    "text/markdown": "MD",
    "text/csv": "CSV",
    "text/tab-separated-values": "TSV",
    "application/pdf": "PDF",
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WebP",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "DOCX",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      "PPTX",
  };
  const unit = file.size < 1024 ? "B" : file.size < 1024 * 1024 ? "KB" : "MB";
  const size =
    file.size / (unit === "B" ? 1 : unit === "KB" ? 1024 : 1024 * 1024);
  return `${names[file.mediaType] ?? file.mediaType} · ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(size)} ${unit}`;
};
export function draftAttachmentViews(
  runtime: AttachmentRuntime,
  entries: readonly AttachmentEntry[],
) {
  const busy = runtime.getSnapshot().busy;
  return entries.map((file) => ({
    id: file.id,
    filename: file.filename,
    detail: detail(file),
    kind: file.mediaType.startsWith("image/")
      ? ("image" as const)
      : ("file" as const),
    transfer:
      file.state === "failed"
        ? {
            state: "failed" as const,
            reason:
              file.error === "attachment_too_large"
                ? ("size" as const)
                : file.error === "attachment_type_unsupported"
                  ? ("type" as const)
                  : file.error === "attachment_integrity"
                    ? ("integrity" as const)
                    : file.error === "attachment_quota"
                      ? ("quota" as const)
                      : ("transfer" as const),
          }
        : { state: file.state },
    remove: {
      onPress: () => {
        void runtime.remove(file.id);
      },
      disabled: busy,
    },
    ...(file.retryable
      ? {
          retry: {
            onPress: () => {
              void runtime.retry(file.id);
            },
            disabled: busy,
          },
        }
      : {}),
  }));
}
export function persistedAttachmentViews(
  files: readonly AttachmentPublicFile[],
  download: (file: AttachmentPublicFile) => void,
) {
  return files.map((file) => ({
    id: file.contentId,
    filename: file.filename,
    detail: detail(file),
    kind: file.mediaType.startsWith("image/")
      ? ("image" as const)
      : ("file" as const),
    availability: file.availability,
    ...(file.availability === "available"
      ? { download: { onPress: () => download(file) } }
      : {}),
  }));
}
export function attachmentInterpretation(processing?: AttachmentProcessing) {
  if (!processing) return;
  const states = {
    blocked_capability: "unavailable",
    queued: "queued",
    preparing: "preparing",
    waiting_retry: "retry_required",
    handoff_started: "processing",
    awaiting_publication: "processing",
    published: "complete",
    failed: "failed",
    unknown: "unknown",
    cancelled: "cancelled",
  } as const;
  return { state: states[processing.state] };
}
export const attachmentRuntimeCopy = (language: "en" | "cs") =>
  language === "cs"
    ? {
        again: "Znovu",
        edit: "Upravit",
        conversion: "Výběr nebo otočení může změnit formát fotky.",
        oneFile: "Vyberte jeden soubor.",
        permission: "Fotoaparát není dostupný. Vyberte soubor.",
        failed: "Soubor se nepodařilo připojit.",
        check: "Ověřit nahrání",
      }
    : {
        again: "Again",
        edit: "Edit",
        conversion: "Selection or rotation may convert the photo format.",
        oneFile: "Choose one file at a time.",
        permission: "Camera unavailable. Choose a file.",
        failed: "Could not attach the file.",
        check: "Check upload",
      };
