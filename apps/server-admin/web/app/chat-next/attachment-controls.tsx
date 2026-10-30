import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ClipboardEvent, DragEvent, RefObject } from "react";
import type { AttachmentState } from "../../../../../packages/client-core/attachments";
import type { ClientSession } from "../../../../../packages/client-core/session";
import { AttachmentSelectionFlow } from "../../../../../packages/client-core/attachment-selection";
import {
  browserCandidate,
  browserDigest,
  chooseBrowserFile,
  openBrowserCamera,
  captureBrowserPhoto,
  saveBrowserOriginal,
} from "../../../../../packages/client-core/attachment-browser";
import {
  attachmentInterpretation,
  attachmentRuntimeCopy,
  draftAttachmentViews,
  persistedAttachmentViews,
} from "../../../../../packages/client-core/attachment-presentation-adapter";
import type {
  AttachmentProcessing,
  AttachmentPublicFile,
} from "../../../../../packages/protocol/attachments";
import {
  ChatAttachmentTray,
  ChatAttachmentMenu,
  ChatAttachmentPreview,
  ChatPersistedAttachments,
  ChatAttachmentProcessing,
} from "@admin/components/ui/chat-attachment";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@admin/components/ui/dialog";
import { Button } from "@admin/components/ui/button";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { attachmentCopy } from "../../../../../packages/ui-catalog/attachment-presentation";
const emptyState: AttachmentState = {
  capabilities: null,
  discovering: false,
  target: null,
  draft: null,
  entries: [],
  busy: false,
  error: null,
};
const emptySelection = { rotation: 0 as const, busy: false, error: null };
const noopSubscribe = () => () => {};
export function useWebAttachments(
  session: ClientSession,
  conversationId: string,
  generation: string | null,
  language: "en" | "cs",
) {
  const runtime = session.attachments;
  const state = useSyncExternalStore(
    runtime?.subscribe ?? noopSubscribe,
    runtime?.getSnapshot ?? (() => emptyState),
  );
  const flow = useMemo(
    () =>
      runtime ? new AttachmentSelectionFlow(runtime, browserDigest) : undefined,
    [runtime],
  );
  const selection = useSyncExternalStore(
    flow?.subscribe ?? noopSubscribe,
    flow?.getSnapshot ?? (() => emptySelection),
  );
  const [camera, setCamera] =
    useState<Awaited<ReturnType<typeof openBrowserCamera>>>(null);
  const cameraRef = useRef(camera);
  const cameraController = useRef(new AbortController());
  const [cameraError, setCameraError] = useState(false);
  const restoreFocus = useRef(false);
  const closeCamera = () => {
    cameraController.current.abort();
    cameraController.current = new AbortController();
    cameraRef.current?.stop();
    cameraRef.current = null;
    setCamera(null);
  };
  useEffect(() => {
    if (!runtime || !flow) return;
    restoreFocus.current = false;
    runtime.select({
      conversationId,
      expectedGeneration: generation,
      mode: "current",
    });
    void runtime.discover();
    const cancel = () => {
      flow.cancel();
      closeCamera();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") cancel();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener?.("pagehide", cancel);
    return () => {
      cancel();
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener?.("pagehide", cancel);
    };
    // Scope owns all candidate URLs and streams; primitive inputs prevent render-driven cancellation.
  }, [runtime, flow, conversationId, generation]);
  const file = (file: File) => {
    restoreFocus.current = true;
    if (runtime?.available && flow)
      void flow.choose((signal) =>
        browserCandidate(file, state.capabilities!.limits.maxFileBytes, signal),
      );
  };
  const choose = (kind: "camera" | "photos" | "file") => {
    if (!runtime?.available || !flow || state.busy || selection.busy) return;
    restoreFocus.current = true;
    setCameraError(false);
    if (
      kind === "camera" &&
      globalThis.isSecureContext &&
      typeof navigator.mediaDevices?.getUserMedia === "function"
    ) {
      closeCamera();
      const signal = cameraController.current.signal;
      void openBrowserCamera(signal)
        .then((opened) => {
          if (signal.aborted) {
            opened?.stop();
            return;
          }
          cameraRef.current = opened;
          setCamera(opened);
        })
        .catch(() => {
          if (!signal.aborted) setCameraError(true);
        });
    } else
      void flow.choose(async (signal) => {
        const picked = await chooseBrowserFile(kind, signal);
        return picked
          ? browserCandidate(
              picked,
              state.capabilities!.limits.maxFileBytes,
              signal,
            )
          : null;
      });
  };
  const capture = async (video: HTMLVideoElement) => {
    const owner = cameraRef.current;
    const signal = cameraController.current.signal;
    if (!owner || signal.aborted) return;
    try {
      const photo = await captureBrowserPhoto(video);
      // Encoding may finish after dismiss, background, replacement or scope exit.
      if (signal.aborted || cameraRef.current !== owner) return;
      closeCamera();
      file(photo);
    } catch {
      if (!signal.aborted && cameraRef.current === owner) closeCamera();
    }
  };
  return {
    runtime,
    state,
    flow,
    selection,
    camera,
    closeCamera,
    capture,
    cameraError,
    choose,
    file,
    language,
    closeAutoFocus: (event: Event) => {
      if (!restoreFocus.current) event.preventDefault();
    },
    available: !!runtime?.available,
    ready: !!runtime?.ready,
    drop: (event: DragEvent) => {
      if (!runtime?.available || !event.dataTransfer.types.includes("Files"))
        return;
      event.preventDefault();
      if (event.dataTransfer.files.length !== 1) {
        flow?.reject("attachment_selection_multiple");
        return;
      }
      const picked = event.dataTransfer.files[0];
      if (picked) file(picked);
    },
    paste: (event: ClipboardEvent) => {
      if (!runtime?.available) return;
      const image = Array.from(event.clipboardData.items)
        .find((item) => item.kind === "file" && item.type.startsWith("image/"))
        ?.getAsFile();
      if (image) {
        event.preventDefault();
        file(image);
      }
    },
  };
}
export type WebAttachments = ReturnType<typeof useWebAttachments>;
export function WebAttachmentMenu({
  value,
  disabled,
}: {
  value: WebAttachments;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!value.available) return null;
  return (
    <ChatAttachmentMenu
      language={value.language}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled || value.state.busy || value.selection.busy}
      choices={Object.fromEntries(
        (["camera", "photos", "file"] as const).map((kind) => [
          kind,
          { onPress: () => value.choose(kind) },
        ]),
      )}
    />
  );
}
export function WebAttachmentDraft({
  value,
  fallbackFocusRef,
}: {
  value: WebAttachments;
  fallbackFocusRef: RefObject<HTMLTextAreaElement | null>;
}) {
  if (!value.runtime || !value.flow) return null;
  const copy = attachmentRuntimeCopy(value.language);
  const candidate = value.selection.candidate;
  return (
    <>
      <ChatAttachmentTray
        language={value.language}
        files={draftAttachmentViews(value.runtime, value.state.entries)}
      />
      {value.state.entries
        .filter((entry) => ["uncertain", "verifying"].includes(entry.state))
        .map((entry) => (
          <Button
            key={entry.id}
            type="button"
            variant="ghost"
            size="sm"
            disabled={value.state.busy}
            onClick={() => {
              void value.runtime?.refresh(entry.id);
            }}
          >
            {copy.check}
          </Button>
        ))}
      {value.state.error || value.selection.error || value.cameraError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {value.cameraError
              ? copy.permission
              : value.selection.error === "attachment_selection_multiple"
                ? copy.oneFile
                : copy.failed}
          </AlertDescription>
        </Alert>
      ) : null}
      <ChatAttachmentPreview
        open={!!candidate}
        onOpenChange={(open) => {
          if (!open) value.flow?.cancel();
        }}
        language={value.language}
        filename={candidate?.selection.filename ?? ""}
        raster={candidate?.raster}
        rotation={value.selection.rotation}
        loading={value.selection.busy}
        fallbackFocusRef={fallbackFocusRef}
        onCloseAutoFocus={value.closeAutoFocus}
        rotate={{ onPress: () => value.flow?.rotate() }}
        retake={{
          onPress: () => {
            value.flow?.cancel();
            value.choose("camera");
          },
        }}
        confirm={{
          onPress: () => {
            void value.flow?.confirm();
          },
        }}
      />
      {candidate ? (
        <p className="text-xs text-muted-foreground">{copy.conversion}</p>
      ) : null}
      <BrowserCamera value={value} fallbackFocusRef={fallbackFocusRef} />
    </>
  );
}
function BrowserCamera({
  value,
  fallbackFocusRef,
}: {
  value: WebAttachments;
  fallbackFocusRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const copy = attachmentCopy(value.language);
  useEffect(() => {
    const element = video.current;
    if (!element || !value.camera) return;
    element.srcObject = value.camera.stream;
    void element.play().catch(value.closeCamera);
    return () => {
      element.srcObject = null;
    };
    // The captured stream is the effect owner; closeCamera is an event callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.camera]);
  return (
    <Dialog
      open={!!value.camera}
      onOpenChange={(open) => {
        if (!open) value.closeCamera();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          const content = event.currentTarget as HTMLElement;
          const active = content.ownerDocument.activeElement;
          opener.current =
            active instanceof HTMLElement &&
            active !== content.ownerDocument.body &&
            !content.contains(active)
              ? active
              : null;
        }}
        onCloseAutoFocus={(event) => {
          value.closeAutoFocus(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          const content = event.currentTarget as HTMLElement;
          const active = content.ownerDocument.activeElement;
          if (
            value.camera ||
            (active &&
              active !== content.ownerDocument.body &&
              !content.contains(active))
          )
            return;
          const target = opener.current?.isConnected
            ? opener.current
            : fallbackFocusRef.current;
          if (
            target?.isConnected &&
            !target.closest('[inert], [aria-hidden="true"]')
          )
            target.focus({ preventScroll: true });
        }}
      >
        <DialogHeader>
          <DialogTitle>{copy.camera}</DialogTitle>
        </DialogHeader>
        <video
          ref={video}
          muted
          playsInline
          className="w-full"
          aria-label={copy.camera}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={value.closeCamera}>
            {copy.close}
          </Button>
          <Button
            onClick={() => {
              if (!video.current) return;
              void value.capture(video.current);
            }}
          >
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export function WebMessageAttachments({
  session,
  language,
  files,
  processing,
}: {
  session: ClientSession;
  language: "en" | "cs";
  files: readonly AttachmentPublicFile[];
  processing?: AttachmentProcessing;
}) {
  const [failed, setFailed] = useState(false);
  const interpretation = attachmentInterpretation(processing);
  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-1">
      <ChatPersistedAttachments
        language={language}
        files={persistedAttachmentViews(files, (file) => {
          setFailed(false);
          void session.attachments
            .download(file, browserDigest, saveBrowserOriginal)
            .catch(() => setFailed(true));
        })}
      />
      {interpretation ? (
        <ChatAttachmentProcessing language={language} value={interpretation} />
      ) : null}
      {failed ? (
        <Alert variant="destructive">
          <AlertDescription>
            {attachmentRuntimeCopy(language).failed}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
