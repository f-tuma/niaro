import {
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { mkdir, open, unlink, statfs, lstat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { AttachmentError } from "./schema";

/** A slot spans spooling/store I/O or the entire backpressured response. No wait queue. */
export class AttachmentAdmission {
  private active = new Set<"upload" | "download">();
  claim(kind: "upload" | "download") {
    if (this.active.has(kind))
      throw new AttachmentError("attachment_busy", 429);
    this.active.add(kind);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active.delete(kind);
      }
    };
  }
  counts() {
    return {
      uploads: Number(this.active.has("upload")),
      downloads: Number(this.active.has("download")),
    };
  }
}
/** Called only under the normal workflow owner lock, before accepting transfers. */
export function cleanupAttachmentSpools(directory: string) {
  const dir = join(directory, "attachment-spool");
  if (!existsSync(dir)) return;
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new AttachmentError("attachment_unavailable", 503);
  let removed = 0;
  for (const file of readdirSync(dir)) {
    if (removed >= 100) break;
    if (!/^[a-f0-9-]{36}\.tmp$/.test(file)) continue;
    const path = join(dir, file),
      entry = lstatSync(path);
    if (entry.isFile() && !entry.isSymbolicLink()) {
      unlinkSync(path);
      removed++;
    }
  }
}
export function identifyAttachment(bytes: Uint8Array, declared: string) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const prefix = b.subarray(0, 32);
  if (
    prefix.subarray(0, 2).toString() === "MZ" ||
    (prefix.length >= 4 && prefix.readUInt32BE(0) === 0x7f454c46) ||
    [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(
      prefix.length >= 4 ? prefix.readUInt32BE(0) : 0,
    )
  )
    throw new AttachmentError("attachment_type_unsupported", 415);
  if (b.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (
    b.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) ||
    b.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))
  )
    return "image/tiff";
  if (b.length >= 12 && b.subarray(4, 8).toString() === "ftyp") {
    const brand = b.subarray(8, 12).toString();
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic";
    if (["mif1", "msf1"].includes(brand)) return "image/heif";
  }
  if (b.length >= 4 && b.readUInt32LE(0) === 0x04034b50) {
    // Bounded container identification only: never inflate, execute or fetch a part.
    const names = new Set<string>();
    let entries = 0;
    for (let i = 0; i + 46 <= b.length; i++)
      if (b.readUInt32LE(i) === 0x02014b50) {
        const n = b.readUInt16LE(i + 28),
          extra = b.readUInt16LE(i + 30),
          comment = b.readUInt16LE(i + 32);
        if (
          ++entries > 10000 ||
          i + 46 + n + extra + comment > b.length ||
          b.readUInt16LE(i + 8) & 1
        )
          throw new AttachmentError("attachment_type_unsupported", 415);
        const name = b.subarray(i + 46, i + 46 + n).toString("utf8");
        if (
          name.startsWith("/") ||
          name.split("/").includes("..") ||
          name.includes("vbaProject") ||
          name.includes("EncryptedPackage")
        )
          throw new AttachmentError("attachment_type_unsupported", 415);
        names.add(name);
        i += 45 + n + extra + comment;
      }
    if (names.has("[Content_Types].xml")) {
      if (
        ["word/document.xml", "xl/workbook.xml", "ppt/presentation.xml"].filter(
          (name) => names.has(name),
        ).length !== 1
      )
        throw new AttachmentError("attachment_type_unsupported", 415);
      if (names.has("word/document.xml"))
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      if (names.has("xl/workbook.xml"))
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      if (names.has("ppt/presentation.xml"))
        return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    }
    throw new AttachmentError("attachment_type_unsupported", 415);
  }
  if (
    [
      "text/plain",
      "text/markdown",
      "text/csv",
      "text/tab-separated-values",
    ].includes(declared)
  ) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(b);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw Error();
      return declared;
    } catch {
      throw new AttachmentError("attachment_type_unsupported", 415);
    }
  }
  throw new AttachmentError("attachment_type_unsupported", 415);
}
export async function spoolAttachment(
  req: IncomingMessage,
  directory: string,
  token: string,
  size: number,
  digest: string,
  mediaType: string,
  deadlineSeconds: number,
) {
  const dir = join(directory, "attachment-spool");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new AttachmentError("attachment_unavailable", 503);
  await chmod(dir, 0o700);
  const disk = await statfs(dir);
  if (disk.bavail * disk.bsize < 50 * 1024 * 1024 + size)
    throw new AttachmentError("attachment_unavailable", 503);
  const path = join(dir, `${token}.tmp`),
    file = await open(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  const abort = () =>
    req.destroy(new AttachmentError("attachment_unavailable", 503));
  const absolute = setTimeout(abort, deadlineSeconds * 1000);
  let idle = setTimeout(abort, 15000);
  let received = 0;
  const hash = createHash("sha256");
  try {
    for await (const value of req) {
      clearTimeout(idle);
      idle = setTimeout(abort, 15000);
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (received + chunk.length > size)
        throw new AttachmentError("attachment_too_large", 413);
      for (let n = 0; n < chunk.length; n += 65536) {
        const view = chunk.subarray(n, n + 65536);
        let offset = 0;
        while (offset < view.length) {
          const written = await file.write(view, offset, view.length - offset);
          if (!written.bytesWritten) throw Error("write");
          offset += written.bytesWritten;
        }
        hash.update(view);
      }
      received += chunk.length;
    }
    if (received !== size) throw new AttachmentError("attachment_invalid");
    if (hash.digest("hex") !== digest)
      throw new AttachmentError("attachment_integrity", 503);
    await file.close();
    const read = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      bytes = await read.readFile();
    } finally {
      await read.close();
    }
    if (bytes.length !== size)
      throw new AttachmentError("attachment_integrity", 503);
    return { bytes, mediaType: identifyAttachment(bytes, mediaType) };
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError("attachment_unavailable", 503);
  } finally {
    clearTimeout(absolute);
    clearTimeout(idle);
    await file.close().catch(() => {});
    await unlink(path).catch(() => {});
  }
}
