import type { ChatSearchOptions, SearchRanges } from "../protocol/chat-search";

/** The search screen's filter chips. */
export type ChatSearchFilter = "all" | "mine" | "answers" | "archived";
export const CHAT_SEARCH_FILTERS: readonly ChatSearchFilter[] = [
  "all",
  "mine",
  "answers",
  "archived",
];

/**
 * What a filter asks the server for. Everything but "archived" also finds
 * archived chats (shown with a badge); "archived" finds only those.
 */
export function chatSearchOptions(filter: ChatSearchFilter): ChatSearchOptions {
  switch (filter) {
    case "mine":
      return { includeArchived: true, role: "user" };
    case "answers":
      return { includeArchived: true, role: "assistant" };
    case "archived":
      return { archivedOnly: true };
    default:
      return { includeArchived: true };
  }
}

/** A text split at its highlighted ranges, for rendering as plain text. */
export type HighlightPart = { text: string; match: boolean };
export function highlightParts(
  text: string,
  ranges: SearchRanges | readonly (readonly [number, number])[],
): HighlightPart[] {
  const parts: HighlightPart[] = [];
  let at = 0;
  for (const [rawStart, rawEnd] of ranges) {
    // Out-of-order or overlapping ranges are clipped, never trusted.
    const start = Math.max(at, Math.min(rawStart, text.length));
    const end = Math.max(start, Math.min(rawEnd, text.length));
    if (start > at) parts.push({ text: text.slice(at, start), match: false });
    if (end > start) parts.push({ text: text.slice(start, end), match: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}

/** A short date for a result row: a time today, the day otherwise. */
export function searchDateLabel(
  iso: string,
  language: "en" | "cs",
  labels: { yesterday: string },
  now = new Date(),
) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const locale = language === "cs" ? "cs-CZ" : "en-GB";
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const age = today.getTime() - date.getTime();
  if (age <= 0)
    return date.toLocaleTimeString(locale, {
      hour: "numeric",
      minute: "2-digit",
    });
  if (age <= 86_400_000) return labels.yesterday;
  return date.toLocaleDateString(locale, {
    day: "numeric",
    month: language === "cs" ? "numeric" : "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}
