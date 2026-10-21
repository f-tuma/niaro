/** Pure meeting formatting shared by the mobile views and the web app. */
export function meetingTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
/** Whole minutes for a list; an exact clock only while recording. */
export function meetingDuration(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
/** Long transcripts become paragraphs a list can render lazily. */
export function transcriptParagraphs(transcript: string) {
  const out: string[] = [];
  for (const block of transcript.split(/\n+/)) {
    let rest = block.trim();
    while (rest.length > 1400) {
      const cut = rest.lastIndexOf(". ", 1399);
      const at = cut > 400 ? cut + 1 : 1400;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}
const meaningfulRepeatedWords = new Set([
  "ne",
  "no",
  "ano",
  "jo",
  "yes",
  "yeah",
  "not",
  "never",
  "neither",
  "nor",
  "tak",
  "moc",
  "very",
  "velmi",
  // These can be adjacent words with distinct grammatical roles ("had had",
  // "that that", or Czech "to to"); do not guess that they are stutters.
  "had",
  "that",
  "this",
  "to",
  "já",
  "že",
]);
/** A reversible reading aid only; meeting evidence and citations stay untouched. */
export function cleanTranscriptForReading(transcript: string) {
  return transcript
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+([,.;:!?])/gu, "$1")
    .replace(
      /([,;:!?])(?=\S)/gu,
      (_match: string, punctuation: string, offset: number, text: string) => {
        const before = text[offset - 1] ?? "";
        const after = text[offset + 1] ?? "";
        // A separator between digits is often data, not sentence punctuation:
        // 12:30 and 1,5 must remain intact. A question mark before lowercase
        // text may also be part of a query/token, so only repair clear prose.
        if (/\d/u.test(before) && /\d/u.test(after)) return punctuation;
        if (punctuation === "?" || punctuation === "!")
          return /\p{Lu}/u.test(after) ? `${punctuation} ` : punctuation;
        if (punctuation === ":")
          return /\p{Lu}/u.test(after) ? `${punctuation} ` : punctuation;
        return /\p{L}/u.test(before) && /\p{L}/u.test(after)
          ? `${punctuation} `
          : punctuation;
      },
    )
    .replace(
      /(^|[^\p{L}\p{N}_-])(?:ehm+|em+|hmm+|hm+|uh+|um+|erm+|eee+)[,.!?;:]?(?=$|[^\p{L}\p{N}_-])/giu,
      "$1",
    )
    .replace(
      /(^|[^\p{L}\p{N}_])([\p{L}\p{N}_]+)(?:[ \t]+\2)+(?![\p{L}\p{N}_])/giu,
      (repeat, boundary: string, word: string) =>
        meaningfulRepeatedWords.has(word.toLocaleLowerCase())
          ? repeat
          : `${boundary}${word}`,
    )
    .replace(/[ \t]+/gu, " ")
    .replace(/[ \t]*\n[ \t]*/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
