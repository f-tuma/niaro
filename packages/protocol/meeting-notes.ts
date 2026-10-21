import type { MeetingRecord } from "./meeting-record";

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
      return [
        {
          start,
          end: Math.max(start, seconds(turn.end) ?? start),
          speaker: meetingSpeaker(turn.speaker),
          text: words,
        },
      ];
    }),
  };
}
