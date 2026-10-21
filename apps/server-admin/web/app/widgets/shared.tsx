import {
  createContext,
  useContext,
  useId,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Search, Sparkles } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Field, FieldContent, FieldLabel } from "@admin/components/ui/field";
import { Input } from "@admin/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@admin/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@admin/components/ui/popover";
import { Switch } from "@admin/components/ui/switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@admin/components/ui/toggle-group";
import type { WidgetLanguage } from "./types";

/** A whole number between 1 and `max`. */
export function CountField({
  label,
  value,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
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
        min={1}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = Math.round(Number(event.target.value));
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(1, next)));
        }}
      />
    </Field>
  );
}

/** One of a few named options. */
export function ChoiceField<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        className="flex-wrap"
        value={value}
        disabled={disabled}
        aria-label={label}
        onValueChange={(next) => {
          const found = options.find((option) => option.value === next);
          if (found) onChange(found.value);
        }}
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  );
}

export function SwitchField({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      </FieldContent>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
    </Field>
  );
}

export function TextField({
  label,
  value,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        maxLength={max}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** A prepared request for the chat: one small action under an item. */
export function AskAction({
  label,
  onAsk,
  disabled,
  iconOnly,
}: {
  label: string;
  onAsk: () => void;
  disabled?: boolean;
  /** Only the spark, the label as its name: for dense rows. */
  iconOnly?: boolean;
}) {
  if (iconOnly)
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={disabled}
        aria-label={label}
        data-testid="widget-ask-item"
        onClick={onAsk}
      >
        <Sparkles aria-hidden="true" />
      </Button>
    );
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={disabled}
      data-testid="widget-ask-item"
      onClick={onAsk}
    >
      <Sparkles data-icon="inline-start" aria-hidden="true" />
      {label}
    </Button>
  );
}

/**
 * The widget anatomy (docs/ui-system.md, "Widgets"): one toolbar line under
 * the header, rows with fixed slots, an optional footer line, and in the
 * large view a split pane whose detail keeps its actions at the bottom.
 */

/**
 * Where a widget's toolbar goes: the frame offers the right end of its
 * header's status line, so the controls share that line instead of taking
 * one of their own. Without a slot (a preview, a test) it renders in place.
 */
export const WidgetToolbarSlot = createContext<HTMLElement | null>(null);

/** The widget's context (a count) and controls (filters, a view switch). */
export function WidgetToolbar({
  start,
  end,
}: {
  start?: ReactNode;
  end?: ReactNode;
}) {
  const slot = useContext(WidgetToolbarSlot);
  if (!start && !end) return null;
  const inline = (
    <div
      data-testid="widget-toolbar"
      className="flex min-h-7 shrink-0 items-center gap-2 text-xs text-muted-foreground"
    >
      {start && (
        <div className="flex min-w-0 flex-1 items-center gap-2 tabular-nums">
          {start}
        </div>
      )}
      {end && (
        <div className="ml-auto flex shrink-0 items-center gap-1">{end}</div>
      )}
    </div>
  );
  if (!slot) return inline;
  return createPortal(
    <div
      data-testid="widget-toolbar"
      className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
    >
      {start && (
        <div className="flex min-w-0 items-center gap-2 tabular-nums">
          {start}
        </div>
      )}
      {end && <div className="flex shrink-0 items-center gap-1">{end}</div>}
    </div>,
    slot,
  );
}

/** One line at the bottom: result or status left, tools right. */
export function WidgetFooter({
  start,
  end,
}: {
  start?: ReactNode;
  end?: ReactNode;
}) {
  if (!start && !end) return null;
  return (
    <div
      data-testid="widget-footer"
      className="mt-auto flex min-h-7 shrink-0 items-center gap-2 pt-1 text-xs text-muted-foreground"
    >
      {start && (
        <div className="flex min-w-0 flex-1 items-center gap-2 tabular-nums">
          {start}
        </div>
      )}
      {end && (
        <div className="ml-auto flex shrink-0 items-center gap-1">{end}</div>
      )}
    </div>
  );
}

/** The rows of a widget, divided. */
export function WidgetRows({ children }: { children: ReactNode }) {
  return (
    <ul role="list" className="flex min-w-0 flex-col divide-y">
      {children}
    </ul>
  );
}

/** The class of a row, for rows that are links. */
export const widgetRowClass =
  "flex w-full min-w-0 items-start gap-2 rounded-md px-1 py-2 text-left outline-none hover:bg-muted focus-visible:bg-muted aria-[current=true]:bg-accent";

/**
 * A row's three slots: a 16 px leading state, the main lines (title with an
 * optional badge, the detail, the gist) and a trailing value, right-aligned.
 */
export function WidgetRowContent({
  leading,
  title,
  badge,
  detail,
  gist,
  trailing,
  emphasis,
}: {
  leading?: ReactNode;
  title: ReactNode;
  badge?: ReactNode;
  detail?: ReactNode;
  gist?: ReactNode;
  trailing?: ReactNode;
  /** The title in medium weight: unread, urgent. */
  emphasis?: boolean;
}) {
  return (
    <>
      <span
        aria-hidden={leading ? undefined : true}
        className="flex h-5 w-4 shrink-0 items-center justify-center"
      >
        {leading}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span
            data-emphasis={emphasis === true}
            className="min-w-0 flex-1 truncate text-sm data-[emphasis=true]:font-medium"
          >
            {title}
          </span>
          {badge}
        </span>
        {detail && (
          <span className="flex min-w-0 items-center gap-1 text-sm">
            {detail}
          </span>
        )}
        {gist && (
          <span className="truncate text-xs text-muted-foreground">{gist}</span>
        )}
      </span>
      {trailing !== undefined && trailing !== null && (
        <span className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
          {trailing}
        </span>
      )}
    </>
  );
}

/**
 * A row the person opens; `selected` while its detail is shown. Button props
 * (and the ref) pass through, so a popover trigger can anchor to the row.
 */
export function WidgetRow({
  selected,
  leading,
  title,
  badge,
  detail,
  gist,
  trailing,
  emphasis,
  className,
  ...props
}: ComponentProps<typeof WidgetRowContent> &
  Omit<ComponentProps<"button">, "title"> & { selected?: boolean }) {
  const content = { leading, title, badge, detail, gist, trailing, emphasis };
  if (!props.onClick)
    return (
      <div className={widgetRowClass}>
        <WidgetRowContent {...content} />
      </div>
    );
  return (
    <button
      type="button"
      aria-current={selected === true}
      {...props}
      className={`${widgetRowClass} ${className ?? ""}`}
    >
      <WidgetRowContent {...content} />
    </button>
  );
}

/**
 * The large view of a list widget: the list on the left (fixed width, muted,
 * its own toolbar on top, scrolls), the detail on the right.
 */
export function SplitPane({
  list,
  detail,
}: {
  list: ReactNode;
  detail: ReactNode;
}) {
  return (
    <div
      data-testid="widget-split"
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 md:flex-row md:gap-4"
    >
      <div className="flex min-h-0 shrink-0 flex-col gap-1 rounded-lg bg-muted/40 p-2 md:w-80">
        {list}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{detail}</div>
    </div>
  );
}

/**
 * A detail pane: title and meta with the external link top right, a body
 * that scrolls at a readable width, and the actions in a bar at the bottom.
 */
export function DetailPane({
  title,
  meta,
  link,
  linkLabel,
  status,
  actions,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  link?: string;
  linkLabel?: string;
  /** Loading or failure, shown where the body will be. */
  status?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid="widget-detail-pane"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex items-start justify-between gap-3 pb-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-base font-medium break-words">{title}</p>
          {meta && (
            <p className="text-xs text-muted-foreground tabular-nums">{meta}</p>
          )}
        </div>
        {link && <SourceLink href={link} label={linkLabel ?? ""} />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {status && (
          <p
            data-testid="widget-detail-status"
            className="pb-2 text-xs text-muted-foreground"
          >
            {status}
          </p>
        )}
        <div className="max-w-prose">{children}</div>
      </div>
      {actions && (
        <div
          data-testid="widget-detail-actions"
          className="mt-3 flex flex-wrap items-center gap-1 border-t pt-3"
        >
          {actions}
        </div>
      )}
    </div>
  );
}

/** A row the person opens for its details; `selected` while they are shown. */
export function RowButton({
  selected,
  className,
  ...props
}: ComponentProps<"button"> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-expanded={selected}
      className={`flex w-full min-w-0 items-center gap-2 rounded-md py-2 text-left outline-none hover:bg-muted focus-visible:bg-muted aria-expanded:bg-muted ${className ?? ""}`}
      {...props}
    />
  );
}

/**
 * An item's details beside its row: the full text the row truncates and the
 * actions on it. Rendered only while open, so a closed row stays light.
 */
export function DetailPopover({
  open,
  onOpenChange,
  title,
  description,
  lines,
  actions,
  body,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** The lines under the title; empty values are skipped. */
  lines?: ReactNode[];
  actions?: ReactNode;
  /** Anything else under the lines (a whole detail of its own). */
  body?: ReactNode;
  /** The trigger: a `RowButton`. */
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      {open && (
        <PopoverContent
          align="start"
          className="w-96"
          data-testid="widget-detail"
        >
          <PopoverHeader>
            <PopoverTitle>{title}</PopoverTitle>
            {description && (
              <PopoverDescription>{description}</PopoverDescription>
            )}
          </PopoverHeader>
          <DetailLines lines={lines} />
          {body}
          {actions && (
            <div className="flex flex-wrap items-center gap-1">{actions}</div>
          )}
        </PopoverContent>
      )}
    </Popover>
  );
}

/** The lines of a detail, one under the other. */
export function DetailLines({ lines }: { lines?: ReactNode[] }) {
  const shown = (lines ?? []).filter(
    (line) => line !== undefined && line !== null && line !== "",
  );
  if (!shown.length) return null;
  return (
    <div className="flex flex-col gap-1 text-sm">
      {shown.map((line, index) => (
        <p key={index} className="min-w-0 break-words">
          {line}
        </p>
      ))}
    </div>
  );
}

/** Narrows the rows of a widget by text. */
export function FilterInput({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange: (value: string) => void;
}) {
  return (
    <InputGroup>
      <InputGroupAddon>
        <Search aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={value}
        aria-label={label}
        placeholder={label}
        data-testid="widget-filter"
        onChange={(event) => onChange(event.target.value)}
      />
    </InputGroup>
  );
}

/** True when a row's text contains every word of the query. */
export function matchesQuery(query: string, ...parts: unknown[]) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = parts
    .filter((part) => part !== null && part !== undefined)
    .map(String)
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** A web link from the data; always a new tab without the referrer. */
export function SourceLink({ href, label }: { href: string; label: string }) {
  return (
    <Button variant="ghost" size="icon-xs" asChild>
      <a href={href} target="_blank" rel="noreferrer" aria-label={label}>
        <ExternalLink aria-hidden="true" />
      </a>
    </Button>
  );
}

/** The empty state of a widget's body; `fill` centres it in its pane. */
export function Nothing({
  children,
  fill,
}: {
  children: ReactNode;
  fill?: boolean;
}) {
  return (
    <p
      data-fill={fill === true}
      className="text-sm text-muted-foreground data-[fill=true]:flex data-[fill=true]:flex-1 data-[fill=true]:items-center data-[fill=true]:justify-center data-[fill=true]:py-6"
    >
      {children}
    </p>
  );
}

/** "2026-10-17" (a date only) or a date-time; local time without an offset. */
export const parseWhen = (value: string) => {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T00:00:00` : value);
  return { date, dateOnly, valid: !Number.isNaN(date.getTime()) };
};
export const formatTime = (value: string, language: WidgetLanguage) => {
  const when = parseWhen(value);
  return when.valid && !when.dateOnly
    ? when.date.toLocaleTimeString(language, {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
};
export const formatDay = (date: Date, language: WidgetLanguage) =>
  date.toLocaleDateString(language, {
    weekday: "short",
    day: "numeric",
    month: "numeric",
  });
/** "10/17 9:00 AM" for prepared requests. */
export const formatWhen = (value: string, language: WidgetLanguage) => {
  const when = parseWhen(value);
  if (!when.valid) return value;
  const day = when.date.toLocaleDateString(language, {
    day: "numeric",
    month: "numeric",
  });
  return when.dateOnly ? day : `${day} ${formatTime(value, language)}`;
};
export const dayKey = (date: Date) =>
  `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
