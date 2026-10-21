import { HumanTaskStore } from "./human-task-store";
import {
  MEETING_RECORD_PROFILE,
  MEETING_CONSOLIDATION_VERSION,
  MeetingRecordSchema,
  validateMeetingSynthesis,
  type MeetingSynthesis,
} from "../../packages/protocol/meeting-record";
import { createHash } from "node:crypto";
import {
  createReadStream,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Scope } from "../../packages/protocol";
import {
  MEETING_BLOCK_BYTES,
  MEETING_PROFILE,
  MeetingCreateSchema,
  MeetingSchema,
  MeetingSegmentSchema,
  isAutomaticMeetingTitle,
  type MeetingCreate,
  type Meeting,
  type MeetingSegment,
  type MeetingUtterance,
  MeetingUtteranceSchema,
  MEETING_MAX_UTTERANCES,
} from "../../packages/protocol/meetings";
import { z } from "zod";
import {
  MEETING_CHUNK_SECONDS,
  type MeetingChunkResult,
} from "./meeting-transcript";
import { IdentityError } from "./error";

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const owner = (scope: Scope) =>
  JSON.stringify([
    scope.connectionId,
    scope.serverId,
    scope.workspaceId,
    scope.userId,
  ]);
const FOLD_FUNCTION = "niaro_meeting_fold";
const fold = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
/** A LIKE pattern for folded text containing `needle`. */
const likePattern = (needle: string) =>
  `%${fold(needle).replace(/[\\%_]/g, (c) => "\\" + c)}%`;
/** About `size` characters of `text` around the folded match at `index`. */
function snippetAround(text: string, needle: string, size = 160) {
  const flat = text.replace(/\s+/gu, " ").trim();
  // Folding keeps one character per base letter, so offsets stay close.
  const index = Math.max(0, fold(flat).indexOf(fold(needle)));
  const start = Math.max(0, index - Math.floor(size / 3));
  const end = Math.min(flat.length, start + size);
  return (
    (start > 0 ? "…" : "") +
    flat.slice(start, end).trim() +
    (end < flat.length ? "…" : "")
  ).slice(0, 400);
}
export type MeetingSearchHit = {
  meeting: Meeting;
  field: "title" | "summary" | "transcript";
  snippet: string;
  at: number | null;
  summary: string;
};
/**
 * A meeting task's detail in Tasks: its context from the meeting (or its
 * first quote) and which meeting it came from, with the meeting's date.
 */
export function meetingTaskDetail(
  task: MeetingSynthesis["tasks"][number],
  meeting: Pick<Meeting, "title" | "recordedAt" | "language">,
  timeZone = "UTC",
) {
  let date: string;
  try {
    date = new Intl.DateTimeFormat(
      meeting.language === "cs" ? "cs-CZ" : "en-GB",
      { timeZone, day: "numeric", month: "numeric", year: "numeric" },
    ).format(new Date(meeting.recordedAt));
  } catch {
    date = meeting.recordedAt.slice(0, 10);
  }
  const context = (task.context ?? `„${task.sources[0]!.quote}“`).trim();
  const origin =
    meeting.language === "cs"
      ? `Ze schůzky „${meeting.title}“ (${date}).`
      : `From the meeting "${meeting.title}" (${date}).`;
  return `${context}\n${origin}`.slice(0, 2000);
}
export class MeetingStore {
  readonly directory: string;
  readonly humanTasks: HumanTaskStore;
  constructor(
    private db: DatabaseSync,
    directory?: string,
  ) {
    const file = String(db.prepare("PRAGMA database_list").get()!.file);
    this.directory = directory ?? join(dirname(file), "meeting-audio");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink())
      throw new Error("meeting_storage_invalid");
    db.exec(`CREATE TABLE IF NOT EXISTS niaro_meeting (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, value TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS niaro_meeting_owner ON niaro_meeting(owner);
    CREATE TABLE IF NOT EXISTS niaro_meeting_block (
      id TEXT NOT NULL REFERENCES niaro_meeting(id) ON DELETE CASCADE,
      offset INTEGER NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL,
      PRIMARY KEY(id,offset)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS niaro_meeting_segment (
      id TEXT NOT NULL REFERENCES niaro_meeting(id) ON DELETE CASCADE,
      segment INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,segment)
    ) STRICT;`);
    this.humanTasks = new HumanTaskStore(db);
    // Search ignores case and accents ("stastny" finds "Šťastný").
    db.function(FOLD_FUNCTION, { deterministic: true }, (value) =>
      typeof value === "string" ? fold(value) : null,
    );
    db.exec(`CREATE TABLE IF NOT EXISTS niaro_meeting_synthesis(id TEXT NOT NULL REFERENCES niaro_meeting(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,key)) STRICT;
    CREATE TABLE IF NOT EXISTS niaro_meeting_record(id TEXT PRIMARY KEY REFERENCES niaro_meeting(id) ON DELETE CASCADE, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS niaro_meeting_chunk(id TEXT NOT NULL REFERENCES niaro_meeting(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,key)) STRICT;
    CREATE TABLE IF NOT EXISTS niaro_meeting_utterances(id TEXT PRIMARY KEY REFERENCES niaro_meeting(id) ON DELETE CASCADE, value TEXT NOT NULL) STRICT;`);
    // A paid dispatch may have completed remotely. Never replay it on boot.
    for (const row of db.prepare("SELECT value FROM niaro_meeting").all()) {
      const meeting = MeetingSchema.parse(JSON.parse(String(row.value)));
      if (meeting.status === "transcribing" || meeting.status === "analyzing")
        this.save({
          ...meeting,
          status: "interrupted",
          failure: "meeting_processing_interrupted",
        });
    }
  }
  private save(meeting: Meeting) {
    const next = MeetingSchema.parse({
      ...meeting,
      updatedAt: new Date().toISOString(),
    });
    this.db
      .prepare("UPDATE niaro_meeting SET value=? WHERE id=?")
      .run(JSON.stringify(next), next.id);
    return next;
  }
  get(scope: Scope, id: string) {
    const row = this.db
      .prepare("SELECT value FROM niaro_meeting WHERE id=? AND owner=?")
      .get(id, owner(scope));
    if (!row) throw new IdentityError(404, "meeting_not_found");
    return MeetingSchema.parse(JSON.parse(String(row.value)));
  }
  list(scope: Scope) {
    return this.db
      .prepare("SELECT value FROM niaro_meeting WHERE owner=? ORDER BY id")
      .all(owner(scope))
      .map((row) => MeetingSchema.parse(JSON.parse(String(row.value))))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }
  /** The newest meetings with their summary, for the overview (no transcripts). */
  recent(scope: Scope, limit: number) {
    const open = this.openTasks(scope);
    return this.list(scope)
      .slice(0, Math.max(0, Math.min(8, limit)))
      .map((meeting) => {
        const row = this.db
          .prepare("SELECT value FROM niaro_meeting_record WHERE id=?")
          .get(meeting.id);
        let analysis: { summary?: unknown } | undefined;
        try {
          analysis = row
            ? (JSON.parse(String(row.value)) as { analysis?: typeof analysis })
                .analysis
            : undefined;
        } catch {
          analysis = undefined;
        }
        const summary =
          typeof analysis?.summary === "string"
            ? analysis.summary.trim().slice(0, 400)
            : "";
        return {
          id: meeting.id,
          title: meeting.title,
          recordedAt: meeting.recordedAt,
          status:
            meeting.status === "ready"
              ? ("ready" as const)
              : meeting.status === "failed" || meeting.status === "interrupted"
                ? ("failed" as const)
                : ("processing" as const),
          ...(summary ? { summary } : {}),
          // Only what is still open; resolved items no longer wait.
          tasks: Math.min(80, open.get(meeting.id)?.count ?? 0),
          ...(open.get(meeting.id)?.next
            ? { next: open.get(meeting.id)!.next.slice(0, 160) }
            : {}),
        };
      });
  }
  create(scope: Scope, raw: MeetingCreate) {
    const input = MeetingCreateSchema.parse(raw);
    const old = this.db
      .prepare("SELECT owner,value FROM niaro_meeting WHERE id=?")
      .get(input.id);
    if (old) {
      const stored = this.get(scope, input.id);
      // A replayed upload still carries the automatic title that processing
      // has since replaced with a generated name; that is the same meeting.
      const previous =
        isAutomaticMeetingTitle(input.title) &&
        !isAutomaticMeetingTitle(stored.title)
          ? { ...stored, title: input.title }
          : stored;
      if (
        JSON.stringify(
          MeetingCreateSchema.parse(
            Object.fromEntries(
              Object.keys(input).map((key) => [
                key,
                previous[key as keyof Meeting],
              ]),
            ),
          ),
        ) !== JSON.stringify(input)
      )
        throw new IdentityError(409, "meeting_upload_conflict");
      if (previous.offset === 0 && !existsSync(this.path(previous)))
        closeSync(openSync(this.path(previous), "wx", 0o600));
      return stored;
    }
    const all = this.list(scope);
    if (
      all.length >= 100 ||
      // Only kept sound counts; transcripts and records never do.
      all.reduce((n, m) => n + (m.audioDeletedAt ? 0 : m.bytes), 0) +
        input.bytes >
        512 * 1024 * 1024 ||
      Number(
        this.db.prepare("SELECT count(*) AS n FROM niaro_meeting").get()!.n,
      ) >= 1000
    )
      throw new IdentityError(429, "meeting_storage_limit");
    const meeting = MeetingSchema.parse({
      ...input,
      scope,
      offset: 0,
      status: "uploading",
      durationSeconds: null,
      sourceHash: null,
      completedSegments: 0,
      failure: null,
      updatedAt: new Date().toISOString(),
    });
    const path = this.path(meeting);
    if (existsSync(path)) {
      if (!lstatSync(path).isFile() || lstatSync(path).size !== 0)
        throw new IdentityError(409, "meeting_audio_corrupt");
      unlinkSync(path); // Unacknowledged empty create from a crash before the SQLite insert.
    }
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
    try {
      this.db
        .prepare("INSERT INTO niaro_meeting VALUES (?,?,?)")
        .run(input.id, owner(scope), JSON.stringify(meeting));
    } catch (error) {
      unlinkSync(this.path(meeting));
      throw error;
    }
    return meeting;
  }
  path(meeting: Pick<Meeting, "id">) {
    // All paths originate in a parsed UUID, never a filename from HTTP.
    const id = MeetingCreateSchema.shape.id.parse(meeting.id);
    return join(this.directory, id + ".audio");
  }
  append(scope: Scope, id: string, offset: number, bytes: Uint8Array) {
    const m = this.get(scope, id);
    if (
      m.status !== "uploading" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      bytes.length < 1 ||
      bytes.length > MEETING_BLOCK_BYTES ||
      offset + bytes.length > m.bytes
    )
      throw new IdentityError(409, "meeting_upload_conflict");
    const hash = digest(bytes);
    if (offset < m.offset) {
      const block = this.db
        .prepare(
          "SELECT size,hash FROM niaro_meeting_block WHERE id=? AND offset=?",
        )
        .get(id, offset);
      if (!block || block.size !== bytes.length || block.hash !== hash)
        throw new IdentityError(409, "meeting_upload_conflict");
      const fd = openSync(this.path(m), "r");
      try {
        const recorded = Buffer.alloc(bytes.length);
        if (
          readSync(fd, recorded, 0, recorded.length, offset) !==
            recorded.length ||
          digest(recorded) !== hash
        )
          throw new IdentityError(409, "meeting_audio_corrupt");
      } finally {
        closeSync(fd);
      }
      return m;
    }
    if (offset !== m.offset)
      throw new IdentityError(409, "meeting_upload_conflict");
    const fd = openSync(this.path(m), "r+");
    try {
      let done = 0;
      while (done < bytes.length)
        done += writeSync(fd, bytes, done, bytes.length - done, offset + done);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.db.exec("SAVEPOINT meeting_append");
    try {
      this.db
        .prepare("INSERT INTO niaro_meeting_block VALUES (?,?,?,?)")
        .run(id, offset, bytes.length, hash);
      const next = this.save({ ...m, offset: offset + bytes.length });
      this.db.exec("RELEASE meeting_append");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK TO meeting_append; RELEASE meeting_append");
      throw error;
    }
  }
  async hash(scope: Scope, id: string) {
    const m = this.get(scope, id);
    if (
      m.offset !== m.bytes ||
      !existsSync(this.path(m)) ||
      lstatSync(this.path(m)).size !== m.bytes
    )
      throw new IdentityError(409, "meeting_upload_incomplete");
    const hash = createHash("sha256");
    for await (const block of createReadStream(this.path(m)))
      hash.update(block);
    return hash.digest("hex");
  }
  seal(scope: Scope, id: string, hash: string) {
    const m = this.get(scope, id);
    if (m.sourceHash) {
      if (m.sourceHash !== hash)
        throw new IdentityError(409, "meeting_audio_corrupt");
      return m;
    }
    if (m.status !== "uploading" || m.offset !== m.bytes)
      throw new IdentityError(409, "meeting_upload_incomplete");
    return this.save({ ...m, sourceHash: hash, status: "sealed" });
  }
  /** The owner's own name for a meeting; processing never replaces it. */
  rename(scope: Scope, id: string, title: string) {
    const meeting = this.get(scope, id);
    return this.save({ ...meeting, title: title.trim() });
  }
  /** Deletes only the sound of a processed meeting; notes and transcript stay. */
  deleteAudio(scope: Scope, id: string) {
    const meeting = this.get(scope, id);
    if (meeting.audioDeletedAt) return meeting;
    if (meeting.status !== "ready")
      throw new IdentityError(409, "meeting_processing_busy");
    if (existsSync(this.path(meeting))) unlinkSync(this.path(meeting));
    this.db.prepare("DELETE FROM niaro_meeting_block WHERE id=?").run(id);
    return this.save({ ...meeting, audioDeletedAt: new Date().toISOString() });
  }
  /** The sealed sound of a meeting, for the owner's player. */
  audio(scope: Scope, id: string) {
    const meeting = this.get(scope, id);
    const path = this.path(meeting);
    if (
      meeting.audioDeletedAt ||
      !meeting.sourceHash ||
      !existsSync(path) ||
      !lstatSync(path).isFile() ||
      lstatSync(path).size !== meeting.bytes
    )
      throw new IdentityError(404, "meeting_audio_not_found");
    return { path, bytes: meeting.bytes, mimeType: meeting.mimeType };
  }
  /** The record's summary, or "" for a meeting without one. */
  summary(id: string) {
    const row = this.db
      .prepare(
        "SELECT json_extract(value,'$.analysis.summary') AS summary FROM niaro_meeting_record WHERE id=?",
      )
      .get(id);
    return typeof row?.summary === "string" ? row.summary.trim() : "";
  }
  /**
   * The owner's meetings whose name, summary or transcript contains `query`
   * (case and accents ignored), newest first, with where each matched.
   * Bounded by the owner's 100 meetings; at most `limit` results.
   */
  search(
    scope: Scope,
    query: string,
    options: { from?: string; to?: string; limit?: number } = {},
  ): MeetingSearchHit[] {
    const needle = query.trim().slice(0, 200);
    const limit = Math.max(1, Math.min(100, options.limit ?? 100));
    const meetings = this.list(scope).filter(
      (m) =>
        (!options.from || m.recordedAt >= options.from) &&
        (!options.to || m.recordedAt <= options.to),
    );
    if (!needle) return [];
    const pattern = likePattern(needle);
    const segment = this.db.prepare(
      `SELECT json_extract(value,'$.text') AS text, json_extract(value,'$.startSeconds') AS start FROM niaro_meeting_segment WHERE id=? AND ${FOLD_FUNCTION}(json_extract(value,'$.text')) LIKE ? ESCAPE '\\' ORDER BY segment LIMIT 1`,
    );
    const hits: MeetingSearchHit[] = [];
    for (const meeting of meetings) {
      if (hits.length >= limit) break;
      const summary = this.summary(meeting.id);
      if (fold(meeting.title).includes(fold(needle))) {
        hits.push({
          meeting,
          field: "title",
          snippet: (summary ? snippetAround(summary, "") : meeting.title).slice(
            0,
            400,
          ),
          at: null,
          summary,
        });
        continue;
      }
      if (summary && fold(summary).includes(fold(needle))) {
        hits.push({
          meeting,
          field: "summary",
          snippet: snippetAround(summary, needle),
          at: null,
          summary,
        });
        continue;
      }
      const row = segment.get(meeting.id, pattern);
      if (row && typeof row.text === "string")
        hits.push({
          meeting,
          field: "transcript",
          snippet: snippetAround(row.text, needle),
          at: Number(row.start) || 0,
          summary,
        });
    }
    return hits;
  }
  /** Open items per meeting, with the first one's title: the next step. */
  openTasks(scope: Scope) {
    return this.humanTasks.openByMeeting(scope);
  }
  update(
    scope: Scope,
    id: string,
    patch: Partial<
      Pick<
        Meeting,
        "status" | "failure" | "durationSeconds" | "processingAttempt" | "title"
      >
    >,
  ) {
    return this.save({ ...this.get(scope, id), ...patch });
  }
  segments(scope: Scope, id: string, after = 0) {
    this.get(scope, id);
    return this.db
      .prepare(
        "SELECT value FROM niaro_meeting_segment WHERE id=? AND segment>=? ORDER BY segment LIMIT 13",
      )
      .all(id, after)
      .map((row) => MeetingSegmentSchema.parse(JSON.parse(String(row.value))));
  }
  segment(scope: Scope, id: string, index: number) {
    this.get(scope, id);
    const row = this.db
      .prepare(
        "SELECT value FROM niaro_meeting_segment WHERE id=? AND segment=?",
      )
      .get(id, index);
    return row
      ? MeetingSegmentSchema.parse(JSON.parse(String(row.value)))
      : undefined;
  }
  putSegment(scope: Scope, id: string, segment: MeetingSegment) {
    const m = this.get(scope, id);
    const value = MeetingSegmentSchema.parse(segment);
    this.db
      .prepare(
        "INSERT INTO niaro_meeting_segment VALUES (?,?,?) ON CONFLICT(id,segment) DO UPDATE SET value=excluded.value",
      )
      .run(id, value.index, JSON.stringify(value));
    const n = Number(
      this.db
        .prepare("SELECT count(*) AS n FROM niaro_meeting_segment WHERE id=?")
        .get(id)!.n,
    );
    return this.save({ ...m, completedSegments: n });
  }
  allSegments(scope: Scope, id: string) {
    this.get(scope, id);
    return this.db
      .prepare(
        "SELECT value FROM niaro_meeting_segment WHERE id=? ORDER BY segment LIMIT 241",
      )
      .all(id)
      .map((row) => MeetingSegmentSchema.parse(JSON.parse(String(row.value))));
  }
  /** The extraction model's saved raw output, before source validation. */
  synthesis(scope: Scope, id: string, key: string): unknown {
    this.get(scope, id);
    const row = this.db
      .prepare("SELECT value FROM niaro_meeting_synthesis WHERE id=? AND key=?")
      .get(id, key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  putSynthesis(scope: Scope, id: string, key: string, raw: unknown) {
    this.get(scope, id);
    const value = JSON.stringify(raw ?? null);
    // A paid result is kept as it came; only its size is bounded.
    if (value.length > 512 * 1024)
      throw new Error("meeting_consolidation_limit");
    this.db
      .prepare(
        "INSERT INTO niaro_meeting_synthesis VALUES (?,?,?) ON CONFLICT(id,key) DO NOTHING",
      )
      .run(id, key, value);
    return this.synthesis(scope, id, key);
  }
  /** Whether part of the meeting was transcribed in timestamped chunks. */
  hasChunks(scope: Scope, id: string) {
    this.get(scope, id);
    return !!this.db
      .prepare("SELECT 1 FROM niaro_meeting_chunk WHERE id=? LIMIT 1")
      .get(id);
  }
  /** The chunk size the saved chunks were cut at (their keys start with it). */
  chunkSeconds(scope: Scope, id: string) {
    this.get(scope, id);
    const row = this.db
      .prepare("SELECT key FROM niaro_meeting_chunk WHERE id=? LIMIT 1")
      .get(id);
    const size = row ? Number(String(row.key).split(":")[0]) : NaN;
    return Number.isInteger(size) &&
      size >= MEETING_CHUNK_SECONDS.min &&
      size <= MEETING_CHUNK_SECONDS.max
      ? size
      : undefined;
  }
  /** One transcribed chunk, saved so a retry never pays for it again. */
  chunk(scope: Scope, id: string, key: string) {
    this.get(scope, id);
    const row = this.db
      .prepare("SELECT value FROM niaro_meeting_chunk WHERE id=? AND key=?")
      .get(id, key);
    return row
      ? (JSON.parse(String(row.value)) as MeetingChunkResult)
      : undefined;
  }
  putChunk(scope: Scope, id: string, key: string, value: MeetingChunkResult) {
    this.get(scope, id);
    if (
      (this.db
        .prepare("SELECT count(*) AS n FROM niaro_meeting_chunk WHERE id=?")
        .get(id)!.n as number) >= 400
    )
      throw new Error("meeting_transcript_limit");
    this.db
      .prepare(
        "INSERT INTO niaro_meeting_chunk VALUES (?,?,?) ON CONFLICT(id,key) DO UPDATE SET value=excluded.value",
      )
      .run(id, key, JSON.stringify(value));
  }
  /** The timed turns of a meeting transcribed with timestamps. */
  utterances(scope: Scope, id: string) {
    this.get(scope, id);
    const row = this.db
      .prepare("SELECT value FROM niaro_meeting_utterances WHERE id=?")
      .get(id);
    if (!row) return undefined;
    const value = JSON.parse(String(row.value)) as {
      utterances: unknown;
      language?: string;
    };
    return {
      utterances: z
        .array(MeetingUtteranceSchema)
        .max(MEETING_MAX_UTTERANCES)
        .parse(value.utterances),
      ...(value.language ? { language: value.language } : {}),
    };
  }
  /**
   * The finished transcript of a timestamped meeting: its turns and the
   * minute segments derived from them, saved together. The chunk
   * checkpoints are no longer needed afterwards.
   */
  putTranscript(
    scope: Scope,
    id: string,
    segments: MeetingSegment[],
    utterances: MeetingUtterance[],
    language?: string,
  ) {
    this.get(scope, id);
    const turns = z
      .array(MeetingUtteranceSchema)
      .max(MEETING_MAX_UTTERANCES)
      .parse(utterances);
    this.db.exec("SAVEPOINT meeting_transcript");
    try {
      this.db.prepare("DELETE FROM niaro_meeting_segment WHERE id=?").run(id);
      for (const segment of segments) this.putSegment(scope, id, segment);
      this.db
        .prepare(
          "INSERT INTO niaro_meeting_utterances VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        )
        .run(
          id,
          JSON.stringify({
            utterances: turns,
            ...(language ? { language: language.slice(0, 32) } : {}),
          }),
        );
      this.db.prepare("DELETE FROM niaro_meeting_chunk WHERE id=?").run(id);
      this.db.exec("RELEASE meeting_transcript");
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO meeting_transcript; RELEASE meeting_transcript",
      );
      throw error;
    }
  }
  /**
   * Deletes the sound of processed meetings older than `days` (by when
   * their record was published; else their last change), for every owner. Transcripts, records and tasks
   * stay; the meeting shows its sound as deleted. 0 keeps sound forever.
   */
  sweepAudio(days: number, now = Date.now()) {
    if (!(days > 0)) return 0;
    const before = now - days * 24 * 60 * 60 * 1000;
    let deleted = 0;
    for (const row of this.db
      .prepare(
        "SELECT m.value, json_extract(r.value,'$.publishedAt') AS published FROM niaro_meeting m LEFT JOIN niaro_meeting_record r ON r.id=m.id WHERE json_extract(m.value,'$.status')='ready' AND json_extract(m.value,'$.audioDeletedAt') IS NULL",
      )
      .all()) {
      const meeting = MeetingSchema.parse(JSON.parse(String(row.value)));
      const ready =
        typeof row.published === "string"
          ? Date.parse(row.published)
          : Date.parse(meeting.updatedAt);
      if (!(ready <= before)) continue;
      if (existsSync(this.path(meeting))) unlinkSync(this.path(meeting));
      this.db
        .prepare("DELETE FROM niaro_meeting_block WHERE id=?")
        .run(meeting.id);
      this.save({ ...meeting, audioDeletedAt: new Date(now).toISOString() });
      deleted++;
    }
    return deleted;
  }
  record(scope: Scope, id: string) {
    const meeting = this.get(scope, id),
      segments = this.allSegments(scope, id);
    const expected =
      meeting.durationSeconds === null
        ? null
        : Math.ceil(meeting.durationSeconds / 60);
    const complete =
      expected !== null &&
      expected > 0 &&
      segments.length === expected &&
      segments.every(
        (s, index) =>
          s.index === index &&
          s.startSeconds === index * 60 &&
          Math.abs(
            s.endSeconds - Math.min(meeting.durationSeconds!, (index + 1) * 60),
          ) < 0.001,
      );
    const row = this.db
      .prepare("SELECT value FROM niaro_meeting_record WHERE id=?")
      .get(id);
    const saved = row ? JSON.parse(String(row.value)) : null;
    const transcriptDigest = digest(
      Buffer.from(
        JSON.stringify(
          segments.map((s) => ({
            index: s.index,
            text: s.text,
            start: s.startSeconds,
            end: s.endSeconds,
          })),
        ),
      ),
    );
    if (
      saved &&
      (saved.transcriptDigest !== transcriptDigest ||
        saved.sourceHash !== meeting.sourceHash)
    )
      throw new IdentityError(409, "meeting_source_invalid");
    const turns = this.utterances(scope, id);
    return MeetingRecordSchema.parse({
      profile: MEETING_RECORD_PROFILE,
      scope,
      meeting,
      transcript: segments
        .map((s) => s.text.trim())
        .filter(Boolean)
        .join(" "),
      transcriptComplete: complete,
      reviewReasons: [...new Set(segments.flatMap((s) => s.reviewReasons))],
      analysis: saved?.analysis ?? null,
      analyzer: saved?.analyzer ?? null,
      transcriptDigest,
      recordDigest: saved?.recordDigest ?? null,
      humanTaskIds: saved?.humanTaskIds ?? [],
      ...(turns
        ? {
            utterances: turns.utterances,
            ...(turns.language ? { detectedLanguage: turns.language } : {}),
          }
        : {}),
    });
  }
  publishRecord(
    scope: Scope,
    id: string,
    raw: MeetingSynthesis,
    analyzer: string,
    options: { timeZone?: string } = {},
  ) {
    const prior = this.record(scope, id);
    if (prior.analysis) return prior;
    if (!prior.transcriptComplete)
      throw new IdentityError(409, "meeting_transcript_incomplete");
    const analysis = validateMeetingSynthesis(raw, {
      segments: this.allSegments(scope, id),
    });
    const recordDigest = digest(
      Buffer.from(
        JSON.stringify([
          MEETING_CONSOLIDATION_VERSION,
          prior.meeting.sourceHash,
          prior.transcriptDigest,
          analysis,
        ]),
      ),
    );
    this.db.exec("SAVEPOINT meeting_publish");
    try {
      const humanTaskIds = analysis.tasks.map((task, index) => {
        const taskId = `meeting:${id}:${index}`;
        this.humanTasks.create(
          scope,
          taskId,
          {
            title: task.text,
            detail: meetingTaskDetail(task, prior.meeting, options.timeZone),
            assignee: task.assignee,
            due: task.due,
            ...(task.dueDate ? { dueDate: task.dueDate } : {}),
          },
          {
            kind: "meeting",
            meetingId: id,
            meetingTitle: prior.meeting.title,
            recordDigest,
            sources: task.sources,
          },
        );
        return taskId;
      });
      this.db.prepare("INSERT INTO niaro_meeting_record VALUES (?,?)").run(
        id,
        JSON.stringify({
          analysis,
          analyzer,
          recordDigest,
          transcriptDigest: prior.transcriptDigest,
          sourceHash: prior.meeting.sourceHash,
          humanTaskIds,
          publishedAt: new Date().toISOString(),
        }),
      );
      this.update(scope, id, { status: "ready", failure: null });
      this.db.exec("RELEASE meeting_publish");
      return this.record(scope, id);
    } catch (error) {
      this.db.exec("ROLLBACK TO meeting_publish; RELEASE meeting_publish");
      throw error;
    }
  }
  delete(scope: Scope, id: string) {
    const m = this.get(scope, id);
    if (["transcribing", "analyzing"].includes(m.status))
      throw new IdentityError(409, "meeting_processing_busy");
    // Unlink first: a filesystem failure must not lose the deletion handle.
    if (existsSync(this.path(m))) unlinkSync(this.path(m));
    this.humanTasks.deleteMeeting(scope, id);
    this.db.prepare("DELETE FROM niaro_meeting_record WHERE id=?").run(id);
    this.db.prepare("DELETE FROM niaro_meeting_synthesis WHERE id=?").run(id);
    this.db.prepare("DELETE FROM niaro_meeting_segment WHERE id=?").run(id);
    this.db.prepare("DELETE FROM niaro_meeting_chunk WHERE id=?").run(id);
    this.db.prepare("DELETE FROM niaro_meeting_utterances WHERE id=?").run(id);
    this.db.prepare("DELETE FROM niaro_meeting_block WHERE id=?").run(id);
    this.db.prepare("DELETE FROM niaro_meeting WHERE id=?").run(id);
    return { profile: MEETING_PROFILE, scope, deleted: id };
  }
}
