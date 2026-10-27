import type { Tone } from "@admin/components/console/status";
import type { ClientSession } from "../../../../packages/client-core/session";
import type { Meeting } from "../../../../packages/protocol/meetings";
import type { MeetingRecord } from "../../../../packages/protocol/meeting-record";
import {
  meetingSpeakerName,
  type MeetingNotes,
  type MeetingSpeaker,
} from "../../../../packages/protocol/meeting-notes";
import {
  meetingDuration,
  meetingTime,
} from "../../../../packages/ui-catalog/meeting-format";

/** What the Meetings list shows and how it filters, without any widgets. */
export type MeetingFilter = "all" | "processing" | "ready" | "failed";
const groups: Record<Meeting["status"], Exclude<MeetingFilter, "all">> = {
  uploading: "processing",
  sealed: "processing",
  transcribing: "processing",
  analyzing: "processing",
  ready: "ready",
  failed: "failed",
  interrupted: "failed",
};
/** The state a list shows; Ready needs no badge. */
export const meetingTone: Record<Meeting["status"], Tone | null> = {
  uploading: "info",
  sealed: "neutral",
  transcribing: "info",
  analyzing: "info",
  ready: null,
  failed: "danger",
  interrupted: "warning",
};
const fold = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

/** Meetings matching a search (case and accents ignored) and a state. */
export function filterMeetings(
  meetings: readonly Meeting[],
  search: string,
  filter: MeetingFilter,
) {
  const needle = fold(search.trim());
  return meetings.filter(
    (meeting) =>
      (filter === "all" || groups[meeting.status] === filter) &&
      (!needle || fold(meeting.title).includes(needle)),
  );
}

/** When and how long, as one quiet line. */
export function meetingMeta(meeting: Meeting, language: "en" | "cs") {
  const when = new Date(meeting.recordedAt).toLocaleString(language, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return meeting.durationSeconds
    ? `${when} · ${meetingDuration(meeting.durationSeconds)}`
    : when;
}
/** The day of a meeting, short: "10/20". */
export function meetingDay(meeting: Meeting, language: "en" | "cs") {
  return new Date(meeting.recordedAt).toLocaleDateString(language, {
    day: "numeric",
    month: "numeric",
  });
}
/** Only uploads and processing change by themselves; the list polls then. */
export const meetingChanging = (meeting: Meeting) =>
  ["uploading", "transcribing", "analyzing"].includes(meeting.status);

/** How often the list re-reads: only while something is still changing. */
export const meetingsRefetchInterval = (
  meetings: readonly Meeting[] | undefined,
) => (meetings?.some(meetingChanging) ? 5000 : false);

export type SpeakerNames = Record<MeetingSpeaker, string> & { voice: string };
/** A meeting as Markdown: name and date, notes, then the transcript. */
export function meetingMarkdown(
  record: MeetingRecord,
  notes: MeetingNotes,
  headings: {
    summary: string;
    decisions: string;
    tasks: string;
    openQuestions: string;
    transcript: string;
    speakerSelf: string;
  },
  transcript: string,
  language: "en" | "cs",
) {
  const at = (seconds: number | null) =>
    seconds === null ? "" : ` (${meetingTime(seconds)})`;
  const section = (title: string, lines: string[]) =>
    lines.length ? [`## ${title}`, "", ...lines, ""] : [];
  return [
    `# ${record.meeting.title}`,
    "",
    meetingMeta(record.meeting, language),
    "",
    ...section(headings.summary, [
      ...(notes.summary ? [notes.summary] : []),
      ...(notes.points.length
        ? ["", ...notes.points.map((p) => `- ${p.text}`)]
        : []),
    ]),
    ...section(
      headings.decisions,
      notes.decisions.map((d) => `- ${d.text}${at(d.at)}`),
    ),
    ...section(
      headings.tasks,
      notes.tasks.map(
        (t) =>
          `- [ ] ${t.text}${t.owner ? ` — ${t.owner === "me" ? headings.speakerSelf : t.owner}` : ""}${t.due ? `, ${t.due}` : ""}${at(t.at)}`,
      ),
    ),
    ...section(
      headings.openQuestions,
      notes.openQuestions.map((q) => `- ${q.text}${at(q.at)}`),
    ),
    ...section(headings.transcript, transcript ? [transcript] : []),
  ]
    .join("\n")
    .trim()
    .concat("\n");
}
/** The transcript as plain lines with times: spoken turns, else minutes. */
export function meetingTranscriptText(
  notes: MeetingNotes,
  segments: readonly { startSeconds: number; text: string }[],
  speakers: SpeakerNames,
  fallback: string,
) {
  if (notes.utterances.length)
    return notes.utterances
      .map(
        (turn) =>
          `${meetingTime(turn.start)} ${meetingSpeakerName(turn, speakers)}: ${turn.text}`,
      )
      .join("\n");
  const lines = segments
    .filter((segment) => segment.text.trim())
    .map(
      (segment) =>
        `${meetingTime(segment.startSeconds)} ${segment.text.trim().replace(/\n+/g, "\n     ")}`,
    );
  return lines.length ? lines.join("\n") : fallback;
}

export const meetingsKey = (session: ClientSession) => [
  "app",
  "meetings",
  session.identityKey,
];
