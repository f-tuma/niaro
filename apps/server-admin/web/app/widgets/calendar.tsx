import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { z } from "zod";
import {
  CalendarDays,
  ChevronLeft,
  Circle,
  CircleCheck,
  MapPin,
  User,
  Users,
  Video,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Field, FieldLabel } from "@admin/components/ui/field";
import { Input } from "@admin/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@admin/components/ui/popover";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@admin/components/ui/toggle-group";
import { StatusBadge, type Tone } from "@admin/components/console/status";
import { calendarWidget } from "../../../../../packages/protocol/widgets/calendar";
import {
  calendarDays,
  calendarEntries,
  gridPercent,
  isoDate,
  layoutDays,
  minutesSinceMidnight,
  openingHour,
  startOfDay,
  viewOfRange,
  type CalendarDay,
  type CalendarEntry,
  type CalendarLayout,
  type CalendarPlaced,
  type CalendarStatus,
  type CalendarView,
} from "./calendar-model";
import {
  AskAction,
  ChoiceField,
  DetailPane,
  Nothing,
  SourceLink,
  SwitchField,
  WidgetToolbar,
  formatTime,
  formatWhen,
} from "./shared";
import { defineRenderer, type WidgetLanguage } from "./types";

export { calendarEntries } from "./calendar-model";

type Data = z.infer<typeof calendarWidget.data>;
type Config = z.infer<typeof calendarWidget.config>;

const text = {
  cs: {
    allDay: "Celý den",
    due: "Termín",
    nothing: "Nic naplánovaného.",
    pick: "Vyber schůzku.",
    back: "Zpět",
    view: "Zobrazení",
    views: { day: "Den", next3: "3 dny", week: "Týden" },
    prepare: "Připrav mě na tuto schůzku",
    help: "Pomoz mi s tím",
    open: "Otevřít",
    join: "Připojit se",
    organizer: "Organizuje",
    status: {
      accepted: "Přijato",
      tentative: "Nezávazně",
      declined: "Odmítnuto",
      none: "Bez odpovědi",
    },
    range: "Rozsah",
    ranges: {
      today: "Dnes",
      next3: "3 dny",
      week: "Týden",
      workweek: "Po–pá",
    },
    tasks: "Úkoly s termínem",
    dayStart: "Pracovní doba od",
    dayEnd: "Pracovní doba do",
    describe: {
      today: "dnes",
      next3: "3 dny",
      week: "týden",
      workweek: "po–pá",
    },
    prepareText: (entry: string) => `Připrav mě na schůzku ${entry}.`,
    helpText: (entry: string) => `Pomoz mi s úkolem ${entry}.`,
  },
  en: {
    allDay: "All day",
    due: "Due",
    nothing: "Nothing planned.",
    pick: "Pick a meeting.",
    back: "Back",
    view: "View",
    views: { day: "Day", next3: "3 days", week: "Week" },
    prepare: "Prepare me for this meeting",
    help: "Help me with it",
    open: "Open",
    join: "Join",
    organizer: "Organizer",
    status: {
      accepted: "Accepted",
      tentative: "Tentative",
      declined: "Declined",
      none: "No reply",
    },
    range: "Range",
    ranges: {
      today: "Today",
      next3: "3 days",
      week: "Week",
      workweek: "Mon–Fri",
    },
    tasks: "Tasks with a due date",
    dayStart: "Working hours from",
    dayEnd: "Working hours to",
    describe: {
      today: "today",
      next3: "3 days",
      week: "this week",
      workweek: "Mon–Fri",
    },
    prepareText: (entry: string) => `Prepare me for the meeting ${entry}.`,
    helpText: (entry: string) => `Help me with the task ${entry}.`,
  },
};
const STATUS_TONE: Record<CalendarStatus, Tone> = {
  accepted: "success",
  tentative: "warning",
  declined: "danger",
  none: "neutral",
};
const MINUTE = 60_000;

const timeOf = (date: Date, language: WidgetLanguage) =>
  date.toLocaleTimeString(language, { hour: "numeric", minute: "2-digit" });
/** "9:00–9:30" of a timed entry, "" of an all-day one. */
const spanOf = (entry: CalendarEntry, language: WidgetLanguage) =>
  entry.allDay
    ? ""
    : entry.kind === "task" || !entry.endText
      ? timeOf(entry.start, language)
      : `${timeOf(entry.start, language)}–${timeOf(entry.end, language)}`;

/** '"Team meeting" (10/17 9:00 AM–9:30 AM, Room 2)' for the prepared request. */
export function describeEntry(
  entry: Pick<
    CalendarEntry,
    "title" | "startText" | "endText" | "location" | "allDay"
  >,
  language: WidgetLanguage,
) {
  const end =
    entry.endText && !entry.allDay ? formatTime(entry.endText, language) : "";
  const when = formatWhen(entry.startText, language) + (end ? `–${end}` : "");
  const quoted = language === "cs" ? `„${entry.title}“` : `"${entry.title}"`;
  return `${quoted} (${[when, entry.location].filter(Boolean).join(", ")})`;
}

/** The clock the current-time line follows: a new minute re-renders. */
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), MINUTE);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The entry's detail: a popover under the block the person clicked. */
/** "Fri 23 9:30–11:30" or "Due Fri 23 16:00". */
function whenOf(entry: CalendarEntry, language: WidgetLanguage) {
  const t = text[language];
  const day = entry.start.toLocaleDateString(language, {
    weekday: "short",
    day: "numeric",
    month: "numeric",
  });
  const span = spanOf(entry, language);
  return entry.kind === "task"
    ? `${t.due} ${day}${span ? ` ${span}` : ""}`
    : `${day} ${span || t.allDay}`;
}

/** Where, who and what about: the entry's facts, clamped in a popover. */
function EntryFacts({
  entry,
  language,
  clamp,
}: {
  entry: CalendarEntry;
  language: WidgetLanguage;
  clamp: boolean;
}) {
  const t = text[language];
  return (
    <>
      {entry.status && (
        <div className="flex">
          <StatusBadge tone={STATUS_TONE[entry.status]}>
            {t.status[entry.status]}
          </StatusBadge>
        </div>
      )}
      {(entry.location || entry.organizer || entry.attendees?.length) && (
        <ul className="flex flex-col gap-1 text-sm">
          {entry.location && (
            <li className="flex items-center gap-2">
              <MapPin
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 truncate">{entry.location}</span>
            </li>
          )}
          {entry.organizer && (
            <li className="flex items-center gap-2">
              <User
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 truncate">{entry.organizer}</span>
            </li>
          )}
          {!!entry.attendees?.length && (
            <li className="flex items-start gap-2">
              <Users
                aria-hidden="true"
                className="mt-1 size-3.5 shrink-0 text-muted-foreground"
              />
              <span
                data-clamp={clamp}
                className="min-w-0 data-[clamp=true]:line-clamp-2"
              >
                {entry.attendees.join(", ")}
              </span>
            </li>
          )}
        </ul>
      )}
      {entry.description && (
        <p
          data-clamp={clamp}
          className="text-sm leading-relaxed whitespace-pre-line text-muted-foreground data-[clamp=true]:line-clamp-6 data-[clamp=true]:text-xs"
        >
          {entry.description}
        </p>
      )}
    </>
  );
}

/** Join, the prepared chat request and the source link. */
function EntryActions({
  entry,
  language,
  ask,
  link,
}: {
  entry: CalendarEntry;
  language: WidgetLanguage;
  ask: (text: string) => void;
  /** The source link belongs here in a popover; a pane shows it in its header. */
  link?: boolean;
}) {
  const t = text[language];
  return (
    <>
      {entry.join && (
        <Button size="xs" asChild>
          <a
            href={entry.join}
            target="_blank"
            rel="noreferrer"
            data-testid="calendar-join"
          >
            <Video data-icon="inline-start" aria-hidden="true" />
            {t.join}
          </a>
        </Button>
      )}
      <AskAction
        label={entry.kind === "event" ? t.prepare : t.help}
        onAsk={() =>
          ask(
            (entry.kind === "event" ? t.prepareText : t.helpText)(
              describeEntry(entry, language),
            ),
          )
        }
      />
      {link && entry.link && <SourceLink href={entry.link} label={t.open} />}
    </>
  );
}

/**
 * The entry's detail: a popover on the card; in the large view a click
 * selects it for the pane beside the grid instead.
 */
function EntryDetail({
  entry,
  language,
  ask,
  preview,
  selected,
  onSelect,
  children,
}: {
  entry: CalendarEntry;
  language: WidgetLanguage;
  ask: (text: string) => void;
  preview?: boolean;
  selected?: boolean;
  onSelect?: (entry: CalendarEntry) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (preview) return children;
  if (onSelect)
    return isValidElement<ComponentProps<"button">>(children)
      ? cloneElement(children, {
          onClick: () => onSelect(entry),
          "aria-current": selected === true,
        })
      : children;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      {open && (
        <PopoverContent
          align="start"
          className="w-96"
          data-testid="calendar-detail"
        >
          <PopoverHeader>
            <PopoverTitle>{entry.title}</PopoverTitle>
            <PopoverDescription>
              {whenOf(entry, language)}
              {entry.source && ` · ${entry.source}`}
            </PopoverDescription>
          </PopoverHeader>
          <EntryFacts entry={entry} language={language} clamp />
          <div className="flex flex-wrap items-center gap-1">
            <EntryActions entry={entry} language={language} ask={ask} link />
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}

/** The large view's pane: the selected entry in full. */
/** An entry's identity across refreshes: the data carries no ids. */
const entryKey = (entry: CalendarEntry) =>
  [entry.kind, entry.startText, entry.title].join("\n");

function EntryPane({
  entry,
  language,
  ask,
}: {
  entry: CalendarEntry | null;
  language: WidgetLanguage;
  ask: (text: string) => void;
}) {
  const t = text[language];
  if (!entry) return <Nothing fill>{t.pick}</Nothing>;
  return (
    <div data-testid="calendar-pane" className="flex min-h-0 flex-1 flex-col">
      <DetailPane
        title={entry.title}
        meta={
          whenOf(entry, language) + (entry.source ? ` · ${entry.source}` : "")
        }
        link={entry.link}
        linkLabel={t.open}
        actions={<EntryActions entry={entry} language={language} ask={ask} />}
      >
        <div className="flex flex-col gap-3">
          <EntryFacts entry={entry} language={language} clamp={false} />
        </div>
      </DetailPane>
    </div>
  );
}

/**
 * How much of an entry the gallery's small preview writes: the title and
 * start on one line (one day), the title (a few days) or nothing (a week).
 */
type Compact = "line" | "title" | "bare";

function EventBlock({
  placed,
  day,
  layout,
  language,
  compact,
  ...props
}: {
  placed: CalendarPlaced;
  day: CalendarDay;
  layout: CalendarLayout;
  language: WidgetLanguage;
  compact?: Compact;
} & ComponentProps<"button">) {
  const { entry, lane, lanes } = placed;
  const top = gridPercent(placed.startMin, layout);
  const height = gridPercent(placed.endMin, layout) - top;
  const width = 100 / lanes;
  const vars = {
    "--cal-top": `${top}%`,
    "--cal-height": `${height}%`,
    "--cal-left": `${lane * width}%`,
    "--cal-width": `${width}%`,
  } as CSSProperties;
  return (
    <button
      type="button"
      {...props}
      data-testid="calendar-event"
      data-day={day.key}
      data-lane={lane}
      data-lanes={lanes}
      data-status={entry.status ?? "none"}
      aria-label={`${entry.title}, ${spanOf(entry, language)}`}
      className="absolute top-(--cal-top) left-(--cal-left) flex h-(--cal-height) w-(--cal-width) min-w-0 flex-col overflow-hidden rounded-md border-l-2 border-primary bg-primary/15 px-1.5 py-1 text-left text-xs leading-tight hover:bg-primary/25 aria-[current=true]:ring-2 aria-[current=true]:ring-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none data-[status=declined]:border-muted-foreground data-[status=declined]:bg-muted data-[status=declined]:text-muted-foreground data-[status=declined]:line-through data-[status=tentative]:border-dashed data-[status=tentative]:bg-primary/5"
      style={vars}
    >
      {compact === "line" ? (
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="truncate font-medium">{entry.title}</span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {timeOf(entry.start, language)}
          </span>
        </span>
      ) : compact === "title" ? (
        <span className="truncate font-medium">{entry.title}</span>
      ) : compact === "bare" ? null : (
        <>
          <span className="truncate font-medium">{entry.title}</span>
          <span className="truncate text-muted-foreground tabular-nums">
            {spanOf(entry, language)}
            {entry.location && ` · ${entry.location}`}
          </span>
        </>
      )}
    </button>
  );
}

function TaskMarker({
  placed,
  day,
  layout,
  language,
  ...props
}: {
  placed: CalendarPlaced;
  day: CalendarDay;
  layout: CalendarLayout;
  language: WidgetLanguage;
} & ComponentProps<"button">) {
  const { entry } = placed;
  const Icon = entry.done ? CircleCheck : Circle;
  const vars = {
    "--cal-top": `${gridPercent(placed.startMin, layout)}%`,
  } as CSSProperties;
  return (
    <button
      type="button"
      {...props}
      data-testid="calendar-task"
      data-day={day.key}
      data-done={entry.done === true}
      aria-label={`${entry.title}, ${spanOf(entry, language)}`}
      className="absolute top-(--cal-top) right-0 left-0 z-10 flex h-4 -translate-y-1/2 items-center gap-1 rounded-sm border-l-2 border-muted-foreground bg-muted px-1 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none data-[done=true]:text-muted-foreground data-[done=true]:line-through"
      style={vars}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{entry.title}</span>
    </button>
  );
}

function AllDayChip({
  entry,
  bare,
  ...props
}: {
  entry: CalendarEntry;
  /** A bar without its title (a week in the gallery's preview). */
  bare?: boolean;
} & ComponentProps<"button">) {
  const Icon =
    entry.kind === "task" ? (entry.done ? CircleCheck : Circle) : null;
  return (
    <button
      type="button"
      {...props}
      data-testid="calendar-chip"
      data-kind={entry.kind}
      data-status={entry.status ?? "none"}
      data-done={entry.done === true}
      data-bare={bare === true}
      aria-label={bare ? entry.title : undefined}
      className="flex min-w-0 items-center gap-1 rounded-sm border-l-2 border-primary bg-primary/10 px-1 text-left text-xs leading-tight hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none data-[done=true]:line-through data-[kind=task]:border-muted-foreground data-[kind=task]:bg-muted data-[status=declined]:border-muted-foreground data-[status=declined]:bg-muted data-[status=declined]:text-muted-foreground data-[status=declined]:line-through data-[status=tentative]:border-dashed data-[status=tentative]:bg-primary/5 data-[bare=true]:h-4"
    >
      {!bare && Icon && (
        <Icon
          aria-hidden="true"
          className="size-3 shrink-0 text-muted-foreground"
        />
      )}
      {!bare && <span className="truncate">{entry.title}</span>}
    </button>
  );
}

/** A whole hour of the day, 0–24. */
function HourField({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = Math.round(Number(event.target.value));
          if (Number.isFinite(next))
            onChange(Math.min(max, Math.max(min, next)));
        }}
      />
    </Field>
  );
}

/** Hours in the gallery's preview: three, two under a row of all-day chips. */
const PREVIEW_HOURS = 3;

/**
 * The gallery's preview: a few whole hours from the first timed entry of the
 * shown days, and only the entries that fit in them, so nothing is cut off.
 */
function previewOf(entries: CalendarEntry[], days: Date[], config: Config) {
  const keys = new Set(days.map(isoDate));
  const timed = entries.filter(
    (entry) => !entry.allDay && keys.has(isoDate(entry.start)),
  );
  const allDay = entries.some(
    (entry) =>
      entry.allDay &&
      days.some(
        (day) => startOfDay(entry.start) <= day && day <= startOfDay(entry.end),
      ),
  );
  const hours = allDay ? PREVIEW_HOURS - 1 : PREVIEW_HOURS;
  const first = Math.min(...timed.map((entry) => entry.start.getHours()));
  const from = Math.min(
    Number.isFinite(first) ? first : config.dayStart,
    24 - hours,
  );
  const window = { from, to: from + hours };
  const fits = (entry: CalendarEntry) => {
    if (entry.allDay) return true;
    if (!keys.has(isoDate(entry.start))) return false;
    const end = new Date(entry.start);
    end.setHours(window.to, 0, 0, 0);
    return entry.start.getHours() >= window.from && entry.end <= end;
  };
  return { window, entries: entries.filter(fits) };
}

export default defineRenderer<Data, Config>({
  type: "calendar",
  icon: CalendarDays,
  tall: true,
  describe: (config, language) =>
    `${text[language].describe[config.range]} · ${config.dayStart}–${config.dayEnd}`,
  Body: ({ data, config, language, ask, preview, expanded }) => {
    const t = text[language];
    const now = useNow();
    const [view, setView] = useState<CalendarView>(() =>
      viewOfRange(config.range),
    );
    const [focus, setFocus] = useState<string | null>(null);
    // The large view's pane shows one entry; the card uses popovers.
    // Kept by what the entry is, not its place: a refresh reorders them.
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const entries = useMemo(
      () => calendarEntries(data, config),
      [data, config],
    );
    const isSelected = (entry: CalendarEntry) =>
      selectedKey === entryKey(entry);
    const selectedEntry = entries.find(isSelected) ?? null;
    const detailProps = expanded
      ? {
          onSelect: (entry: CalendarEntry) => setSelectedKey(entryKey(entry)),
        }
      : {};
    const shown = calendarDays(config.range, view, now);
    const focused = focus ? shown.filter((day) => isoDate(day) === focus) : [];
    // The grid runs the whole day and opens on the working hours; the
    // gallery's small preview shows a few hours from its first entry, with
    // only the entries that fit in them whole.
    const days = focused.length ? focused : shown;
    const small = preview ? previewOf(entries, days, config) : null;
    const layout = layoutDays(
      small?.entries ?? entries,
      days,
      small?.window ?? { from: 0, to: 24 },
      now,
    );
    const hours = Array.from(
      { length: layout.to - layout.from },
      (_, index) => layout.from + index,
    );
    const nowMin = minutesSinceMidnight(now);
    const nowPercent =
      nowMin >= layout.from * 60 && nowMin <= layout.to * 60
        ? gridPercent(nowMin, layout)
        : null;
    const hasAllDay = layout.days.some((day) => day.allDay.length);
    const multi = layout.days.length > 1;
    const compact: Compact | undefined = !preview
      ? undefined
      : !multi
        ? "line"
        : layout.days.length <= 3
          ? "title"
          : "bare";

    // Open on the current hour (or the first entry); once, when laid out.
    const scroller = useRef<HTMLDivElement>(null);
    const opened = useRef(false);
    const opening = openingHour(layout, config.dayStart);
    useEffect(() => {
      const element = scroller.current;
      if (opened.current || !element) return;
      // Inside a sheet or dialog the grid has no height on the first frame.
      let frames = 0;
      let handle = 0;
      const attempt = () => {
        if (opened.current) return;
        if (!element.scrollHeight) {
          if (frames++ < 30 && typeof requestAnimationFrame === "function")
            handle = requestAnimationFrame(attempt);
          return;
        }
        opened.current = true;
        const rows = layout.to - layout.from;
        const row = element.scrollHeight / rows;
        element.scrollTop = Math.max(
          0,
          (opening - layout.from) * row - row / 2,
        );
      };
      attempt();
      return () => {
        if (handle && typeof cancelAnimationFrame === "function")
          cancelAnimationFrame(handle);
      };
    }, [opening, layout.from, layout.to]);

    const calendar = (
      <div
        data-testid="calendar"
        data-large={expanded === true}
        data-preview={preview === true}
        className="group/cal flex min-h-0 min-w-0 flex-1 flex-col gap-1"
      >
        <WidgetToolbar
          start={
            focused.length > 0 ? (
              <Button
                variant="ghost"
                size="xs"
                data-testid="calendar-back"
                onClick={() => setFocus(null)}
              >
                <ChevronLeft data-icon="inline-start" aria-hidden="true" />
                {t.back}
              </Button>
            ) : !entries.length ? (
              <Nothing>{t.nothing}</Nothing>
            ) : undefined
          }
          end={
            !preview ? (
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                value={view}
                aria-label={t.view}
                data-testid="calendar-view"
                onValueChange={(next) => {
                  if (next === "day" || next === "next3" || next === "week") {
                    setView(next);
                    setFocus(null);
                  }
                }}
              >
                {(["day", "next3", "week"] as const).map((value) => (
                  <ToggleGroupItem key={value} value={value}>
                    {t.views[value]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : undefined
          }
        />
        <div className="flex border-b">
          <div className="w-10 shrink-0" />
          {layout.days.map((day) => (
            <button
              key={day.key}
              type="button"
              data-testid="calendar-day-header"
              data-date={day.key}
              data-today={day.today}
              disabled={!multi || preview === true}
              onClick={() => setFocus(day.key)}
              className="flex min-w-0 flex-1 items-baseline justify-center gap-1 rounded-md py-1 text-xs text-muted-foreground enabled:hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[today=true]:font-semibold data-[today=true]:text-primary"
            >
              {compact !== "bare" && (
                <span className="truncate">
                  {day.date.toLocaleDateString(language, { weekday: "short" })}
                </span>
              )}
              <span className="font-medium tabular-nums">
                {day.date.getDate()}
              </span>
            </button>
          ))}
        </div>
        {hasAllDay && (
          <div className="flex border-b pb-1">
            <div className="w-10 shrink-0 pr-1 text-right text-xs text-muted-foreground">
              {t.allDay}
            </div>
            {layout.days.map((day) => (
              <div
                key={day.key}
                data-testid="calendar-allday"
                data-date={day.key}
                className="flex min-w-0 flex-1 flex-col gap-0.5 border-l px-0.5"
              >
                {day.allDay.map((entry) => (
                  <EntryDetail
                    key={entry.id}
                    entry={entry}
                    language={language}
                    ask={ask}
                    preview={preview}
                    selected={isSelected(entry)}
                    {...detailProps}
                  >
                    <AllDayChip entry={entry} bare={compact === "bare"} />
                  </EntryDetail>
                ))}
              </div>
            ))}
          </div>
        )}
        <div
          ref={scroller}
          data-testid="calendar-grid"
          className="min-h-0 flex-1 overflow-y-auto group-data-[preview=true]/cal:overflow-hidden group-data-[preview=true]/cal:pt-2"
        >
          <div className="flex">
            <div className="w-10 shrink-0">
              {hours.map((hour) => (
                <div
                  key={hour}
                  className="relative h-10 group-data-[large=true]/cal:h-14 group-data-[preview=true]/cal:h-8"
                >
                  <span className="absolute -top-2 right-1 text-xs text-muted-foreground tabular-nums">
                    {hour}:00
                  </span>
                </div>
              ))}
            </div>
            {layout.days.map((day) => (
              <div
                key={day.key}
                data-testid="calendar-day"
                data-date={day.key}
                data-today={day.today}
                className="relative min-w-0 flex-1 border-l data-[today=true]:bg-muted/40"
              >
                {hours.map((hour) => (
                  <div
                    key={hour}
                    aria-hidden="true"
                    className="h-10 border-t group-data-[large=true]/cal:h-14 group-data-[preview=true]/cal:h-8"
                  />
                ))}
                {day.events.map((placed) => (
                  <EntryDetail
                    key={placed.entry.id}
                    entry={placed.entry}
                    language={language}
                    ask={ask}
                    preview={preview}
                    selected={isSelected(placed.entry)}
                    {...detailProps}
                  >
                    <EventBlock
                      placed={placed}
                      day={day}
                      layout={layout}
                      language={language}
                      compact={compact}
                    />
                  </EntryDetail>
                ))}
                {day.tasks.map((placed) => (
                  <EntryDetail
                    key={placed.entry.id}
                    entry={placed.entry}
                    language={language}
                    ask={ask}
                    preview={preview}
                    selected={isSelected(placed.entry)}
                    {...detailProps}
                  >
                    <TaskMarker
                      placed={placed}
                      day={day}
                      layout={layout}
                      language={language}
                    />
                  </EntryDetail>
                ))}
                {day.today && nowPercent !== null && (
                  <div
                    aria-hidden="true"
                    data-testid="calendar-now"
                    className="pointer-events-none absolute top-(--cal-top) right-0 left-0 z-20 border-t border-destructive"
                    style={{ "--cal-top": `${nowPercent}%` } as CSSProperties}
                  >
                    <span className="absolute -top-1 -left-1 size-2 rounded-full bg-destructive" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
    if (!expanded) return calendar;
    return (
      <div className="flex min-h-0 min-w-0 flex-1 gap-4">
        {calendar}
        <aside className="flex w-80 shrink-0 flex-col border-l pl-4">
          <EntryPane entry={selectedEntry} language={language} ask={ask} />
        </aside>
      </div>
    );
  },
  Config: ({ config, onChange, disabled, language }) => {
    const t = text[language];
    return (
      <>
        <ChoiceField
          label={t.range}
          value={config.range}
          disabled={disabled}
          options={(["today", "next3", "week", "workweek"] as const).map(
            (value) => ({ value, label: t.ranges[value] }),
          )}
          onChange={(range) => onChange({ ...config, range })}
        />
        <SwitchField
          label={t.tasks}
          checked={config.tasks}
          disabled={disabled}
          onChange={(tasks) => onChange({ ...config, tasks })}
        />
        <div className="grid grid-cols-2 gap-3">
          <HourField
            label={t.dayStart}
            value={config.dayStart}
            min={0}
            max={23}
            disabled={disabled}
            onChange={(dayStart) =>
              onChange({
                ...config,
                dayStart,
                dayEnd: Math.max(config.dayEnd, dayStart + 1),
              })
            }
          />
          <HourField
            label={t.dayEnd}
            value={config.dayEnd}
            min={1}
            max={24}
            disabled={disabled}
            onChange={(dayEnd) =>
              onChange({
                ...config,
                dayEnd,
                dayStart: Math.min(config.dayStart, dayEnd - 1),
              })
            }
          />
        </div>
      </>
    );
  },
});
