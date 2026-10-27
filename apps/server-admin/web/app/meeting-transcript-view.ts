import type {
  MeetingSpeaker,
  MeetingUtterance,
} from "../../../../packages/protocol/meeting-notes";

/**
 * A transcript reads as one text: what one speaker says in a row is one
 * block, cut into paragraphs at sentence ends, whatever pieces it was
 * transcribed in. Each paragraph keeps the time it starts at, estimated
 * within a piece by how far into its text it begins.
 */
export type TranscriptParagraph = { start: number; text: string };
export type TranscriptBlock = {
  speaker: MeetingSpeaker;
  voice?: number;
  start: number;
  paragraphs: TranscriptParagraph[];
};

/** About this many characters make a paragraph; a sentence is never cut. */
const PARAGRAPH = 500;

export function transcriptBlocks(
  turns: readonly MeetingUtterance[],
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let run: MeetingUtterance[] = [];
  const flush = () => {
    if (run.length) blocks.push(block(run));
    run = [];
  };
  for (const turn of turns) {
    if (!turn.text.trim()) continue;
    if (
      run.length &&
      (run[0]!.speaker !== turn.speaker || run[0]!.voice !== turn.voice)
    )
      flush();
    run.push(turn);
  }
  flush();
  return blocks;
}

function block(turns: readonly MeetingUtterance[]): TranscriptBlock {
  // Where each piece starts in the joined text, to time a paragraph.
  const pieces: { offset: number; turn: MeetingUtterance; length: number }[] =
    [];
  let text = "";
  for (const turn of turns) {
    const words = turn.text.replace(/\s+/gu, " ").trim();
    if (text) text += " ";
    pieces.push({ offset: text.length, turn, length: words.length });
    text += words;
  }
  const timeAt = (offset: number) => {
    const piece =
      pieces.findLast((candidate) => candidate.offset <= offset) ?? pieces[0]!;
    const into = Math.min(1, (offset - piece.offset) / (piece.length || 1));
    return piece.turn.start + into * (piece.turn.end - piece.turn.start);
  };
  const paragraphs: TranscriptParagraph[] = [];
  let start = 0;
  let current = "";
  let offset = 0;
  // A sentence, or punctuation on its own ("…" opening a turn, a lone "?").
  for (const sentence of text.match(
    /[^.!?…]+(?:[.!?…]+["“”»)]*|$)\s*|[.!?…]+["“”»)]*\s*/gu,
  ) ?? []) {
    if (!current) start = offset;
    current += sentence;
    offset += sentence.length;
    if (current.length >= PARAGRAPH) {
      paragraphs.push({ start: timeAt(start), text: current.trim() });
      current = "";
    }
  }
  if (current.trim())
    paragraphs.push({ start: timeAt(start), text: current.trim() });
  return {
    speaker: turns[0]!.speaker,
    ...(turns[0]!.voice ? { voice: turns[0]!.voice } : {}),
    start: turns[0]!.start,
    paragraphs,
  };
}

/** The paragraph a time falls in: [block, paragraph], or null when none. */
export function paragraphAt(
  blocks: readonly TranscriptBlock[],
  seconds: number,
): [number, number] | null {
  let found: [number, number] | null = null;
  blocks.forEach((b, i) =>
    b.paragraphs.forEach((p, j) => {
      if (p.start <= seconds + 0.5) found = [i, j];
    }),
  );
  return found ?? (blocks.length ? [0, 0] : null);
}
