import type { Language } from "../protocol";

/**
 * Days in chats, shared by the web and the phone: the groups of the chat
 * list and the dividers inside a chat. Calendar days, never 24-hour spans:
 * a daylight-saving night is 23 or 25 hours long.
 */
const locale = (language: Language) => (language === "cs" ? "cs-CZ" : "en-GB");
const capitalize = (text: string) =>
  text.charAt(0).toLocaleUpperCase() + text.slice(1);
/** Local midnight of the day `value` falls on, in milliseconds. */
export const startOfDay = (value: Date) =>
  new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
/** Local midnight `n` calendar days before `day`. */
const daysBefore = (day: number, n: number) => {
  const date = new Date(day);
  date.setDate(date.getDate() - n);
  return date.getTime();
};

export type DayLabels = { today: string; yesterday: string; lastWeek: string };

/** Today, Yesterday, Previous 7 days, then by month; input stays newest first. */
export function groupChatsByDay<T extends { updatedAt: string }>(
  conversations: readonly T[],
  language: Language,
  labels: DayLabels,
  now = new Date(),
) {
  const startOfToday = startOfDay(now);
  const startOfYesterday = daysBefore(startOfToday, 1),
    startOfLastWeek = daysBefore(startOfToday, 7);
  const groups: { label: string; conversations: T[] }[] = [];
  for (const conversation of conversations) {
    const date = new Date(conversation.updatedAt);
    const at = date.getTime();
    const label =
      at >= startOfToday
        ? labels.today
        : at >= startOfYesterday
          ? labels.yesterday
          : at >= startOfLastWeek
            ? labels.lastWeek
            : // "listopad" is a heading here: "Listopad".
              capitalize(
                date.toLocaleDateString(locale(language), {
                  month: "long",
                  ...(date.getFullYear() === now.getFullYear()
                    ? {}
                    : { year: "numeric" }),
                }),
              );
    const last = groups.at(-1);
    if (last?.label === label) last.conversations.push(conversation);
    else groups.push({ label, conversations: [conversation] });
  }
  return groups;
}

/**
 * For each message, the day it starts when that differs from the timed
 * message before it (for the first one, from today). Messages without a time
 * never start one, so a chat from before message times shows no dividers.
 */
export function messageDays(
  messages: readonly { createdAt?: string }[],
  now = new Date(),
) {
  let previous = startOfDay(now);
  return messages.map(({ createdAt }) => {
    if (!createdAt) return undefined;
    const day = startOfDay(new Date(createdAt));
    if (day === previous) return undefined;
    previous = day;
    return day;
  });
}

/** A divider's words: Today, Yesterday, or "Monday 2 November" (and year). */
export function dayLabel(
  day: number,
  language: Language,
  labels: Pick<DayLabels, "today" | "yesterday">,
  now = new Date(),
) {
  const today = startOfDay(now);
  if (day === today) return labels.today;
  if (day === daysBefore(today, 1)) return labels.yesterday;
  const date = new Date(day);
  return date.toLocaleDateString(locale(language), {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** A message's time of day, "14:05". */
export function messageTime(at: string, language: Language) {
  return new Date(at).toLocaleTimeString(locale(language), {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The full moment, for a screen reader or a long press. */
export function messageMoment(at: string, language: Language) {
  return new Date(at).toLocaleString(locale(language), {
    dateStyle: "full",
    timeStyle: "short",
  });
}
