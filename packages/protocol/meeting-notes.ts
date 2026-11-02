import type { MeetingRecord } from "./meeting-record";
import {
  meetingSpeakerLabels,
  nameVoices,
  voiceLabel,
  type MeetingPeople,
} from "./meetings";

/**
 * A meeting record as notes: summary, decisions, tasks, open questions and
 * the spoken turns, read defensively so records with or without the newer
 * fields (decisions, open questions, task owners and times, utterances)
 * show the same way. Pure; shared by the web app and the agent's tools.
 */
export type MeetingNoteItem = { text: string; at: number | null };
export type MeetingNoteTask = MeetingNoteItem & {
  /** Position in the record; the meeting's Tasks use the same order. */
  index: number;
  /** "me" (the person recording), a name as said, or null. */
  owner: string | null;
  /** The deadline as said, and resolved to a date when it could be. */
  due: string | null;
  dueDate: string | null;
};
export type MeetingSpeaker = "self" | "others" | "unknown";
export type MeetingUtterance = {
  start: number;
  end: number;
  speaker: MeetingSpeaker;
  /** The diarizer's numbered voice, when it told the voices apart. */
  voice?: number;
  text: string;
};
export type MeetingNotes = {
  summary: string;
  points: MeetingNoteItem[];
  decisions: MeetingNoteItem[];
  openQuestions: MeetingNoteItem[];
  tasks: MeetingNoteTask[];
  utterances: MeetingUtterance[];
};

type Loose = Record<string, unknown>;
const object = (value: unknown): Loose | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Loose)
    : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) =>
  typeof value === "string"
    ? value.trim()
    : typeof object(value)?.text === "string"
      ? String(object(value)!.text).trim()
      : "";
const seconds = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const nullableText = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** Where in the recording an item was said: its own time, else its quote's minute. */
function itemAt(value: unknown) {
  const item = object(value);
  if (!item) return null;
  const own = seconds(item.at) ?? seconds(item.start);
  if (own !== null) return own;
  const source = object(list(item.sources)[0]) ?? object(item.source);
  const segment = seconds(source?.segment);
  return segment === null ? null : segment * 60;
}
const items = (value: unknown): MeetingNoteItem[] =>
  list(value).flatMap((item) => {
    const words = text(item);
    return words ? [{ text: words, at: itemAt(item) }] : [];
  });

const SELF = new Set(["self", "me", "já", "ja"]);
const OTHERS = new Set(["others", "other", "ostatní", "ostatni"]);
/** A speaker as the notes name them; anything else is unknown. */
export function meetingSpeaker(value: unknown): MeetingSpeaker {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SELF.has(raw) ? "self" : OTHERS.has(raw) ? "others" : "unknown";
}

/** A turn's speaker as people read it: "Me", "Others", or "Speaker 2". */
export function meetingSpeakerName(
  turn: { speaker: MeetingSpeaker; voice?: number },
  names: Record<MeetingSpeaker, string> & { voice: string },
  people?: MeetingPeople,
) {
  return turn.speaker !== "self" && turn.voice
    ? voiceLabel(turn.voice, names, people)
    : names[turn.speaker];
}
/** The notes with every mention of a named voice replaced by its name. */
export function namedMeetingNotes(
  notes: MeetingNotes,
  names: { self: string; voice: string },
  people?: MeetingPeople,
): MeetingNotes {
  if (!people?.selfVoice && !Object.keys(people?.voiceNames ?? {}).length)
    return notes;
  const name = (text: string) => nameVoices(text, names, people);
  const item = <T extends MeetingNoteItem>(value: T) => ({
    ...value,
    text: name(value.text),
  });
  return {
    ...notes,
    summary: name(notes.summary),
    points: notes.points.map(item),
    decisions: notes.decisions.map(item),
    openQuestions: notes.openQuestions.map(item),
    tasks: notes.tasks.map((task) => ({
      ...item(task),
      owner: task.owner && name(task.owner),
    })),
  };
}

export function meetingNotes(record: MeetingRecord): MeetingNotes {
  const loose = record as unknown as Loose;
  const analysis = object(record.analysis) ?? {};
  const field = (name: string) => analysis[name] ?? loose[name];
  return {
    summary:
      typeof analysis.summary === "string" ? analysis.summary.trim() : "",
    points: items(analysis.points),
    decisions: items(field("decisions")),
    openQuestions: items(field("openQuestions")),
    tasks: list(analysis.tasks).flatMap((value, index) => {
      const task = object(value);
      const words = text(value);
      if (!words) return [];
      return [
        {
          index,
          text: words,
          owner: nullableText(task?.owner) ?? nullableText(task?.assignee),
          due: nullableText(task?.due),
          dueDate: nullableText(task?.dueDate),
          at: itemAt(value),
        },
      ];
    }),
    utterances: list(field("utterances")).flatMap((value) => {
      const turn = object(value);
      const words = text(value);
      const start = seconds(turn?.start);
      if (!turn || !words || start === null) return [];
      const voice = turn.voice;
      return [
        {
          start,
          end: Math.max(start, seconds(turn.end) ?? start),
          speaker: meetingSpeaker(turn.speaker),
          ...(typeof voice === "number" && Number.isInteger(voice) && voice > 0
            ? { voice }
            : {}),
          text: words,
        },
      ];
    }),
  };
}

/**
 * A record whose transcript and notes read the owner's names for the voices
 * ("Jana:" for "Speaker 2:"), for views that show the record's text as is.
 */
export function namedMeetingRecord<
  T extends {
    meeting: MeetingPeople & { language: "en" | "cs" };
    transcript: string;
    analysis: unknown;
  },
>(record: T): T {
  const people = record.meeting;
  if (!people.selfVoice && !Object.keys(people.voiceNames ?? {}).length)
    return record;
  const labels = meetingSpeakerLabels(record.meeting.language);
  const name = (value: unknown): unknown =>
    typeof value === "string"
      ? nameVoices(value, labels, people)
      : Array.isArray(value)
        ? value.map(name)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([key, item]) => [key, name(item)]),
            )
          : value;
  return {
    ...record,
    transcript: nameVoices(record.transcript, labels, people),
    analysis: name(record.analysis),
  };
}
