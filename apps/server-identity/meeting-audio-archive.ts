import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { Readable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import type { StorageRuntime } from "../server-storage/runtime";
import { StorageError, type ObjectHandle } from "../server-storage/types";
import { MeetingSchema, type Meeting } from "../../packages/protocol/meetings";
import { IdentityError } from "./error";

/** Parts stay far below the store's object cap and its 30-second operation bound. */
export const MEETING_AUDIO_PART_BYTES = 8 * 1024 * 1024;
/** Playback reads this much per request, so seeking never waits for a whole part. */
const READ_BYTES = 1024 * 1024;
type State = "pending" | "stored" | "deleting" | "uncertain";
const parts = (bytes: number) =>
  Math.max(1, Math.ceil(bytes / MEETING_AUDIO_PART_BYTES));
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Keeps the sound of processed meetings in the configured object storage.
 * Upload and processing work on the local file; once a meeting is ready its
 * sound moves to the store in immutable parts and the local copy goes. Without
 * configured storage the sound simply stays on disk.
 */
export class MeetingAudioArchive {
  private storage: () => StorageRuntime = () => ({ state: "disabled" });
  private running?: Promise<void>;
  private again = false;
  private closed = false;
  private retry?: ReturnType<typeof setTimeout>;
  private periodic?: ReturnType<typeof setInterval>;
  constructor(
    private readonly db: DatabaseSync,
    private readonly path: (meeting: Pick<Meeting, "id">) => string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS niaro_meeting_object (
      id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, part INTEGER NOT NULL,
      handle TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','stored','deleting','uncertain'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS niaro_meeting_object_meeting ON niaro_meeting_object(meeting_id,state);`);
    // A put cut off by a restart may still land: delete it rather than trust it.
    db.exec(
      "UPDATE niaro_meeting_object SET state='deleting' WHERE state='pending'",
    );
  }
  /** Connects the object store; until then every sound stays local. */
  attach(storage: () => StorageRuntime) {
    this.storage = storage;
    if (this.periodic) clearInterval(this.periodic);
    this.periodic = setInterval(() => this.kick(), 10 * 60 * 1000);
    this.periodic.unref();
    this.kick();
  }
  private store() {
    const runtime = this.storage();
    return runtime.state === "configured" ? runtime.store : undefined;
  }
  private rows(meetingId: string, state: State) {
    return this.db
      .prepare(
        "SELECT id,part,handle,state FROM niaro_meeting_object WHERE meeting_id=? AND state=? ORDER BY part",
      )
      .all(meetingId, state)
      .map((row) => ({
        id: String(row.id),
        part: Number(row.part),
        handle: JSON.parse(String(row.handle)) as ObjectHandle,
        state: row.state as State,
      }));
  }
  /** The stored parts when they hold the whole sound, else undefined. */
  private complete(meeting: Pick<Meeting, "id" | "bytes">) {
    const stored = this.rows(meeting.id, "stored");
    const count = parts(meeting.bytes);
    if (
      stored.length !== count ||
      stored.some(
        (row, i) =>
          row.part !== i ||
          row.handle.size !==
            Math.min(
              MEETING_AUDIO_PART_BYTES,
              meeting.bytes - i * MEETING_AUDIO_PART_BYTES,
            ),
      )
    )
      return undefined;
    return stored;
  }
  /** True when the sound lives in object storage. */
  stored(meeting: Pick<Meeting, "id" | "bytes">) {
    return !!this.complete(meeting);
  }
  /** Bytes `start`..`end` (inclusive) of a stored sound, read part by part. */
  read(
    meeting: Pick<Meeting, "id" | "bytes">,
    start: number,
    end: number,
  ): Readable | undefined {
    const stored = this.complete(meeting);
    const store = this.store();
    if (!stored) return undefined;
    if (!store) throw new IdentityError(503, "meeting_audio_unavailable");
    async function* body() {
      let at = start;
      while (at <= end) {
        const index = Math.floor(at / MEETING_AUDIO_PART_BYTES);
        const base = index * MEETING_AUDIO_PART_BYTES;
        const part = stored![index]!;
        const to = Math.min(
          end - base,
          part.handle.size - 1,
          at - base + READ_BYTES - 1,
        );
        yield Buffer.from(
          await busyRetry(() =>
            store!.range(part.handle, { start: at - base, end: to }),
          ),
        );
        at = base + to + 1;
      }
    }
    return Readable.from(body());
  }
  /**
   * Puts the sound back on disk for processing. Parts stay in the store, so
   * the next pass only removes the local copy again.
   */
  async restore(meeting: Meeting) {
    const target = this.path(meeting);
    if (existsSync(target)) return target;
    const stored = this.complete(meeting);
    const store = this.store();
    if (!stored || !store || !meeting.sourceHash)
      throw new IdentityError(409, "meeting_audio_unavailable");
    const temporary = `${target}.restore`;
    if (existsSync(temporary)) unlinkSync(temporary);
    const fd = openSync(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    try {
      let offset = 0;
      for (const part of stored) {
        const bytes = await busyRetry(() => store.get(part.handle));
        hash.update(bytes);
        let done = 0;
        while (done < bytes.length)
          done += writeSync(
            fd,
            bytes,
            done,
            bytes.length - done,
            offset + done,
          );
        offset += bytes.length;
      }
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      unlinkSync(temporary);
      throw error;
    }
    closeSync(fd);
    if (hash.digest("hex") !== meeting.sourceHash) {
      unlinkSync(temporary);
      throw new IdentityError(409, "meeting_audio_corrupt");
    }
    renameSync(temporary, target);
    return target;
  }
  /** Marks every object of a meeting for deletion; the next pass erases them. */
  discard(meetingId: string) {
    this.db
      .prepare(
        "UPDATE niaro_meeting_object SET state='deleting' WHERE meeting_id=? AND state IN ('pending','stored')",
      )
      .run(meetingId);
    this.kick();
  }
  /** Runs one archive pass now, or right after the one in progress. */
  kick() {
    if (this.closed) return this.running ?? Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      // Never inside the caller's transaction: start once it has settled.
      await new Promise((ok) => setImmediate(ok));
      try {
        do {
          this.again = false;
          if (!(await this.pass())) this.later();
        } while (this.again && !this.closed);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }
  private later() {
    if (this.retry || this.closed) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.kick();
    }, 30_000);
    this.retry.unref();
  }
  /** One sweep of deletions, then of ready meetings. False when work remains. */
  private async pass() {
    const store = this.store();
    if (!store) return true;
    let settled = true;
    for (const row of this.db
      .prepare(
        "SELECT id,handle FROM niaro_meeting_object WHERE state='deleting'",
      )
      .all()) {
      if (this.closed) return true;
      try {
        await store.delete(JSON.parse(String(row.handle)) as ObjectHandle);
        this.db
          .prepare("DELETE FROM niaro_meeting_object WHERE id=?")
          .run(String(row.id));
      } catch (error) {
        settled = false;
        if (error instanceof StorageError && error.code === "uncertain")
          this.db
            .prepare(
              "UPDATE niaro_meeting_object SET state='uncertain' WHERE id=?",
            )
            .run(String(row.id));
      }
    }
    for (const row of this.db
      .prepare(
        "SELECT value FROM niaro_meeting WHERE json_extract(value,'$.status')='ready' AND json_extract(value,'$.audioDeletedAt') IS NULL",
      )
      .all()) {
      if (this.closed) return true;
      const meeting = MeetingSchema.parse(JSON.parse(String(row.value)));
      if (!existsSync(this.path(meeting))) continue;
      try {
        await this.offload(meeting);
      } catch {
        settled = false;
      }
    }
    return settled;
  }
  private current(meeting: Meeting) {
    const row = this.db
      .prepare("SELECT value FROM niaro_meeting WHERE id=?")
      .get(meeting.id);
    return row ? MeetingSchema.parse(JSON.parse(String(row.value))) : undefined;
  }
  private async offload(meeting: Meeting) {
    const store = this.store()!;
    const path = this.path(meeting);
    if (
      !meeting.sourceHash ||
      !lstatSync(path).isFile() ||
      lstatSync(path).size !== meeting.bytes
    )
      return;
    if (!this.complete(meeting)) {
      const have = new Set(
        this.rows(meeting.id, "stored").map((row) => row.part),
      );
      const fd = openSync(path, "r");
      try {
        // The whole file must match the sealed upload before any part is kept.
        const hash = createHash("sha256");
        for (let i = 0; i < parts(meeting.bytes); i++)
          hash.update(read(fd, i, meeting.bytes));
        if (hash.digest("hex") !== meeting.sourceHash) return;
        for (let i = 0; i < parts(meeting.bytes); i++) {
          if (have.has(i)) continue;
          if (this.closed) return;
          await this.put(store, meeting.id, i, read(fd, i, meeting.bytes));
        }
      } finally {
        closeSync(fd);
      }
    }
    // Processing may have started meanwhile and needs the local file.
    const now = this.current(meeting);
    if (
      now?.status === "ready" &&
      !now.audioDeletedAt &&
      this.complete(now) &&
      existsSync(path)
    )
      unlinkSync(path);
  }
  private async put(
    store: NonNullable<ReturnType<MeetingAudioArchive["store"]>>,
    meetingId: string,
    part: number,
    bytes: Uint8Array,
  ) {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const handle = store.reserve(meetingId, {
      sha256: digest,
      size: bytes.length,
    });
    this.db
      .prepare("INSERT INTO niaro_meeting_object VALUES (?,?,?,?,'pending')")
      .run(handle.id, meetingId, part, JSON.stringify(handle));
    try {
      await busyRetry(() => store.put(handle, bytes));
    } catch (error) {
      const uncertain =
        error instanceof StorageError &&
        (error.outcome === "unknown" || error.code === "uncertain");
      this.db
        .prepare("UPDATE niaro_meeting_object SET state=? WHERE id=?")
        .run(uncertain ? "uncertain" : "deleting", handle.id);
      throw error;
    }
    const kept = this.db
      .prepare(
        "UPDATE niaro_meeting_object SET state='stored' WHERE id=? AND state='pending'",
      )
      .run(handle.id);
    // Deleted while the part was uploading: erase it on the next pass.
    if (!kept.changes)
      this.db
        .prepare("UPDATE niaro_meeting_object SET state='deleting' WHERE id=?")
        .run(handle.id);
  }
  async close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.periodic) clearInterval(this.periodic);
    await this.running;
  }
}
function read(fd: number, index: number, total: number) {
  const offset = index * MEETING_AUDIO_PART_BYTES;
  const piece = Buffer.alloc(
    Math.min(MEETING_AUDIO_PART_BYTES, total - offset),
  );
  let done = 0;
  while (done < piece.length) {
    const n = readSync(fd, piece, done, piece.length - done, offset + done);
    if (!n) throw new IdentityError(409, "meeting_audio_corrupt");
    done += n;
  }
  return piece;
}
/** The store admits two operations at once; attachments may hold them briefly. */
async function busyRetry<T>(run: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (
        !(error instanceof StorageError) ||
        error.code !== "busy" ||
        attempt >= 40
      )
        throw error;
      await wait(150);
    }
  }
}
