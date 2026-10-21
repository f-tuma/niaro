import { useUiLanguage } from "@admin/context";

/** "5 minutes ago", "yesterday", then a medium date after a week. */
export function formatRelative(
  value: string | number | Date,
  language: string,
  now = Date.now(),
) {
  const time = new Date(value).getTime();
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const minutes = Math.round((time - now) / 60_000);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return format.format(days, "day");
  return new Date(time).toLocaleDateString(language, { dateStyle: "medium" });
}

/** Locale date and time, e.g. "Tue 13 Oct, 10:00". */
export function formatDateTime(
  value: string | number | Date,
  language: string,
) {
  return new Date(value).toLocaleString(language, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The one way to show when something happened: a relative time, with the
 * exact local date and time in the tooltip. Never print both.
 */
export function RelativeTime({
  value,
  now,
}: {
  value: string | number | Date;
  now?: number;
}) {
  const language = useUiLanguage();
  const date = new Date(value);
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString(language, {
        dateStyle: "full",
        timeStyle: "short",
      })}
      className="whitespace-nowrap tabular-nums"
    >
      {formatRelative(date, language, now)}
    </time>
  );
}
