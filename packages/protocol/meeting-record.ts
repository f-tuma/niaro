import { z } from "zod";
import { ScopeSchema } from "./index";
import { DateTimeInput } from "./internal-plugins";
import {
  MEETING_MAX_SECONDS,
  MeetingSchema,
  MeetingSourceSchema,
  MeetingUtteranceSchema,
  MEETING_MAX_UTTERANCES,
  type MeetingUtterance,
} from "./meetings";
import { locateQuote, normalizeQuote, quoteMentions } from "./meeting-quotes";
/** Records with structured notes and utterances; `/1` records still parse. */
export const MEETING_RECORD_PROFILE = "niaro-meeting-record/2";
export const MEETING_RECORD_PROFILES = [
  "niaro-meeting-record/1",
  MEETING_RECORD_PROFILE,
] as const;
export const MEETING_CONSOLIDATION_VERSION = "whole-meeting/3";
/** The analysis format: absent (1) or 2 with decisions, open questions and task owners/times. */
export const MEETING_ANALYSIS_VERSION = 2;
export const MEETING_SYNTHESIS_INPUT_CHARS = 1000000;
export const MEETING_SYNTHESIS_OUTPUT_CHARS = 96000;
const sources = z.array(MeetingSourceSchema).min(1).max(4);
/** Seconds into the meeting where the first cited words were said. */
const at = z.number().min(0).max(MEETING_MAX_SECONDS);
/** A resolved deadline: a local date, or a local time with its offset. */
export const MeetingDueDate = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z))?$/,
  );
const note = z.strictObject({
  text: z.string().min(1).max(600),
  sources,
  at: at.optional(),
});
export const MeetingSynthesisSchema = z
  .strictObject({
    /** Absent in records made before structured notes. */
    version: z.literal(MEETING_ANALYSIS_VERSION).optional(),
    summary: z.string().max(2400),
    summarySources: z.array(MeetingSourceSchema).max(32),
    points: z.array(note).max(24),
    decisions: z.array(note).max(40).optional(),
    tasks: z
      .array(
        z.strictObject({
          text: z.string().min(1).max(1000),
          /** Who does it as said; null for the person recording ("me"). */
          assignee: z.string().min(1).max(160).nullable(),
          /** The deadline as said. */
          due: z.string().min(1).max(160).nullable(),
          sources,
          /** "me" (the person recording), a name as said, or null. */
          owner: z.string().min(1).max(160).nullable().optional(),
          /** `due` resolved against the meeting's date and time zone. */
          dueDate: MeetingDueDate.nullable().optional(),
          at: at.optional(),
          /** One or two sentences of context from the meeting. */
          context: z.string().max(400).optional(),
        }),
      )
      .max(80),
    openQuestions: z.array(note).max(40).optional(),
    overflow: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (JSON.stringify(value).length > MEETING_SYNTHESIS_OUTPUT_CHARS)
      ctx.addIssue({ code: "custom", message: "meeting_consolidation_limit" });
  });
export type MeetingSynthesis = z.infer<typeof MeetingSynthesisSchema>;
export type MeetingTask = MeetingSynthesis["tasks"][number];

const draftSources = z
  .array(
    z.object({
      segment: z.number().int().min(0).max(239),
      quote: z.string().min(1).max(1200),
    }),
  )
  .max(8);
const draftNote = z.object({
  text: z.string().min(1).max(600),
  sources: draftSources,
});
/** A deadline the model interpreted; the server does the calendar arithmetic. */
export const MeetingDueWhenSchema = z.strictObject({
  when: DateTimeInput.shape.when,
  time: DateTimeInput.shape.time,
});
/**
 * What the extraction model returns. Lenient: sources are repaired or
 * dropped afterwards and a malformed optional field is ignored, so one
 * imperfect detail never discards a paid whole-meeting result.
 */
export const MeetingSynthesisDraftSchema = z.object({
  summary: z.string().max(2400),
  summarySources: z.array(draftSources.element).max(32),
  points: z.array(draftNote).max(24),
  decisions: z.array(draftNote).max(40).default([]),
  tasks: z
    .array(
      // Loose: a model that still answers with `assignee` keeps its owner.
      z.looseObject({
        text: z.string().min(1).max(1000),
        owner: z.string().min(1).max(160).nullable().default(null),
        due: z.string().min(1).max(160).nullable().default(null),
        dueWhen: MeetingDueWhenSchema.nullable().default(null).catch(null),
        context: z.string().max(400).nullable().default(null).catch(null),
        sources: draftSources,
      }),
    )
    .max(80),
  openQuestions: z.array(draftNote).max(40).default([]),
  overflow: z.boolean(),
});
export type MeetingSynthesisDraft = z.infer<typeof MeetingSynthesisDraftSchema>;
/** Anything validation accepts: a model draft, or an already validated record. */
const looseSource = z.object({
  segment: z.number().int().min(0).max(239),
  quote: z.string().max(4000),
});
const looseNote = z.object({
  text: z.string().min(1).max(600),
  sources: z.array(looseSource).max(32),
  at: z.number().optional(),
});
const SynthesisInputSchema = z.object({
  summary: z.string().max(2400),
  summarySources: z.array(looseSource).max(64),
  points: z.array(looseNote).max(24),
  decisions: z.array(looseNote).max(40).optional(),
  tasks: z
    .array(
      z.object({
        text: z.string().min(1).max(1000),
        owner: z.string().max(160).nullable().optional(),
        assignee: z.string().max(160).nullable().optional(),
        due: z.string().max(160).nullable().optional(),
        dueWhen: z.unknown().optional(),
        dueDate: z.string().nullable().optional(),
        at: z.number().optional(),
        context: z.string().nullable().optional(),
        sources: z.array(looseSource).max(32),
      }),
    )
    .max(80),
  openQuestions: z.array(looseNote).max(40).optional(),
  overflow: z.boolean(),
});
export type MeetingConsolidationInput = {
  segments: { index: number; text: string }[];
  /**
   * A two-track recording: transcript lines starting with `self:` are the
   * person recording, lines starting with `others:` the other participants.
   * With diarization, `voice` numbered ("Speaker 2:") is one participant.
   */
  speakers?: { self: string; others: string; voice?: string };
  /** What is known about the meeting; dates are interpreted against `date`. */
  meeting?: {
    title: string;
    /** The meeting's local date, YYYY-MM-DD, and weekday (1 = Monday). */
    date: string;
    weekday: number;
    timeZone: string;
    attendees?: string[];
    companies?: string[];
  };
};
export type MeetingValidationContext = {
  /** Resolves a deadline the model interpreted; null when it cannot. */
  resolveDue?: (due: z.infer<typeof MeetingDueWhenSchema>) => string | null;
  /** Timed turns, so items get the second they were said. */
  utterances?: MeetingUtterance[];
};
function taskKey(value: string | null | undefined) {
  return (
    value?.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase() ?? null
  );
}
function deduplicateTasks(tasks: MeetingSynthesis["tasks"]) {
  const unique: MeetingSynthesis["tasks"] = [];
  const indexes = new Map<string, number[]>();
  for (const task of tasks) {
    const key = JSON.stringify([
      taskKey(task.text),
      task.assignee,
      task.owner ?? null,
      task.due,
      task.dueDate ?? null,
    ]);
    const existingIndexes = indexes.get(key) ?? [];
    const sourceKey = (source: (typeof task.sources)[number]) =>
      JSON.stringify([source.segment, source.quote]);
    const mergeIndex = existingIndexes.find((index) => {
      const existing = unique[index]!;
      const existingKeys = new Set(existing.sources.map(sourceKey));
      const union = new Set([...existingKeys, ...task.sources.map(sourceKey)]);
      // Only merge entries with overlapping evidence. Matching wording alone
      // can describe separate obligations whose subject was omitted by the model.
      return (
        task.sources.some((source) => existingKeys.has(sourceKey(source))) &&
        union.size <= 4
      );
    });
    if (mergeIndex === undefined) {
      const index = unique.length;
      unique.push({ ...task, sources: [...task.sources] });
      indexes.set(key, [...existingIndexes, index]);
      continue;
    }
    const existing = unique[mergeIndex]!;
    const seen = new Set(existing.sources.map(sourceKey));
    for (const source of task.sources)
      if (!seen.has(sourceKey(source))) {
        existing.sources.push(source);
        seen.add(sourceKey(source));
      }
  }
  return unique;
}
export const MeetingRecordSchema = z.strictObject({
  profile: z.enum(MEETING_RECORD_PROFILES),
  scope: ScopeSchema,
  meeting: MeetingSchema,
  transcript: z.string().max(960240),
  transcriptComplete: z.boolean(),
  reviewReasons: z.array(z.enum(["uncertain", "repetition"])).max(2),
  analysis: MeetingSynthesisSchema.nullable(),
  analyzer: z.string().max(160).nullable(),
  transcriptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  recordDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  humanTaskIds: z.array(z.string().min(1).max(160)).max(80),
  /** Timed turns of a meeting transcribed with timestamps; absent for older ones. */
  utterances: z
    .array(MeetingUtteranceSchema)
    .max(MEETING_MAX_UTTERANCES)
    .optional(),
  /** The spoken language the transcriber detected, when it said. */
  detectedLanguage: z.string().min(1).max(32).optional(),
});
export type MeetingRecord = z.infer<typeof MeetingRecordSchema>;
/** The words of a quote, without the speaker label a model may copy. */
function firstWords(quote: string, count: number) {
  return normalizeQuote(quote).split(" ").slice(0, count).join(" ");
}
/** Second into the meeting where a source was said: its utterance, else its minute. */
export function meetingSourceSeconds(
  source: { segment: number; quote: string },
  utterances?: MeetingUtterance[],
) {
  const from = source.segment * 60;
  const head = firstWords(source.quote, 4);
  const turn = utterances?.find(
    (u) =>
      u.start >= from - 1 &&
      u.start < from + 60 &&
      !!head &&
      normalizeQuote(u.text).includes(head),
  );
  return Math.max(0, Math.min(MEETING_MAX_SECONDS, turn?.start ?? from));
}
/**
 * Checks every quote against the original transcript, tolerantly: a quote
 * with small deviations is replaced by the exact original words, one that
 * cannot be found is dropped, and an item is dropped only when none of its
 * sources is left. Owners and deadlines must still appear in one of the
 * item's quotes, else they are cleared. Never fails because of a quote.
 */
export function validateMeetingSynthesis(
  raw: unknown,
  input: MeetingConsolidationInput,
  context: MeetingValidationContext = {},
): MeetingSynthesis {
  const result = SynthesisInputSchema.parse(raw);
  if (result.overflow) throw new Error("meeting_consolidation_limit");
  const segments = new Map(input.segments.map((s) => [s.index, s.text]));
  if (input.segments.some((s) => s.text.trim()) && !result.summary.trim())
    throw new Error("meeting_summary_missing");
  const repair = (source: z.infer<typeof looseSource>) => {
    // The cited minute first; a quote at a minute's edge may have been
    // cited from the minute next door. Fuzzy repair stays in the cited one.
    for (const [index, fuzzy] of [
      [source.segment, false],
      [source.segment - 1, false],
      [source.segment + 1, false],
      [source.segment, true],
    ] as const) {
      const text = segments.get(index);
      if (text === undefined) continue;
      const quote = locateQuote(text, source.quote, fuzzy);
      if (quote && quote.length <= 600) return { segment: index, quote };
    }
    return undefined;
  };
  const repairAll = (list: z.infer<typeof looseSource>[], max: number) => {
    const seen = new Set<string>();
    const kept: z.infer<typeof MeetingSourceSchema>[] = [];
    for (const source of list) {
      const fixed = repair(source);
      if (!fixed) continue;
      const key = JSON.stringify([fixed.segment, fixed.quote]);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(fixed);
      if (kept.length >= max) break;
    }
    return kept;
  };
  const when = (list: z.infer<typeof MeetingSourceSchema>[], own?: number) =>
    context.utterances || own === undefined || !Number.isFinite(own)
      ? meetingSourceSeconds(list[0]!, context.utterances)
      : Math.max(0, Math.min(MEETING_MAX_SECONDS, own));
  const notes = (list: z.infer<typeof looseNote>[] | undefined) =>
    (list ?? []).flatMap((item) => {
      const kept = repairAll(item.sources, 4);
      return kept.length
        ? [
            {
              text: item.text,
              sources: kept,
              at: when(kept, item.at),
            },
          ]
        : [];
    });
  const tasks = result.tasks.flatMap((task): MeetingTask[] => {
    const kept = repairAll(task.sources, 4);
    if (!kept.length) return [];
    const said = (value: string) =>
      kept.some((source) => quoteMentions(source.quote, value));
    let owner = task.owner ?? task.assignee ?? null;
    if (owner !== null && !owner.trim()) owner = null;
    if (owner && owner.toLowerCase() !== "me" && !said(owner)) owner = null;
    if (owner?.toLowerCase() === "me") owner = "me";
    let due = task.due?.trim() ? task.due : null;
    if (due && !said(due)) due = null;
    let dueDate: string | null = null;
    if (due) {
      const parsed = MeetingDueWhenSchema.safeParse(task.dueWhen);
      if (parsed.success && context.resolveDue)
        dueDate = context.resolveDue(parsed.data);
      else if (MeetingDueDate.safeParse(task.dueDate).success)
        dueDate = task.dueDate!;
    }
    const contextText = task.context?.trim().slice(0, 400);
    return [
      {
        text: task.text,
        assignee: owner === "me" ? null : owner,
        due,
        sources: kept,
        owner,
        dueDate,
        at: when(kept, task.at),
        ...(contextText ? { context: contextText } : {}),
      },
    ];
  });
  return MeetingSynthesisSchema.parse({
    version: MEETING_ANALYSIS_VERSION,
    summary: result.summary,
    summarySources: repairAll(result.summarySources, 32),
    points: notes(result.points),
    decisions: notes(result.decisions),
    tasks: deduplicateTasks(tasks),
    openQuestions: notes(result.openQuestions),
    overflow: false,
  });
}
