import {
  browserCandidate,
  browserDigest,
  chooseBrowserFile,
  saveBrowserOriginal,
} from "../../packages/client-core/attachment-browser";
export const attachmentDigest = browserDigest;
export const saveAttachment = saveBrowserOriginal;
export async function pickAttachment(
  kind: "camera" | "photos" | "file",
  maxBytes: number,
  signal: AbortSignal,
) {
  const file = await chooseBrowserFile(kind, signal);
  return file ? browserCandidate(file, maxBytes, signal) : null;
}
