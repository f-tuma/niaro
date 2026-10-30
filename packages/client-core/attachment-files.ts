import type { AttachmentSelection } from "./attachments";
import { AttachmentClientError } from "./attachment-transport";
export type RasterType = "image/jpeg" | "image/png" | "image/webp";
const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));
/** A conservative client check, never a substitute for the server's independent identifier. Names are display only. */
export function identifyAttachment(
  bytes: Uint8Array,
  declared: string,
): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP")
    return "image/webp";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (ascii(bytes, 0, 4) === "PK\x03\x04") {
    // No archive execution/decompression. Only known OOXML containers; the server verifies structure.
    const header = ascii(bytes, 0, Math.min(bytes.length, 65536));
    if (header.includes("[Content_Types].xml")) {
      for (const [part, kind] of [
        ["word/", "wordprocessingml.document"],
        ["xl/", "spreadsheetml.sheet"],
        ["ppt/", "presentationml.presentation"],
      ])
        if (header.includes(part!))
          return `application/vnd.openxmlformats-officedocument.${kind}`;
    }
    throw new AttachmentClientError("attachment_type_unsupported");
  }
  if (ascii(bytes, 0, 2) === "MZ" || ascii(bytes, 0, 4) === "\x7fELF")
    throw new AttachmentClientError("attachment_type_unsupported");
  const textType =
    !declared || declared === "application/octet-stream"
      ? "text/plain"
      : declared;
  if (
    [
      "text/plain",
      "text/markdown",
      "text/csv",
      "text/tab-separated-values",
    ].includes(textType)
  ) {
    const sample = bytes.subarray(0, Math.min(bytes.length, 65536));
    // Reject binary and active markup even when its extension or OS MIME says text.
    if (
      !sample.some((byte) => byte === 0 || byte < 9 || (byte > 13 && byte < 32))
    ) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(sample, {
          stream: sample.length !== bytes.length,
        });
        if (!/<\s*(?:!doctype|html|script|svg|iframe|object)\b/i.test(text))
          return textType;
      } catch {}
    }
  }
  throw new AttachmentClientError("attachment_type_unsupported");
}
/** Reads dimensions from raster headers before asking a platform decoder to allocate pixels. */
export function rasterDimensions(
  bytes: Uint8Array,
  mediaType: string,
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0,
    height = 0;
  if (mediaType === "image/png" && bytes.length >= 24) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (mediaType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length && offset < 262144) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1]!;
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        height = view.getUint16(offset + 5);
        width = view.getUint16(offset + 7);
        break;
      }
      offset += length + 2;
    }
  } else if (mediaType === "image/webp" && bytes.length >= 30) {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === "VP8X") {
      width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    } else if (
      chunk === "VP8 " &&
      bytes[23] === 0x9d &&
      bytes[24] === 1 &&
      bytes[25] === 0x2a
    ) {
      width = view.getUint16(26, true) & 16383;
      height = view.getUint16(28, true) & 16383;
    } else if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const n = view.getUint32(21, true);
      width = (n & 16383) + 1;
      height = ((n >>> 14) & 16383) + 1;
    }
  }
  return width > 0 &&
    height > 0 &&
    width <= 16000 &&
    height <= 16000 &&
    width * height <= 24_000_000
    ? { width, height }
    : null;
}
export function checkedSelection(
  filename: string,
  declared: string,
  bytes: Uint8Array,
  release: () => void,
): AttachmentSelection {
  const mediaType = identifyAttachment(bytes, declared);
  return {
    filename: filename.normalize("NFC"),
    mediaType,
    size: bytes.length,
    read: async () => bytes,
    release,
  };
}
