const pad = (value: number) => String(value).padStart(2, "0");

/** Presentation conversion only. The server still validates the meeting. */
export function localDateTime(iso: string) {
  const value = new Date(iso);
  return {
    date: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    time: `${pad(value.getHours())}:${pad(value.getMinutes())}`,
  };
}

export function localDateTimeToIso(
  date: string,
  time: string,
  originalIso?: string,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
    return null;
  // Keep an unchanged instant, including its offset during the autumn clock change.
  if (originalIso) {
    const original = localDateTime(originalIso);
    if (original.date === date && original.time === time) return originalIso;
  }
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const value = new Date(0);
  value.setFullYear(year, month - 1, day);
  value.setHours(hour, minute, 0, 0);
  if (!Number.isFinite(value.getTime())) return null;
  const roundTrip = localDateTime(value.toISOString());
  // Reject impossible dates/times, including a spring DST gap, rather than shifting them.
  return roundTrip.date === date && roundTrip.time === time
    ? value.toISOString()
    : null;
}

export type DateTimeFieldsProps = {
  date: string;
  time: string;
  initialValue: string;
  dateLabel: string;
  timeLabel: string;
  language: "en" | "cs";
  disabled?: boolean;
  onDateChange(value: string): void;
  onTimeChange(value: string): void;
};
