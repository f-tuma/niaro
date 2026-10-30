import { checkedSelection, rasterDimensions } from "./attachment-files";
import { AttachmentClientError } from "./attachment-transport";
import type { AttachmentCandidate } from "./attachment-device";
export async function browserDigest(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function chooseBrowserFile(
  kind: "camera" | "photos" | "file",
  signal: AbortSignal,
): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (kind !== "file") input.accept = "image/jpeg,image/png,image/webp";
    if (kind === "camera") input.capture = "environment";
    input.hidden = true;
    document.body.append(input);
    const finish = (file: File | null) => {
      signal.removeEventListener("abort", cancel);
      input.remove();
      resolve(file);
    };
    const cancel = () => finish(null);
    input.addEventListener("change", () => finish(input.files?.[0] ?? null), {
      once: true,
    });
    input.addEventListener("cancel", cancel, { once: true });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    else input.click();
  });
}
export async function browserCandidate(
  file: File,
  maxBytes: number,
  signal: AbortSignal,
): Promise<AttachmentCandidate> {
  if (signal.aborted || !file.size || file.size > maxBytes)
    throw new AttachmentClientError("attachment_too_large");
  let bytes: Uint8Array | undefined = new Uint8Array(await file.arrayBuffer());
  if (signal.aborted) throw new AttachmentClientError("attachment_stale");
  const selection = checkedSelection(
    file.name,
    file.type.toLowerCase(),
    bytes,
    () => {},
  );
  let uri: string | undefined;
  let released = false;
  const release = () => {
    released = true;
    bytes = undefined;
    if (uri) URL.revokeObjectURL(uri);
    uri = undefined;
  };
  let raster: AttachmentCandidate["raster"];
  if (selection.mediaType.startsWith("image/")) {
    if (!rasterDimensions(bytes, selection.mediaType)) {
      release();
      throw new AttachmentClientError("attachment_type_unsupported");
    }
    // Decoding is restricted to bounded identified raster data; no HTML/SVG/PDF previews.
    const decoded = await createImageBitmap(file);
    const dimensions = { width: decoded.width, height: decoded.height };
    decoded.close();
    if (signal.aborted || dimensions.width * dimensions.height > 24_000_000) {
      release();
      throw new AttachmentClientError("attachment_stale");
    }
    uri = URL.createObjectURL(
      new Blob([bytes.slice().buffer], { type: selection.mediaType }),
    );
    raster = {
      uri,
      mediaType: selection.mediaType as NonNullable<typeof raster>["mediaType"],
    };
  }
  return {
    selection: {
      ...selection,
      read: async () => {
        if (!bytes) throw new AttachmentClientError("attachment_stale");
        return bytes;
      },
      release,
    },
    raster,
    release,
    confirm: async (rotation) => {
      if (released || signal.aborted || !bytes)
        throw new AttachmentClientError("attachment_stale");
      if (!rotation || !raster)
        return {
          ...selection,
          read: async () => {
            if (!bytes) throw new AttachmentClientError("attachment_stale");
            return bytes;
          },
          release,
        };
      const bitmap = await createImageBitmap(
        new Blob([bytes.slice().buffer], { type: selection.mediaType }),
      );
      try {
        const canvas = document.createElement("canvas");
        canvas.width = rotation % 180 ? bitmap.height : bitmap.width;
        canvas.height = rotation % 180 ? bitmap.width : bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) throw new AttachmentClientError("attachment_unavailable");
        context.translate(canvas.width / 2, canvas.height / 2);
        context.rotate((rotation * Math.PI) / 180);
        context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (blob) =>
              blob
                ? resolve(blob)
                : reject(new AttachmentClientError("attachment_unavailable")),
            "image/png",
          ),
        );
        canvas.width = 0;
        canvas.height = 0;
        if (blob.size > maxBytes || signal.aborted || released)
          throw new AttachmentClientError("attachment_too_large");
        const rotated = new Uint8Array(await blob.arrayBuffer());
        if (signal.aborted || released)
          throw new AttachmentClientError("attachment_stale");
        return checkedSelection(
          selection.filename.replace(/\.[^.]*$/, "") + ".png",
          "image/png",
          rotated,
          release,
        );
      } finally {
        bitmap.close();
      }
    },
  };
}
export async function saveBrowserOriginal(bytes: Uint8Array, filename: string) {
  const uri = URL.createObjectURL(
    new Blob([bytes.slice().buffer], { type: "application/octet-stream" }),
  );
  const link = document.createElement("a");
  link.href = uri;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser time to take ownership of the download, then release it regardless of dialog outcome.
  setTimeout(() => URL.revokeObjectURL(uri), 1000);
}
/** Only called from the camera action; late permission completion cannot leak tracks. */
export async function openBrowserCamera(signal: AbortSignal) {
  if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia)
    return null;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "environment",
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  });
  const stop = () => stream.getTracks().forEach((track) => track.stop());
  if (signal.aborted) {
    stop();
    return null;
  }
  signal.addEventListener("abort", stop, { once: true });
  return {
    stream,
    stop: () => {
      signal.removeEventListener("abort", stop);
      stop();
    },
  };
}
export async function captureBrowserPhoto(
  video: HTMLVideoElement,
): Promise<File> {
  if (!video.videoWidth || video.videoWidth * video.videoHeight > 24_000_000)
    throw new AttachmentClientError("attachment_type_unsupported");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new AttachmentClientError("attachment_unavailable");
  context.drawImage(video, 0, 0);
  try {
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new AttachmentClientError("attachment_unavailable")),
        "image/jpeg",
        0.95,
      ),
    );
    return new File([blob], "photo.jpg", { type: "image/jpeg" });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
