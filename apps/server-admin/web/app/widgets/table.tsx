import { useEffect, useMemo, useState } from "react";
import type { z } from "zod";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  Copy,
  Table2,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@admin/components/ui/table";
import { tableWidget } from "../../../../../packages/protocol/widgets/table";
import {
  CountField,
  FilterInput,
  Nothing,
  SourceLink,
  WidgetFooter,
  WidgetToolbar,
  matchesQuery,
  rowLimit,
} from "./shared";
import { defineRenderer } from "./types";

type Data = z.infer<typeof tableWidget.data>;
type Config = z.infer<typeof tableWidget.config>;
const PREVIEW_COLUMNS = 3;
type Cell = Data["rows"][number][number];
type Sort = { column: number; direction: "asc" | "desc" };

const text = {
  cs: {
    count: "Nejvýš řádků",
    nothing: "Žádné řádky.",
    nothingFiltered: "Nic takového.",
    filter: "Filtrovat…",
    sort: (column: string) => `Seřadit podle ${column}`,
    copy: "Kopírovat",
    copied: "Zkopírováno",
    open: "Otevřít",
    rows: (shown: number, total: number) => `${shown} z ${total}`,
  },
  en: {
    count: "Rows at most",
    nothing: "No rows.",
    nothingFiltered: "Nothing like that.",
    filter: "Filter…",
    sort: (column: string) => `Sort by ${column}`,
    copy: "Copy",
    copied: "Copied",
    open: "Open",
    rows: (shown: number, total: number) => `${shown} of ${total}`,
  },
};

/** Numbers before text, nulls last whatever the direction. */
const compare = (a: Cell, b: Cell, direction: Sort["direction"]) => {
  if (a === null || a === undefined)
    return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  const sign = direction === "asc" ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return sign * (a - b);
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return sign * a.localeCompare(b, undefined, { numeric: true });
};

/** The rows as tab-separated text, for a spreadsheet or a message. */
export function tableToTsv(columns: string[], rows: Cell[][]) {
  const cell = (value: Cell) =>
    value === null || value === undefined
      ? ""
      : String(value).replace(/[\t\n\r]+/g, " ");
  return [columns, ...rows]
    .map((row) => row.map((value) => cell(value as Cell)).join("\t"))
    .join("\n");
}

export default defineRenderer<Data, Config>({
  type: "table",
  icon: Table2,
  tall: true,
  Body: ({ data, config, language, preview, expanded }) => {
    const t = text[language];
    const [sort, setSort] = useState<Sort | null>(null);
    const [query, setQuery] = useState("");
    const [copied, setCopied] = useState(false);
    useEffect(() => {
      if (!copied) return;
      const timer = setTimeout(() => setCopied(false), 1500);
      return () => clearTimeout(timer);
    }, [copied]);
    const format = new Intl.NumberFormat(language, {
      maximumFractionDigits: 2,
    });
    const all = useMemo(
      () =>
        data.rows
          .slice(0, rowLimit(config.count, preview))
          .map((cells, index) => ({
            cells,
            link: data.rowLinks?.[index] ?? null,
          })),
      [data, config.count, preview],
    );
    // The gallery's narrow preview fits a few columns, without links.
    const columns = preview
      ? data.columns.slice(0, PREVIEW_COLUMNS)
      : data.columns;
    // A column is numeric when every filled cell in it is a number.
    const numeric = columns.map((_, column) => {
      const filled = all
        .map((row) => row.cells[column])
        .filter((value) => value !== null && value !== undefined);
      return (
        filled.length > 0 && filled.every((value) => typeof value === "number")
      );
    });
    const rows = useMemo(() => {
      const filtered = all.filter((row) => matchesQuery(query, ...row.cells));
      if (!sort) return filtered;
      return [...filtered].sort((a, b) =>
        compare(
          a.cells[sort.column] ?? null,
          b.cells[sort.column] ?? null,
          sort.direction,
        ),
      );
    }, [all, query, sort]);
    const hasLinks = !preview && all.some((row) => row.link);
    const tools = !preview && (all.length > 5 || expanded);
    if (!all.length) return <Nothing>{t.nothing}</Nothing>;
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(
          tableToTsv(
            data.columns,
            rows.map((row) => row.cells),
          ),
        );
        setCopied(true);
      } catch {
        // No clipboard here (an insecure context, a denied permission).
      }
    };
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1">
        {tools && (
          <WidgetToolbar
            start={
              <div className="w-full max-w-xs">
                <FilterInput
                  value={query}
                  label={t.filter}
                  onChange={setQuery}
                />
              </div>
            }
            end={
              rows.length !== all.length ? (
                <span>{t.rows(rows.length, all.length)}</span>
              ) : undefined
            }
          />
        )}
        {!rows.length ? (
          <Nothing fill={expanded}>{t.nothingFiltered}</Nothing>
        ) : (
          <Table scroll={!preview}>
            <TableHeader sticky={!preview}>
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
                        active === "asc"
                          ? "ascending"
                          : active === "desc"
                            ? "descending"
                            : "none"
                      }
                      className={numeric[index] ? "text-right" : undefined}
                    >
                      {preview ? (
                        column
                      ) : (
                        <button
                          type="button"
                          data-testid="table-sort"
                          data-direction={active ?? "none"}
                          aria-label={t.sort(column)}
                          className="group/sort inline-flex max-w-full items-center gap-1 outline-none hover:text-foreground focus-visible:text-foreground"
                          onClick={() =>
                            setSort(
                              active === "asc"
                                ? { column: index, direction: "desc" }
                                : { column: index, direction: "asc" },
                            )
                          }
                        >
                          <span className="truncate">{column}</span>
                          <Icon
                            aria-hidden="true"
                            data-active={active !== null}
                            className="size-3 shrink-0 opacity-0 group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100 data-[active=true]:opacity-100"
                          />
                        </button>
                      )}
                    </TableHead>
                  );
                })}
                {hasLinks && <TableHead className="w-9" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={index} data-testid="table-row">
                  {columns.map((_, column) => {
                    const value = row.cells[column];
                    return (
                      <TableCell
                        key={column}
                        className={numeric[column] ? "text-right" : undefined}
                      >
                        {typeof value === "number" ? (
                          <span className="tabular-nums">
                            {format.format(value)}
                          </span>
                        ) : (
                          (value ?? "")
                        )}
                      </TableCell>
                    );
                  })}
                  {hasLinks && (
                    <TableCell className="text-right">
                      {row.link && (
                        <SourceLink href={row.link} label={t.open} />
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {!preview && (
          <WidgetFooter
            start={
              !tools && rows.length !== all.length
                ? t.rows(rows.length, all.length)
                : undefined
            }
            end={
              <Button
                variant="ghost"
                size="xs"
                data-testid="table-copy"
                onClick={() => void copy()}
              >
                {copied ? (
                  <Check data-icon="inline-start" aria-hidden="true" />
                ) : (
                  <Copy data-icon="inline-start" aria-hidden="true" />
                )}
                {copied ? t.copied : t.copy}
              </Button>
            }
          />
        )}
      </div>
    );
  },
  Config: ({ config, onChange, disabled, language }) => (
    <CountField
      label={text[language].count}
      value={config.count}
      max={20}
      disabled={disabled}
      onChange={(count) => onChange({ ...config, count })}
    />
  ),
});
