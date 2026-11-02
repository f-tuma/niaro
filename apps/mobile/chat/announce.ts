/** The longest gist a screen reader is given after "Answer ready". */
const GIST_MAX = 300;

/** One line of Markdown as the words a person would read. */
function words(line: string) {
  return line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|\*|~~)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/(^|[^\w])(__|_)(\S(?:.*?\S)?)\2(?=[^\w]|$)/g, "$1$3");
}

/**
 * An answer's first paragraph as plain text, for the "Answer ready"
 * announcement: Markdown marks, links and code spans are reduced to their
 * words; code blocks and tables are skipped; a heading stands in only when
 * there is no paragraph.
 */
export function answerGist(text: string, max = GIST_MAX) {
  // Paragraphs: runs of lines between blank lines and code fences.
  const blocks: string[][] = [[]];
  let fenced = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      fenced = !fenced;
      blocks.push([]);
    } else if (!fenced) {
      if (line) blocks.at(-1)!.push(line);
      else blocks.push([]);
    }
  }
  const clip = (value: string) =>
    value.length > max ? `${value.slice(0, max - 1)}…` : value;
  let heading = "";
  for (const lines of blocks) {
    if (!lines.length || lines.every((line) => line.startsWith("|"))) continue;
    const value = lines.map(words).join(" ").replace(/\s+/g, " ").trim();
    if (!value) continue;
    if (lines.length === 1 && /^#{1,6}\s/.test(lines[0]!)) heading ||= value;
    else return clip(value);
  }
  return clip(heading);
}

/** What the screen reader says once when an answer is stored. */
export function answerAnnouncement(prefix: string, text: string) {
  const gist = answerGist(text);
  return gist ? `${prefix}. ${gist}` : prefix;
}
