import {
  MEETING_MAX_SECONDS,
  MEETING_MAX_UTTERANCES,
  meetingSpeakerLabels,
  meetingTurnLabel,
  type MeetingSegment,
  type MeetingUtterance,
} from "../../packages/protocol/meetings";

/** Overlap between neighbouring chunks, so no word is cut at a boundary. */
export const MEETING_CHUNK_OVERLAP_SECONDS = 2;
export const MEETING_CHUNK_SECONDS = { min: 120, max: 600, default: 300 };
/** A minute with only digital silence is not sent to the paid transcriber. */
export const MEETING_SILENCE_WINDOW_SECONDS = 60;
const SILENCE_RMS = 0.0001;

/** One channel of one chunk, transcribed; times are seconds into the meeting. */
export type MeetingChunkResult = {
  /** Where the chunk's audio starts and ends in the meeting. */
  start: number;
  end: number;
  speaker: MeetingUtterance["speaker"];
  segments: { start: number; end: number; text: string }[];
  words?: { word: string; start: number; end: number }[];
  /** The provider gave no timestamps: one segment spans the chunk. */
  timed: boolean;
  text: string;
  language?: string;
};
/**
 * The first and last non-silent sixty-second windows of a channel, as
 * sample offsets; undefined when all of it is digital silence. Only the
 * span between them is sent, so silent minutes at either end cost nothing.
 */
export function speechSpan(samples: Float32Array, rate = 16000) {
  const window = MEETING_SILENCE_WINDOW_SECONDS * rate;
  let first: number | undefined, last: number | undefined;
  for (let at = 0; at < samples.length; at += window) {
    const end = Math.min(samples.length, at + window);
    let energy = 0;
    for (let i = at; i < end; i++) energy += samples[i]! * samples[i]!;
    if (Math.sqrt(energy / Math.max(1, end - at)) >= SILENCE_RMS) {
      first ??= at;
      last = end;
    }
  }
  return first === undefined ? undefined : { from: first, to: last! };
}
const words = (text: string) => text.trim().split(/\s+/u).filter(Boolean);
const wordKey = (word: string) =>
  word
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLocaleLowerCase();
/**
 * Drops the start of `next` that repeats the end of `previous` (the same
 * words heard twice in the overlap). Up to `limit` words are compared.
 */
export function dropRepeatedPrefix(previous: string, next: string, limit = 12) {
  const tail = words(previous).slice(-limit).map(wordKey);
  const head = words(next);
  const keys = head.map(wordKey);
  for (let size = Math.min(tail.length, keys.length); size >= 1; size--) {
    const matches = keys
      .slice(0, size)
      .every((key, i) => key === tail[tail.length - size + i]);
    // A single repeated short word is too weak to be the overlap.
    if (matches && (size >= 2 || (keys[0]?.length ?? 0) >= 4))
      return head.slice(size).join(" ");
  }
  return next.trim();
}
/**
 * Joins one speaker's chunks by their timestamps. Segments and words that
 * fall in time already covered by the previous chunk (the overlap) are
 * dropped, and a segment straddling the boundary loses its repeated words.
 */
export function stitchChunks(chunks: MeetingChunkResult[]): MeetingUtterance[] {
  const result: MeetingUtterance[] = [];
  /** End of the last kept speech, and of the audio already sent. */
  let covered = 0;
  let chunkEnd = 0;
  const tolerance = 0.25;
  const push = (
    start: number,
    end: number,
    text: string,
    speaker: MeetingUtterance["speaker"],
  ) => {
    if (!text) return;
    // A long stretch (a reply without timestamps, one segment for a whole
    // chunk) becomes pieces of a few sentences, timed by their place in the
    // text, so every minute keeps its own words and nothing is cut off.
    const pieces = spokenPieces(text, 600);
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0) || 1;
    const span = Math.max(0, end - start);
    let offset = 0;
    for (const piece of pieces) {
      const from = start + (offset / total) * span;
      offset += piece.length;
      const to = start + (offset / total) * span;
      result.push({
        start: round(from),
        end: round(Math.max(from, to)),
        speaker,
        text: piece,
      });
    }
    covered = Math.max(covered, end);
  };
  for (const chunk of [...chunks].sort((a, b) => a.start - b.start)) {
    const boundary = covered;
    if (!chunk.timed) {
      // Text only: it starts where the previous chunk's audio ended, and
      // its first words repeat that chunk's last ones when both heard them.
      const previous = result[result.length - 1];
      let text = chunk.text.trim();
      if (previous && previous.end >= chunk.start - tolerance)
        text = dropRepeatedPrefix(previous.text, text);
      push(Math.max(chunk.start, chunkEnd), chunk.end, text, chunk.speaker);
      chunkEnd = Math.max(chunkEnd, chunk.end);
      continue;
    }
    for (const segment of [...chunk.segments].sort(
      (a, b) => a.start - b.start,
    )) {
      let text = segment.text.trim();
      let start = segment.start;
      // Already heard at the end of the previous chunk.
      if (!text || segment.end <= boundary + tolerance) continue;
      if (start < boundary - tolerance) {
        const spoken = chunk.words?.filter(
          (w) => w.start >= segment.start - 0.01 && w.end <= segment.end + 0.01,
        );
        if (spoken?.length) {
          const kept = spoken.filter((w) => (w.start + w.end) / 2 >= boundary);
          text = kept
            .map((w) => w.word.trim())
            .join(" ")
            .trim();
          start = kept[0]?.start ?? boundary;
        } else start = boundary;
      }
      const previous = result[result.length - 1];
      if (
        previous &&
        start < previous.end + tolerance + MEETING_CHUNK_OVERLAP_SECONDS
      )
        text = dropRepeatedPrefix(previous.text, text);
      push(start, segment.end, text, chunk.speaker);
    }
    chunkEnd = Math.max(chunkEnd, chunk.end);
  }
  return result;
}
const round = (seconds: number) =>
  Math.max(0, Math.min(MEETING_MAX_SECONDS, Math.round(seconds * 100) / 100));
/** Both speakers' turns in the order they started. */
export function mergeUtterances(...tracks: MeetingUtterance[][]) {
  const order = { me: 0, others: 1, unknown: 2 };
  let merged = tracks
    .flat()
    .sort(
      (a, b) =>
        a.start - b.start ||
        order[a.speaker] - order[b.speaker] ||
        a.end - b.end,
    );
  // Bounded: very many short turns are joined with the same speaker's next one.
  while (merged.length > MEETING_MAX_UTTERANCES) {
    const joined: MeetingUtterance[] = [];
    let changed = false;
    for (const turn of merged) {
      const last = joined[joined.length - 1];
      if (
        last &&
        last.speaker === turn.speaker &&
        last.text.length + turn.text.length < 4000
      ) {
        last.end = Math.max(last.end, turn.end);
        last.text = `${last.text} ${turn.text}`;
        changed = true;
      } else joined.push({ ...turn });
    }
    if (!changed) throw new Error("meeting_transcript_limit");
    merged = joined;
  }
  return merged;
}
/** Conservative review flags for text the transcriber did not score. */
export function transcriptReviewReasons(text: string) {
  const reasons: MeetingSegment["reviewReasons"] = [];
  if (/\[[^\]]*(?:inaudible|nesrozumiteln|unintelligible)[^\]]*\]/iu.test(text))
    reasons.push("uncertain");
  const spoken = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const triples = spoken
    .slice(2)
    .map((_, i) => spoken.slice(i, i + 3).join(" "));
  if (spoken.length >= 12 && new Set(triples).size / triples.length < 0.6)
    reasons.push("repetition");
  return reasons;
}
/**
 * The minute segments every record and quote refers to, derived from the
 * timed turns: a turn belongs to the minute it starts in. A two-track or
 * diarized recording keeps one "Me: …" / "Speaker 2: …" line per change of
 * speaker.
 */
export function minuteSegments(
  utterances: MeetingUtterance[],
  duration: number,
  options: {
    language: "en" | "cs";
    twoTrack: boolean;
    transcriber: string;
  },
): MeetingSegment[] {
  const count = Math.ceil(duration / 60);
  const labels = meetingSpeakerLabels(options.language);
  const labelled =
    options.twoTrack || utterances.some((turn) => turn.voice !== undefined);
  const byMinute = Array.from(
    { length: count },
    () => [] as MeetingUtterance[],
  );
  for (const turn of utterances)
    byMinute[
      Math.max(0, Math.min(count - 1, Math.floor(turn.start / 60)))
    ]!.push(turn);
  return byMinute.map((turns, index) => {
    let text: string;
    if (!labelled) text = turns.map((t) => t.text.trim()).join(" ");
    else {
      const lines: { label: string; text: string }[] = [];
      for (const turn of turns) {
        const label = meetingTurnLabel(turn, labels);
        const last = lines[lines.length - 1];
        if (last?.label === label) last.text += ` ${turn.text.trim()}`;
        else lines.push({ label, text: turn.text.trim() });
      }
      text = lines
        .map((line) => (line.label ? `${line.label}: ${line.text}` : line.text))
        .join("\n");
    }
    text = text.trim();
    if (text.length > 4000) throw new Error("meeting_transcript_limit");
    return {
      index,
      startSeconds: index * 60,
      endSeconds: Math.min(duration, (index + 1) * 60),
      text,
      reviewReasons: transcriptReviewReasons(text),
      transcriber: options.transcriber,
      analyzer: null,
      analysis: text ? null : { summary: [], points: [], tasks: [] },
    };
  });
}
/**
 * A short context for the transcriber: names and terms it should spell
 * right, and the end of what was said just before. Never instructions.
 */
export function transcriptionPrompt(input: {
  title?: string;
  attendees?: string[];
  companies?: string[];
  glossary?: string[];
  previous?: string;
}) {
  const parts = [
    input.title,
    input.attendees?.length ? input.attendees.join(", ") : "",
    input.companies?.length ? input.companies.join(", ") : "",
    input.glossary?.length ? input.glossary.join(", ") : "",
  ]
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join(". ")
    .slice(0, 600);
  const previous = (input.previous ?? "").trim().slice(-200);
  return [parts, previous].filter(Boolean).join("\n").slice(0, 900);
}

/**
 * Text cut into pieces of at most `size` characters, at sentence ends where
 * it can and at a space otherwise; no word is split unless it alone is longer.
 */
export function spokenPieces(text: string, size: number): string[] {
  const pieces: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) pieces.push(current.trim());
    current = "";
  };
  for (const sentence of text.match(/[^.!?…]+[.!?…]*\s*|[.!?…]+\s*/gu) ?? [])
    if ((current + sentence).length <= size) current += sentence;
    else {
      flush();
      if (sentence.length <= size) current = sentence;
      else
        for (const word of sentence.split(/(?<=\s)/u)) {
          if ((current + word).length > size) flush();
          for (let i = 0; i + size < word.length; i += size)
            pieces.push(word.slice(i, i + size));
          current +=
            word.length > size
              ? word.slice(-(word.length % size || size))
              : word;
        }
    }
  flush();
  return pieces;
}
