import type { Language } from "../protocol";
import { readableName } from "../protocol/display-name";

/**
 * Display-only formatting of action parameters and result fields. Machine keys
 * read as labels, ISO instants as local dates and JSON lists as items. The
 * underlying values (and what gets approved) never change.
 */
export type DisplayField = {
  label: string;
  /** Formatted single value; also the accessible value for `items`. */
  value: string;
  /** A list value shown as chips. */
  items?: string[];
};

/** Common parameter names in both languages; anything else is humanized. */
const LABELS: Record<string, { en: string; cs: string }> = {
  title: { en: "Title", cs: "Název" },
  name: { en: "Name", cs: "Název" },
  subject: { en: "Subject", cs: "Předmět" },
  summary: { en: "Summary", cs: "Shrnutí" },
  description: { en: "Description", cs: "Popis" },
  body: { en: "Message", cs: "Zpráva" },
  message: { en: "Message", cs: "Zpráva" },
  text: { en: "Text", cs: "Text" },
  notes: { en: "Notes", cs: "Poznámky" },
  note: { en: "Note", cs: "Poznámka" },
  when: { en: "When", cs: "Kdy" },
  start: { en: "Start", cs: "Začátek" },
  end: { en: "End", cs: "Konec" },
  date: { en: "Date", cs: "Datum" },
  time: { en: "Time", cs: "Čas" },
  due: { en: "Due", cs: "Termín" },
  duration: { en: "Duration", cs: "Délka" },
  location: { en: "Location", cs: "Místo" },
  attendees: { en: "Attendees", cs: "Účastníci" },
  participants: { en: "Participants", cs: "Účastníci" },
  participant: { en: "Participant", cs: "Účastník" },
  guests: { en: "Guests", cs: "Hosté" },
  to: { en: "To", cs: "Komu" },
  cc: { en: "Cc", cs: "Kopie" },
  recipient: { en: "Recipient", cs: "Příjemce" },
  recipients: { en: "Recipients", cs: "Příjemci" },
  email: { en: "Email", cs: "E-mail" },
  phone: { en: "Phone", cs: "Telefon" },
  owner: { en: "Owner", cs: "Vlastník" },
  assignee: { en: "Assignee", cs: "Řešitel" },
  status: { en: "Status", cs: "Stav" },
  priority: { en: "Priority", cs: "Priorita" },
  amount: { en: "Amount", cs: "Částka" },
  calendar: { en: "Calendar", cs: "Kalendář" },
  url: { en: "Link", cs: "Odkaz" },
  link: { en: "Link", cs: "Odkaz" },
  company: { en: "Company", cs: "Firma" },
};
const WHEN = { en: "When", cs: "Kdy" };
const YES_NO = { en: ["Yes", "No"], cs: ["Ano", "Ne"] } as const;

const START_KEYS = new Set([
  "start",
  "starts",
  "startsat",
  "starttime",
  "startdate",
  "startdatetime",
  "begin",
  "from",
]);
const END_KEYS = new Set([
  "end",
  "ends",
  "endsat",
  "endtime",
  "enddate",
  "enddatetime",
  "until",
  "to",
]);

const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const keyOf = (label: string) => label.toLowerCase().replace(/[^a-z]/g, "");

/** "attendees" → "Attendees", "startTime" → "Start time"; human labels stay as written. */
export function fieldLabel(label: string, language: Language): string {
  const known = LABELS[keyOf(label)];
  if (known && !/\s/.test(label.trim())) return known[language];
  return readableName(label) || label;
}

const locale = (language: Language) => (language === "cs" ? "cs-CZ" : "en-GB");

function dayPart(date: Date, language: Language, timeZone?: string) {
  const sameYear =
    new Intl.DateTimeFormat("en", { year: "numeric", timeZone }).format(
      date,
    ) ===
    new Intl.DateTimeFormat("en", { year: "numeric", timeZone }).format(
      new Date(),
    );
  return new Intl.DateTimeFormat(locale(language), {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone,
  }).format(date);
}
function timePart(date: Date, language: Language, timeZone?: string) {
  return new Intl.DateTimeFormat(locale(language), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(date);
}
const sameDay = (a: Date, b: Date, timeZone?: string) => {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone });
  return day.format(a) === day.format(b);
};

function parseInstant(value: string): Date | undefined {
  const trimmed = value.trim();
  if (!ISO_INSTANT.test(trimmed) && !ISO_DATE.test(trimmed)) return undefined;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** "Tue 13 Oct · 10:00", or just the day for a date-only value. */
export function formatInstant(
  value: string,
  language: Language,
  timeZone?: string,
): string | undefined {
  const date = parseInstant(value);
  if (!date) return undefined;
  if (ISO_DATE.test(value.trim())) return dayPart(date, language, "UTC");
  return `${dayPart(date, language, timeZone)} · ${timePart(date, language, timeZone)}`;
}

/** "Tue 13 Oct · 10:00–10:30"; across days both ends carry their date. */
export function formatRange(
  start: string,
  end: string,
  language: Language,
  timeZone?: string,
): string | undefined {
  const from = parseInstant(start);
  const to = parseInstant(end);
  if (!from || !to || ISO_DATE.test(start.trim()) || ISO_DATE.test(end.trim()))
    return undefined;
  if (sameDay(from, to, timeZone))
    return `${dayPart(from, language, timeZone)} · ${timePart(from, language, timeZone)}–${timePart(to, language, timeZone)}`;
  return `${formatInstant(start, language, timeZone)} – ${formatInstant(end, language, timeZone)}`;
}

/** A JSON list of plain values becomes its items; anything else stays text. */
function listItems(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return undefined;
    const items = parsed.map((item) =>
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
        ? String(item)
        : item && typeof item === "object"
          ? objectLabel(item as Record<string, unknown>)
          : undefined,
    );
    return items.every((item): item is string => !!item?.trim())
      ? items
      : undefined;
  } catch {
    return undefined;
  }
}
/** Attendee-like objects read by their name or address. */
function objectLabel(item: Record<string, unknown>) {
  for (const key of ["name", "label", "title", "email", "displayName", "id"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function formatFieldValue(
  value: string,
  language: Language,
  timeZone?: string,
): Pick<DisplayField, "value" | "items"> {
  const items = listItems(value);
  if (items)
    return items.length ? { value: items.join(", "), items } : { value: "—" };
  const instant = formatInstant(value, language, timeZone);
  if (instant) return { value: instant };
  if (value === "true") return { value: YES_NO[language][0] };
  if (value === "false") return { value: YES_NO[language][1] };
  if (value === "null" || !value.trim()) return { value: "—" };
  return { value };
}

/**
 * Turns raw `{label, value}` pairs into display rows: human labels, local
 * dates, list chips, and a start/end pair merged into one "When" row.
 */
export function displayFields(
  fields: readonly { label: string; value: string }[],
  language: Language,
  timeZone?: string,
): DisplayField[] {
  const startIndex = fields.findIndex(
    (field) =>
      START_KEYS.has(keyOf(field.label)) && !!parseInstant(field.value),
  );
  const endIndex = fields.findIndex(
    (field) => END_KEYS.has(keyOf(field.label)) && !!parseInstant(field.value),
  );
  const range =
    startIndex >= 0 && endIndex >= 0
      ? formatRange(
          fields[startIndex]!.value,
          fields[endIndex]!.value,
          language,
          timeZone,
        )
      : undefined;
  const rows: DisplayField[] = [];
  fields.forEach((field, index) => {
    if (range && index === endIndex) return;
    if (range && index === startIndex) {
      rows.push({ label: WHEN[language], value: range });
      return;
    }
    rows.push({
      label: fieldLabel(field.label, language),
      ...formatFieldValue(field.value, language, timeZone),
    });
  });
  return rows;
}
