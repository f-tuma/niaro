/**
 * The audio of a meeting's video recording (Teams, Zoom, Meet and Slack all
 * download MP4) as an audio-only MP4, without decoding or re-encoding: the
 * sound track's own sample table is kept and only its chunk offsets move.
 * A one-hour 1080p recording of several hundred MB becomes the few tens of MB
 * of its AAC track, so it fits the meeting upload limit.
 *
 * Nothing is read into memory except the box headers and the `moov` index;
 * the result is a Blob that references slices of the original file.
 */

type Box = { type: string; start: number; header: number; size: number };

export class Mp4AudioError extends Error {}

const text = (bytes: Uint8Array, at: number) =>
  String.fromCharCode(
    bytes[at]!,
    bytes[at + 1]!,
    bytes[at + 2]!,
    bytes[at + 3]!,
  );

/** Child boxes of `bytes[from, to)`; offsets are relative to `bytes`. */
function children(bytes: Uint8Array, from: number, to: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) throw new Mp4AudioError("mp4_invalid");
    boxes.push({ type: text(bytes, at + 4), start: at, header, size });
    at += size;
  }
  return boxes;
}
function child(bytes: Uint8Array, parent: Box, type: string) {
  return children(
    bytes,
    parent.start + parent.header,
    parent.start + parent.size,
  ).find((box) => box.type === type);
}
function path(bytes: Uint8Array, parent: Box, types: string[]) {
  let box: Box | undefined = parent;
  for (const type of types) box = box && child(bytes, box, type);
  return box;
}

async function read(file: Blob, start: number, length: number) {
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
}

/** Top-level boxes, read header by header. */
async function topLevel(file: Blob) {
  const boxes: Box[] = [];
  let at = 0;
  while (at + 8 <= file.size) {
    const head = await read(file, at, 16);
    const view = new DataView(head.buffer);
    let size = view.getUint32(0);
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(8));
      header = 16;
    } else if (size === 0) size = file.size - at;
    if (size < header || at + size > file.size)
      throw new Mp4AudioError("mp4_invalid");
    boxes.push({ type: text(head, 4), start: at, header, size });
    at += size;
  }
  return boxes;
}

function u32(value: number) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}
function box(type: string, ...parts: Uint8Array[]) {
  const size = 8 + parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  out.set(u32(size), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let at = 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Whether a file name or type is in the MP4 family (MP4, M4A, MOV, M4V, 3GP). */
export function isMp4Family(name: string) {
  return /\.(mp4|m4a|m4v|mov|3gp)$/i.test(name);
}

/**
 * The first sound track of an MP4/MOV file as an audio-only MP4 Blob.
 * Fragmented files (live streams, some screen recorders) are refused.
 */
export async function extractMp4Audio(file: Blob): Promise<Blob> {
  const top = await topLevel(file);
  const moovBox = top.find((entry) => entry.type === "moov");
  if (!moovBox || top.some((entry) => entry.type === "moof"))
    throw new Mp4AudioError("mp4_unsupported");
  const moov = await read(file, moovBox.start, moovBox.size);
  const root: Box = { ...moovBox, start: 0 };
  if (child(moov, root, "mvex")) throw new Mp4AudioError("mp4_unsupported");
  const mvhd = child(moov, root, "mvhd");
  const trak = children(moov, root.header, root.size).find((entry) => {
    if (entry.type !== "trak") return false;
    const hdlr = path(moov, entry, ["mdia", "hdlr"]);
    return !!hdlr && text(moov, hdlr.start + hdlr.header + 8) === "soun";
  });
  if (!mvhd || !trak) throw new Mp4AudioError("mp4_no_audio");
  const stbl = path(moov, trak, ["mdia", "minf", "stbl"]);
  const stsc = stbl && child(moov, stbl, "stsc");
  const stsz = stbl && child(moov, stbl, "stsz");
  const offsets =
    stbl && (child(moov, stbl, "stco") ?? child(moov, stbl, "co64"));
  if (!stsc || !stsz || !offsets) throw new Mp4AudioError("mp4_unsupported");
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const wide = offsets.type === "co64";
  const chunkCount = view.getUint32(offsets.start + offsets.header + 4);
  const chunkAt = (index: number) =>
    offsets.start + offsets.header + 8 + index * (wide ? 8 : 4);
  const chunkOffset = (index: number) =>
    wide
      ? Number(view.getBigUint64(chunkAt(index)))
      : view.getUint32(chunkAt(index));
  // Samples per chunk: stsc runs apply from their first chunk to the next run.
  const runs = view.getUint32(stsc.start + stsc.header + 4);
  const run = (index: number) => {
    const at = stsc.start + stsc.header + 8 + index * 12;
    return { first: view.getUint32(at), samples: view.getUint32(at + 4) };
  };
  const constant = view.getUint32(stsz.start + stsz.header + 4);
  const sampleCount = view.getUint32(stsz.start + stsz.header + 8);
  const sampleSize = (index: number) =>
    constant || view.getUint32(stsz.start + stsz.header + 12 + index * 4);
  const chunks: { offset: number; size: number }[] = [];
  let sample = 0;
  let runIndex = 0;
  for (let chunk = 1; chunk <= chunkCount; chunk++) {
    while (runIndex + 1 < runs && run(runIndex + 1).first <= chunk) runIndex++;
    const samples = runs ? run(runIndex).samples : 0;
    let size = 0;
    for (let i = 0; i < samples && sample < sampleCount; i++)
      size += sampleSize(sample++);
    const offset = chunkOffset(chunk - 1);
    if (offset + size > file.size) throw new Mp4AudioError("mp4_invalid");
    chunks.push({ offset, size });
  }
  if (!chunks.length || sample !== sampleCount)
    throw new Mp4AudioError("mp4_invalid");

  const ftyp = box(
    "ftyp",
    new TextEncoder().encode("M4A "),
    u32(0),
    new TextEncoder().encode("M4A isommp42"),
  );
  const track = moov.slice(trak.start, trak.start + trak.size);
  const header = moov.slice(mvhd.start, mvhd.start + mvhd.size);
  const index = box("moov", header, track);
  const dataBytes = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  if (dataBytes + 8 > 0xffffffff) throw new Mp4AudioError("mp4_unsupported");
  let at = ftyp.length + index.length + 8;
  // The offset table sits at the same place inside the copied track.
  const table = new DataView(
    index.buffer,
    8 + header.length + (offsets.start - trak.start) + offsets.header + 8,
  );
  chunks.forEach((chunk, i) => {
    if (wide) table.setBigUint64(i * 8, BigInt(at));
    else table.setUint32(i * 4, at);
    at += chunk.size;
  });
  const mdat = box("mdat");
  new DataView(mdat.buffer).setUint32(0, dataBytes + 8);
  return new Blob(
    [
      ftyp,
      index,
      mdat,
      ...chunks.map((chunk) =>
        file.slice(chunk.offset, chunk.offset + chunk.size),
      ),
    ],
    { type: "audio/mp4" },
  );
}
