import { z } from "zod";
import { ScopeSchema } from "./index";

export const MEETING_PROFILE = "niaro-meetings/1";
export const MEETING_BLOCK_BYTES = 256 * 1024;
export const MEETING_MAX_BYTES = 64 * 1024 * 1024;
export const MEETING_MAX_SECONDS = 7200;
export const MeetingId = z.string().uuid();
export const MeetingCreateSchema = z.strictObject({
  profile: z.literal(MEETING_PROFILE),
  id: MeetingId,
  title: z.string().trim().min(1).max(160),
  recordedAt: z.iso.datetime(),
  language: z.enum(["en", "cs"]),
  mimeType: z.enum([
    "audio/mp4",
    "audio/wav",
    "audio/webm",
    "audio/mpeg",
    "audio/ogg",
  ]),
  bytes: z.number().int().min(1).max(MEETING_MAX_BYTES),
  /**
   * Present only for a two-track recording (the web app's microphone +
   * meeting capture): a stereo file whose left channel is the person
   * recording and whose right channel is everyone else in the call. Each
   * channel is transcribed on its own and labelled with its speaker.
   */
  speakerChannels: z.literal("self-others").optional(),
  /**
   * The person confirmed before recording that the others know. The server
   * stores what the client sends; older clients send nothing.
   */
  consent: z
    .strictObject({
      at: z.iso.datetime(),
      by: z.string().trim().min(1).max(160),
    })
    .optional(),
  /**
   * Who took part and which companies, when known (for example from a
   * calendar event). Only a hint for transcribing names; may be empty.
   */
  attendees: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  companies: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
});
export type MeetingCreate = z.infer<typeof MeetingCreateSchema>;
export const MeetingStatus = z.enum([
  "uploading",
  "sealed",
  "transcribing",
  "analyzing",
  "ready",
  "failed",
  "interrupted",
]);
export const MeetingSchema = MeetingCreateSchema.extend({
  scope: ScopeSchema,
  status: MeetingStatus,
  offset: z.number().int().min(0).max(MEETING_MAX_BYTES),
  durationSeconds: z.number().min(0).max(MEETING_MAX_SECONDS).nullable(),
  sourceHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  failure: z
    .string()
    .regex(/^[a-z_]{1,100}$/)
    .nullable(),
  completedSegments: z.number().int().min(0).max(240),
  processingAttempt: z.number().int().min(0).max(100).default(0),
  /** The owner deleted the sound; the record and transcript stay. */
  audioDeletedAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime(),
});
export type Meeting = z.infer<typeof MeetingSchema>;
export const MeetingSourceSchema = z.strictObject({
  segment: z.number().int().min(0).max(239),
  quote: z.string().min(1).max(600),
});
export const MeetingAnalysisSchema = z.strictObject({
  summary: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(1000),
        source: MeetingSourceSchema,
      }),
    )
    .max(8),
  points: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(600),
        source: MeetingSourceSchema,
      }),
    )
    .max(12),
  tasks: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(600),
        assignee: z.string().min(1).max(160).nullable(),
        due: z.string().min(1).max(160).nullable(),
        source: MeetingSourceSchema,
      }),
    )
    .max(12),
});
export type MeetingAnalysis = z.infer<typeof MeetingAnalysisSchema>;
/** Most timed turns kept for one meeting (two hours of short turns). */
export const MEETING_MAX_UTTERANCES = 6000;
/**
 * One timed turn of a meeting transcribed with timestamps: who spoke
 * ("me" is the person recording, on a two-track recording), from when to
 * when in seconds, and what was said.
 */
export const MeetingUtteranceSchema = z.strictObject({
  start: z.number().min(0).max(MEETING_MAX_SECONDS),
  end: z.number().min(0).max(MEETING_MAX_SECONDS),
  speaker: z.enum(["me", "others", "unknown"]),
  /**
   * With speaker diarization: which of the voices on this track spoke,
   * numbered in the order they first speak ("Speaker 2", "Others 2").
   */
  voice: z.number().int().min(1).max(20).optional(),
  text: z.string().min(1).max(4000),
});
export type MeetingUtterance = z.infer<typeof MeetingUtteranceSchema>;
export const MeetingSegmentSchema = z.strictObject({
  index: z.number().int().min(0).max(239),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  text: z.string().max(4000),
  reviewReasons: z.array(z.enum(["uncertain", "repetition"])).max(2),
  transcriber: z.string().max(160),
  analyzer: z.string().max(160).nullable(),
  analysis: MeetingAnalysisSchema.nullable(),
});
export type MeetingSegment = z.infer<typeof MeetingSegmentSchema>;
/** Longest search in the meeting list (`?q=`); a longer one is refused. */
export const MEETING_SEARCH_MAX_QUERY = 200;
/** Where a searched meeting matched: its name, summary or transcript. */
export const MeetingMatchSchema = z.strictObject({
  meetingId: MeetingId,
  field: z.enum(["title", "summary", "transcript"]),
  /** Plain text around the match; "…" marks a cut. */
  snippet: z.string().min(1).max(400),
  /** Seconds into the recording, for a transcript match. */
  at: z.number().min(0).max(MEETING_MAX_SECONDS).nullable(),
});
export type MeetingMatch = z.infer<typeof MeetingMatchSchema>;
export const MeetingListSchema = z.strictObject({
  profile: z.literal(MEETING_PROFILE),
  scope: ScopeSchema,
  meetings: z.array(MeetingSchema).max(100),
  /** With `include=tasks`: open items per meeting id (absent = none). */
  openTasks: z.record(MeetingId, z.number().int().min(1).max(80)).optional(),
  /** With `q`: where each listed meeting matched, best first. */
  matches: z.array(MeetingMatchSchema).max(100).optional(),
});
export type MeetingList = z.infer<typeof MeetingListSchema>;
/** `PATCH /meetings/:id`: the owner renames a meeting. */
export const MeetingRenameSchema = z.strictObject({
  profile: z.literal(MEETING_PROFILE),
  title: z.string().trim().min(1).max(160),
});
export const MeetingDetailSchema = z.strictObject({
  profile: z.literal(MEETING_PROFILE),
  scope: ScopeSchema,
  meeting: MeetingSchema,
  segments: z.array(MeetingSegmentSchema).max(12),
  next: z.number().int().min(0).max(240).nullable(),
});
export function validateMeetingAnalysis(
  raw: unknown,
  segment: Pick<MeetingSegment, "index" | "text">,
) {
  const analysis = MeetingAnalysisSchema.parse(raw);
  for (const item of [
    ...analysis.summary,
    ...analysis.points,
    ...analysis.tasks,
  ]) {
    if (
      item.source.segment !== segment.index ||
      !segment.text.includes(item.source.quote)
    )
      throw new Error("meeting_source_invalid");
  }
  for (const task of analysis.tasks) {
    if (
      (task.assignee && !task.source.quote.includes(task.assignee)) ||
      (task.due && !task.source.quote.includes(task.due))
    )
      throw new Error("meeting_source_invalid");
  }
  return analysis;
}
/** Speaker labels of a two-track recording, as they appear in its transcript. */
export function meetingSpeakerLabels(language: "en" | "cs") {
  return language === "cs"
    ? { self: "Já", others: "Ostatní", voice: "Mluvčí" }
    : { self: "Me", others: "Others", voice: "Speaker" };
}
/**
 * A turn's speaker as people read it: "Me", "Others", or with diarization
 * the numbered voice ("Speaker 2"); the person recording stays "Me".
 */
export function meetingTurnLabel(
  turn: { speaker: "me" | "others" | "unknown"; voice?: number },
  labels: { self: string; others: string; voice: string; unknown?: string },
) {
  if (turn.speaker === "me") return labels.self;
  if (turn.voice) return `${labels.voice} ${turn.voice}`;
  return turn.speaker === "others" ? labels.others : (labels.unknown ?? "");
}
// The app names a recording nobody named "Meeting · <date>" ("Schůzka · …"
// in Czech; earlier builds wrote "Plan a meeting · …"). Only such titles may
// be replaced by a name generated from the meeting; a person's name stays.
const AUTOMATIC_TITLE =
  /^(Meeting|Schůzka|Plan a meeting|Naplánovat schůzku) · /u;
export function isAutomaticMeetingTitle(title: string) {
  return AUTOMATIC_TITLE.test(title);
}
/** A generated name as people scan it: at most four words, no quotes or end mark. */
export function shortMeetingTitle(raw: string) {
  return raw
    .replace(/["'„“”‚‘’«»]/gu, "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ")
    .replace(/[\s.,;:!?…–—-]+$/u, "")
    .slice(0, 60)
    .trim();
}
