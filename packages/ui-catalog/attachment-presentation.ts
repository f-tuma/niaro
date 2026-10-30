/** View props only. The caller owns identity, authorization, I/O and all transitions. */
export type AttachmentLanguage = "en" | "cs";
export type AttachmentAction = { onPress: () => void; disabled?: boolean };
export type AttachmentChoice = "camera" | "photos" | "file" | "task";
export type AttachmentChoices = Partial<
  Record<AttachmentChoice, AttachmentAction>
>;

/** Decoded/validated raster, held only for this view's lifetime. Never an original/storage URL. */
export type AttachmentRaster = {
  uri: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
};
export function rasterUri(raster?: AttachmentRaster): string | undefined {
  if (
    !raster ||
    !["image/jpeg", "image/png", "image/webp"].includes(raster.mediaType)
  )
    return;
  if (/^(blob:|file:\/\/|content:\/\/)/.test(raster.uri)) return raster.uri;
  if (raster.uri.startsWith(`data:${raster.mediaType};base64,`))
    return raster.uri;
}

export type AttachmentTransfer =
  | {
      state:
        | "selected"
        | "preparing"
        | "verifying"
        | "uploaded"
        | "uncertain"
        | "removing"
        | "expired";
    }
  | { state: "uploading"; progress?: number }
  | {
      state: "failed";
      reason?:
        | "transfer"
        | "size"
        | "type"
        | "quota"
        | "permission"
        | "integrity";
    };
export type AttachmentFile = {
  id: string;
  filename: string;
  /** Human-readable metadata from the caller, e.g. PDF · 1.2 MB. */
  detail: string;
  kind: "image" | "file";
  thumbnail?: AttachmentRaster;
  preview?: AttachmentAction;
};
export type DraftAttachment = AttachmentFile & {
  transfer: AttachmentTransfer;
  remove?: AttachmentAction;
  retry?: AttachmentAction;
};
export type PersistedAttachment = AttachmentFile & {
  availability: "available" | "unavailable";
  download?: AttachmentAction;
  downloadState?: "loading" | "failed";
};
/** Message-level interpretation, independent of each file's transfer and original availability. */
export type AttachmentInterpretation = {
  state:
    | "queued"
    | "preparing"
    | "unavailable"
    | "retry_required"
    | "processing"
    | "complete"
    | "failed"
    | "unknown"
    | "cancelled";
  retry?: AttachmentAction;
};
export type AttachmentPreviewProps = {
  language: AttachmentLanguage;
  filename: string;
  raster?: AttachmentRaster;
  rotation: 0 | 90 | 180 | 270;
  loading?: boolean;
  failed?: boolean;
  onImageError?: () => void;
  rotate?: AttachmentAction;
  retake?: AttachmentAction;
  confirm?: AttachmentAction;
};

const en = {
  attachments: "Attachments",
  attach: "Attach",
  camera: "Camera",
  photos: "Photos",
  file: "File",
  task: "Task",
  remove: "Remove",
  retry: "Retry upload",
  preview: "Preview",
  download: "Download",
  close: "Close",
  rotate: "Rotate",
  retake: "Retake",
  confirm: "Use photo",
  previewUnavailable: "Preview unavailable",
  loadingPreview: "Loading preview…",
  selected: "Not uploaded",
  preparing: "Preparing…",
  uploading: "Uploading",
  verifying: "Verifying…",
  uploaded: "Uploaded",
  uncertain: "Upload unconfirmed",
  removing: "Removing…",
  expired: "Selection expired",
  transfer: "Upload failed",
  size: "File too large",
  type: "Unsupported file",
  quota: "Upload limit reached",
  permission: "Access unavailable",
  integrity: "File check failed",
  unavailable: "File unavailable",
  loadingDownload: "Downloading…",
  failedDownload: "Download failed",
  interpretation: "Interpretation",
  queued: "Waiting to process",
  processing: "Processing…",
  complete: "Processed",
  interpretationUnavailable: "Processing unavailable",
  interpretationFailed: "Processing failed",
  unknown: "Result unconfirmed",
  cancelled: "Processing stopped",
  retry_required: "Processing needs retry",
  retryProcessing: "Retry processing",
};
const cs: typeof en = {
  attachments: "Přílohy",
  attach: "Připojit",
  camera: "Fotoaparát",
  photos: "Fotky",
  file: "Soubor",
  task: "Úkol",
  remove: "Odebrat",
  retry: "Opakovat nahrání",
  preview: "Náhled",
  download: "Stáhnout",
  close: "Zavřít",
  rotate: "Otočit",
  retake: "Vyfotit znovu",
  confirm: "Použít fotku",
  previewUnavailable: "Náhled není dostupný",
  loadingPreview: "Načítám náhled…",
  selected: "Nenahráno",
  preparing: "Připravuji…",
  uploading: "Nahrávám",
  verifying: "Ověřuji…",
  uploaded: "Nahráno",
  uncertain: "Nahrání nepotvrzeno",
  removing: "Odebírám…",
  expired: "Výběr vypršel",
  transfer: "Nahrání selhalo",
  size: "Soubor je velký",
  type: "Nepodporovaný soubor",
  quota: "Limit nahrávání",
  permission: "Přístup není dostupný",
  integrity: "Kontrola selhala",
  unavailable: "Soubor není dostupný",
  loadingDownload: "Stahuji…",
  failedDownload: "Stažení selhalo",
  interpretation: "Zpracování",
  queued: "Čeká na zpracování",
  processing: "Zpracovávám…",
  complete: "Zpracováno",
  interpretationUnavailable: "Zpracování není dostupné",
  interpretationFailed: "Zpracování selhalo",
  unknown: "Výsledek nepotvrzen",
  cancelled: "Zpracování zastaveno",
  retry_required: "Zpracování čeká",
  retryProcessing: "Opakovat zpracování",
};
export const attachmentCopy = (language: AttachmentLanguage) =>
  language === "cs" ? cs : en;
export function transferPercent(transfer: AttachmentTransfer) {
  return transfer.state === "uploading" &&
    transfer.progress !== undefined &&
    Number.isFinite(transfer.progress)
    ? Math.round(Math.max(0, Math.min(1, transfer.progress)) * 100)
    : undefined;
}
export function transferLabel(
  transfer: AttachmentTransfer,
  language: AttachmentLanguage,
) {
  const copy = attachmentCopy(language);
  if (transfer.state === "failed") return copy[transfer.reason ?? "transfer"];
  const percent = transferPercent(transfer);
  return `${copy[transfer.state]}${percent === undefined ? "" : ` ${percent} %`}`;
}
export function interpretationLabel(
  value: AttachmentInterpretation,
  language: AttachmentLanguage,
) {
  const copy = attachmentCopy(language);
  return value.state === "failed"
    ? copy.interpretationFailed
    : value.state === "unavailable"
      ? copy.interpretationUnavailable
      : copy[value.state];
}
export const attachmentChoiceOrder: readonly AttachmentChoice[] = [
  "camera",
  "photos",
  "file",
  "task",
];
