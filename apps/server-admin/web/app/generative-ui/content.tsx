import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CircleCheck,
  ExternalLink,
  Info,
  TriangleAlert,
} from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@admin/components/ui/alert";
import { Card, CardContent } from "@admin/components/ui/card";
import { Markdown as MarkdownText } from "@admin/components/ui/markdown";
import { Progress as ProgressBar } from "@admin/components/ui/progress";
import { Separator as Divider } from "@admin/components/ui/separator";
import {
  Table as DataTable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@admin/components/ui/table";
import {
  Tabs as TabSet,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@admin/components/ui/tabs";
import { StatusBadge } from "@admin/components/console/status";
import { Disclosure } from "@admin/components/console/disclosure";
import { displayFieldIcon } from "../../../../../packages/protocol/display-link";
import { safeUrl } from "../../../../../packages/openui-library/program";
import { FieldValue } from "../chat-cards";
import { useChatCopy } from "../chat-copy";
import { elements, text, type Tone, type View } from "./scope";
import { ItemAction } from "./actions";

const blocks = "flex min-w-0 flex-col gap-4";

export const Stack: View<{ children: unknown[] }> = ({ props, renderNode }) => (
  <div className={blocks}>{renderNode(props.children)}</div>
);
/** Side by side while there is room; each block keeps a readable width. */
export const Row: View<{ children: unknown[] }> = ({ props, renderNode }) => (
  <div className="flex min-w-0 flex-wrap items-start gap-4 *:min-w-0 *:flex-1 *:basis-40">
    {renderNode(props.children)}
  </div>
);
export const Grid: View<{ children: unknown[]; columns: number }> = ({
  props,
  renderNode,
}) => (
  <div
    data-columns={props.columns ?? 2}
    className="grid min-w-0 grid-cols-1 gap-4 *:min-w-0 @md/generated:grid-cols-2 @2xl/generated:data-[columns=3]:grid-cols-3 @2xl/generated:data-[columns=4]:grid-cols-4"
  >
    {renderNode(props.children)}
  </div>
);
export const Section: View<{ title: string; children: unknown[] }> = ({
  props,
  renderNode,
}) => (
  <section className="flex min-w-0 flex-col gap-3">
    <h3 className="text-md font-semibold">{text(props.title)}</h3>
    {renderNode(props.children)}
  </section>
);
/** The content of one tab or accordion item. */
export const Group: View<{ children: unknown[] }> = ({ props, renderNode }) => (
  <div className={blocks}>{renderNode(props.children)}</div>
);
export const Tabs: View<{ tabs: unknown[] }> = ({ props, renderNode }) => {
  const tabs = elements(props.tabs);
  if (!tabs.length) return null;
  return (
    <TabSet defaultValue="0" className="min-w-0">
      <TabsList variant="line">
        {tabs.map((tab, index) => (
          <TabsTrigger key={index} value={String(index)}>
            {text(tab.props.label)}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab, index) => (
        <TabsContent key={index} value={String(index)} className="mt-3">
          {renderNode(tab)}
        </TabsContent>
      ))}
    </TabSet>
  );
};
/** Optional detail, every part closed at first. */
export const Accordion: View<{ items: unknown[] }> = ({
  props,
  renderNode,
}) => (
  <div className="flex min-w-0 flex-col gap-1">
    {elements(props.items).map((item, index) => (
      <Disclosure key={index} title={text(item.props.title)}>
        {renderNode(item)}
      </Disclosure>
    ))}
  </div>
);
export const Separator: View<object> = () => <Divider />;

export const Heading: View<{ text: string; size: "l" | "m" }> = ({ props }) =>
  props.size === "l" ? (
    <h3 className="text-lg font-semibold break-words">{text(props.text)}</h3>
  ) : (
    <h4 className="text-md font-semibold break-words">{text(props.text)}</h4>
  );
export const Text: View<{ text: string; tone: "default" | "muted" }> = ({
  props,
}) => (
  <p
    data-tone={props.tone ?? "default"}
    className="break-words whitespace-pre-wrap data-[tone=muted]:text-muted-foreground"
  >
    {text(props.text)}
  </p>
);
export const Markdown: View<{ text: string }> = ({ props }) => (
  <MarkdownText text={text(props.text)} />
);
const calloutIcon = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: TriangleAlert,
};
export const Callout: View<{
  text: string;
  tone: keyof typeof calloutIcon;
  title: string;
}> = ({ props }) => {
  const tone = props.tone ?? "info";
  const Icon = calloutIcon[tone] ?? Info;
  return (
    <Alert variant={tone === "danger" ? "destructive" : "default"}>
      <Icon aria-hidden="true" />
      {props.title && <AlertTitle>{text(props.title)}</AlertTitle>}
      <AlertDescription>{text(props.text)}</AlertDescription>
    </Alert>
  );
};
export const Badge: View<{ label: string; tone: Tone }> = ({ props }) => (
  <span className="flex">
    <StatusBadge tone={props.tone ?? "neutral"}>
      {text(props.label)}
    </StatusBadge>
  </span>
);
/** Only a checked http(s) address becomes a link; it opens a new tab. */
export const Link: View<{ label: string; url: string }> = ({ props }) => {
  const href = safeUrl(props.url);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 self-start text-primary underline-offset-4 hover:underline"
    >
      {text(props.label) || href}
      <ExternalLink aria-hidden="true" className="size-3.5" />
    </a>
  );
};

function useNumber() {
  const { language } = useChatCopy();
  return useMemo(
    () => new Intl.NumberFormat(language, { maximumFractionDigits: 2 }),
    [language],
  );
}
const shown = (value: unknown, format: Intl.NumberFormat) =>
  typeof value === "number" ? format.format(value) : text(value);

export const Metric: View<{
  label: string;
  value: string | number;
  unit: string;
  change: string;
  tone: Tone;
}> = ({ props }) => {
  const format = useNumber();
  return (
    <Card size="sm">
      <CardContent>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-xs text-muted-foreground">
            {text(props.label)}
          </span>
          <span className="flex min-w-0 flex-wrap items-baseline gap-1">
            <span className="text-2xl font-semibold tabular-nums">
              {shown(props.value, format)}
            </span>
            {props.unit && (
              <span className="text-muted-foreground">{text(props.unit)}</span>
            )}
          </span>
          {props.change && (
            <span
              data-tone={props.tone ?? "neutral"}
              className="text-xs text-muted-foreground tabular-nums data-[tone=danger]:text-destructive data-[tone=info]:text-info data-[tone=success]:text-success data-[tone=warning]:text-warning"
            >
              {text(props.change)}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export const Details: View<{ items: unknown[] }> = ({ props, renderNode }) => (
  <dl className="grid grid-cols-1 gap-x-6 gap-y-2 @md/generated:grid-cols-3">
    {renderNode(props.items)}
  </dl>
);
/** A complete email, phone or web address opens the person's own app. */
export const Detail: View<{ label: string; value: string | number }> = ({
  props,
}) => {
  const format = useNumber();
  const label = text(props.label);
  const value = shown(props.value, format);
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words @md/generated:col-span-2">
        {typeof props.value === "string" ? (
          <FieldValue
            value={value}
            phone={displayFieldIcon(label, value) === "phone"}
          />
        ) : (
          <span className="tabular-nums">{value}</span>
        )}
      </dd>
    </div>
  );
};

export const List: View<{ items: unknown[] }> = ({ props, renderNode }) => (
  <ul role="list" className="flex min-w-0 flex-col divide-y">
    {renderNode(props.items)}
  </ul>
);
/** A row: title and an exception badge, the detail, a trailing meta, an action. */
export const ListItem: View<{
  title: string;
  detail: string;
  meta: string;
  badge: unknown;
  action: unknown;
}> = ({ props, renderNode }) => (
  <li className="flex min-w-0 items-start gap-2 py-2">
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{text(props.title)}</span>
        {renderNode(props.badge)}
      </span>
      {props.detail && (
        <span className="break-words text-muted-foreground">
          {text(props.detail)}
        </span>
      )}
    </span>
    {props.meta && (
      <span className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
        {text(props.meta)}
      </span>
    )}
    {!!props.action && (
      <ItemAction label={text(props.title)} action={props.action} />
    )}
  </li>
);

type Cell = string | number | null;
type Sort = { column: number; direction: "asc" | "desc" };
/** Numbers before text, empty cells last whatever the direction. */
const compare = (a: Cell, b: Cell, direction: Sort["direction"]) => {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  const sign = direction === "asc" ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return sign * (a - b);
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return sign * a.localeCompare(b, undefined, { numeric: true });
};
export const Table: View<{
  columns: string[];
  rows: Cell[][];
  sortable: boolean;
}> = ({ props }) => {
  const { copy } = useChatCopy();
  const format = useNumber();
  const [sort, setSort] = useState<Sort | null>(null);
  const columns = (props.columns ?? []).map(text);
  const all = (props.rows ?? []).filter(Array.isArray).map((cells) =>
    columns.map((_, index): Cell => {
      const value = cells[index];
      return typeof value === "number" || typeof value === "string"
        ? value
        : null;
    }),
  );
  // A column is numeric when every filled cell in it is a number.
  const numeric = columns.map((_, column) => {
    const filled = all.map((row) => row[column]).filter((v) => v !== null);
    return filled.length > 0 && filled.every((v) => typeof v === "number");
  });
  const rows = sort
    ? [...all].sort((a, b) =>
        compare(a[sort.column] ?? null, b[sort.column] ?? null, sort.direction),
      )
    : all;
  if (!columns.length) return null;
  return (
    <Card variant="flush">
      <DataTable>
        <TableHeader>
          <TableRow>
            {columns.map((column, index) => {
              const active = sort?.column === index ? sort.direction : null;
              const Icon =
                active === "asc"
                  ? ArrowUp
                  : active === "desc"
                    ? ArrowDown
                    : ArrowUpDown;
              return (
                <TableHead
                  key={index}
                  aria-sort={
                    !props.sortable
                      ? undefined
                      : active === "asc"
                        ? "ascending"
                        : active === "desc"
                          ? "descending"
                          : "none"
                  }
                  className={numeric[index] ? "text-right" : undefined}
                >
                  {props.sortable ? (
                    <button
                      type="button"
                      aria-label={copy.generated.sortBy(column)}
                      className="group/sort inline-flex max-w-full items-center gap-1 outline-none hover:text-foreground focus-visible:text-foreground"
                      onClick={() =>
                        setSort({
                          column: index,
                          direction: active === "asc" ? "desc" : "asc",
                        })
                      }
                    >
                      <span className="truncate">{column}</span>
                      <Icon
                        aria-hidden="true"
                        data-active={active !== null}
                        className="size-3 shrink-0 opacity-0 group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100 data-[active=true]:opacity-100"
                      />
                    </button>
                  ) : (
                    column
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={index}>
              {row.map((value, column) => (
                <TableCell
                  key={column}
                  className={numeric[column] ? "text-right" : undefined}
                >
                  {typeof value === "number" ? (
                    <span className="tabular-nums">{format.format(value)}</span>
                  ) : (
                    (value ?? "")
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </DataTable>
    </Card>
  );
};

export const Progress: View<{ label: string; value: number; max: number }> = ({
  props,
}) => {
  const format = useNumber();
  const max = typeof props.max === "number" && props.max > 0 ? props.max : 100;
  const value = typeof props.value === "number" ? props.value : 0;
  const label = text(props.label);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex justify-between gap-2">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {format.format(value)} / {format.format(max)}
        </span>
      </div>
      <ProgressBar
        value={Math.min(100, Math.max(0, (value / max) * 100))}
        aria-label={label}
      />
    </div>
  );
};

export const Timeline: View<{ items: unknown[] }> = ({ props, renderNode }) => (
  <ol className="flex min-w-0 flex-col">{renderNode(props.items)}</ol>
);
export const TimelineItem: View<{
  time: string;
  title: string;
  detail: string;
  tone: Tone;
}> = ({ props }) => (
  <li className="group/step flex min-w-0 gap-3">
    <span aria-hidden="true" className="flex flex-col items-center">
      <span
        data-tone={props.tone ?? "neutral"}
        className="mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground data-[tone=danger]:bg-destructive data-[tone=info]:bg-info data-[tone=success]:bg-success data-[tone=warning]:bg-warning"
      />
      <span className="mt-1 w-px flex-1 bg-border group-last/step:hidden" />
    </span>
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 pb-4 group-last/step:pb-0">
      <span className="text-xs text-muted-foreground tabular-nums">
        {text(props.time)}
      </span>
      <span className="font-medium break-words">{text(props.title)}</span>
      {props.detail && (
        <span className="break-words text-muted-foreground">
          {text(props.detail)}
        </span>
      )}
    </span>
  </li>
);
