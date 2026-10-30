import * as React from "react";
import {
  Camera,
  Download,
  FileText,
  Image as ImageIcon,
  Images,
  Paperclip,
  RotateCw,
  CircleCheck,
  X,
} from "lucide-react";
import { Button } from "./button";
import { Progress } from "./progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import {
  attachmentChoiceOrder,
  attachmentCopy,
  interpretationLabel,
  rasterUri,
  transferLabel,
  transferPercent,
  type AttachmentChoices,
  type AttachmentFile,
  type AttachmentInterpretation,
  type AttachmentLanguage,
  type AttachmentPreviewProps,
  type DraftAttachment,
  type PersistedAttachment,
} from "../../../../../packages/ui-catalog/attachment-presentation";

function FileSummary({
  file,
  status,
  preview = true,
  problem = false,
}: {
  file: AttachmentFile;
  status: string;
  preview?: boolean;
  problem?: boolean;
}) {
  const uri = rasterUri(file.thumbnail);
  const Glyph = file.kind === "image" ? ImageIcon : FileText;
  const content = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md text-muted-foreground">
        {uri ? (
          <img src={uri} alt="" className="size-full object-cover" />
        ) : (
          <Glyph aria-hidden="true" className="size-5" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium" dir="auto">
          {file.filename}
        </span>
        <span
          data-problem={problem}
          className="text-xs text-muted-foreground data-[problem=true]:text-destructive"
        >
          {status}
        </span>
      </span>
    </>
  );
  return preview && file.preview ? (
    <button
      type="button"
      aria-label={file.filename}
      title={`${file.filename}\n${status}`}
      disabled={file.preview.disabled}
      onClick={file.preview.onPress}
      className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-lg p-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      {content}
    </button>
  ) : (
    <div
      title={file.filename}
      className="flex min-h-12 min-w-0 flex-1 items-center gap-2 p-2"
    >
      {content}
    </div>
  );
}

/** Controlled presentation. Successful uploads never imply successful interpretation. */
export function ChatAttachmentTray({
  files,
  language,
}: {
  files: readonly DraftAttachment[];
  language: AttachmentLanguage;
}) {
  const copy = attachmentCopy(language);
  if (!files.length) return null;
  return (
    <section
      aria-label={copy.attachments}
      className="flex min-w-0 flex-col"
    >
      <div role="list" className="flex gap-2 overflow-x-auto pb-1">
        {files.map((file) => (
          <div
            role="listitem"
            key={file.id}
            data-testid={`attachment-${file.id}`}
            className="w-72 max-w-full shrink-0 overflow-hidden rounded-xl border bg-muted/30"
          >
            <div className="flex items-center">
              <FileSummary
                file={file}
                status={transferLabel(file.transfer, language)}
                problem={
                  file.transfer.state === "failed" ||
                  file.transfer.state === "uncertain"
                }
              />
              {file.transfer.state === "failed" && file.retry ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-12"
                  aria-label={`${copy.retry}: ${file.filename}`}
                  title={copy.retry}
                  disabled={file.retry.disabled}
                  onClick={file.retry.onPress}
                >
                  <RotateCw />
                </Button>
              ) : null}
              {file.remove ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-12"
                  aria-label={`${copy.remove}: ${file.filename}`}
                  title={copy.remove}
                  disabled={
                    file.remove.disabled || file.transfer.state === "removing"
                  }
                  onClick={file.remove.onPress}
                >
                  <X />
                </Button>
              ) : null}
            </div>
            {file.transfer.state === "uploading" ? (
              <Progress
                value={transferPercent(file.transfer) ?? null}
                aria-label={`${copy.uploading}: ${file.filename}`}
                aria-valuetext={transferLabel(file.transfer, language)}
              />
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

export function ChatPersistedAttachments({
  files,
  language,
}: {
  files: readonly PersistedAttachment[];
  language: AttachmentLanguage;
}) {
  const copy = attachmentCopy(language);
  if (!files.length) return null;
  return (
    <div
      role="list"
      aria-label={copy.attachments}
      className="flex min-w-0 flex-col gap-1.5"
    >
      {files.map((file) => {
        const available = file.availability === "available";
        const status = !available
          ? copy.unavailable
          : file.downloadState === "failed"
            ? copy.failedDownload
            : file.downloadState === "loading"
              ? copy.loadingDownload
              : file.detail;
        return (
          <div
            role="listitem"
            key={file.id}
            data-testid={`retained-${file.id}`}
            className="flex min-w-0 items-center rounded-xl border bg-muted/30"
          >
            <FileSummary
              file={{
                ...file,
                thumbnail: available ? file.thumbnail : undefined,
              }}
              status={status}
              problem={!available || file.downloadState === "failed"}
              preview={available}
            />
            {available && file.download ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-12"
                aria-label={`${copy.download}: ${file.filename}`}
                title={copy.download}
                disabled={
                  file.download.disabled || file.downloadState === "loading"
                }
                onClick={file.download.onPress}
              >
                <Download />
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function ChatAttachmentProcessing({
  value,
  language,
}: {
  value: AttachmentInterpretation;
  language: AttachmentLanguage;
}) {
  const copy = attachmentCopy(language);
  const retryable = ["failed", "unavailable", "retry_required"].includes(
    value.state,
  );
  return (
    <div className="flex min-w-0 items-center gap-2">
      <p role="status" className="flex-1 text-xs text-muted-foreground">
        {interpretationLabel(value, language)}
      </p>
      {retryable && value.retry ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-12"
          aria-label={copy.retryProcessing}
          title={copy.retryProcessing}
          disabled={value.retry.disabled}
          onClick={value.retry.onPress}
        >
          <RotateCw />
        </Button>
      ) : null}
    </div>
  );
}

const glyphs = {
  camera: Camera,
  photos: Images,
  file: FileText,
  task: CircleCheck,
};
export function ChatAttachmentMenu({
  language,
  choices,
  open,
  onOpenChange,
  disabled,
}: {
  language: AttachmentLanguage;
  choices: AttachmentChoices;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}) {
  const copy = attachmentCopy(language);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-12"
          aria-label={copy.attach}
          disabled={disabled}
        >
          <Paperclip />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuGroup>
          {attachmentChoiceOrder.map((id) => {
            const action = choices[id];
            if (!action) return null;
            const Glyph = glyphs[id];
            return (
              <DropdownMenuItem
                key={id}
                disabled={action.disabled}
                onSelect={action.onPress}
                className="min-h-12"
              >
                <Glyph />
                {copy[id]}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The parent supplies only a validated transient raster; originals never render inline. */
export function ChatAttachmentPreview({
  open,
  onOpenChange,
  language,
  filename,
  raster,
  rotation,
  loading,
  failed,
  onImageError,
  rotate,
  retake,
  confirm,
  fallbackFocusRef,
  onCloseAutoFocus,
}: AttachmentPreviewProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Used only when the control focused at opening has been removed. */
  fallbackFocusRef?: React.RefObject<HTMLElement | null>;
  /** Radix escape hatch: preventDefault() when a scope transition owns focus. */
  onCloseAutoFocus?: React.ComponentProps<
    typeof DialogContent
  >["onCloseAutoFocus"];
}) {
  const copy = attachmentCopy(language);
  const uri = rasterUri(raster);
  const ready = !!uri && !loading && !failed;
  const openerRef = React.useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="flex max-h-[90dvh] max-w-[calc(100%-1rem)] flex-col overflow-y-auto sm:max-w-md"
        onOpenAutoFocus={(event) => {
          const content = event.currentTarget as HTMLElement;
          const active = content.ownerDocument.activeElement;
          // Capture once per actual opening, before Radix moves focus inside.
          openerRef.current =
            active instanceof HTMLElement &&
            active !== content.ownerDocument.body &&
            !content.contains(active)
              ? active
              : null;
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          // This controlled root has no DialogTrigger for Radix to restore.
          event.preventDefault();
          const content = event.currentTarget as HTMLElement;
          const active = content.ownerDocument.activeElement;
          // An unmounted/reopened preview or a new focus owner wins.
          if (
            open ||
            (active &&
              active !== content.ownerDocument.body &&
              !content.contains(active))
          )
            return;
          const target = openerRef.current?.isConnected
            ? openerRef.current
            : fallbackFocusRef?.current;
          if (
            target?.isConnected &&
            !target.closest('[inert], [aria-hidden="true"]')
          )
            target.focus({ preventScroll: true });
        }}
      >
        <DialogHeader className="min-w-0 shrink-0">
          <div className="flex items-center justify-between gap-1">
            <DialogTitle>{copy.preview}</DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-12"
              aria-label={copy.close}
              onClick={() => onOpenChange(false)}
            >
              <X />
            </Button>
          </div>
          <p className="break-all text-sm text-muted-foreground" dir="auto">
            {filename}
          </p>
        </DialogHeader>
        <div className="relative flex aspect-square w-full shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted">
          {ready ? (
            <img
              src={uri}
              alt={filename}
              onError={onImageError}
              data-rotation={rotation}
              className="size-full object-contain data-[rotation=90]:rotate-90 data-[rotation=180]:rotate-180 data-[rotation=270]:rotate-270"
            />
          ) : (
            <p
              role="status"
              className="p-4 text-center text-sm text-muted-foreground"
            >
              {loading ? copy.loadingPreview : copy.previewUnavailable}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {rotate ? (
            <Button
              type="button"
              variant="secondary"
              className="h-auto min-h-12 flex-1 whitespace-normal"
              disabled={rotate.disabled || !ready}
              onClick={rotate.onPress}
            >
              <RotateCw data-icon="inline-start" />
              {copy.rotate}
            </Button>
          ) : null}
          {retake ? (
            <Button
              type="button"
              variant="secondary"
              className="h-auto min-h-12 flex-1 whitespace-normal"
              disabled={retake.disabled}
              onClick={retake.onPress}
            >
              <Camera data-icon="inline-start" />
              {copy.retake}
            </Button>
          ) : null}
        </div>
        {confirm ? (
          <Button
            type="button"
            className="h-auto min-h-12 whitespace-normal"
            disabled={confirm.disabled || !ready}
            onClick={confirm.onPress}
          >
            {copy.confirm}
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
